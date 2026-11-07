/**
 * Data behind the "ratings over time" view of a player: the real T20 history of game players (from the
 * CricketArchive per-year ratings, exported by packages/ratings/src/analysis/export-rating-history.py), the
 * career-mode history kept by Player.progress(), and the simulated projection from the engine.
 */

import { calculateOverallRating, projectPlayer, type Player, type ProjectionPoint, type RatingHistoryEntry } from "@ipl-sim/engine";

export type RatingSeries = "overall" | "batting" | "bowling" | "fielding" | "keeping";

/** The compact file served at /data/rating-history.json */
export interface RatingHistoryData {
  v: number;
  /** game player id -> CricketArchive id */
  ids: Record<string, number>;
  /** CricketArchive ids of women */
  f?: number[];
  /** CricketArchive id -> [firstYear, bat, bowl, bat, bowl, ...], -1 where there is no rating */
  p: Record<string, number[]>;
  /** Version 2: CricketArchive id -> [firstYear, fielding, fielding, ...], one single-season (shrunk) rating a year, -1 = none */
  q?: Record<string, number[]>;
  /** Version 2: the same for keeping, wicketkeepers only */
  k?: Record<string, number[]>;
}

export interface RealSeason {
  year: number;
  bat: number | null;
  bowl: number | null;
  /** Single-season fielding / keeping (history file version 2); absent in old files */
  field?: number | null;
  keep?: number | null;
}

/** The year the game's first season starts from (ratings are as of the 2026 data) */
export const GAME_START_YEAR = 2026;

let cached: Promise<RatingHistoryData | null> | null = null;

/** Fetch the history file once (null if it is not available) */
export function loadRatingHistory(): Promise<RatingHistoryData | null> {
  if (!cached) {
    const base = (typeof import.meta !== "undefined" && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || "/";
    cached = fetch(`${base}data/rating-history.json`)
      .then(r => (r.ok ? (r.json() as Promise<RatingHistoryData>) : null))
      .catch(() => null);
  }
  return cached;
}

function caIdOf(data: RatingHistoryData, playerId: string): number | null {
  if (data.ids[playerId] !== undefined) return data.ids[playerId];
  const m = /^ca_(\d+)$/.exec(playerId);
  return m ? Number(m[1]) : null;
}

export function isWomanInHistory(data: RatingHistoryData | null, playerId: string): boolean | null {
  if (!data) return null;
  const ca = caIdOf(data, playerId);
  if (ca === null || !data.p[String(ca)]) return null;
  return (data.f ?? []).includes(ca);
}

/** A player's real seasons, oldest first (empty when we have no record of him) */
export function realSeasonsFor(data: RatingHistoryData | null, playerId: string): RealSeason[] {
  if (!data) return [];
  const ca = caIdOf(data, playerId);
  if (ca === null) return [];
  const arr = data.p[String(ca)];
  const fArr = data.q?.[String(ca)];
  const kArr = data.k?.[String(ca)];
  if (!arr && !fArr && !kArr) return [];
  const at = (a: number[] | undefined, y: number, stride: number, off: number): number | null => {
    if (!a) return null;
    const i = 1 + (y - a[0]) * stride + off;
    if (y < a[0] || i >= a.length) return null;
    return a[i] >= 0 ? a[i] : null;
  };
  const firsts = [arr, fArr, kArr].filter((a): a is number[] => !!a).map(a => a[0]);
  const lasts = [arr && arr[0] + (arr.length - 1) / 2 - 1, fArr && fArr[0] + fArr.length - 2, kArr && kArr[0] + kArr.length - 2]
    .filter((y): y is number => typeof y === "number");
  const out: RealSeason[] = [];
  for (let y = Math.min(...firsts); y <= Math.max(...lasts); y++) {
    const season: RealSeason = { year: y, bat: at(arr, y, 2, 0), bowl: at(arr, y, 2, 1) };
    if (fArr) season.field = at(fArr, y, 1, 0);
    if (kArr) season.keep = at(kArr, y, 1, 0);
    out.push(season);
  }
  return out;
}

export interface ChartPoint {
  age: number;
  value: number;
}

export interface ProjectionBandPoint {
  age: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Share of simulated careers still going at this age */
  active: number;
}

export interface ChartModel {
  series: RatingSeries;
  /** Real seasons before the game started, shifted to meet the game's rating (see `shift`) */
  real: ChartPoint[];
  /** The career so far in the game: one point per completed season plus now */
  career: ChartPoint[];
  /** Simulated future from now on, starting at the current rating */
  projection: ProjectionBandPoint[];
  /** Points added to the real history so it meets the game's rating at the start of the career */
  shift: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface ChartInput {
  series: RatingSeries;
  age: number;
  seasonNumber: number;
  ratingHistory: readonly RatingHistoryEntry[];
  /** Current ratings in the game */
  current: { overall: number; batting: number; bowling: number; fielding?: number; keeping?: number };
  real: RealSeason[];
  projection: ProjectionPoint[];
}

type Entry = { overall: number; batting: number; bowling: number; fielding?: number; keeping?: number };

function pick(entry: Entry, series: RatingSeries): number | undefined {
  return series === "overall" ? entry.overall : series === "batting" ? entry.batting : series === "bowling" ? entry.bowling
    : series === "fielding" ? entry.fielding : entry.keeping;
}

function realValue(s: RealSeason, series: RatingSeries): number | null {
  if (series === "batting") return s.bat;
  if (series === "bowling") return s.bowl;
  if (series === "fielding") return s.field ?? null;
  if (series === "keeping") return s.keep ?? null;
  if (s.bat === null && s.bowl === null) return null;
  return calculateOverallRating(s.bat ?? 0, s.bowl ?? 0);
}

/** Fielding and keeping seasons are single-season values, shrunk toward 50 but noisy: they are not anchored to the game's rating */
export function isNoisySeries(series: RatingSeries): boolean {
  return series === "fielding" || series === "keeping";
}

/** Which series the chart offers: fielding when the player has the rating or a record of it, keeping only for wicketkeepers */
export function availableSeries(
  player: Pick<Player, "isWicketKeeper"> & { ratings: { fielding?: number; keeping?: number } },
  real: readonly RealSeason[],
): RatingSeries[] {
  const out: RatingSeries[] = ["overall", "batting", "bowling"];
  if (typeof player.ratings.fielding === "number" || real.some(s => s.field !== undefined && s.field !== null)) out.push("fielding");
  if (player.isWicketKeeper && (typeof player.ratings.keeping === "number" || real.some(s => s.keep !== undefined && s.keep !== null))) out.push("keeping");
  return out;
}

/** Assemble the three parts of the chart on one age axis */
export function buildChartModel(input: ChartInput): ChartModel {
  const { series, age, seasonNumber, ratingHistory, current, real, projection } = input;
  // The game's first season is played at this age; real seasons before it are placed by calendar year
  const startAge = ratingHistory.length > 0 && ratingHistory[0].age !== undefined ? ratingHistory[0].age : age - (seasonNumber - 1);

  // Seasons recorded before the player had the rating (older saves) have no value for fielding / keeping and are skipped
  const career: ChartPoint[] = [];
  ratingHistory.forEach((h, i) => {
    const v = pick(h, series);
    if (v !== undefined) career.push({ age: h.age ?? startAge + i, value: v });
  });
  const nowValue = pick(current, series);
  if (nowValue !== undefined) career.push({ age, value: nowValue });

  const realPts: ChartPoint[] = [];
  for (const s of real) {
    if (s.year >= GAME_START_YEAR) continue;
    const v = realValue(s, series);
    if (v === null) continue;
    realPts.push({ age: startAge - (GAME_START_YEAR - s.year), value: v });
  }
  // Anchor: the latest real season is shown relative to the game's own rating (the game's pipeline differs a little
  // from the raw per-year ratings), so the line runs into the career without a jump. Not for fielding and keeping:
  // a single season of those is mostly luck, and the career rating is the shrunk multi-season figure, so the line is
  // left where the data put it.
  const lastReal = realPts[realPts.length - 1];
  const shift = lastReal && career.length > 0 && !isNoisySeries(series) ? Math.round(career[0].value - lastReal.value) : 0;
  const shifted = realPts.map(p => ({ age: p.age, value: Math.max(0, Math.min(99, p.value + shift)) }));

  const bandOf = (p: ProjectionPoint) => (series === "overall" ? p.overall : series === "batting" ? p.batting : series === "bowling" ? p.bowling
    : series === "fielding" ? p.fielding : p.keeping);
  const band: ProjectionBandPoint[] = [];
  if (nowValue !== undefined) {
    band.push({ age, p10: nowValue, p25: nowValue, p50: nowValue, p75: nowValue, p90: nowValue, active: 1 });
    for (const p of projection) {
      if (p.active === 0) break;
      const b = bandOf(p);
      if (!b) break;
      band.push({ age: p.age, p10: b.p10, p25: b.p25, p50: b.p50, p75: b.p75, p90: b.p90, active: p.active });
    }
  }

  const xs = [...shifted.map(p => p.age), ...career.map(p => p.age), ...band.map(p => p.age)];
  const ys = [...shifted.map(p => p.value), ...career.map(p => p.value), ...band.flatMap(p => [p.p10, p.p90])];
  const lo = ys.length ? Math.min(...ys) : 40, hi = ys.length ? Math.max(...ys) : 60;
  return {
    series, real: shifted, career, projection: band, shift,
    xMin: xs.length ? Math.min(...xs) : age, xMax: xs.length ? Math.max(...xs) : age + 1,
    yMin: Math.max(0, Math.floor((lo - 3) / 5) * 5), yMax: Math.min(99, Math.ceil((hi + 3) / 5) * 5),
  };
}

/** A stable small seed from a player id, so a player's projection does not jitter between renders */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000003;
}

export interface ProjectionSummary {
  /** Median overall next season and the change from now */
  nextOverall: number;
  nextChange: number;
  trajectory: "Developing" | "Steady growth" | "Peak years" | "Gradual decline" | "Sharp decline";
  /** Ages (inclusive) around the projected peak of the median */
  peakFrom: number;
  peakTo: number;
  /** The simulated seasons themselves */
  points: ProjectionPoint[];
}

export const PROJECTION_SEASONS = 6;
export const PROJECTION_RUNS = 200;

/** Simulate a player's next seasons (deterministic per player and state) and summarise */
export function projectionFor(
  player: Player, seasonNumber: number, gender: "male" | "female", seasons = PROJECTION_SEASONS, runs = PROJECTION_RUNS,
): ProjectionPoint[] {
  return projectPlayer(player, { seasons, runs, seed: seedOf(player.id) + player.age * 31 + seasonNumber, gender });
}

export function summariseProjection(player: Pick<Player, "overall" | "age">, points: ProjectionPoint[]): ProjectionSummary {
  const live = points.filter(p => p.active > 0.2);
  const next = points[0];
  const nextOverall = Math.round(next.overall.p50);
  const nextChange = next.overall.p50 - player.overall;
  const trajectory = nextChange >= 1.5 ? "Developing" : nextChange >= 0.5 ? "Steady growth" : nextChange >= -0.5 ? "Peak years"
    : nextChange >= -1.5 ? "Gradual decline" : "Sharp decline";
  const medians = [{ age: player.age, v: player.overall }, ...live.map(p => ({ age: p.age, v: p.overall.p50 }))];
  const best = Math.max(...medians.map(m => m.v));
  const near = medians.filter(m => m.v >= best - 1);
  return { nextOverall, nextChange, trajectory, peakFrom: near[0].age, peakTo: near[near.length - 1].age, points };
}
