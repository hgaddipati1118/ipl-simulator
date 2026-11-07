/**
 * Standalone progression simulator: project a player's ratings forward many times and summarise the spread
 * (median and bands per season), with retirement. Built on Player.progress(), so it is exactly what a career
 * mode player goes through. Seeded and deterministic.
 */

import { Player, type PlayerData } from "./player.js";
import { createRNG, type RNG } from "./rng.js";
import { retirementProbability, retirementRole, type ProgressionGender } from "./progression.js";

export interface Band {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  mean: number;
}

export interface ProjectionPoint {
  /** Seasons ahead (1 = next season) */
  season: number;
  /** Age during that season */
  age: number;
  /** Share of the simulated careers still going (not retired) */
  active: number;
  /** Bands over the careers still going */
  batting: Band;
  bowling: Band;
  overall: Band;
  /** Only for players who have the rating (bands over the careers still going) */
  fielding?: Band;
  keeping?: Band;
}

export interface ProjectionOptions {
  seasons?: number;
  runs?: number;
  seed?: number;
  gender?: ProgressionGender;
  /** Retire players with the fitted hazard (default true); when false every run continues */
  retirement?: boolean;
}

export function quantileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function bandOf(values: number[]): Band {
  const v = [...values].sort((a, b) => a - b);
  const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  return {
    p10: quantileOf(v, 0.1), p25: quantileOf(v, 0.25), p50: quantileOf(v, 0.5),
    p75: quantileOf(v, 0.75), p90: quantileOf(v, 0.9), mean,
  };
}

/** Chance this player retires after the season just played (age is his age during it) */
export function playerRetirementProbability(p: Player, gender: ProgressionGender = "male", ageDuringSeason = p.age): number {
  return retirementProbability({
    age: ageDuringSeason, overall: p.overall, gender,
    role: retirementRole(p.bowlingStyle, p.role),
  });
}

export interface CareerSeason {
  age: number;
  batting: number;
  bowling: number;
  overall: number;
  fielding?: number;
  keeping?: number;
  /** False from the season after he retires (ratings then stay frozen) */
  active: boolean;
}

/** Run one career forward; returns each season's ratings and whether he is still playing */
export function simulateCareer(
  data: PlayerData, seasons: number, rng: RNG, opts: { gender?: ProgressionGender; retirement?: boolean } = {},
): CareerSeason[] {
  const gender = opts.gender ?? "male";
  const p = new Player({ ...data, ratingHistory: data.ratingHistory ? [...data.ratingHistory] : [] });
  const out: CareerSeason[] = [];
  let active = true;
  for (let k = 1; k <= seasons; k++) {
    if (active && opts.retirement !== false && rng() < playerRetirementProbability(p, gender)) active = false;
    if (active) p.progress({ rng, gender });
    out.push({
      age: p.age, batting: p.battingOvr, bowling: p.bowlingOvr, overall: p.overall, active,
      ...(typeof p.ratings.fielding === "number" ? { fielding: p.ratings.fielding } : {}),
      ...(typeof p.ratings.keeping === "number" ? { keeping: p.ratings.keeping } : {}),
    });
  }
  return out;
}

/** Median-and-band projection of a player's next seasons */
export function projectPlayer(data: PlayerData, opts: ProjectionOptions = {}): ProjectionPoint[] {
  const seasons = opts.seasons ?? 8;
  const runs = opts.runs ?? 400;
  const base = opts.seed ?? 1;
  const careers: CareerSeason[][] = [];
  for (let r = 0; r < runs; r++) {
    careers.push(simulateCareer(data, seasons, createRNG((base * 1000003 + r * 7919) >>> 0), opts));
  }
  const points: ProjectionPoint[] = [];
  for (let k = 0; k < seasons; k++) {
    const live = careers.map(c => c[k]).filter(c => c.active);
    points.push({
      season: k + 1,
      age: data.age + k + 1,
      active: live.length / runs,
      batting: bandOf(live.map(c => c.batting)),
      bowling: bandOf(live.map(c => c.bowling)),
      overall: bandOf(live.map(c => c.overall)),
      ...(typeof data.ratings.fielding === "number" ? { fielding: bandOf(live.map(c => c.fielding ?? data.ratings.fielding!)) } : {}),
      // keeping is only projected for a designated keeper (for anyone else no match ever uses it)
      ...(typeof data.ratings.keeping === "number" && data.isWicketKeeper ? { keeping: bandOf(live.map(c => c.keeping ?? data.ratings.keeping!)) } : {}),
    });
  }
  return points;
}
