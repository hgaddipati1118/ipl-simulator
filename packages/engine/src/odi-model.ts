/**
 * The ODI ball model (docs/FORMATS.md, ODI section).
 *
 * An ODI delivery does not go through the T20 tables (base matrix x phase multipliers x chase adjustment): its outcome
 * weights come from a model fitted on Cricsheet ODIs (odi-model-data.ts, built by
 * packages/ratings/src/analysis/odi-ball-model.py):
 *
 *   weight_k = base_k x over_k x wickets_k(down, overs) x set_k(balls faced) x chase_k(required rate, stage)
 *              x bowlerType_k(pace / spin, overs) x rating_k(batter, bowler) x ODI_CAL_k
 *
 * The context factors were fitted with each batter's and bowler's own quality taken out, so the situation effects
 * (wickets kept in hand, then the late charge; a set batter; a chase that needs 8 an over) are behaviour, not the tail
 * coming in. Player quality comes from the ratings: rating_k is log-linear in the same rating composites the T20 model
 * uses (batter - bowler balance, timing, power, wicket-taking, accuracy), measured from REF, the involvement-weighted
 * average of international XIs, with slopes scaled to the real spread of ODI batters and bowlers. ODI_CAL is the small
 * per-outcome calibration that brings a replay of the real 2019+ fixture list to the real per-delivery rates
 * (benchmark-odi.ts). Everything else on the ball (venue, hand matchups, fielding, free hits, DRS, extras detail) is
 * shared with the T20 engine.
 */

import type { BallOutcome } from "./match.js";
import { isSpinBowler, type BowlingStyle } from "./matchups.js";
import { ODI_MODEL_DATA } from "./odi-model-data.js";

/** Outcome order of every vector in the ODI tables */
export const ODI_OUTCOMES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"] as const satisfies readonly BallOutcome[];

/** One gender's fitted tables (odi-model-data.ts) */
export interface OdiModelTables {
  /** Average 2019+ ODI delivery */
  base: number[];
  /** [over 0-49] */
  over: number[][];
  /** [wickets down 0..7, 8+][overs 1-10, 11-20, 21-30, 31-40, 41-45, 46-50] */
  wickets: number[][][];
  /** [striker's balls faced: 0, 1-4, 5-9, 10-19, 20-34, 35-59, 60-99, 100+] */
  set: number[][];
  /** [stage: overs 1-20, 21-35, 36-45, 46-50][required rate: <3, 3-4, 4-5, 5-6, 6-7, 7-8, 8-9, 9-10, 10-12, 12+] */
  chase: number[][][];
  /** [2010-14, 2015-18, 2019-26] */
  era: number[][];
  /** [pace, spin][overs 1-10, 11-20, 21-30, 31-40, 41-50] */
  bowlerType: number[][][];
}

/** ODI rain rates (odi-model-data.ts ODI_RAIN) */
export interface OdiRainRates {
  matches: number;
  pNoResult: number;
  pReduced: number;
  when: { preMatch: number; firstInnings: number; secondInnings: number };
  /** Overs per side after the cut, 5-over bands keyed by their first over */
  oversPerSide: Record<string, number>;
}

/** What the ODI model needs to know about a player (a Player, or the live engine's serialized player) */
export interface OdiPlayerLike {
  battingOvr: number;
  bowlingOvr: number;
  bowlingStyle?: BowlingStyle;
  ratings: { timing: number; power: number; wicketTaking: number; accuracy: number };
}

export interface OdiBallContext {
  /** Over of the innings (0-based) */
  over: number;
  wicketsDown: number;
  /** Balls the striker has faced so far */
  batterBalls: number;
  /** Second innings: runs still needed and legal balls left */
  chase?: { runsNeeded: number; ballsLeft: number };
  gender: "male" | "female";
  /** Overs the innings is scheduled for (rain): the over tables are stretched onto it. Default 50 */
  scheduledOvers?: number;
  /** Era of the scoring level (index into the era table); default the 2019-26 level */
  era?: 0 | 1 | 2;
}

/**
 * Reference ratings: the involvement-weighted average of the international XIs the benchmark replays (balls faced for
 * the batting composites, balls bowled for the bowling ones), so an average matchup has rating_k = 1.
 */
export const ODI_REF = { bat: 0.582, timing: 0.585, power: 0.538, bowl: 0.606, wicketTaking: 0.62, accuracy: 0.62 };

/**
 * Slopes of log rating_k per unit of composite (ratings / 100). They start from the T20 model's own sensitivities at REF
 * (d log p / d x) and are scaled so the simulated spread of batters' and bowlers' rates matches the real ODI spread
 * (player effects of odi-ball-model.py, docs/data/odi_ball_model.json playerSpread).
 */
export const ODI_RATING_SLOPES: Record<(typeof ODI_OUTCOMES)[number], { balance?: number; timing?: number; power?: number; wicketTaking?: number; accuracy?: number }> = {
  dot: { balance: -0.55 },
  "1": { balance: 0.12 },
  "2": { balance: 0.45 },
  "3": {},
  "4": { balance: 0.9, timing: 0.45 },
  "6": { balance: 1.6, power: 1.4 },
  wicket: { balance: -1.6, wicketTaking: 0.9 },
  wide: { accuracy: -0.8 },
  noball: { accuracy: -1.2 },
  legbye: {},
};

/** Per-outcome calibration of the full engine (venue, matchups, fielding layers) to the real 2019+ rates, per gender */
export const ODI_CAL: Record<"male" | "female", number[]> = {
  male: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  female: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
};

const SET_EDGES = [0, 1, 5, 10, 20, 35, 60, 100];
const RRR_EDGES = [0, 3, 4, 5, 6, 7, 8, 9, 10, 12];

function edgeIndex(x: number, edges: readonly number[]): number {
  let i = 0;
  while (i + 1 < edges.length && x >= edges[i + 1]) i++;
  return i;
}

/** Overs-bucket of the wickets table: 1-10, 11-20, 21-30, 31-40, 41-45, 46-50 */
function wicketsBucket(o: number): number {
  return o < 40 ? Math.floor(o / 10) : o < 45 ? 4 : 5;
}

/** Stage of the chase table: overs 1-20, 21-35, 36-45, 46-50 */
function chaseStage(o: number): number {
  return o < 20 ? 0 : o < 35 ? 1 : o < 45 ? 2 : 3;
}

/** The fitted tables for a gender */
export function odiTables(gender: "male" | "female"): OdiModelTables {
  return ODI_MODEL_DATA[gender === "female" ? "women" : "men"];
}

/** Over of a full 50-over innings that over `over` of a `scheduled`-over innings plays like (rain shortens all phases alike) */
export function odiTableOver(over: number, scheduled = 50): number {
  if (scheduled >= 50) return Math.min(49, Math.max(0, over));
  return Math.min(49, Math.floor((over * 50) / Math.max(1, scheduled)));
}

/** rating_k: the batter's and bowler's quality against the reference matchup */
export function odiRatingMultipliers(batter: OdiPlayerLike, bowler: OdiPlayerLike): number[] {
  const bal = ((batter.battingOvr + batter.ratings.timing) / 200 - ODI_REF.bat) - ((bowler.bowlingOvr + bowler.ratings.accuracy) / 200 - ODI_REF.bowl);
  const dx = {
    balance: bal,
    timing: batter.ratings.timing / 100 - ODI_REF.timing,
    power: batter.ratings.power / 100 - ODI_REF.power,
    wicketTaking: bowler.ratings.wicketTaking / 100 - ODI_REF.wicketTaking,
    accuracy: bowler.ratings.accuracy / 100 - ODI_REF.accuracy,
  };
  return ODI_OUTCOMES.map(k => {
    const s = ODI_RATING_SLOPES[k];
    let x = 0;
    for (const [term, slope] of Object.entries(s) as [keyof typeof dx, number][]) x += slope * dx[term];
    // a hard limit keeps impossible rating gaps (a number 11 against an all-time great) from leaving the data
    return Math.exp(Math.max(-1.6, Math.min(1.6, x)));
  });
}

/** The context factors (no players): base x over x wickets x set x chase x era x bowler type */
export function odiContextWeights(ctx: OdiBallContext, bowlingStyle: BowlingStyle | undefined): number[] {
  const t = odiTables(ctx.gender);
  const o = odiTableOver(ctx.over, ctx.scheduledOvers);
  const wk = t.wickets[Math.min(8, Math.max(0, ctx.wicketsDown))][wicketsBucket(o)];
  const st = t.set[edgeIndex(Math.max(0, ctx.batterBalls), SET_EDGES)];
  let ch: number[] | undefined;
  if (ctx.chase && ctx.chase.ballsLeft > 0) {
    const rrr = (6 * Math.max(0, ctx.chase.runsNeeded)) / ctx.chase.ballsLeft;
    ch = t.chase[chaseStage(o)][edgeIndex(rrr, RRR_EDGES)];
  }
  const era = t.era[ctx.era ?? 2];
  const bt = t.bowlerType[bowlingStyle && isSpinBowler(bowlingStyle) ? 1 : 0][Math.min(4, Math.floor(o / 10))];
  return t.base.map((b, k) => b * t.over[o][k] * wk[k] * st[k] * (ch ? ch[k] : 1) * era[k] * bt[k]);
}

/** Outcome weights of one ODI delivery before the shared layers (venue, matchups, fielding ...); not normalised */
export function odiBallProbabilities(batter: OdiPlayerLike, bowler: OdiPlayerLike, ctx: OdiBallContext): Record<BallOutcome, number> {
  const c = odiContextWeights(ctx, bowler.bowlingStyle);
  const m = odiRatingMultipliers(batter, bowler);
  const cal = ODI_CAL[ctx.gender];
  const p = {} as Record<BallOutcome, number>;
  ODI_OUTCOMES.forEach((k, i) => { p[k] = c[i] * m[i] * cal[i]; });
  return p;
}

// ── Captaincy: who bowls the next over (both engines) ──────────────────

export interface OdiBowlerOption {
  id: string;
  /** Overs bowled so far (a part-bowled over counts) */
  overs: number;
  /** The captain's ranking of him (higher = better) */
  rating: number;
}

/**
 * Narrow the bowlers who may bowl the next over (already filtered for the cap and the consecutive-over rule) to the ones
 * a captain would choose from in a 50-over innings, best first:
 *  - when the attack's overs left barely cover the innings (five bowlers, all ten overs needed), only bowlers after whose
 *    over every quota can still be finished in alternate overs (so no part-timer and no forced pair of overs in a row);
 *  - before the last fifth of the innings the two best bowlers keep three overs each for the death.
 */
export function odiBowlerChoices(
  eligible: readonly OdiBowlerOption[],
  attack: readonly OdiBowlerOption[],
  over: number,
  scheduledOvers: number,
  cap: number,
): OdiBowlerOption[] {
  let ranked = [...eligible].sort((a, b) => b.rating - a.rating);
  if (ranked.length <= 1) return ranked;
  const left = (b: OdiBowlerOption) => Math.max(0, cap - b.overs);
  const oversLeft = scheduledOvers - over;
  const capacity = attack.reduce((s, b) => s + left(b), 0);
  if (capacity - oversLeft <= 2) {
    // after this over L1 remain; the bowler cannot bowl the next one, everyone else can bowl every other over
    const L1 = oversLeft - 1;
    const feasible = ranked.filter(b => left(b) - 1 <= Math.floor(L1 / 2) && attack.every(x => x.id === b.id || left(x) <= Math.ceil(L1 / 2)));
    if (feasible.length > 0) ranked = feasible;
  }
  if (over < Math.round(scheduledOvers * 0.8)) {
    const top2 = new Set([...attack].sort((a, b) => b.rating - a.rating).slice(0, 2).map(b => b.id));
    const reserve = Math.min(3, Math.round(cap * 0.3));
    const kept = ranked.filter(b => !top2.has(b.id) || left(b) > reserve);
    if (kept.length > 0) ranked = kept;
  }
  return ranked;
}
