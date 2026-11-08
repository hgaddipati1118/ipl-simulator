/**
 * ODI and Test level of every CricketArchive player: the CA List A / first-class ratings (src/analysis/ca-ratings.py:
 * competition- and opponent-adjusted, decayed, shrunk) as the evidence, the player's other formats as a prior.
 *
 * Scale: CA runs per 100 balls above the average ball of the competition-season (batting: value of runs and of
 * staying in, a wicket worth 0.5 x runs per wicket in List A and 1.0 x in first-class; bowling the mirror image).
 * ODIs are List A matches and Tests first-class ones, split by opponent in the CA fit, so a List A rating already
 * counts an ODI against a strong side for more than a domestic one-day match.
 *
 * Per player, format (ListA = ODI, FC = Test) and side:
 *   - data: the format's latest CA rating (as of `asOf`), its sd widened for staleness (x 2^(years since / half-life),
 *     the CA model's own half-life) and scaled by DATA_VAR (tuned out of sample, format-ratings-report.ts);
 *   - prior: the best translation from another format (T20 or the other long format; weighted least squares over
 *     players rated in both, residual variance added to the sd, as ca-model.ts does for T20);
 *   - both: inverse-variance blend. `dataWeight` >= 0.5 makes the side "data", else "derived";
 *   - prior only ("derived"): shrunk toward a below-average prior (the 35th percentile of the format's regulars).
 * A side the player barely does (< 6 balls a match in the format) has no data, the same rule as ca-model.ts.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";

const DIR = new URL("../../data/analysis/", import.meta.url).pathname;
const CA_FILE = `${DIR}ca_ratings_by_year.parquet`;
const CELLS_FILE = `${DIR}ca_cells.parquet`;
const LOWER_FILE = `${DIR}ca_lower_ratings.parquet`;
const LOWER_CELLS_FILE = `${DIR}ca_lower_cells.parquet`;
const VALIDATION_FILE = `${DIR}ca_validation.json`;

export type CaFormat = "T20" | "ListA" | "FC";
export type Side = "bat" | "bowl";
export type Gender = "male" | "female";
export const CA_FORMATS: CaFormat[] = ["T20", "ListA", "FC"];
export const SIDES: Side[] = ["bat", "bowl"];
/** The CA format each longer game format is measured in */
export const CA_FORMAT_OF = { odi: "ListA", test: "FC" } as const satisfies Record<"odi" | "test", CaFormat>;

/** Least evidence (career balls in the format) for a rating to count as data at all; the sd does the rest */
export const MIN_EVIDENCE_BALLS = 60;
/** Same rule as ca-model.ts: a side done for fewer balls a match than this is not one the player does */
export const MIN_BALLS_PER_MATCH = 6;
/** Regulars of a format (the reference for the percentile map and the prior): career balls in the side */
export const REGULAR_BALLS: Record<Gender, Record<CaFormat, number>> = {
  male: { T20: 240, ListA: 480, FC: 1200 },
  // Women play few multi-day matches: 300 first-class balls is a regular (about three Tests)
  female: { T20: 240, ListA: 480, FC: 300 },
};
/** Players rated in both formats with this much evidence define a translation */
const TRANSLATE_MIN_BALLS: Record<CaFormat, number> = { T20: 500, ListA: 600, FC: 1200 };
/** Ratings of the two formats must be within this many years of each other to pair them for a translation */
const TRANSLATE_MAX_GAP = 2;
/** Players are ranked by mean - this many sds (model-ratings.ts FALLBACK_CONSERVATISM): a thin record ranks a little lower */
export const RANK_CONSERVATISM = 0.5;
/** Prior for a side with no data in the format: this percentile of the format's regulars (below average) */
export const DERIVED_PRIOR_PCT = 0.35;

export interface SideRating {
  rating: number;
  sd: number;
  /** Year of the rating (the last season he played the format, up to asOf) */
  year: number;
  /** Career balls in the format up to asOf */
  balls: number;
  /** Matches in the format (the larger of innings batted and bowled), for the balls-a-match rule */
  matches: number;
}
export type CaPlayerFormats = Partial<Record<CaFormat, Partial<Record<Side, SideRating>>>>;

interface Params { half_life: number; K: number }

/** Half-life and shrinkage K the CA model tuned per side, format and gender (ca_validation.json) */
export function caParams(gender: Gender): Record<`${Side}/${CaFormat}`, Params> {
  const fallback: Params = { half_life: 3, K: 1000 };
  const v = existsSync(VALIDATION_FILE) ? JSON.parse(readFileSync(VALIDATION_FILE, "utf-8").replace(/\bNaN\b/g, "null")) : {};
  const out = {} as Record<`${Side}/${CaFormat}`, Params>;
  for (const s of SIDES) for (const f of CA_FORMATS) out[`${s}/${f}`] = { ...fallback, ...(v[`${s}/${f}/${gender}`]?.params ?? {}) };
  return out;
}

function duck<T>(sql: string): T[] {
  return JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 * 1024 }) || "[]") as T[];
}

interface Row {
  player_id: number; format: CaFormat;
  bat_rating: number | null; bat_sd: number | null; bat_year: number | null;
  bowl_rating: number | null; bowl_sd: number | null; bowl_year: number | null;
  bat_balls: number | null; bat_inns: number | null; bowl_balls: number | null; bowl_inns: number | null;
}

function toFormats(rows: Row[], into = new Map<number, CaPlayerFormats>()): Map<number, CaPlayerFormats> {
  for (const r of rows) {
    const id = Number(r.player_id);
    const entry = into.get(id) ?? {};
    const matches = Math.max(r.bat_inns ?? 0, r.bowl_inns ?? 0);
    const side = (s: Side): SideRating | undefined => {
      const rating = s === "bat" ? r.bat_rating : r.bowl_rating;
      if (rating === null || rating === undefined) return undefined;
      return {
        rating, sd: (s === "bat" ? r.bat_sd : r.bowl_sd) ?? 15, year: Number((s === "bat" ? r.bat_year : r.bowl_year) ?? 0),
        balls: Number((s === "bat" ? r.bat_balls : r.bowl_balls) ?? 0), matches,
      };
    };
    const fmt: Partial<Record<Side, SideRating>> = { ...(entry[r.format] ?? {}) };
    for (const s of SIDES) { const v = side(s); if (v) fmt[s] = v; }
    entry[r.format] = fmt;
    into.set(id, entry);
  }
  return into;
}

/**
 * Every CA player's ratings per format and side as they stood at the end of `asOf` (the latest rated season up to it),
 * with career balls up to then. `lower` merges in the lower-level ratings (second XIs and below, on the senior scale;
 * per side they replace the senior rating, which they include) for players without one: only meaningful for asOf =
 * the last season, since the lower-level file holds the latest ratings only.
 */
export function loadCaFormats(gender: Gender, asOf: number, opts: { lower?: boolean; ids?: Set<number> } = {}): Map<number, CaPlayerFormats> {
  const sql = `
    WITH last AS (
      SELECT player_id, format,
             arg_max(bat_rating, year) FILTER (WHERE bat_rating IS NOT NULL) AS bat_rating,
             arg_max(bat_sd, year) FILTER (WHERE bat_rating IS NOT NULL) AS bat_sd,
             max(year) FILTER (WHERE bat_rating IS NOT NULL) AS bat_year,
             arg_max(bowl_rating, year) FILTER (WHERE bowl_rating IS NOT NULL) AS bowl_rating,
             arg_max(bowl_sd, year) FILTER (WHERE bowl_rating IS NOT NULL) AS bowl_sd,
             max(year) FILTER (WHERE bowl_rating IS NOT NULL) AS bowl_year
      FROM '${CA_FILE}' WHERE gender = '${gender}' AND year <= ${asOf} GROUP BY ALL),
    car AS (SELECT player_id, format, side, sum(balls) AS balls, sum(inns) AS inns FROM '${CELLS_FILE}'
            WHERE gender = '${gender}' AND year <= ${asOf} GROUP BY ALL)
    SELECT l.*, b.balls AS bat_balls, b.inns AS bat_inns, w.balls AS bowl_balls, w.inns AS bowl_inns
    FROM last l
    LEFT JOIN car b ON b.player_id = l.player_id AND b.format = l.format AND b.side = 'bat'
    LEFT JOIN car w ON w.player_id = l.player_id AND w.format = l.format AND w.side = 'bowl'`;
  const out = toFormats(duck<Row>(sql));
  if (opts.lower && existsSync(LOWER_FILE) && existsSync(LOWER_CELLS_FILE)) {
    const lsql = `
      WITH car AS (
        SELECT player_id, format, side, sum(balls) AS balls, sum(inns) AS inns FROM (
          SELECT player_id, format, side, balls, inns FROM '${CELLS_FILE}' WHERE gender = '${gender}'
          UNION ALL SELECT player_id, format, side, balls, inns FROM '${LOWER_CELLS_FILE}' WHERE gender = '${gender}') GROUP BY ALL)
      SELECT l.player_id, l.format, l.bat_rating, l.bat_sd, CASE WHEN l.bat_rating IS NOT NULL THEN l.year END AS bat_year,
             l.bowl_rating, l.bowl_sd, CASE WHEN l.bowl_rating IS NOT NULL THEN l.year END AS bowl_year,
             b.balls AS bat_balls, b.inns AS bat_inns, w.balls AS bowl_balls, w.inns AS bowl_inns
      FROM '${LOWER_FILE}' l
      LEFT JOIN car b ON b.player_id = l.player_id AND b.format = l.format AND b.side = 'bat'
      LEFT JOIN car w ON w.player_id = l.player_id AND w.format = l.format AND w.side = 'bowl'
      WHERE l.gender = '${gender}'`;
    const lower = duck<Row>(lsql).filter(r => !opts.ids || opts.ids.has(Number(r.player_id)));
    toFormats(lower, out);
  }
  return out;
}

// ── translations between formats ──────────────────────────────────────

export interface Translation { a: number; b: number; residVar: number; n: number }
export type TranslationKey = `${Side}/${CaFormat}>${CaFormat}`;
export type Translations = Partial<Record<TranslationKey, Translation>>;

/** Weighted least squares of y on x (same estimator as ca-model.ts fitTranslation) */
export function fitLine(pairs: { x: number; y: number; w: number }[]): Translation {
  if (pairs.length < 30) return { a: 0, b: 1, residVar: 400, n: pairs.length };
  const sw = pairs.reduce((s, p) => s + p.w, 0);
  const mx = pairs.reduce((s, p) => s + p.w * p.x, 0) / sw;
  const my = pairs.reduce((s, p) => s + p.w * p.y, 0) / sw;
  const sxx = pairs.reduce((s, p) => s + p.w * (p.x - mx) ** 2, 0);
  const sxy = pairs.reduce((s, p) => s + p.w * (p.x - mx) * (p.y - my), 0);
  const b = sxx > 0 ? sxy / sxx : 1;
  const a = my - b * mx;
  const residVar = pairs.reduce((s, p) => s + p.w * (p.y - a - b * p.x) ** 2, 0) / sw;
  return { a, b, residVar, n: pairs.length };
}

/** A side counts as one the player does in a format: rated, enough balls, and enough of them a match */
export function doesSide(r: SideRating | undefined, minBalls = MIN_EVIDENCE_BALLS): r is SideRating {
  return !!r && r.balls >= minBalls && (r.matches > 0 ? r.balls / r.matches : 0) >= MIN_BALLS_PER_MATCH;
}

/** Translations from every format to every other, per side, over players rated in both */
export function fitTranslations(players: Iterable<CaPlayerFormats>): Translations {
  const out: Translations = {};
  const list = [...players];
  for (const side of SIDES) {
    for (const to of CA_FORMATS) {
      for (const from of CA_FORMATS) {
        if (from === to) continue;
        const pairs: { x: number; y: number; w: number }[] = [];
        for (const p of list) {
          const x = p[from]?.[side], y = p[to]?.[side];
          if (!doesSide(x, TRANSLATE_MIN_BALLS[from]) || !doesSide(y, TRANSLATE_MIN_BALLS[to])) continue;
          if (Math.abs(x.year - y.year) > TRANSLATE_MAX_GAP) continue;
          pairs.push({ x: x.rating, y: y.rating, w: (2 * x.balls * y.balls) / (x.balls + y.balls) });
        }
        out[`${side}/${from}>${to}`] = fitLine(pairs);
      }
    }
  }
  return out;
}

// ── the estimate ──────────────────────────────────────────────────────

export interface FormatScore {
  /** Expected level on the CA scale of the target format */
  mean: number;
  sd: number;
  /** Share of the estimate carried by the format's own record (0 = derived only) */
  dataWeight: number;
  source: "data" | "derived";
  /** Where the prior came from (a translated format), when one was used */
  from?: CaFormat;
  /** Career balls in the target format */
  balls: number;
}

export interface EstimateContext {
  asOf: number;
  translations: Translations;
  params: Record<`${Side}/${CaFormat}`, Params>;
  /** Below-average prior for derived-only sides, per side: mean and between-player sd of the format's regulars */
  prior: Record<Side, { mean: number; sd: number }>;
  /** Multiplier on the data variance (tuned out of sample); Infinity would ignore the record, 0 ignores the prior */
  dataVar: number;
}

/** Variance of a rating, widened for the years since it was last updated (the CA model's half-life) */
function staleVar(r: SideRating, fmt: CaFormat, side: Side, ctx: EstimateContext): number {
  const gap = Math.max(0, ctx.asOf - r.year);
  return r.sd ** 2 * 2 ** (gap / ctx.params[`${side}/${fmt}`].half_life);
}

/** The best translated prior for `target` from the player's other formats (smallest variance) */
export function translatedPrior(p: CaPlayerFormats, target: CaFormat, side: Side, ctx: EstimateContext): { mean: number; var: number; from: CaFormat } | undefined {
  let best: { mean: number; var: number; from: CaFormat } | undefined;
  for (const from of CA_FORMATS) {
    if (from === target) continue;
    const r = p[from]?.[side];
    const t = ctx.translations[`${side}/${from}>${target}`];
    if (!doesSide(r) || !t || t.n < 30) continue;
    const v = t.b ** 2 * staleVar(r, from, side, ctx) + t.residVar;
    const cand = { mean: t.a + t.b * r.rating, var: v, from };
    if (!best || cand.var < best.var) best = cand;
  }
  return best;
}

/** Level of a player in `target` for one side, or undefined when he has no rated format to go on */
export function estimateFormat(p: CaPlayerFormats, target: CaFormat, side: Side, ctx: EstimateContext): FormatScore | undefined {
  const own = p[target]?.[side];
  const data = doesSide(own) ? own : undefined;
  const prior = translatedPrior(p, target, side, ctx);
  const balls = own?.balls ?? 0;
  if (data) {
    const vD = staleVar(data, target, side, ctx) * ctx.dataVar;
    if (!prior || !Number.isFinite(prior.var)) return { mean: data.rating, sd: Math.sqrt(vD), dataWeight: 1, source: "data", balls };
    const wD = 1 / Math.max(1e-6, vD), wP = 1 / prior.var;
    const mean = (data.rating * wD + prior.mean * wP) / (wD + wP);
    const dataWeight = wD / (wD + wP);
    return { mean, sd: Math.sqrt(1 / (wD + wP)), dataWeight, source: dataWeight >= 0.5 ? "data" : "derived", from: prior.from, balls };
  }
  if (!prior) return undefined;
  // No record in the format: the translation, shrunk toward a below-average prior (a player who has not played the
  // format is, on average, one selectors did not pick for it)
  const pr = ctx.prior[side];
  const wT = 1 / prior.var, wP = 1 / pr.sd ** 2;
  const mean = (prior.mean * wT + pr.mean * wP) / (wT + wP);
  return { mean, sd: Math.sqrt(1 / (wT + wP)), dataWeight: 0, source: "derived", from: prior.from, balls };
}

/** Mean, between-player sd and the below-average prior of the regulars of a format, per side */
export function regularsPrior(players: Iterable<CaPlayerFormats>, target: CaFormat, gender: Gender, asOf: number): Record<Side, { mean: number; sd: number }> {
  const out = {} as Record<Side, { mean: number; sd: number }>;
  const list = [...players];
  for (const side of SIDES) {
    const xs = list.map(p => p[target]?.[side]).filter((r): r is SideRating => doesSide(r, REGULAR_BALLS[gender][target]) && asOf - r.year <= 2)
      .map(r => r.rating).sort((a, b) => a - b);
    if (xs.length < 10) { out[side] = { mean: 0, sd: 15 }; continue; }
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
    out[side] = { mean: xs[Math.floor(DERIVED_PRIOR_PCT * (xs.length - 1))], sd };
  }
  return out;
}

/** Everything estimateFormat needs for one gender, format and season */
export function buildContext(players: Map<number, CaPlayerFormats>, target: CaFormat, gender: Gender, asOf: number, dataVar: number, translations?: Translations): EstimateContext {
  return {
    asOf, dataVar,
    translations: translations ?? fitTranslations(players.values()),
    params: caParams(gender),
    prior: regularsPrior(players.values(), target, gender, asOf),
  };
}
