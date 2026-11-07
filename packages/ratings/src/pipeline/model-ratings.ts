/**
 * Re-rank the game's players with the ratings model (src/analysis/ratings-model.py).
 *
 * The model says who is better; the game's engine is calibrated to the current spread of
 * attribute values (IPL-era scoring). So this reorders rather than rescales: for each attribute,
 * the players the model covers keep the same set of values they have now, reassigned in the
 * model's order of the matching component (docs: data/analysis/ratings-report.md, section 9).
 * Each player's four batting (and four bowling) attributes are then shifted together so his
 * batting/bowling overall lands at the model's rank for its overall, which carries the
 * conservative, experience-adjusted rating. Players the model doesn't cover are unchanged.
 *
 * With CricketArchive scores (ca-model.ts) the ranking score becomes:
 *   - Cricsheet-rated players: an inverse-variance blend of the Cricsheet score and the CA score mapped onto
 *     the Cricsheet scale. CA's T20 record includes the same matches Cricsheet has, so CA's precision is
 *     discounted to the share of its balls Cricsheet doesn't cover (at least 5%) to avoid counting them twice.
 *   - Players Cricsheet can't rate (too few balls, or not in it): the mapped CA score alone. They don't join the
 *     ranking (thousands of them would shift the value pool the Cricsheet-rated players are ranked against);
 *     instead each gets the overall a Cricsheet-rated player with the same score gets, interpolated along that
 *     score -> overall curve. They keep the generator's attribute mix (CA has no components).
 * The CA -> Cricsheet mapping is a regression over players with >= MAP_MIN_BALLS in both.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import type { CaPlayer } from "./ca-model.js";

const MODEL_FILE = new URL("../../data/analysis/player_ratings_by_season.parquet", import.meta.url).pathname;

/** Balls of evidence before a player's components are trusted enough to re-rank him */
const MIN_BAT_BALLS = 240;
const MIN_BOWL_BALLS = 240;
/**
 * Only re-rank a discipline a player actually does: part-time bowlers and tail-end batters keep
 * the game's values for it (the model's per-ball scale says nothing about how little they do it)
 */
const MIN_BAT_BALLS_PER_MATCH = 6;
const MIN_BOWL_BALLS_PER_MATCH = 6;
/**
 * Ranked by the model's proven-adjusted rating (`*_rank_value_proj`: age-projected mean minus k
 * SDs, pulled toward the role prior until a player has ~5 elite seasons). Older parquet files
 * without it fall back to projected mean minus this many SDs.
 */
const FALLBACK_CONSERVATISM = 0.5;

export interface GameRatings {
  battingIQ: number; timing: number; power: number; running: number;
  wicketTaking: number; economy: number; accuracy: number; clutch: number;
}

export interface RateablePlayer {
  id: string;
  name: string;
  ratings: GameRatings;
}

interface ModelRow {
  cricinfo_id: number;
  bat_balls_career: number | null;
  bowl_balls_career: number | null;
  bat_runs: number | null; bat_dismissal: number | null; bat_timing: number | null; bat_power: number | null; bat_running: number | null;
  bowl_wickets: number | null; bowl_economy: number | null; bowl_accuracy: number | null;
  bat_value_proj: number | null; bat_sd: number | null; bat_balls_per_match: number | null;
  bowl_value_proj: number | null; bowl_sd: number | null; bowl_balls_per_match: number | null;
  bat_rank_value_proj: number | null; bowl_rank_value_proj: number | null;
  experience: number | null;
}

/** Same formulas as packages/engine (Player.battingOvr / bowlingOvr) */
export function battingOvr(r: GameRatings): number {
  return Math.round(r.battingIQ * 0.30 + r.timing * 0.30 + r.power * 0.35 + r.running * 0.05);
}
export function bowlingOvr(r: GameRatings): number {
  return Math.round(r.wicketTaking * 0.55 + r.economy * 0.20 + r.accuracy * 0.10 + r.clutch * 0.15);
}

export function modelAvailable(): boolean {
  return existsSync(MODEL_FILE);
}

/** The model's latest snapshot for one gender, keyed by Cricinfo id */
export function loadModel(gender: "male" | "female"): Map<number, ModelRow> {
  const cols = modelColumns();
  const pick = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`);
  const sql = `SELECT cricinfo_id, ${[
    "bat_balls_career", "bowl_balls_career", "bat_runs", "bat_dismissal", "bat_timing", "bat_power", "bat_running",
    "bowl_wickets", "bowl_economy", "bowl_accuracy",
    "bat_value_proj", "bat_sd", "bat_balls_per_match", "bowl_value_proj", "bowl_sd", "bowl_balls_per_match",
    "bat_rank_value_proj", "bowl_rank_value_proj", "experience",
  ].map(pick).join(", ")}
    FROM '${MODEL_FILE}' WHERE snapshot = 'latest' AND gender = '${gender}' AND cricinfo_id IS NOT NULL`;
  const rows = JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }) || "[]") as ModelRow[];
  // A Cricinfo id can appear on more than one register entry; keep the one with the most evidence
  const balls = (r: ModelRow) => (r.bat_balls_career ?? 0) + (r.bowl_balls_career ?? 0);
  const byId = new Map<number, ModelRow>();
  for (const r of rows) {
    const id = Number(r.cricinfo_id);
    const seen = byId.get(id);
    if (!seen || balls(r) > balls(seen)) byId.set(id, r);
  }
  return byId;
}

function modelColumns(): Set<string> {
  const out = execFileSync("duckdb", ["-csv", "-noheader", "-c", `SELECT column_name FROM (DESCRIBE SELECT * FROM '${MODEL_FILE}')`], { encoding: "utf-8" });
  return new Set(out.split("\n").map(s => s.trim()).filter(Boolean));
}

const clamp = (v: number) => Math.max(1, Math.min(99, Math.round(v)));

/**
 * Give `players` (in place) the model's ordering. `order(row)` is the model score to rank by;
 * the values handed out are the players' own current values for `get`.
 */
function reassign<T>(
  items: { player: RateablePlayer; row: ModelRow }[],
  get: (r: GameRatings) => number,
  set: (r: GameRatings, v: number) => void,
  order: (row: ModelRow) => number,
): void {
  const values = items.map(i => get(i.player.ratings)).sort((a, b) => a - b);
  const ranked = [...items].sort((a, b) => order(a.row) - order(b.row));
  ranked.forEach((item, i) => set(item.player.ratings, values[i]));
}

/** Shift a player's batting (or bowling) attributes together until the overall hits `target` */
export function shiftTo(r: GameRatings, keys: (keyof GameRatings)[], overall: (r: GameRatings) => number, target: number): void {
  for (let pass = 0; pass < 4; pass++) {
    const delta = target - overall(r);
    if (delta === 0) return;
    for (const k of keys) r[k] = clamp(r[k] + delta);
  }
}

/**
 * Key of a player in the model / CA maps: the Cricinfo id for `espn_<id>`, and -<CricketArchive id> for the extended
 * pool's `ca_<id>` players (they have no Cricinfo id and are never in the Cricsheet model).
 */
export function playerKey(p: { id: string }): number {
  return p.id.startsWith("ca_") ? -Number(p.id.slice(3)) : Number(p.id.replace(/^espn_/, ""));
}

export interface ApplyReport {
  batting: number;
  bowling: number;
  unmatched: number;
  /** Cricsheet-rated players whose score was blended with CA */
  blendedBatting?: number;
  blendedBowling?: number;
  /** Players ranked on CA alone, by CA source format */
  caOnlyBatting?: Record<string, number>;
  caOnlyBowling?: Record<string, number>;
  caMap?: { bat: { a: number; b: number; n: number }; bowl: { a: number; b: number; n: number } };
  /** Career T20 balls of evidence per player (max of Cricsheet and CA), for small-sample caps */
  evidence: Map<string, { bat: number; bowl: number }>;
  /** Players whose rating for a side comes only from List A / first-class (no usable T20 record) */
  t20Unproven?: { bat: Set<string>; bowl: Set<string> };
}

const MAP_MIN_BALLS = 500;
/** CA's independent share of evidence never drops below this (keeps the blend defined) */
const MIN_CA_INDEPENDENT = 0.05;

interface Mapping { a: number; b: number; n: number }

function fitMapping(pairs: { x: number; y: number; w: number }[]): Mapping {
  if (pairs.length < 30) return { a: 0, b: 1, n: pairs.length };
  const sw = pairs.reduce((t, p) => t + p.w, 0);
  const mx = pairs.reduce((t, p) => t + p.w * p.x, 0) / sw;
  const my = pairs.reduce((t, p) => t + p.w * p.y, 0) / sw;
  const sxx = pairs.reduce((t, p) => t + p.w * (p.x - mx) ** 2, 0);
  const b = sxx > 0 ? pairs.reduce((t, p) => t + p.w * (p.x - mx) * (p.y - my), 0) / sxx : 1;
  return { a: my - b * mx, b, n: pairs.length };
}

/**
 * Re-rank `players` in place. Each needs an `espn_<cricinfo id>` id to be matched to the model.
 */
export function applyModelRatings(players: RateablePlayer[], model: Map<number, ModelRow>, ca?: Map<number, CaPlayer>): ApplyReport {
  const espnId = playerKey;
  const matched = players.flatMap(player => {
    const row = model.get(espnId(player));
    return row ? [{ player, row }] : [];
  });
  const bat = matched.filter(m =>
    (m.row.bat_balls_career ?? 0) >= MIN_BAT_BALLS && (m.row.bat_balls_per_match ?? 0) >= MIN_BAT_BALLS_PER_MATCH && m.row.bat_value_proj !== null);
  const bowl = matched.filter(m =>
    (m.row.bowl_balls_career ?? 0) >= MIN_BOWL_BALLS && (m.row.bowl_balls_per_match ?? 0) >= MIN_BOWL_BALLS_PER_MATCH && m.row.bowl_value_proj !== null);

  // Targets first, from the overalls as they stand, so the attribute shuffle doesn't move them
  const batScore = (row: ModelRow) => row.bat_rank_value_proj ?? row.bat_value_proj! - FALLBACK_CONSERVATISM * (row.bat_sd ?? 0);
  const bowlScore = (row: ModelRow) => row.bowl_rank_value_proj ?? row.bowl_value_proj! - FALLBACK_CONSERVATISM * (row.bowl_sd ?? 0);

  // ── CricketArchive: map onto the Cricsheet scale, blend, and add players Cricsheet can't rate ──
  const evidence = new Map<string, { bat: number; bowl: number }>();
  for (const m of matched) evidence.set(m.player.id, { bat: m.row.bat_balls_career ?? 0, bowl: m.row.bowl_balls_career ?? 0 });
  const report: Omit<ApplyReport, "batting" | "bowling" | "unmatched"> = { evidence };
  type Ranked = { player: RateablePlayer; score: number; caOnly?: boolean };
  const batRanked: Ranked[] = bat.map(m => ({ player: m.player, score: batScore(m.row) }));
  const bowlRanked: Ranked[] = bowl.map(m => ({ player: m.player, score: bowlScore(m.row) }));
  if (ca && ca.size > 0) {
    for (const p of players) {
      const c = ca.get(espnId(p));
      if (!c) continue;
      const e = evidence.get(p.id) ?? { bat: 0, bowl: 0 };
      evidence.set(p.id, { bat: Math.max(e.bat, c.t20BatBalls), bowl: Math.max(e.bowl, c.t20BowlBalls) });
    }
    const sides = [
      { side: "bat" as const, list: bat, ranked: batRanked, value: (r: ModelRow) => r.bat_value_proj, balls: (r: ModelRow) => r.bat_balls_career ?? 0, sd: (r: ModelRow) => r.bat_sd ?? 0 },
      { side: "bowl" as const, list: bowl, ranked: bowlRanked, value: (r: ModelRow) => r.bowl_value_proj, balls: (r: ModelRow) => r.bowl_balls_career ?? 0, sd: (r: ModelRow) => r.bowl_sd ?? 0 },
    ];
    report.caMap = { bat: { a: 0, b: 1, n: 0 }, bowl: { a: 0, b: 1, n: 0 } };
    report.t20Unproven = { bat: new Set(), bowl: new Set() };
    for (const s of sides) {
      const pairs = s.list.flatMap(m => {
        const c = ca.get(espnId(m.player))?.[s.side];
        const v = s.value(m.row);
        return c && c.source === "T20" && c.balls >= MAP_MIN_BALLS && s.balls(m.row) >= MAP_MIN_BALLS && v !== null
          ? [{ x: c.score, y: v, w: Math.min(c.balls, s.balls(m.row)) }] : [];
      });
      const map = fitMapping(pairs);
      report.caMap[s.side] = map;
      const mapped = (c: { score: number; sd: number }) => ({ mean: map.a + map.b * c.score, sd: Math.abs(map.b) * c.sd });
      let blended = 0;
      const inModel = new Set(s.list.map(m => m.player.id));
      for (const r of s.ranked) {
        const m = s.list.find(x => x.player === r.player)!;
        const c = ca.get(espnId(r.player))?.[s.side];
        if (!c || c.source !== "T20") continue;
        const cs = mapped(c);
        const caBalls = s.side === "bat" ? ca.get(espnId(r.player))!.t20BatBalls : ca.get(espnId(r.player))!.t20BowlBalls;
        const independent = Math.max(MIN_CA_INDEPENDENT, caBalls > 0 ? (caBalls - s.balls(m.row)) / caBalls : 0);
        const vCs = Math.max(1e-6, s.sd(m.row) ** 2);
        const vCa = Math.max(1e-6, cs.sd ** 2) / independent;
        const caScore = cs.mean - FALLBACK_CONSERVATISM * cs.sd;
        r.score = (r.score / vCs + caScore / vCa) / (1 / vCs + 1 / vCa);
        blended++;
      }
      const caOnly: Record<string, number> = {};
      for (const p of players) {
        if (inModel.has(p.id)) continue;
        // Cricsheet has him and judged this a discipline he barely does (under 6 balls a match): respect that
        const row = model.get(espnId(p));
        const perMatch = row ? (s.side === "bat" ? row.bat_balls_per_match : row.bowl_balls_per_match) : null;
        const csBalls = row ? (row.bat_balls_career ?? 0) + (row.bowl_balls_career ?? 0) : 0;
        if (row && csBalls >= MIN_BAT_BALLS && perMatch !== null && perMatch < (s.side === "bat" ? MIN_BAT_BALLS_PER_MATCH : MIN_BOWL_BALLS_PER_MATCH)) continue;
        const c = ca.get(espnId(p))?.[s.side];
        if (!c) continue;
        const cs = mapped(c);
        s.ranked.push({ player: p, score: cs.mean - FALLBACK_CONSERVATISM * cs.sd, caOnly: true });
        caOnly[c.source] = (caOnly[c.source] ?? 0) + 1;
        if (c.source !== "T20") report.t20Unproven![s.side].add(p.id);
      }
      if (s.side === "bat") { report.blendedBatting = blended; report.caOnlyBatting = caOnly; }
      else { report.blendedBowling = blended; report.caOnlyBowling = caOnly; }
    }
  }
  const batTargets = rankTargets(batRanked.filter(r => !r.caOnly), m => battingOvr(m.player.ratings), m => m.score);
  const bowlTargets = rankTargets(bowlRanked.filter(r => !r.caOnly), m => bowlingOvr(m.player.ratings), m => m.score);
  placeOnCurve(batRanked, batTargets);
  placeOnCurve(bowlRanked, bowlTargets);

  const n = (v: number | null) => v ?? 0;
  reassign(bat, r => r.battingIQ, (r, v) => { r.battingIQ = v; }, row => n(row.bat_dismissal) + n(row.bat_runs));
  reassign(bat, r => r.timing, (r, v) => { r.timing = v; }, row => n(row.bat_timing));
  reassign(bat, r => r.power, (r, v) => { r.power = v; }, row => n(row.bat_power));
  reassign(bat, r => r.running, (r, v) => { r.running = v; }, row => n(row.bat_running));
  reassign(bowl, r => r.wicketTaking, (r, v) => { r.wicketTaking = v; }, row => n(row.bowl_wickets));
  reassign(bowl, r => r.economy, (r, v) => { r.economy = v; }, row => n(row.bowl_economy));
  // accuracy is left as generated: the model's wide/no-ball signal is too weak to re-rank by
  // The game's clutch feeds bowling overall; the model's honest equivalent is big-match experience
  const withExperience = matched.filter(m => m.row.experience !== null);
  if (withExperience.length > 0) reassign(withExperience, r => r.clutch, (r, v) => { r.clutch = v; }, row => n(row.experience));

  for (const m of batRanked) shiftTo(m.player.ratings, ["battingIQ", "timing", "power", "running"], battingOvr, batTargets.get(m.player.id)!);
  for (const m of bowlRanked) shiftTo(m.player.ratings, ["wicketTaking", "economy"], bowlingOvr, bowlTargets.get(m.player.id)!);

  return { batting: batRanked.length, bowling: bowlRanked.length, unmatched: players.length - matched.length, ...report };
}

/**
 * Give each CA-only player the overall a ranked (Cricsheet-rated) player with the same score has: linear
 * interpolation along the ranked players' score -> target curve, clamped to its ends.
 */
function placeOnCurve(items: { player: RateablePlayer; score: number; caOnly?: boolean }[], targets: Map<string, number>): void {
  const curve = items.filter(i => !i.caOnly && targets.has(i.player.id))
    .map(i => ({ x: i.score, y: targets.get(i.player.id)! })).sort((a, b) => a.x - b.x);
  if (curve.length === 0) return;
  for (const i of items) {
    if (!i.caOnly) continue;
    let y: number;
    if (i.score <= curve[0].x) y = curve[0].y;
    else if (i.score >= curve[curve.length - 1].x) y = curve[curve.length - 1].y;
    else {
      let lo = 0, hi = curve.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (curve[mid].x <= i.score) lo = mid; else hi = mid; }
      const t = (i.score - curve[lo].x) / Math.max(1e-9, curve[hi].x - curve[lo].x);
      y = curve[lo].y + t * (curve[hi].y - curve[lo].y);
    }
    targets.set(i.player.id, Math.round(y));
  }
}

/** The current overall values, handed out in the model's order */
function rankTargets<M extends { player: RateablePlayer }>(items: M[], current: (m: M) => number, score: (m: M) => number): Map<string, number> {
  const values = items.map(current).sort((a, b) => a - b);
  const ranked = [...items].sort((a, b) => score(a) - score(b));
  return new Map(ranked.map((m, i) => [m.player.id, values[i]]));
}
