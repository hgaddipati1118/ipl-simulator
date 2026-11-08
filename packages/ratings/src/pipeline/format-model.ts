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
 *   - data: the format's latest CA rating (as of `asOf`), its sd widened for staleness (x 2^(seasons since / half-life),
 *     the CA model's own half-life, at most two seasons) and scaled by DATA_VAR (tuned out of sample, format-validation.ts);
 *   - prior: the best translation from another format (T20 or the other long format; weighted least squares over
 *     players rated in both, residual variance added to the sd, as ca-model.ts does for T20; bowling from T20 also uses
 *     the player's T20 economy and strike rate, T20Style);
 *   - both: inverse-variance blend (`dataWeight` = the record's share);
 *   - prior only ("derived"): shrunk toward a below-average prior (the 35th percentile of the format's regulars).
 * A side the player barely does (< 6 balls a match in the format) has no data, the same rule as ca-model.ts.
 * The side is "data" when it is measured in the format: half a regular's balls (DATA_BALLS) and a rating no more than
 * DATA_MAX_AGE seasons older than the player's last season in any format (lastSeason: a retired player is rated as he
 * stopped); else "derived" (the blend still uses whatever record there is).
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { testProfileOf, type PlayerRole } from "@ipl-sim/engine";

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
/** A side is "data" (measured in the format) with this many career balls in it ... */
export const DATA_BALLS: Record<Gender, Record<CaFormat, number>> = {
  male: { T20: 120, ListA: 240, FC: 600 },
  female: { T20: 120, ListA: 240, FC: 150 },
};
/** ... and a rating no older than this many seasons */
export const DATA_MAX_AGE = 5;
/** Players rated in both formats with this much evidence define a translation (women: few play first-class cricket) */
const TRANSLATE_MIN_BALLS: Record<Gender, Record<CaFormat, number>> = {
  male: { T20: 500, ListA: 600, FC: 1200 },
  female: { T20: 500, ListA: 600, FC: 300 },
};
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
  /** Balls a match in the side over the player's last RECENT_SEASONS seasons in the format (senior cells), see doesSideNow */
  recentPerMatch?: number;
  /**
   * List A / first-class only (loadIntlEvidence): his record in internationals against full members (ODIs / Tests), balls
   * decayed with the CA half-life and the ball-weighted adjusted value per 100 balls, and the decayed share of his balls in
   * the format by domestic country (dom_IND ...). See IntlAdjust.
   */
  intlBalls?: number;
  intlAdj?: number;
  domShare?: Record<string, number>;
  /** Batting only: his ball-weighted mean batting position in the format, over his last RECENT_SEASONS seasons of it (4+ innings), else career */
  meanPos?: number;
}

/** Bowling workload (balls an innings in the field) from which a player is a front-line bowler in a format: six overs */
export const FRONT_LINE_BALLS = 36;
/** Batting position up to which a player bats in the order (and so is a batter, or an all-rounder if he also bowls) */
export const TOP_ORDER_POS = 7.5;

/** Balls he bowls an innings in the field in the format, recent seasons first (the Test profile's workload, from the CA cells) */
export function bowlingWorkload(r: SideRating | undefined): number | undefined {
  if (!r || r.matches <= 0) return undefined;
  return r.recentPerMatch ?? r.balls / r.matches;
}
/**
 * T20 style of a player, as z-scores against T20 regulars (500+ balls): batting [strike rate, log balls per dismissal],
 * bowling [runs per ball, wickets per ball]. Translations from T20 use it: a T20 rating earned by hitting (or by
 * economy) carries over to List A and, more so, to first-class cricket less than one earned by staying in (or by wickets).
 */
export type T20Style = Partial<Record<Side, [number, number]>>;
export type CaPlayerFormats = Partial<Record<CaFormat, Partial<Record<Side, SideRating>>>> & {
  style?: T20Style;
  /** Last rated season in senior cricket (lower-level cricket only if he has no senior record): see lastSeason */
  last?: number;
};

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
  for (const p of out.values()) p.last = lastRated(p);
  for (const r of loadRecentUse(gender, asOf)) {
    const side = out.get(Number(r.player_id))?.[r.format]?.[r.side];
    if (side) side.recentPerMatch = r.matches > 0 ? r.balls / r.matches : 0;
  }
  for (const r of loadT20Style(gender, asOf)) {
    const p = out.get(Number(r.player_id));
    if (p) (p.style ??= {})[r.side] = [r.z1, r.z2];
  }
  for (const r of loadBattingPositions(gender, asOf)) {
    const side = out.get(Number(r.player_id))?.[r.format]?.bat;
    if (side) side.meanPos = r.pos;
  }
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
    for (const p of out.values()) p.last ??= lastRated(p);
  }
  return out;
}

/**
 * Sides whose translation from T20 uses the T20 style. Bowling only: out of sample (format-validation.ts) the style term
 * lifts the T20 -> ODI / Test bowling prior (held-out correlation 0.32 -> 0.36 ODI, 0.20 -> 0.24 Test) but lowers the
 * batting one (0.31 -> 0.30 ODI, 0.24 -> 0.19 Test): in 2024-25 the hitters who were picked for Tests did well.
 */
const STYLE_SIDES: Side[] = ["bowl"];
/** Domestic countries with their own term in IntlAdjust; the rest share "other" */
export const DOM_COUNTRIES = ["IND", "ENG", "AUS", "RSA", "NZ", "PAK", "SL", "WI", "BDESH"] as const;

/**
 * International evidence for the long formats (see SideRating.intlBalls): per player and side, from the CA cells up to
 * asOf, decayed with the CA model's half-life for the side and format. Internationals are the cells against full members
 * outside the weak tier, valued as the CA model values them (the cell's value plus the opponent's fitted strength).
 */
export function loadIntlEvidence(players: Map<number, CaPlayerFormats>, gender: Gender, asOf: number): void {
  const params = caParams(gender);
  for (const format of ["ListA", "FC"] as const) {
    const rows = duck<{ player_id: number; side: Side; cls: string; year: number; balls: number; val: number }>(`
      WITH s AS (SELECT side, format, gender, comp, strength, weak_tier FROM read_csv('${DIR}ca_comp_strength.csv'))
      SELECT c.player_id, c.side,
             CASE WHEN c.comp_class = 'intl_full' AND NOT coalesce(s.weak_tier, false) THEN 'intl' ELSE c.comp_class END AS cls,
             c.year, sum(c.balls) AS balls, sum(c.value_ms + c.balls * coalesce(s.strength, 0) / 100) AS val
      FROM '${CELLS_FILE}' c LEFT JOIN s USING (side, format, gender, comp)
      WHERE c.gender = '${gender}' AND c.format = '${format}' AND c.year <= ${asOf} AND c.balls > 0
      GROUP BY ALL`);
    const acc = new Map<string, { intlB: number; intlV: number; all: number; dom: Record<string, number> }>();
    for (const r of rows) {
      const h = params[`${r.side}/${format}`].half_life;
      const w = 0.5 ** ((asOf - Number(r.year)) / h);
      const key = `${r.player_id}/${r.side}`;
      const a = acc.get(key) ?? { intlB: 0, intlV: 0, all: 0, dom: {} };
      a.all += w * r.balls;
      if (r.cls === "intl") { a.intlB += w * r.balls; a.intlV += w * r.val; }
      else if (r.cls.startsWith("dom_")) {
        const c = (DOM_COUNTRIES as readonly string[]).includes(r.cls.slice(4)) ? r.cls.slice(4) : "other";
        a.dom[c] = (a.dom[c] ?? 0) + w * r.balls;
      }
      acc.set(key, a);
    }
    for (const [key, a] of acc) {
      const [id, side] = key.split("/") as [string, Side];
      const sr = players.get(Number(id))?.[format]?.[side];
      if (!sr || a.all <= 0) continue;
      sr.intlBalls = a.intlB;
      sr.intlAdj = a.intlB > 0 ? (100 * a.intlV) / a.intlB : undefined;
      sr.domShare = Object.fromEntries(Object.entries(a.dom).map(([c, b]) => [c, b / a.all]));
    }
  }
}

/** Seasons of a format, counted back from the player's last one, that say whether he still does a side in it */
export const RECENT_SEASONS = 3;

/** Balls per side and matches over each player's last RECENT_SEASONS seasons in each format (senior cells, up to asOf) */
function loadRecentUse(gender: Gender, asOf: number): { player_id: number; format: CaFormat; side: Side; balls: number; matches: number }[] {
  return duck(`
    WITH c AS (SELECT player_id, format, year, side, sum(balls) AS balls, sum(inns) AS inns FROM '${CELLS_FILE}'
               WHERE gender = '${gender}' AND year <= ${asOf} GROUP BY ALL),
    y AS (SELECT player_id, format, year, max(inns) AS matches,
                 row_number() OVER (PARTITION BY player_id, format ORDER BY year DESC) AS k FROM c GROUP BY player_id, format, year),
    recent AS (SELECT player_id, format, year FROM y WHERE k <= ${RECENT_SEASONS}),
    m AS (SELECT y.player_id, y.format, sum(y.matches) AS matches FROM y JOIN recent USING (player_id, format, year) GROUP BY ALL)
    SELECT m.player_id, m.format, s.side, coalesce(sum(c.balls), 0) AS balls, any_value(m.matches) AS matches
    FROM m CROSS JOIN (VALUES ('bat'), ('bowl')) s(side)
    LEFT JOIN (SELECT c.* FROM c JOIN recent USING (player_id, format, year)) c ON c.player_id = m.player_id AND c.format = m.format AND c.side = s.side
    GROUP BY ALL`);
}

/** Mean batting position per player and format: the last RECENT_SEASONS seasons of it with 4+ innings, else his career */
function loadBattingPositions(gender: Gender, asOf: number): { player_id: number; format: CaFormat; pos: number }[] {
  return duck(`
    WITH c AS (SELECT player_id, format, year, sum(inns) AS inns, sum(balls) AS balls, sum(mean_position * balls) AS pb FROM '${CELLS_FILE}'
               WHERE gender = '${gender}' AND side = 'bat' AND year <= ${asOf} AND balls > 0 AND mean_position IS NOT NULL GROUP BY ALL),
    k AS (SELECT *, row_number() OVER (PARTITION BY player_id, format ORDER BY year DESC) AS k FROM c),
    agg AS (SELECT player_id, format, sum(inns) FILTER (WHERE k <= ${RECENT_SEASONS}) AS ri, sum(pb) FILTER (WHERE k <= ${RECENT_SEASONS}) AS rpb,
                   sum(balls) FILTER (WHERE k <= ${RECENT_SEASONS}) AS rb, sum(pb) AS cpb, sum(balls) AS cb FROM k GROUP BY ALL)
    SELECT player_id, format, CASE WHEN ri >= 4 THEN rpb / rb ELSE cpb / cb END AS pos FROM agg`);
}

/** Career rates relative to the competition-season average (1 = average), per player, long format and side (loadRelativeRates) */
export interface RelativeRates { runs: number; outs: number }

/**
 * Career rates in List A / first-class cricket relative to the average of the competition-seasons he played in: runs and
 * dismissals per ball (batting), runs and wickets per ball (bowling). Free of conditions and era (a Ranji Trophy seamer's
 * economy is measured against Ranji scoring, a Test bowler's against Tests); the level of the competition is the CA rating's job.
 */
export function loadRelativeRates(gender: Gender): Record<"ListA" | "FC", Map<number, Partial<Record<Side, RelativeRates & { balls: number }>>>> {
  const rows = duck<{ player_id: number; format: "ListA" | "FC"; side: Side; balls: number; runs: number; outs: number; xruns: number; xouts: number }>(`
    SELECT c.player_id, c.format, c.side, sum(c.balls) AS balls, sum(c.runs) AS runs, sum(c.outs) AS outs,
           sum(c.balls * b.rpb) AS xruns, sum(c.balls * b.opb) AS xouts
    FROM '${CELLS_FILE}' c JOIN '${DIR}ca_comp_seasons.parquet' b USING (side, format, gender, year, comp)
    WHERE c.gender = '${gender}' AND c.format IN ('ListA', 'FC') AND c.balls > 0 GROUP BY ALL`);
  const out = { ListA: new Map(), FC: new Map() } as ReturnType<typeof loadRelativeRates>;
  for (const r of rows) {
    const m = out[r.format];
    const e = m.get(Number(r.player_id)) ?? {};
    e[r.side] = { balls: r.balls, runs: r.xruns > 0 ? r.runs / r.xruns : 1, outs: r.xouts > 0 ? r.outs / r.xouts : 1 };
    m.set(Number(r.player_id), e);
  }
  return out;
}

/** Pseudo-balls of the T20 average added to a player's T20 rates before they are turned into style z-scores */
const STYLE_PRIOR_BALLS = 120;
const STYLE_MIN_BALLS = 60;
const STYLE_REGULAR_BALLS = 500;

/** T20 style z-scores per player and side from the CA cells up to asOf (see T20Style) */
function loadT20Style(gender: Gender, asOf: number): { player_id: number; side: Side; z1: number; z2: number }[] {
  const n0 = STYLE_PRIOR_BALLS;
  return duck(`
    WITH c AS (SELECT player_id, side, sum(balls) AS balls, sum(runs) AS runs, sum(outs) AS outs FROM '${CELLS_FILE}'
               WHERE gender = '${gender}' AND format = 'T20' AND year <= ${asOf} GROUP BY ALL),
    pop AS (SELECT side, sum(runs) / sum(balls) AS rpb, sum(outs) / sum(balls) AS opb FROM c GROUP BY ALL),
    f AS (SELECT c.player_id, c.side, c.balls,
                 CASE WHEN c.side = 'bat' THEN 100 * (c.runs + ${n0} * p.rpb) / (c.balls + ${n0}) ELSE (c.runs + ${n0} * p.rpb) / (c.balls + ${n0}) END AS s1,
                 CASE WHEN c.side = 'bat' THEN ln((c.balls + ${n0}) / (c.outs + ${n0} * p.opb)) ELSE (c.outs + ${n0} * p.opb) / (c.balls + ${n0}) END AS s2
          FROM c JOIN pop p USING (side)),
    m AS (SELECT side, avg(s1) AS m1, stddev_pop(s1) AS d1, avg(s2) AS m2, stddev_pop(s2) AS d2 FROM f WHERE balls >= ${STYLE_REGULAR_BALLS} GROUP BY ALL)
    SELECT f.player_id, f.side, (s1 - m1) / d1 AS z1, (s2 - m2) / d2 AS z2 FROM f JOIN m USING (side) WHERE f.balls >= ${STYLE_MIN_BALLS}`);
}

// ── role in a format ──────────────────────────────────────────────────

const PART_TIME_BALLS = 6;

/**
 * A player's role in a long format, from what he does in it: front-line if he bowls six overs an innings in the field
 * (Tests: the Test profile's workload, test-profile-data.ts, else his first-class record; ODIs: his List A record, recent
 * seasons first), a batter if he bats in the top seven. Front-line and top seven: all-rounder; front-line only: bowler;
 * otherwise batsman (keepers too). A player with no record in the format keeps his T20 role.
 */
export function formatRole(
  p: { id: string; role: PlayerRole; isWicketKeeper?: boolean }, format: "odi" | "test", rec: Partial<Record<Side, SideRating>> | undefined,
): PlayerRole {
  const profile = format === "test" ? testProfileOf({ id: p.id, sourceId: p.id }) : undefined;
  const workload = profile?.bowl !== undefined
    ? [0, PART_TIME_BALLS, FRONT_LINE_BALLS][profile.bowl]
    : rec?.bowl ? bowlingWorkload(rec.bowl) : rec?.bat ? 0 : undefined;
  const pos = profile?.pos ?? rec?.bat?.meanPos;
  if (workload === undefined && pos === undefined) return p.role;
  if (p.isWicketKeeper) return "batsman";
  const front = (workload ?? 0) >= FRONT_LINE_BALLS;
  const bats = pos !== undefined ? pos <= TOP_ORDER_POS : p.role !== "bowler";
  return front ? (bats ? "all-rounder" : "bowler") : "batsman";
}

// ── translations between formats ──────────────────────────────────────

export interface Translation {
  a: number; b: number; residVar: number; n: number;
  /** Coefficients on the T20 style z-scores (translations from T20 only) */
  c?: [number, number];
}
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

/** Weighted least squares of y on [1, ...xs] (normal equations); undefined if singular */
export function fitWls(rows: { xs: number[]; y: number; w: number }[]): { coef: number[]; residVar: number } | undefined {
  const k = (rows[0]?.xs.length ?? 0) + 1;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (const r of rows) {
    const x = [1, ...r.xs];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += r.w * x[i] * x[j];
      A[i][k] += r.w * x[i] * r.y;
    }
  }
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let i = col + 1; i < k; i++) if (Math.abs(A[i][col]) > Math.abs(A[piv][col])) piv = i;
    if (Math.abs(A[piv][col]) < 1e-12) return undefined;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let i = 0; i < k; i++) {
      if (i === col) continue;
      const f = A[i][col] / A[col][col];
      for (let j = col; j <= k; j++) A[i][j] -= f * A[col][j];
    }
  }
  const coef = A.map((row, i) => row[k] / row[i]);
  const sw = rows.reduce((t, r) => t + r.w, 0);
  const residVar = rows.reduce((t, r) => t + r.w * (r.y - coef[0] - r.xs.reduce((u, x, i) => u + coef[i + 1] * x, 0)) ** 2, 0) / sw;
  return { coef, residVar };
}

/** A side counts as one the player does in a format: rated, enough balls, and enough of them a match */
export function doesSide(r: SideRating | undefined, minBalls = MIN_EVIDENCE_BALLS): r is SideRating {
  return !!r && r.balls >= minBalls && (r.matches > 0 ? r.balls / r.matches : 0) >= MIN_BALLS_PER_MATCH;
}

/**
 * Does the side in the format now: doesSide over the career and the same 6 balls a match over his last RECENT_SEASONS
 * seasons of it (a batter who bowled leg-spin a decade ago and no longer does is not a bowler). Without the recent figure
 * (lower-level records), the career rule alone.
 */
export function doesSideNow(r: SideRating | undefined): r is SideRating {
  return doesSide(r) && (r.recentPerMatch === undefined || r.recentPerMatch >= MIN_BALLS_PER_MATCH);
}

/** Translations from every format to every other, per side, over players rated in both */
export function fitTranslations(players: Iterable<CaPlayerFormats>, gender: Gender): Translations {
  const minBalls = TRANSLATE_MIN_BALLS[gender];
  const out: Translations = {};
  const list = [...players];
  for (const side of SIDES) {
    for (const to of CA_FORMATS) {
      for (const from of CA_FORMATS) {
        if (from === to) continue;
        const pairs: { x: number; y: number; w: number; s?: [number, number] }[] = [];
        for (const p of list) {
          const x = p[from]?.[side], y = p[to]?.[side];
          if (!doesSide(x, minBalls[from]) || !doesSide(y, minBalls[to])) continue;
          if (Math.abs(x.year - y.year) > TRANSLATE_MAX_GAP) continue;
          pairs.push({ x: x.rating, y: y.rating, w: (2 * x.balls * y.balls) / (x.balls + y.balls), s: p.style?.[side] });
        }
        let t = fitLine(pairs);
        // From T20: add the player's T20 style (fitted on players who have it; a missing style counts as average)
        const styled = pairs.filter(q => q.s);
        if (from === "T20" && STYLE_SIDES.includes(side) && styled.length >= 100) {
          const fit = fitWls(styled.map(q => ({ xs: [q.x, q.s![0], q.s![1]], y: q.y, w: q.w })));
          if (fit) t = { a: fit.coef[0], b: fit.coef[1], c: [fit.coef[2], fit.coef[3]], residVar: fit.residVar, n: styled.length };
        }
        out[`${side}/${from}>${to}`] = t;
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
  /** Career balls in the target format for the side to count as "data" (DATA_BALLS) */
  dataBalls: number;
}

/**
 * A rating's sd is widened for at most this many seasons without the format (held-out correlation: unlimited 0.621,
 * 2 seasons 0.624, none 0.618 for Test batting; the other sides are within 0.001): an old but long record keeps
 * some weight against the translated prior
 */
const MAX_STALE_SEASONS = 2;

function lastRated(p: CaPlayerFormats): number | undefined {
  let last = 0;
  for (const f of CA_FORMATS) for (const s of SIDES) last = Math.max(last, p[f]?.[s]?.year ?? 0);
  return last > 0 ? last : undefined;
}

/**
 * The season a player's ratings are as of: his last season of senior cricket in any format (up to asOf). A retired
 * player is rated as he was when he stopped, like the T20 extended pool rates him, and staleness counts from there;
 * veterans' and legends' matches (lower-level cards) don't make him current again.
 */
export function lastSeason(p: CaPlayerFormats, asOf: number): number {
  const last = p.last ?? lastRated(p);
  return last ? Math.min(asOf, last) : asOf;
}

/** Variance of a rating, widened for the seasons since it was last updated (the CA model's half-life) */
function staleVar(r: SideRating, fmt: CaFormat, side: Side, ctx: EstimateContext, last: number): number {
  const gap = Math.min(MAX_STALE_SEASONS, Math.max(0, last - r.year));
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
    const v = t.b ** 2 * staleVar(r, from, side, ctx, lastSeason(p, ctx.asOf)) + t.residVar;
    const st = t.c && p.style?.[side];
    const cand = { mean: t.a + t.b * r.rating + (st ? t.c![0] * st[0] + t.c![1] * st[1] : 0), var: v, from };
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
    const last = lastSeason(p, ctx.asOf);
    const vD = staleVar(data, target, side, ctx, last) * ctx.dataVar;
    const source = data.balls >= ctx.dataBalls && last - data.year <= DATA_MAX_AGE ? "data" : "derived";
    if (!prior || !Number.isFinite(prior.var)) return { mean: data.rating, sd: Math.sqrt(vD), dataWeight: 1, source, balls };
    const wD = 1 / Math.max(1e-6, vD), wP = 1 / prior.var;
    const mean = (data.rating * wD + prior.mean * wP) / (wD + wP);
    return { mean, sd: Math.sqrt(1 / (wD + wP)), dataWeight: wD / (wD + wP), source, from: prior.from, balls };
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
    asOf, dataVar, dataBalls: DATA_BALLS[gender][target],
    translations: translations ?? fitTranslations(players.values(), gender),
    params: caParams(gender),
    prior: regularsPrior(players.values(), target, gender, asOf),
  };
}

// ── score -> game overall ─────────────────────────────────────────────

/** Value at quantile q (0..1) of a sorted list */
export const quantile = (sorted: number[], q: number): number => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))))];
/** Where x falls in a sorted list, 0..1 (mid-rank for ties, halfway between neighbours otherwise) */
export function percentile(sorted: number[], x: number): number {
  if (sorted.length < 2) return 0.5;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  let end = lo;
  while (end < sorted.length && sorted[end] === x) end++;
  const rank = end > lo ? (lo + end - 1) / 2 : lo - 0.5;
  return Math.max(0, Math.min(1, rank / (sorted.length - 1)));
}

/** Monotone score -> overall curve, linear between points and flat beyond the ends */
export function readCurve(curve: { x: number; y: number }[], x: number): number {
  if (curve.length === 0) return 50;
  if (x <= curve[0].x) return curve[0].y;
  if (x >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
  let lo = 0, hi = curve.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (curve[mid].x <= x) lo = mid; else hi = mid; }
  const t = (x - curve[lo].x) / Math.max(1e-9, curve[hi].x - curve[lo].x);
  return curve[lo].y + t * (curve[hi].y - curve[lo].y);
}

/**
 * Equipercentile link: the i-th lowest score of `players` gets the i-th lowest of `values` at the same quantile.
 * Ties in score are averaged so the curve is a function.
 */
export function linkCurve(scores: number[], values: number[]): { x: number; y: number }[] {
  const xs = [...scores].sort((a, b) => a - b), ys = [...values].sort((a, b) => a - b);
  const pts = xs.map((x, i) => ({ x, y: quantile(ys, xs.length > 1 ? i / (xs.length - 1) : 0.5) }));
  const out: { x: number; y: number }[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9) { last.y = (last.y + p.y) / 2; continue; }
    out.push({ ...p });
  }
  return out;
}
