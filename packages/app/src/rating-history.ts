/**
 * Data behind the "ratings over time" view of a player: the real T20 history of game players (from the
 * CricketArchive per-year ratings, exported by packages/ratings/src/analysis/export-rating-history.py), the
 * career-mode history kept by Player.progress(), and the simulated projection from the engine.
 */

import { calculateOverallRating, projectPlayer, type Player, type ProjectionPoint, type RatingHistoryEntry } from "@ipl-sim/engine";

export type RatingSeries = "overall" | "batting" | "bowling";

/** The compact file served at /data/rating-history.json */
export interface RatingHistoryData {
  v: number;
  /** game player id -> CricketArchive id */
  ids: Record<string, number>;
  /** CricketArchive ids of women */
  f?: number[];
  /** CricketArchive id -> [firstYear, bat, bowl, bat, bowl, ...], -1 where there is no rating */
  p: Record<string, number[]>;
}

export interface RealSeason {
  year: number;
  bat: number | null;
  bowl: number | null;
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
  const arr = ca === null ? undefined : data.p[String(ca)];
  if (!arr) return [];
  const out: RealSeason[] = [];
  for (let i = 1; i + 1 < arr.length; i += 2) {
    out.push({ year: arr[0] + (i - 1) / 2, bat: arr[i] >= 0 ? arr[i] : null, bowl: arr[i + 1] >= 0 ? arr[i + 1] : null });
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
  current: { overall: number; batting: number; bowling: number };
  real: RealSeason[];
  projection: ProjectionPoint[];
}

function pick(entry: { overall: number; batting: number; bowling: number }, series: RatingSeries): number {
  return series === "overall" ? entry.overall : series === "batting" ? entry.batting : entry.bowling;
}

function realValue(s: RealSeason, series: RatingSeries): number | null {
  if (series === "batting") return s.bat;
  if (series === "bowling") return s.bowl;
  if (s.bat === null && s.bowl === null) return null;
  return calculateOverallRating(s.bat ?? 0, s.bowl ?? 0);
}

/** Assemble the three parts of the chart on one age axis */
export function buildChartModel(input: ChartInput): ChartModel {
  const { series, age, seasonNumber, ratingHistory, current, real, projection } = input;
  // The game's first season is played at this age; real seasons before it are placed by calendar year
  const startAge = ratingHistory.length > 0 && ratingHistory[0].age !== undefined ? ratingHistory[0].age : age - (seasonNumber - 1);

  const career: ChartPoint[] = ratingHistory.map((h, i) => ({ age: h.age ?? startAge + i, value: pick(h, series) }));
  career.push({ age, value: pick(current, series) });

  const startValue = career[0].value;
  const realPts: ChartPoint[] = [];
  for (const s of real) {
    if (s.year >= GAME_START_YEAR) continue;
    const v = realValue(s, series);
    if (v === null) continue;
    realPts.push({ age: startAge - (GAME_START_YEAR - s.year), value: v });
  }
  // Anchor: the latest real season is shown relative to the game's own rating (the game's pipeline differs a little
  // from the raw per-year ratings), so the line runs into the career without a jump
  const lastReal = realPts[realPts.length - 1];
  const shift = lastReal ? Math.round(startValue - lastReal.value) : 0;
  const shifted = realPts.map(p => ({ age: p.age, value: Math.max(0, Math.min(99, p.value + shift)) }));

  const bandOf = (p: ProjectionPoint) => (series === "overall" ? p.overall : series === "batting" ? p.batting : p.bowling);
  const now = pick(current, series);
  const band: ProjectionBandPoint[] = [{ age, p10: now, p25: now, p50: now, p75: now, p90: now, active: 1 }];
  for (const p of projection) {
    if (p.active === 0) break;
    const b = bandOf(p);
    band.push({ age: p.age, p10: b.p10, p25: b.p25, p50: b.p50, p75: b.p75, p90: b.p90, active: p.active });
  }

  const xs = [...shifted.map(p => p.age), ...career.map(p => p.age), ...band.map(p => p.age)];
  const ys = [...shifted.map(p => p.value), ...career.map(p => p.value), ...band.flatMap(p => [p.p10, p.p90])];
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return {
    series, real: shifted, career, projection: band, shift,
    xMin: Math.min(...xs), xMax: Math.max(...xs),
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
