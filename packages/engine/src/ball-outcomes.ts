/**
 * Realistic ball outcome system for cricket simulation.
 *
 * Handles: dismissal types, run outs, dropped catches, wides, no-balls,
 * free hits, leg byes, overthrows, and mid-match injuries.
 */

import type { BowlingStyle } from "./player.js";
import type { RNG } from "./rng.js";

// ── Dismissal Types ─────────────────────────────────────────────────────

export type DismissalType =
  | "bowled"        // ~15% of T20 dismissals
  | "caught"        // ~40% (in field/deep)
  | "caught-behind" // ~15% (keeper catch, DRS-reviewable)
  | "lbw"           // ~12% (DRS-reviewable)
  | "run-out"       // ~8%
  | "stumped"       // ~5% (mainly vs spin)
  | "hit-wicket";   // ~1%

/** Given a wicket has fallen, determine the type of dismissal */
export function determineDismissalType(params: {
  bowlingStyle: BowlingStyle;
  batterRunning: number;    // 0-99
  fieldingQuality: number;  // 0-99 avg fielding of bowling team
  isSpinner: boolean;
  batterRuns: number;       // current score (set batters less likely run out)
  rng?: RNG;
}): DismissalType {
  const { bowlingStyle, batterRunning, fieldingQuality, isSpinner, batterRuns, rng = Math.random } = params;

  // Base probabilities (must sum to 1.0)
  let bowled = 0.15;
  let caught = 0.40;
  let caughtBehind = 0.15;
  let lbw = 0.12;
  let runOut = 0.08;
  let stumped = 0.05;
  let hitWicket = 0.01;

  // Adjustments based on bowling type
  if (isSpinner) {
    stumped *= 2.0;    // Spinners cause more stumpings
    bowled *= 0.8;     // Less likely to bowl batters out with spin
    lbw *= 1.2;        // More LBW with spin (turning into pads)
    caughtBehind *= 0.7; // Fewer edges to keeper off spin
  } else {
    // Pace
    bowled *= 1.1;
    caughtBehind *= 1.3; // More edges off pace
    stumped *= 0.3;      // Rare off pace
  }

  // Running quality affects run-out probability
  const runOutMod = 1.0 + (100 - batterRunning) / 200; // poor running = more run outs
  runOut *= runOutMod;

  // Set batters less likely to be run out (more cautious)
  if (batterRuns > 30) runOut *= 0.7;

  // Fielding quality affects catches and run outs
  const fieldMod = fieldingQuality / 70; // 70 = baseline
  caught *= fieldMod;
  caughtBehind *= fieldMod;
  runOut *= fieldMod;

  // Normalize
  const total = bowled + caught + caughtBehind + lbw + runOut + stumped + hitWicket;
  const rand = rng() * total;

  let cumulative = 0;
  if ((cumulative += bowled) > rand) return "bowled";
  if ((cumulative += caught) > rand) return "caught";
  if ((cumulative += caughtBehind) > rand) return "caught-behind";
  if ((cumulative += lbw) > rand) return "lbw";
  if ((cumulative += runOut) > rand) return "run-out";
  if ((cumulative += stumped) > rand) return "stumped";
  return "hit-wicket";
}

// ── Dropped Catches ─────────────────────────────────────────────────────

/** Returns true if a catch is dropped (fielding error) */
export function isCatchDropped(params: {
  fieldingQuality: number;  // 0-99
  matchPressure: number;    // 0-1 (higher = more pressure, e.g. death overs in close chase)
  isEdge: boolean;          // edge catches are harder
  rng?: RNG;
}): boolean {
  const { fieldingQuality, matchPressure, isEdge, rng = Math.random } = params;

  // Base drop rate: ~8% for average fielders
  let dropChance = 0.08;

  // Fielding quality reduces drops (90+ = elite, <50 = poor)
  dropChance *= (100 - fieldingQuality) / 30;

  // Pressure increases drops
  dropChance *= (1 + matchPressure * 0.5);

  // Edge catches harder to hold
  if (isEdge) dropChance *= 1.5;

  // Cap at 25% max drop rate
  dropChance = Math.min(0.25, Math.max(0.02, dropChance));

  return rng() < dropChance;
}

// ── Wide Types ──────────────────────────────────────────────────────────

export type WideType = "down-leg" | "outside-off" | "bouncer-wide";

/** Determine the type of wide delivery */
export function determineWideType(bowlingStyle: BowlingStyle, over: number, rng: RNG = Math.random): WideType {
  const isPace = ["right-arm-fast", "left-arm-fast", "right-arm-medium", "left-arm-medium"].includes(bowlingStyle);
  const isDeath = over >= 16;

  if (isPace && isDeath) {
    // Pace bowlers try yorkers in death → wides down leg
    return rng() < 0.7 ? "down-leg" : "bouncer-wide";
  }
  if (isPace) {
    return rng() < 0.5 ? "down-leg" : "outside-off";
  }
  // Spin
  return rng() < 0.6 ? "outside-off" : "down-leg";
}

/** Can runs be scored off a wide? (1-2 extra byes) */
export function runsOffWide(rng: RNG = Math.random): number {
  const rand = rng();
  if (rand < 0.05) return 4; // Wide to boundary (~5%)
  if (rand < 0.15) return 2; // Keeper misses, run 2 (~10%)
  if (rand < 0.30) return 1; // Run 1 bye off wide (~15%)
  return 0; // Just 1 wide, no additional runs (~70%)
}

// ── No Ball Types ───────────────────────────────────────────────────────

export type NoBallType = "front-foot" | "bouncer" | "beamer";

/** Determine the type of no ball */
export function determineNoBallType(bouncersThisOver: number, maxBouncersPerOver: number, rng: RNG = Math.random): NoBallType {
  const rand = rng();
  if (bouncersThisOver >= maxBouncersPerOver && rand < 0.3) return "bouncer";
  if (rand < 0.03) return "beamer"; // Very rare
  return "front-foot"; // Most common
}

/** Can runs be scored off a no ball? */
export function runsOffNoBall(rng: RNG = Math.random): number {
  // Batters often swing at no-balls
  const rand = rng();
  if (rand < 0.12) return 6; // Big hit off no-ball
  if (rand < 0.25) return 4; // Boundary off no-ball
  if (rand < 0.45) return 1; // Single off no-ball
  return 0; // Just 1 no-ball extra
}

// ── Free Hit ────────────────────────────────────────────────────────────

/** On a free hit, the batter can only be run out.
 *  Returns true if this is a free hit situation. */
export function isFreeHitBall(previousBallWasNoBall: boolean): boolean {
  return previousBallWasNoBall;
}

/** On a free hit, only run-out dismissals are valid.
 *  All other dismissals are cancelled (batter survives). */
export function canBeDismissedOnFreeHit(dismissalType: DismissalType): boolean {
  return dismissalType === "run-out";
}

// ── Leg Byes / Byes ─────────────────────────────────────────────────────

/** Determine if leg byes/byes occur (ball misses bat, batters run) */
export function determineLegByes(params: {
  batterRunning: number;
  isPace: boolean;
  rng?: RNG;
}): number {
  const { batterRunning, isPace, rng = Math.random } = params;

  // Leg byes more common off pace (ball deflects off pads)
  const baseProbability = isPace ? 0.04 : 0.02;

  if (rng() > baseProbability) return 0;

  // Running quality affects how many leg byes
  if (batterRunning > 70 && rng() < 0.3) return 2;
  return 1;
}

// ── Run Outs ────────────────────────────────────────────────────────────

/** When batters run (1, 2, 3), check for run-out possibility */
export function checkRunOut(params: {
  runsAttempted: number;
  batterRunning: number;    // 0-99
  nonStrikerRunning: number; // 0-99
  fieldingQuality: number;   // 0-99
}): boolean {
  const { runsAttempted, batterRunning, nonStrikerRunning, fieldingQuality } = params;

  if (runsAttempted <= 0) return false;

  // Base run-out probability per run attempt
  let chance = 0;
  switch (runsAttempted) {
    case 1: chance = 0.005; break; // Very rare on singles
    case 2: chance = 0.03; break;  // More common on 2s
    case 3: chance = 0.08; break;  // Risky 3s
    default: chance = 0.01;
  }

  // Running quality reduces risk
  const avgRunning = (batterRunning + nonStrikerRunning) / 2;
  chance *= (100 - avgRunning) / 50; // Good runners = halved risk

  // Fielding quality increases risk
  chance *= fieldingQuality / 60;

  return Math.random() < chance;
}

// ── Overthrows ──────────────────────────────────────────────────────────

/** Rare overthrow — misfield sends ball to boundary */
export function checkOverthrow(fieldingQuality: number): { happened: boolean; extraRuns: number } {
  // Base 1% chance, reduced by fielding quality
  const chance = 0.01 * (100 - fieldingQuality) / 50;
  if (Math.random() < chance) {
    return { happened: true, extraRuns: 4 }; // Overthrow to boundary
  }
  return { happened: false, extraRuns: 0 };
}

// ── Mid-Match Injuries ──────────────────────────────────────────────────

export type MatchInjuryType = "hamstring" | "side-strain" | "groin" | "concussion" | "finger" | "ankle";

/** Check if a player gets injured during play */
export function checkMidMatchInjury(params: {
  playerAge: number;
  isBowling: boolean;
  oversBowled: number;
  isSprinting: boolean; // running between wickets
}): { injured: boolean; type: MatchInjuryType } | null {
  const { playerAge, isBowling, oversBowled, isSprinting } = params;

  // Very rare event: ~0.5% per ball for bowlers, ~0.1% for batters
  let baseChance = isBowling ? 0.005 : 0.001;

  // Age increases risk
  if (playerAge > 34) baseChance *= 2.0;
  else if (playerAge > 30) baseChance *= 1.5;

  // Bowling workload increases risk
  if (isBowling && oversBowled > 3) baseChance *= 1.5;

  // Sprinting increases injury risk
  if (isSprinting) baseChance *= 2.0;

  if (Math.random() < baseChance) {
    // Determine injury type
    const types: [MatchInjuryType, number][] = [
      ["hamstring", 0.30],
      ["side-strain", 0.25],
      ["groin", 0.20],
      ["ankle", 0.15],
      ["finger", 0.08],
      ["concussion", 0.02],
    ];
    const rand = Math.random();
    let cum = 0;
    for (const [type, prob] of types) {
      cum += prob;
      if (rand < cum) return { injured: true, type };
    }
    return { injured: true, type: "hamstring" };
  }

  return null;
}

// ── Injury Responses ────────────────────────────────────────────────────

export type InjuryResponse =
  | "retired-hurt"       // Batter walks off, can potentially return later
  | "retired-out"        // Voluntary tactical retirement — batter cannot return
  | "concussion-sub"     // Like-for-like replacement from bench
  | "bowling-breakdown"  // Bowler can't continue, another bowler finishes over
  | "continues";         // Minor, player plays on

/** Determine the response to a mid-match injury */
export function determineInjuryResponse(injuryType: MatchInjuryType, isBatting: boolean): InjuryResponse {
  if (injuryType === "concussion") return "concussion-sub";

  if (isBatting) {
    // Batters: most injuries = retired hurt
    switch (injuryType) {
      case "hamstring":
      case "groin":
      case "ankle":
        return "retired-hurt";
      case "side-strain":
        return Math.random() < 0.5 ? "retired-hurt" : "continues";
      case "finger":
        return Math.random() < 0.3 ? "retired-hurt" : "continues";
      default:
        return "continues";
    }
  } else {
    // Bowlers: can't bowl = breakdown
    switch (injuryType) {
      case "hamstring":
      case "groin":
      case "side-strain":
        return "bowling-breakdown";
      case "ankle":
        return Math.random() < 0.7 ? "bowling-breakdown" : "continues";
      case "finger":
        return Math.random() < 0.4 ? "bowling-breakdown" : "continues";
      default:
        return "continues";
    }
  }
}

/** Check if a concussion sub is a valid like-for-like replacement.
 *  In IPL: batter replaced by batter, bowler by bowler, AR by AR. */
export function isLikeForLikeReplacement(
  injuredRole: string,
  replacementRole: string,
): boolean {
  // Strict like-for-like (IPL rules)
  if (injuredRole === replacementRole) return true;
  // Slight flexibility: AR can replace batter or bowler
  if (replacementRole === "all-rounder") return true;
  if (injuredRole === "all-rounder") return true;
  return false;
}

// ── Season Injury Replacement ───────────────────────────────────────────

/** When a player is ruled out for multiple games, determine replacement eligibility.
 *  Returns constraints for the replacement player. */
export function getReplacementConstraints(injuredPlayer: {
  isInternational: boolean;
  role: string;
  bid: number;
}): {
  mustBeInternational: boolean | null; // null = either is fine
  maxPrice: number; // replacement must be at or below this price
  preferredRole: string;
} {
  return {
    // Overseas replaced by overseas, domestic by domestic
    mustBeInternational: injuredPlayer.isInternational ? true : false,
    // Replacement in same price bracket (or lower)
    maxPrice: injuredPlayer.bid,
    preferredRole: injuredPlayer.role,
  };
}

// ── DRS System ──────────────────────────────────────────────────────────

export interface DRSResult {
  reviewed: boolean;
  overturned: boolean;
  umpiresCall: boolean; // True = umpire's call (review retained)
  reviewsRemaining: number;
}

/** Process a DRS review for a dismissal */
export function processDRSReview(params: {
  dismissalType: DismissalType;
  reviewsRemaining: number;
}): DRSResult {
  const { dismissalType, reviewsRemaining } = params;

  if (reviewsRemaining <= 0) {
    return { reviewed: false, overturned: false, umpiresCall: false, reviewsRemaining: 0 };
  }

  let overturnChance = 0;
  let umpiresCallChance = 0;

  switch (dismissalType) {
    case "lbw":
      overturnChance = 0.35;     // 35% fully overturned
      umpiresCallChance = 0.15;  // 15% umpire's call (retained)
      break;
    case "caught-behind":
      overturnChance = 0.30;
      umpiresCallChance = 0.05;
      break;
    case "stumped":
      overturnChance = 0.20;
      umpiresCallChance = 0.05;
      break;
    default:
      // Other dismissals not reviewable
      return { reviewed: false, overturned: false, umpiresCall: false, reviewsRemaining };
  }

  const rand = Math.random();
  if (rand < overturnChance) {
    // Overturned — batter survives, review retained
    return { reviewed: true, overturned: true, umpiresCall: false, reviewsRemaining };
  }
  if (rand < overturnChance + umpiresCallChance) {
    // Umpire's call — decision stands, review retained
    return { reviewed: true, overturned: false, umpiresCall: true, reviewsRemaining };
  }
  // Review unsuccessful — decision stands, review lost
  return { reviewed: true, overturned: false, umpiresCall: false, reviewsRemaining: reviewsRemaining - 1 };
}
