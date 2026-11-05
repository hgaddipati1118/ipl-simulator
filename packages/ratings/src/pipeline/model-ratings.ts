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
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

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
function shiftTo(r: GameRatings, keys: (keyof GameRatings)[], overall: (r: GameRatings) => number, target: number): void {
  for (let pass = 0; pass < 4; pass++) {
    const delta = target - overall(r);
    if (delta === 0) return;
    for (const k of keys) r[k] = clamp(r[k] + delta);
  }
}

export interface ApplyReport {
  batting: number;
  bowling: number;
  unmatched: number;
}

/**
 * Re-rank `players` in place. Each needs an `espn_<cricinfo id>` id to be matched to the model.
 */
export function applyModelRatings(players: RateablePlayer[], model: Map<number, ModelRow>): ApplyReport {
  const matched = players.flatMap(player => {
    const id = Number(player.id.replace(/^espn_/, ""));
    const row = model.get(id);
    return row ? [{ player, row }] : [];
  });
  const bat = matched.filter(m =>
    (m.row.bat_balls_career ?? 0) >= MIN_BAT_BALLS && (m.row.bat_balls_per_match ?? 0) >= MIN_BAT_BALLS_PER_MATCH && m.row.bat_value_proj !== null);
  const bowl = matched.filter(m =>
    (m.row.bowl_balls_career ?? 0) >= MIN_BOWL_BALLS && (m.row.bowl_balls_per_match ?? 0) >= MIN_BOWL_BALLS_PER_MATCH && m.row.bowl_value_proj !== null);

  // Targets first, from the overalls as they stand, so the attribute shuffle doesn't move them
  const batScore = (row: ModelRow) => row.bat_rank_value_proj ?? row.bat_value_proj! - FALLBACK_CONSERVATISM * (row.bat_sd ?? 0);
  const bowlScore = (row: ModelRow) => row.bowl_rank_value_proj ?? row.bowl_value_proj! - FALLBACK_CONSERVATISM * (row.bowl_sd ?? 0);
  const batTargets = rankTargets(bat, m => battingOvr(m.player.ratings), m => batScore(m.row));
  const bowlTargets = rankTargets(bowl, m => bowlingOvr(m.player.ratings), m => bowlScore(m.row));

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

  for (const m of bat) shiftTo(m.player.ratings, ["battingIQ", "timing", "power", "running"], battingOvr, batTargets.get(m.player.id)!);
  for (const m of bowl) shiftTo(m.player.ratings, ["wicketTaking", "economy"], bowlingOvr, bowlTargets.get(m.player.id)!);

  return { batting: bat.length, bowling: bowl.length, unmatched: players.length - matched.length };
}

/** The current overall values, handed out in the model's order */
function rankTargets<M extends { player: RateablePlayer }>(items: M[], current: (m: M) => number, score: (m: M) => number): Map<string, number> {
  const values = items.map(current).sort((a, b) => a - b);
  const ranked = [...items].sort((a, b) => score(a) - score(b));
  return new Map(ranked.map((m, i) => [m.player.id, values[i]]));
}
