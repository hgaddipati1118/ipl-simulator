/**
 * Ball-by-ball T20 match simulation engine.
 * Ported and enhanced from IndianCricketLeague/GameClass.js
 *
 * Uses a multi-layer probability system:
 *   1. Base outcome matrix (batter rating x bowler rating)
 *   2. Phase multipliers (powerplay / middle / death)
 *   3. Chase context (required run rate in 2nd innings)
 *   4. Pressure/clutch factors
 *   5. Stadium bowling rating (home advantage)
 *
 * Supports IPL rule sets including the Impact Player substitution rule.
 */

import { Player } from "./player.js";
import { Team } from "./team.js";
import { clamp, weightedRandom } from "./math.js";
import { DEFAULT_RULES, type RuleSet } from "./rules.js";
import { runPostMatchInjuryChecks, type InjuryStatus } from "./injury.js";

export type BallOutcome = "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball" | "legbye";

export interface BallEvent {
  over: number;
  ball: number;
  bowler: string;
  batter: string;
  outcome: BallOutcome;
  runs: number;       // runs scored off this ball
  extras: number;     // extra runs (wides, noballs)
  isWicket: boolean;
  commentary: string;
}

export interface ImpactSubEvent {
  subIn: string;    // player ID brought in
  subOut: string;   // player ID replaced
  overUsed: number; // over at which substitution happened
  side: "batting" | "bowling"; // which side used it
}

export interface InningsScore {
  teamId: string;
  runs: number;
  wickets: number;
  overs: number;      // completed overs
  balls: number;      // balls in current over
  totalBalls: number; // total legal deliveries faced
  extras: number;
  fours: number;
  sixes: number;
  ballLog: BallEvent[];
  batterStats: Map<string, { runs: number; balls: number; fours: number; sixes: number; isOut: boolean }>;
  bowlerStats: Map<string, { overs: number; balls: number; runs: number; wickets: number; wides: number; noballs: number }>;
  impactSub?: ImpactSubEvent;
}

export interface MatchInjuryEvent {
  playerId: string;
  playerName: string;
  teamId: string;
  injury: InjuryStatus;
}

/* ───── Detailed scorecard types (from WT2) ───── */

export interface DetailedBallEvent {
  over: number;        // 0-19
  ball: number;        // 1-6 (legal deliveries)
  innings: 1 | 2;
  batterName: string;
  bowlerName: string;
  runs: number;
  extras: number;
  eventType: "dot" | "single" | "double" | "triple" | "four" | "six" | "wicket" | "wide" | "noball" | "legbye";
  wicketType?: "bowled" | "caught" | "lbw" | "run_out" | "stumped";
  fielderName?: string;
  commentary: string;
  scoreSoFar: number;
  wicketsSoFar: number;
}

export interface BatterInnings {
  playerId: string;
  playerName: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  strikeRate: number;
  howOut: string;       // "c Jadeja b Bumrah" or "not out"
  fallOfWicket?: string; // "45/3 (8.2 ov)"
}

export interface BowlerFigures {
  playerId: string;
  playerName: string;
  overs: string;       // "4.0" or "3.2"
  maidens: number;
  runs: number;
  wickets: number;
  economy: number;
  dots: number;
  wides: number;
  noBalls: number;
}

export interface InningsScorecard {
  battingTeamId: string;
  battingTeamName: string;
  bowlingTeamId: string;
  bowlingTeamName: string;
  totalRuns: number;
  totalWickets: number;
  totalOvers: string;
  batters: BatterInnings[];
  bowlers: BowlerFigures[];
  extras: { wides: number; noBalls: number; legByes: number; total: number };
  fallOfWickets: string[];
}

export interface DetailedMatchResult {
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName: string;
  awayTeamName: string;
  tossWinner: string;
  tossWinnerName: string;
  tossDecision: "bat" | "bowl";
  innings1: InningsScorecard;
  innings2: InningsScorecard;
  ballLog: DetailedBallEvent[];
  result: string;
  manOfTheMatch: { playerId: string; playerName: string; reason: string };
  venue: string;
}

export interface MatchResult {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  tossWinner: string;
  tossDecision: "bat" | "bowl";
  innings: [InningsScore, InningsScore];
  superOver?: [InningsScore, InningsScore];
  winnerId: string | null; // null for tie/no result
  margin: string;    // "5 wickets", "23 runs", "Super Over"
  motm: string;      // man of the match player id
  injuries: MatchInjuryEvent[];  // players injured during this match
  detailed?: DetailedMatchResult; // full scorecard data
}

/** Phase of the innings based on over number */
function getPhase(over: number): "powerplay" | "middle" | "death" {
  if (over < 6) return "powerplay";
  if (over < 15) return "middle";
  return "death";
}

/** Phase multipliers for outcome probabilities
 * Tuned to match IPL 2025 real-world benchmarks:
 *   - Avg innings score ~200-210, RR ~10.0-10.4
 *   - Powerplay: more boundaries, fewer dots
 *   - Middle: more dots, fewer boundaries (spin-dominant)
 *   - Death: big sixes, more wickets, more wides
 */
const PHASE_MULTIPLIERS: Record<string, Record<string, number>> = {
  // Real IPL 2025 phase patterns:
  // PP (1-6): RR ~9.5, more 4s (fielding restrictions), fewer wickets
  // Mid (7-15): RR ~8.5, spin-dominant, fewer boundaries, more dots
  // Death (16-20): RR ~12+, big sixes, more wickets/wides, aggressive batting
  powerplay: { dot: 0.90, "1": 1.05, "2": 0.85, "3": 0.8, "4": 1.25, "6": 0.90, wicket: 0.80, wide: 1.05, noball: 1.0 },
  middle:    { dot: 1.10, "1": 1.05, "2": 1.05, "3": 1.0, "4": 0.82, "6": 0.75, wicket: 1.05, wide: 0.85, noball: 0.9 },
  death:     { dot: 0.85, "1": 0.85, "2": 1.15, "3": 1.3, "4": 1.05, "6": 1.40, wicket: 1.15, wide: 1.20, noball: 1.2 },
};

/** Generate base outcome probabilities from batter and bowler ratings */
function baseOutcomeProbabilities(
  batter: Player,
  bowler: Player,
): Record<BallOutcome, number> {
  const batRating = (batter.battingOvr + batter.ratings.timing) / 2 / 100;
  const bowlRating = (bowler.bowlingOvr + bowler.ratings.accuracy) / 2 / 100;

  // Balance between batter and bowler determines distribution
  const balance = batRating - bowlRating; // -1 to 1, positive favors batter

  // Tuned to match real IPL 2025 ball-outcome distributions:
  //   dots ~38-40%, singles ~30-33%, 2s/3s ~5-7%, 4s ~8-10%, 6s ~5-7%, wickets ~4-5%, wides ~3-4%
  //   Target avg innings score: ~200-210 (combined ~400-420)
  return {
    dot:    clamp(0.33 - balance * 0.10, 0.18, 0.50),
    "1":    clamp(0.32 + balance * 0.02, 0.22, 0.40),
    "2":    clamp(0.07 + balance * 0.02, 0.03, 0.12),
    "3":    clamp(0.015, 0.005, 0.03),
    "4":    clamp(0.085 + balance * 0.038 + (batter.ratings.timing / 100) * 0.02, 0.03, 0.16),
    "6":    clamp(0.058 + balance * 0.034 + (batter.ratings.power / 100) * 0.027, 0.01, 0.14),
    wicket: clamp(0.04 - balance * 0.025 + (bowler.ratings.wicketTaking / 100) * 0.02, 0.01, 0.10),
    wide:   clamp(0.04 - (bowler.ratings.accuracy / 100) * 0.015, 0.012, 0.07),
    noball:  clamp(0.008 - (bowler.ratings.accuracy / 100) * 0.004, 0.002, 0.025),
    legbye: 0.02,
  };
}

/** Adjust probabilities for chase context in 2nd innings */
function chaseAdjustment(
  probs: Record<BallOutcome, number>,
  requiredRate: number,
  currentRate: number,
  wicketsDown: number,
): Record<BallOutcome, number> {
  const pressure = (requiredRate - currentRate) / 8; // normalized pressure (-1 to 1+)
  const wicketPressure = wicketsDown >= 7 ? 0.3 : wicketsDown >= 5 ? 0.15 : 0;

  const adjusted = { ...probs };
  if (pressure > 0) {
    // Need to accelerate — capped to avoid runaway boundary inflation
    const cappedPressure = Math.min(pressure, 1.5);
    adjusted["4"] *= 1 + cappedPressure * 0.2;
    adjusted["6"] *= 1 + cappedPressure * 0.3;
    adjusted.dot *= 1 - cappedPressure * 0.15;
    adjusted.wicket *= 1 + cappedPressure * 0.2 + wicketPressure;
  } else {
    // Comfortable position, play safe
    adjusted.dot *= 1 + Math.abs(pressure) * 0.1;
    adjusted["1"] *= 1 + Math.abs(pressure) * 0.1;
    adjusted.wicket *= 1 - Math.abs(pressure) * 0.1;
  }

  return adjusted;
}

/** Simulate a single ball */
function simulateBall(
  batter: Player,
  bowler: Player,
  over: number,
  isSecondInnings: boolean,
  target: number,
  currentScore: number,
  ballsRemaining: number,
  wicketsDown: number,
  stadiumBowlRating: number,
): BallEvent {
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

  // Determine runs
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

  return {
    over,
    ball: 0, // filled in by innings simulation
    bowler: bowler.id,
    batter: batter.id,
    outcome,
    runs,
    extras,
    isWicket,
    commentary,
  };
}

/** Determine wicket type with realistic distribution */
function randomWicketType(): "bowled" | "caught" | "lbw" | "run_out" | "stumped" {
  const r = Math.random();
  if (r < 0.55) return "caught";
  if (r < 0.75) return "bowled";
  if (r < 0.90) return "lbw";
  if (r < 0.97) return "run_out";
  return "stumped";
}

/** Pick a random fielding position name */
function randomFielderPosition(): string {
  const positions = [
    "point", "cover", "mid-off", "mid-on", "midwicket", "square leg",
    "fine leg", "third man", "long-on", "long-off", "deep midwicket",
    "deep square leg", "deep cover", "slip", "gully", "short leg",
  ];
  return positions[Math.floor(Math.random() * positions.length)];
}

/** Pick a random shot description for boundaries */
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
  over: number,
  runs: number,
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

/** Create empty innings score */
function emptyInnings(teamId: string): InningsScore {
  return {
    teamId, runs: 0, wickets: 0, overs: 0, balls: 0,
    totalBalls: 0, extras: 0, fours: 0, sixes: 0,
    ballLog: [],
    batterStats: new Map(),
    bowlerStats: new Map(),
  };
}

// ── Impact Player Logic ──────────────────────────────────────────────────

/** Check if an overseas impact sub can legally enter (max overseas on field per rules) */
function canUseOverseasSub(sub: Player, currentXI: Player[], subOut: Player, maxOverseas = 4): boolean {
  if (!sub.isInternational) return true;
  const currentOverseas = currentXI.filter(p => p.isInternational).length;
  const afterSwap = currentOverseas - (subOut.isInternational ? 1 : 0) + 1;
  return afterSwap <= maxOverseas;
}

/** AI decides whether and how to use the batting impact sub */
function evaluateBattingImpact(
  over: number,
  innings: InningsScore,
  battingOrder: Player[],
  subs: Player[],
  currentXI: Player[],
  currentBatterIdx: number,
): { subIn: Player; subOut: Player } | null {
  if (subs.length === 0) return null;

  const bestBatSub = subs.reduce((best, s) =>
    s.battingOvr > best.battingOvr ? s : best, subs[0]);
  const unbatted = battingOrder.slice(currentBatterIdx);
  if (unbatted.length === 0) return null;

  const weakest = unbatted.reduce((w, p) =>
    p.battingOvr < w.battingOvr ? p : w, unbatted[0]);

  const shouldUse =
    (over >= 14 && bestBatSub.battingOvr > weakest.battingOvr) ||
    (innings.wickets >= 3 && over < 10) ||
    (over >= 10 && bestBatSub.battingOvr > weakest.battingOvr + 5);

  if (shouldUse && canUseOverseasSub(bestBatSub, currentXI, weakest)) {
    return { subIn: bestBatSub, subOut: weakest };
  }

  return null;
}

/** AI decides whether and how to use the bowling impact sub */
function evaluateBowlingImpact(
  over: number,
  innings: InningsScore,
  bowlers: Player[],
  subs: Player[],
  currentXI: Player[],
): { subIn: Player; subOut: Player } | null {
  if (subs.length === 0) return null;

  const bestBowlSub = subs.reduce((best, s) =>
    s.bowlingOvr > best.bowlingOvr ? s : best, subs[0]);
  const weakestBowler = bowlers.reduce((w, p) =>
    p.bowlingOvr < w.bowlingOvr ? p : w, bowlers[0]);

  const runRate = innings.totalBalls > 0 ? (innings.runs / innings.totalBalls) * 6 : 0;

  const shouldUse =
    (over >= 13 && bestBowlSub.bowlingOvr > weakestBowler.bowlingOvr) ||
    (over >= 6 && runRate > 9.5 && bestBowlSub.bowlingOvr > weakestBowler.bowlingOvr) ||
    (over >= 8 && bestBowlSub.bowlingOvr > weakestBowler.bowlingOvr + 5);

  if (shouldUse && canUseOverseasSub(bestBowlSub, currentXI, weakestBowler)) {
    return { subIn: bestBowlSub, subOut: weakestBowler };
  }

  return null;
}

// ── Innings Simulation ───────────────────────────────────────────────────

/** Simulate one full innings (max 20 overs or 10 wickets) */
function simulateInnings(
  battingTeam: Team,
  bowlingTeam: Team,
  xi: Player[],
  bowlingXI: Player[],
  isSecondInnings: boolean,
  target: number,
  stadiumBowlRating: number,
  maxOvers = 20,
  battingSubs: Player[] = [],
  bowlingSubs: Player[] = [],
): InningsScore {
  const innings = emptyInnings(battingTeam.id);
  const battingOrder = battingTeam.getBattingOrder(xi);
  const bowlers = bowlingTeam.getBowlingOrder(bowlingXI);

  // Safety: need at least 2 batters and 1 bowler
  if (battingOrder.length < 2 || bowlers.length < 1) {
    return innings;
  }

  let strikerIdx = 0;
  let nonStrikerIdx = 1;
  let currentBatterIdx = 2; // next batter to come in

  // Initialize batter stats
  for (const p of battingOrder) {
    innings.batterStats.set(p.id, { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false });
  }

  // Bowling allocation: each bowler can bowl max 4 overs (or 1 in super over)
  const maxOversPerBowler = maxOvers === 1 ? 1 : 4;
  const bowlerOvers = new Map<string, number>();
  for (const b of bowlers) bowlerOvers.set(b.id, 0);

  // Impact player tracking (each side gets one sub per innings)
  let battingImpactUsed = false;
  let bowlingImpactUsed = false;
  const availBattingSubs = [...battingSubs];
  const availBowlingSubs = [...bowlingSubs];

  for (let over = 0; over < maxOvers; over++) {
    // ── Impact Player evaluation (between overs) ──
    if (maxOvers > 1) { // not in super over
      // Batting team impact sub
      if (!battingImpactUsed && availBattingSubs.length > 0) {
        const decision = evaluateBattingImpact(
          over, innings, battingOrder, availBattingSubs, [...battingOrder], currentBatterIdx,
        );
        if (decision) {
          const outIdx = battingOrder.indexOf(decision.subOut);
          if (outIdx >= 0 && outIdx >= currentBatterIdx) {
            battingOrder[outIdx] = decision.subIn;
            innings.batterStats.set(decision.subIn.id, { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false });
            innings.impactSub = { subIn: decision.subIn.id, subOut: decision.subOut.id, overUsed: over, side: "batting" };
            battingImpactUsed = true;
            availBattingSubs.length = 0;
          }
        }
      }

      // Bowling team impact sub
      if (!bowlingImpactUsed && availBowlingSubs.length > 0) {
        const decision = evaluateBowlingImpact(
          over, innings, bowlers, availBowlingSubs, [...bowlingXI],
        );
        if (decision) {
          const outIdx = bowlers.indexOf(decision.subOut);
          if (outIdx >= 0) {
            bowlers[outIdx] = decision.subIn;
            bowlerOvers.set(decision.subIn.id, 0);
            if (!innings.impactSub) {
              innings.impactSub = { subIn: decision.subIn.id, subOut: decision.subOut.id, overUsed: over, side: "bowling" };
            }
            bowlingImpactUsed = true;
            availBowlingSubs.length = 0;
          }
        }
      }
    }

    // Pick bowler (can't bowl consecutive overs, max 4 each)
    const lastBowlerId = innings.ballLog.length > 0
      ? innings.ballLog[innings.ballLog.length - 1].bowler
      : null;

    let eligibleBowlers = bowlers.filter(b =>
      (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler &&
      b.id !== lastBowlerId
    );

    // If no one eligible (consecutive-over rule conflict), relax the consecutive rule
    if (eligibleBowlers.length === 0) {
      eligibleBowlers = bowlers.filter(b =>
        (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler
      );
    }

    const bowler = eligibleBowlers.length > 0
      ? eligibleBowlers.sort((a, b) => b.bowlingOvr - a.bowlingOvr)[
          Math.floor(Math.random() * Math.min(3, eligibleBowlers.length))
        ]
      : bowlers[0]; // absolute fallback

    let ballsInOver = 0;
    let legalBalls = 0;

    while (legalBalls < 6) {
      const striker = battingOrder[strikerIdx];
      const ballsRemaining = (maxOvers - over) * 6 - legalBalls;

      const event = simulateBall(
        striker,
        bowler,
        over,
        isSecondInnings,
        target,
        innings.runs,
        ballsRemaining,
        innings.wickets,
        stadiumBowlRating,
      );

      event.ball = legalBalls + 1;
      innings.ballLog.push(event);

      // Update scores
      if (event.outcome === "wide" || event.outcome === "noball") {
        innings.runs += event.extras;
        innings.extras += event.extras;
        const bs = innings.bowlerStats.get(bowler.id) ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
        bs.runs += event.extras;
        if (event.outcome === "wide") bs.wides++;
        else bs.noballs++;
        innings.bowlerStats.set(bowler.id, bs);
      } else {
        legalBalls++;
        innings.totalBalls++;
        innings.runs += event.runs + event.extras;
        innings.extras += event.extras;

        // Update batter stats
        const batStat = innings.batterStats.get(striker.id)!;
        batStat.balls++;
        batStat.runs += event.runs;
        if (event.outcome === "4") { batStat.fours++; innings.fours++; }
        if (event.outcome === "6") { batStat.sixes++; innings.sixes++; }

        // Update bowler stats
        const bs = innings.bowlerStats.get(bowler.id) ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
        bs.balls++;
        bs.runs += event.runs + event.extras;
        if (legalBalls === 6) {
          bs.overs++;
          bs.balls = 0;
        }
        innings.bowlerStats.set(bowler.id, bs);

        if (event.isWicket) {
          innings.wickets++;
          batStat.isOut = true;
          bs.wickets++;
          if (currentBatterIdx < battingOrder.length) {
            strikerIdx = currentBatterIdx;
            currentBatterIdx++;
          }
          if (innings.wickets >= 10) break;
        } else if (event.runs % 2 === 1) {
          // Odd runs = swap strike
          [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
        }
      }

      // Check if target reached
      if (isSecondInnings && innings.runs >= target) break;
    }

    // Update over count
    bowlerOvers.set(bowler.id, (bowlerOvers.get(bowler.id) ?? 0) + 1);
    innings.overs = over + 1;
    innings.balls = 0;

    // Swap strike at end of over
    [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];

    if (innings.wickets >= 10) break;
    if (isSecondInnings && innings.runs >= target) break;
  }

  return innings;
}

/** Update player season stats from innings */
function updatePlayerStats(
  team: Team,
  innings: InningsScore,
  matchId: string,
  bowlingInnings: InningsScore,
): void {
  for (const player of team.roster) {
    const batStat = innings.batterStats.get(player.id);
    const bowlStat = bowlingInnings.bowlerStats.get(player.id);

    if (batStat) {
      player.stats.matches++;
      if (batStat.balls > 0) {
        player.stats.innings++;
        player.stats.runs += batStat.runs;
        player.stats.ballsFaced += batStat.balls;
        player.stats.fours += batStat.fours;
        player.stats.sixes += batStat.sixes;
        if (!batStat.isOut) player.stats.notOuts++;
        if (batStat.runs > player.stats.highScore) player.stats.highScore = batStat.runs;
        if (batStat.runs >= 100) player.stats.hundreds++;
        else if (batStat.runs >= 50) player.stats.fifties++;
      }
    }

    if (bowlStat && (bowlStat.overs > 0 || bowlStat.balls > 0)) {
      const overs = bowlStat.overs + bowlStat.balls / 10; // display format
      player.stats.overs += overs;
      player.stats.runsConceded += bowlStat.runs;
      player.stats.wickets += bowlStat.wickets;
    }

    player.stats.matchLog.push({
      matchId,
      runsScored: batStat?.runs ?? 0,
      ballsFaced: batStat?.balls ?? 0,
      fours: batStat?.fours ?? 0,
      sixes: batStat?.sixes ?? 0,
      wicketsTaken: bowlStat?.wickets ?? 0,
      oversBowled: bowlStat ? bowlStat.overs + bowlStat.balls / 10 : 0,
      runsConceded: bowlStat?.runs ?? 0,
    });
  }
}

/** Calculate man of the match — returns { playerId, reason } */
function calculateMOTM(
  homeTeam: Team,
  awayTeam: Team,
  innings1: InningsScore,
  innings2: InningsScore,
): { playerId: string; reason: string } {
  let bestScore = -1;
  let bestPlayer = "";
  let bestReason = "";

  const allPlayers = [...homeTeam.roster, ...awayTeam.roster];

  for (const player of allPlayers) {
    const batStat1 = innings1.batterStats.get(player.id);
    const batStat2 = innings2.batterStats.get(player.id);
    const bowlStat1 = innings1.bowlerStats?.get(player.id);
    const bowlStat2 = innings2.bowlerStats?.get(player.id);

    let score = 0;

    // Batting contribution
    const runs = (batStat1?.runs ?? 0) + (batStat2?.runs ?? 0);
    const balls = (batStat1?.balls ?? 0) + (batStat2?.balls ?? 0);
    score += runs * 1.5;
    if (balls > 0) score += ((runs / balls) * 100 - 120) * 0.3; // SR bonus
    score += ((batStat1?.sixes ?? 0) + (batStat2?.sixes ?? 0)) * 3;

    // Bowling contribution
    const wickets = (bowlStat1?.wickets ?? 0) + (bowlStat2?.wickets ?? 0);
    score += wickets * 25;
    const bowlRuns = (bowlStat1?.runs ?? 0) + (bowlStat2?.runs ?? 0);
    const bowlOvers = (bowlStat1?.overs ?? 0) + (bowlStat2?.overs ?? 0);
    if (bowlOvers > 0) {
      const econ = bowlRuns / bowlOvers;
      score += (8 - econ) * 5; // bonus for economy under 8
    }

    if (score > bestScore) {
      bestScore = score;
      bestPlayer = player.id;
      // Build a reason string
      const parts: string[] = [];
      if (runs > 0) parts.push(`${runs}(${balls})`);
      if (wickets > 0) parts.push(`${wickets}/${bowlRuns}`);
      bestReason = parts.join(" & ");
    }
  }

  return { playerId: bestPlayer, reason: bestReason };
}

/* ───── Build detailed match result from raw innings data (from WT2) ───── */

function buildInningsScorecard(
  inningsScore: InningsScore,
  battingTeam: Team,
  bowlingTeam: Team,
  battingXI: Player[],
  bowlingXI: Player[],
): InningsScorecard {
  const playerMap = new Map<string, Player>();
  for (const p of [...battingTeam.roster, ...bowlingTeam.roster]) {
    playerMap.set(p.id, p);
  }

  const battingOrder = battingTeam.getBattingOrder(battingXI);
  const batters: BatterInnings[] = [];
  const fallOfWickets: string[] = [];

  let runsSoFar = 0;
  let wicketsSoFar = 0;
  const fowMap = new Map<string, string>();

  for (const ball of inningsScore.ballLog) {
    if (ball.outcome === "wide" || ball.outcome === "noball") {
      runsSoFar += ball.extras;
    } else {
      runsSoFar += ball.runs + ball.extras;
      if (ball.isWicket) {
        wicketsSoFar++;
        const overBall = `${ball.over}.${ball.ball}`;
        const fowStr = `${runsSoFar}/${wicketsSoFar} (${overBall} ov)`;
        fowMap.set(ball.batter, fowStr);
        fallOfWickets.push(fowStr);
      }
    }
  }

  let totalWides = 0;
  let totalNoBalls = 0;
  let totalLegByes = 0;
  for (const ball of inningsScore.ballLog) {
    if (ball.outcome === "wide") totalWides += ball.extras;
    else if (ball.outcome === "noball") totalNoBalls += ball.extras;
    else if (ball.outcome === "legbye") totalLegByes += ball.extras;
  }

  for (const batter of battingOrder) {
    const stat = inningsScore.batterStats.get(batter.id);
    if (!stat) continue;
    if (stat.balls === 0 && !stat.isOut) continue;

    let howOut = "not out";
    if (stat.isOut) {
      const dismissalBall = inningsScore.ballLog.find(
        b => b.batter === batter.id && b.isWicket
      );
      if (dismissalBall) {
        const bowlerPlayer = playerMap.get(dismissalBall.bowler);
        const bowlerName = bowlerPlayer?.name ?? "unknown";
        const wicketType = randomWicketType();
        switch (wicketType) {
          case "bowled":
            howOut = `b ${bowlerName}`;
            break;
          case "caught": {
            const fielders = bowlingXI.filter(p => p.id !== dismissalBall.bowler);
            const fielder = fielders[Math.floor(Math.random() * fielders.length)];
            howOut = `c ${fielder?.name ?? randomFielderPosition()} b ${bowlerName}`;
            break;
          }
          case "lbw":
            howOut = `lbw b ${bowlerName}`;
            break;
          case "run_out":
            howOut = `run out`;
            break;
          case "stumped": {
            const keeper = bowlingXI.find(p => p.isWicketKeeper);
            howOut = `st ${keeper?.name ?? "keeper"} b ${bowlerName}`;
            break;
          }
        }
      }
    }

    batters.push({
      playerId: batter.id,
      playerName: batter.name,
      runs: stat.runs,
      balls: stat.balls,
      fours: stat.fours,
      sixes: stat.sixes,
      strikeRate: stat.balls > 0 ? Math.round((stat.runs / stat.balls) * 1000) / 10 : 0,
      howOut,
      fallOfWicket: fowMap.get(batter.id),
    });
  }

  const bowlers: BowlerFigures[] = [];
  const bowlingOrder = bowlingTeam.getBowlingOrder(bowlingXI);

  for (const bowler of bowlingOrder) {
    const stat = inningsScore.bowlerStats.get(bowler.id);
    if (!stat) continue;
    if (stat.overs === 0 && stat.balls === 0) continue;

    const oversStr = stat.balls > 0 ? `${stat.overs}.${stat.balls}` : `${stat.overs}.0`;

    let dots = 0;
    let maidens = 0;
    const overBuckets = new Map<number, number[]>();

    for (const ball of inningsScore.ballLog) {
      if (ball.bowler !== bowler.id) continue;
      if (ball.outcome === "wide" || ball.outcome === "noball") continue;
      if (ball.runs === 0 && !ball.isWicket && ball.outcome !== "legbye") {
        dots++;
      }
      const overIdx = ball.over;
      if (!overBuckets.has(overIdx)) overBuckets.set(overIdx, []);
      overBuckets.get(overIdx)!.push(ball.runs + ball.extras);
    }

    for (const [, ballRuns] of overBuckets) {
      if (ballRuns.length === 6 && ballRuns.every(r => r === 0)) {
        maidens++;
      }
    }

    const effectiveOvers = stat.overs + stat.balls / 6;
    bowlers.push({
      playerId: bowler.id,
      playerName: bowler.name,
      overs: oversStr,
      maidens,
      runs: stat.runs,
      wickets: stat.wickets,
      economy: effectiveOvers > 0 ? Math.round((stat.runs / effectiveOvers) * 100) / 100 : 0,
      dots,
      wides: stat.wides,
      noBalls: stat.noballs,
    });
  }

  const lastBall = inningsScore.ballLog[inningsScore.ballLog.length - 1];
  let oversDisplay: string;
  if (lastBall) {
    const legalBallsInLastOver = lastBall.ball;
    if (legalBallsInLastOver === 6) {
      oversDisplay = `${lastBall.over + 1}.0`;
    } else {
      oversDisplay = `${lastBall.over}.${legalBallsInLastOver}`;
    }
  } else {
    oversDisplay = "0.0";
  }

  return {
    battingTeamId: battingTeam.id,
    battingTeamName: battingTeam.name,
    bowlingTeamId: bowlingTeam.id,
    bowlingTeamName: bowlingTeam.name,
    totalRuns: inningsScore.runs,
    totalWickets: inningsScore.wickets,
    totalOvers: oversDisplay,
    batters,
    bowlers,
    extras: {
      wides: totalWides,
      noBalls: totalNoBalls,
      legByes: totalLegByes,
      total: totalWides + totalNoBalls + totalLegByes,
    },
    fallOfWickets,
  };
}

function buildDetailedBallLog(
  innings: InningsScore,
  inningsNumber: 1 | 2,
  playerMap: Map<string, Player>,
): DetailedBallEvent[] {
  let runsSoFar = 0;
  let wicketsSoFar = 0;

  return innings.ballLog.map(ball => {
    const batterPlayer = playerMap.get(ball.batter);
    const bowlerPlayer = playerMap.get(ball.bowler);

    if (ball.outcome === "wide" || ball.outcome === "noball") {
      runsSoFar += ball.extras;
    } else {
      runsSoFar += ball.runs + ball.extras;
      if (ball.isWicket) wicketsSoFar++;
    }

    let eventType: DetailedBallEvent["eventType"];
    switch (ball.outcome) {
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
    if (ball.isWicket) {
      wicketType = randomWicketType();
      if (wicketType === "caught") {
        fielderName = randomFielderPosition();
      }
    }

    return {
      over: ball.over,
      ball: ball.ball,
      innings: inningsNumber,
      batterName: batterPlayer?.name ?? ball.batter,
      bowlerName: bowlerPlayer?.name ?? ball.bowler,
      runs: ball.runs,
      extras: ball.extras,
      eventType,
      wicketType,
      fielderName,
      commentary: ball.commentary,
      scoreSoFar: runsSoFar,
      wicketsSoFar,
    };
  });
}

function buildDetailedResult(
  matchId: string,
  homeTeam: Team,
  awayTeam: Team,
  battingFirst: Team,
  bowlingFirst: Team,
  innings1: InningsScore,
  innings2: InningsScore,
  firstXI: Player[],
  firstBowlXI: Player[],
  secondXI: Player[],
  secondBowlXI: Player[],
  winnerId: string | null,
  margin: string,
  tossWinner: Team,
  tossDecision: "bat" | "bowl",
  motm: { playerId: string; reason: string },
): DetailedMatchResult {
  const playerMap = new Map<string, Player>();
  for (const p of [...homeTeam.roster, ...awayTeam.roster]) {
    playerMap.set(p.id, p);
  }

  const motmPlayer = playerMap.get(motm.playerId);
  const winnerTeam = winnerId ? (winnerId === homeTeam.id ? homeTeam : awayTeam) : null;
  const resultText = winnerTeam
    ? `${winnerTeam.name} won by ${margin}`
    : `Match tied`;

  const inn1Scorecard = buildInningsScorecard(innings1, battingFirst, bowlingFirst, firstXI, firstBowlXI);
  const inn2Scorecard = buildInningsScorecard(innings2, bowlingFirst, battingFirst, secondXI, secondBowlXI);

  const ballLog1 = buildDetailedBallLog(innings1, 1, playerMap);
  const ballLog2 = buildDetailedBallLog(innings2, 2, playerMap);

  return {
    matchId,
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    homeTeamName: homeTeam.name,
    awayTeamName: awayTeam.name,
    tossWinner: tossWinner.id,
    tossWinnerName: tossWinner.name,
    tossDecision,
    innings1: inn1Scorecard,
    innings2: inn2Scorecard,
    ballLog: [...ballLog1, ...ballLog2],
    result: resultText,
    manOfTheMatch: {
      playerId: motm.playerId,
      playerName: motmPlayer?.name ?? "Unknown",
      reason: motm.reason,
    },
    venue: `${homeTeam.config.city}`,
  };
}

let matchCounter = 0;

/** Simulate a full T20 match between two teams */
export function simulateMatch(
  homeTeam: Team,
  awayTeam: Team,
  rules: RuleSet = DEFAULT_RULES,
): MatchResult {
  const matchId = `match_${++matchCounter}`;

  const homeXI = homeTeam.getPlayingXI(rules.maxOverseasInXI);
  const awayXI = awayTeam.getPlayingXI(rules.maxOverseasInXI);

  // Impact player subs (empty arrays if rule is off)
  const homeSubs = rules.impactPlayer ? homeTeam.getImpactSubs(homeXI) : [];
  const awaySubs = rules.impactPlayer ? awayTeam.getImpactSubs(awayXI) : [];

  // Toss
  const tossWinner = Math.random() < 0.5 ? homeTeam : awayTeam;
  const tossDecision: "bat" | "bowl" = Math.random() < 0.6 ? "bowl" : "bat";

  const battingFirst = tossDecision === "bat" ? tossWinner : (tossWinner === homeTeam ? awayTeam : homeTeam);
  const bowlingFirst = battingFirst === homeTeam ? awayTeam : homeTeam;

  const stadiumRating = homeTeam.config.stadiumBowlingRating ?? 1.0;

  // Determine XIs and subs for each side
  const firstXI = battingFirst === homeTeam ? homeXI : awayXI;
  const firstBowlXI = battingFirst === homeTeam ? awayXI : homeXI;
  const firstBatSubs = battingFirst === homeTeam ? homeSubs : awaySubs;
  const firstBowlSubs = battingFirst === homeTeam ? awaySubs : homeSubs;

  // Adjust stadium rating for scoring multiplier (WPL = lower scoring)
  const adjustedStadiumRating = stadiumRating * (2 - rules.scoringMultiplier);

  // First innings
  const innings1 = simulateInnings(
    battingFirst, bowlingFirst,
    firstXI, firstBowlXI,
    false, 0, adjustedStadiumRating, 20,
    firstBatSubs, firstBowlSubs,
  );

  // Second innings
  const target = innings1.runs + 1;
  const secondXI = bowlingFirst === homeTeam ? homeXI : awayXI;
  const secondBowlXI = bowlingFirst === homeTeam ? awayXI : homeXI;
  const secondBatSubs = bowlingFirst === homeTeam ? homeSubs : awaySubs;
  const secondBowlSubs = bowlingFirst === homeTeam ? awaySubs : homeSubs;

  const innings2 = simulateInnings(
    bowlingFirst, battingFirst,
    secondXI, secondBowlXI,
    true, target, adjustedStadiumRating, 20,
    secondBatSubs, secondBowlSubs,
  );

  // Determine winner
  let winnerId: string | null;
  let margin: string;

  if (innings2.runs >= target) {
    winnerId = bowlingFirst.id;
    margin = `${10 - innings2.wickets} wickets`;
  } else if (innings2.runs < innings1.runs) {
    winnerId = battingFirst.id;
    margin = `${innings1.runs - innings2.runs} runs`;
  } else {
    // Tie -> Super Over (no impact subs in super over)
    let so1 = simulateInnings(battingFirst, bowlingFirst, firstXI, firstBowlXI, false, 0, adjustedStadiumRating, 1);
    let so2 = simulateInnings(bowlingFirst, battingFirst, secondXI, secondBowlXI, true, so1.runs + 1, adjustedStadiumRating, 1);

    if (so2.runs > so1.runs) {
      winnerId = bowlingFirst.id;
    } else if (so1.runs > so2.runs) {
      winnerId = battingFirst.id;
    } else if (rules.superOverTieBreaker === "repeated-super-over") {
      while (so2.runs === so1.runs) {
        so1 = simulateInnings(battingFirst, bowlingFirst, firstXI, firstBowlXI, false, 0, adjustedStadiumRating, 1);
        so2 = simulateInnings(bowlingFirst, battingFirst, secondXI, secondBowlXI, true, so1.runs + 1, adjustedStadiumRating, 1);
      }
      winnerId = so2.runs > so1.runs ? bowlingFirst.id : battingFirst.id;
    } else {
      // Boundary count-back
      const homeBatInnings = battingFirst === homeTeam ? innings1 : innings2;
      const awayBatInnings = battingFirst === awayTeam ? innings1 : innings2;
      const homeBoundaries = homeBatInnings.fours + homeBatInnings.sixes;
      const awayBoundaries = awayBatInnings.fours + awayBatInnings.sixes;
      winnerId = homeBoundaries >= awayBoundaries ? homeTeam.id : awayTeam.id;
    }
    margin = "Super Over";
  }

  // Update team records
  const winner = winnerId === homeTeam.id ? homeTeam : awayTeam;
  const loser = winner === homeTeam ? awayTeam : homeTeam;

  winner.wins++;
  loser.losses++;

  // Update NRR components
  const team1Batting = battingFirst === homeTeam ? innings1 : innings2;
  const team1Bowling = battingFirst === homeTeam ? innings2 : innings1;
  const team2Batting = battingFirst === awayTeam ? innings1 : innings2;
  const team2Bowling = battingFirst === awayTeam ? innings2 : innings1;

  homeTeam.runsFor += team1Batting.runs;
  homeTeam.ballsFacedFor += team1Batting.totalBalls;
  homeTeam.runsAgainst += team1Bowling.runs;
  homeTeam.ballsFacedAgainst += team1Bowling.totalBalls;
  homeTeam.updateNRR();

  awayTeam.runsFor += team2Batting.runs;
  awayTeam.ballsFacedFor += team2Batting.totalBalls;
  awayTeam.runsAgainst += team2Bowling.runs;
  awayTeam.ballsFacedAgainst += team2Bowling.totalBalls;
  awayTeam.updateNRR();

  // Update player stats
  updatePlayerStats(battingFirst, innings1, matchId, innings2);
  updatePlayerStats(bowlingFirst, innings2, matchId, innings1);

  // Run injury checks using the injury system (WT3)
  const injuries: MatchInjuryEvent[] = [];
  const injuriesEnabled = rules.injuriesEnabled ?? true;
  const homeInjuries = runPostMatchInjuryChecks(homeXI, injuriesEnabled);
  for (const { player, injury } of homeInjuries) {
    injuries.push({
      playerId: player.id,
      playerName: player.name,
      teamId: homeTeam.id,
      injury,
    });
  }
  const awayInjuries = runPostMatchInjuryChecks(awayXI, injuriesEnabled);
  for (const { player, injury } of awayInjuries) {
    injuries.push({
      playerId: player.id,
      playerName: player.name,
      teamId: awayTeam.id,
      injury,
    });
  }

  const motm = calculateMOTM(homeTeam, awayTeam, innings1, innings2);

  // Build detailed scorecard (WT2)
  const detailed = buildDetailedResult(
    matchId, homeTeam, awayTeam,
    battingFirst, bowlingFirst,
    innings1, innings2,
    firstXI, firstBowlXI,
    secondXI, secondBowlXI,
    winnerId, margin,
    tossWinner, tossDecision,
    motm,
  );

  return {
    id: matchId,
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    tossWinner: tossWinner.id,
    tossDecision,
    innings: [innings1, innings2],
    winnerId,
    margin,
    motm: motm.playerId,
    injuries,
    detailed,
  };
}
