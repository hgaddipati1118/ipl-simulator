/**
 * ODI and Test ratings for every player the game ships: the ESPN pool (all-players.ts / wpl-players.ts), the league
 * squads' fallback players (league-rosters.ts) and the extended pool's shards (app/public/pool/).
 *
 *   npx tsx src/pipeline/generate-format-ratings.ts [--gender male|female] [--no-pool]
 *
 * Inputs (data/analysis/): ca_ratings_by_year.parquet, ca_cells.parquet, ca_lower_ratings.parquet, ca_lower_cells.parquet,
 *   ca_pool_stats.parquet, ca_comp_strength.csv, ca_validation.json, ca_espn_map.csv, deliveries.parquet + matches.parquet
 *   (Cricsheet ODIs / Tests), people.parquet; data/scraped/espn-players.json (ids of the hand-added players).
 * Outputs: ../app/public/data/format-ratings.json (ESPN pool + league fallback players, format in src/format-ratings.ts),
 *   the pool shards rewritten as version 2 (same T20 rows, ODI / Test sets appended), and in data/analysis/:
 *   format_ratings.json (per-player diagnostics for format-ratings-report.ts) and format_ratings_validation.json.
 *
 * Per gender, format (ODI = List A, Test = first-class) and side (batting, bowling):
 *  1. Level: format-model.ts estimateFormat, the CA rating in the format blended with the translation from the player's
 *     other formats, the balance tuned out of sample (format-validation.ts, re-run here). Ranked by mean - 0.5 sd.
 *  2. Game overall: equipercentile link on the players who are regulars of both the format and T20 (ESPN pool): the
 *     k-th best of them in the format gets the k-th best of their T20 overalls, so among players who play both a
 *     format rating sits where his T20 rating would. Everyone else is read off that score -> overall curve
 *     (interpolated, clamped to its ends), without moving anyone on it.
 *  3. Caps. A side the player doesn't do in the format (fewer than 6 balls a match over his career or his last three
 *     seasons of it: format-model.ts doesSideNow) keeps his T20 level at most, so established batters' few part-time overs
 *     don't make them bowlers. Then, as the T20 pipeline: a format record below 7/3 K balls (K = the CA model's shrinkage for the format) can't
 *     rate above the 95th percentile of established players; a derived side (no usable record) can't rate above the
 *     median of the format's regulars; extended-pool players rated only from lower-level cricket have the T20 pipeline's
 *     tier ceilings. A side with no CA evidence anywhere (a batter who never bowls) follows his T20 overall through a
 *     line fitted on players rated from data, capped at the median.
 *  4. Attributes: from the player's own scorecard stats in the format (ca_pool_stats.parquet, plus Cricsheet dot balls
 *     and extras in ODIs / Tests), each attribute's blend of z-scores (calculator.ts weights, format populations) mapped
 *     by percentile among the format's regulars onto the T20 attribute distribution of T20 regulars; a side without a
 *     usable record keeps the T20 mix. The side's attributes are then shifted together to its overall (model-ratings.ts
 *     shiftTo); clutch, fielding and keeping are the T20 values. Finally the set is normalised the way
 *     createPlayerFromData normalises T20 ratings (secondary discipline, clutch), with the player's T20 role (his format
 *     views share it), so it is runtime-ready.
 *  A set is "data" when the player's main discipline (his better T20 side) is measured in the format, else "derived".
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { gunzipSync, gzipSync } from "zlib";
import { join } from "path";
import {
  createPlayerFromData, normalizeRatingsForRole, calculateBattingOverall, calculateBowlingOverall, calculateOverallRating,
  type PlayerRatings, type PlayerRole,
} from "@ipl-sim/engine";
import { WPL_PLAYERS } from "../wpl-players.js";
import { getRealPlayers, getPoolPlayers } from "../real-players.js";
import { getLeaguePlayers, EXTRA_LEAGUE_IDS } from "../league-players.js";
import { decodeShard, encodeShard, POOL_VERSION, type PoolManifest, type PoolRow, type PoolShard, type ExtendedPlayer, toRealPlayerData } from "../extended-pool.js";
import { CORE_KEYS, encodeSet, FORMAT_RATINGS_VERSION, type EncodedSet, type FormatRatingsFile } from "../format-ratings.js";
import { shiftTo, type GameRatings } from "./model-ratings.js";
import {
  buildContext, caParams, doesSide, doesSideNow, estimateFormat, fitLine, fitTranslations, linkCurve, loadCaFormats, percentile, quantile, RANK_CONSERVATISM, readCurve, REGULAR_BALLS,
  type CaPlayerFormats, type EstimateContext, type FormatScore, type Gender, type Side, SIDES,
} from "./format-model.js";
import { validate, type FormatValidation } from "./format-validation.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const OUT_JSON = new URL("../../../app/public/data/format-ratings.json", import.meta.url).pathname;
const DIAG_FILE = `${DIR}format_ratings.json`;
const VALIDATION_OUT = `${DIR}format_ratings_validation.json`;
const AS_OF = 2026;
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);

type LongFmt = "ListA" | "FC";
const FORMATS: { key: "odi" | "test"; ca: LongFmt }[] = [{ key: "odi", ca: "ListA" }, { key: "test", ca: "FC" }];
const BAT_KEYS = ["battingIQ", "timing", "power", "running"] as const;
const BOWL_KEYS = ["wicketTaking", "economy", "accuracy"] as const;
/** Bowling overall is moved with these two, as in the T20 pipeline (accuracy and clutch keep their mix) */
const BOWL_SHIFT_KEYS = ["wicketTaking", "economy"] as const;

/** Small-sample cap: below 7/3 K balls a side can't rate above this percentile of established players (generate-ratings-espn.ts) */
const CAP_RELIABILITY = 0.7;
const CAP_PERCENTILE = 0.95;
/** Lower-tier ceilings of the extended pool (generate-ca-pool.ts): percentile of established ESPN players, tier0..tier4 */
const TIER_CEILING_PCT = [0.85, 0.70, 0.55, 0.55, 0.40];
/** A rating more than this many seasons old does not make its player a current regular of the format */
const REGULAR_MAX_AGE = 3;
/**
 * DATA_VAR where it can't be tuned (too few women's Tests to validate against). Women's first-class competition strengths
 * rest on almost no links between competitions (docs/CA-RATINGS-REPORT.md: one link), so domestic multi-day cricket sits
 * level with Tests; their first-class record is trusted a quarter as much and the ODI translation carries most of it.
 */
const UNTUNED_DATA_VAR: Record<string, number> = { "female/FC": 4 };
/** Lowest attribute value (create-player.ts squashTowardBaseline floors secondary T20 attributes at 10) */
const ATTRIBUTE_FLOOR = 10;
/** Fewer linked players than this: link format regulars to T20 regulars instead (the brief's literal percentile map) */
const MIN_LINK_PLAYERS = 30;

// ── shipped players ───────────────────────────────────────────────────

type FlatRecord = Parameters<typeof createPlayerFromData>[0];

interface Shipped {
  id: string;
  name: string;
  country: string;
  age: number;
  group: "espn" | "league" | "extended";
  /** Extended pool: senior / tier0..tier4 */
  tier?: string;
  caId?: number;
  t20: PlayerRatings;
  role: PlayerRole;
  isWicketKeeper: boolean;
  /** Extended-pool row to rewrite */
  row?: { shard: string; index: number };
}

function runtime(record: FlatRecord): { t20: PlayerRatings; role: PlayerRole; isWicketKeeper: boolean } {
  const p = createPlayerFromData(record);
  return { t20: { ...p.ratings }, role: p.role, isWicketKeeper: p.isWicketKeeper };
}

function espnToCa(): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of readFileSync(`${DIR}ca_espn_map.csv`, "utf-8").split("\n").slice(1)) {
    const [e, c] = line.split(",");
    if (e && c && !out.has(Number(e))) out.set(Number(e), Number(c));
  }
  return out;
}

/** Hand-added players (`manual_<name>`, generate-ratings-espn.ts getManualPlayers) by name in the ESPN profiles */
function manualEspnIds(names: string[]): Map<string, number> {
  const file = `${ROOT}data/scraped/espn-players.json`;
  const out = new Map<string, number>();
  if (!existsSync(file) || names.length === 0) return out;
  const want = new Set(names);
  const profiles = JSON.parse(readFileSync(file, "utf-8")) as { profile: { espnId: number; name: string; longName: string; gender: string } }[];
  for (const { profile } of profiles) {
    for (const n of [profile.longName, profile.name]) if (want.has(n) && !out.has(n) && profile.gender === "M") out.set(n, Number(profile.espnId));
  }
  return out;
}

interface PoolFile { file: string; shard: PoolShard; players: ExtendedPlayer[] }

function loadPoolShards(): { manifest: PoolManifest; files: PoolFile[] } | null {
  if (!existsSync(join(POOL_DIR, "manifest.json"))) return null;
  const manifest = JSON.parse(readFileSync(join(POOL_DIR, "manifest.json"), "utf-8")) as PoolManifest;
  const files = manifest.shards.map(s => {
    const shard = JSON.parse(gunzipSync(readFileSync(join(POOL_DIR, s.file))).toString()) as PoolShard;
    return { file: s.file, shard, players: decodeShard(shard) };
  });
  return { manifest, files };
}

function shippedPlayers(gender: Gender, pool: PoolFile[] | null): Shipped[] {
  const map = espnToCa();
  const out: Shipped[] = [];
  const espnRecords: FlatRecord[] = gender === "male"
    ? [...getRealPlayers(), ...getPoolPlayers()]
    : WPL_PLAYERS.map(p => ({
      id: p.id, name: p.name, age: p.age, country: p.country, role: p.role, isWicketKeeper: p.isWicketKeeper,
      bowlingStyle: p.bowlingStyle, battingHand: p.battingHand, ...p.ratings,
    }));
  const manual = manualEspnIds(espnRecords.filter(r => r.id?.startsWith("manual_")).map(r => r.name));
  for (const r of espnRecords) {
    const espn = r.id!.startsWith("espn_") ? Number(r.id!.slice(5)) : manual.get(r.name);
    out.push({ id: r.id!, name: r.name, country: r.country, age: r.age, group: "espn", caId: espn !== undefined ? map.get(espn) : undefined, ...runtime(r) });
  }
  const seen = new Set(out.map(p => p.id));
  // League squads' players not in the pool (without the extended pool registered, league-players.ts falls back to these)
  const leagueGender = (id: string) => (id === "wbbl" || id === "hundred-w" ? "female" : "male");
  for (const league of EXTRA_LEAGUE_IDS) {
    if (leagueGender(league) !== gender) continue;
    for (const d of getLeaguePlayers(league)) {
      if (d.source !== "fallback" || seen.has(d.id)) continue;
      seen.add(d.id);
      out.push({ id: d.id, name: d.name, country: d.country, age: d.age, group: "league", caId: d.caId, ...runtime(d) });
    }
  }
  for (const f of pool ?? []) {
    if (f.shard.gender !== (gender === "male" ? "men" : "women")) continue;
    f.players.forEach((p, index) => {
      out.push({
        id: p.id, name: p.name, country: p.country, age: p.age, group: "extended", tier: p.tier, caId: Number(p.id.slice(3)),
        row: { shard: f.file, index }, ...runtime(toRealPlayerData({ ...p, formatRatings: undefined })),
      });
    });
  }
  return out;
}

// ── format stats for the attribute mix ────────────────────────────────

interface FormatStats {
  /** Last season in the format */
  lastYear: number;
  bat?: { balls: number; runs: number; outs: number; fours: number; sixes: number; bndBalls: number; matches: number; dots?: number; dotBalls?: number };
  bowl?: { balls: number; runs: number; wkts: number; inns: number; matches: number; dots?: number; extras?: number; legal?: number };
}

function duck<T>(sql: string): T[] {
  return JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: ROOT, maxBuffer: 2 * 1024 * 1024 * 1024 }) || "[]") as T[];
}

/**
 * Career scorecard stats per CA player in List A and first-class (senior cards; lower-level cards for players without
 * senior ones), plus Cricsheet ODI / Test dot balls and extras for internationals.
 */
function loadFormatStats(gender: Gender): Record<LongFmt, Map<number, FormatStats>> {
  const rows = duck<{
    player_id: number; format: LongFmt; senior: boolean; bat_balls: number; bat_runs: number; bat_outs_b: number; fours: number; sixes: number;
    bnd_balls: number; bat_matches: number; bowl_balls: number; bowl_runs: number; bowl_wkts: number; bowl_inns: number; matches: number; last_year: number;
  }>(`
    WITH s AS (SELECT *, level = 'senior' AS senior FROM 'data/analysis/ca_pool_stats.parquet' WHERE gender = '${gender}' AND format IN ('ListA', 'FC')),
    pick AS (SELECT player_id, format, bool_or(senior) AS has_senior FROM s GROUP BY ALL)
    SELECT s.player_id, s.format, p.has_senior AS senior, sum(bat_balls) AS bat_balls, sum(bat_runs) AS bat_runs, sum(bat_outs_b) AS bat_outs_b,
           sum(coalesce(fours, 0)) AS fours, sum(coalesce(sixes, 0)) AS sixes, sum(coalesce(bnd_balls, 0)) AS bnd_balls,
           sum(bat_inns_b) AS bat_matches, sum(bowl_balls) AS bowl_balls, sum(bowl_runs) AS bowl_runs, sum(bowl_wkts) AS bowl_wkts,
           sum(bowl_inns) AS bowl_inns, sum(matches) AS matches, max(coalesce(last_year, 0)) AS last_year
    FROM s JOIN pick p USING (player_id, format) WHERE s.senior = p.has_senior GROUP BY ALL`);
  const out: Record<LongFmt, Map<number, FormatStats>> = { ListA: new Map(), FC: new Map() };
  for (const r of rows) {
    out[r.format].set(Number(r.player_id), {
      lastYear: Number(r.last_year),
      bat: r.bat_balls > 0 ? { balls: r.bat_balls, runs: r.bat_runs, outs: r.bat_outs_b, fours: r.fours, sixes: r.sixes, bndBalls: r.bnd_balls, matches: r.bat_matches } : undefined,
      bowl: r.bowl_balls > 0 ? { balls: r.bowl_balls, runs: r.bowl_runs, wkts: r.bowl_wkts, inns: r.bowl_inns, matches: r.matches } : undefined,
    });
  }
  // Cricsheet internationals: dot balls faced / bowled, wides + no-balls per ball
  const cs = duck<{ ca: number; fmt: LongFmt; side: Side; balls: number; dots: number; extras: number }>(`
    WITH m AS (SELECT match_id, CASE match_type WHEN 'ODI' THEN 'ListA' ELSE 'FC' END AS fmt FROM 'data/analysis/matches.parquet'
               WHERE match_type IN ('ODI', 'Test') AND gender = '${gender}'),
    d AS (SELECT d.*, m.fmt FROM 'data/analysis/deliveries.parquet' d JOIN m USING (match_id) WHERE coalesce(d.super_over, 0) = 0),
    ppl AS (SELECT cricsheet_id, any_value(cricketarchive_id) AS ca FROM 'data/analysis/people.parquet' WHERE cricketarchive_id IS NOT NULL GROUP BY ALL),
    bat AS (SELECT batter_id AS id, fmt, 'bat' AS side, count(*) FILTER (WHERE coalesce(wides, 0) = 0) AS balls,
                   count(*) FILTER (WHERE coalesce(wides, 0) = 0 AND runs_batter = 0) AS dots, 0 AS extras FROM d GROUP BY ALL),
    bowl AS (SELECT bowler_id AS id, fmt, 'bowl' AS side, count(*) FILTER (WHERE coalesce(wides, 0) = 0 AND coalesce(noballs, 0) = 0) AS balls,
                    count(*) FILTER (WHERE coalesce(wides, 0) = 0 AND coalesce(noballs, 0) = 0 AND runs_batter = 0) AS dots,
                    count(*) FILTER (WHERE coalesce(wides, 0) > 0 OR coalesce(noballs, 0) > 0) AS extras FROM d GROUP BY ALL)
    SELECT try_cast(ppl.ca AS BIGINT) AS ca, x.fmt, x.side, x.balls, x.dots, x.extras FROM (SELECT * FROM bat UNION ALL SELECT * FROM bowl) x
    JOIN ppl ON ppl.cricsheet_id = x.id WHERE try_cast(ppl.ca AS BIGINT) IS NOT NULL`);
  for (const r of cs) {
    const s = out[r.fmt].get(Number(r.ca));
    if (!s) continue;
    if (r.side === "bat" && s.bat) { s.bat.dots = r.dots; s.bat.dotBalls = r.balls; }
    if (r.side === "bowl" && s.bowl) { s.bowl.dots = r.dots; s.bowl.legal = r.balls; s.bowl.extras = r.extras; }
  }
  return out;
}

// ── attribute mix ─────────────────────────────────────────────────────

/** Pseudo-balls of the population average added to each record (a thin record says little about style) */
const MIX_PRIOR_BALLS: Record<LongFmt, { bat: number; bowl: number }> = { ListA: { bat: 120, bowl: 180 }, FC: { bat: 300, bowl: 360 } };
/** Cricsheet dot-ball / extras rates count once a player has this many balls of them */
const MIN_CRICSHEET_BALLS = 200;
/** The attribute-mix reference: regulars who played the format in the last this many seasons */
const MIX_CURRENT_SEASONS = 4;
/** A side's attributes come from its format stats once it has this many balls in the format (else the T20 mix) */
const MIN_MIX_BALLS = 200;

type Features = Record<string, number | undefined>;
interface PopRates { rpb: number; opb: number; bnd: number; six: number; four: number; dot: number; wpb: number; brpb: number; bdot: number; extras: number }

function populationRates(stats: Map<number, FormatStats>): PopRates {
  let bb = 0, br = 0, bo = 0, b4 = 0, b6 = 0, bnd = 0, dots = 0, dotBalls = 0, wb = 0, wr = 0, ww = 0, wd = 0, wl = 0, we = 0;
  for (const s of stats.values()) {
    if (s.bat) { bb += s.bat.balls; br += s.bat.runs; bo += s.bat.outs; b4 += s.bat.fours; b6 += s.bat.sixes; bnd += s.bat.bndBalls; dots += s.bat.dots ?? 0; dotBalls += s.bat.dotBalls ?? 0; }
    if (s.bowl) { wb += s.bowl.balls; wr += s.bowl.runs; ww += s.bowl.wkts; wd += s.bowl.dots ?? 0; wl += s.bowl.legal ?? 0; we += s.bowl.extras ?? 0; }
  }
  return {
    rpb: br / Math.max(1, bb), opb: bo / Math.max(1, bb), bnd: (b4 + b6) / Math.max(1, bnd), six: b6 / Math.max(1, bnd), four: b4 / Math.max(1, bnd),
    dot: dots / Math.max(1, dotBalls), wpb: ww / Math.max(1, wb), brpb: wr / Math.max(1, wb), bdot: wd / Math.max(1, wl), extras: we / Math.max(1, wl),
  };
}

function batFeatures(s: NonNullable<FormatStats["bat"]>, pop: PopRates, n0: number): Features {
  const balls = s.balls + n0, runs = s.runs + n0 * pop.rpb, outs = s.outs + n0 * pop.opb;
  const share = s.bndBalls > 0 ? Math.min(1, s.bndBalls / s.balls) : 0;
  const bndBalls = s.bndBalls + n0, fours = s.fours + n0 * pop.four, sixes = s.sixes + n0 * pop.six;
  // Boundaries on the innings that record them, scaled to all balls faced, for the runs not from boundaries
  const bndRuns = share > 0 ? ((s.fours * 4 + s.sixes * 6) / share) : (s.balls * (pop.four * 4 + pop.six * 6));
  const nonBnd = Math.max(0, s.runs - bndRuns) + n0 * (pop.rpb - 4 * pop.four - 6 * pop.six);
  const hasDots = (s.dotBalls ?? 0) >= MIN_CRICSHEET_BALLS;
  return {
    avg: runs / Math.max(0.5, outs), sr: (100 * runs) / balls, bpo: balls / Math.max(0.5, outs),
    bdry: (fours + sixes) / bndBalls, six: sixes / bndBalls, srnb: (100 * nonBnd) / balls,
    dot: hasDots ? ((s.dots ?? 0) + n0 * pop.dot) / (s.dotBalls! + n0) : undefined,
    exp: Math.log1p(s.matches),
  };
}

function bowlFeatures(s: NonNullable<FormatStats["bowl"]>, pop: PopRates, n0: number): Features {
  const balls = s.balls + n0;
  const hasCs = (s.legal ?? 0) >= MIN_CRICSHEET_BALLS;
  return {
    wpb: (s.wkts + n0 * pop.wpb) / balls, rpb: (s.runs + n0 * pop.brpb) / balls, bpi: s.balls / Math.max(1, s.inns),
    dot: hasCs ? ((s.dots ?? 0) + n0 * pop.bdot) / (s.legal! + n0) : undefined,
    extras: hasCs ? ((s.extras ?? 0) + n0 * pop.extras) / (s.legal! + n0) : undefined,
    exp: Math.log1p(s.matches),
  };
}

/** Weighted z-score blends per attribute (calculator.ts weights; dot balls and extras where Cricsheet has them) */
const BAT_BLEND: Record<(typeof BAT_KEYS)[number], [string, number][]> = {
  battingIQ: [["avg", 0.40], ["bpo", 0.25], ["srnb", 0.20], ["exp", 0.05], ["-dot", 0.10]],
  timing: [["avg", 0.25], ["bpo", 0.20], ["srnb", 0.20], ["sr", 0.20], ["bdry", 0.15]],
  power: [["sr", 0.2], ["bdry", 0.4], ["six", 0.4]],
  // The game's T20 running is the ratings model's running component, not age: here non-boundary scoring and strike rotation
  running: [["sr", 0.3], ["srnb", 0.5], ["-dot", 0.2]],
};
const BOWL_BLEND: Record<(typeof BOWL_KEYS)[number], [string, number][]> = {
  wicketTaking: [["wpb", 0.6], ["-rpb", 0.2], ["bpi", 0.1], ["exp", 0.1]],
  economy: [["-rpb", 0.7], ["dot", 0.2], ["bpi", 0.1]],
  accuracy: [["exp", 0.4], ["-rpb", 0.2], ["dot", 0.3], ["-extras", 0.1]],
};

type Moments = Record<string, { mean: number; sd: number }>;

function moments(list: Features[]): Moments {
  const out: Moments = {};
  const keys = new Set(list.flatMap(f => Object.keys(f)));
  for (const k of keys) {
    const xs = list.map(f => f[k]).filter((v): v is number => v !== undefined && Number.isFinite(v));
    const mean = xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, xs.length)) || 1;
    out[k] = { mean, sd };
  }
  return out;
}

function blend(f: Features, m: Moments, weights: [string, number][]): number {
  let s = 0, w = 0;
  for (const [key, wt] of weights) {
    const neg = key.startsWith("-");
    const k = neg ? key.slice(1) : key;
    const v = f[k];
    if (v === undefined || !Number.isFinite(v) || !m[k]) continue;
    s += wt * ((neg ? -1 : 1) * (v - m[k].mean)) / m[k].sd;
    w += wt;
  }
  return w > 0 ? s / w : 0;
}

// ── the generator ─────────────────────────────────────────────────────

interface SideResult {
  est?: FormatScore;
  score?: number;
  /** Overall before caps, and after */
  raw: number;
  overall: number;
  source: "data" | "derived";
  capped?: string;
  mix: "format" | "t20";
  /** Career matches in the format and T20 balls in the side (diagnostics) */
  matches: number;
  t20Balls: number;
}

interface PlayerResult {
  p: Shipped;
  formats: Record<"odi" | "test", { bat: SideResult; bowl: SideResult; ratings: PlayerRatings; source: "data" | "derived"; role: PlayerRole }>;
}

const ovr = (side: Side, r: GameRatings | PlayerRatings) => (side === "bat" ? calculateBattingOverall(r) : calculateBowlingOverall(r));

function runGender(gender: Gender, pool: PoolFile[] | null, validation: FormatValidation[]): { results: PlayerResult[]; summary: Record<string, unknown> } {
  const t0 = Date.now();
  const shipped = shippedPlayers(gender, pool);
  const espn = shipped.filter(p => p.group === "espn");
  const nonEspnIds = new Set(shipped.filter(p => p.group !== "espn" && p.caId !== undefined).map(p => p.caId!));
  const senior = loadCaFormats(gender, AS_OF);
  const merged = loadCaFormats(gender, AS_OF, { lower: true, ids: nonEspnIds });
  const formatsOf = (p: Shipped): CaPlayerFormats => (p.caId === undefined ? {} : (p.group === "espn" ? senior.get(p.caId) : merged.get(p.caId)) ?? {});
  const translations = fitTranslations(senior.values(), gender);
  const stats = loadFormatStats(gender);
  const params = caParams(gender);
  console.log(`${gender}: ${shipped.length} shipped players (${espn.length} ESPN), CA rows ${senior.size} (${Date.now() - t0} ms)`);

  // T20 reference: ESPN players who are T20 regulars in a side, their runtime overall and attributes
  const t20Regular = (p: Shipped, side: Side) => doesSide(formatsOf(p).T20?.[side], REGULAR_BALLS[gender].T20);
  const t20Ref = Object.fromEntries(SIDES.map(side => {
    const regs = espn.filter(p => t20Regular(p, side));
    const attrs = Object.fromEntries((side === "bat" ? BAT_KEYS : BOWL_KEYS).map(k => [k, regs.map(p => p.t20[k]).sort((a, b) => a - b)]));
    return [side, { overalls: regs.map(p => ovr(side, p.t20)).sort((a, b) => a - b), attrs }];
  })) as Record<Side, { overalls: number[]; attrs: Record<string, number[]> }>;

  const results: PlayerResult[] = shipped.map(p => ({ p, formats: {} as PlayerResult["formats"] }));
  const summary: Record<string, unknown> = { players: shipped.length, espn: espn.length };

  for (const fmt of FORMATS) {
    const fstats = stats[fmt.ca];
    const pop = populationRates(fstats);
    const n0 = MIX_PRIOR_BALLS[fmt.ca];
    // Attribute-mix populations: regulars of the format who still play it (career rates are not era-adjusted, and
    // scoring has risen since 2000: against every regular since then, today's bowlers would all look expensive)
    const current = [...fstats.values()].filter(s => s.lastYear >= AS_OF - MIX_CURRENT_SEASONS);
    const batRegs = current.filter(s => (s.bat?.balls ?? 0) >= REGULAR_BALLS[gender][fmt.ca]).map(s => batFeatures(s.bat!, pop, n0.bat));
    const bowlRegs = current.filter(s => (s.bowl?.balls ?? 0) >= REGULAR_BALLS[gender][fmt.ca]).map(s => bowlFeatures(s.bowl!, pop, n0.bowl));
    const batM = moments(batRegs), bowlM = moments(bowlRegs);
    const batBlends = Object.fromEntries(BAT_KEYS.map(k => [k, batRegs.map(f => blend(f, batM, BAT_BLEND[k])).sort((a, b) => a - b)]));
    const bowlBlends = Object.fromEntries(BOWL_KEYS.map(k => [k, bowlRegs.map(f => blend(f, bowlM, BOWL_BLEND[k])).sort((a, b) => a - b)]));

    const sideOut = {} as Record<Side, SideResult[]>;
    const regularsOf = {} as Record<Side, number[]>;
    const linkedOf = {} as Record<Side, number[]>;
    for (const side of SIDES) {
      const v = validation.find(x => x.format === fmt.ca && x.side === side);
      const dataVar = UNTUNED_DATA_VAR[`${gender}/${fmt.ca}`] ?? v?.dataVar ?? 1;
      const ctx: EstimateContext = buildContext(senior, fmt.ca, gender, AS_OF, dataVar, translations);
      const est = shipped.map(p => estimateFormat(formatsOf(p), fmt.ca, side, ctx));
      const score = est.map(e => (e ? e.mean - RANK_CONSERVATISM * e.sd : undefined));
      const isRegular = (i: number) => {
        const r = formatsOf(shipped[i])[fmt.ca]?.[side];
        return shipped[i].group === "espn" && est[i]?.source === "data" && doesSide(r, REGULAR_BALLS[gender][fmt.ca]) && AS_OF - r.year <= REGULAR_MAX_AGE;
      };
      const regIdx = shipped.map((_, i) => i).filter(isRegular);
      regularsOf[side] = regIdx;
      // Link on players who are regulars of both; fall back to all format regulars vs all T20 regulars
      const linked = regIdx.filter(i => t20Regular(shipped[i], side));
      const useLinked = linked.length >= MIN_LINK_PLAYERS;
      linkedOf[side] = useLinked ? linked : [];
      const curve = useLinked
        ? linkCurve(linked.map(i => score[i]!), linked.map(i => ovr(side, shipped[i].t20)))
        : linkCurve(regIdx.map(i => score[i]!), t20Ref[side].overalls);
      const raw = shipped.map((_, i) => (score[i] !== undefined ? readCurve(curve, score[i]!) : undefined));

      // Sides with no CA evidence anywhere: follow the T20 overall along a line fitted on players rated from data
      const dataIdx = shipped.map((_, i) => i).filter(i => shipped[i].group === "espn" && est[i]?.source === "data");
      const line = fitLine(dataIdx.map(i => ({ x: ovr(side, shipped[i].t20), y: raw[i]!, w: 1 })));

      // caps
      const K = params[`${side}/${fmt.ca}`].K;
      const threshold = Math.ceil((K * CAP_RELIABILITY) / (1 - CAP_RELIABILITY) / 100) * 100;
      const established = shipped.map((_, i) => i).filter(i => shipped[i].group === "espn" && est[i]?.source === "data" && est[i]!.balls >= threshold).map(i => raw[i]!).sort((a, b) => a - b);
      const regValues = regIdx.map(i => raw[i]!).sort((a, b) => a - b);
      // Too few established players (women's Tests): the regulars stand in for them
      const capRef = established.length >= 20 ? established : regValues;
      const cap95 = capRef.length >= 20 ? quantile(capRef, CAP_PERCENTILE) : 99;
      const median = regValues.length ? quantile(regValues, 0.5) : 99;
      const tierCeil = TIER_CEILING_PCT.map(q => (capRef.length ? quantile(capRef, q) : 99));

      sideOut[side] = shipped.map((p, i) => {
        const e = est[i];
        let value = raw[i] ?? line.a + line.b * ovr(side, p.t20);
        const source: "data" | "derived" = e?.source ?? "derived";
        let capped: string | undefined;
        const capTo = (c: number, why: string) => { if (value > c) { value = c; capped = why; } };
        // A side he doesn't do in the format (no record of 6+ balls a match, over his career and his last seasons of it)
        // keeps his T20 level: a batter's part-time bowling must not be lifted by a translation or the line fitted on bowlers
        const doesNow = doesSideNow(formatsOf(p)[fmt.ca]?.[side]);
        if (!doesNow) capTo(ovr(side, p.t20), "not-done");
        if (source === "derived") capTo(median, "derived");
        else if (e!.balls < threshold) capTo(cap95, "small-sample");
        if (p.group === "extended" && p.tier && p.tier !== "senior") capTo(tierCeil[Number(p.tier.slice(4))] ?? median, "tier");
        const st = side === "bat" ? (p.caId !== undefined ? fstats.get(p.caId)?.bat : undefined) : (p.caId !== undefined ? fstats.get(p.caId)?.bowl : undefined);
        return {
          est: e, score: score[i], raw: raw[i] ?? value, overall: Math.round(Math.max(1, Math.min(99, value))), source, capped,
          mix: doesNow && source === "data" && st && st.balls >= MIN_MIX_BALLS ? "format" : "t20",
          matches: formatsOf(p)[fmt.ca]?.[side]?.matches ?? 0, t20Balls: formatsOf(p).T20?.[side]?.balls ?? 0,
        };
      });
      summary[`${fmt.key}/${side}`] = {
        dataVar: ctx.dataVar, prior: ctx.prior[side], linkPlayers: useLinked ? linked.length : 0, regulars: regIdx.length,
        t20Regulars: t20Ref[side].overalls.length, threshold, cap95, median,
        line: { a: +line.a.toFixed(2), b: +line.b.toFixed(3) },
        curve: curve.filter((_, j) => j % Math.max(1, Math.floor(curve.length / 20)) === 0).map(c => [+c.x.toFixed(1), +c.y.toFixed(1)]),
        translation: translations[`${side}/T20>${fmt.ca}`],
      };
    }

    // attributes
    results.forEach((res, i) => {
      const p = res.p;
      const st = p.caId !== undefined ? fstats.get(p.caId) : undefined;
      const r: PlayerRatings = { ...p.t20 };
      const bat = sideOut.bat[i], bowl = sideOut.bowl[i];
      if (bat.mix === "format" && st?.bat) {
        const f = batFeatures(st.bat, pop, n0.bat);
        for (const k of BAT_KEYS) r[k] = quantile(t20Ref.bat.attrs[k], percentile(batBlends[k], blend(f, batM, BAT_BLEND[k])));
      }
      if (bowl.mix === "format" && st?.bowl) {
        const f = bowlFeatures(st.bowl, pop, n0.bowl);
        for (const k of BOWL_KEYS) r[k] = quantile(t20Ref.bowl.attrs[k], percentile(bowlBlends[k], blend(f, bowlM, BOWL_BLEND[k])));
      }
      // Shift to the targets, normalise like createPlayerFromData, repeat once (the clutch floor moves bowling overall)
      // With the player's T20 role: his format views share it (a derived all-rounder capped at the medians must not be
      // squashed into a bowler)
      let ratings = r;
      const role = p.role;
      for (let pass = 0; pass < 2; pass++) {
        shiftTo(ratings as GameRatings, [...BAT_KEYS], calculateBattingOverall, bat.overall);
        shiftTo(ratings as GameRatings, [...BOWL_SHIFT_KEYS], calculateBowlingOverall, bowl.overall);
        ratings = normalizeRatingsForRole(ratings, role, p.isWicketKeeper);
      }
      // A tail-ender's batting can be shifted to the bottom of the scale: floor it where the runtime squash floors T20 sets
      for (const k of CORE_KEYS) ratings[k] = Math.max(ATTRIBUTE_FLOOR, Math.min(99, Math.round(ratings[k])));
      for (const k of ["fielding", "keeping"] as const) { if (p.t20[k] !== undefined) ratings[k] = p.t20[k]; else delete ratings[k]; }
      const main: Side = ovr("bat", p.t20) >= ovr("bowl", p.t20) ? "bat" : "bowl";
      res.formats[fmt.key] = { bat, bowl, ratings, source: (main === "bat" ? bat : bowl).source, role };
    });
    // Distribution check: final discipline overall of the format's regulars against T20 regulars' T20 overall
    const qs = (xs: number[]) => [0.1, 0.25, 0.5, 0.75, 0.9, 1].map(q => quantile([...xs].sort((a, b) => a - b), q));
    for (const side of SIDES) {
      const sum = summary[`${fmt.key}/${side}`] as Record<string, unknown>;
      sum.distribution = {
        format: qs(regularsOf[side].map(i => ovr(side, results[i].formats[fmt.key].ratings))),
        t20: qs(t20Ref[side].overalls),
        formatAttrs: Object.fromEntries((side === "bat" ? BAT_KEYS : BOWL_KEYS).map(k => [k, qs(regularsOf[side].map(i => results[i].formats[fmt.key].ratings[k]))])),
        t20Attrs: Object.fromEntries((side === "bat" ? BAT_KEYS : BOWL_KEYS).map(k => [k, qs(t20Ref[side].attrs[k])])),
        // The linked players (regulars of both): their format set against their own T20 set
        linked: Object.fromEntries([["overall", (r: PlayerRatings) => ovr(side, r)] as const, ...(side === "bat" ? BAT_KEYS : BOWL_KEYS).map(k => [k, (r: PlayerRatings) => r[k]] as const)]
          .map(([k, get]) => [k, { format: qs(linkedOf[side].map(i => get(results[i].formats[fmt.key].ratings))), t20: qs(linkedOf[side].map(i => get(results[i].p.t20))) }])),
      };
    }
  }
  return { results, summary };
}

// ── outputs ───────────────────────────────────────────────────────────

function core(r: PlayerRatings): Pick<PlayerRatings, (typeof CORE_KEYS)[number]> {
  return Object.fromEntries(CORE_KEYS.map(k => [k, r[k]])) as Pick<PlayerRatings, (typeof CORE_KEYS)[number]>;
}

function setsOf(res: PlayerResult): [EncodedSet, EncodedSet] {
  return [encodeSet(core(res.formats.odi.ratings), res.formats.odi.source), encodeSet(core(res.formats.test.ratings), res.formats.test.source)];
}

function diagnostics(res: PlayerResult) {
  const side = (s: SideResult) => ({
    matches: s.matches, t20Balls: s.t20Balls,
    mean: s.est ? +s.est.mean.toFixed(2) : null, sd: s.est ? +s.est.sd.toFixed(2) : null, w: s.est ? +s.est.dataWeight.toFixed(2) : 0,
    from: s.est?.from ?? null, balls: s.est?.balls ?? 0, raw: +s.raw.toFixed(1), overall: s.overall, source: s.source, capped: s.capped ?? null, mix: s.mix,
  });
  const f = (k: "odi" | "test") => {
    const x = res.formats[k];
    const b = calculateBattingOverall(x.ratings), w = calculateBowlingOverall(x.ratings);
    return { bat: side(x.bat), bowl: side(x.bowl), batOvr: b, bowlOvr: w, overall: calculateOverallRating(b, w), source: x.source, role: x.role, ratings: core(x.ratings) };
  };
  const p = res.p;
  const b = calculateBattingOverall(p.t20), w = calculateBowlingOverall(p.t20);
  return {
    id: p.id, name: p.name, country: p.country, age: p.age, group: p.group, tier: p.tier ?? null, caId: p.caId ?? null, role: p.role,
    t20: { batOvr: b, bowlOvr: w, overall: calculateOverallRating(b, w), ratings: core(p.t20) }, odi: f("odi"), test: f("test"),
  };
}

function main(): void {
  const only = arg("--gender") as Gender | undefined;
  const withPool = !process.argv.includes("--no-pool");
  const poolData = withPool ? loadPoolShards() : null;
  const file: FormatRatingsFile = existsSync(OUT_JSON) && only
    ? JSON.parse(readFileSync(OUT_JSON, "utf-8")) as FormatRatingsFile
    : { v: FORMAT_RATINGS_VERSION, generated: "", players: {} };
  file.v = FORMAT_RATINGS_VERSION;
  file.generated = new Date().toISOString();
  const diag: Record<string, unknown> = existsSync(DIAG_FILE) && only ? JSON.parse(readFileSync(DIAG_FILE, "utf-8")) : {};
  const valOut: Record<string, FormatValidation> = existsSync(VALIDATION_OUT) && only ? JSON.parse(readFileSync(VALIDATION_OUT, "utf-8")) : {};
  const poolSets = new Map<string, [EncodedSet, EncodedSet][]>();

  for (const gender of ["male", "female"] as const) {
    if (only && only !== gender) continue;
    // Out-of-sample tuning of the data / prior balance (and the numbers for the report)
    const cache = new Map<number, Map<number, CaPlayerFormats>>();
    const validation: FormatValidation[] = [];
    for (const f of ["ListA", "FC"] as const) for (const side of SIDES) {
      const v = validate(gender, f, side, cache);
      validation.push(v);
      valOut[`${gender}/${f}/${side}`] = v;
      console.log(`  validation ${gender} ${f} ${side}: DATA_VAR ${v.dataVar}, held-out corr ${v.holdout[0].all.corr.toFixed(3)} (T20 rating ${v.holdout.find(h => h.predictor.startsWith("T20 rating ("))?.all.corr.toFixed(3)})`);
    }
    const { results, summary } = runGender(gender, poolData?.files ?? null, validation);
    const out: unknown[] = [];
    for (const res of results) {
      const sets = setsOf(res);
      if (res.p.group !== "extended") file.players[res.p.id] = sets;
      else {
        const list = poolSets.get(res.p.row!.shard) ?? [];
        list[res.p.row!.index] = sets;
        poolSets.set(res.p.row!.shard, list);
      }
      if (res.p.group !== "extended" || res.p.tier === "senior") out.push(diagnostics(res));
    }
    const count = (k: "odi" | "test", s: "data" | "derived", g?: Shipped["group"]) => results.filter(r => (!g || r.p.group === g) && r.formats[k].source === s).length;
    summary.sources = {
      espn: { odiData: count("odi", "data", "espn"), testData: count("test", "data", "espn"), odiDerived: count("odi", "derived", "espn"), testDerived: count("test", "derived", "espn") },
      extended: { odiData: count("odi", "data", "extended"), testData: count("test", "data", "extended") },
      league: { odiData: count("odi", "data", "league"), testData: count("test", "data", "league"), players: results.filter(r => r.p.group === "league").length },
    };
    diag[gender] = { summary, players: out };
    console.log(`  ${gender}:`, JSON.stringify(summary.sources));
  }

  mkdirSync(join(OUT_JSON, ".."), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(file));
  console.log(`format-ratings.json: ${Object.keys(file.players).length} players, ${(readFileSync(OUT_JSON).length / 1024).toFixed(0)} KB (${(gzipSync(readFileSync(OUT_JSON)).length / 1024).toFixed(0)} KB gzipped)`);
  writeFileSync(DIAG_FILE, JSON.stringify(diag));
  writeFileSync(VALIDATION_OUT, JSON.stringify(valOut, null, 1));

  if (poolData) {
    for (const f of poolData.files) {
      const sets = poolSets.get(f.file);
      if (!sets) continue;
      const rows: PoolRow[] = f.players.map((p, i) => ({
        id: Number(p.id.slice(3)), name: p.name, age: p.age, country: p.country, role: p.role as PoolRow["role"],
        ratings: CORE_KEYS.map(k => p.ratings[k]) as PoolRow["ratings"], bowlingStyle: p.bowlingStyle ?? "unknown",
        battingHand: p.battingHand ?? "right", isWicketKeeper: !!p.isWicketKeeper,
        matches: p.careerStats?.m ?? 0, runs: p.careerStats?.r ?? 0, average: p.careerStats?.avg ?? 0, strikeRate: p.careerStats?.sr ?? 0,
        wickets: p.careerStats?.w ?? 0, economy: p.careerStats?.econ ?? 0, lastYear: p.lastYear, formats: sets[i],
      }));
      // Same T20 rows as before (only the format sets are new): check before writing
      const shard = encodeShard(f.shard.gender, f.shard.tier, rows);
      shard.countries.forEach((c, i) => { if (c !== f.shard.countries[i]) throw new Error(`${f.file}: country table changed`); });
      f.shard.rows.forEach((r, i) => { if (JSON.stringify(r.slice(0, 23)) !== JSON.stringify(shard.rows[i].slice(0, 23))) throw new Error(`${f.file}: row ${i} changed`); });
      const bytes = gzipSync(Buffer.from(JSON.stringify(shard)), { level: 9 });
      writeFileSync(join(POOL_DIR, f.file), bytes);
      const info = poolData.manifest.shards.find(s => s.file === f.file)!;
      info.bytes = bytes.length;
    }
    poolData.manifest.version = POOL_VERSION;
    writeFileSync(join(POOL_DIR, "manifest.json"), JSON.stringify(poolData.manifest, null, 1));
    const total = poolData.manifest.shards.reduce((s, x) => s + x.bytes, 0);
    console.log(`pool shards rewritten with format sets: ${poolData.manifest.shards.length} files, ${(total / 1024).toFixed(0)} KB`);
  }
}

main();
