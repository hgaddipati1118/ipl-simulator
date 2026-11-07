/**
 * Incremental (ball-by-ball) match simulation for the live match viewer.
 *
 * Wraps the existing simulation logic from match.ts into a step-by-step API
 * so that each ball can be rendered individually in the UI.
 */

import { Player } from "./player.js";
import { Team, type BowlingPlan } from "./team.js";
import { clamp, weightedRandom } from "./math.js";
import { DEFAULT_RULES, type RuleSet } from "./rules.js";
import { runPostMatchInjuryChecks, type InjuryStatus } from "./injury.js";
import { createRNG, randomSeed, type RNG } from "./rng.js";
import { getVenueProfileForTeam, getLeagueChaseAdvantage, applyVenueProfile, applyChaseEdge, type VenueProfile } from "./venues.js";
import { stadiumRatingFor } from "./match.js";
import {
  type BattingHand,
  type BowlingStyle,
  decideTossChoice,
  getMatchPhase,
  getMatchupModifiers,
  isPaceBowler,
  isSpinBowler,
  type BoundarySize,
  type DewFactor,
  type MatchPhase,
  type PitchType,
} from "./matchups.js";
import { generateDeliveryCommentary } from "./commentary.js";
import {
  EXTRAS_RATE_CAL,
  trimRunningRuns,
  SUPER_OVER_CAL,
  applyFreeHitToProbs,
  bowlerRuns,
  batterFaced,
  dismissalText,
  expandDelivery,
  genderOf,
  retireParams,
  RETIRED_HURT_TEXT,
  type DeliveryDetail,
  type DismissalKind,
  type Gender,
} from "./delivery-rules.js";
import { describeDelivery, retiredHurtLine, retiredOutLine, superOverLine, timedOutLine } from "./delivery-text.js";
import { T20_FORMAT } from "./format.js";
import { commentarySeed } from "./commentary-model.js";
import {
  applyFieldingToProbs,
  battingLives,
  buildFieldingUnit,
  fieldingCommentary,
  resolveWicketChance,
  type FieldingNote,
  type FieldingUnit,
  type FielderLike,
} from "./fielding.js";
import { checkRainInterruption, calculateDLSTarget, canProduceResult, getRainDelayNarrative } from "./dls.js";
import { ruleOverrides } from "./dismissal-kinds.js";
import {
  applyGenderExtras,
  applyOverRatePenalty,
  applySpecialPlays,
  beamerSuspensionLine,
  bowlerInjuryLine,
  drawOverRatePenalty,
  overRateLine,
} from "./special-plays.js";
import {
  DRS_REVIEWS_PER_INNINGS,
  drsAtDismissal,
  drsAtDot,
  drsKindOf,
  drsText,
  reviewLost,
  userBattingReviewOfWicket,
  userFieldingReviewOfNotOut,
  type DrsKind,
  type DrsReview,
} from "./drs.js";
import type {
  BallOutcome,
  BallEvent,
  InningsScore,
  MatchResult,
  DetailedMatchResult,
  DetailedBallEvent,
  BatterInnings,
  BowlerFigures,
  InningsScorecard,
  ImpactSubEvent,
  MatchInjuryEvent,
} from "./match.js";

// Re-export the types the UI needs (PendingDecision/PendingDecisionOption defined locally below)
export type { BatterInnings, BowlerFigures, DetailedBallEvent };

/* ─────────────────── Field Settings ─────────────────── */

export type FieldSetting = "aggressive" | "standard" | "defensive" | "spin-attack" | "boundary-save";

const FIELD_MODIFIERS: Record<FieldSetting, Partial<Record<BallOutcome, number>>> = {
  aggressive:      { wicket: 1.20, "4": 1.15, "6": 1.10, dot: 0.90 },
  standard:        {},  // no modifiers
  defensive:       { wicket: 0.85, "4": 0.85, "6": 0.85, dot: 1.10, "1": 1.10 },
  "spin-attack":   { wicket: 1.25, "4": 1.10, dot: 0.95 },
  "boundary-save": { "6": 0.75, "4": 0.80, "1": 1.15, "2": 1.15 },
};

/* ─────────────────── Live-only Venue Nuance ─────────────────── */

const BOUNDARY_RUNNING_MODIFIERS: Record<BoundarySize, Partial<Record<BallOutcome, number>>> = {
  small: {},
  medium: {},
  large: { "2": 1.15, "3": 1.20 },
};

/** Dew mostly leaks into extras on top of the shared core matchup modifiers. */
const DEW_EXTRA_MODIFIERS: Record<DewFactor, Partial<Record<BallOutcome, number>>> = {
  none: {},
  moderate: { wide: 1.10 },
  heavy: { wide: 1.20 },
};

/* ─────────────────── MatchState ─────────────────── */

export interface LiveBatterStats {
  playerId: string;
  playerName: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  isOut: boolean;
  howOut: string;
  fallOfWicket?: string;
  /** Left the field hurt; not out, and may resume at a wicket */
  retiredHurt?: boolean;
}

/** One super over (a tied match is settled by one or more) */
export interface LiveSuperOver {
  round: number;
  battingTeamId: string;
  bowlingTeamId: string;
  runs: number;
  wickets: number;
  /** The three nominated batters, the bowler (ids) */
  batters: string[];
  bowler: string;
  /** Batters dismissed in this super over (they cannot be nominated in the next one) */
  out: string[];
  balls: DetailedBallEvent[];
}

export interface LiveBowlerStats {
  playerId: string;
  playerName: string;
  overs: number;
  balls: number; // legal deliveries in current over (0-5)
  runs: number;
  wickets: number;
  wides: number;
  noBalls: number;
  dots: number;
  maidens: number;
}

export type DrsReviewKind = "lbw" | "caught" | "wide" | "noball" | "runout";
export type DrsReviewingSide = "batting" | "bowling";
export type DrsOnFieldCall = "out" | "not_out" | "wide" | "not_wide" | "noball" | "not_noball" | "run_out" | "not_run_out";

export interface PendingDrsContext {
  batterName: string;
  bowlerName: string;
  reviewKind: DrsReviewKind;
  reviewingSide: DrsReviewingSide;
  onFieldCall: DrsOnFieldCall;
  isGivenOut: boolean;
  /** Hint for the UI: how confident the appeal looks (0-100). Higher = more likely to overturn. */
  confidence?: number;
  /** Short description of the appeal for the UI, e.g. "Pitched in line, hitting middle" */
  appealDescription?: string;
}

/** A pending tactical decision the user must resolve before the match continues. */
export interface PendingDecision {
  type: 'choose_bowler' | 'choose_batter' | 'impact_sub' | 'toss_decision' | 'drs_review' | 'retire_out' | 'strategic_timeout';
  /** Player IDs the user can pick from. For impact_sub, these are bench players who can come in.
   *  For toss_decision, options are ["bat", "bowl"]. For drs_review, options are ["review", "accept"]. */
  options: string[];
  /** For impact_sub, the playing XI player IDs who could be swapped out. */
  swapOutOptions?: string[];
  /** Extra info to help the UI: e.g. bowler figures, batter ratings. */
  optionDetails?: PendingDecisionOption[];
  /** Which team the decision is for (so UI can label it). */
  teamId: string;
  /** For drs_review: the batter who was given out / not out */
  drsContext?: PendingDrsContext;
  /** choose_bowler in the middle of an over: why the bowler left, and who he was */
  reason?: "injury" | "beamer";
  outgoingBowlerName?: string;
  /** choose_batter: the options that are retired-hurt batters who may resume (ids); "none" = nobody comes in, the innings ends */
  retiredHurtIds?: string[];
}

export interface PendingDecisionOption {
  playerId: string;
  playerName: string;
  role: string;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  /** For bowlers: current match figures */
  oversBowled?: number;
  oversRemaining?: number;
  runsConceded?: number;
  wicketsTaken?: number;
  economy?: number;
  dots?: number;
  /** Bowling style for bowler selection */
  bowlingStyle?: string;
  /** Batting hand */
  battingHand?: string;
  /** Granular bowling ratings */
  wicketTakingRating?: number;
  economyRating?: number;
  accuracyRating?: number;
  /** Granular batting ratings */
  battingIQRating?: number;
  timingRating?: number;
  powerRating?: number;
  /** True if this is a bench player (impact sub option) */
  isBench?: boolean;
}

export interface MatchState {
  // Teams
  homeTeam: { id: string; name: string; shortName: string; primaryColor: string; secondaryColor: string };
  awayTeam: { id: string; name: string; shortName: string; primaryColor: string; secondaryColor: string };

  // Current innings info
  innings: 1 | 2;
  overs: number;       // completed overs in this innings
  balls: number;       // legal deliveries in current over (0-5)
  score: number;
  wickets: number;
  extras: number;
  fours: number;
  sixes: number;
  target?: number;     // set after innings 1

  // Player indices into batting order
  strikerIdx: number;
  nonStrikerIdx: number;
  nextBatterIdx: number;
  currentBowlerIdx: number;

  // Player names for display
  strikerName: string;
  nonStrikerName: string;
  currentBowlerName: string;

  // The batting and bowling team for current innings
  battingTeamId: string;
  bowlingTeamId: string;

  // Ball log (all balls across both innings)
  ballLog: DetailedBallEvent[];
  // Innings-specific ball log for stats
  innings1BallLog: DetailedBallEvent[];
  innings2BallLog: DetailedBallEvent[];

  // Scorecard data accumulated so far
  batterStats: LiveBatterStats[];
  bowlerStats: LiveBowlerStats[];

  // Innings 1 data (set after innings break)
  innings1Scorecard?: InningsScorecard;
  innings1Score?: number;
  innings1Wickets?: number;
  innings1Overs?: string;

  // Fall of wickets
  fallOfWickets: string[];

  // Status
  status: "in_progress" | "innings_break" | "completed" | "waiting_for_decision";
  tossWinner: string;
  tossDecision: "bat" | "bowl";
  result?: string;
  winnerId?: string;
  manOfTheMatch?: { playerId: string; playerName: string; reason: string };
  injuries: MatchInjuryEvent[];

  // Tactical decision support
  pendingDecision?: PendingDecision;
  impactSubUsed: { home: boolean; away: boolean };

  // Aggression level per team (0=defensive, 50=normal, 100=all-out attack)
  aggression: { home: number; away: number };

  // Field placement setting per team
  fieldSetting: { home: FieldSetting; away: FieldSetting };

  // DRS reviews remaining per team (IPL 2026: 2 per innings)
  drsRemaining: { home: number; away: number };

  // Strategic timeouts (IPL: bowling team overs 6-9, batting team overs 13-16)
  strategicTimeouts: {
    home: { used: boolean; over?: number };
    away: { used: boolean; over?: number };
  };

  // Retired-out count (does NOT count as wickets)
  retiredOutCount?: number;

  /** The next ball is a free hit (after a no-ball; carries over a wide or no-ball bowled on a free hit) */
  freeHit?: boolean;

  /** This innings the bowling side is behind the over rate from this over (0-based) on: one fewer fielder outside the circle */
  overRatePenaltyFrom?: number;

  /** Super overs played to settle a tie, in order (absent = no tie) */
  superOvers?: LiveSuperOver[];

  // DLS rain delay info (set when rain interrupts play)
  maxOvers: number;               // current max overs for this innings (default 20, reduced by rain)
  rainDelay?: {
    oversLost: number;
    narrative: string;
    innings: 1 | 2;
    revisedTarget?: number;       // set only for 2nd innings rain
  };
  /** Whether rain has already been checked this innings (only once per innings) */
  rainChecked?: boolean;

  // Internal state (for serialization, not for UI display)
  _internal: MatchStateInternal;
}

/** Internal engine state not directly useful to the UI but needed for simulation continuity */
interface MatchStateInternal {
  matchId: string;
  rules: RuleSet;
  stadiumRating: number;

  // Seeded RNG for deterministic simulation
  seed: number;
  rng: RNG;
  /** The innings is over because no batter is left to bat (all out, or short of a partner after retirements) */
  allOut?: boolean;
  /** A new batter is owed but a review of the dismissal is still open */
  awaitingBatter?: { survivorIdx: number; newBatterFaces: boolean; swapAfter?: boolean };
  /** A line about a batter leaving (retired hurt / out, timed out) waiting to be added to the last ball's commentary */
  pendingNote?: string;
  /** The end-of-over change is owed once the batter owed by a review has been chosen */
  deferredOverSwap?: boolean;
  /** Batting-order indices of batters who retired hurt and may return at a wicket */
  retiredHurtIdx?: number[];
  /** A user's choose_batter with a retired-hurt option: the batting-order index the incoming batter's end was set to */
  batterSlotIdx?: number;
  /** Bowlers who left the field hurt (or were removed from the attack) this innings */
  unavailableBowlers?: string[];
  /** Beamers per bowler this innings (two remove him from the attack) */
  beamers?: Record<string, number>;
  /** The over-rate restriction has been announced this innings */
  overRateAnnounced?: boolean;
  /** Corpus commentary lines already used in this match (JSON-safe so it survives state cloning) */
  commentaryUsed?: Record<string, 1>;

  // Playing XIs (player IDs)
  homeXIIds: string[];
  awayXIIds: string[];

  // Batting order (player IDs in order)
  battingOrderIds: string[];
  bowlingOrderIds: string[];

  // Bowler over allocation
  bowlerOvers: Record<string, number>; // playerId -> overs bowled
  maxOversPerBowler: number;
  lastBowlerId: string | null;

  // Impact player tracking
  battingImpactUsed: boolean;
  bowlingImpactUsed: boolean;

  // Which team bats first
  battingFirstId: string;
  bowlingFirstId: string;

  // Innings 1 raw data (for final result building)
  innings1Raw?: InningsScoreRaw;

  // Current innings raw accumulator
  currentInningsRaw: InningsScoreRaw;

  // Full player roster data keyed by ID (serialized)
  playerDataMap: Record<string, SerializedPlayer>;

  // Over-level tracking
  currentOverLegalBalls: number;

  // Innings 2 batting/bowling orders (set after innings 1)
  innings2BattingOrderIds?: string[];
  innings2BowlingOrderIds?: string[];

  // User team ID (null for CPU vs CPU). When set, tactical decisions pause for user input.
  userTeamId: string | null;

  // Bench (impact sub) player IDs per team
  homeBenchIds: string[];
  awayBenchIds: string[];

  // Pitch conditions (from home team config)
  pitchType: "flat" | "seaming" | "turning" | "balanced";
  boundarySize: "small" | "medium" | "large";
  dewFactor: "none" | "moderate" | "heavy";
  /** Measured home-ground conditions (absent in states saved before measured venues) */
  venueProfile?: VenueProfile | null;
  /** P(chaser wins) - 0.5 for equal sides at this venue */
  chaseAdvantage?: number;

  // Phase-specific bowling plans per team
  homeBowlingPlan?: BowlingPlan;
  awayBowlingPlan?: BowlingPlan;

  // Per-player tactical presets (from lineup page)
  batterAggression?: Record<string, number>;
  bowlerFieldSettings?: Record<string, FieldSetting>;

  // Strategic timeout bonuses (temporary boosts from using a timeout)
  timeoutBonuses?: Record<string, {
    accuracyBoost?: number;
    economyBoost?: number;
    clutchBoost?: number;
    expiresAfterOver: number;
  }>;
}

interface InningsScoreRaw {
  teamId: string;
  runs: number;
  wickets: number;
  overs: number;
  balls: number;
  totalBalls: number;
  extras: number;
  fours: number;
  sixes: number;
  ballLog: BallEvent[];
  batterStats: Record<string, { runs: number; balls: number; fours: number; sixes: number; isOut: boolean }>;
  bowlerStats: Record<string, { overs: number; balls: number; runs: number; wickets: number; wides: number; noballs: number }>;
}

interface SerializedPlayer {
  id: string;
  name: string;
  role: string;
  isInternational: boolean;
  isWicketKeeper: boolean;
  bowlingStyle: BowlingStyle;
  battingHand: BattingHand;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  form: number; // rolling form 0-100, 50 = neutral
  ratings: {
    battingIQ: number;
    timing: number;
    power: number;
    running: number;
    wicketTaking: number;
    economy: number;
    accuracy: number;
    clutch: number;
  };
}

/* ─────────────────── Simulation helpers (extracted from match.ts) ─────────────────── */

const PHASE_MULTIPLIERS: Record<"powerplay" | "middle" | "death", Partial<Record<BallOutcome, number>>> = {
  powerplay: { dot: 0.80, "1": 1.0, "2": 0.9, "3": 1.0, "4": 1.35, "6": 1.2, wicket: 0.85, wide: 1.1, noball: 1.0 },
  middle:    { dot: 1.08, "1": 1.1, "2": 1.0, "3": 1.0, "4": 0.92, "6": 0.88, wicket: 1.0, wide: 0.9, noball: 1.0 },
  death:     { dot: 0.75, "1": 0.85, "2": 1.15, "3": 1.1, "4": 1.25, "6": 1.35, wicket: 1.15, wide: 1.2, noball: 1.1 },
};

/** Aggression: 0 = very defensive, 50 = normal, 100 = all-out attack.
 *  Higher aggression = more boundaries + more wickets (risk/reward). */
function baseOutcomeProbabilities(
  batter: SerializedPlayer,
  bowler: SerializedPlayer,
  aggression: number = 50,
): Record<BallOutcome, number> {
  const batRating = (batter.battingOvr + batter.ratings.timing) / 2 / 100;
  const bowlRating = (bowler.bowlingOvr + bowler.ratings.accuracy) / 2 / 100;
  const balance = batRating - bowlRating;

  // Aggression modifier: -0.5 (defensive) to +0.5 (aggressive)
  const aggrMod = (aggression - 50) / 100;

  // Form modifier: ranges from -0.10 (cold) to +0.10 (hot)
  const formMod = (batter.form - 50) / 500;

  // Base probabilities tuned to match IPL 2025:
  // IPL 2025: avg 1st innings ~178, 52 scores above 200, record boundaries
  // Target average team score: 175-185 (Impact Player era)
  const probs: Record<BallOutcome, number> = {
    dot:    clamp(0.30 - balance * 0.15 - aggrMod * 0.10, 0.12, 0.46),
    "1":    clamp(0.26 + balance * 0.03 - aggrMod * 0.03, 0.16, 0.35),
    "2":    clamp(0.06 + balance * 0.02, 0.02, 0.13),
    "3":    clamp(0.012, 0.005, 0.025),
    "4":    clamp(0.155 + balance * 0.07 + (batter.ratings.timing / 100) * 0.05 + aggrMod * 0.05, 0.06, 0.26),
    "6":    clamp(0.075 + balance * 0.06 + (batter.ratings.power / 100) * 0.06 + aggrMod * 0.05, 0.02, 0.22),
    wicket: clamp(0.042 - balance * 0.03 + (bowler.ratings.wicketTaking / 100) * 0.025 + aggrMod * 0.03, 0.01, 0.10),
    wide:   clamp(0.035 - (bowler.ratings.accuracy / 100) * 0.015, 0.01, 0.06) * EXTRAS_RATE_CAL.wide,
    noball:  clamp(0.006 - (bowler.ratings.accuracy / 100) * 0.003, 0.001, 0.02) * EXTRAS_RATE_CAL.noball,
    legbye: 0.015 * EXTRAS_RATE_CAL.legbye,
  };

  trimRunningRuns(probs);

  // Apply form modifier to boundary and wicket probabilities
  probs["4"] *= (1 + formMod);
  probs["6"] *= (1 + formMod);
  probs.wicket *= (1 - formMod); // hot form = fewer wickets, cold form = more

  return probs;
}

function chaseAdjustment(
  probs: Record<BallOutcome, number>,
  requiredRate: number,
  currentRate: number,
  wicketsDown: number,
): Record<BallOutcome, number> {
  // Cap pressure to prevent unrealistic six rates when stacking with death/clutch multipliers
  const pressure = clamp((requiredRate - currentRate) / 8, -1.5, 1.0);
  const wicketPressure = wicketsDown >= 7 ? 0.3 : wicketsDown >= 5 ? 0.15 : 0;

  const adjusted = { ...probs };
  if (pressure > 0) {
    adjusted["4"] *= 1 + pressure * 0.3;
    adjusted["6"] *= 1 + pressure * 0.4; // reduced from 0.5 to prevent six rate stacking
    adjusted.dot *= 1 - pressure * 0.2;
    adjusted.wicket *= 1 + pressure * 0.2 + wicketPressure;
  } else {
    // Easy chase: slow down more aggressively (real teams coast when ahead)
    adjusted.dot *= 1 + Math.abs(pressure) * 0.2;
    adjusted["1"] *= 1 + Math.abs(pressure) * 0.15;
    adjusted["4"] *= 1 - Math.abs(pressure) * 0.1;
    adjusted["6"] *= 1 - Math.abs(pressure) * 0.15;
    adjusted.wicket *= 1 - Math.abs(pressure) * 0.1;
  }

  return adjusted;
}

function randomBoundaryShot(runs: number, rng: RNG = Math.random): string {
  const fourShots = [
    "driven through covers", "cut past point", "flicked through midwicket",
    "punched through the off side", "pulled to deep square leg",
    "edged past the keeper", "swept fine", "driven down the ground",
    "glanced to fine leg", "slashed over point",
  ];
  const sixShots = [
    "launched over long-on", "smashed over midwicket", "slog-swept into the stands",
    "lifted over extra cover", "hoisted over cow corner", "clubbed over long-off",
    "deposited into the second tier", "sent sailing over the boundary",
    "reverse-swept for six", "pulled massively over deep square",
  ];
  const shots = runs === 6 ? sixShots : fourShots;
  return shots[Math.floor(rng() * shots.length)];
}

// generateCommentary removed -- replaced by imported generateBallCommentary from commentary.ts

function randomWicketType(rng: RNG = Math.random): "bowled" | "caught" | "lbw" | "run_out" | "stumped" {
  const r = rng();
  if (r < 0.55) return "caught";
  if (r < 0.75) return "bowled";
  if (r < 0.90) return "lbw";
  if (r < 0.97) return "run_out";
  return "stumped";
}

export function applyLiveBallContextModifiers(
  probs: Record<BallOutcome, number>,
  input: {
    batterBalls?: number;
    bowlerOversBowled?: number;
    bowlingStyle?: BowlingStyle;
    over?: number;
  },
): Record<BallOutcome, number> {
  const adjusted = { ...probs };
  const batterBalls = input.batterBalls ?? 0;
  const bowlerOversBowled = input.bowlerOversBowled ?? 0;

  if (batterBalls < 10) {
    adjusted.wicket *= 1.15;
    adjusted["4"] *= 0.92;
    adjusted["6"] *= 0.90;
  } else if (batterBalls >= 20) {
    const setBatterBonus = Math.min((batterBalls - 20) / 30, 0.15);
    adjusted.wicket *= 1 - 0.10 - setBatterBonus;
    adjusted["4"] *= 1 + 0.08 + setBatterBonus * 0.5;
    adjusted["6"] *= 1 + 0.06 + setBatterBonus * 0.5;
    adjusted.dot *= 0.95;
  }

  if (bowlerOversBowled >= 2 && input.bowlingStyle && isPaceBowler(input.bowlingStyle)) {
    const deathBonus = (input.over ?? 0) >= 16 ? 0.03 : 0;
    const fatiguePressure = Math.min(0.04 + Math.max(0, bowlerOversBowled - 2) * 0.03 + deathBonus, 0.12);
    adjusted.wicket *= 1 - fatiguePressure * 0.45;
    adjusted["4"] *= 1 + fatiguePressure * 0.55;
    adjusted["6"] *= 1 + fatiguePressure * 0.45;
    adjusted.wide *= 1 + fatiguePressure;
    adjusted.noball *= 1 + fatiguePressure * 1.1;
  }

  // Spinner fatigue: batters read them better in later overs (milder than pace fatigue)
  if (bowlerOversBowled >= 2 && input.bowlingStyle && isSpinBowler(input.bowlingStyle)) {
    const spinFatigue = Math.min(0.02 + Math.max(0, bowlerOversBowled - 2) * 0.02, 0.08);
    adjusted.wicket *= 1 - spinFatigue * 0.3;
    adjusted["4"] *= 1 + spinFatigue * 0.4;
    adjusted["6"] *= 1 + spinFatigue * 0.5;
  }

  return adjusted;
}

/** What the Laws add to a live ball: free hit, gender (fitted rates), substitute fielders */
interface LiveRulesCtx {
  freeHit: boolean;
  /** The slow over-rate restriction is on (one fewer fielder outside the circle) */
  overRatePenalty?: boolean;
  /** A super over: wickets come faster (SUPER_OVER_CAL) */
  superOver?: boolean;
  gender: Gender;
  bench: readonly FielderLike[];
  nonStrikerName?: string;
}

interface LiveBallResult {
  outcome: BallOutcome;
  runs: number;
  extras: number;
  isWicket: boolean;
  commentary: string;
  commentaryKey?: string;
  wicketType?: DismissalKind;
  fielderId?: string;
  fieldingNote?: FieldingNote;
  /** The complete delivery (extras by type, who is out, runs run ...). DRS may replace it. */
  detail: DeliveryDetail;
  fielderName?: string;
  fielder2Name?: string;
  /** A catch put down in the deep */
  deepChance?: boolean;
  /** The context needed to re-expand the delivery after a review changes its outcome */
  ctx: { gender: Gender; unit?: FieldingUnit };
}

function runOneBall(
  batter: SerializedPlayer,
  bowler: SerializedPlayer,
  over: number,
  isSecondInnings: boolean,
  target: number,
  currentScore: number,
  ballsRemaining: number,
  wicketsDown: number,
  stadiumBowlRating: number,
  aggression: number = 50,
  fieldSetting: FieldSetting = "standard",
  pitchType: PitchType = "balanced",
  boundarySize: BoundarySize = "medium",
  dewFactor: DewFactor = "none",
  batterRuns: number = 0,
  batterBalls: number = 0,
  legalBallInOver: number = 0,
  bowlerOversBowled: number = 0,
  rng: RNG = Math.random,
  isHomeBatting: boolean = false,
  isDayNight: boolean = true,
  venueProfile: VenueProfile | null = null,
  chaseAdvantage: number | undefined = undefined,
  fieldingUnit?: FieldingUnit,
  commentaryCtx?: { gender?: "male" | "female"; nonStrikerName?: string; usedLines?: Readonly<Record<string, unknown>> },
  rulesCtx: LiveRulesCtx = { freeHit: false, gender: "male", bench: [], nonStrikerName: undefined },
): LiveBallResult {
  let probs = baseOutcomeProbabilities(batter, bowler, aggression);
  // Women's cricket has its own wide / no-ball / bye rates
  applyGenderExtras(probs, rulesCtx.gender);
  const nbf = ruleOverrides().noBallRateFactor;
  if (nbf !== undefined) probs.noball *= nbf;

  // Phase adjustment
  const phase = getMatchPhase(over);
  const phaseMult = PHASE_MULTIPLIERS[phase];
  for (const key of Object.keys(probs) as BallOutcome[]) {
    probs[key] *= phaseMult[key] ?? 1;
  }

  // Stadium bowling adjustment — bowl-friendly grounds increase wickets/dots, reduce boundaries
  // Dampened by 50% to keep IPL 2025 scoring levels: stadiums affect feel, not dominate scoring
  const stadiumEffect = 1 + (stadiumBowlRating - 1) * 0.5; // e.g. 1.12 -> 1.06
  probs.wicket *= stadiumEffect;
  probs.dot *= stadiumEffect;
  probs["4"] *= (2 - stadiumEffect);
  probs["6"] *= (2 - stadiumEffect);

  // Measured ground: run / six / wicket factors and bowler-type edges; chase edge in innings 2
  if (venueProfile) applyVenueProfile(probs, venueProfile, bowler.bowlingStyle);
  if (isSecondInnings && chaseAdvantage !== undefined) applyChaseEdge(probs, chaseAdvantage);

  // Ball change rule (IPL 2026): bowling team can request ball change after over 10 in 2nd innings
  // Addresses dew — replacement ball has similar wear but is drier, helping pace bowlers grip
  if (isSecondInnings && over >= 10 && isPaceBowler(bowler.bowlingStyle)) {
    probs.wicket *= 1.08; // 8% more wickets (drier ball = better grip)
    probs["4"] *= 0.95;   // slightly harder to time
    probs.dot *= 1.04;    // more dots due to better control
  }

  // Shared core matchup + venue adjustment
  const matchupMods = getMatchupModifiers({
    bowlingStyle: bowler.bowlingStyle,
    battingHand: batter.battingHand,
    over,
    pitchType,
    boundarySize,
    dewFactor,
    isSecondInnings,
    measuredVenue: !!venueProfile,
  });
  probs.wicket *= matchupMods.wicketMod;
  probs["4"] *= matchupMods.fourMod;
  probs["6"] *= matchupMods.sixMod;
  probs.dot *= matchupMods.dotMod;

  // Live mode keeps a little extra venue nuance for running and wides.
  const boundaryRunningMod = BOUNDARY_RUNNING_MODIFIERS[boundarySize];
  for (const key of Object.keys(boundaryRunningMod) as BallOutcome[]) {
    probs[key] *= boundaryRunningMod[key] ?? 1;
  }

  if (isSecondInnings) {
    const dewExtraMod = DEW_EXTRA_MODIFIERS[dewFactor];
    for (const key of Object.keys(dewExtraMod) as BallOutcome[]) {
      probs[key] *= dewExtraMod[key] ?? 1;
    }
  }

  // Field placement adjustment
  const fieldMod = FIELD_MODIFIERS[fieldSetting];
  for (const key of Object.keys(fieldMod) as BallOutcome[]) {
    probs[key] *= fieldMod[key] ?? 1;
  }

  // Chase context
  if (isSecondInnings && ballsRemaining > 0) {
    const requiredRate = ((target - currentScore) / ballsRemaining) * 6;
    const currentRate = ballsRemaining < 120
      ? (currentScore / (120 - ballsRemaining)) * 6
      : 0;
    probs = chaseAdjustment(probs, requiredRate, currentRate, wicketsDown);
  }

  // Clutch factor for last 3 overs in close games
  if (over >= 17 && isSecondInnings) {
    const runsNeeded = target - currentScore;
    if (runsNeeded > 0 && runsNeeded <= 30) {
      const clutchBalance = (batter.ratings.clutch - bowler.ratings.clutch) / 100;
      probs["6"] *= 1 + clutchBalance * 0.3;
      probs["4"] *= 1 + clutchBalance * 0.2;
      probs.wicket *= 1 - clutchBalance * 0.2;
    }
  }

  probs = applyLiveBallContextModifiers(probs, {
    batterBalls,
    bowlerOversBowled,
    bowlingStyle: bowler.bowlingStyle,
    over,
  });

  // ── Home field advantage ──
  // Home team gets a small boost: +3% boundaries, -3% wickets (crowd support, familiar conditions)
  if (isHomeBatting) {
    probs["4"] *= 1.03;
    probs["6"] *= 1.03;
    probs.wicket *= 0.97;
  }

  // ── Day/Night modifier ──
  // Day-night matches: batting second under lights is slightly easier (dew already handled above)
  // Day games: pitch deteriorates more (slightly harder batting in 2nd innings)
  if (!isDayNight && isSecondInnings) {
    // Pure day game, 2nd innings on worn pitch
    probs.wicket *= 1.03;
    probs["4"] *= 0.97;
  }

  // IPL 2025 scoring era boost: compensate for stacked defensive modifiers
  // IPL 2025 avg 1st innings ~178, most boundary-heavy season ever
  probs["4"] *= 1.12;
  probs["6"] *= 1.15;
  probs.dot *= 0.92;
  probs.wicket *= 0.95;

  if (rulesCtx.superOver) { probs.wicket *= SUPER_OVER_CAL.wicket; probs["4"] *= SUPER_OVER_CAL.boundary; probs["6"] *= SUPER_OVER_CAL.boundary; }

  // Slow over rate: one fewer fielder outside the circle, so more boundaries
  if (rulesCtx.overRatePenalty) applyOverRatePenalty(probs);

  // A free hit: boundaries come easier and only the run-out family can dismiss
  if (rulesCtx.freeHit) applyFreeHitToProbs(probs);

  // Fielding: runs saved, byes, and dismissal chances (catches / stumpings / run-outs are converted or put down)
  applyFieldingToProbs(probs, fieldingUnit, bowler.bowlingStyle, rulesCtx.gender);

  // Normalize and sample
  const entries = Object.entries(probs) as [BallOutcome, number][];
  const forced = ruleOverrides().forceOutcomeSparesSuperOver && rulesCtx.superOver ? undefined : ruleOverrides().forceCoarseOutcome;
  let outcome = forced ?? weightedRandom(entries, rng);

  // A wicket draw is a dismissal chance: its kind, who was involved, and whether it was taken
  let resolution: ReturnType<typeof resolveWicketChance> | undefined;
  if (outcome === "wicket") {
    resolution = resolveWicketChance(fieldingUnit, bowler.id, bowler.bowlingStyle, probs, rng, {
      gender: rulesCtx.gender, freeHit: rulesCtx.freeHit, bench: rulesCtx.bench,
    });
    if (resolution.outcome !== "wicket") outcome = resolution.outcome;
  }

  // The complete delivery: wides, no-ball cost, byes, overthrows, who is out, how far they ran
  const detail = expandDelivery(outcome, resolution, {
    rng, fmt: T20_FORMAT, gender: rulesCtx.gender, freeHit: rulesCtx.freeHit,
    bowlerId: bowler.id, bowlerStyle: bowler.bowlingStyle, unit: fieldingUnit, bench: rulesCtx.bench,
  });
  // Rare plays: short runs, misfields, sixes saved on the rope, boundary catches, no-ball and penalty reasons, lodged balls
  applySpecialPlays(detail, { rng, unit: fieldingUnit, bowlerId: bowler.id, resolution, labelsOnly: !!resolution?.note && !detail.dismissal });
  const dis = detail.dismissal;
  const runs = detail.batRuns;
  const isWicket = !!dis;
  const wicketType = dis?.kind;

  const nameOf = (id?: string) => {
    if (!id) return undefined;
    if (resolution?.fielder?.id === id) return resolution.fielder.name;
    if (resolution?.fielder2?.id === id) return resolution.fielder2.name;
    return undefined;
  };
  const unitName = (id?: string) => (id ? fieldingUnit?.fielders.find(p => p.id === id)?.name : undefined);
  const fielderName = nameOf(dis?.fielderId) ?? unitName(dis?.fielderId);
  const fielder2Name = nameOf(dis?.fielder2Id) ?? unitName(detail.relayFielderId);
  const playFielderName = unitName(detail.sixSaved?.fielderId ?? detail.misfield?.fielderId);

  // Generate rich contextual commentary. It runs on its own seeded stream (derived from the ball's context), so
  // wording never changes how the match plays out, whether or not the corpus model is loaded.
  const commentaryRng = createRNG(commentarySeed(batter.id, bowler.id, over, legalBallInOver, currentScore, wicketsDown, batterRuns, batterBalls, outcome));
  // Every delivery (dismissal kinds, extras, free hits ...) goes through one entry point: corpus line where it has a fit, hand-written otherwise
  const generated = generateDeliveryCommentary({
    detail, bowlerName: bowler.name, batterName: batter.name,
    nonStrikerName: commentaryCtx?.nonStrikerName ?? rulesCtx.nonStrikerName, fielderName: fielderName ?? playFielderName, fielder2Name,
    substitute: dis?.substitute, freeHit: rulesCtx.freeHit,
    over, ball: legalBallInOver + 1, score: currentScore, wickets: wicketsDown, isSecondInnings,
    target: isSecondInnings ? target : undefined, bowlingStyle: bowler.bowlingStyle, battingHand: batter.battingHand,
    gender: commentaryCtx?.gender, batterRuns, batterBalls,
    boundaryShot: (outcome === "4" || outcome === "6") ? randomBoundaryShot(runs || (outcome === "4" ? 4 : 6), commentaryRng) : undefined,
    rng: commentaryRng, usedLines: commentaryCtx?.usedLines,
  });
  const commentary = generated.text;
  const commentaryKey = generated.key;

  // A fielding note replaces the line only where it says the right thing (those lines know only the striker, one fielder, no free hit)
  const noteFits = !isWicket || (dis!.out === "striker" && detail.outcome === "wicket" && !dis!.substitute && !dis!.fielder2Id && (dis!.kind === "caught" || dis!.kind === "run_out"));
  let fieldingLine = resolution?.note && noteFits ? fieldingCommentary(resolution, { batter: batter.name, bowler: bowler.name, runs }, rng) : undefined;
  if (fieldingLine && rulesCtx.freeHit && !fieldingLine.startsWith("FREE HIT")) fieldingLine = "FREE HIT! " + fieldingLine;

  return {
    outcome: isWicket && outcome !== "wide" && outcome !== "noball" ? "wicket" : outcome,
    runs, extras: detail.extras, isWicket,
    commentary: fieldingLine ?? commentary,
    commentaryKey: fieldingLine ? undefined : commentaryKey,
    wicketType,
    fielderId: dis?.fielderId ?? (resolution?.fielder && resolution.note ? resolution.fielder.id : undefined) ?? detail.misfield?.fielderId ?? detail.sixSaved?.fielderId,
    fieldingNote: resolution?.note ?? (detail.misfield ? "misfield" : detail.sixSaved ? "six_saved" : undefined),
    deepChance: !dis && !!resolution?.deep,
    detail,
    fielderName,
    fielder2Name,
    ctx: { gender: rulesCtx.gender, unit: fieldingUnit },
  };
}

/* (which deliveries the corpus covers and which use hand-written lines is decided in commentary.ts generateDeliveryCommentary) */

/* ─────────────────── Serialization helpers ─────────────────── */

function serializePlayer(p: Player): SerializedPlayer {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    isInternational: p.isInternational,
    isWicketKeeper: p.isWicketKeeper,
    bowlingStyle: p.bowlingStyle,
    battingHand: p.battingHand,
    battingOvr: p.battingOvr,
    bowlingOvr: p.bowlingOvr,
    overall: p.overall,
    form: p.form,
    ratings: { ...p.ratings },
  };
}

function emptyInningsRaw(teamId: string): InningsScoreRaw {
  return {
    teamId,
    runs: 0,
    wickets: 0,
    overs: 0,
    balls: 0,
    totalBalls: 0,
    extras: 0,
    fours: 0,
    sixes: 0,
    ballLog: [],
    batterStats: {},
    bowlerStats: {},
  };
}

/** Clone a MatchState, preserving the RNG function reference (not serializable by JSON) */
function cloneState(state: MatchState): MatchState {
  const cloned: MatchState = JSON.parse(JSON.stringify(state));
  cloned._internal.rng = state._internal.rng;
  return cloned;
}

/* ─────────────────── Public API ─────────────────── */

let liveMatchCounter = 1000;

/**
 * Create a new match state ready for ball-by-ball simulation.
 * @param userTeamId - The user's team ID, or null for CPU-vs-CPU matches.
 *   When provided, the engine will pause for tactical decisions on the user's team.
 * @param seed - Optional RNG seed for deterministic simulation. If not provided, a random seed is generated.
 */
export function createMatchState(
  homeTeam: Team,
  awayTeam: Team,
  rules: RuleSet = DEFAULT_RULES,
  userTeamId: string | null = null,
  seed?: number,
): MatchState {
  const matchId = `live_match_${++liveMatchCounter}`;
  const matchSeed = seed ?? randomSeed();
  const rng = createRNG(matchSeed);

  const homeXI = homeTeam.getPlayingXI(rules.maxOverseasInXI);
  const awayXI = awayTeam.getPlayingXI(rules.maxOverseasInXI);

  // Pitch conditions from home team
  const pitchType = homeTeam.config.pitchType ?? "balanced";
  const boundarySize = homeTeam.config.boundarySize ?? "medium";
  const dewFactor = homeTeam.config.dewFactor ?? "none";

  // Toss
  const tossWinner = rng() < 0.5 ? homeTeam : awayTeam;
  const isUserTossWinner = userTeamId !== null && tossWinner.id === userTeamId;

  const venueProfile = getVenueProfileForTeam(homeTeam.config.venueTeamId ?? homeTeam.id);
  const chaseAdvantage = venueProfile?.chaseAdvantage ?? getLeagueChaseAdvantage(rules.league, rules.gender);

  // CPU toss decision: follow the ground's measured chase advantage
  const tossDecision: "bat" | "bowl" = isUserTossWinner
    ? "bowl"
    : decideTossChoice({ pitchType, dewFactor, chaseAdvantage: venueProfile ? chaseAdvantage : undefined, rng });

  const battingFirst = tossDecision === "bat" ? tossWinner : (tossWinner === homeTeam ? awayTeam : homeTeam);
  const bowlingFirst = battingFirst === homeTeam ? awayTeam : homeTeam;

  const stadiumRating = stadiumRatingFor(homeTeam, venueProfile) * (2 - rules.scoringMultiplier);

  const firstXI = battingFirst === homeTeam ? homeXI : awayXI;
  const firstBowlXI = battingFirst === homeTeam ? awayXI : homeXI;

  const battingOrder = battingFirst.getBattingOrder(firstXI);
  const bowlingOrder = bowlingFirst.getBowlingOrder(firstBowlXI);

  // Build player data map
  const playerDataMap: Record<string, SerializedPlayer> = {};
  for (const p of [...homeTeam.roster, ...awayTeam.roster]) {
    playerDataMap[p.id] = serializePlayer(p);
  }

  // Initialize batter stats
  const batterStats: LiveBatterStats[] = battingOrder.slice(0, 2).map(p => ({
    playerId: p.id,
    playerName: p.name,
    runs: 0,
    balls: 0,
    fours: 0,
    sixes: 0,
    isOut: false,
    howOut: "not out",
  }));

  const bowlerOvers: Record<string, number> = {};
  for (const b of bowlingOrder) bowlerOvers[b.id] = 0;

  // Pick first bowler
  const firstBowler = bowlingOrder[0];

  const firstBowlerStats: LiveBowlerStats = {
    playerId: firstBowler.id,
    playerName: firstBowler.name,
    overs: 0,
    balls: 0,
    runs: 0,
    wickets: 0,
    wides: 0,
    noBalls: 0,
    dots: 0,
    maidens: 0,
  };

  // Build raw innings
  const currentInningsRaw = emptyInningsRaw(battingFirst.id);
  for (const p of battingOrder) {
    currentInningsRaw.batterStats[p.id] = { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false };
  }

  // Bench (impact sub) players
  const homeBenchIds = rules.impactPlayer ? homeTeam.getImpactSubs(homeXI).map(p => p.id) : [];
  const awayBenchIds = rules.impactPlayer ? awayTeam.getImpactSubs(awayXI).map(p => p.id) : [];

  // Make sure bench players are in the player data map
  for (const p of [...homeTeam.getImpactSubs(homeXI), ...awayTeam.getImpactSubs(awayXI)]) {
    if (!playerDataMap[p.id]) playerDataMap[p.id] = serializePlayer(p);
  }

  // Second innings orders (computed now for later use)
  const secondXI = bowlingFirst === homeTeam ? homeXI : awayXI;
  const secondBowlXI = bowlingFirst === homeTeam ? awayXI : homeXI;
  const inn2BattingOrder = bowlingFirst.getBattingOrder(secondXI);
  const inn2BowlingOrder = battingFirst.getBowlingOrder(secondBowlXI);

  // Build bowling plans: use user's plan if set, otherwise auto-generate based on bowling style
  const homeBowlingPlan = homeTeam.getBowlingPlan() ?? autoGenerateBowlingPlan(homeXI, playerDataMap);
  const awayBowlingPlan = awayTeam.getBowlingPlan() ?? autoGenerateBowlingPlan(awayXI, playerDataMap);

  // If user wins the toss, pause for their decision
  const initialStatus: MatchState["status"] = isUserTossWinner ? "waiting_for_decision" : "in_progress";
  const pendingDecision: PendingDecision | undefined = isUserTossWinner ? {
    type: "toss_decision",
    options: ["bat", "bowl"],
    teamId: tossWinner.id,
  } : undefined;

  return {
    homeTeam: {
      id: homeTeam.id,
      name: homeTeam.name,
      shortName: homeTeam.shortName,
      primaryColor: homeTeam.config.primaryColor,
      secondaryColor: homeTeam.config.secondaryColor,
    },
    awayTeam: {
      id: awayTeam.id,
      name: awayTeam.name,
      shortName: awayTeam.shortName,
      primaryColor: awayTeam.config.primaryColor,
      secondaryColor: awayTeam.config.secondaryColor,
    },

    innings: 1,
    overs: 0,
    balls: 0,
    score: 0,
    wickets: 0,
    extras: 0,
    fours: 0,
    sixes: 0,

    strikerIdx: 0,
    nonStrikerIdx: 1,
    nextBatterIdx: 2,
    currentBowlerIdx: 0,

    strikerName: battingOrder[0].name,
    nonStrikerName: battingOrder[1].name,
    currentBowlerName: firstBowler.name,

    battingTeamId: battingFirst.id,
    bowlingTeamId: bowlingFirst.id,

    ballLog: [],
    innings1BallLog: [],
    innings2BallLog: [],

    batterStats,
    bowlerStats: [firstBowlerStats],

    fallOfWickets: [],

    status: initialStatus,
    tossWinner: tossWinner.name,
    tossDecision,
    injuries: [],
    pendingDecision,
    impactSubUsed: { home: false, away: false },
    aggression: { home: 50, away: 50 },
    fieldSetting: { home: "standard", away: "standard" },
    drsRemaining: { home: 2, away: 2 }, // IPL 2026: 2 reviews per team per innings
    strategicTimeouts: {
      home: { used: false },
      away: { used: false },
    },
    maxOvers: 20,
    rainChecked: false,
    ...(() => { const f = drawOverRatePenalty(rng, 20); return f >= 0 ? { overRatePenaltyFrom: f } : {}; })(),

    _internal: {
      matchId,
      rules,
      stadiumRating,
      seed: matchSeed,
      rng,
      homeXIIds: homeXI.map(p => p.id),
      awayXIIds: awayXI.map(p => p.id),
      battingOrderIds: battingOrder.map(p => p.id),
      bowlingOrderIds: bowlingOrder.map(p => p.id),
      bowlerOvers,
      maxOversPerBowler: 4,
      lastBowlerId: null,
      battingImpactUsed: false,
      bowlingImpactUsed: false,
      battingFirstId: battingFirst.id,
      bowlingFirstId: bowlingFirst.id,
      currentInningsRaw,
      playerDataMap,
      currentOverLegalBalls: 0,
      innings2BattingOrderIds: inn2BattingOrder.map(p => p.id),
      innings2BowlingOrderIds: inn2BowlingOrder.map(p => p.id),
      userTeamId,
      homeBenchIds,
      awayBenchIds,
      pitchType,
      boundarySize,
      dewFactor,
      venueProfile,
      chaseAdvantage,
      homeBowlingPlan,
      awayBowlingPlan,
      batterAggression: { ...homeTeam.batterAggression, ...awayTeam.batterAggression },
      bowlerFieldSettings: { ...homeTeam.bowlerFieldSettings, ...awayTeam.bowlerFieldSettings },
    },
  };
}

/** Auto-generate a bowling plan for CPU teams based on bowling styles.
 *  Pace bowlers assigned to powerplay + death, spinners to middle overs. */
function autoGenerateBowlingPlan(
  xi: Player[],
  pm: Record<string, SerializedPlayer>,
): BowlingPlan {
  const bowlers = xi.filter(p => p.role === "bowler" || p.role === "all-rounder");
  const paceIds: string[] = [];
  const spinIds: string[] = [];

  for (const b of bowlers) {
    const sp = pm[b.id];
    if (sp && isPaceBowler(sp.bowlingStyle as any)) {
      paceIds.push(b.id);
    } else if (sp && isSpinBowler(sp.bowlingStyle as any)) {
      spinIds.push(b.id);
    } else {
      // Unknown style: assign to pace by default
      paceIds.push(b.id);
    }
  }

  return {
    powerplay: paceIds.length > 0 ? paceIds : spinIds.slice(0, 2),
    middle: spinIds.length > 0 ? spinIds : paceIds.slice(0, 2),
    death: paceIds.length > 0 ? paceIds : spinIds.slice(0, 2),
  };
}

/**
 * Simulate exactly ONE ball. Returns the updated state and the ball event.
 * If the state has a pending decision (waiting_for_decision status), you must
 * call applyDecision() first before stepping another ball.
 */
export function stepBall(state: MatchState): { state: MatchState; ball: DetailedBallEvent } {
  if (state.status === "waiting_for_decision") {
    throw new Error("Cannot step ball: a tactical decision is pending. Call applyDecision() first.");
  }
  if (state.status !== "in_progress") {
    throw new Error("Cannot step ball: match is not in progress");
  }

  const int = state._internal;
  const pm = int.playerDataMap;
  const isSecondInnings = state.innings === 2;
  const maxOvers = state.maxOvers;

  // Get current players
  const strikerId = int.battingOrderIds[state.strikerIdx];
  let bowlerId = int.bowlingOrderIds[state.currentBowlerIdx];

  // Safety: if current bowler has hit max overs or is bowling consecutive overs, auto-swap
  const bowlerOversSoFar = int.bowlerOvers[bowlerId] ?? 0;
  if (bowlerOversSoFar >= int.maxOversPerBowler || (int.currentOverLegalBalls === 0 && bowlerId === int.lastBowlerId)) {
    ensureFreshBowlerOption(state, int);
    const nextIdx = pickNextBowler(int.bowlingOrderIds, int.bowlerOvers, int.maxOversPerBowler, int.lastBowlerId, pm, undefined, state.overs);
    assignNextBowler(state, int, pm, nextIdx);
    bowlerId = int.bowlingOrderIds[state.currentBowlerIdx];
  }

  const rp = retireParams();
  const rulesGender: Gender = genderOf(int.rules);

  // (A bowler leaving mid-over, hurt or removed for two beamers, is handled after the ball: bowlerLeavesMidOver)

  // Mankad: the bowler runs out the non-striker before delivering. No ball is bowled.
  if (int.rng() < rp.mankadPerDelivery && state.wickets < 9) {
    return stepMankad(state, bowlerId);
  }

  const striker = pm[strikerId];
  const bowler = pm[bowlerId];

  const ballsRemaining = (maxOvers - state.overs) * 6 - int.currentOverLegalBalls;
  const target = state.target ?? 0;

  // Run the ball
  const battingTeamAggression = state.battingTeamId === state.homeTeam.id
    ? state.aggression.home : state.aggression.away;
  const bowlingTeamFieldSetting = state.bowlingTeamId === state.homeTeam.id
    ? state.fieldSetting.home : state.fieldSetting.away;
  // Look up current batter stats for commentary milestones
  const liveBatterPre = state.batterStats.find(b => b.playerId === strikerId);
  const batterRunsPre = liveBatterPre?.runs ?? 0;
  const batterBallsPre = liveBatterPre?.balls ?? 0;

  const rng = int.rng;

  // The side in the field, for catches, stumpings, run-outs, runs saved and byes (fielding.ts)
  const bowlingXIIdsNow = state.bowlingTeamId === state.homeTeam.id ? int.homeXIIds : int.awayXIIds;
  const fieldingUnit = buildFieldingUnit(
    bowlingXIIdsNow
      .map(id => pm[id])
      .filter((p): p is SerializedPlayer => !!p) as FielderLike[],
  );
  // Substitute fielders: squad players who are not in the XI
  const benchPool = (state.bowlingTeamId === state.homeTeam.id ? int.homeBenchIds : int.awayBenchIds)
    .map(id => pm[id]).filter((p): p is SerializedPlayer => !!p) as FielderLike[];
  const freeHitNow = !!state.freeHit;

  // Apply strategic timeout bonuses (temporary rating boosts)
  let effectiveStriker = striker;
  let effectiveBowler = bowler;
  if (int.timeoutBonuses) {
    const strikerBonus = int.timeoutBonuses[strikerId];
    if (strikerBonus && state.overs < strikerBonus.expiresAfterOver) {
      effectiveStriker = { ...striker, ratings: { ...striker.ratings, clutch: Math.min(99, striker.ratings.clutch + (strikerBonus.clutchBoost ?? 0)) } };
    }
    const bowlerBonus = int.timeoutBonuses[bowlerId];
    if (bowlerBonus && state.overs < bowlerBonus.expiresAfterOver) {
      effectiveBowler = { ...bowler, ratings: { ...bowler.ratings, accuracy: Math.min(99, bowler.ratings.accuracy + (bowlerBonus.accuracyBoost ?? 0)), economy: Math.min(99, bowler.ratings.economy + (bowlerBonus.economyBoost ?? 0)) } };
    }
  }

  const overRateOn = state.overRatePenaltyFrom !== undefined && state.overs >= state.overRatePenaltyFrom;
  const result = runOneBall(
    effectiveStriker,
    effectiveBowler,
    state.overs,
    isSecondInnings,
    target,
    state.score,
    ballsRemaining,
    state.wickets,
    int.stadiumRating,
    battingTeamAggression,
    bowlingTeamFieldSetting,
    int.pitchType,
    int.boundarySize,
    int.dewFactor,
    batterRunsPre,
    batterBallsPre,
    int.currentOverLegalBalls,
    int.bowlerOvers[bowlerId] ?? 0,
    rng,
    state.battingTeamId === state.homeTeam.id, // isHomeBatting
    true, // isDayNight (all IPL matches are day-night)
    int.venueProfile ?? null,
    int.chaseAdvantage,
    fieldingUnit,
    {
      gender: int.rules.gender === "women" ? "female" : "male",
      nonStrikerName: pm[int.battingOrderIds[state.nonStrikerIdx]]?.name,
      usedLines: int.commentaryUsed,
    },
    {
      freeHit: freeHitNow, gender: rulesGender, bench: benchPool, nonStrikerName: pm[int.battingOrderIds[state.nonStrikerIdx]]?.name,
      overRatePenalty: overRateOn,
    },
  );
  if (overRateOn && !int.overRateAnnounced) {
    result.commentary = `${overRateLine(state.bowlingTeamId === state.homeTeam.id ? state.homeTeam.name : state.awayTeam.name)} ${result.commentary}`;
  }

  // Clone state for mutation
  const newState = cloneState(state);
  const ni = newState._internal;
  const rawInnings = ni.currentInningsRaw;
  if (overRateOn) ni.overRateAnnounced = true;
  // remember which corpus line this ball used so the same line is not repeated in this match
  if (result.commentaryKey) (ni.commentaryUsed ??= {})[result.commentaryKey] = 1;

  // Build the detailed ball event for the UI
  let eventType: DetailedBallEvent["eventType"];
  switch (result.outcome) {
    case "dot": eventType = "dot"; break;
    case "1": eventType = "single"; break;
    case "2": eventType = "double"; break;
    case "3": eventType = "triple"; break;
    case "4": eventType = "four"; break;
    case "6": eventType = "six"; break;
    case "wicket": eventType = "wicket"; break;
    case "wide": eventType = "wide"; break;
    case "noball": eventType = "noball"; break;
    case "legbye": eventType = "legbye"; break;
    default: eventType = "dot";
  }

  let wicketType: DetailedBallEvent["wicketType"] = result.wicketType;
  let fielderName: string | undefined;
  let drsOverturned = false;
  // For DRS user review: store whether the review should overturn, and if marginal (umpire's call)
  let _drsOverturns: boolean | undefined;
  let _drsMarginal: boolean | undefined;
  /** lbw / caught behind: the kind under review, a user batting review's hidden answer, a CPU review that happened */
  let _drsKind: DrsKind | undefined;
  let _drsResult: DrsReview["result"] | undefined;
  let _drsFielderId: string | undefined;
  let _drsReview: DrsReview | undefined;
  const canOfferNonLbwReview = int.currentOverLegalBalls < 5;
  /** A review changes the call, so the delivery is built again for the new outcome */
  const redo = (outcome: BallOutcome, res?: { outcome: "wicket"; kind: DismissalKind }) => {
    const d = expandDelivery(outcome as DeliveryDetail["outcome"], res as any, {
      rng, fmt: T20_FORMAT, gender: rulesGender, freeHit: freeHitNow, bowlerId: bowler.id,
      bowlerStyle: bowler.bowlingStyle, unit: fieldingUnit, bench: benchPool,
    });
    result.detail = d;
    result.outcome = d.dismissal && d.outcome !== "wide" && d.outcome !== "noball" ? "wicket" : d.outcome;
    result.runs = d.batRuns;
    result.extras = d.extras;
    result.isWicket = !!d.dismissal;
    result.wicketType = d.dismissal?.kind;
  };
  /** Only a plain wide or no-ball (one extra, nothing off the bat) can be reviewed with the old amend-the-counters flow */
  const simpleExtra = (d: DeliveryDetail) =>
    !d.dismissal && !d.penalty && !d.overthrow && ((d.outcome === "wide" && d.wides === 1) || (d.outcome === "noball" && d.noBalls === 1 && d.batRuns === 0 && d.byes === 0 && d.legByes === 0));

  if (result.isWicket) {
    if (result.fielderId && pm[result.fielderId]) {
      // The fielder who took the catch / made the stumping / threw at the stumps (decided with the chance)
      fielderName = pm[result.fielderId].name;
    } else if (wicketType === "caught") {
      // Pick a random bowler-side player name
      const bowlingTeamIds = isSecondInnings
        ? (ni.battingFirstId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds)
        : (ni.bowlingFirstId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds);
      const fielders = bowlingTeamIds.filter(id => id !== bowlerId);
      const fielderId = fielders[Math.floor(rng() * fielders.length)];
      fielderName = pm[fielderId]?.name ?? "fielder";
    }

    // DRS for lbw and caught behind (drs.ts): the batting side reviews out decisions, the fielding side not-outs
    const drsK = !freeHitNow && result.detail.outcome === "wicket"
      ? drsKindOf(wicketType, !!fieldingUnit.keeper && result.fielderId === fieldingUnit.keeper.id) : null;
    if (drsK) {
      const d = drsSides(newState, ni);
      const what = drsK === "lbw" ? "lbw" : "caught behind";
      const r = drsAtDismissal(drsK, rng, d.avail);
      if (r.cancel) {
        // given not out, and the fielding side has no review left to overturn it
        drsOverturned = true;
        redo("dot");
        result.commentary = `${bowler.name} to ${striker.name}, big appeal for ${what}... not out says the umpire, and ${d.bowlSN} have no reviews left.`;
        eventType = "dot";
        wicketType = undefined;
        fielderName = undefined;
      } else if (r.review?.by === "fielding") {
        if (d.userBowling) {
          // shown as not out: the user decides whether to review it (it would be overturned)
          drsOverturned = true;
          _drsOverturns = true;
          _drsKind = drsK;
          _drsFielderId = result.fielderId;
          redo("dot");
          eventType = "dot";
          wicketType = undefined;
          fielderName = undefined;
          result.commentary = `${bowler.name} to ${striker.name}, huge appeal for ${what}! Not out says the umpire.`;
          newState.pendingDecision = drsPending(newState.bowlingTeamId, striker.name, bowler.name, drsK, "bowling", false,
            drsK === "lbw" ? 55 : 60, drsK === "lbw" ? "Struck on the pad in line, looked to be hitting" : "A faint noise as it passed the bat");
          newState.status = "waiting_for_decision";
        } else {
          _drsReview = r.review;
          result.commentary = `${bowler.name} to ${striker.name}, ${drsText(r.review, d.bowlSN, rng)} ${result.commentary}`;
        }
      } else if (d.userBatting && d.avail.batting > 0) {
        // given out: the user may review it (the decision was right: struck down, or umpire's call)
        _drsResult = userBattingReviewOfWicket(drsK, rng);
        _drsKind = drsK;
        newState.pendingDecision = drsPending(newState.battingTeamId, striker.name, bowler.name, drsK, "batting", true,
          _drsResult === "umpires_call" ? 30 : 15, drsK === "lbw" ? "Struck on the pad, the question is whether it was going on to hit" : "Given caught behind, was there bat on it?");
        newState.status = "waiting_for_decision";
      } else if (r.review) {
        _drsReview = r.review;
        if (reviewLost(r.review)) decDrs(newState, newState.battingTeamId);
        result.commentary += " " + drsText(r.review, d.batSN, rng);
      }
    }


    // DRS for run out decisions: ~30% of run outs are close calls worth reviewing
    if (wicketType === "run_out" && !drsOverturned) {
      const isCloseRunOut = rng() < 0.30;
      if (isCloseRunOut) {
        // Variable overturn: diving = 40% overturned, normal = 15%
        const isDiving = rng() < 0.35;
        const overturnChance = isDiving ? 0.40 : 0.15;
        const wasActuallyIn = rng() < overturnChance;
        const confidence = Math.round(overturnChance * 100);
        const appealDesc = isDiving
          ? "Batter was diving — the grounding of the bat needs checking frame by frame"
          : "Batter was stretching to make the crease — looks tight on first viewing";
        const battingTeamIsHome = newState.battingTeamId === newState.homeTeam.id;
        const isUserBatting = ni.userTeamId !== null && newState.battingTeamId === ni.userTeamId;
        const drsAvailable = battingTeamIsHome ? newState.drsRemaining.home : newState.drsRemaining.away;

        if (drsAvailable > 0 && isUserBatting) {
          // Offer run out review to user
          _drsOverturns = wasActuallyIn;
          result.commentary = `${bowler.name} to ${striker.name}, RUN OUT says the on-field umpire! ${result.detail.dismissal?.out === "nonStriker" ? "Direct hit at the non-striker's end." : "Direct hit at the striker's end."}`;
          newState.pendingDecision = {
            type: "drs_review",
            options: ["review", "accept"],
            teamId: newState.battingTeamId,
            drsContext: {
              batterName: striker.name,
              bowlerName: bowler.name,
              reviewKind: "runout",
              reviewingSide: "batting",
              onFieldCall: "run_out",
              isGivenOut: true,
              confidence,
              appealDescription: appealDesc,
            },
          };
          newState.status = "waiting_for_decision";
        } else if (drsAvailable > 0 && !isUserBatting && rng() < 0.50) {
          // CPU reviews close run outs 50% of the time
          if (wasActuallyIn) {
            drsOverturned = true;
            redo(String(Math.min(3, result.detail.batRuns + 1)) as BallOutcome); // batter made the run
            result.commentary = `${bowler.name} to ${striker.name}, run out given! DRS review... OVERTURNED! Batter was IN. The run counts.`;
            eventType = result.runs === 1 ? "single" : result.runs === 2 ? "double" : "triple";
            wicketType = undefined;
          } else {
            if (battingTeamIsHome) newState.drsRemaining.home--;
            else newState.drsRemaining.away--;
            const sn = battingTeamIsHome ? newState.homeTeam.shortName : newState.awayTeam.shortName;
            result.commentary = `${bowler.name} to ${striker.name}, run out! DRS review... stays OUT. Batter was short. ${sn} lose their review.`;
          }
        }
      }
    }
  } else if ((result.outcome === "wide" || result.outcome === "noball") && canOfferNonLbwReview && simpleExtra(result.detail)) {
    const reviewKind = result.outcome;
    const reviewWindowOpens = rng() < (reviewKind === "wide" ? 0.10 : 0.06);

    if (reviewWindowOpens) {
      // Variable overturn rate: wides on the line = 30%, clearly wide = 10%; noball close = 20%, clear = 8%
      const isCloseCall = rng() < 0.5;
      const overturnRate = reviewKind === "wide"
        ? (isCloseCall ? 0.30 : 0.10)
        : (isCloseCall ? 0.20 : 0.08);
      const shouldOverturn = rng() < overturnRate;
      const confidence = Math.round(overturnRate * 100);
      const appealDesc = reviewKind === "wide"
        ? (isCloseCall ? "Delivery on the wide line — could go either way on replay" : "Looked comfortably wide, unlikely to be overturned")
        : (isCloseCall ? "Front foot landing close to the crease — tight call" : "Foot well over the line, hard to overturn");
      const bowlingTeamIsHome = newState.bowlingTeamId === newState.homeTeam.id;
      const isUserBowling = ni.userTeamId !== null && newState.bowlingTeamId === ni.userTeamId;
      const drsAvailable = bowlingTeamIsHome ? newState.drsRemaining.home : newState.drsRemaining.away;
      const shortName = bowlingTeamIsHome ? newState.homeTeam.shortName : newState.awayTeam.shortName;
      const callText = reviewKind === "wide" ? "wide called by the umpire" : "no ball called by the umpire";

      if (drsAvailable > 0 && isUserBowling) {
        _drsOverturns = shouldOverturn;
        result.commentary = `${bowler.name} to ${striker.name}, ${callText}.`;
        newState.pendingDecision = {
          type: "drs_review",
          options: ["review", "accept"],
          teamId: newState.bowlingTeamId,
          drsContext: {
            batterName: striker.name,
            bowlerName: bowler.name,
            reviewKind,
            reviewingSide: "bowling",
            onFieldCall: reviewKind,
            isGivenOut: false,
            confidence,
            appealDescription: appealDesc,
          },
        };
        newState.status = "waiting_for_decision";
      } else if (drsAvailable > 0 && !isUserBowling && rng() < 0.35) {
        if (shouldOverturn) {
          redo("dot");
          result.commentary = `${bowler.name} to ${striker.name}, ${callText}. DRS review... OVERTURNED! Fair delivery. Call withdrawn.`;
          eventType = "dot";
        } else {
          if (bowlingTeamIsHome) newState.drsRemaining.home--;
          else newState.drsRemaining.away--;
          result.commentary = `${bowler.name} to ${striker.name}, ${callText}. DRS review... ${reviewKind === "wide" ? "stays WIDE" : "stays NO BALL"}. ${shortName} lose their review.`;
        }
      }
    }
  } else if (result.outcome === "dot" && !result.detail.overthrow && !result.detail.penalty) {
    const battingTeamIsHome = newState.battingTeamId === newState.homeTeam.id;
    const isUserBatting = ni.userTeamId !== null && newState.battingTeamId === ni.userTeamId;
    const battingDrsAvailable = battingTeamIsHome ? newState.drsRemaining.home : newState.drsRemaining.away;
    const missedExtraReviewWindowOpens = canOfferNonLbwReview && battingDrsAvailable > 0 && rng() < 0.035;

    if (missedExtraReviewWindowOpens) {
      const reviewKind: DrsReviewKind = rng() < 0.65 ? "wide" : "noball";
      // Variable: batting-side reviews for missed extras have wider range
      const isCloseCall = rng() < 0.45;
      const overturnRate = reviewKind === "wide"
        ? (isCloseCall ? 0.45 : 0.15)
        : (isCloseCall ? 0.30 : 0.10);
      const shouldOverturn = rng() < overturnRate;
      const confidence = Math.round(overturnRate * 100);
      const appealDesc = reviewKind === "wide"
        ? (isCloseCall ? "Looked like it went down the leg side — worth a look" : "Delivery was close to the wide line but umpire said no")
        : (isCloseCall ? "Front foot looked suspect — could be landing past the crease" : "Bowler's foot looked fine on first look");
      const shortName = battingTeamIsHome ? newState.homeTeam.shortName : newState.awayTeam.shortName;
      const callText = reviewKind === "wide" ? "no wide says the umpire" : "not called a no ball";

      if (isUserBatting) {
        _drsOverturns = shouldOverturn;
        result.commentary = `${bowler.name} to ${striker.name}, ${callText}.`;
        newState.pendingDecision = {
          type: "drs_review",
          options: ["review", "accept"],
          teamId: newState.battingTeamId,
          drsContext: {
            batterName: striker.name,
            bowlerName: bowler.name,
            reviewKind,
            reviewingSide: "batting",
            onFieldCall: reviewKind === "wide" ? "not_wide" : "not_noball",
            isGivenOut: false,
            confidence,
            appealDescription: appealDesc,
          },
        };
        newState.status = "waiting_for_decision";
      } else if (rng() < 0.30) {
        if (shouldOverturn) {
          redo(reviewKind);
          result.commentary = `${bowler.name} to ${striker.name}, ${callText}. DRS review... OVERTURNED! That's ${reviewKind === "wide" ? "WIDE" : "NO BALL"}. Add one and rebowl it.`;
          eventType = reviewKind;
        } else {
          if (battingTeamIsHome) newState.drsRemaining.home--;
          else newState.drsRemaining.away--;
          result.commentary = `${bowler.name} to ${striker.name}, ${callText}. DRS review... stays ${reviewKind === "wide" ? "a fair delivery" : "a legal delivery"}. ${shortName} lose their review.`;
        }
      }
    } else if (!freeHitNow) {
      // DRS on a dot ball: a wrong out decision (overturned, or standing when the batting side has no review left) or a
      // fielding-side review of a not-out appeal that fails (drs.ts)
      const d = drsSides(newState, ni);
      const r = drsAtDot(rng, d.avail, !!fieldingUnit.keeper);
      if (r.wicket) {
        const k = r.wicket;
        const keeper = k === "caught" ? fieldingUnit.keeper : undefined;
        redo("wicket", { outcome: "wicket", kind: k === "lbw" ? "lbw" : "caught", fielder: keeper } as any);
        eventType = "wicket";
        wicketType = result.wicketType;
        fielderName = keeper?.name;
        result.fielderId = keeper?.id;
        result.commentary = `${bowler.name} to ${striker.name}, given out ${k === "lbw" ? "lbw" : "caught behind"}! ${k === "lbw" ? "It looked to be sliding down leg" : "It looked to brush only the pad"}, but ${d.batSN} have no reviews left, so the decision stands.`;
      } else if (r.review?.by === "batting") {
        // a wrong out decision; the review will overturn it
        if (d.userBatting) {
          _drsResult = "overturned";
          _drsKind = r.review.kind;
          result.commentary = `${bowler.name} to ${striker.name}, given OUT ${r.review.kind === "lbw" ? "lbw" : "caught behind"}!`;
          newState.pendingDecision = drsPending(newState.battingTeamId, striker.name, bowler.name, r.review.kind, "batting", true,
            70, r.review.kind === "lbw" ? "Felt like an inside edge, or going down leg" : "The bat looked well clear of the ball");
          newState.status = "waiting_for_decision";
        } else {
          _drsReview = r.review;
          result.commentary = `${bowler.name} to ${striker.name}, ${drsText(r.review, d.batSN, rng)}`;
        }
      } else if (r.review?.by === "fielding") {
        if (d.userBowling) {
          _drsOverturns = false;
          _drsMarginal = r.review.result === "umpires_call";
          _drsKind = r.review.kind;
          result.commentary = `${bowler.name} to ${striker.name}, huge appeal for ${r.review.kind === "lbw" ? "lbw" : "caught behind"}! Not out says the umpire.`;
          newState.pendingDecision = drsPending(newState.bowlingTeamId, striker.name, bowler.name, r.review.kind, "bowling", false,
            _drsMarginal ? 35 : 20, r.review.kind === "lbw" ? "Hit on the pad, but was it pitching in line?" : "A noise as it passed the bat, or the pad?");
          newState.status = "waiting_for_decision";
        } else {
          _drsReview = r.review;
          if (reviewLost(r.review)) decDrs(newState, newState.bowlingTeamId);
          result.commentary = `${bowler.name} to ${striker.name}, ${drsText(r.review, d.bowlSN, rng)}`;
        }
      }
    }
  }

  // ── Apply the delivery (after any review has settled the call) ──
  const detail = result.detail;
  const dis = detail.dismissal;
  const isExtra = !detail.legal;
  const nonStrikerId = int.battingOrderIds[state.nonStrikerIdx];
  const outIsNonStriker = dis?.out === "nonStriker";
  const outId = outIsNonStriker ? nonStrikerId : strikerId;
  const survivorIdx = outIsNonStriker ? state.strikerIdx : state.nonStrikerIdx;

  // Build the ball event for the raw log (after DRS adjustments)
  const rawBall: BallEvent = {
    over: newState.overs,
    ball: isExtra ? ni.currentOverLegalBalls : ni.currentOverLegalBalls + 1,
    bowler: bowlerId,
    batter: strikerId,
    outcome: result.outcome,
    runs: result.runs,
    extras: result.extras,
    isWicket: result.isWicket,
    commentary: result.commentary,
    runsRun: detail.runsRun,
    nonStriker: nonStrikerId,
  };
  if (detail.wides) rawBall.wides = detail.wides;
  if (detail.noBalls) rawBall.noBalls = detail.noBalls;
  if (detail.byes) rawBall.byes = detail.byes;
  if (detail.legByes) rawBall.legByes = detail.legByes;
  if (detail.penalty) rawBall.penaltyRuns = detail.penalty;
  if (detail.batBoundary) rawBall.boundary = detail.batBoundary;
  if (detail.overthrow) rawBall.overthrow = detail.overthrow;
  if (detail.wideKind) rawBall.wideKind = detail.wideKind;
  if (freeHitNow) rawBall.freeHit = true;
  if (dis) {
    rawBall.wicketType = dis.kind;
    rawBall.newBatterFaces = dis.newBatterFaces;
    if (outIsNonStriker) rawBall.playerOutId = nonStrikerId;
    if (dis.fielderId) rawBall.fielderId = dis.fielderId;
    if (dis.fielder2Id) rawBall.fielder2Id = dis.fielder2Id;
    if (dis.substitute) rawBall.substitute = true;
  }
  if (_drsOverturns !== undefined) (rawBall as any)._drsOverturns = _drsOverturns;
  if (_drsMarginal !== undefined) (rawBall as any)._drsMarginal = _drsMarginal;
  if (_drsKind !== undefined) (rawBall as any)._drsKind = _drsKind;
  if (_drsResult !== undefined) (rawBall as any)._drsResult = _drsResult;
  if (_drsFielderId !== undefined) (rawBall as any)._drsFielderId = _drsFielderId;
  if (_drsReview) rawBall.review = _drsReview;
  // fielding errors and the section 13 plays, for the scorecard ("dropped on 23") and the fielding stats
  if (!dis && result.fieldingNote && !result.isWicket) { rawBall.fieldingNote = result.fieldingNote; if (result.fielderId) rawBall.fielderId = result.fielderId; }
  if (dis && result.fieldingNote) rawBall.fieldingNote = result.fieldingNote;
  if (!dis && result.deepChance) rawBall.deepChance = true;
  if (detail.noBallKind) rawBall.noBallKind = detail.noBallKind;
  if (detail.beamer) rawBall.beamer = true;
  if (detail.penaltyReason) rawBall.penaltyReason = detail.penaltyReason;
  if (detail.shortRun) rawBall.shortRun = true;
  if (detail.lodged) rawBall.lodged = true;
  if (dis && detail.boundaryCatch) { rawBall.boundaryCatch = true; if (detail.relayFielderId) rawBall.fielder2Id = detail.relayFielderId; }
  if (overRateOn) rawBall.overRatePenalty = true;
  rawInnings.ballLog.push(rawBall);

  // Score and extras
  newState.score += result.runs + result.extras;
  newState.extras += result.extras;
  rawInnings.runs += result.runs + result.extras;
  rawInnings.extras += result.extras;

  // The bowler is charged the bat's runs, wides and no-balls, not byes, leg byes or penalty runs
  const charged = bowlerRuns(detail);
  const rawBowl = rawInnings.bowlerStats[bowlerId] ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
  rawBowl.runs += charged;
  if (detail.wides) rawBowl.wides++;
  if (detail.noBalls) rawBowl.noballs++;
  const liveBowler = newState.bowlerStats.find(b => b.playerId === bowlerId)!;
  liveBowler.runs += charged;
  if (detail.wides) liveBowler.wides++;
  if (detail.noBalls) liveBowler.noBalls++;

  // The striker faces every legal ball and every no-ball (not a wide)
  const rawBat = rawInnings.batterStats[strikerId];
  const liveBatter = newState.batterStats.find(b => b.playerId === strikerId);
  if (batterFaced(detail)) {
    if (rawBat) rawBat.balls++;
    if (liveBatter) liveBatter.balls++;
  }
  if (rawBat) rawBat.runs += result.runs;
  if (liveBatter) liveBatter.runs += result.runs;
  if (detail.batBoundary === 4) { if (rawBat) rawBat.fours++; rawInnings.fours++; newState.fours++; if (liveBatter) liveBatter.fours++; }
  if (detail.batBoundary === 6) { if (rawBat) rawBat.sixes++; rawInnings.sixes++; newState.sixes++; if (liveBatter) liveBatter.sixes++; }

  if (detail.legal) {
    ni.currentOverLegalBalls++;
    rawInnings.totalBalls++;
    rawBowl.balls++;
    liveBowler.balls++;
    if (charged === 0) liveBowler.dots++;
    if (rawBowl.balls === 6) { rawBowl.overs++; rawBowl.balls = 0; }
    if (liveBowler.balls === 6) { liveBowler.overs++; liveBowler.balls = 0; }
  }
  rawInnings.bowlerStats[bowlerId] = rawBowl;

  // A no-ball (or a wide / no-ball on a free hit) makes the next ball a free hit
  newState.freeHit = detail.freeHitNext ? true : undefined;

  let batterNeeded = false;
  if (result.isWicket && dis) {
    newState.wickets++;
    rawInnings.wickets++;
    const outRaw = rawInnings.batterStats[outId];
    if (outRaw) outRaw.isOut = true;
    const outLive = newState.batterStats.find(b => b.playerId === outId);
    if (outLive) {
      outLive.isOut = true;
      const fieldName = (id?: string) => (id && pm[id] ? pm[id].name : undefined);
      outLive.howOut = dismissalText({
        kind: dis.kind,
        bowler: pm[bowlerId]?.name ?? "unknown",
        fielder: dis.kind === "caught" && !dis.fielderId ? "fielder" : fieldName(dis.fielderId),
        fielder2: fieldName(dis.fielder2Id),
        substitute: dis.substitute,
      });
    }
    const overBall = `${newState.overs}.${ni.currentOverLegalBalls}`;
    const fow = `${newState.score}/${newState.wickets} (${overBall} ov)`;
    newState.fallOfWickets.push(fow);
    if (outLive) outLive.fallOfWicket = fow;
    if (dis.bowlerCredit) {
      rawBowl.wickets++;
      liveBowler.wickets++;
    }
    // A new batter comes in, unless a review of this very dismissal is still open
    if (newState.status === "waiting_for_decision" && newState.pendingDecision?.type === "drs_review") {
      ni.awaitingBatter = { survivorIdx, newBatterFaces: dis.newBatterFaces, swapAfter: ni.currentOverLegalBalls >= 6 };
    } else {
      batterNeeded = true;
    }
  } else if (detail.runsRun % 2 === 1) {
    // Odd runs run = swap strike
    swapStrike(newState);
  }
  if (batterNeeded && dis) {
    afterWicket(newState, ni, pm, rawInnings, survivorIdx, dis.newBatterFaces);
  }

  // A batter goes off hurt (not out, can come back at a wicket)
  if (newState.status !== "waiting_for_decision" && !ni.allOut && newState.wickets < 10 && !ni.allOut &&
      !(isSecondInnings && newState.score >= target) && rng() < 2 * rp.hurtPerBatterBall) {
    retireHurt(newState, ni, pm, rawInnings, rng() < 0.67);
  }

  // Create the detailed event
  const detailedBall: DetailedBallEvent = {
    over: newState.overs,
    ball: isExtra ? ni.currentOverLegalBalls : ni.currentOverLegalBalls,
    innings: newState.innings,
    batterName: striker.name,
    bowlerName: bowler.name,
    runs: result.runs,
    extras: result.extras,
    eventType,
    wicketType,
    fielderName,
    commentary: result.commentary,
    scoreSoFar: newState.score,
    wicketsSoFar: newState.wickets,
    ...(outIsNonStriker ? { playerOutName: pm[nonStrikerId]?.name } : {}),
    ...(freeHitNow ? { freeHit: true } : {}),
  };

  newState.ballLog.push(detailedBall);
  if (newState.innings === 1) {
    newState.innings1BallLog.push(detailedBall);
  } else {
    newState.innings2BallLog.push(detailedBall);
  }

  // ── The bowler leaves mid-over: removed from the attack after a second beamer, or hurt (another bowler finishes the over) ──
  {
    const overNow = newState.wickets >= 10 || !!ni.allOut || (isSecondInnings && newState.score >= target);
    if (detail.beamer && !overNow) {
      const n = ((ni.beamers ??= {})[bowlerId] ?? 0) + 1;
      ni.beamers[bowlerId] = n;
      if (n >= 2 && ni.currentOverLegalBalls < 6) bowlerLeavesMidOver(newState, ni, "beamer");
      else if (n < 2) queueNote(ni, "The umpire gives the bowler a first and final warning for the beamer.");
    } else if (!overNow && ni.currentOverLegalBalls > 0 && ni.currentOverLegalBalls < 6 && rng() < rp.bowlerLeavesPerOver / 6) {
      bowlerLeavesMidOver(newState, ni, "injury");
    }
  }

  // Check for end of over
  if (ni.currentOverLegalBalls >= 6) {
    // Update bowler overs
    ni.bowlerOvers[bowlerId] = (ni.bowlerOvers[bowlerId] ?? 0) + 1;
    ni.lastBowlerId = bowlerId;

    // Check for maiden: six legal balls by this bowler in the over and nothing charged to him
    const overBalls = rawInnings.ballLog.filter(b => b.over === newState.overs && b.bowler === bowlerId && !b.deadBall);
    const legalBalls = overBalls.filter(b => b.outcome !== "wide" && b.outcome !== "noball");
    if (legalBalls.length === 6 && overBalls.every(b => rawChargedRuns(b) === 0)) {
      liveBowler.maidens++;
    }

    newState.overs++;
    newState.balls = 0;
    ni.currentOverLegalBalls = 0;
    rawInnings.overs = newState.overs;
    rawInnings.balls = 0;

    // ── Rain check (once per innings, between overs 8-15) ───────────────────────────
    if (!newState.rainChecked && newState.overs >= 8 && newState.overs <= 15) {
      // Dew factor increases rain probability: heavy = 3x, moderate = 2x, none = 1x
      const dewMultiplier = ni.dewFactor === "heavy" ? 3.0 : ni.dewFactor === "moderate" ? 2.0 : 1.0;
      const oversLost = checkRainInterruption(newState.overs, rng);
      // Apply dew multiplier by re-rolling if the base check failed and dew is present
      const effectiveOversLost = oversLost > 0 ? oversLost :
        (dewMultiplier > 1 && rng() < 0.003 * dewMultiplier) ? Math.ceil(rng() * 5) : 0;

      if (effectiveOversLost > 0) {
        newState.rainChecked = true;
        const oversAvailable = maxOvers - newState.overs;
        const actualOversLost = Math.min(effectiveOversLost, oversAvailable);
        const newMaxOvers = maxOvers - actualOversLost;
        const remainingOvers = newMaxOvers - newState.overs;

        if (!canProduceResult(newMaxOvers, !isSecondInnings)) {
          // Abandoned — fewer than 5 overs available total
          newState.maxOvers = newMaxOvers;
          newState.result = "Match abandoned due to rain";
          newState.status = "completed";
          newState.rainDelay = {
            oversLost: actualOversLost,
            narrative: `Heavy rain! Match abandoned — only ${newMaxOvers} overs possible.`,
            innings: newState.innings,
          };
          return { state: newState, ball: detailedBall };
        }

        newState.maxOvers = newMaxOvers;
        const narrative = getRainDelayNarrative(actualOversLost, remainingOvers);

        if (isSecondInnings && newState.innings1Score != null) {
          // Recalculate DLS target for 2nd innings
          const inn1Overs = state.innings1Overs
            ? parseFloat(state.innings1Overs)
            : 20;
          const revisedTarget = calculateDLSTarget(
            newState.innings1Score,
            remainingOvers + newState.overs,  // total overs available to team 2
            newState.wickets,
            Math.floor(inn1Overs),
          );
          newState.target = revisedTarget;
          newState.rainDelay = {
            oversLost: actualOversLost,
            narrative: `${narrative} Revised target: ${revisedTarget}.`,
            innings: 2,
            revisedTarget,
          };
        } else {
          // 1st innings: just reduce available overs
          newState.rainDelay = {
            oversLost: actualOversLost,
            narrative,
            innings: 1,
          };
        }
      }
    }

    // Swap strike at end of over
    const temp = newState.strikerIdx;
    newState.strikerIdx = newState.nonStrikerIdx;
    newState.nonStrikerIdx = temp;
    const tempName = newState.strikerName;
    newState.strikerName = newState.nonStrikerName;
    newState.nonStrikerName = tempName;

    // ── Retire Out (between overs, death phase only) ─────────
    // Only offer in overs 16+ when explosive batters are waiting
    if (newState.status !== "waiting_for_decision" &&
        newState.overs >= 16 && newState.overs < maxOvers && newState.wickets < 10 && !ni.allOut &&
        !(isSecondInnings && newState.score >= target) &&
        newState.nextBatterIdx < ni.battingOrderIds.length) {
      const isUserBatting = ni.userTeamId !== null && newState.battingTeamId === ni.userTeamId;

      // Check if explosive batters are actually waiting
      const waitingBatters = ni.battingOrderIds.slice(newState.nextBatterIdx);
      const hasExplosiveWaiting = waitingBatters.some(id => {
        const p = pm[id];
        return p && p.battingOvr > 75 && p.ratings.power > 65;
      });

      if (isUserBatting && hasExplosiveWaiting) {
        // Offer retire-out between overs: options are current striker and non-striker (plus "skip")
        const currentStrikerId = ni.battingOrderIds[newState.strikerIdx];
        const currentNonStrikerId = ni.battingOrderIds[newState.nonStrikerIdx];
        const retireOptions = ["skip", currentStrikerId, currentNonStrikerId];
        const retireDetails: PendingDecisionOption[] = [currentStrikerId, currentNonStrikerId].map(id => {
          const p = pm[id];
          const liveStat = newState.batterStats.find(b => b.playerId === id);
          return {
            playerId: id,
            playerName: p.name,
            role: p.role,
            battingOvr: p.battingOvr,
            bowlingOvr: p.bowlingOvr,
            overall: p.overall,
            oversBowled: liveStat?.runs,
            oversRemaining: liveStat?.balls,
          };
        });

        newState.pendingDecision = {
          type: 'retire_out',
          options: retireOptions,
          teamId: newState.battingTeamId,
          optionDetails: retireDetails,
        };
        newState.status = "waiting_for_decision";
      } else if (!isUserBatting && hasExplosiveWaiting) {
        // CPU auto-retire: in death overs, retire batters with SR < 120 who scored 25+
        {
          const currentStrikerId = ni.battingOrderIds[newState.strikerIdx];
          const currentNonStrikerId = ni.battingOrderIds[newState.nonStrikerIdx];
          const strikerLive = newState.batterStats.find(b => b.playerId === currentStrikerId);
          const nonStrikerLive = newState.batterStats.find(b => b.playerId === currentNonStrikerId);

          {
            // Check striker for retirement
            let retireId: string | null = null;
            if (strikerLive && strikerLive.runs >= 25 && strikerLive.balls > 0 &&
                (strikerLive.runs / strikerLive.balls) * 100 < 120) {
              retireId = currentStrikerId;
            } else if (nonStrikerLive && nonStrikerLive.runs >= 25 && nonStrikerLive.balls > 0 &&
                       (nonStrikerLive.runs / nonStrikerLive.balls) * 100 < 120) {
              retireId = currentNonStrikerId;
            }

            if (retireId) retireOut(newState, ni, pm, rawInnings, retireId);
          }
        }
      }
    }

    // ── Strategic Timeout (between overs) ───────────────────────────
    // IPL rule: bowling team calls timeout in overs 6-9, batting team in overs 13-16
    if (newState.status !== "waiting_for_decision" &&
        newState.overs < maxOvers && newState.wickets < 10 && !ni.allOut &&
        !(isSecondInnings && newState.score >= target)) {
      const completedOver = newState.overs; // overs just completed (1-indexed after increment)
      const isUserBattingTO = ni.userTeamId !== null && newState.battingTeamId === ni.userTeamId;
      const isUserBowlingTO = ni.userTeamId !== null && newState.bowlingTeamId === ni.userTeamId;
      const bowlingIsHome = newState.bowlingTeamId === newState.homeTeam.id;
      const battingIsHome = newState.battingTeamId === newState.homeTeam.id;

      // Bowling team timeout: overs 6-9 (after overs 6, 7, 8, 9 completed)
      if (completedOver >= 6 && completedOver <= 9) {
        const bowlTO = bowlingIsHome ? newState.strategicTimeouts.home : newState.strategicTimeouts.away;
        if (!bowlTO.used) {
          if (isUserBowlingTO) {
            // Offer timeout to user
            newState.pendingDecision = {
              type: 'strategic_timeout',
              options: ["use", "skip"],
              teamId: newState.bowlingTeamId,
            };
            newState.status = "waiting_for_decision";
          } else {
            // CPU auto-uses at over 7
            if (completedOver === 7) {
              if (bowlingIsHome) {
                newState.strategicTimeouts.home = { used: true, over: completedOver };
              } else {
                newState.strategicTimeouts.away = { used: true, over: completedOver };
              }
            }
          }
        }
      }

      // Batting team timeout: overs 13-16 (after overs 13, 14, 15, 16 completed)
      if (newState.status !== "waiting_for_decision" &&
          completedOver >= 13 && completedOver <= 16) {
        const batTO = battingIsHome ? newState.strategicTimeouts.home : newState.strategicTimeouts.away;
        if (!batTO.used) {
          if (isUserBattingTO) {
            newState.pendingDecision = {
              type: 'strategic_timeout',
              options: ["use", "skip"],
              teamId: newState.battingTeamId,
            };
            newState.status = "waiting_for_decision";
          } else {
            // CPU auto-uses at over 14
            if (completedOver === 14) {
              if (battingIsHome) {
                newState.strategicTimeouts.home = { used: true, over: completedOver };
              } else {
                newState.strategicTimeouts.away = { used: true, over: completedOver };
              }
            }
          }
        }
      }
    }

    // Pick next bowler if innings continues (and no pending batter/retire/timeout decision)
    if (newState.status !== "waiting_for_decision" &&
        newState.overs < maxOvers && newState.wickets < 10 && !ni.allOut &&
        !(isSecondInnings && newState.score >= target)) {
      const isUserBowling = ni.userTeamId !== null && newState.bowlingTeamId === ni.userTeamId;

      // Build eligible bowler list
      ensureFreshBowlerOption(newState, ni);
      ensureFreshBowlerOption(newState, ni);
    const eligibleBowlerIds = getEligibleBowlerIds(ni.bowlingOrderIds, ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId);

      if (isUserBowling && eligibleBowlerIds.length > 1) {
        // User can pick ANY XI player (not just bowling order) — like real cricket
        const bowlingXIIds = newState.battingTeamId === state.homeTeam.id
          ? ni.awayXIIds ?? ni.bowlingOrderIds
          : ni.homeXIIds ?? ni.bowlingOrderIds;
        const allEligible = getEligibleBowlerIds(
          [...new Set([...ni.bowlingOrderIds, ...bowlingXIIds])],
          ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId
        );
        // Sort: preferred bowlers first, then others
        const preferredSet = new Set(ni.bowlingOrderIds);
        allEligible.sort((a, b) => {
          const aPreferred = preferredSet.has(a) ? 0 : 1;
          const bPreferred = preferredSet.has(b) ? 0 : 1;
          if (aPreferred !== bPreferred) return aPreferred - bPreferred;
          return (pm[b]?.bowlingOvr ?? 0) - (pm[a]?.bowlingOvr ?? 0);
        });

        const optionDetails: PendingDecisionOption[] = allEligible.map(id => {
          const p = pm[id];
          const oversBowled = ni.bowlerOvers[id] ?? 0;
          const liveStat = newState.bowlerStats.find(b => b.playerId === id);
          return {
            playerId: id,
            playerName: p.name,
            role: p.role,
            battingOvr: p.battingOvr,
            bowlingOvr: p.bowlingOvr,
            overall: p.overall,
            bowlingStyle: p.bowlingStyle,
            battingHand: p.battingHand,
            oversBowled,
            oversRemaining: ni.maxOversPerBowler - oversBowled,
            runsConceded: liveStat?.runs ?? 0,
            wicketsTaken: liveStat?.wickets ?? 0,
            economy: liveStat && (liveStat.overs > 0 || liveStat.balls > 0)
              ? Math.round((liveStat.runs / (liveStat.overs + liveStat.balls / 6)) * 100) / 100
              : 0,
            dots: liveStat?.dots ?? 0,
            wicketTakingRating: p.ratings.wicketTaking,
            economyRating: p.ratings.economy,
            accuracyRating: p.ratings.accuracy,
          };
        });
        newState.pendingDecision = {
          type: 'choose_bowler',
          options: allEligible,
          teamId: newState.bowlingTeamId,
          optionDetails,
        };
        newState.status = "waiting_for_decision";
      } else {
        // CPU auto-picks or only one option — use phase-specific bowling plan
        const currentBowlingPlan = newState.bowlingTeamId === newState.homeTeam.id
          ? ni.homeBowlingPlan : ni.awayBowlingPlan;
        const nextBowlerIdx = pickNextBowler(ni.bowlingOrderIds, ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId, pm, currentBowlingPlan, newState.overs, rng);
        assignNextBowler(newState, ni, pm, nextBowlerIdx);
      }
    }
  } else {
    newState.balls = ni.currentOverLegalBalls;
  }

  // Check for innings end conditions
  const inningsEnded =
    newState.wickets >= 10 ||
    !!ni.allOut ||
    newState.overs >= maxOvers ||
    (isSecondInnings && newState.score >= target);

  if (inningsEnded) {
    if (newState.innings === 1) {
      finalizeFirstInningsBreak(newState, ni, rawInnings);
    } else {
      // Match completed
      completeMatch(newState);
    }
  }

  flushNote(newState);
  return { state: newState, ball: detailedBall };
}

/* ─────────────────── A bowler leaves in the middle of an over ─────────────────── */

/** What the bowler-choice panel shows for each option */
function bowlerOptionDetails(state: MatchState, ni: MatchStateInternal, ids: string[]): PendingDecisionOption[] {
  const pm = ni.playerDataMap;
  return ids.map(id => {
    const p = pm[id];
    const oversBowled = ni.bowlerOvers[id] ?? 0;
    const liveStat = state.bowlerStats.find(b => b.playerId === id);
    return {
      playerId: id, playerName: p.name, role: p.role, battingOvr: p.battingOvr, bowlingOvr: p.bowlingOvr, overall: p.overall,
      bowlingStyle: p.bowlingStyle, battingHand: p.battingHand, oversBowled, oversRemaining: ni.maxOversPerBowler - oversBowled,
      runsConceded: liveStat?.runs ?? 0, wicketsTaken: liveStat?.wickets ?? 0,
      economy: liveStat && (liveStat.overs > 0 || liveStat.balls > 0) ? Math.round((liveStat.runs / (liveStat.overs + liveStat.balls / 6)) * 100) / 100 : 0,
      dots: liveStat?.dots ?? 0, wicketTakingRating: p.ratings.wicketTaking, economyRating: p.ratings.economy, accuracyRating: p.ratings.accuracy,
    };
  });
}

/**
 * The current bowler cannot finish the over: hurt (he takes no further part) or removed from the attack after a second
 * beamer (Law 41.7). Another bowler, not the previous over's, finishes it; the part-bowled over counts towards both. When
 * the user's side is bowling the user picks him, as at the start of an over.
 */
function bowlerLeavesMidOver(state: MatchState, ni: MatchStateInternal, reason: "injury" | "beamer"): void {
  const pm = ni.playerDataMap;
  const goneId = ni.bowlingOrderIds[state.currentBowlerIdx];
  const xi = state.bowlingTeamId === state.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
  const unavailable = new Set(ni.unavailableBowlers ?? []);
  const pool = xi
    .filter(id => id !== goneId && id !== ni.lastBowlerId && !unavailable.has(id) && (ni.bowlerOvers[id] ?? 0) < ni.maxOversPerBowler && pm[id])
    .sort((a, b) => (pm[b].bowlingOvr ?? 0) - (pm[a].bowlingOvr ?? 0));
  if (pool.length === 0) return; // nobody can take over: he carries on
  (ni.unavailableBowlers ??= []).push(goneId);
  ni.bowlerOvers[goneId] = ni.maxOversPerBowler; // off for the innings: his overs are used up
  const goneName = pm[goneId].name;
  const userBowling = ni.userTeamId !== null && state.bowlingTeamId === ni.userTeamId;
  if (userBowling && pool.length > 1 && state.status !== "waiting_for_decision") {
    for (const id of pool) if (ni.bowlerOvers[id] === undefined) ni.bowlerOvers[id] = 0;
    state.pendingDecision = {
      type: "choose_bowler", options: pool, teamId: state.bowlingTeamId, optionDetails: bowlerOptionDetails(state, ni, pool),
      reason, outgoingBowlerName: goneName,
    };
    state.status = "waiting_for_decision";
    queueNote(ni, reason === "beamer"
      ? `That is the second beamer from ${goneName}, who is removed from the attack and cannot bowl again in the innings.`
      : `${goneName} pulls up mid-over and has to leave the field.`);
    return;
  }
  let idx = ni.bowlingOrderIds.indexOf(pool[0]);
  if (idx < 0) { ni.bowlingOrderIds.push(pool[0]); idx = ni.bowlingOrderIds.length - 1; }
  ni.bowlerOvers[pool[0]] = ni.bowlerOvers[pool[0]] ?? 0;
  assignNextBowler(state, ni, pm, idx);
  queueNote(ni, reason === "beamer" ? beamerSuspensionLine(goneName, pm[pool[0]].name) : bowlerInjuryLine(goneName, pm[pool[0]].name));
}

/* ─────────────────── DRS helpers ─────────────────── */

/** Reviews left for the two sides of the innings, who the user is, and the teams' short names */
function drsSides(state: MatchState, ni: MatchStateInternal) {
  const batHome = state.battingTeamId === state.homeTeam.id;
  const r = state.drsRemaining;
  return {
    avail: { batting: batHome ? r.home : r.away, fielding: batHome ? r.away : r.home },
    userBatting: ni.userTeamId !== null && state.battingTeamId === ni.userTeamId,
    userBowling: ni.userTeamId !== null && state.bowlingTeamId === ni.userTeamId,
    batSN: batHome ? state.homeTeam.shortName : state.awayTeam.shortName,
    bowlSN: batHome ? state.awayTeam.shortName : state.homeTeam.shortName,
  };
}

/** The keeper of the side in the field */
function pickKeeperId(state: MatchState, ni: MatchStateInternal): string | undefined {
  const ids = state.bowlingTeamId === state.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
  const unit = buildFieldingUnit(ids.map(id => ni.playerDataMap[id]).filter(Boolean) as FielderLike[]);
  return unit.keeper?.id;
}

function decDrs(state: MatchState, teamId: string): void {
  if (teamId === state.homeTeam.id) state.drsRemaining.home = Math.max(0, state.drsRemaining.home - 1);
  else state.drsRemaining.away = Math.max(0, state.drsRemaining.away - 1);
}

function drsPending(teamId: string, batterName: string, bowlerName: string, kind: DrsKind, side: DrsReviewingSide, givenOut: boolean, confidence: number, appealDescription: string): PendingDecision {
  return {
    type: "drs_review",
    options: ["review", "accept"],
    teamId,
    drsContext: {
      batterName, bowlerName, reviewKind: kind, reviewingSide: side,
      onFieldCall: givenOut ? "out" : "not_out", isGivenOut: givenOut, confidence, appealDescription,
    },
  };
}

/* ─────────────────── Helper: bring in next batter (auto) ─────────────────── */

function bringInNextBatter(
  state: MatchState,
  ni: MatchStateInternal,
  pm: Record<string, SerializedPlayer>,
  rawInnings: InningsScoreRaw,
  idx: number = state.nextBatterIdx,
): void {
  const nextBatterId = ni.battingOrderIds[idx];
  const nextBatter = pm[nextBatterId];
  if (idx === state.nextBatterIdx) state.nextBatterIdx++;

  // Auto-apply per-batter aggression preset
  const batterAggrPreset = ni.batterAggression?.[nextBatterId];
  if (batterAggrPreset !== undefined) {
    if (state.battingTeamId === state.homeTeam.id) state.aggression.home = batterAggrPreset;
    else state.aggression.away = batterAggrPreset;
  }

  const existing = state.batterStats.find(b => b.playerId === nextBatterId);
  if (!existing) {
    state.batterStats.push({
      playerId: nextBatterId,
      playerName: nextBatter.name,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      isOut: false,
      howOut: "not out",
    });
  } else if (existing.retiredHurt) {
    // A retired-hurt batter resumes his innings
    existing.retiredHurt = false;
    existing.howOut = "not out";
  }

  if (!rawInnings.batterStats[nextBatterId]) {
    rawInnings.batterStats[nextBatterId] = { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false };
  }
  syncBatterNames(state, ni);
}

/** strikerName / nonStrikerName follow the indices into the batting order */
function syncBatterNames(state: MatchState, ni: MatchStateInternal): void {
  const pm = ni.playerDataMap;
  state.strikerName = pm[ni.battingOrderIds[state.strikerIdx]]?.name ?? state.strikerName;
  state.nonStrikerName = pm[ni.battingOrderIds[state.nonStrikerIdx]]?.name ?? state.nonStrikerName;
}

function swapStrike(state: MatchState): void {
  const t = state.strikerIdx; state.strikerIdx = state.nonStrikerIdx; state.nonStrikerIdx = t;
  const n = state.strikerName; state.strikerName = state.nonStrikerName; state.nonStrikerName = n;
}

/** Whose turn is it to come in: a retired-hurt batter if he is fit (index into the order), else the next in the order, else none */
function nextBatterToCrease(state: MatchState, ni: MatchStateInternal, rng: RNG): number {
  const hurt = ni.retiredHurtIdx ?? [];
  if (hurt.length > 0 && rng() < retireParams().returnProb) return hurt.shift()!;
  if (state.nextBatterIdx < ni.battingOrderIds.length) return state.nextBatterIdx;
  return -1;
}

/**
 * After a dismissal: the incoming batter takes the dismissed batter's end. Who faces next follows the Laws as the
 * data has them (a catch: the new batter, whether or not they crossed; a run out: the end where it happened).
 * The index the incoming batter will have is known now (a user's pick reorders the batting order but keeps the
 * index), so the batters can be put at their ends at once and the end-of-over change applies on top.
 */
function afterWicket(
  state: MatchState,
  ni: MatchStateInternal,
  pm: Record<string, SerializedPlayer>,
  rawInnings: InningsScoreRaw,
  survivorIdx: number,
  newBatterFaces: boolean,
): void {
  const rng = ni.rng;
  // The user's side with a batter who retired hurt: the user decides whether he resumes (or, with nobody else left, whether
  // the innings goes on at all). He takes the end of the batter who is out, like anyone coming in.
  const hurt = ni.retiredHurtIdx ?? [];
  const userBats = ni.userTeamId !== null && state.battingTeamId === ni.userTeamId;
  if (userBats && hurt.length > 0 && state.wickets < 10) {
    const fresh = state.nextBatterIdx < ni.battingOrderIds.length ? ni.battingOrderIds.slice(state.nextBatterIdx) : [];
    const slot = fresh.length > 0 ? state.nextBatterIdx : hurt[0];
    if (newBatterFaces) { state.strikerIdx = slot; state.nonStrikerIdx = survivorIdx; }
    else { state.strikerIdx = survivorIdx; state.nonStrikerIdx = slot; }
    const hurtIds = hurt.map(i => ni.battingOrderIds[i]);
    const ids = [...fresh, ...hurtIds];
    const optionDetails: PendingDecisionOption[] = ids.map(id => {
      const p = pm[id];
      const live = state.batterStats.find(b => b.playerId === id);
      return {
        playerId: id, playerName: p.name, role: p.role, battingOvr: p.battingOvr, bowlingOvr: p.bowlingOvr, overall: p.overall,
        battingHand: p.battingHand, battingIQRating: p.ratings.battingIQ, timingRating: p.ratings.timing, powerRating: p.ratings.power,
        ...(hurtIds.includes(id) ? { oversBowled: live?.runs, oversRemaining: live?.balls } : {}),
      };
    });
    ni.batterSlotIdx = slot;
    state.pendingDecision = {
      type: "choose_batter", options: fresh.length > 0 ? ids : [...ids, "none"], teamId: state.battingTeamId, optionDetails, retiredHurtIds: hurtIds,
    };
    state.status = "waiting_for_decision";
    return;
  }
  // A batter can be timed out on arrival (three minutes without being ready); the next one then comes in
  for (;;) {
    if (state.wickets >= 10) { ni.allOut = true; return; }
    const idx = nextBatterToCrease(state, ni, rng);
    if (idx < 0) { ni.allOut = true; return; }
    if (idx === state.nextBatterIdx && rng() < retireParams().timedOutPerWicket) {
      const id = ni.battingOrderIds[idx];
      state.nextBatterIdx++;
      state.wickets++;
      rawInnings.wickets++;
      state.batterStats.push({ playerId: id, playerName: pm[id].name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: true, howOut: dismissalText({ kind: "timed_out" }) });
      rawInnings.batterStats[id] = { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: true };
      const fow = `${state.score}/${state.wickets} (${state.overs}.${ni.currentOverLegalBalls} ov)`;
      state.fallOfWickets.push(fow);
      state.batterStats[state.batterStats.length - 1].fallOfWicket = fow;
      queueNote(ni, timedOutLine(pm[id].name, createRNG(state.score * 31 + state.wickets)));
      continue;
    }
    if (newBatterFaces) { state.strikerIdx = idx; state.nonStrikerIdx = survivorIdx; }
    else { state.strikerIdx = survivorIdx; state.nonStrikerIdx = idx; }

    const isUserBatting = ni.userTeamId !== null && state.battingTeamId === ni.userTeamId;
    const returning = idx !== state.nextBatterIdx;
    const remaining = ni.battingOrderIds.length - state.nextBatterIdx;
    if (!returning && isUserBatting && remaining > 1) {
      // The user chooses who comes in (and may bring on the impact player)
      const options = ni.battingOrderIds.slice(state.nextBatterIdx);
      const optionDetails: PendingDecisionOption[] = options.map(id => {
        const p = pm[id];
        return {
          playerId: id, playerName: p.name, role: p.role, battingOvr: p.battingOvr, bowlingOvr: p.bowlingOvr, overall: p.overall,
          battingHand: p.battingHand, battingIQRating: p.ratings.battingIQ, timingRating: p.ratings.timing, powerRating: p.ratings.power,
        };
      });
      const isHome = state.battingTeamId === state.homeTeam.id;
      const subUsed = isHome ? state.impactSubUsed.home : state.impactSubUsed.away;
      if (!subUsed && ni.rules.impactPlayer) {
        for (const benchId of (isHome ? ni.homeBenchIds : ni.awayBenchIds)) {
          const bp = pm[benchId];
          if (bp) {
            options.push(benchId);
            optionDetails.push({
              playerId: benchId, playerName: bp.name, role: bp.role, battingOvr: bp.battingOvr, bowlingOvr: bp.bowlingOvr, overall: bp.overall,
              battingHand: bp.battingHand, battingIQRating: bp.ratings.battingIQ, timingRating: bp.ratings.timing, powerRating: bp.ratings.power, isBench: true,
            });
          }
        }
      }
      state.pendingDecision = { type: 'choose_batter', options, teamId: state.battingTeamId, optionDetails };
      state.status = "waiting_for_decision";
    } else {
      bringInNextBatter(state, ni, pm, rawInnings, idx);
    }
    return;
  }
}

/** A batter leaves hurt: not out, replaced at his end, free to resume at a later wicket */
function retireHurt(
  state: MatchState,
  ni: MatchStateInternal,
  pm: Record<string, SerializedPlayer>,
  rawInnings: InningsScoreRaw,
  strikerHurt: boolean,
): void {
  const idx = strikerHurt ? state.strikerIdx : state.nonStrikerIdx;
  const id = ni.battingOrderIds[idx];
  const live = state.batterStats.find(b => b.playerId === id);
  if (live) { live.retiredHurt = true; live.howOut = RETIRED_HURT_TEXT; }
  queueNote(ni, retiredHurtLine(pm[id].name, createRNG(state.score * 17 + state.overs)));
  if (state.nextBatterIdx >= ni.battingOrderIds.length) {
    // nobody to replace him: a lone batter cannot continue, the innings is over
    ni.allOut = true;
    return;
  }
  (ni.retiredHurtIdx ??= []).push(idx);
  const newIdx = state.nextBatterIdx;
  if (strikerHurt) state.strikerIdx = newIdx; else state.nonStrikerIdx = newIdx;
  bringInNextBatter(state, ni, pm, rawInnings, newIdx);
}

/** Queue a line for the commentary of the ball being played (or the one just played) */
function queueNote(ni: MatchStateInternal, text: string): void {
  ni.pendingNote = ni.pendingNote ? `${ni.pendingNote} ${text}` : text;
}

/** Add any queued line to the latest ball's commentary */
function flushNote(state: MatchState): void {
  const ni = state._internal;
  if (!ni.pendingNote) return;
  const last = getLatestDetailedBall(state);
  if (last) syncLatestDetailedBall(state, { commentary: `${last.commentary} ${ni.pendingNote}` });
  ni.pendingNote = undefined;
}

/** A tactical retirement: out of the innings for good (it cannot be undone), but not a wicket */
function retireOut(
  state: MatchState,
  ni: MatchStateInternal,
  pm: Record<string, SerializedPlayer>,
  rawInnings: InningsScoreRaw,
  id: string,
): void {
  const live = state.batterStats.find(b => b.playerId === id);
  if (live) { live.isOut = true; live.howOut = dismissalText({ kind: "retired_out" }); }
  if (rawInnings.batterStats[id]) rawInnings.batterStats[id].isOut = true;
  state.retiredOutCount = (state.retiredOutCount ?? 0) + 1;
  queueNote(ni, retiredOutLine(pm[id].name, createRNG(state.score * 13 + state.overs)));
  if (state.nextBatterIdx >= ni.battingOrderIds.length) { ni.allOut = true; return; }
  const newIdx = state.nextBatterIdx;
  if (ni.battingOrderIds[state.strikerIdx] === id) state.strikerIdx = newIdx;
  else state.nonStrikerIdx = newIdx;
  bringInNextBatter(state, ni, pm, rawInnings, newIdx);
}

/** Extras by type from a raw ball log (old logs carry only outcome + extras) */
function extrasFromLog(log: readonly BallEvent[]): { wides: number; noBalls: number; legByes: number; byes: number; penalty: number; total: number } {
  let wides = 0, noBalls = 0, legByes = 0, byes = 0, penalty = 0;
  for (const b of log) {
    if (b.wides !== undefined || b.noBalls !== undefined || b.byes !== undefined || b.legByes !== undefined || b.penaltyRuns !== undefined) {
      wides += b.wides ?? 0; noBalls += b.noBalls ?? 0; legByes += b.legByes ?? 0; byes += b.byes ?? 0; penalty += b.penaltyRuns ?? 0;
    } else if (b.outcome === "wide") wides += b.extras;
    else if (b.outcome === "noball") noBalls += b.extras;
    else if (b.outcome === "legbye") legByes += b.extras;
  }
  return { wides, noBalls, legByes, byes, penalty, total: wides + noBalls + legByes + byes + penalty };
}

/** Runs charged to the bowler on a raw ball (old logs: wides and no-balls carried their extras, legal balls their bat runs) */
function rawChargedRuns(b: BallEvent): number {
  if (b.wides !== undefined || b.noBalls !== undefined) return b.runs + (b.wides ?? 0) + (b.noBalls ?? 0);
  return b.runs + (b.outcome === "wide" || b.outcome === "noball" ? b.extras : 0);
}

/** A Mankad: the bowler breaks the stumps at the non-striker's end before delivering. A wicket, not a ball. */
function stepMankad(state: MatchState, bowlerId: string): { state: MatchState; ball: DetailedBallEvent } {
  const newState = cloneState(state);
  const ni = newState._internal;
  const pm = ni.playerDataMap;
  const raw = ni.currentInningsRaw;
  const strikerId = ni.battingOrderIds[state.strikerIdx];
  const nsId = ni.battingOrderIds[state.nonStrikerIdx];
  const bowlerName = pm[bowlerId].name;
  const commentary = describeDelivery({
    detail: { outcome: "wicket", batRuns: 0, wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0, overthrow: 0, dismissal: { kind: "run_out", out: "nonStriker", bowlerCredit: false, newBatterFaces: false } },
    bowler: bowlerName, batter: pm[strikerId].name, nonStriker: pm[nsId].name, deadBall: true, rng: ni.rng,
  })!;
  raw.ballLog.push({
    over: newState.overs, ball: ni.currentOverLegalBalls, bowler: bowlerId, batter: strikerId, outcome: "wicket", runs: 0, extras: 0, nonStriker: nsId,
    isWicket: true, commentary, wicketType: "run_out", playerOutId: nsId, fielderId: bowlerId, deadBall: true, newBatterFaces: false,
  });
  newState.wickets++;
  raw.wickets++;
  if (raw.batterStats[nsId]) raw.batterStats[nsId].isOut = true;
  const live = newState.batterStats.find(b => b.playerId === nsId);
  if (live) {
    live.isOut = true;
    live.howOut = dismissalText({ kind: "run_out", fielder: bowlerName });
    live.fallOfWicket = `${newState.score}/${newState.wickets} (${newState.overs}.${ni.currentOverLegalBalls} ov)`;
    newState.fallOfWickets.push(live.fallOfWicket);
  }
  const ball: DetailedBallEvent = {
    over: newState.overs, ball: ni.currentOverLegalBalls, innings: newState.innings, batterName: pm[strikerId].name, bowlerName,
    runs: 0, extras: 0, eventType: "wicket", wicketType: "run_out", fielderName: bowlerName, commentary,
    scoreSoFar: newState.score, wicketsSoFar: newState.wickets, playerOutName: pm[nsId].name,
  };
  newState.ballLog.push(ball);
  (newState.innings === 1 ? newState.innings1BallLog : newState.innings2BallLog).push(ball);
  afterWicket(newState, ni, pm, raw, state.strikerIdx, false);
  if (newState.wickets >= 10 || ni.allOut) {
    if (newState.innings === 1) finalizeFirstInningsBreak(newState, ni, raw);
    else completeMatch(newState);
  }
  return { state: newState, ball };
}

/* ─────────────────── Helper: assign next bowler ─────────────────── */

function assignNextBowler(
  state: MatchState,
  ni: MatchStateInternal,
  pm: Record<string, SerializedPlayer>,
  bowlerIdx: number,
): void {
  state.currentBowlerIdx = bowlerIdx;
  const nextBowlerId = ni.bowlingOrderIds[bowlerIdx];
  state.currentBowlerName = pm[nextBowlerId].name;

  // Auto-apply per-bowler field setting preset
  const bowlerFieldPreset = ni.bowlerFieldSettings?.[nextBowlerId];
  if (bowlerFieldPreset) {
    if (state.bowlingTeamId === state.homeTeam.id) state.fieldSetting.home = bowlerFieldPreset;
    else state.fieldSetting.away = bowlerFieldPreset;
  }

  if (!state.bowlerStats.find(b => b.playerId === nextBowlerId)) {
    state.bowlerStats.push({
      playerId: nextBowlerId,
      playerName: pm[nextBowlerId].name,
      overs: 0,
      balls: 0,
      runs: 0,
      wickets: 0,
      wides: 0,
      noBalls: 0,
      dots: 0,
      maidens: 0,
    });
  }
}

/* ─────────────────── Helper: get eligible bowler IDs ─────────────────── */

/**
 * No consecutive overs while anyone else in the XI can bowl: when everyone in the bowling order with overs left bowled
 * the previous over, the rest of the XI (a keeper last) joins the bowling order. Only when nobody else has overs to spare
 * does getEligibleBowlerIds relax the consecutive-overs rule.
 */
function ensureFreshBowlerOption(state: MatchState, ni: MatchStateInternal): void {
  const ok = (id: string) => (ni.bowlerOvers[id] ?? 0) < ni.maxOversPerBowler && id !== ni.lastBowlerId && !(ni.unavailableBowlers ?? []).includes(id);
  if (ni.bowlingOrderIds.some(ok)) return;
  const xi = state.bowlingTeamId === state.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
  const others = xi.filter(id => ok(id) && ni.playerDataMap[id]);
  const fielders = others.filter(id => !ni.playerDataMap[id].isWicketKeeper);
  for (const id of fielders.length > 0 ? fielders : others) {
    if (!ni.bowlingOrderIds.includes(id)) ni.bowlingOrderIds.push(id);
    if (ni.bowlerOvers[id] === undefined) ni.bowlerOvers[id] = 0;
  }
}

function getEligibleBowlerIds(
  bowlingOrderIds: string[],
  bowlerOvers: Record<string, number>,
  maxOversPerBowler: number,
  lastBowlerId: string | null,
): string[] {
  let eligible = bowlingOrderIds.filter(
    id => (bowlerOvers[id] ?? 0) < maxOversPerBowler && id !== lastBowlerId
  );
  if (eligible.length === 0) {
    eligible = bowlingOrderIds.filter(id => (bowlerOvers[id] ?? 0) < maxOversPerBowler);
  }
  // Deduplicate (in case of repeats in the order)
  return [...new Set(eligible)];
}

function getLatestDetailedBall(state: MatchState): DetailedBallEvent | undefined {
  return state.innings === 1
    ? state.innings1BallLog[state.innings1BallLog.length - 1]
    : state.innings2BallLog[state.innings2BallLog.length - 1];
}

function syncLatestDetailedBall(state: MatchState, patch: Partial<DetailedBallEvent>): void {
  const lastDetailed = getLatestDetailedBall(state);
  if (lastDetailed) Object.assign(lastDetailed, patch);
  const lastLogBall = state.ballLog[state.ballLog.length - 1];
  if (lastLogBall) Object.assign(lastLogBall, patch);
}

function finalizeFirstInningsBreak(
  state: MatchState,
  ni: MatchStateInternal,
  rawInnings: InningsScoreRaw,
): void {
  state.innings1Score = state.score;
  state.innings1Wickets = state.wickets;
  state.innings1Overs = formatOvers(state.overs, ni.currentOverLegalBalls);
  state.target = state.score + 1;

  ni.innings1Raw = JSON.parse(JSON.stringify(rawInnings));

  state.innings1Scorecard = buildLiveInningsScorecard(
    state.batterStats,
    state.bowlerStats,
    state.battingTeamId,
    getBattingTeamName(state),
    state.bowlingTeamId,
    getBowlingTeamName(state),
    state.score,
    state.wickets,
    formatOvers(state.overs, ni.currentOverLegalBalls >= 6 ? 0 : ni.currentOverLegalBalls),
    state.fallOfWickets,
    rawInnings,
    id => ni.playerDataMap[id]?.name,
  );

  state.status = "innings_break";
}

/**
 * Apply a user's tactical decision to the match state.
 * Call when state.status === "waiting_for_decision".
 */
export function applyDecision(
  state: MatchState,
  decision: { type: string; selectedPlayerId: string; swapOutPlayerId?: string },
): MatchState {
  if (state.status !== "waiting_for_decision" || !state.pendingDecision) {
    throw new Error("No pending decision to apply");
  }

  const newState = cloneState(state);
  const ni = newState._internal;
  const pm = ni.playerDataMap;
  const rawInnings = ni.currentInningsRaw;
  const pending = newState.pendingDecision!;

  if (decision.type !== pending.type) {
    throw new Error(`Decision type mismatch: expected ${pending.type}, got ${decision.type}`);
  }

  if (!pending.options.includes(decision.selectedPlayerId)) {
    throw new Error(`Invalid selection: ${decision.selectedPlayerId} not in options`);
  }

  /** The decision ended the innings (nobody left to bat) */
  let endInningsNow = false;

  switch (pending.type) {
    case 'choose_batter': {
      const chosenId = decision.selectedPlayerId;
      const currentIdx = newState.nextBatterIdx;
      // A retired-hurt batter resumes, or nobody can come in and the innings is over
      if (pending.retiredHurtIds && (chosenId === "none" || pending.retiredHurtIds.includes(chosenId))) {
        const slot = ni.batterSlotIdx ?? currentIdx;
        ni.batterSlotIdx = undefined;
        if (chosenId === "none") {
          ni.allOut = true;
          endInningsNow = true;
          break;
        }
        const h = ni.battingOrderIds.indexOf(chosenId);
        ni.retiredHurtIdx = (ni.retiredHurtIdx ?? []).filter(i => i !== h);
        if (newState.strikerIdx === slot) newState.strikerIdx = h;
        else if (newState.nonStrikerIdx === slot) newState.nonStrikerIdx = h;
        queueNote(ni, `${pm[chosenId].name} walks back out to resume the innings after retiring hurt.`);
        bringInNextBatter(newState, ni, pm, rawInnings, h);
        if (ni.deferredOverSwap) { ni.deferredOverSwap = false; swapStrike(newState); }
        flushNote(newState);
        break;
      }
      ni.batterSlotIdx = undefined;
      const isHome = newState.battingTeamId === newState.homeTeam.id;
      const benchIds = isHome ? ni.homeBenchIds : ni.awayBenchIds;
      const isBenchPlayer = benchIds.includes(chosenId);

      if (isBenchPlayer) {
        // Impact sub: bring in bench player as the new batter
        const benchArr = isHome ? ni.homeBenchIds : ni.awayBenchIds;
        const benchIdx = benchArr.indexOf(chosenId);
        if (benchIdx >= 0) benchArr.splice(benchIdx, 1);

        // Add to XI
        const xiArr = isHome ? ni.homeXIIds : ni.awayXIIds;
        xiArr.push(chosenId);

        // Insert into batting order at the current position
        ni.battingOrderIds.splice(currentIdx, 0, chosenId);

        // Also add to bowling order tracking
        if (ni.bowlerOvers[chosenId] === undefined) ni.bowlerOvers[chosenId] = 0;
        if (!ni.bowlingOrderIds.includes(chosenId)) {
          ni.bowlingOrderIds.push(chosenId);
        }

        // Mark impact sub as used
        if (isHome) newState.impactSubUsed.home = true;
        else newState.impactSubUsed.away = true;
      } else {
        // Regular batter selection — re-order the batting lineup
        const chosenPosInOrder = ni.battingOrderIds.indexOf(chosenId);
        if (chosenPosInOrder >= currentIdx) {
          const existingAtIdx = ni.battingOrderIds[currentIdx];
          ni.battingOrderIds[currentIdx] = chosenId;
          ni.battingOrderIds[chosenPosInOrder] = existingAtIdx;
        }
      }

      // Now bring in the batter
      bringInNextBatter(newState, ni, pm, rawInnings);
      if (ni.deferredOverSwap) { ni.deferredOverSwap = false; swapStrike(newState); }
      break;
    }

    case 'choose_bowler': {
      const chosenId = decision.selectedPlayerId;
      let idx = ni.bowlingOrderIds.indexOf(chosenId);
      // If player isn't in the bowling order (part-timer from XI), add them
      if (idx < 0) {
        ni.bowlingOrderIds.push(chosenId);
        if (ni.bowlerOvers[chosenId] === undefined) ni.bowlerOvers[chosenId] = 0;
        idx = ni.bowlingOrderIds.length - 1;
      }
      assignNextBowler(newState, ni, pm, idx);
      break;
    }

    case 'impact_sub': {
      const subInId = decision.selectedPlayerId;
      const subOutId = decision.swapOutPlayerId;
      if (!subOutId) {
        throw new Error("impact_sub decision requires swapOutPlayerId");
      }

      const isHome = pending.teamId === newState.homeTeam.id;

      // Add the sub player to the player data map if needed
      const subPlayer = pm[subInId];
      if (!subPlayer) {
        throw new Error(`Sub player ${subInId} not found in player data`);
      }

      // Replace in batting order (for 2nd innings if at innings break)
      const battingOrderIds = ni.innings2BattingOrderIds ?? ni.battingOrderIds;
      const subOutBatIdx = battingOrderIds.indexOf(subOutId);
      if (subOutBatIdx >= 0) {
        battingOrderIds[subOutBatIdx] = subInId;
      }

      // Replace in bowling order
      const bowlingOrderIds = ni.innings2BowlingOrderIds ?? ni.bowlingOrderIds;
      const subOutBowlIdx = bowlingOrderIds.indexOf(subOutId);
      if (subOutBowlIdx >= 0) {
        bowlingOrderIds[subOutBowlIdx] = subInId;
      }

      // Replace in XI
      const xiIds = isHome ? ni.homeXIIds : ni.awayXIIds;
      const xiIdx = xiIds.indexOf(subOutId);
      if (xiIdx >= 0) {
        xiIds[xiIdx] = subInId;
      }

      // Mark impact sub as used
      if (isHome) {
        newState.impactSubUsed.home = true;
      } else {
        newState.impactSubUsed.away = true;
      }

      // Remove from bench
      if (isHome) {
        ni.homeBenchIds = ni.homeBenchIds.filter(id => id !== subInId);
      } else {
        ni.awayBenchIds = ni.awayBenchIds.filter(id => id !== subInId);
      }

      break;
    }

    case 'toss_decision': {
      const chosen = decision.selectedPlayerId as "bat" | "bowl";
      newState.tossDecision = chosen;

      // Recalculate batting/bowling first based on user's toss choice
      // The toss winner is the user's team (pending.teamId)
      const tossWinnerId = pending.teamId;
      const tossLoserId = tossWinnerId === newState.homeTeam.id ? newState.awayTeam.id : newState.homeTeam.id;

      const battingFirstId = chosen === "bat" ? tossWinnerId : tossLoserId;
      const bowlingFirstId = battingFirstId === newState.homeTeam.id ? newState.awayTeam.id : newState.homeTeam.id;

      newState.battingTeamId = battingFirstId;
      newState.bowlingTeamId = bowlingFirstId;
      ni.battingFirstId = battingFirstId;
      ni.bowlingFirstId = bowlingFirstId;

      // Recompute batting/bowling orders
      const battingXIIds = battingFirstId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
      const bowlingXIIds = bowlingFirstId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
      ni.battingOrderIds = computeBattingOrder(battingXIIds, pm);
      ni.bowlingOrderIds = computeBowlingOrder(bowlingXIIds, pm);

      // Recompute 2nd innings orders
      ni.innings2BattingOrderIds = computeBattingOrder(bowlingXIIds, pm);
      ni.innings2BowlingOrderIds = computeBowlingOrder(battingXIIds, pm);

      // Reset bowler overs
      ni.bowlerOvers = {};
      for (const id of ni.bowlingOrderIds) ni.bowlerOvers[id] = 0;

      // Re-initialize openers
      const openerId1 = ni.battingOrderIds[0];
      const openerId2 = ni.battingOrderIds[1];
      newState.strikerIdx = 0;
      newState.nonStrikerIdx = 1;
      newState.nextBatterIdx = 2;
      newState.strikerName = pm[openerId1].name;
      newState.nonStrikerName = pm[openerId2].name;

      // Re-initialize batter stats
      newState.batterStats = [
        { playerId: openerId1, playerName: pm[openerId1].name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, howOut: "not out" },
        { playerId: openerId2, playerName: pm[openerId2].name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, howOut: "not out" },
      ];

      // Re-initialize first bowler
      const firstBowlerId = ni.bowlingOrderIds[0];
      newState.currentBowlerIdx = 0;
      newState.currentBowlerName = pm[firstBowlerId].name;
      newState.bowlerStats = [{
        playerId: firstBowlerId, playerName: pm[firstBowlerId].name,
        overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0, dots: 0, maidens: 0,
      }];

      // Re-initialize raw innings
      ni.currentInningsRaw = emptyInningsRaw(battingFirstId);
      for (const id of ni.battingOrderIds) {
        ni.currentInningsRaw.batterStats[id] = { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false };
      }

      break;
    }

    case 'drs_review': {
      const choice = decision.selectedPlayerId; // "review" or "accept"
      const drsContext = pending.drsContext;
      const reviewingTeamIsHome = pending.teamId === newState.homeTeam.id;
      const lastBall = rawInnings.ballLog[rawInnings.ballLog.length - 1];
      const shortName = reviewingTeamIsHome ? newState.homeTeam.shortName : newState.awayTeam.shortName;
      const lbwOrCaught = drsContext && (drsContext.reviewKind === "lbw" || drsContext.reviewKind === "caught");
      const kind: DrsKind = drsContext?.reviewKind === "caught" ? "caught" : "lbw";
      const keeperId = (lastBall as any)?._drsFielderId as string | undefined
        ?? (kind === "caught" ? pickKeeperId(newState, ni) : undefined);

      /** The on-field call was wrong-out-that-stands / not-out-that-is-overturned: the ball becomes the wicket */
      const wicketPostHoc = () => {
        lastBall.isWicket = true;
        lastBall.outcome = "wicket";
        lastBall.wicketType = kind === "lbw" ? "lbw" : "caught";
        lastBall.newBatterFaces = true;
        if (kind === "caught" && keeperId) lastBall.fielderId = keeperId;
        lastBall.fieldingNote = undefined;
        newState.wickets++;
        rawInnings.wickets++;
        const strikerId = lastBall.batter;
        const rawBat = rawInnings.batterStats[strikerId];
        if (rawBat) rawBat.isOut = true;
        const liveBatter = newState.batterStats.find(b => b.playerId === strikerId);
        const bowlerName = pm[lastBall.bowler]?.name ?? "unknown";
        if (liveBatter) {
          liveBatter.isOut = true;
          liveBatter.howOut = dismissalText({ kind: kind === "lbw" ? "lbw" : "caught", bowler: bowlerName, fielder: keeperId ? pm[keeperId]?.name : undefined });
        }
        const overBall = `${newState.overs}.${ni.currentOverLegalBalls}`;
        const fow = `${newState.score}/${newState.wickets} (${overBall} ov)`;
        newState.fallOfWickets.push(fow);
        if (liveBatter) liveBatter.fallOfWicket = fow;
        const rawBowler = rawInnings.bowlerStats[lastBall.bowler];
        if (rawBowler) rawBowler.wickets++;
        const liveBowler = newState.bowlerStats.find(b => b.playerId === lastBall.bowler);
        if (liveBowler) liveBowler.wickets++;
        // The new batter takes the dismissed striker's slot (which is the non-striker's if the over has since ended)
        const outSlotIsStriker = ni.battingOrderIds[newState.strikerIdx] === strikerId;
        const survivor = outSlotIsStriker ? newState.nonStrikerIdx : newState.strikerIdx;
        afterWicket(newState, ni, pm, rawInnings, survivor, outSlotIsStriker);
        syncLatestDetailedBall(newState, {
          eventType: "wicket",
          wicketType: lastBall.wicketType,
          fielderName: keeperId && kind === "caught" ? pm[keeperId]?.name : undefined,
          commentary: lastBall.commentary,
          wicketsSoFar: newState.wickets,
        });
      };

      if (choice === "accept" || !drsContext) {
        // The umpire's call stands. A wrong out decision the user does not review is a wicket.
        if (lbwOrCaught && drsContext!.reviewingSide === "batting" && !lastBall.isWicket && (lastBall as any)._drsResult === "overturned") {
          lastBall.commentary += ` ${newState.battingTeamId === newState.homeTeam.id ? newState.homeTeam.shortName : newState.awayTeam.shortName} do not review, and the batter walks.`;
          wicketPostHoc();
        }
        break;
      }

      // User reviews: resolve the hidden review outcome stored on the last ball.
      const shouldOverturn = (lastBall as any)?._drsOverturns === true;

      if (lbwOrCaught && drsContext.reviewingSide === "batting") {
        // The batting side reviews an out decision
        const res = ((lastBall as any)._drsResult ?? "struck_down") as DrsReview["result"];
        const review: DrsReview = { by: "batting", kind, onField: "out", result: res };
        lastBall.review = review;
        lastBall.commentary += " " + drsText(review, shortName, ni.rng);
        if (reviewLost(review)) decDrs(newState, pending.teamId);
        syncLatestDetailedBall(newState, { commentary: lastBall.commentary });
        // overturned: the ball stays the dot it was; otherwise the wicket stands and the new batter comes in below
      } else if (lbwOrCaught) {
        const isMarginal = (lastBall as any)?._drsMarginal === true;
        const review: DrsReview = { by: "fielding", kind, onField: "not_out", result: shouldOverturn ? "overturned" : isMarginal ? "umpires_call" : "struck_down" };
        lastBall.review = review;
        lastBall.commentary += " " + drsText(review, shortName, ni.rng);
        if (shouldOverturn) {
          wicketPostHoc();
        } else {
          if (reviewLost(review)) decDrs(newState, pending.teamId);
          syncLatestDetailedBall(newState, { commentary: lastBall.commentary });
        }
      } else if (drsContext.reviewKind === "runout") {
        // Run out DRS: batting team reviews a run out decision
        const shortName = reviewingTeamIsHome ? newState.homeTeam.shortName : newState.awayTeam.shortName;
        if (shouldOverturn) {
          // Batter was IN — overturn the run out, restore to not out + 1 run
          const outId = lastBall.playerOutId ?? lastBall.batter;
          const priorRuns = lastBall.runs;
          const newRuns = Math.min(3, priorRuns + 1);
          lastBall.isWicket = false;
          lastBall.outcome = String(newRuns) as BallEvent["outcome"];
          lastBall.runs = newRuns;
          lastBall.runsRun = (lastBall.runsRun ?? priorRuns) + 1;
          lastBall.wicketType = undefined;
          lastBall.playerOutId = undefined;
          lastBall.fielderId = undefined;
          lastBall.fielder2Id = undefined;
          lastBall.newBatterFaces = undefined;
          lastBall.commentary += ` DRS review... OVERTURNED! Batter was IN! The run counts.`;

          newState.wickets--;
          rawInnings.wickets--;

          const rawOut = rawInnings.batterStats[outId];
          if (rawOut) rawOut.isOut = false;
          const liveOut = newState.batterStats.find(b => b.playerId === outId);
          if (liveOut) { liveOut.isOut = false; liveOut.howOut = "not out"; liveOut.fallOfWicket = undefined; }
          const rawBat = rawInnings.batterStats[lastBall.batter];
          if (rawBat) rawBat.runs += 1;
          const liveBatter = newState.batterStats.find(b => b.playerId === lastBall.batter);
          if (liveBatter) liveBatter.runs += 1;

          // Restore the run
          newState.score += 1;
          rawInnings.runs += 1;

          // Remove the fall of wicket entry
          newState.fallOfWickets.pop();
          ni.awaitingBatter = undefined;
          ni.allOut = false;
          // one more run run: the ends change if the total is odd
          if (lastBall.runsRun % 2 === 1) swapStrike(newState);

          syncLatestDetailedBall(newState, {
            eventType: newRuns === 1 ? "single" : newRuns === 2 ? "double" : "triple",
            wicketType: undefined,
            playerOutName: undefined,
            commentary: lastBall.commentary,
            runs: newRuns,
            scoreSoFar: newState.score,
            wicketsSoFar: newState.wickets,
          });
        } else {
          // Batter was OUT — review fails
          if (reviewingTeamIsHome) newState.drsRemaining.home--;
          else newState.drsRemaining.away--;
          lastBall.commentary += ` DRS review... stays OUT. Batter was short of the crease. ${shortName} lose their review.`;
          syncLatestDetailedBall(newState, { commentary: lastBall.commentary });
        }
      } else {
        const reviewKind = drsContext.reviewKind as "wide" | "noball";
        const rawBat = rawInnings.batterStats[lastBall.batter];
        const liveBatter = newState.batterStats.find(b => b.playerId === lastBall.batter);
        const rawBowler = rawInnings.bowlerStats[lastBall.bowler] ?? {
          overs: 0,
          balls: 0,
          runs: 0,
          wickets: 0,
          wides: 0,
          noballs: 0,
        };
        rawInnings.bowlerStats[lastBall.bowler] = rawBowler;
        const liveBowler = newState.bowlerStats.find(b => b.playerId === lastBall.bowler);

        if (shouldOverturn) {
          if (drsContext.reviewingSide === "batting") {
            lastBall.outcome = reviewKind;
            lastBall.extras = 1;
            lastBall.runs = 0;
            lastBall.runsRun = 0;
            lastBall.overthrow = undefined;
            if (reviewKind === "wide") { lastBall.wides = 1; lastBall.noBalls = undefined; }
            else { lastBall.noBalls = 1; lastBall.wides = undefined; }
            newState.freeHit = reviewKind === "noball" ? true : newState.freeHit;
            lastBall.commentary = `${drsContext.bowlerName} to ${drsContext.batterName}, ${reviewKind === "wide" ? "no wide says the umpire" : "not called a no ball"}. DRS review... OVERTURNED! That's ${reviewKind === "wide" ? "WIDE" : "NO BALL"}. Add one and rebowl it.`;

            ni.currentOverLegalBalls = Math.max(0, ni.currentOverLegalBalls - 1);
            newState.balls = ni.currentOverLegalBalls;
            rawInnings.totalBalls = Math.max(0, rawInnings.totalBalls - 1);
            rawInnings.balls = ni.currentOverLegalBalls;

            newState.score += 1;
            newState.extras += 1;
            rawInnings.runs += 1;
            rawInnings.extras += 1;

            if (rawBat) rawBat.balls = Math.max(0, rawBat.balls - 1);
            if (liveBatter) liveBatter.balls = Math.max(0, liveBatter.balls - 1);

            rawBowler.balls = Math.max(0, rawBowler.balls - 1);
            rawBowler.runs += 1;
            if (reviewKind === "wide") rawBowler.wides++;
            else rawBowler.noballs++;

            if (liveBowler) {
              liveBowler.balls = Math.max(0, liveBowler.balls - 1);
              liveBowler.runs += 1;
              if (reviewKind === "wide") liveBowler.wides++;
              else liveBowler.noBalls++;
              liveBowler.dots = Math.max(0, liveBowler.dots - 1);
            }

            lastBall.ball = ni.currentOverLegalBalls;
            syncLatestDetailedBall(newState, {
              ball: ni.currentOverLegalBalls,
              eventType: reviewKind,
              commentary: lastBall.commentary,
              runs: 0,
              extras: 1,
              scoreSoFar: newState.score,
              wicketsSoFar: newState.wickets,
            });
          } else {
            lastBall.outcome = "dot";
            lastBall.extras = 0;
            lastBall.runs = 0;
            lastBall.runsRun = 0;
            lastBall.wides = undefined;
            lastBall.noBalls = undefined;
            if (reviewKind === "noball") newState.freeHit = undefined;
            lastBall.commentary = `${drsContext.bowlerName} to ${drsContext.batterName}, ${reviewKind === "wide" ? "wide called by the umpire" : "no ball called by the umpire"}. DRS review... OVERTURNED! Fair delivery. Call withdrawn.`;

            ni.currentOverLegalBalls++;
            newState.balls = ni.currentOverLegalBalls;
            rawInnings.totalBalls++;
            rawInnings.balls = ni.currentOverLegalBalls;

            newState.score = Math.max(0, newState.score - 1);
            newState.extras = Math.max(0, newState.extras - 1);
            rawInnings.runs = Math.max(0, rawInnings.runs - 1);
            rawInnings.extras = Math.max(0, rawInnings.extras - 1);

            if (rawBat) rawBat.balls++;
            if (liveBatter) liveBatter.balls++;

            rawBowler.balls++;
            rawBowler.runs = Math.max(0, rawBowler.runs - 1);
            if (reviewKind === "wide") rawBowler.wides = Math.max(0, rawBowler.wides - 1);
            else rawBowler.noballs = Math.max(0, rawBowler.noballs - 1);

            if (liveBowler) {
              liveBowler.balls++;
              liveBowler.runs = Math.max(0, liveBowler.runs - 1);
              if (reviewKind === "wide") liveBowler.wides = Math.max(0, liveBowler.wides - 1);
              else liveBowler.noBalls = Math.max(0, liveBowler.noBalls - 1);
              liveBowler.dots++;
            }

            lastBall.ball = ni.currentOverLegalBalls;
            syncLatestDetailedBall(newState, {
              ball: ni.currentOverLegalBalls,
              eventType: "dot",
              commentary: lastBall.commentary,
              runs: 0,
              extras: 0,
              scoreSoFar: newState.score,
              wicketsSoFar: newState.wickets,
            });
          }
        } else {
          if (reviewingTeamIsHome) newState.drsRemaining.home--;
          else newState.drsRemaining.away--;

          lastBall.commentary += drsContext.reviewingSide === "batting"
            ? ` DRS review... stays ${reviewKind === "wide" ? "a fair delivery" : "a legal delivery"}. ${shortName} lose their review.`
            : ` DRS review... ${reviewKind === "wide" ? "stays WIDE" : "stays NO BALL"}. ${shortName} lose their review.`;
          syncLatestDetailedBall(newState, { commentary: lastBall.commentary });
        }
      }

      break;
    }

    case 'retire_out': {
      const chosenId = decision.selectedPlayerId;

      if (chosenId === "skip") {
        // User chose not to retire anyone — proceed
        break;
      }

      // Retire the selected batter out (cannot return); he is replaced at his end
      retireOut(newState, ni, pm, rawInnings, chosenId);
      break;
    }

    case 'strategic_timeout': {
      const choice = decision.selectedPlayerId; // "use" or "skip"
      const teamId = pending.teamId;
      const isHome = teamId === newState.homeTeam.id;

      if (choice === "use") {
        if (isHome) {
          newState.strategicTimeouts.home = { used: true, over: newState.overs };
        } else {
          newState.strategicTimeouts.away = { used: true, over: newState.overs };
        }

        // Tangible benefit: timeout gives a composure/rest boost
        const isBowlingTeam = teamId === newState.bowlingTeamId;
        if (isBowlingTeam) {
          // Bowling team timeout: current bowler gets a small accuracy/economy boost for next over
          const bowlerId = ni.bowlingOrderIds[newState.currentBowlerIdx];
          const bowlerData = pm[bowlerId];
          if (bowlerData) {
            // Temporarily boost accuracy for rest of spell (stored as timeout bonus)
            ni.timeoutBonuses = ni.timeoutBonuses ?? {};
            ni.timeoutBonuses[bowlerId] = { accuracyBoost: 5, economyBoost: 3, expiresAfterOver: newState.overs + 2 };
          }
        } else {
          // Batting team timeout: batters at crease get composure boost (clutch +5 for 2 overs)
          const strikerId = ni.battingOrderIds[newState.strikerIdx];
          const nonStrikerId = ni.battingOrderIds[newState.nonStrikerIdx];
          ni.timeoutBonuses = ni.timeoutBonuses ?? {};
          ni.timeoutBonuses[strikerId] = { clutchBoost: 5, expiresAfterOver: newState.overs + 2 };
          ni.timeoutBonuses[nonStrikerId] = { clutchBoost: 5, expiresAfterOver: newState.overs + 2 };
        }
      }
      // If "skip", the team forfeits the timeout for this over window (but can still use later)

      break;
    }
  }

  // A review of a run out (or any dismissal) left the new batter owed: now the wicket stands, send him in
  if (pending.type === "drs_review" && ni.awaitingBatter) {
    const w = ni.awaitingBatter;
    ni.awaitingBatter = undefined;
    const lastB = rawInnings.ballLog[rawInnings.ballLog.length - 1];
    if (lastB?.isWicket) {
      afterWicket(newState, ni, pm, rawInnings, w.survivorIdx, w.newBatterFaces);
      if (w.swapAfter && newState.status !== "waiting_for_decision") swapStrike(newState);
      else if (w.swapAfter) ni.deferredOverSwap = true;
    }
  }

  if (endInningsNow) {
    newState.pendingDecision = undefined;
    if (newState.innings === 1) finalizeFirstInningsBreak(newState, ni, rawInnings);
    else completeMatch(newState);
    return newState;
  }

  // A case can chain a new decision (e.g. DRS wicket -> choose_batter): that sets a new
  // pendingDecision object. Otherwise the original one is resolved and must be cleared.
  const chainedDecision = newState.status === "waiting_for_decision" && !!newState.pendingDecision && newState.pendingDecision !== pending;
  if (!chainedDecision) {
    newState.pendingDecision = undefined;
  }

  if (pending.type === "drs_review") {
    // If a new decision was set inside the DRS case (e.g. choose_batter after wicket), return it
    if (chainedDecision) {
      return newState;
    }

    const inningsEnded =
      newState.wickets >= 10 || !!ni.allOut ||
      (newState.innings === 2 && newState.target !== undefined && newState.score >= newState.target);

    if (inningsEnded) {
      if (newState.innings === 1) {
        finalizeFirstInningsBreak(newState, ni, rawInnings);
      } else {
        completeMatch(newState);
      }
      return newState;
    }
  }

  // Clear the pending decision and resume
  newState.status = "in_progress";

  // After retire-out, strategic timeout, or DRS review, bowler selection may be needed.
  // If at the start of a new over (currentOverLegalBalls === 0), trigger bowler selection.
  if ((pending.type === 'retire_out' || pending.type === 'strategic_timeout' || pending.type === 'drs_review') &&
      ni.currentOverLegalBalls === 0 && newState.overs < 20 && newState.wickets < 10) {
    const isUserBowling = ni.userTeamId !== null && newState.bowlingTeamId === ni.userTeamId;
    ensureFreshBowlerOption(newState, ni);
    const eligibleBowlerIds = getEligibleBowlerIds(ni.bowlingOrderIds, ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId);

    if (isUserBowling && eligibleBowlerIds.length > 1) {
      const bowlingXIIds = newState.battingTeamId === newState.homeTeam.id
        ? ni.awayXIIds ?? ni.bowlingOrderIds
        : ni.homeXIIds ?? ni.bowlingOrderIds;
      const allEligible = getEligibleBowlerIds(
        [...new Set([...ni.bowlingOrderIds, ...bowlingXIIds])],
        ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId
      );
      const optionDetails: PendingDecisionOption[] = allEligible.map(id => {
        const p = pm[id];
        const oversBowled = ni.bowlerOvers[id] ?? 0;
        const liveStat = newState.bowlerStats.find(b => b.playerId === id);
        return {
          playerId: id, playerName: p.name, role: p.role,
          battingOvr: p.battingOvr, bowlingOvr: p.bowlingOvr, overall: p.overall,
          bowlingStyle: p.bowlingStyle, battingHand: p.battingHand, oversBowled,
          oversRemaining: ni.maxOversPerBowler - oversBowled,
          runsConceded: liveStat?.runs ?? 0, wicketsTaken: liveStat?.wickets ?? 0,
          economy: liveStat && (liveStat.overs > 0 || liveStat.balls > 0)
            ? Math.round((liveStat.runs / (liveStat.overs + liveStat.balls / 6)) * 100) / 100 : 0,
          dots: liveStat?.dots ?? 0,
          wicketTakingRating: p.ratings.wicketTaking,
          economyRating: p.ratings.economy,
          accuracyRating: p.ratings.accuracy,
        };
      });
      newState.pendingDecision = { type: 'choose_bowler', options: allEligible, teamId: newState.bowlingTeamId, optionDetails };
      newState.status = "waiting_for_decision";
    } else {
      // CPU auto-pick bowler
      const currentBowlingPlan = newState.bowlingTeamId === newState.homeTeam.id ? ni.homeBowlingPlan : ni.awayBowlingPlan;
      const nextBowlerIdx = pickNextBowler(ni.bowlingOrderIds, ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId, pm, currentBowlingPlan, newState.overs);
      assignNextBowler(newState, ni, pm, nextBowlerIdx);
    }
  }

  flushNote(newState);
  return newState;
}

/**
 * Get impact sub options for a team (for the UI to display at innings break).
 * Returns null if the team can't use an impact sub.
 */
export function getImpactSubOptions(
  state: MatchState,
  teamId: string,
): { benchPlayers: PendingDecisionOption[]; xiPlayers: PendingDecisionOption[]; suggestedSwapOutId?: string } | null {
  const ni = state._internal;
  if (!ni.rules.impactPlayer) return null;

  const isHome = teamId === state.homeTeam.id;
  if (isHome && state.impactSubUsed.home) return null;
  if (!isHome && state.impactSubUsed.away) return null;

  const benchIds = isHome ? ni.homeBenchIds : ni.awayBenchIds;
  if (benchIds.length === 0) return null;

  const pm = ni.playerDataMap;
  const xiIds = isHome ? ni.homeXIIds : ni.awayXIIds;

  const benchPlayers: PendingDecisionOption[] = benchIds.map(id => {
    const p = pm[id];
    return {
      playerId: id,
      playerName: p?.name ?? "Unknown",
      role: p?.role ?? "unknown",
      battingOvr: p?.battingOvr ?? 0,
      bowlingOvr: p?.bowlingOvr ?? 0,
      overall: p?.overall ?? 0,
    };
  });

  const xiPlayers: PendingDecisionOption[] = xiIds.map(id => {
    const p = pm[id];
    return {
      playerId: id,
      playerName: p?.name ?? "Unknown",
      role: p?.role ?? "unknown",
      battingOvr: p?.battingOvr ?? 0,
      bowlingOvr: p?.bowlingOvr ?? 0,
      overall: p?.overall ?? 0,
    };
  });

  // Suggest which XI player to swap out: lowest overall, avoiding wicket-keepers
  // and accounting for whether the best bench player is a batter or bowler
  let suggestedSwapOutId: string | undefined;
  const bestBench = benchPlayers.reduce((best, p) => p.overall > best.overall ? p : best, benchPlayers[0]);
  if (bestBench) {
    const isBenchBatter = bestBench.role === "batsman" || bestBench.role === "wicket-keeper";
    let worstScore = Infinity;
    for (const xip of xiPlayers) {
      const p = pm[xip.playerId];
      if (p?.isWicketKeeper) continue;
      const score = isBenchBatter ? xip.battingOvr : xip.bowlingOvr;
      if (score < worstScore) { worstScore = score; suggestedSwapOutId = xip.playerId; }
    }
  }

  return { benchPlayers, xiPlayers, suggestedSwapOutId };
}

/**
 * Apply an impact sub decision at the innings break.
 * Can be called with subInId=null to skip (no sub used).
 */
export function applyImpactSub(
  state: MatchState,
  teamId: string,
  subInId: string | null,
  subOutId: string | null,
): MatchState {
  if (!subInId || !subOutId) {
    // Skip - no impact sub used
    return state;
  }

  const newState = cloneState(state);
  return applyDecision(
    { ...newState, status: "waiting_for_decision", pendingDecision: {
      type: 'impact_sub',
      options: [subInId],
      swapOutOptions: [subOutId],
      teamId,
    }},
    { type: 'impact_sub', selectedPlayerId: subInId, swapOutPlayerId: subOutId },
  );
}

/** Set batting aggression for a team (0=defensive, 50=normal, 100=all-out attack) */
export function setAggression(state: MatchState, teamId: string, level: number): MatchState {
  const newState = cloneState(state);
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  if (teamId === newState.homeTeam.id) newState.aggression.home = clamped;
  else newState.aggression.away = clamped;
  return newState;
}

/** Set field placement for a team's bowling. */
export function setFieldSetting(state: MatchState, teamId: string, setting: FieldSetting): MatchState {
  const newState = cloneState(state);
  if (teamId === newState.homeTeam.id) newState.fieldSetting.home = setting;
  else newState.fieldSetting.away = setting;
  return newState;
}

/**
 * Start the second innings (call after innings_break status).
 */
export function startSecondInnings(state: MatchState): MatchState {
  if (state.status !== "innings_break") {
    throw new Error("Cannot start 2nd innings: match is not at innings break");
  }

  const newState = cloneState(state);
  const ni = newState._internal;

  // Swap batting/bowling teams
  const newBattingTeamId = ni.bowlingFirstId;
  const newBowlingTeamId = ni.battingFirstId;
  newState.battingTeamId = newBattingTeamId;
  newState.bowlingTeamId = newBowlingTeamId;

  // Set up innings 2
  newState.innings = 2;
  newState.overs = 0;
  newState.balls = 0;
  newState.score = 0;
  newState.wickets = 0;
  newState.extras = 0;
  newState.fours = 0;
  newState.sixes = 0;
  newState.fallOfWickets = [];

  newState.freeHit = undefined;
  ni.allOut = false;
  ni.awaitingBatter = undefined;
  ni.retiredHurtIdx = [];
  ni.unavailableBowlers = [];
  ni.beamers = {};
  ni.overRateAnnounced = false;
  const orp = drawOverRatePenalty(ni.rng, newState.maxOvers ?? 20);
  newState.overRatePenaltyFrom = orp >= 0 ? orp : undefined;

  // Reset strategic timeouts for the new innings
  newState.strategicTimeouts = {
    home: { used: false },
    away: { used: false },
  };

  // IPL teams get two reviews each innings.
  newState.drsRemaining = { home: 2, away: 2 };

  // Reset rain state for 2nd innings (allow a new rain event)
  newState.rainChecked = false;
  // If 1st innings was rain-reduced, 2nd innings keeps the same max overs
  // (unless further rain reduces it). Reset maxOvers to match 1st innings max.
  if (!newState.rainDelay || newState.rainDelay.innings === 1) {
    // 2nd innings starts with the same reduced max overs as 1st innings ended with
    // (already set on maxOvers by the rain delay logic)
  }
  // Clear the rain delay display (it was for 1st innings)
  newState.rainDelay = undefined;

  // Recompute innings 2 orders from current XI (accounts for impact subs applied during break)
  const battingXIIds = newBattingTeamId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
  const bowlingXIIds = newBowlingTeamId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds;
  ni.battingOrderIds = computeBattingOrder(battingXIIds, ni.playerDataMap);
  ni.bowlingOrderIds = computeBowlingOrder(bowlingXIIds, ni.playerDataMap);

  const pm = ni.playerDataMap;

  // Reset bowler overs
  ni.bowlerOvers = {};
  for (const id of ni.bowlingOrderIds) ni.bowlerOvers[id] = 0;
  ni.lastBowlerId = null;
  ni.currentOverLegalBalls = 0;

  // Reset batting stats for 2nd innings
  newState.strikerIdx = 0;
  newState.nonStrikerIdx = 1;
  newState.nextBatterIdx = 2;

  const openerId1 = ni.battingOrderIds[0];
  const openerId2 = ni.battingOrderIds[1];
  newState.strikerName = pm[openerId1].name;
  newState.nonStrikerName = pm[openerId2].name;

  newState.batterStats = [
    {
      playerId: openerId1,
      playerName: pm[openerId1].name,
      runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, howOut: "not out",
    },
    {
      playerId: openerId2,
      playerName: pm[openerId2].name,
      runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, howOut: "not out",
    },
  ];

  // Pick first bowler
  const firstBowlerIdx = 0;
  const firstBowlerId = ni.bowlingOrderIds[firstBowlerIdx];
  newState.currentBowlerIdx = firstBowlerIdx;
  newState.currentBowlerName = pm[firstBowlerId].name;

  newState.bowlerStats = [{
    playerId: firstBowlerId,
    playerName: pm[firstBowlerId].name,
    overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0, dots: 0, maidens: 0,
  }];

  // Reset raw innings
  ni.currentInningsRaw = emptyInningsRaw(newBattingTeamId);
  for (const id of ni.battingOrderIds) {
    ni.currentInningsRaw.batterStats[id] = { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false };
  }

  newState.status = "in_progress";

  return newState;
}

/**
 * Auto-resolve a pending decision (for CPU teams or when fast-forwarding).
 * Picks the best option based on ratings.
 */
export function autoResolveDecision(state: MatchState): MatchState {
  if (state.status !== "waiting_for_decision" || !state.pendingDecision) {
    return state;
  }

  const pending = state.pendingDecision;
  const pm = state._internal.playerDataMap;

  switch (pending.type) {
    case 'choose_batter': {
      // Pick the batter with highest batting OVR (as the CPU does, a retired-hurt batter does not come back)
      const hurtIds = new Set(pending.retiredHurtIds ?? []);
      const pool = pending.options.filter(id => !hurtIds.has(id) && id !== "none");
      if (pool.length === 0) return applyDecision(state, { type: 'choose_batter', selectedPlayerId: pending.options.includes("none") ? "none" : pending.options[0] });
      let bestId = pool[0];
      let bestOvr = pm[bestId]?.battingOvr ?? 0;
      for (const id of pool) {
        const ovr = pm[id]?.battingOvr ?? 0;
        if (ovr > bestOvr) { bestOvr = ovr; bestId = id; }
      }
      return applyDecision(state, { type: 'choose_batter', selectedPlayerId: bestId });
    }

    case 'choose_bowler': {
      // Pick the bowler with highest bowling OVR
      let bestId = pending.options[0];
      let bestOvr = pm[bestId]?.bowlingOvr ?? 0;
      for (const id of pending.options) {
        const ovr = pm[id]?.bowlingOvr ?? 0;
        if (ovr > bestOvr) { bestOvr = ovr; bestId = id; }
      }
      return applyDecision(state, { type: 'choose_bowler', selectedPlayerId: bestId });
    }

    case 'impact_sub': {
      // CPU auto-uses impact sub: bring in best bench player, swap out weakest XI player
      const ni = state._internal;
      const isHome = pending.teamId === state.homeTeam.id;
      const benchIds = isHome ? ni.homeBenchIds : ni.awayBenchIds;
      const xiIds = isHome ? ni.homeXIIds : ni.awayXIIds;

      if (benchIds.length === 0) {
        const newState = cloneState(state);
        newState.pendingDecision = undefined;
        newState.status = "in_progress";
        return newState;
      }

      // Pick the best bench player by overall rating
      let bestBenchId = benchIds[0];
      let bestBenchOvr = pm[bestBenchId]?.overall ?? 0;
      for (const id of benchIds) {
        const ovr = pm[id]?.overall ?? 0;
        if (ovr > bestBenchOvr) { bestBenchOvr = ovr; bestBenchId = id; }
      }

      // Pick the weakest XI player to swap out (prefer lowest overall, avoid WK)
      const benchPlayer = pm[bestBenchId];
      const isBenchBatter = benchPlayer && (benchPlayer.role === "batsman" || benchPlayer.role === "wicket-keeper");
      let worstXIId = xiIds[0];
      let worstScore = Infinity;
      for (const id of xiIds) {
        const p = pm[id];
        if (!p) continue;
        // Don't swap out a wicket-keeper
        if (p.isWicketKeeper) continue;
        // If bench player is a batter, swap out the weakest batter; if bowler, swap weakest bowler
        const score = isBenchBatter ? p.battingOvr : p.bowlingOvr;
        if (score < worstScore) { worstScore = score; worstXIId = id; }
      }

      return applyDecision(state, {
        type: 'impact_sub',
        selectedPlayerId: bestBenchId,
        swapOutPlayerId: worstXIId,
      });
    }

    case 'toss_decision': {
      // CPU auto-decides: conditions-based (already computed a default toss decision)
      const ni = state._internal;
      const choice = decideTossChoice({
        pitchType: ni.pitchType,
        dewFactor: ni.dewFactor,
        chaseAdvantage: ni.venueProfile ? ni.chaseAdvantage : undefined,
        rng: ni.rng,
      });
      return applyDecision(state, { type: 'toss_decision', selectedPlayerId: choice });
    }

    case 'drs_review': {
      // Auto-resolving (fast-forward): review what the CPU would have reviewed, the lbw / caught-behind calls the model
      // marked (a wrong out, or a not-out the fielding side would overturn); accept everything else
      const last = state._internal.currentInningsRaw.ballLog[state._internal.currentInningsRaw.ballLog.length - 1] as any;
      const ctx = state.pendingDecision?.drsContext;
      const review = !!ctx && (ctx.reviewKind === "lbw" || ctx.reviewKind === "caught") && (last?._drsResult === "overturned" || last?._drsOverturns === true);
      return applyDecision(state, { type: 'drs_review', selectedPlayerId: review ? "review" : "accept" });
    }

    case 'retire_out': {
      // When auto-resolving (fast-forward / CPU), skip retirement
      return applyDecision(state, { type: 'retire_out', selectedPlayerId: "skip" });
    }

    case 'strategic_timeout': {
      // When auto-resolving, skip the timeout
      return applyDecision(state, { type: 'strategic_timeout', selectedPlayerId: "skip" });
    }
  }

  return state;
}

/**
 * Simulate the rest of the match from the current state.
 * Returns the completed state and all balls that were simulated.
 */
export function simulateRemaining(state: MatchState): { state: MatchState; balls: DetailedBallEvent[] } {
  let current = state;
  const allBalls: DetailedBallEvent[] = [];

  // If waiting for decision, auto-resolve it
  if (current.status === "waiting_for_decision") {
    current = autoResolveDecision(current);
  }

  // If at innings break, start second innings first
  if (current.status === "innings_break") {
    current = startSecondInnings(current);
  }

  while (current.status === "in_progress" || current.status === "waiting_for_decision") {
    // Auto-resolve any pending decisions when simulating remaining
    if (current.status === "waiting_for_decision") {
      current = autoResolveDecision(current);
      continue;
    }

    const { state: next, ball } = stepBall(current);
    allBalls.push(ball);
    current = next;

    // Auto-start second innings if we hit the break
    if (current.status === "innings_break") {
      current = startSecondInnings(current);
    }
  }

  return { state: current, balls: allBalls };
}

/**
 * Simulate one full over (up to 6 legal deliveries), returns all balls.
 */
export function simulateOver(state: MatchState): { state: MatchState; balls: DetailedBallEvent[] } {
  let current = state;
  const balls: DetailedBallEvent[] = [];

  if (current.status === "waiting_for_decision") {
    current = autoResolveDecision(current);
  }

  if (current.status === "innings_break") {
    current = startSecondInnings(current);
  }

  if (current.status !== "in_progress") {
    return { state: current, balls };
  }

  const startOver = current.overs;
  const startInnings = current.innings;

  while ((current.status === "in_progress" || current.status === "waiting_for_decision") &&
         current.overs === startOver && current.innings === startInnings) {
    if (current.status === "waiting_for_decision") {
      current = autoResolveDecision(current);
      continue;
    }
    const { state: next, ball } = stepBall(current);
    balls.push(ball);
    current = next;
  }

  return { state: current, balls };
}

/**
 * Convert a completed MatchState into data suitable for the game state update.
 * The caller (App.tsx) is responsible for actually updating the Team objects.
 */
export function finalizeMatchState(state: MatchState): {
  winnerId: string | null;
  margin: string;
  result: string;
  manOfTheMatch: { playerId: string; playerName: string; reason: string };
  innings1Score: number;
  innings1Wickets: number;
  innings2Score: number;
  innings2Wickets: number;
  battingFirstId: string;
  bowlingFirstId: string;
} {
  return {
    winnerId: state.winnerId ?? null,
    margin: state.result?.replace(/^.*won by /, "").replace(/^Match tied$/, "tie") ?? "",
    result: state.result ?? "",
    manOfTheMatch: state.manOfTheMatch ?? { playerId: "", playerName: "", reason: "" },
    innings1Score: state.innings1Score ?? 0,
    innings1Wickets: state.innings1Wickets ?? 0,
    innings2Score: state.score,
    innings2Wickets: state.wickets,
    battingFirstId: state._internal.battingFirstId,
    bowlingFirstId: state._internal.bowlingFirstId,
  };
}

/**
 * Build a DetailedMatchResult from a completed MatchState,
 * suitable for saving to IndexedDB.
 */
export function buildDetailedResultFromState(state: MatchState): DetailedMatchResult {
  if (state.status !== "completed") {
    throw new Error("Cannot build detailed result from incomplete match");
  }

  const pm = state._internal.playerDataMap;
  const battingFirstId = state._internal.battingFirstId;
  const isBattingFirstHome = battingFirstId === state.homeTeam.id;

  const battingFirstTeam = isBattingFirstHome ? state.homeTeam : state.awayTeam;
  const bowlingFirstTeam = isBattingFirstHome ? state.awayTeam : state.homeTeam;

  // Build innings scorecards from the detailed ball logs
  const innings1Scorecard = state.innings1Scorecard!;

  // For innings 2, build from stored data
  const inn2Lives = battingLives(state._internal.currentInningsRaw.ballLog, id => state._internal.playerDataMap[id]?.name);
  const inn2Batters: BatterInnings[] = state.batterStats.map(b => ({
    playerId: b.playerId,
    playerName: b.playerName,
    runs: b.runs,
    balls: b.balls,
    fours: b.fours,
    sixes: b.sixes,
    strikeRate: b.balls > 0 ? Math.round((b.runs / b.balls) * 1000) / 10 : 0,
    howOut: b.howOut,
    fallOfWicket: b.fallOfWicket,
    ...(inn2Lives.get(b.playerId) ? { lives: inn2Lives.get(b.playerId) } : {}),
  })).filter(b => b.balls > 0 || b.howOut !== "not out");

  const inn2Bowlers: BowlerFigures[] = state.bowlerStats
    .filter(hasRecordedBowlingFigures)
    .map(b => {
      const oversStr = b.balls > 0 ? `${b.overs}.${b.balls}` : `${b.overs}.0`;
      const effectiveOvers = b.overs + b.balls / 6;
      return {
        playerId: b.playerId,
        playerName: b.playerName,
        overs: oversStr,
        maidens: b.maidens,
        runs: b.runs,
        wickets: b.wickets,
        economy: effectiveOvers > 0 ? Math.round((b.runs / effectiveOvers) * 100) / 100 : 0,
        dots: b.dots,
        wides: b.wides,
        noBalls: b.noBalls,
      };
    });

  const ex2 = extrasFromLog(state._internal.currentInningsRaw.ballLog);

  const innings2Scorecard: InningsScorecard = {
    battingTeamId: state._internal.bowlingFirstId,
    battingTeamName: bowlingFirstTeam.name,
    bowlingTeamId: state._internal.battingFirstId,
    bowlingTeamName: battingFirstTeam.name,
    totalRuns: state.score,
    totalWickets: state.wickets,
    totalOvers: formatOvers(state.overs, state._internal.currentOverLegalBalls >= 6 ? 0 : state._internal.currentOverLegalBalls),
    batters: inn2Batters,
    bowlers: inn2Bowlers,
    extras: {
      wides: ex2.wides,
      noBalls: ex2.noBalls,
      legByes: ex2.legByes,
      total: ex2.total,
      ...(ex2.byes > 0 ? { byes: ex2.byes } : {}),
      ...(ex2.penalty > 0 ? { penalty: ex2.penalty } : {}),
    },
    fallOfWickets: state.fallOfWickets,
  };

  return {
    matchId: state._internal.matchId,
    homeTeamId: state.homeTeam.id,
    awayTeamId: state.awayTeam.id,
    homeTeamName: state.homeTeam.name,
    awayTeamName: state.awayTeam.name,
    tossWinner: state.tossWinner === state.homeTeam.name ? state.homeTeam.id : state.awayTeam.id,
    tossWinnerName: state.tossWinner,
    tossDecision: state.tossDecision,
    innings1: innings1Scorecard,
    innings2: innings2Scorecard,
    ballLog: [...state.innings1BallLog, ...state.innings2BallLog],
    result: state.result ?? "No result",
    manOfTheMatch: state.manOfTheMatch ?? { playerId: "", playerName: "", reason: "" },
    venue: state.homeTeam.name.includes("Chennai") ? "Chennai"
         : state.homeTeam.name.includes("Mumbai") ? "Mumbai"
         : state.homeTeam.name.includes("Kolkata") ? "Kolkata"
         : state.homeTeam.id === "dc" ? "Delhi"
         : state.homeTeam.id === "rcb" ? "Bengaluru"
         : state.homeTeam.id === "rr" ? "Jaipur"
         : state.homeTeam.id === "pbks" ? "Mohali"
         : state.homeTeam.id === "srh" ? "Hyderabad"
         : state.homeTeam.id === "gt" ? "Ahmedabad"
         : state.homeTeam.id === "lsg" ? "Lucknow"
         : "Stadium",
  };
}

/**
 * Serialize a MatchState to a plain JSON-safe object for IndexedDB storage.
 */
export function serializeMatchState(state: MatchState): object {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Deserialize a MatchState from IndexedDB storage.
 * Reconstructs the RNG from the stored seed.
 * Note: The RNG state won't be identical to where it left off, so
 * a resumed match may diverge from the original. For exact replays,
 * replay from scratch using the same seed.
 */
export function deserializeMatchState(data: any): MatchState {
  const state = data as MatchState;
  // Reconstruct the RNG from the stored seed
  if (state._internal && state._internal.seed != null) {
    state._internal.rng = createRNG(state._internal.seed);
  } else {
    state._internal.rng = Math.random;
  }
  return state;
}

/* ─────────────────── Internal helpers ─────────────────── */

/** Recompute batting order from current XI IDs using the same logic as Team.autoBattingOrder */
function computeBattingOrder(
  xiIds: string[],
  pm: Record<string, SerializedPlayer>,
): string[] {
  const roleOrder: Record<string, number> = { batsman: 0, "all-rounder": 1, bowler: 2 };
  return [...xiIds].sort((aId, bId) => {
    const a = pm[aId];
    const b = pm[bId];
    // Wicket-keeper bats 1-3
    if (a.isWicketKeeper && !b.isWicketKeeper) return -1;
    if (b.isWicketKeeper && !a.isWicketKeeper) return 1;
    // Batsmen first, then all-rounders, then bowlers
    const diff = (roleOrder[a.role] ?? 2) - (roleOrder[b.role] ?? 2);
    if (diff !== 0) return diff;
    // Within same role, higher batting OVR first
    return b.battingOvr - a.battingOvr;
  });
}

/** Recompute bowling order from current XI IDs using the same logic as Team.autoBowlingOrder */
function computeBowlingOrder(
  xiIds: string[],
  pm: Record<string, SerializedPlayer>,
): string[] {
  const bowlers = xiIds
    .filter(id => pm[id].role === "bowler" || pm[id].role === "all-rounder")
    .sort((aId, bId) => (pm[bId]?.bowlingOvr ?? 0) - (pm[aId]?.bowlingOvr ?? 0));

  // Need at least 5 bowlers for 20 overs (max 4 each)
  if (bowlers.length < 5) {
    const partTimers = xiIds
      .filter(id => pm[id].role === "batsman")
      .sort((aId, bId) => (pm[bId]?.bowlingOvr ?? 0) - (pm[aId]?.bowlingOvr ?? 0));
    for (const pt of partTimers) {
      if (bowlers.length >= 5) break;
      bowlers.push(pt);
    }
  }

  return bowlers;
}

function pickNextBowler(
  bowlingOrderIds: string[],
  bowlerOvers: Record<string, number>,
  maxOversPerBowler: number,
  lastBowlerId: string | null,
  pm: Record<string, SerializedPlayer>,
  bowlingPlan?: BowlingPlan,
  currentOver?: number,
  rng: RNG = Math.random,
): number {
  let eligibleIndices = bowlingOrderIds
    .map((id, idx) => ({ id, idx }))
    .filter(({ id }) => (bowlerOvers[id] ?? 0) < maxOversPerBowler && id !== lastBowlerId);

  if (eligibleIndices.length === 0) {
    eligibleIndices = bowlingOrderIds
      .map((id, idx) => ({ id, idx }))
      .filter(({ id }) => (bowlerOvers[id] ?? 0) < maxOversPerBowler);
  }

  if (eligibleIndices.length === 0) {
    return 0; // fallback
  }

  // If a bowling plan is set, prefer bowlers assigned to the current phase
  const phase = currentOver !== undefined ? getMatchPhase(currentOver) : undefined;
  let planIds: string[] = [];
  if (bowlingPlan && phase) {
    planIds = bowlingPlan[phase] ?? [];
  }
  const planSet = new Set(planIds);

  // Prefer phase-plan bowlers > specialist bowlers > all-rounders > batsmen
  // Within each tier, sort by bowling OVR descending
  eligibleIndices.sort((a, b) => {
    // Phase plan preference (bowlers in the plan for this phase come first)
    const aInPlan = planSet.has(a.id) ? 0 : 1;
    const bInPlan = planSet.has(b.id) ? 0 : 1;
    if (aInPlan !== bInPlan) return aInPlan - bInPlan;

    const roleA = pm[a.id]?.role ?? "batsman";
    const roleB = pm[b.id]?.role ?? "batsman";
    const tierA = roleA === "bowler" ? 0 : roleA === "all-rounder" ? 1 : 2;
    const tierB = roleB === "bowler" ? 0 : roleB === "all-rounder" ? 1 : 2;
    if (tierA !== tierB) return tierA - tierB;
    return (pm[b.id]?.bowlingOvr ?? 0) - (pm[a.id]?.bowlingOvr ?? 0);
  });
  // Pick randomly from top 2 of the best tier available
  const picked = eligibleIndices[Math.floor(rng() * Math.min(2, eligibleIndices.length))];
  return picked.idx;
}

function formatOvers(overs: number, ballsInOver: number): string {
  // If over is complete (6 legal balls bowled) or we're at the start of a new over, show clean overs
  if (ballsInOver === 0 || ballsInOver >= 6) {
    return `${overs}`;
  }
  return `${overs - 1}.${ballsInOver}`;
}

function getBattingTeamName(state: MatchState): string {
  return state.battingTeamId === state.homeTeam.id ? state.homeTeam.name : state.awayTeam.name;
}

function getBowlingTeamName(state: MatchState): string {
  return state.bowlingTeamId === state.homeTeam.id ? state.homeTeam.name : state.awayTeam.name;
}

function buildLiveInningsScorecard(
  batterStats: LiveBatterStats[],
  bowlerStats: LiveBowlerStats[],
  battingTeamId: string,
  battingTeamName: string,
  bowlingTeamId: string,
  bowlingTeamName: string,
  totalRuns: number,
  totalWickets: number,
  totalOvers: string,
  fallOfWickets: string[],
  rawInnings: InningsScoreRaw,
  nameOf?: (id: string) => string | undefined,
): InningsScorecard {
  const names = new Map<string, string>();
  for (const b of batterStats) names.set(b.playerId, b.playerName);
  for (const b of bowlerStats) names.set(b.playerId, b.playerName);
  const lives = battingLives(rawInnings.ballLog, id => names.get(id) ?? nameOf?.(id));
  const batters: BatterInnings[] = batterStats
    .filter(b => b.balls > 0 || b.isOut)
    .map(b => ({
      playerId: b.playerId,
      playerName: b.playerName,
      runs: b.runs,
      balls: b.balls,
      fours: b.fours,
      sixes: b.sixes,
      strikeRate: b.balls > 0 ? Math.round((b.runs / b.balls) * 1000) / 10 : 0,
      howOut: b.howOut,
      fallOfWicket: b.fallOfWicket,
      ...(lives.get(b.playerId) ? { lives: lives.get(b.playerId) } : {}),
    }));

  const bowlers: BowlerFigures[] = bowlerStats
    .filter(hasRecordedBowlingFigures)
    .map(b => {
      const oversStr = b.balls > 0 ? `${b.overs}.${b.balls}` : `${b.overs}.0`;
      const effectiveOvers = b.overs + b.balls / 6;
      return {
        playerId: b.playerId,
        playerName: b.playerName,
        overs: oversStr,
        maidens: b.maidens,
        runs: b.runs,
        wickets: b.wickets,
        economy: effectiveOvers > 0 ? Math.round((b.runs / effectiveOvers) * 100) / 100 : 0,
        dots: b.dots,
        wides: b.wides,
        noBalls: b.noBalls,
      };
    });

  const ex = extrasFromLog(rawInnings.ballLog);

  return {
    battingTeamId,
    battingTeamName,
    bowlingTeamId,
    bowlingTeamName,
    totalRuns,
    totalWickets,
    totalOvers,
    batters,
    bowlers,
    extras: {
      wides: ex.wides,
      noBalls: ex.noBalls,
      legByes: ex.legByes,
      total: ex.total,
      ...(ex.byes > 0 ? { byes: ex.byes } : {}),
      ...(ex.penalty > 0 ? { penalty: ex.penalty } : {}),
    },
    fallOfWickets,
  };
}

function hasRecordedBowlingFigures(bowler: LiveBowlerStats): boolean {
  return (
    bowler.overs > 0 ||
    bowler.balls > 0 ||
    bowler.runs > 0 ||
    bowler.wickets > 0 ||
    bowler.wides > 0 ||
    bowler.noBalls > 0
  );
}

function completeMatch(state: MatchState): void {
  if (state.innings !== 2 || !state._internal) {
    throw new Error("Cannot complete match: invalid state");
  }
  if (state.target == null || state.innings1Score == null) {
    throw new Error("Cannot complete match: missing innings 1 data (target or innings1Score)");
  }

  const int = state._internal;
  const target = state.target;
  const inn1Score = state.innings1Score;
  const inn2Score = state.score;

  const battingFirstName = int.battingFirstId === state.homeTeam.id ? state.homeTeam.name : state.awayTeam.name;
  const bowlingFirstName = int.bowlingFirstId === state.homeTeam.id ? state.homeTeam.name : state.awayTeam.name;

  if (inn2Score >= target) {
    state.winnerId = int.bowlingFirstId;
    state.result = `${bowlingFirstName} won by ${10 - state.wickets} wickets`;
  } else if (inn2Score < inn1Score) {
    state.winnerId = int.battingFirstId;
    state.result = `${battingFirstName} won by ${inn1Score - inn2Score} runs`;
  } else {
    // A tie goes to a super over (repeated while it stays tied), or to a boundary count-back under the old rule
    playLiveSuperOvers(state);
  }

  // Calculate man of the match
  state.manOfTheMatch = calculateLiveMOTM(state);
  state.status = "completed";
}


/* ─────────────────── Super over ─────────────────── */

/**
 * Settle a tied match: one over each, two wickets end an innings, three nominated batters and one bowler per side.
 * The side that batted second in the match bats first. A bowler of the previous super over cannot bowl again and a
 * batter dismissed in it cannot bat again. Under "repeated-super-over" the super overs go on until one side wins; under
 * the old boundary rule the side with more boundaries (the match and the super over together) wins after one.
 */
export function playLiveSuperOvers(state: MatchState): void {
  const ni = state._internal;
  const pm = ni.playerDataMap;
  const rng = ni.rng;
  const homeId = state.homeTeam.id;
  const xiOf = (teamId: string) => (teamId === homeId ? ni.homeXIIds : ni.awayXIIds);
  const nameOf = (teamId: string) => (teamId === homeId ? state.homeTeam.name : state.awayTeam.name);
  const gender = genderOf(ni.rules);

  // Boundaries in the match, per team, for the old count-back
  const boundaries: Record<string, number> = {
    [ni.battingFirstId]: (state.innings1Scorecard?.batters ?? []).reduce((n, b) => n + (b.fours ?? 0) + (b.sixes ?? 0), 0),
    [ni.bowlingFirstId]: state.batterStats.reduce((n, b) => n + (b.fours ?? 0) + (b.sixes ?? 0), 0),
  };

  const rounds: LiveSuperOver[] = [];
  let first = ni.bowlingFirstId;
  let prevBowler: Record<string, string> = {};
  let prevOut: Record<string, Set<string>> = {};
  let winnerId: string | undefined;
  let resultText = "";

  const runInnings = (round: number, batId: string, bowlId: string, target: number | undefined): LiveSuperOver => {
    const outs = prevOut[batId] ?? new Set<string>();
    let batPool = xiOf(batId).filter(id => !outs.has(id) && pm[id]);
    if (batPool.length < 3) batPool = xiOf(batId).filter(id => pm[id]);
    const batters = [...batPool].sort((a, b) => pm[b].battingOvr - pm[a].battingOvr).slice(0, 3);
    let bowlPool = xiOf(bowlId).filter(id => id !== prevBowler[bowlId] && pm[id] && pm[id].bowlingOvr > 0);
    if (bowlPool.length === 0) bowlPool = xiOf(bowlId).filter(id => pm[id]);
    const bowlerId = [...bowlPool].sort((a, b) => pm[b].bowlingOvr - pm[a].bowlingOvr)[0];
    const unit = buildFieldingUnit(xiOf(bowlId).map(id => pm[id]).filter(Boolean) as FielderLike[]);

    let runs = 0, wickets = 0, legal = 0, striker = 0, non = 1, next = 2, freeHit = false;
    const out = new Set<string>();
    const balls: DetailedBallEvent[] = [];
    while (legal < 6 && wickets < 2 && !(target !== undefined && runs >= target)) {
      const bat = pm[batters[striker]];
      const res = runOneBall(
        bat, pm[bowlerId], 19, target !== undefined, target ?? 0, runs, 6 - legal, wickets, ni.stadiumRating, 50, "standard",
        ni.pitchType, ni.boundarySize, ni.dewFactor, 0, 0, legal, 0, rng, batId === homeId, true,
        ni.venueProfile ?? null, ni.chaseAdvantage, unit, { gender: gender === "female" ? "female" : "male", nonStrikerName: pm[batters[non]]?.name },
        { freeHit, gender, bench: [], nonStrikerName: pm[batters[non]]?.name, superOver: true },
      );
      const d = res.detail;
      runs += res.runs + res.extras;
      if (d.legal) legal++;
      let playerOutName: string | undefined;
      if (d.dismissal) {
        wickets++;
        const outIsNon = d.dismissal.out === "nonStriker";
        const outBatter = outIsNon ? batters[non] : batters[striker];
        out.add(outBatter);
        playerOutName = outIsNon ? pm[batters[non]]?.name : undefined;
        const survivor = outIsNon ? striker : non;
        if (next >= batters.length) { striker = survivor; non = survivor; wickets = Math.max(wickets, 2); }
        else if (d.dismissal.newBatterFaces) { striker = next; non = survivor; next++; }
        else { striker = survivor; non = next; next++; }
      } else if (d.runsRun % 2 === 1) {
        [striker, non] = [non, striker];
      }
      freeHit = d.freeHitNext;
      const ev: DetailedBallEvent["eventType"] = d.dismissal ? "wicket" : res.outcome === "wicket" ? "wicket" :
        res.outcome === "1" ? "single" : res.outcome === "2" ? "double" : res.outcome === "3" ? "triple" :
        res.outcome === "4" ? "four" : res.outcome === "6" ? "six" : res.outcome as DetailedBallEvent["eventType"];
      balls.push({
        over: 0, ball: legal, innings: 2, batterName: bat.name, bowlerName: pm[bowlerId].name, runs: res.runs, extras: res.extras,
        eventType: ev, wicketType: d.dismissal?.kind, fielderName: res.fielderName,
        commentary: balls.length === 0 && target === undefined ? `${superOverLine(round === 1 ? "start" : "tied", createRNG(round))} ${res.commentary}` : res.commentary,
        scoreSoFar: runs, wicketsSoFar: wickets, ...(playerOutName ? { playerOutName } : {}), ...(freeHit ? { freeHit: true } : {}),
      });
    }
    return {
      round, battingTeamId: batId, bowlingTeamId: bowlId, runs, wickets: Math.min(wickets, 2), batters, bowler: bowlerId, out: [...out], balls,
    };
  };

  for (let round = 1; round <= 25; round++) {
    const second = first === ni.battingFirstId ? ni.bowlingFirstId : ni.battingFirstId;
    const a = runInnings(round, first, second, undefined);
    const b = runInnings(round, second, first, a.runs + 1);
    const ra = a, rb = b;
    rounds.push(ra, rb);
    const sb = (x: LiveSuperOver) => x.balls.filter(e => e.eventType === "four" || e.eventType === "six").length;
    boundaries[first] += sb(ra);
    boundaries[second] += sb(rb);
    const score = `${ra.runs}/${ra.wickets} v ${rb.runs}/${rb.wickets}`;
    const suffix = round > 1 ? ` after ${round} Super Overs` : "";
    if (ra.runs !== rb.runs) {
      winnerId = rb.runs > ra.runs ? second : first;
      resultText = `${nameOf(winnerId)} won by Super Over (${winnerId === first ? score : `${rb.runs}/${rb.wickets} v ${ra.runs}/${ra.wickets}`})${suffix}`;
      break;
    }
    if (ni.rules.superOverTieBreaker !== "repeated-super-over") {
      const bf = boundaries[ni.battingFirstId], bs = boundaries[ni.bowlingFirstId];
      winnerId = bf > bs ? ni.battingFirstId : bs > bf ? ni.bowlingFirstId : ni.battingFirstId;
      resultText = bf === bs
        ? `${nameOf(winnerId)} won by Super Over (boundaries level)`
        : `${nameOf(winnerId)} won by boundary count (${Math.max(bf, bs)}-${Math.min(bf, bs)})`;
      break;
    }
    prevBowler = { [second]: a.bowler, [first]: b.bowler };
    prevOut = { [first]: new Set(a.out), [second]: new Set(b.out) };
    first = second; // the side that batted second goes first next time
  }
  if (!winnerId) {
    winnerId = ni.battingFirstId;
    resultText = `${nameOf(winnerId)} won by Super Over (25 tied Super Overs)`;
  }
  state.superOvers = rounds;
  state.winnerId = winnerId;
  state.result = resultText;
}

function calculateLiveMOTM(state: MatchState): { playerId: string; playerName: string; reason: string } {
  const int = state._internal;
  const inn1Raw = int.innings1Raw!;
  const inn2Raw = int.currentInningsRaw;
  const pm = int.playerDataMap;

  let bestScore = -1;
  let bestPlayerId = "";
  let bestReason = "";

  const allPlayerIds = new Set<string>([
    ...Object.keys(inn1Raw.batterStats),
    ...Object.keys(inn1Raw.bowlerStats),
    ...Object.keys(inn2Raw.batterStats),
    ...Object.keys(inn2Raw.bowlerStats),
  ]);

  for (const playerId of allPlayerIds) {
    const bat1 = inn1Raw.batterStats[playerId];
    const bat2 = inn2Raw.batterStats[playerId];
    const bowl1 = inn1Raw.bowlerStats[playerId];
    const bowl2 = inn2Raw.bowlerStats[playerId];

    let score = 0;
    const runs = (bat1?.runs ?? 0) + (bat2?.runs ?? 0);
    const balls = (bat1?.balls ?? 0) + (bat2?.balls ?? 0);
    score += runs * 1.5;
    if (balls > 0) score += ((runs / balls) * 100 - 120) * 0.3;
    score += ((bat1?.sixes ?? 0) + (bat2?.sixes ?? 0)) * 3;

    const wickets = (bowl1?.wickets ?? 0) + (bowl2?.wickets ?? 0);
    score += wickets * 25;
    const bowlRuns = (bowl1?.runs ?? 0) + (bowl2?.runs ?? 0);
    const bowlOvers = (bowl1?.overs ?? 0) + (bowl2?.overs ?? 0);
    if (bowlOvers > 0) {
      const econ = bowlRuns / bowlOvers;
      score += (8 - econ) * 5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPlayerId = playerId;
      const parts: string[] = [];
      if (runs > 0) parts.push(`${runs}(${balls})`);
      if (wickets > 0) parts.push(`${wickets}/${bowlRuns}`);
      bestReason = parts.join(" & ");
    }
  }

  const player = pm[bestPlayerId];
  return {
    playerId: bestPlayerId,
    playerName: player?.name ?? "Unknown",
    reason: bestReason,
  };
}
