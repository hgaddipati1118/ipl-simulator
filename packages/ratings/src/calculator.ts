/**
 * Player rating calculator.
 *
 * Converts raw T20 statistics into the 8 game rating attributes.
 *
 * Approach (from the Cricket Player Ratings spreadsheet):
 * 1. Compute per-ball/per-innings derived stats
 * 2. Z-score each stat relative to population mean/stdev
 * 3. Pass weighted z-score blends through NORM.S.DIST (normal CDF) → 0-100 percentile
 * 4. Apply experience and age adjustments
 *
 * Rating scale: 15-99
 */

import { clamp } from "@ipl-sim/engine";

export interface RawPlayerStats {
  name: string;
  age: number;
  country: string;

  // batting
  matches: number;
  battingInnings: number;
  notOuts: number;
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;

  // bowling
  bowlingInnings: number;
  ballsBowled: number;
  runsConceded: number;
  wickets: number;

  // fielding
  catches: number;
}

export interface CalculatedRatings {
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
}

// ── Normal distribution helpers ──────────────────────────────────────

/** Standard normal CDF (Φ). Returns percentile 0-1 for a z-score. */
function normSDist(z: number): number {
  // Abramowitz & Stegun approximation (accurate to 7.5e-8)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * erf);
}

/** Convert a weighted z-score blend to a 0-100 rating via normal CDF. */
function zToRating(zBlend: number): number {
  return normSDist(zBlend) * 100;
}

// ── Population statistics for z-scoring ──────────────────────────────
// These are calibrated from the full ESPN player dataset.
// Each stat is the (mean, stdev) of the per-innings/per-ball metric across all players.

interface PopStats { mean: number; std: number; }

interface BatPopStats {
  average: PopStats;
  strikeRate: PopStats;
  ballsPerOut: PopStats;
  boundariesPerBall: PopStats;
  sixesPerBall: PopStats;
  srNoBoundaries: PopStats;
  batPct: PopStats;
  experience: PopStats;
}

interface BowlPopStats {
  wicketsPerBall: PopStats;
  runsPerBall: PopStats;
  ballsPerBoundary: PopStats;
  bowlPct: PopStats;
  ballsPerInnings: PopStats;
  dotBallPct: PopStats;
}

// Batting stats — calibrated from 2,200+ ESPN T20 players (10+ matches)
const POP_BAT: BatPopStats = {
  average:          { mean: 19, std: 8.5 },      // batting avg
  strikeRate:       { mean: 116, std: 25 },       // batting SR
  ballsPerOut:      { mean: 15, std: 8 },         // balls faced / dismissals
  boundariesPerBall:{ mean: 0.12, std: 0.05 },    // (4s+6s) / balls faced
  sixesPerBall:     { mean: 0.043, std: 0.029 },  // sixes / balls faced
  srNoBoundaries:   { mean: 42, std: 16 },        // (runs - boundary runs) / balls * 100
  batPct:           { mean: 0.75, std: 0.2 },     // batting innings / matches
  experience:       { mean: 74, std: 82 },        // total matches
};

// Bowling stats — calibrated from 1,000+ qualified bowlers
// Use artificially wider stdev to spread the pre-filtered population
// and prevent compression of z-scores among "all decent" bowlers
const POP_BOWL: BowlPopStats = {
  wicketsPerBall:   { mean: 0.045, std: 0.018 },  // wider mean/std to spread from avg to elite
  runsPerBall:      { mean: 1.35, std: 0.25 },    // wider — 8.1 econ = avg, 6.5 = elite, 10 = poor
  ballsPerBoundary: { mean: 6, std: 3 },
  bowlPct:          { mean: 0.5, std: 0.3 },
  ballsPerInnings:  { mean: 20, std: 8 },
  dotBallPct:       { mean: 0.38, std: 0.15 },
};

// Women's batting stats — calibrated from 468 qualified WT20I players (10+ matches)
// Women's T20I features lower scoring rates, fewer boundaries, and much fewer sixes.
const POP_BAT_WOMEN: BatPopStats = {
  average:          { mean: 13, std: 9 },         // lower than men (13 vs 19)
  strikeRate:       { mean: 90, std: 28 },         // women ~90 SR on average (vs 116)
  ballsPerOut:      { mean: 16, std: 8 },          // similar to men
  boundariesPerBall:{ mean: 0.07, std: 0.04 },     // far fewer boundaries
  sixesPerBall:     { mean: 0.008, std: 0.012 },   // very few sixes in women's cricket
  srNoBoundaries:   { mean: 35, std: 15 },          // lower non-boundary scoring
  batPct:           { mean: 0.75, std: 0.2 },       // similar to men
  experience:       { mean: 55, std: 50 },           // fewer career matches on average
};

// Women's bowling stats — calibrated from 316 qualified WT20I bowlers (100+ balls, 5+ wk).
// The actual population is: econ mean=5.84 std=1.04, RPB mean=0.973 std=0.174.
// We shift the mean slightly upward (worse) so that elite bowlers (econ ~5.8-6.0)
// get positive z-scores. This ensures top international bowlers rate 75-85.
const POP_BOWL_WOMEN: BowlPopStats = {
  wicketsPerBall:   { mean: 0.042, std: 0.020 },   // shifted down so elite wpb=0.06 → z=0.9
  runsPerBall:      { mean: 1.10, std: 0.22 },      // shifted up so econ 6.0 → rpb=1.0 → z=0.45
  ballsPerBoundary: { mean: 10, std: 5 },
  bowlPct:          { mean: 0.5, std: 0.3 },
  ballsPerInnings:  { mean: 18, std: 6 },
  dotBallPct:       { mean: 0.40, std: 0.15 },
};

export type GenderPop = "men" | "women";

/** Get population stats for the given gender */
function getPopStats(gender: GenderPop = "men"): { bat: BatPopStats; bowl: BowlPopStats } {
  if (gender === "women") {
    return { bat: POP_BAT_WOMEN, bowl: POP_BOWL_WOMEN };
  }
  return { bat: POP_BAT, bowl: POP_BOWL };
}

/** Compute z-score for a stat value */
function zScore(value: number, pop: PopStats): number {
  if (pop.std === 0) return 0;
  return (value - pop.mean) / pop.std;
}

// ── Main calculator ──────────────────────────────────────────────────

export function calculateRatings(stats: RawPlayerStats, gender: GenderPop = "men"): CalculatedRatings {
  const hasBatting = stats.battingInnings > 0 && stats.ballsFaced > 0;
  const hasBowling = stats.bowlingInnings > 0 && stats.ballsBowled > 0;

  const { bat: popBat, bowl: popBowl } = getPopStats(gender);

  // ── Derived batting metrics ──
  const dismissals = Math.max(stats.battingInnings - stats.notOuts, 1);
  const battingAvg = hasBatting ? stats.runs / dismissals : 0;
  const strikeRate = hasBatting ? (stats.runs / stats.ballsFaced) * 100 : 0;
  const ballsPerOut = hasBatting ? stats.ballsFaced / dismissals : 0;
  const boundaryRuns = stats.fours * 4 + stats.sixes * 6;
  const boundariesPerBall = hasBatting ? (stats.fours + stats.sixes) / stats.ballsFaced : 0;
  const sixesPerBall = hasBatting ? stats.sixes / stats.ballsFaced : 0;
  const nonBoundaryRuns = Math.max(stats.runs - boundaryRuns, 0);
  const srNoBoundaries = hasBatting ? (nonBoundaryRuns / stats.ballsFaced) * 100 : 0;
  const batPct = stats.matches > 0 ? stats.battingInnings / stats.matches : 0;

  // ── Z-scores for batting ──
  const zAvg = zScore(battingAvg, popBat.average);
  const zSR = zScore(strikeRate, popBat.strikeRate);
  const zBPO = zScore(ballsPerOut, popBat.ballsPerOut);
  const zBdryPB = zScore(boundariesPerBall, popBat.boundariesPerBall);
  const zSixPB = zScore(sixesPerBall, popBat.sixesPerBall);
  const zSRnb = zScore(srNoBoundaries, popBat.srNoBoundaries);
  const zBatPct = zScore(batPct, popBat.batPct);
  const zExp = zScore(stats.matches, popBat.experience);

  // ── Batting ratings (spreadsheet formulas) ──
  // IQ = f(EXP*0.2 + AVG*0.25 + BallsPerOut*0.2 + BatPct*0.15 + SR_NoBoundaries*0.2)
  const battingIQ = hasBatting
    ? clamp(Math.round(zToRating(zExp*0.2 + zAvg*0.25 + zBPO*0.2 + zBatPct*0.15 + zSRnb*0.2)), 15, 99)
    : 20;

  // Technique = f(SR*0.3 + AVG*0.2 + SR_NoBoundaries*0.2 + BdryPerBall*0.2 + BatPct*0.1)
  const timing = hasBatting
    ? clamp(Math.round(zToRating(zSR*0.3 + zAvg*0.2 + zSRnb*0.2 + zBdryPB*0.2 + zBatPct*0.1)), 15, 99)
    : 20;

  // Power = f(SR*0.2 + BdryPerBall*0.4 + SixesPerBall*0.4)
  const power = hasBatting
    ? clamp(Math.round(zToRating(zSR*0.2 + zBdryPB*0.4 + zSixPB*0.4)), 15, 99)
    : 20;

  // Running = f(SR*0.2 + SR_NoBoundaries*0.5 + Age*0.3)
  // Age: younger = higher running. z-score age inversely (negate)
  const zAge = -zScore(stats.age, { mean: 28, std: 5 });
  const running = hasBatting
    ? clamp(Math.round(zToRating(zSR*0.2 + zSRnb*0.5 + zAge*0.3)), 15, 99)
    : 25;

  // ── Derived bowling metrics ──
  const bowlingOvers = stats.ballsBowled / 6;
  const economyRate = hasBowling ? stats.runsConceded / bowlingOvers : 99;
  const wicketsPerBall = hasBowling ? stats.wickets / stats.ballsBowled : 0;
  const runsPerBall = hasBowling ? stats.runsConceded / stats.ballsBowled : 2;
  // Economy inverted for z-score: lower economy = higher z-score
  const ballsPerInnings = hasBowling && stats.bowlingInnings > 0 ? stats.ballsBowled / stats.bowlingInnings : 0;
  // Dot ball % estimation: (1 - runsPerBall/1.5) roughly
  const dotBallPct = hasBowling ? Math.max(0, 1 - runsPerBall / 1.8) : 0;

  // ── Z-scores for bowling ──
  const zWPB = zScore(wicketsPerBall, popBowl.wicketsPerBall);
  // Economy: invert (negate) so lower econ = higher z-score
  const zEcon = -zScore(runsPerBall, popBowl.runsPerBall);
  const zDotPct = zScore(dotBallPct, popBowl.dotBallPct);
  const zBowlPct = zScore(stats.matches > 0 ? stats.bowlingInnings / stats.matches : 0, popBowl.bowlPct);
  const zBPI = zScore(ballsPerInnings, popBowl.ballsPerInnings);
  const zBowlExp = zScore(stats.matches, popBat.experience);

  // ── Bowling ratings ──
  // WicketTaking: primarily wickets per ball + some economy context
  const wicketTaking = hasBowling
    ? clamp(Math.round(zToRating(zWPB*0.6 + zEcon*0.2 + zBowlPct*0.1 + zBowlExp*0.1)), 15, 99)
    : 20;

  // Economy: primarily economy + dot ball rate
  const economy = hasBowling
    ? clamp(Math.round(zToRating(zEcon*0.7 + zDotPct*0.2 + zBowlPct*0.1)), 15, 99)
    : 20;

  // Accuracy: experience + economy + consistency
  const accuracy = hasBowling
    ? clamp(Math.round(zToRating(zBowlExp*0.4 + zEcon*0.2 + zDotPct*0.3 + zBowlPct*0.1)), 15, 99)
    : 25;

  // Clutch: bowling under pressure — experience + bowling workload
  const clutch = hasBowling
    ? clamp(Math.round(zToRating(zBowlExp*0.3 + zBowlPct*0.3 + zWPB*0.2 + zEcon*0.2)), 15, 99)
    : 30;

  // ── Experience penalty (small sample regression) ──
  // Aggressive for very small samples: 10 matches → 0.5, 20 → 0.67, 30 → 0.83, 50 → 1.0
  const matchPenalty = stats.matches < 50
    ? 0.33 + 0.67 * (stats.matches / 50)
    : 1.0;

  // ── Age curve adjustment ──
  const age = stats.age;
  let ageFactor: number;
  if (age <= 20)      ageFactor = 1.08;
  else if (age <= 22) ageFactor = 1.05;
  else if (age <= 25) ageFactor = 1.03;
  else if (age <= 27) ageFactor = 1.01;
  else if (age <= 32) ageFactor = 1.0;
  else if (age <= 34) ageFactor = 0.96;
  else if (age <= 36) ageFactor = 0.92;
  else if (age <= 38) ageFactor = 0.87;
  else                ageFactor = 0.80;

  // ── Apply experience penalty and age curve to individual attributes ──
  // This is critical: the Player class recomputes overalls from individual attributes,
  // so the penalty MUST be baked into the attributes themselves, not just the overalls.
  const combinedFactor = matchPenalty * ageFactor;

  let adjBattingIQ = battingIQ;
  let adjTiming = timing;
  let adjPower = power;
  let adjRunning = running;
  let adjWicketTaking = wicketTaking;
  let adjEconomy = economy;
  let adjAccuracy = accuracy;
  let adjClutch = clutch;

  if (combinedFactor !== 1.0) {
    adjBattingIQ = clamp(Math.round(50 + (battingIQ - 50) * combinedFactor), 15, 99);
    adjTiming = clamp(Math.round(50 + (timing - 50) * combinedFactor), 15, 99);
    adjPower = clamp(Math.round(50 + (power - 50) * combinedFactor), 15, 99);
    adjRunning = clamp(Math.round(50 + (running - 50) * combinedFactor), 15, 99);
    adjWicketTaking = clamp(Math.round(50 + (wicketTaking - 50) * combinedFactor), 15, 99);
    adjEconomy = clamp(Math.round(50 + (economy - 50) * combinedFactor), 15, 99);
    adjAccuracy = clamp(Math.round(50 + (accuracy - 50) * combinedFactor), 15, 99);
    adjClutch = clamp(Math.round(50 + (clutch - 50) * combinedFactor), 15, 99);
  }

  // ── Overall composites (from adjusted attributes) ──
  // Batting: IQ 30%, Technique 30%, Power 35%, Running 5% (from spreadsheet)
  const batOvr = clamp(Math.round(adjBattingIQ * 0.30 + adjTiming * 0.30 + adjPower * 0.35 + adjRunning * 0.05), 15, 99);
  // Bowling: WT 45%, Economy 30%, Accuracy 10%, Clutch 15%
  // Wicket-taking is king in T20 — taking wickets wins matches
  const bowlOvr = clamp(Math.round(adjWicketTaking * 0.45 + adjEconomy * 0.30 + adjAccuracy * 0.10 + adjClutch * 0.15), 15, 99);

  const stronger = Math.max(batOvr, bowlOvr);
  const weaker = Math.min(batOvr, bowlOvr);
  const overall = Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));

  return {
    battingIQ: adjBattingIQ, timing: adjTiming, power: adjPower, running: adjRunning,
    wicketTaking: adjWicketTaking, economy: adjEconomy, accuracy: adjAccuracy, clutch: adjClutch,
    battingOvr: batOvr, bowlingOvr: bowlOvr, overall,
  };
}

/**
 * Infer player role from calculated ratings.
 */
export function inferRole(ratings: CalculatedRatings): "batsman" | "bowler" | "all-rounder" {
  const diff = ratings.battingOvr - ratings.bowlingOvr;
  // Batting 55+ and bowling 60+ (or vice versa) to be a genuine all-rounder
  const bothCompetent = Math.min(ratings.battingOvr, ratings.bowlingOvr) >= 55
    && Math.max(ratings.battingOvr, ratings.bowlingOvr) >= 60;
  if (!bothCompetent) return diff >= 0 ? "batsman" : "bowler";
  if (diff > 25) return "batsman";
  if (diff < -25) return "bowler";
  return "all-rounder";
}
