/**
 * Incremental (ball-by-ball) match simulation for the live match viewer.
 *
 * Wraps the existing simulation logic from match.ts into a step-by-step API
 * so that each ball can be rendered individually in the UI.
 */

import { Player } from "./player.js";
import { Team } from "./team.js";
import { clamp, weightedRandom } from "./math.js";
import { DEFAULT_RULES, type RuleSet } from "./rules.js";
import { runPostMatchInjuryChecks, type InjuryStatus } from "./injury.js";
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

/** A pending tactical decision the user must resolve before the match continues. */
export interface PendingDecision {
  type: 'choose_bowler' | 'choose_batter' | 'impact_sub';
  /** Player IDs the user can pick from. For impact_sub, these are bench players who can come in. */
  options: string[];
  /** For impact_sub, the playing XI player IDs who could be swapped out. */
  swapOutOptions?: string[];
  /** Extra info to help the UI: e.g. bowler figures, batter ratings. */
  optionDetails?: PendingDecisionOption[];
  /** Which team the decision is for (so UI can label it). */
  teamId: string;
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

  // Internal state (for serialization, not for UI display)
  _internal: MatchStateInternal;
}

/** Internal engine state not directly useful to the UI but needed for simulation continuity */
interface MatchStateInternal {
  matchId: string;
  rules: RuleSet;
  stadiumRating: number;

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
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
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

function getPhase(over: number): "powerplay" | "middle" | "death" {
  if (over < 6) return "powerplay";
  if (over < 15) return "middle";
  return "death";
}

const PHASE_MULTIPLIERS: Record<string, Record<string, number>> = {
  powerplay: { dot: 0.85, "1": 1.0, "2": 0.9, "3": 1.0, "4": 1.3, "6": 1.1, wicket: 0.9, wide: 1.1, noball: 1.0 },
  middle:    { dot: 1.1,  "1": 1.1, "2": 1.0, "3": 1.0, "4": 0.9, "6": 0.85, wicket: 1.0, wide: 0.9, noball: 1.0 },
  death:     { dot: 0.8,  "1": 0.9, "2": 1.1, "3": 1.1, "4": 1.2, "6": 1.4, wicket: 1.2, wide: 1.2, noball: 1.1 },
};

function baseOutcomeProbabilities(
  batter: SerializedPlayer,
  bowler: SerializedPlayer,
): Record<BallOutcome, number> {
  const batRating = (batter.battingOvr + batter.ratings.timing) / 2 / 100;
  const bowlRating = (bowler.bowlingOvr + bowler.ratings.accuracy) / 2 / 100;
  const balance = batRating - bowlRating;

  return {
    dot:    clamp(0.35 - balance * 0.15, 0.15, 0.55),
    "1":    clamp(0.28 + balance * 0.03, 0.18, 0.38),
    "2":    clamp(0.08 + balance * 0.02, 0.03, 0.15),
    "3":    clamp(0.015, 0.005, 0.03),
    "4":    clamp(0.10 + balance * 0.06 + (batter.ratings.timing / 100) * 0.04, 0.04, 0.22),
    "6":    clamp(0.05 + balance * 0.05 + (batter.ratings.power / 100) * 0.05, 0.01, 0.18),
    wicket: clamp(0.05 - balance * 0.03 + (bowler.ratings.wicketTaking / 100) * 0.03, 0.01, 0.12),
    wide:   clamp(0.04 - (bowler.ratings.accuracy / 100) * 0.02, 0.01, 0.08),
    noball:  clamp(0.01 - (bowler.ratings.accuracy / 100) * 0.005, 0.002, 0.03),
    legbye: 0.02,
  };
}

function chaseAdjustment(
  probs: Record<BallOutcome, number>,
  requiredRate: number,
  currentRate: number,
  wicketsDown: number,
): Record<BallOutcome, number> {
  const pressure = (requiredRate - currentRate) / 8;
  const wicketPressure = wicketsDown >= 7 ? 0.3 : wicketsDown >= 5 ? 0.15 : 0;

  const adjusted = { ...probs };
  if (pressure > 0) {
    adjusted["4"] *= 1 + pressure * 0.3;
    adjusted["6"] *= 1 + pressure * 0.5;
    adjusted.dot *= 1 - pressure * 0.2;
    adjusted.wicket *= 1 + pressure * 0.2 + wicketPressure;
  } else {
    adjusted.dot *= 1 + Math.abs(pressure) * 0.1;
    adjusted["1"] *= 1 + Math.abs(pressure) * 0.1;
    adjusted.wicket *= 1 - Math.abs(pressure) * 0.1;
  }

  return adjusted;
}

function randomBoundaryShot(runs: number): string {
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
  return shots[Math.floor(Math.random() * shots.length)];
}

function generateCommentary(
  outcome: BallOutcome,
  batter: string,
  bowler: string,
  _over: number,
  _runs: number,
): string {
  const templates: Record<BallOutcome, string[]> = {
    dot: [
      `${bowler} to ${batter}, no run. Good length outside off, left alone`,
      `${bowler} to ${batter}, no run. Defended solidly back down the pitch`,
      `${bowler} to ${batter}, no run. Beaten outside off! Good delivery`,
      `${bowler} to ${batter}, no run. Plays and misses, beaten for pace`,
      `${bowler} to ${batter}, no run. Pushed to cover, no single there`,
      `${bowler} to ${batter}, no run. Tight line, can't get it away`,
    ],
    "1": [
      `${bowler} to ${batter}, 1 run. Worked away to midwicket for a single`,
      `${bowler} to ${batter}, 1 run. Nudged to the leg side, quick single taken`,
      `${bowler} to ${batter}, 1 run. Pushed to cover, they take the run`,
      `${bowler} to ${batter}, 1 run. Tapped to mid-on, easy single`,
    ],
    "2": [
      `${bowler} to ${batter}, 2 runs. Pushed into the gap, they come back for two`,
      `${bowler} to ${batter}, 2 runs. Driven wide of mid-off, good running between the wickets`,
      `${bowler} to ${batter}, 2 runs. Worked square, misfield and they get a second`,
    ],
    "3": [
      `${bowler} to ${batter}, 3 runs. Driven to the deep, misfield and they get three!`,
      `${bowler} to ${batter}, 3 runs. Placed into the gap, excellent running gets them back for the third`,
    ],
    "4": [
      `${bowler} to ${batter}, FOUR! ${randomBoundaryShot(4)}`,
      `${bowler} to ${batter}, FOUR! ${randomBoundaryShot(4)}`,
      `${bowler} to ${batter}, FOUR! That races away to the boundary!`,
    ],
    "6": [
      `${bowler} to ${batter}, SIX! ${randomBoundaryShot(6)}!`,
      `${bowler} to ${batter}, SIX! ${randomBoundaryShot(6)}!`,
      `${bowler} to ${batter}, SIX! What a shot! That's massive!`,
    ],
    wicket: [
      `${bowler} to ${batter}, OUT! ${batter} has to walk back!`,
      `${bowler} to ${batter}, OUT! Big wicket! ${batter} departs!`,
      `${bowler} to ${batter}, OUT! Breakthrough! That's the end of ${batter}!`,
    ],
    wide: [
      `${bowler} to ${batter}, wide. Straying down the leg side`,
      `${bowler} to ${batter}, wide. Too far outside off, the umpire signals`,
    ],
    noball: [
      `${bowler} to ${batter}, no ball! Overstepped, free hit coming up`,
      `${bowler} to ${batter}, no ball! Front foot no ball, one extra`,
    ],
    legbye: [
      `${bowler} to ${batter}, leg bye. Off the pad, they scamper through for one`,
      `${bowler} to ${batter}, leg bye. Flicked off the thigh pad`,
    ],
  };

  const options = templates[outcome];
  return options[Math.floor(Math.random() * options.length)];
}

function randomWicketType(): "bowled" | "caught" | "lbw" | "run_out" | "stumped" {
  const r = Math.random();
  if (r < 0.55) return "caught";
  if (r < 0.75) return "bowled";
  if (r < 0.90) return "lbw";
  if (r < 0.97) return "run_out";
  return "stumped";
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
): { outcome: BallOutcome; runs: number; extras: number; isWicket: boolean; commentary: string } {
  let probs = baseOutcomeProbabilities(batter, bowler);

  // Phase adjustment
  const phase = getPhase(over);
  const phaseMult = PHASE_MULTIPLIERS[phase];
  for (const key of Object.keys(probs) as BallOutcome[]) {
    probs[key] *= phaseMult[key] ?? 1;
  }

  // Stadium bowling adjustment
  probs.wicket *= stadiumBowlRating;
  probs.dot *= stadiumBowlRating;

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

  // Normalize and sample
  const entries = Object.entries(probs) as [BallOutcome, number][];
  const outcome = weightedRandom(entries);

  let runs = 0;
  let extras = 0;
  let isWicket = false;

  switch (outcome) {
    case "dot": runs = 0; break;
    case "1": runs = 1; break;
    case "2": runs = 2; break;
    case "3": runs = 3; break;
    case "4": runs = 4; break;
    case "6": runs = 6; break;
    case "wicket": isWicket = true; runs = 0; break;
    case "wide": extras = 1; break;
    case "noball": extras = 1; break;
    case "legbye": extras = 1; break;
  }

  const commentary = generateCommentary(outcome, batter.name, bowler.name, over, runs);

  return { outcome, runs, extras, isWicket, commentary };
}

/* ─────────────────── Serialization helpers ─────────────────── */

function serializePlayer(p: Player): SerializedPlayer {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    isInternational: p.isInternational,
    isWicketKeeper: p.isWicketKeeper,
    battingOvr: p.battingOvr,
    bowlingOvr: p.bowlingOvr,
    overall: p.overall,
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

/* ─────────────────── Public API ─────────────────── */

let liveMatchCounter = 1000;

/**
 * Create a new match state ready for ball-by-ball simulation.
 * @param userTeamId - The user's team ID, or null for CPU-vs-CPU matches.
 *   When provided, the engine will pause for tactical decisions on the user's team.
 */
export function createMatchState(
  homeTeam: Team,
  awayTeam: Team,
  rules: RuleSet = DEFAULT_RULES,
  userTeamId: string | null = null,
): MatchState {
  const matchId = `live_match_${++liveMatchCounter}`;

  const homeXI = homeTeam.getPlayingXI(rules.maxOverseasInXI);
  const awayXI = awayTeam.getPlayingXI(rules.maxOverseasInXI);

  // Toss
  const tossWinner = Math.random() < 0.5 ? homeTeam : awayTeam;
  const tossDecision: "bat" | "bowl" = Math.random() < 0.6 ? "bowl" : "bat";

  const battingFirst = tossDecision === "bat" ? tossWinner : (tossWinner === homeTeam ? awayTeam : homeTeam);
  const bowlingFirst = battingFirst === homeTeam ? awayTeam : homeTeam;

  const stadiumRating = (homeTeam.config.stadiumBowlingRating ?? 1.0) * (2 - rules.scoringMultiplier);

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

    status: "in_progress",
    tossWinner: tossWinner.name,
    tossDecision,
    injuries: [],
    impactSubUsed: { home: false, away: false },

    _internal: {
      matchId,
      rules,
      stadiumRating,
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
    },
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
  const maxOvers = 20;

  // Get current players
  const strikerId = int.battingOrderIds[state.strikerIdx];
  const bowlerId = int.bowlingOrderIds[state.currentBowlerIdx];
  const striker = pm[strikerId];
  const bowler = pm[bowlerId];

  const ballsRemaining = (maxOvers - state.overs) * 6 - int.currentOverLegalBalls;
  const target = state.target ?? 0;

  // Run the ball
  const result = runOneBall(
    striker,
    bowler,
    state.overs,
    isSecondInnings,
    target,
    state.score,
    ballsRemaining,
    state.wickets,
    int.stadiumRating,
  );

  // Clone state for mutation
  const newState: MatchState = JSON.parse(JSON.stringify(state));
  const ni = newState._internal;
  const rawInnings = ni.currentInningsRaw;

  const isExtra = result.outcome === "wide" || result.outcome === "noball";

  // Build the ball event for the raw log
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
  };
  rawInnings.ballLog.push(rawBall);

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

  let wicketType: DetailedBallEvent["wicketType"];
  let fielderName: string | undefined;
  if (result.isWicket) {
    wicketType = randomWicketType();
    if (wicketType === "caught") {
      // Pick a random bowler-side player name
      const bowlingTeamIds = isSecondInnings
        ? (ni.battingFirstId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds)
        : (ni.bowlingFirstId === newState.homeTeam.id ? ni.homeXIIds : ni.awayXIIds);
      const fielders = bowlingTeamIds.filter(id => id !== bowlerId);
      const fielderId = fielders[Math.floor(Math.random() * fielders.length)];
      fielderName = pm[fielderId]?.name ?? "fielder";
    }
  }

  if (isExtra) {
    // Extra: no legal delivery count, just add runs
    newState.score += result.extras;
    newState.extras += result.extras;
    rawInnings.runs += result.extras;
    rawInnings.extras += result.extras;

    // Update bowler stats
    const bs = rawInnings.bowlerStats[bowlerId] ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
    bs.runs += result.extras;
    if (result.outcome === "wide") bs.wides++;
    else bs.noballs++;
    rawInnings.bowlerStats[bowlerId] = bs;

    // Update live bowler stats
    const liveBowler = newState.bowlerStats.find(b => b.playerId === bowlerId)!;
    liveBowler.runs += result.extras;
    if (result.outcome === "wide") liveBowler.wides++;
    else liveBowler.noBalls++;
  } else {
    // Legal delivery
    ni.currentOverLegalBalls++;
    rawInnings.totalBalls++;
    rawInnings.runs += result.runs + result.extras;
    rawInnings.extras += result.extras;
    newState.score += result.runs + result.extras;
    newState.extras += result.extras;

    // Update raw batter stats
    const rawBat = rawInnings.batterStats[strikerId];
    if (rawBat) {
      rawBat.balls++;
      rawBat.runs += result.runs;
      if (result.outcome === "4") { rawBat.fours++; rawInnings.fours++; newState.fours++; }
      if (result.outcome === "6") { rawBat.sixes++; rawInnings.sixes++; newState.sixes++; }
    }

    // Update live batter stats
    let liveBatter = newState.batterStats.find(b => b.playerId === strikerId);
    if (liveBatter) {
      liveBatter.balls++;
      liveBatter.runs += result.runs;
      if (result.outcome === "4") liveBatter.fours++;
      if (result.outcome === "6") liveBatter.sixes++;
    }

    // Update raw bowler stats
    const rawBowl = rawInnings.bowlerStats[bowlerId] ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
    rawBowl.balls++;
    rawBowl.runs += result.runs + result.extras;
    if (ni.currentOverLegalBalls === 6) {
      rawBowl.overs++;
      rawBowl.balls = 0;
    }
    rawInnings.bowlerStats[bowlerId] = rawBowl;

    // Update live bowler stats
    const liveBowler = newState.bowlerStats.find(b => b.playerId === bowlerId)!;
    liveBowler.runs += result.runs + result.extras;
    if (result.runs === 0 && !result.isWicket && result.outcome !== "legbye") {
      liveBowler.dots++;
    }

    if (result.isWicket) {
      newState.wickets++;
      rawInnings.wickets++;
      if (rawBat) rawBat.isOut = true;

      // Update live batter
      if (liveBatter) {
        liveBatter.isOut = true;
        // Build howOut
        const bowlerName = pm[bowlerId]?.name ?? "unknown";
        if (wicketType === "bowled") liveBatter.howOut = `b ${bowlerName}`;
        else if (wicketType === "caught") liveBatter.howOut = `c ${fielderName} b ${bowlerName}`;
        else if (wicketType === "lbw") liveBatter.howOut = `lbw b ${bowlerName}`;
        else if (wicketType === "run_out") liveBatter.howOut = `run out`;
        else if (wicketType === "stumped") liveBatter.howOut = `st ${fielderName ?? "keeper"} b ${bowlerName}`;
      }

      // Fall of wicket
      const overBall = `${newState.overs}.${ni.currentOverLegalBalls}`;
      const fow = `${newState.score}/${newState.wickets} (${overBall} ov)`;
      newState.fallOfWickets.push(fow);
      if (liveBatter) liveBatter.fallOfWicket = fow;

      liveBowler.wickets++;

      // Bring in next batter
      if (newState.nextBatterIdx < ni.battingOrderIds.length) {
        const isUserBatting = ni.userTeamId !== null && newState.battingTeamId === ni.userTeamId;
        const remainingBatterCount = ni.battingOrderIds.length - newState.nextBatterIdx;

        if (isUserBatting && remainingBatterCount > 1) {
          // User gets to choose who comes in next
          const options = ni.battingOrderIds.slice(newState.nextBatterIdx);
          const optionDetails: PendingDecisionOption[] = options.map(id => {
            const p = pm[id];
            return {
              playerId: id,
              playerName: p.name,
              role: p.role,
              battingOvr: p.battingOvr,
              bowlingOvr: p.bowlingOvr,
              overall: p.overall,
            };
          });
          newState.pendingDecision = {
            type: 'choose_batter',
            options,
            teamId: newState.battingTeamId,
            optionDetails,
          };
          newState.status = "waiting_for_decision";
        } else {
          // Auto-select (CPU or only one option)
          bringInNextBatter(newState, ni, pm, rawInnings);
        }
      }
    } else if (result.runs % 2 === 1) {
      // Odd runs = swap strike
      const temp = newState.strikerIdx;
      newState.strikerIdx = newState.nonStrikerIdx;
      newState.nonStrikerIdx = temp;
      const tempName = newState.strikerName;
      newState.strikerName = newState.nonStrikerName;
      newState.nonStrikerName = tempName;
    }
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
  };

  newState.ballLog.push(detailedBall);
  if (newState.innings === 1) {
    newState.innings1BallLog.push(detailedBall);
  } else {
    newState.innings2BallLog.push(detailedBall);
  }

  // Check for end of over
  if (ni.currentOverLegalBalls >= 6) {
    // Update bowler overs
    ni.bowlerOvers[bowlerId] = (ni.bowlerOvers[bowlerId] ?? 0) + 1;
    ni.lastBowlerId = bowlerId;

    // Update live bowler stats
    const liveBowler = newState.bowlerStats.find(b => b.playerId === bowlerId)!;
    liveBowler.overs++;
    liveBowler.balls = 0;

    // Check for maiden
    const overBalls = rawInnings.ballLog.filter(
      b => b.over === newState.overs && b.bowler === bowlerId &&
      b.outcome !== "wide" && b.outcome !== "noball"
    );
    if (overBalls.length === 6 && overBalls.every(b => b.runs === 0 && b.extras === 0 && !b.isWicket)) {
      liveBowler.maidens++;
    }

    newState.overs++;
    newState.balls = 0;
    ni.currentOverLegalBalls = 0;
    rawInnings.overs = newState.overs;
    rawInnings.balls = 0;

    // Swap strike at end of over
    const temp = newState.strikerIdx;
    newState.strikerIdx = newState.nonStrikerIdx;
    newState.nonStrikerIdx = temp;
    const tempName = newState.strikerName;
    newState.strikerName = newState.nonStrikerName;
    newState.nonStrikerName = tempName;

    // Pick next bowler if innings continues (and no pending batter decision)
    if (newState.status !== "waiting_for_decision" &&
        newState.overs < maxOvers && newState.wickets < 10 &&
        !(isSecondInnings && newState.score >= target)) {
      const isUserBowling = ni.userTeamId !== null && newState.bowlingTeamId === ni.userTeamId;

      // Build eligible bowler list
      const eligibleBowlerIds = getEligibleBowlerIds(ni.bowlingOrderIds, ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId);

      if (isUserBowling && eligibleBowlerIds.length > 1) {
        // User picks the bowler
        const optionDetails: PendingDecisionOption[] = eligibleBowlerIds.map(id => {
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
            oversBowled,
            oversRemaining: ni.maxOversPerBowler - oversBowled,
            runsConceded: liveStat?.runs ?? 0,
            wicketsTaken: liveStat?.wickets ?? 0,
            economy: liveStat && (liveStat.overs > 0 || liveStat.balls > 0)
              ? Math.round((liveStat.runs / (liveStat.overs + liveStat.balls / 6)) * 100) / 100
              : 0,
            dots: liveStat?.dots ?? 0,
          };
        });
        newState.pendingDecision = {
          type: 'choose_bowler',
          options: eligibleBowlerIds,
          teamId: newState.bowlingTeamId,
          optionDetails,
        };
        newState.status = "waiting_for_decision";
      } else {
        // CPU auto-picks or only one option
        const nextBowlerIdx = pickNextBowler(ni.bowlingOrderIds, ni.bowlerOvers, ni.maxOversPerBowler, ni.lastBowlerId, pm);
        assignNextBowler(newState, ni, pm, nextBowlerIdx);
      }
    }
  } else {
    newState.balls = ni.currentOverLegalBalls;
  }

  // Check for innings end conditions
  const inningsEnded =
    newState.wickets >= 10 ||
    newState.overs >= maxOvers ||
    (isSecondInnings && newState.score >= target);

  if (inningsEnded) {
    if (newState.innings === 1) {
      // Save innings 1 data and transition to innings break
      newState.innings1Score = newState.score;
      newState.innings1Wickets = newState.wickets;
      newState.innings1Overs = formatOvers(newState.overs, ni.currentOverLegalBalls);
      newState.target = newState.score + 1;

      // Save raw innings 1
      ni.innings1Raw = JSON.parse(JSON.stringify(rawInnings));

      // Build innings 1 scorecard for display
      newState.innings1Scorecard = buildLiveInningsScorecard(
        newState.batterStats,
        newState.bowlerStats,
        newState.battingTeamId,
        getBattingTeamName(newState),
        newState.bowlingTeamId,
        getBowlingTeamName(newState),
        newState.score,
        newState.wickets,
        formatOvers(newState.overs, ni.currentOverLegalBalls >= 6 ? 0 : ni.currentOverLegalBalls),
        newState.fallOfWickets,
        rawInnings,
      );

      newState.status = "innings_break";
    } else {
      // Match completed
      completeMatch(newState);
    }
  }

  return { state: newState, ball: detailedBall };
}

/* ─────────────────── Helper: bring in next batter (auto) ─────────────────── */

function bringInNextBatter(
  state: MatchState,
  ni: MatchStateInternal,
  pm: Record<string, SerializedPlayer>,
  rawInnings: InningsScoreRaw,
): void {
  const nextBatterId = ni.battingOrderIds[state.nextBatterIdx];
  const nextBatter = pm[nextBatterId];
  state.strikerIdx = state.nextBatterIdx;
  state.nextBatterIdx++;
  state.strikerName = nextBatter.name;

  if (!state.batterStats.find(b => b.playerId === nextBatterId)) {
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
  }

  if (!rawInnings.batterStats[nextBatterId]) {
    rawInnings.batterStats[nextBatterId] = { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false };
  }
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

  const newState: MatchState = JSON.parse(JSON.stringify(state));
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

  switch (pending.type) {
    case 'choose_batter': {
      // Re-order the batting lineup so the chosen batter comes next
      const chosenId = decision.selectedPlayerId;
      const currentIdx = newState.nextBatterIdx;
      const chosenPosInOrder = ni.battingOrderIds.indexOf(chosenId);

      if (chosenPosInOrder >= currentIdx) {
        // Swap the chosen batter to the nextBatterIdx position
        const existingAtIdx = ni.battingOrderIds[currentIdx];
        ni.battingOrderIds[currentIdx] = chosenId;
        ni.battingOrderIds[chosenPosInOrder] = existingAtIdx;
      }

      // Now bring in the batter
      bringInNextBatter(newState, ni, pm, rawInnings);
      break;
    }

    case 'choose_bowler': {
      // Find the index of the chosen bowler in the bowling order
      const chosenId = decision.selectedPlayerId;
      const idx = ni.bowlingOrderIds.indexOf(chosenId);
      if (idx < 0) {
        throw new Error(`Bowler ${chosenId} not found in bowling order`);
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
  }

  // Clear the pending decision and resume
  newState.pendingDecision = undefined;
  newState.status = "in_progress";

  return newState;
}

/**
 * Get impact sub options for a team (for the UI to display at innings break).
 * Returns null if the team can't use an impact sub.
 */
export function getImpactSubOptions(
  state: MatchState,
  teamId: string,
): { benchPlayers: PendingDecisionOption[]; xiPlayers: PendingDecisionOption[] } | null {
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

  return { benchPlayers, xiPlayers };
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

  const newState: MatchState = JSON.parse(JSON.stringify(state));
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

/**
 * Start the second innings (call after innings_break status).
 */
export function startSecondInnings(state: MatchState): MatchState {
  if (state.status !== "innings_break") {
    throw new Error("Cannot start 2nd innings: match is not at innings break");
  }

  const newState: MatchState = JSON.parse(JSON.stringify(state));
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
      // Pick the batter with highest batting OVR
      let bestId = pending.options[0];
      let bestOvr = pm[bestId]?.battingOvr ?? 0;
      for (const id of pending.options) {
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
      // Skip impact sub when auto-resolving
      const newState: MatchState = JSON.parse(JSON.stringify(state));
      newState.pendingDecision = undefined;
      newState.status = "in_progress";
      return newState;
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
  })).filter(b => b.balls > 0 || b.howOut !== "not out");

  const inn2Bowlers: BowlerFigures[] = state.bowlerStats
    .filter(b => b.overs > 0 || b.balls > 0)
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

  // Calculate extras for innings 2
  let inn2Wides = 0, inn2NoBalls = 0, inn2LegByes = 0;
  for (const ball of state.innings2BallLog) {
    if (ball.eventType === "wide") inn2Wides += ball.extras;
    else if (ball.eventType === "noball") inn2NoBalls += ball.extras;
    else if (ball.eventType === "legbye") inn2LegByes += ball.extras;
  }

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
      wides: inn2Wides,
      noBalls: inn2NoBalls,
      legByes: inn2LegByes,
      total: inn2Wides + inn2NoBalls + inn2LegByes,
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
 */
export function deserializeMatchState(data: any): MatchState {
  // The state is already a plain object from JSON.parse, just cast it
  return data as MatchState;
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

  // Sort by bowling OVR descending and pick randomly from top 3
  eligibleIndices.sort((a, b) => (pm[b.id]?.bowlingOvr ?? 0) - (pm[a.id]?.bowlingOvr ?? 0));
  const pick = eligibleIndices[Math.floor(Math.random() * Math.min(3, eligibleIndices.length))];
  return pick.idx;
}

function formatOvers(overs: number, ballsInOver: number): string {
  if (ballsInOver === 0 || ballsInOver >= 6) {
    return `${overs}.0`;
  }
  return `${overs}.${ballsInOver}`;
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
): InningsScorecard {
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
    }));

  const bowlers: BowlerFigures[] = bowlerStats
    .filter(b => b.overs > 0 || b.balls > 0)
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

  // Calculate extras
  let wides = 0, noBalls = 0, legByes = 0;
  for (const ball of rawInnings.ballLog) {
    if (ball.outcome === "wide") wides += ball.extras;
    else if (ball.outcome === "noball") noBalls += ball.extras;
    else if (ball.outcome === "legbye") legByes += ball.extras;
  }

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
      wides,
      noBalls,
      legByes,
      total: wides + noBalls + legByes,
    },
    fallOfWickets,
  };
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
    // Tie — award to team with more boundaries (fours + sixes)
    const team1Boundaries = (state.innings1Scorecard?.batters ?? []).reduce(
      (sum, b) => sum + (b.fours ?? 0) + (b.sixes ?? 0), 0
    );
    // batterStats at this point holds innings 2 batters (bowlingFirstId team)
    const team2Boundaries = state.batterStats
      .reduce((sum, b) => sum + (b.fours ?? 0) + (b.sixes ?? 0), 0);

    if (team1Boundaries > team2Boundaries) {
      state.winnerId = int.battingFirstId;
      state.result = `${battingFirstName} won by boundary count (${team1Boundaries}-${team2Boundaries})`;
    } else if (team2Boundaries > team1Boundaries) {
      state.winnerId = int.bowlingFirstId;
      state.result = `${bowlingFirstName} won by boundary count (${team2Boundaries}-${team1Boundaries})`;
    } else {
      // True tie — coin flip
      state.result = "Match tied";
      state.winnerId = int.battingFirstId;
    }
  }

  // Calculate man of the match
  state.manOfTheMatch = calculateLiveMOTM(state);
  state.status = "completed";
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
