/**
 * Validation of the progression model against what actually happened: take real players' states in a base year
 * (2015 for men, 2018 for women), simulate their careers forward with Player.progress() and the retirement
 * hazard, and compare the distributions with the real later ratings.
 * The cohorts come from packages/ratings/src/analysis/progression.py (fixtures/progression-cohort.json).
 */

import { Player } from "./player.js";
import type { BattingPosition, BowlingStyle, PlayerData, PlayerRole, RatingHistoryEntry } from "./player.js";
import { createRNG } from "./rng.js";
import { retirementProbability, retirementRole, type ProgressionGender } from "./progression.js";

export interface CohortPlayer {
  g: string;
  /** Age during the base year */
  a: number;
  /** Batting and bowling ovr in the base year (null when none) */
  bo: number | null;
  wo: number | null;
  /** T20 balls batted / bowled in the base year */
  bb: number;
  wb: number;
  /** Seasons of rating evidence at the base year */
  n: number;
  bt: string;
  br: string;
  /** [bat, bowl] ovr one and two seasons before the base year */
  p: ([number | null, number | null] | null)[];
  /** Per later season: [bat ovr, bowl ovr, bat balls, bowl balls], null when he has no T20 rows */
  o: ([number | null, number | null, number, number] | null)[];
}

export interface Cohort {
  baseYear: number;
  players: CohortPlayer[];
}

export const REGULAR_BALLS = 120;

export function cohortPlayerData(c: CohortPlayer): PlayerData {
  const batReg = c.bb >= REGULAR_BALLS;
  const bowlReg = c.wb >= REGULAR_BALLS;
  const bo = c.bo ?? 40;
  const wo = c.wo ?? 35;
  const role: PlayerRole = batReg && bowlReg ? "all-rounder" : bowlReg ? "bowler" : "batsman";
  const position: BattingPosition = c.br === "top" ? "top-order" : c.br === "lower" ? "lower-order" : "middle-order";
  const style: BowlingStyle = c.bt === "spin" ? "off-spin" : c.bt === "pace" ? "right-arm-fast-medium" : "unknown";
  const history: RatingHistoryEntry[] = [];
  for (let i = c.p.length - 1; i >= 0; i--) {
    const h = c.p[i];
    if (h && h[0] !== null && h[1] !== null) history.push({ season: -i - 1, overall: 0, batting: h[0], bowling: h[1] });
  }
  return {
    id: "cohort", name: "cohort", age: c.a, country: "India", role, isInternational: false,
    ratings: {
      battingIQ: bo, timing: bo, power: bo, running: bo,
      wicketTaking: wo, economy: wo, accuracy: wo, clutch: role === "batsman" ? bo : wo,
    },
    bowlingStyle: style, battingPosition: position, injured: false, injuryGamesLeft: 0,
    ratingHistory: history, experience: c.n,
  };
}

/** Where a player is by season k after the base year: his ratings, or null when not playing */
export type Path = ({ bat: number; bowl: number; age: number; regular?: boolean } | null)[];

export function realPath(c: CohortPlayer): Path {
  return c.o.map((o, k) => {
    if (!o || (o[0] === null && o[1] === null)) return null;
    return { bat: o[0] ?? NaN, bowl: o[1] ?? NaN, age: c.a + k + 1, regular: o[2] >= REGULAR_BALLS || o[3] >= REGULAR_BALLS };
  });
}

export function simulatedPaths(c: CohortPlayer, horizon: number, runs: number, seed: number, gender: ProgressionGender): Path[] {
  const data = cohortPlayerData(c);
  const paths: Path[] = [];
  for (let r = 0; r < runs; r++) {
    const rng = createRNG(((seed * 2654435761) ^ (r * 40503) ^ (c.a * 977) ^ (c.n * 131)) >>> 0);
    const p = new Player({ ...data, ratingHistory: [...(data.ratingHistory ?? [])] });
    let active = true;
    const path: Path = [];
    for (let k = 0; k < horizon; k++) {
      if (active) {
        const prob = retirementProbability({ age: p.age, overall: p.overall, gender, role: retirementRole(p.bowlingStyle, p.role) });
        if (rng() < prob) active = false;
      }
      if (active) {
        p.progress({ rng, gender });
        path.push({ bat: p.battingOvr, bowl: p.bowlingOvr, age: p.age });
      } else path.push(null);
    }
    paths.push(path);
  }
  return paths;
}

export interface Stat {
  n: number;
  mean: number;
  sd: number;
  p10: number;
  p50: number;
  p90: number;
}

function stat(values: number[]): Stat {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, p10: NaN, p50: NaN, p90: NaN };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const q = (p: number) => v[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))];
  return { n, mean, sd, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

export interface HorizonMetrics {
  horizon: number;
  /** Share of the cohort still playing T20 */
  active: number;
  /** Ovr of the regulars (batting for those who bat regularly, bowling for bowlers) who are still playing */
  level: Stat;
  /** Change from the base-year ovr among those still playing */
  change: Stat;
  improved: number;
  breakout: number;
  collapse: number;
}

export interface ValidationReport {
  gender: ProgressionGender;
  horizons: { real: HorizonMetrics; sim: HorizonMetrics }[];
  /** Mean age at the peak of the main discipline, for players aged 18-24 at the base year with 5+ later seasons */
  peakAge: { real: Stat; sim: Stat };
  /** Age at the last regular season (120+ balls), by role class, for careers that ended at least four seasons before the horizon ends */
  retirementAge: Record<string, { real: Stat; sim: Stat }>;
  /** Share of the cohort whose career ended four+ seasons before the horizon's end */
  retiredEarly: { real: number; sim: number };
}

interface Obs {
  c: CohortPlayer;
  paths: Path[];
  weight: number;
}

function roleClassOf(c: CohortPlayer): string {
  const batReg = c.bb >= REGULAR_BALLS;
  const bowlReg = c.wb >= REGULAR_BALLS;
  if (batReg && bowlReg) return "allround";
  if (bowlReg) return c.bt === "spin" ? "spin" : "pace";
  return "bat";
}

function metricsAt(obs: Obs[], k: number): HorizonMetrics {
  const idx = k - 1;
  let total = 0, act = 0, improved = 0, brk = 0, col = 0, cnt = 0;
  const level: number[] = [], change: number[] = [];
  for (const o of obs) {
    for (const path of o.paths) {
      total += o.weight;
      // still in the game: plays now or at any later season (a gap year is not a retirement)
      if (path.slice(idx).some(Boolean)) act += o.weight;
      const at = path[idx];
      if (!at) continue;
      const regBat = o.c.bb >= REGULAR_BALLS && o.c.bo !== null;
      const regBowl = o.c.wb >= REGULAR_BALLS && o.c.wo !== null;
      for (const [reg, now, base] of [[regBat, at.bat, o.c.bo], [regBowl, at.bowl, o.c.wo]] as [boolean, number, number | null][]) {
        if (!reg || base === null || !Number.isFinite(now)) continue;
        // every (player, run) counts once; the cohort is weighted evenly per player in real and simulated alike
        const w = o.weight;
        level.push(now);
        change.push(now - base);
        cnt += w;
        if (now > base) improved += w;
        if (now - base >= 8) brk += w;
        if (now - base <= -8) col += w;
      }
    }
  }
  return {
    horizon: k, active: act / total, level: stat(level), change: stat(change),
    improved: improved / Math.max(1e-9, cnt), breakout: brk / Math.max(1e-9, cnt), collapse: col / Math.max(1e-9, cnt),
  };
}

function mainOf(c: CohortPlayer, at: { bat: number; bowl: number }): number {
  const batReg = c.bb >= REGULAR_BALLS && c.bo !== null;
  const bowlReg = c.wb >= REGULAR_BALLS && c.wo !== null;
  if (batReg && bowlReg) return Math.max(at.bat, at.bowl);
  return bowlReg ? at.bowl : at.bat;
}

export function validateCohort(
  cohort: Cohort, opts: { runs?: number; seed?: number; horizons?: number[]; gender?: ProgressionGender } = {},
): ValidationReport {
  const gender = opts.gender ?? (cohort.players[0]?.g === "f" ? "female" : "male");
  const runs = opts.runs ?? 20;
  const seed = opts.seed ?? 7;
  const maxH = cohort.players[0]?.o.length ?? 8;
  const horizons = opts.horizons ?? [1, 3, 5, Math.min(8, maxH)];
  const real: Obs[] = cohort.players.map(c => ({ c, paths: [realPath(c)], weight: 1 }));
  const sim: Obs[] = cohort.players.map(c => ({ c, paths: simulatedPaths(c, maxH, runs, seed, gender), weight: 1 / runs }));

  const peak = (obs: Obs[]): number[] => {
    const out: number[] = [];
    for (const o of obs) {
      if (o.c.a < 18 || o.c.a > 24) continue;
      for (const path of o.paths) {
        const vals: { age: number; v: number }[] = [{ age: o.c.a, v: mainOf(o.c, { bat: o.c.bo ?? 0, bowl: o.c.wo ?? 0 }) }];
        for (const at of path) if (at && Number.isFinite(mainOf(o.c, at))) vals.push({ age: at.age, v: mainOf(o.c, at) });
        if (vals.length < 6) continue;
        let best = vals[0];
        for (const x of vals) if (x.v > best.v) best = x;
        out.push(best.age);
      }
    }
    return out;
  };

  const retire = (obs: Obs[]) => {
    const byRole: Record<string, number[]> = {};
    let ended = 0, all = 0;
    for (const o of obs) {
      for (const path of o.paths) {
        all += o.weight;
        let last = -1;
        path.forEach((at, i) => { if (at && at.regular !== false) last = i; });
        if (last <= maxH - 5) {
          // last season index (0 = base year) is at least four seasons before the end
          ended += o.weight;
          const age = o.c.a + last + 1;
          (byRole[roleClassOf(o.c)] ??= []).push(last < 0 ? o.c.a : age);
        }
      }
    }
    return { byRole, share: ended / all };
  };

  const rr = retire(real), sr = retire(sim);
  const retirementAge: ValidationReport["retirementAge"] = {};
  for (const role of new Set([...Object.keys(rr.byRole), ...Object.keys(sr.byRole)])) {
    retirementAge[role] = { real: stat(rr.byRole[role] ?? []), sim: stat(sr.byRole[role] ?? []) };
  }
  return {
    gender,
    horizons: horizons.map(k => ({ real: metricsAt(real, k), sim: metricsAt(sim, k) })),
    peakAge: { real: stat(peak(real)), sim: stat(peak(sim)) },
    retirementAge,
    retiredEarly: { real: rr.share, sim: sr.share },
  };
}

export function formatValidation(r: ValidationReport): string {
  const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
  const lines = [`${r.gender} cohort`, "horizon | still playing real/sim | ovr mean real/sim | ovr sd | change mean | improved | +8 breakout | -8 collapse"];
  for (const { real, sim } of r.horizons) {
    lines.push(
      `+${real.horizon} | ${f(real.active * 100, 0)}% / ${f(sim.active * 100, 0)}% | ${f(real.level.mean)} / ${f(sim.level.mean)} | ${f(real.level.sd)} / ${f(sim.level.sd)}` +
      ` | ${f(real.change.mean, 2)} / ${f(sim.change.mean, 2)} | ${f(real.improved * 100, 0)}% / ${f(sim.improved * 100, 0)}%` +
      ` | ${f(real.breakout * 100, 1)}% / ${f(sim.breakout * 100, 1)}% | ${f(real.collapse * 100, 1)}% / ${f(sim.collapse * 100, 1)}%`,
    );
  }
  lines.push(`peak age (18-24 at start, 5+ later seasons): real ${f(r.peakAge.real.mean)} (n=${r.peakAge.real.n}) / sim ${f(r.peakAge.sim.mean)}`);
  for (const [role, v] of Object.entries(r.retirementAge)) {
    lines.push(`last-season age ${role}: real ${f(v.real.p50, 0)} median (mean ${f(v.real.mean)}, n=${v.real.n}) / sim ${f(v.sim.p50, 0)} (mean ${f(v.sim.mean)})`);
  }
  lines.push(`careers ended 4+ seasons before horizon end: real ${f(r.retiredEarly.real * 100, 0)}% / sim ${f(r.retiredEarly.sim * 100, 0)}%`);
  return lines.join("\n");
}
