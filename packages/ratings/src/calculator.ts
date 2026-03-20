/**
 * Player rating calculator.
 *
 * Converts raw T20 statistics into the 8 game rating attributes.
 * These formulas were originally in Google Sheets in the
 * Determine-Cricket-Player-Ratings project — now codified here.
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

/**
 * Calculate all 8 rating attributes from raw stats.
 *
 * Rating scale: 15-99
 *
 * Batting:
 *  - IQ: batting average normalized (high avg = smarter shot selection)
 *  - Timing: combination of average and consistency (innings played)
 *  - Power: sixes per innings + boundary percentage
 *  - Running: strike rate component from non-boundary runs
 *
 * Bowling:
 *  - WicketTaking: wickets per match, bowling strike rate
 *  - Economy: economy rate inverted (lower = better)
 *  - Accuracy: derived from economy + dot ball estimation
 *  - Clutch: overall effectiveness (wickets * economy balance)
 */
export function calculateRatings(stats: RawPlayerStats): CalculatedRatings {
  const hasBatting = stats.battingInnings > 0 && stats.ballsFaced > 0;
  const hasBowling = stats.bowlingInnings > 0 && stats.ballsBowled > 0;

  // -- Batting ratings --
  const dismissals = stats.battingInnings - stats.notOuts;
  const battingAvg = dismissals > 0 ? stats.runs / dismissals : stats.runs;
  const strikeRate = hasBatting ? (stats.runs / stats.ballsFaced) * 100 : 0;
  const sixesPerInnings = hasBatting ? stats.sixes / stats.battingInnings : 0;
  const foursPerInnings = hasBatting ? stats.fours / stats.battingInnings : 0;
  const boundaryPct = hasBatting
    ? ((stats.fours * 4 + stats.sixes * 6) / Math.max(stats.runs, 1)) * 100
    : 0;
  const runsFromRunning = hasBatting
    ? stats.runs - (stats.fours * 4 + stats.sixes * 6)
    : 0;
  const runningRate = hasBatting && stats.ballsFaced > 0
    ? (runsFromRunning / stats.ballsFaced) * 100
    : 0;

  // Batting IQ: avg normalized. T20 avg of 40+ is elite, <15 is poor
  const battingIQ = hasBatting
    ? clamp(Math.round(20 + (battingAvg / 50) * 70), 15, 99)
    : 20;

  // Timing: avg + experience factor
  const expFactor = Math.min(stats.battingInnings / 80, 1); // maxes at 80 innings
  const timing = hasBatting
    ? clamp(Math.round(15 + (battingAvg / 45) * 50 + expFactor * 25), 15, 99)
    : 20;

  // Power: sixes + boundary percentage
  const power = hasBatting
    ? clamp(Math.round(15 + sixesPerInnings * 25 + (boundaryPct / 80) * 30), 15, 99)
    : 20;

  // Running: non-boundary run rate + strike rate bonus
  const running = hasBatting
    ? clamp(Math.round(20 + runningRate * 40 + (strikeRate - 100) * 0.3), 15, 99)
    : 25;

  // -- Bowling ratings --
  const bowlingOvers = stats.ballsBowled / 6;
  const economyRate = hasBowling ? stats.runsConceded / bowlingOvers : 99;
  const bowlingStrikeRate = hasBowling && stats.wickets > 0
    ? stats.ballsBowled / stats.wickets
    : 999;
  const wicketsPerMatch = hasBowling ? stats.wickets / Math.max(stats.matches, 1) : 0;

  // Wicket Taking: bowling SR + wickets per match
  const wicketTaking = hasBowling
    ? clamp(Math.round(15 + (30 / Math.max(bowlingStrikeRate, 8)) * 50 + wicketsPerMatch * 15), 15, 99)
    : 20;

  // Economy: inverted economy rate. 6.0 = elite, 10.0+ = poor
  const economy = hasBowling
    ? clamp(Math.round(15 + ((12 - economyRate) / 6) * 70), 15, 99)
    : 20;

  // Accuracy: economy-derived + consistency from overs bowled
  const bowlExpFactor = Math.min(bowlingOvers / 200, 1);
  const accuracy = hasBowling
    ? clamp(Math.round(15 + ((10 - economyRate) / 5) * 40 + bowlExpFactor * 30), 15, 99)
    : 25;

  // Clutch: balance of wicket-taking and economy (all-round bowling effectiveness)
  const clutch = hasBowling
    ? clamp(Math.round((wicketTaking + economy) / 2 + (wicketsPerMatch > 1.5 ? 10 : 0)), 15, 99)
    : 30;

  // -- Overall composites --
  const batOvr = Math.round(battingIQ * 0.35 + timing * 0.30 + power * 0.30 + running * 0.05);
  const bowlOvr = Math.round(wicketTaking * 0.40 + economy * 0.40 + accuracy * 0.10 + clutch * 0.10);

  const stronger = Math.max(batOvr, bowlOvr);
  const weaker = Math.min(batOvr, bowlOvr);
  const overall = Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));

  return {
    battingIQ, timing, power, running,
    wicketTaking, economy, accuracy, clutch,
    battingOvr: batOvr, bowlingOvr: bowlOvr, overall,
  };
}

/**
 * Infer player role from calculated ratings.
 */
export function inferRole(ratings: CalculatedRatings): "batsman" | "bowler" | "all-rounder" {
  const diff = ratings.battingOvr - ratings.bowlingOvr;
  if (diff > 15) return "batsman";
  if (diff < -15) return "bowler";
  return "all-rounder";
}
