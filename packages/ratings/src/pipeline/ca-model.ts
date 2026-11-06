/**
 * CricketArchive per-year ratings (src/analysis/ca-ratings.py) as a second source for the game.
 *
 * For each ESPN player (matched through data/analysis/ca_espn_map.csv: Cricsheet's register, else same DOB +
 * compatible name) this gives a batting and a bowling score on the CA T20 scale (runs per 100 balls above the
 * competition-season average, competition/opponent-adjusted), with its uncertainty and career T20 balls.
 * A side with too little T20 evidence falls back to List A, then (batting only) first-class, translated to the T20 scale by a
 * regression over players rated in both formats (the regression's residual variance is added to the
 * uncertainty, so a translated score is trusted less than a real T20 one).
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";

const DIR = new URL("../../data/analysis/", import.meta.url).pathname;
const CA_FILE = `${DIR}ca_ratings_by_year.parquet`;
const CELLS_FILE = `${DIR}ca_cells.parquet`;
const MAP_FILE = `${DIR}ca_espn_map.csv`;
const VALIDATION_FILE = `${DIR}ca_validation.json`;

type Format = "T20" | "ListA" | "FC";
const FALLBACKS: Format[] = ["ListA", "FC"];

/** Evidence needed before a format's rating is used for a side */
const MIN_BALLS: Record<Format, number> = { T20: 240, ListA: 480, FC: 1200 };
/**
 * Only use a discipline the player actually does: balls per match (matches ~ the larger of innings batted and
 * innings bowled in that format), the same 6-ball rule the Cricsheet model uses. Per innings bowled would let
 * a part-timer who bowls rarely (but an over or two when he does) pass as a bowler.
 */
const MIN_BALLS_PER_MATCH = 6;
/** Players rated in both formats with at least this much evidence define the translation */
const TRANSLATE_MIN_T20 = 500;
const TRANSLATE_MIN_OTHER = 1000;

export interface CaSide {
  /** CA T20-scale score (translated if `source` isn't T20) */
  score: number;
  sd: number;
  source: Format;
  /** Career balls in the format used */
  balls: number;
}

export interface CaPlayer {
  caId: number;
  bat?: CaSide;
  bowl?: CaSide;
  /** Career T20 balls, for overlap with Cricsheet and the small-sample cap */
  t20BatBalls: number;
  t20BowlBalls: number;
}

interface Row {
  player_id: number; format: Format;
  bat_rating: number | null; bat_sd: number | null; bowl_rating: number | null; bowl_sd: number | null;
  bat_balls: number | null; bat_inns: number | null; bowl_balls: number | null; bowl_inns: number | null;
}

export function caAvailable(): boolean {
  return existsSync(CA_FILE) && existsSync(CELLS_FILE) && existsSync(MAP_FILE);
}

/** Shrinkage K (balls) the CA model tuned per side for T20, for the small-sample cap threshold */
export function caTunedK(gender: "male" | "female"): { bat: number; bowl: number } {
  const fallback = { bat: 400, bowl: 1600 };
  if (!existsSync(VALIDATION_FILE)) return fallback;
  // Older files may hold NaN (not valid JSON) for tiny groups
  const v = JSON.parse(readFileSync(VALIDATION_FILE, "utf-8").replace(/\bNaN\b/g, "null"));
  return {
    bat: v[`bat/T20/${gender}`]?.params?.K ?? fallback.bat,
    bowl: v[`bowl/T20/${gender}`]?.params?.K ?? fallback.bowl,
  };
}

function query(gender: "male" | "female"): Row[] {
  const sql = `
    WITH last AS (
      SELECT player_id, format,
             arg_max(bat_rating, year) FILTER (WHERE bat_rating IS NOT NULL) AS bat_rating,
             arg_max(bat_sd, year) FILTER (WHERE bat_rating IS NOT NULL) AS bat_sd,
             arg_max(bowl_rating, year) FILTER (WHERE bowl_rating IS NOT NULL) AS bowl_rating,
             arg_max(bowl_sd, year) FILTER (WHERE bowl_rating IS NOT NULL) AS bowl_sd
      FROM '${CA_FILE}' WHERE gender = '${gender}' GROUP BY ALL),
    car AS (SELECT player_id, format, side, sum(balls) AS balls, sum(inns) AS inns FROM '${CELLS_FILE}' WHERE gender = '${gender}' GROUP BY ALL)
    SELECT l.*, b.balls AS bat_balls, b.inns AS bat_inns, w.balls AS bowl_balls, w.inns AS bowl_inns
    FROM last l
    LEFT JOIN car b ON b.player_id = l.player_id AND b.format = l.format AND b.side = 'bat'
    LEFT JOIN car w ON w.player_id = l.player_id AND w.format = l.format AND w.side = 'bowl'`;
  return JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 }) || "[]") as Row[];
}

interface Translation { a: number; b: number; residVar: number; n: number }

/** Weighted least squares of T20 score on the other format's score, over players rated in both */
function fitTranslation(pairs: { x: number; y: number; w: number }[]): Translation {
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

export interface CaLoadReport { players: number; translations: Record<string, Translation> }

/** CA scores for one gender, keyed by ESPN (Cricinfo) id */
export function loadCa(gender: "male" | "female"): { byEspn: Map<number, CaPlayer>; report: CaLoadReport } {
  const espnByCa = new Map<number, number[]>();
  for (const line of readFileSync(MAP_FILE, "utf-8").split("\n").slice(1)) {
    const [espn, ca] = line.split(",");
    if (!espn || !ca) continue;
    const list = espnByCa.get(Number(ca)) ?? [];
    list.push(Number(espn));
    espnByCa.set(Number(ca), list);
  }
  const byPlayer = new Map<number, Partial<Record<Format, Row>>>();
  for (const r of query(gender)) {
    const id = Number(r.player_id);
    const entry = byPlayer.get(id) ?? {};
    entry[r.format] = r;
    byPlayer.set(id, entry);
  }

  const usable = (r: Row | undefined, side: "bat" | "bowl", fmt: Format): boolean => {
    if (!r) return false;
    const rating = side === "bat" ? r.bat_rating : r.bowl_rating;
    const balls = (side === "bat" ? r.bat_balls : r.bowl_balls) ?? 0;
    const matches = Math.max(r.bat_inns ?? 0, r.bowl_inns ?? 0);
    const perMatch = matches > 0 ? balls / matches : 0;
    return rating !== null && balls >= MIN_BALLS[fmt] && perMatch >= MIN_BALLS_PER_MATCH;
  };

  const translations: Record<string, Translation> = {};
  for (const side of ["bat", "bowl"] as const) {
    for (const fmt of FALLBACKS) {
      const pairs: { x: number; y: number; w: number }[] = [];
      for (const formats of byPlayer.values()) {
        const t = formats.T20, o = formats[fmt];
        if (!t || !o) continue;
        const tb = (side === "bat" ? t.bat_balls : t.bowl_balls) ?? 0;
        const ob = (side === "bat" ? o.bat_balls : o.bowl_balls) ?? 0;
        const ty = side === "bat" ? t.bat_rating : t.bowl_rating;
        const ox = side === "bat" ? o.bat_rating : o.bowl_rating;
        if (tb >= TRANSLATE_MIN_T20 && ob >= TRANSLATE_MIN_OTHER && ty !== null && ox !== null) {
          pairs.push({ x: ox, y: ty, w: (2 * tb * ob) / (tb + ob) });
        }
      }
      translations[`${side}/${fmt}`] = fitTranslation(pairs);
    }
  }

  const byEspn = new Map<number, CaPlayer>();
  for (const [caId, formats] of byPlayer) {
    const espnIds = espnByCa.get(caId);
    if (!espnIds) continue;
    const player: CaPlayer = {
      caId,
      t20BatBalls: formats.T20?.bat_balls ?? 0,
      t20BowlBalls: formats.T20?.bowl_balls ?? 0,
    };
    for (const side of ["bat", "bowl"] as const) {
      const pick = (fmt: Format): CaSide | undefined => {
        const r = formats[fmt];
        if (!usable(r, side, fmt)) return undefined;
        const raw = side === "bat" ? r!.bat_rating! : r!.bowl_rating!;
        const sd = (side === "bat" ? r!.bat_sd : r!.bowl_sd) ?? 10;
        const balls = (side === "bat" ? r!.bat_balls : r!.bowl_balls) ?? 0;
        if (fmt === "T20") return { score: raw, sd, source: fmt, balls };
        const t = translations[`${side}/${fmt}`];
        return { score: t.a + t.b * raw, sd: Math.sqrt((t.b * sd) ** 2 + t.residVar), source: fmt, balls };
      };
      // First-class bowling (long spells, wicket-taking) is too weak a guide to T20 bowling: batting only
      const chosen = pick("T20") ?? pick("ListA") ?? (side === "bat" ? pick("FC") : undefined);
      if (chosen) player[side] = chosen;
    }
    if (!player.bat && !player.bowl) continue;
    for (const espnId of espnIds) byEspn.set(espnId, player);
  }
  return { byEspn, report: { players: byEspn.size, translations } };
}
