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
import { getMoraleModifier, getClutchMoraleModifier } from "./morale.js";
import { runPostMatchInjuryChecks, type InjuryStatus } from "./injury.js";
import {
  decideTossChoice,
  getMatchPhase,
  getMatchupModifiers,
  isPaceBowler,
  type BoundarySize,
  type DewFactor,
  type PitchType,
} from "./matchups.js";
import { createRNG, randomSeed, type RNG } from "./rng.js";
import {
  getVenueProfileForTeam,
  getLeagueChaseAdvantage,
  getNeutralVenueProfile,
  applyVenueProfile,
  applyChaseEdge,
  deriveStadiumBowlingRating,
  type VenueProfile,
} from "./venues.js";
import { LEGACY_STADIUM_BOWLING_RATINGS } from "./team.js";
import { describeDelivery, retiredHurtLine, retiredOutLine, timedOutLine } from "./delivery-text.js";
import {
  applyFieldingToProbs,
  buildFieldingUnit,
  fieldingCommentary,
  pickKeeper,
  resolveWicketChance,
  type FieldingNote,
  type FieldingUnit,
  type WicketKind,
} from "./fielding.js";
import { T20_FORMAT, matchFormatFor, phaseOver, type MatchFormatSpec } from "./format.js";
import {
  EXTRAS_RATE_CAL,
  trimRunningRuns,
  SUPER_OVER_CAL,
  applyFreeHitToProbs,
  dismissalText,
  expandDelivery,
  genderOf,
  isBowlerWicket,
  retireParams,
  RETIRED_HURT_TEXT,
  type DismissalKind,
  type Gender,
} from "./delivery-rules.js";

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
  /** How the batter was dismissed (set on wicket balls; decided at the ball, see fielding.ts) */
  wicketType?: DismissalKind;
  /** Fielder who took the catch / made the stumping / threw at the stumps (id) */
  fielderId?: string;
  /** A put-down catch, great catch, missed stumping, ... on this ball (the ball itself did not end in a wicket for misses) */
  fieldingNote?: FieldingNote;
  // ── Match rules detail (RULES-MATCH.md section 12). All optional: old logs lack them and read as before ──
  /** The batter at the other end when the ball was bowled */
  nonStriker?: string;
  /** For a wicket: the dismissed batter (absent = the striker, which is who every older log dismisses) */
  playerOutId?: string;
  /** Second fielder of a relay run out */
  fielder2Id?: string;
  /** The catch / run out was made by a substitute fielder */
  substitute?: boolean;
  /** Extras by type; `extras` is their sum. `runs` is what the striker scored off the bat (completed runs on a run-out ball) */
  wides?: number;
  noBalls?: number;
  byes?: number;
  legByes?: number;
  penaltyRuns?: number;
  /** 4 or 6 when the bat hit a boundary (counts as a four / six; overthrow boundaries do not) */
  boundary?: 4 | 6;
  /** Overthrow boundary runs inside `runs` / `byes` / `legByes` */
  overthrow?: number;
  /** This ball was a free hit */
  freeHit?: boolean;
  /** Where a wide went */
  wideKind?: "off" | "leg" | "height";
  /** Runs the batters physically ran (strike changes on odd) */
  runsRun?: number;
  /** After a wicket: the incoming batter faces the next ball (before any end-of-over change) */
  newBatterFaces?: boolean;
  /** No delivery was bowled (Mankad run out at the non-striker's end): not a ball of the over */
  deadBall?: boolean;
  /** The bowler was replaced mid-over (injury) from this ball on */
  bowlerChanged?: boolean;
}

/** A batter who left the innings away from a delivery: timed out, retired out, retired hurt */
export interface OffBallDismissal {
  playerId: string;
  kind: "timed_out" | "retired_out" | "retired_hurt";
  over: number;
  /** Legal balls bowled in the over when it happened */
  ball: number;
  runs: number;
  wickets: number;
  /** What the commentary says about it */
  commentary?: string;
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
  batterStats: Map<string, { runs: number; balls: number; fours: number; sixes: number; isOut: boolean; retiredHurt?: boolean }>;
  bowlerStats: Map<string, { overs: number; balls: number; runs: number; wickets: number; wides: number; noballs: number }>;
  impactSub?: ImpactSubEvent;
  /** Extras by type (the total is `extras`) */
  extrasBreakdown?: { wides: number; noBalls: number; byes: number; legByes: number; penalty: number };
  /** Timed out / retired out / retired hurt */
  offBall?: OffBallDismissal[];
  /** Super over innings: the batters and the bowler that were nominated */
  superOver?: { batters: string[]; bowler: string };
  /** Balls per over (set) in this innings' format: 6 for T20, 5 for The Hundred. Absent = 6. */
  ballsPerOver?: number;
}

export interface MatchInjuryEvent {
  playerId: string;
  playerName: string;
  teamId: string;
  injury: InjuryStatus;
}

interface VenueContext {
  stadiumBowlRating: number;
  pitchType: PitchType;
  boundarySize: BoundarySize;
  dewFactor: DewFactor;
  /** Measured home-ground conditions (null at neutral venues and for unmapped teams) */
  profile: VenueProfile | null;
  /** P(chaser wins) - 0.5 for equal sides at this venue */
  chaseAdvantage: number;
  /** Men's or women's cricket (extras and dismissal mixes are fitted per gender) */
  gender?: Gender;
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
  wicketType?: DismissalKind;
  fielderName?: string;
  commentary: string;
  scoreSoFar: number;
  wicketsSoFar: number;
  /** Name of the dismissed batter when it is not the striker (non-striker run out) */
  playerOutName?: string;
  freeHit?: boolean;
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
  extras: { wides: number; noBalls: number; legByes: number; total: number; byes?: number; penalty?: number };
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
  /** The deciding super over: [bats first, bats second] (the side that batted second in the match bats first) */
  superOver?: [InningsScore, InningsScore];
  /** Every super over played, in order */
  superOverRounds?: [InningsScore, InningsScore][];
  winnerId: string | null; // null for tie/no result
  margin: string;    // "5 wickets", "23 runs", "Super Over"
  motm: string;      // man of the match player id
  injuries: MatchInjuryEvent[];  // players injured during this match
  detailed?: DetailedMatchResult; // full scorecard data
}

export interface MatchOptions {
  neutralVenue?: boolean;
  countTowardStandings?: boolean;
  venueName?: string;
}

/** Phase multipliers for outcome probabilities (aligned with live-match.ts)
 * Target avg innings score: 160-175
 */
const PHASE_MULTIPLIERS: Record<"powerplay" | "middle" | "death", Partial<Record<BallOutcome, number>>> = {
  powerplay: { dot: 0.82, "1": 0.98, "2": 0.9, "3": 1.0, "4": 1.30, "6": 1.15, wicket: 0.88, wide: 1.1, noball: 1.0 },
  middle:    { dot: 1.10, "1": 1.08, "2": 1.0, "3": 1.0, "4": 0.90, "6": 0.83, wicket: 1.01, wide: 0.9, noball: 1.0 },
  death:     { dot: 0.76, "1": 0.87, "2": 1.12, "3": 1.1, "4": 1.24, "6": 1.32, wicket: 1.18, wide: 1.2, noball: 1.1 },
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

  // Tuned to match IPL 2025 ball-outcome distributions:
  //   IPL 2025 had 52 scores above 200, avg innings ~178, record boundaries
  //   Target avg innings score: 175-185 (Impact Player era, flat pitches, short boundaries)
  const p: Record<BallOutcome, number> = {
    dot:    clamp(0.355 - balance * 0.12, 0.19, 0.50),
    "1":    clamp(0.278 + balance * 0.02, 0.19, 0.37),
    "2":    clamp(0.052 + balance * 0.015, 0.02, 0.10),
    "3":    clamp(0.011, 0.005, 0.025),
    "4":    clamp(0.112 + balance * 0.038 + (batter.ratings.timing / 100) * 0.019, 0.04, 0.19),
    "6":    clamp(0.050 + balance * 0.028 + (batter.ratings.power / 100) * 0.022, 0.012, 0.13),
    wicket: clamp(0.044 - balance * 0.025 + (bowler.ratings.wicketTaking / 100) * 0.019, 0.013, 0.095),
    wide:   clamp(0.031 - (bowler.ratings.accuracy / 100) * 0.012, 0.009, 0.06) * EXTRAS_RATE_CAL.wide,
    noball:  clamp(0.005 - (bowler.ratings.accuracy / 100) * 0.003, 0.001, 0.02) * EXTRAS_RATE_CAL.noball,
    legbye: 0.015 * EXTRAS_RATE_CAL.legbye,
  };
  trimRunningRuns(p);
  return p;
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
    // Need to accelerate — modest boosts, significant wicket risk
    const cappedPressure = Math.min(pressure, 1.5);
    adjusted["4"] *= 1 + cappedPressure * 0.10;
    adjusted["6"] *= 1 + cappedPressure * 0.15;
    adjusted.dot *= 1 - cappedPressure * 0.08;
    adjusted.wicket *= 1 + cappedPressure * 0.30 + wicketPressure;
  } else {
    // Comfortable position — play safe, suppress boundaries, protect wickets
    const comfort = Math.min(Math.abs(pressure), 1.5);
    adjusted.dot *= 1 + comfort * 0.18;
    adjusted["1"] *= 1 + comfort * 0.12;
    adjusted["4"] *= 1 - comfort * 0.12;
    adjusted["6"] *= 1 - comfort * 0.18;
    adjusted.wicket *= 1 - comfort * 0.12;
  }

  return adjusted;
}

/** What the Laws and the format add to a ball: free hit, format (no-ball cost), gender, substitute fielders */
interface BallRules {
  freeHit: boolean;
  fmt: MatchFormatSpec;
  gender: Gender;
  bench?: readonly Player[];
  /** A super over: wickets come faster (SUPER_OVER_CAL) */
  superOver?: boolean;
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
  venue: VenueContext,
  rng: RNG = Math.random,
  fieldingUnit?: FieldingUnit,
  inningsBalls = 120,
  rules: BallRules = { freeHit: false, fmt: T20_FORMAT, gender: "male" },
  nonStriker?: Player,
): BallEvent {
  let probs = baseOutcomeProbabilities(batter, bowler);

  // Phase adjustment
  const phase = getMatchPhase(over);
  const phaseMult = PHASE_MULTIPLIERS[phase];
  for (const key of Object.keys(probs) as BallOutcome[]) {
    probs[key] *= phaseMult[key] ?? 1;
  }

  // Stadium bowling adjustment — dampened to keep IPL 2025 scoring era feel.
  // With a measured ground this is neutral unless the stadium editor changed the rating.
  const stadiumEffect = 1 + (venue.stadiumBowlRating - 1) * 0.5;
  probs.wicket *= stadiumEffect;
  probs.dot *= stadiumEffect;

  // Measured ground: run / six / wicket factors and bowler-type edges
  if (venue.profile) applyVenueProfile(probs, venue.profile, bowler.bowlingStyle);
  if (isSecondInnings) applyChaseEdge(probs, venue.chaseAdvantage);

  // Style, handedness, and venue context
  const matchupMods = getMatchupModifiers({
    bowlingStyle: bowler.bowlingStyle,
    battingHand: batter.battingHand,
    over,
    pitchType: venue.pitchType,
    boundarySize: venue.boundarySize,
    dewFactor: venue.dewFactor,
    isSecondInnings,
    measuredVenue: venue.profile !== null,
  });
  probs.wicket *= matchupMods.wicketMod;
  probs["4"] *= matchupMods.fourMod;
  probs["6"] *= matchupMods.sixMod;
  probs.dot *= matchupMods.dotMod;

  // Ball change rule (IPL 2026): after over 10 in 2nd innings, drier ball helps pace
  if (isSecondInnings && over >= 10) {
    const bowlStyle = bowler.bowlingStyle;
    if (bowlStyle && isPaceBowler(bowlStyle)) {
      probs.wicket *= 1.08;
      probs["4"] *= 0.95;
      probs.dot *= 1.04;
    }
  }

  // Chase context
  if (isSecondInnings && ballsRemaining > 0) {
    const requiredRate = ((target - currentScore) / ballsRemaining) * 6;
    const currentRate = ballsRemaining < inningsBalls
      ? (currentScore / (inningsBalls - ballsRemaining)) * 6
      : 0;
    probs = chaseAdjustment(probs, requiredRate, currentRate, wicketsDown);
  }

  // Clutch factor for last 3 overs in close games
  if (over >= 17 && isSecondInnings) {
    const runsNeeded = target - currentScore;
    if (runsNeeded > 0 && runsNeeded <= 30) {
      const clutchBalance = (batter.ratings.clutch * getClutchMoraleModifier(batter) - bowler.ratings.clutch * getClutchMoraleModifier(bowler)) / 100;
      probs["6"] *= 1 + clutchBalance * 0.3;
      probs["4"] *= 1 + clutchBalance * 0.2;
      probs.wicket *= 1 - clutchBalance * 0.2;
    }
  }

  // Morale modifier: happy batters perform slightly better, unhappy slightly worse
  const batterMoraleMod = getMoraleModifier(batter);
  const bowlerMoraleMod = getMoraleModifier(bowler);
  probs["4"] *= batterMoraleMod;
  probs["6"] *= batterMoraleMod;
  probs.wicket *= bowlerMoraleMod;
  probs.dot *= bowlerMoraleMod;

  if (rules.superOver) { probs.wicket *= SUPER_OVER_CAL.wicket; probs["4"] *= SUPER_OVER_CAL.boundary; probs["6"] *= SUPER_OVER_CAL.boundary; }

  // A free hit: boundaries come easier and only the run-out family can dismiss
  if (rules.freeHit) applyFreeHitToProbs(probs);

  // Fielding: runs saved, byes, and dismissal chances (catches / stumpings / run-outs are converted or put down)
  applyFieldingToProbs(probs, fieldingUnit, bowler.bowlingStyle, rules.gender);

  // Normalize and sample
  const entries = Object.entries(probs) as [BallOutcome, number][];
  let outcome = weightedRandom(entries, rng);

  // A wicket draw is a dismissal chance: decide its kind and who was involved, and whether it was taken
  let resolution: ReturnType<typeof resolveWicketChance> | undefined;
  if (outcome === "wicket") {
    resolution = resolveWicketChance(fieldingUnit, bowler.id, bowler.bowlingStyle, probs, rng, {
      gender: rules.gender, freeHit: rules.freeHit, bench: rules.bench,
    });
    if (resolution.outcome !== "wicket") outcome = resolution.outcome;
  }

  // The complete delivery: wides, no-ball cost, byes, overthrows, who is out, how far they ran
  const detail = expandDelivery(outcome, resolution, {
    rng, fmt: rules.fmt, gender: rules.gender, freeHit: rules.freeHit,
    bowlerId: bowler.id, bowlerStyle: bowler.bowlingStyle, unit: fieldingUnit, bench: rules.bench,
  });
  return buildBallEvent(detail, resolution, batter, nonStriker, bowler, over, rules.freeHit, rng);
}

/** Wrap a finished delivery into a ball-log event with its commentary */
function buildBallEvent(
  detail: ReturnType<typeof expandDelivery>,
  resolution: ReturnType<typeof resolveWicketChance> | undefined,
  batter: Player,
  nonStriker: Player | undefined,
  bowler: Player,
  over: number,
  freeHit: boolean,
  rng: RNG,
): BallEvent {
  const dis = detail.dismissal;
  const outcome = dis ? (detail.outcome === "wide" || detail.outcome === "noball" ? detail.outcome : "wicket") : detail.outcome;
  const fielderPlayer = (id?: string): string | undefined => {
    if (!id) return undefined;
    return resolution?.fielder?.id === id ? resolution.fielder.name : resolution?.fielder2?.id === id ? resolution.fielder2.name : undefined;
  };
  const special = describeDelivery({
    detail: { ...detail, outcome },
    bowler: bowler.name, batter: batter.name, nonStriker: nonStriker?.name,
    fielder: fielderPlayer(dis?.fielderId), fielder2: fielderPlayer(dis?.fielder2Id), substitute: dis?.substitute,
    freeHit, rng,
  });
  const fieldingLine = !dis && resolution?.note
    ? fieldingCommentary(resolution, { batter: batter.name, bowler: bowler.name, runs: detail.batRuns }, rng)
    : undefined;
  const commentary = special ?? fieldingLine ?? generateCommentary(outcome === "wicket" ? "wicket" : outcome, batter.name, bowler.name, over, detail.batRuns, rng);

  const event: BallEvent = {
    over,
    ball: 0, // filled in by innings simulation
    bowler: bowler.id,
    batter: batter.id,
    outcome,
    runs: detail.batRuns,
    extras: detail.extras,
    isWicket: !!dis,
    commentary: (freeHit && !special ? "FREE HIT! " : "") + commentary,
    runsRun: detail.runsRun,
  };
  if (nonStriker) event.nonStriker = nonStriker.id;
  if (detail.wides) event.wides = detail.wides;
  if (detail.noBalls) event.noBalls = detail.noBalls;
  if (detail.byes) event.byes = detail.byes;
  if (detail.legByes) event.legByes = detail.legByes;
  if (detail.penalty) event.penaltyRuns = detail.penalty;
  if (detail.batBoundary) event.boundary = detail.batBoundary;
  if (detail.overthrow) event.overthrow = detail.overthrow;
  if (detail.wideKind) event.wideKind = detail.wideKind;
  if (freeHit) event.freeHit = true;
  if (dis) {
    event.wicketType = dis.kind;
    event.newBatterFaces = dis.newBatterFaces;
    if (dis.out === "nonStriker" && nonStriker) event.playerOutId = nonStriker.id;
    if (dis.fielderId) event.fielderId = dis.fielderId;
    if (dis.fielder2Id) event.fielder2Id = dis.fielder2Id;
    if (dis.substitute) event.substitute = true;
  } else if (resolution?.note) {
    if (resolution.fielder) event.fielderId = resolution.fielder.id;
    event.fieldingNote = resolution.note;
  }
  if (dis && resolution?.note) event.fieldingNote = resolution.note;
  return event;
}

/** Determine wicket type with realistic distribution */
function randomWicketType(rng: RNG = Math.random): "bowled" | "caught" | "lbw" | "run_out" | "stumped" {
  // Only used for logs saved before dismissal kinds were decided at the ball
  const r = rng();
  if (r < 0.55) return "caught";
  if (r < 0.75) return "bowled";
  if (r < 0.90) return "lbw";
  if (r < 0.97) return "run_out";
  return "stumped";
}

/** Pick a random fielding position name */
function randomFielderPosition(rng: RNG = Math.random): string {
  const positions = [
    "point", "cover", "mid-off", "mid-on", "midwicket", "square leg",
    "fine leg", "third man", "long-on", "long-off", "deep midwicket",
    "deep square leg", "deep cover", "slip", "gully", "short leg",
  ];
  return positions[Math.floor(rng() * positions.length)];
}

/** Pick a random shot description for boundaries */
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

function generateCommentary(
  outcome: BallOutcome,
  batter: string,
  bowler: string,
  over: number,
  runs: number,
  rng: RNG = Math.random,
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
      `${bowler} to ${batter}, FOUR! ${randomBoundaryShot(4, rng)}`,
      `${bowler} to ${batter}, FOUR! ${randomBoundaryShot(4, rng)}`,
      `${bowler} to ${batter}, FOUR! That races away to the boundary!`,
    ],
    "6": [
      `${bowler} to ${batter}, SIX! ${randomBoundaryShot(6, rng)}!`,
      `${bowler} to ${batter}, SIX! ${randomBoundaryShot(6, rng)}!`,
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
  return options[Math.floor(rng() * options.length)];
}

/** Create empty innings score */
function emptyInnings(teamId: string, ballsPerOver = 6): InningsScore {
  return {
    ...(ballsPerOver !== 6 ? { ballsPerOver } : {}),
    teamId, runs: 0, wickets: 0, overs: 0, balls: 0,
    totalBalls: 0, extras: 0, fours: 0, sixes: 0,
    ballLog: [],
    batterStats: new Map(),
    bowlerStats: new Map(),
  };
}

function getVenueContext(
  homeTeam: Team,
  rules: RuleSet,
  options?: MatchOptions,
): VenueContext {
  const leagueChase = getLeagueChaseAdvantage(rules.league, rules.gender);
  if (options?.neutralVenue) {
    return {
      stadiumBowlRating: 1.0 * (2 - rules.scoringMultiplier),
      pitchType: "balanced",
      boundarySize: "medium",
      dewFactor: "none",
      profile: getNeutralVenueProfile(rules.league),
      chaseAdvantage: leagueChase,
      gender: genderOf(rules),
    };
  }

  const profile = getVenueProfileForTeam(homeTeam.config.venueTeamId ?? homeTeam.id);
  return {
    stadiumBowlRating: stadiumRatingFor(homeTeam, profile) * (2 - rules.scoringMultiplier),
    pitchType: homeTeam.config.pitchType ?? "balanced",
    boundarySize: homeTeam.config.boundarySize ?? "medium",
    dewFactor: homeTeam.config.dewFactor ?? "none",
    profile,
    chaseAdvantage: profile?.chaseAdvantage ?? leagueChase,
    gender: genderOf(rules),
  };
}

/**
 * Stadium rating to feed the legacy stadium effect. For a measured ground the measured factors do
 * the work, so only a user's edit in the stadium editor (relative to the measured default) applies.
 * An old save still holding the pre-measurement hand-set default counts as unedited.
 */
export function stadiumRatingFor(team: Team, profile: VenueProfile | null): number {
  const rating = team.config.stadiumBowlingRating ?? 1.0;
  if (!profile) return rating;
  const measuredDefault = deriveStadiumBowlingRating(profile);
  const legacy = LEGACY_STADIUM_BOWLING_RATINGS[team.id];
  if (legacy !== undefined && Math.abs(rating - legacy) < 1e-9) return 1.0;
  return rating / measuredDefault;
}

function getNRRBallDenominator(innings: InningsScore, maxBalls = 120): number {
  if (innings.wickets >= 10 && innings.totalBalls < maxBalls) {
    return maxBalls;
  }
  return innings.totalBalls;
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
/** What a super over / a specially staffed innings changes */
interface InningsExtra {
  /** Super over: the nominated batters and bowler; the whole XI still fields; two wickets end the innings */
  superOver?: { batters: Player[]; bowler: Player; fieldXI: Player[] };
}

function simulateInnings(
  battingTeam: Team,
  bowlingTeam: Team,
  xi: Player[],
  bowlingXI: Player[],
  isSecondInnings: boolean,
  target: number,
  venue: VenueContext,
  maxOvers = 20,
  battingSubs: Player[] = [],
  bowlingSubs: Player[] = [],
  rng: RNG = Math.random,
  fmt: MatchFormatSpec = T20_FORMAT,
  extra: InningsExtra = {},
): InningsScore {
  const innings = emptyInnings(battingTeam.id, fmt.ballsPerOver);
  const ballsPerOver = fmt.ballsPerOver;
  const so = extra.superOver;
  const battingOrder = so ? [...so.batters] : battingTeam.getBattingOrder(xi);
  const bowlers = so ? [so.bowler] : bowlingTeam.getBowlingOrder(bowlingXI);
  // The side in the field (an impact sub replaces the player he came on for)
  const fieldXI = so ? [...so.fieldXI] : [...bowlingXI];
  let fieldingUnit = buildFieldingUnit(fieldXI);
  const gender = venue.gender ?? "male";
  const maxWickets = so ? 2 : 10;
  const rp = retireParams();
  const bench: Player[] = bowlingTeam.roster.filter(p => !fieldXI.includes(p) && !p.injured);
  if (so) {
    innings.superOver = { batters: battingOrder.map(p => p.id), bowler: bowlers[0]?.id ?? "" };
  }

  // Safety: need at least 2 batters and 1 bowler
  if (battingOrder.length < 2 || bowlers.length < 1) {
    return innings;
  }

  let strikerIdx = 0;
  let nonStrikerIdx = 1;
  let nextIdx = 2; // next batter to come in
  const retiredHurt: number[] = []; // batters who left hurt and may come back
  let freeHit = false;
  let inningsOver = false;

  // Initialize batter stats
  for (const p of battingOrder) {
    innings.batterStats.set(p.id, { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false });
  }
  innings.extrasBreakdown = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 };
  const offBall: OffBallDismissal[] = [];
  innings.offBall = offBall;

  // Bowling allocation: each bowler can bowl max 4 overs (or 1 in super over)
  const maxOversPerBowler = maxOvers === 1 ? 1 : fmt.maxOversPerBowler;
  let consecutiveOvers = 0; // overs in a row by the current bowler (The Hundred allows two sets in a row)
  const bowlerOvers = new Map<string, number>();
  for (const b of bowlers) bowlerOvers.set(b.id, 0);
  const unavailable = new Set<string>(); // bowlers who left the field hurt

  // Impact player tracking (each side gets one sub per innings)
  let battingImpactUsed = false;
  let bowlingImpactUsed = false;
  const availBattingSubs = [...battingSubs];
  const availBowlingSubs = [...bowlingSubs];

  const logOffBall = (playerId: string, kind: OffBallDismissal["kind"], over: number, ball: number) => {
    const name = battingOrder.find(p => p.id === playerId)?.name ?? playerId;
    const line = kind === "timed_out" ? timedOutLine : kind === "retired_out" ? retiredOutLine : retiredHurtLine;
    offBall.push({ playerId, kind, over, ball, runs: innings.runs, wickets: innings.wickets, commentary: line(name, createRNG(over * 100 + ball + innings.runs)) });
  };

  /** Next batter to the crease: a retired-hurt batter if fit, else the next in the order; -1 when nobody is left */
  const pickNext = (): number => {
    if (retiredHurt.length > 0 && rng() < rp.returnProb) return retiredHurt.shift()!;
    if (nextIdx < battingOrder.length) return nextIdx++;
    return -1;
  };
  /** A batter arrives (he may be timed out); -1 when the innings is over */
  const arrive = (over: number, ball: number): number => {
    for (;;) {
      if (innings.wickets >= maxWickets) return -1;
      const idx = pickNext();
      if (idx < 0) return -1;
      if (!so && rng() < rp.timedOutPerWicket) {
        const st = innings.batterStats.get(battingOrder[idx].id)!;
        st.isOut = true;
        innings.wickets++;
        logOffBall(battingOrder[idx].id, "timed_out", over, ball);
        continue;
      }
      return idx;
    }
  };

  for (let over = 0; over < maxOvers && !inningsOver; over++) {
    // ── Impact Player evaluation (between overs) ──
    if (maxOvers > 1) { // not in super over
      // Batting team impact sub
      if (!battingImpactUsed && availBattingSubs.length > 0) {
        const decision = evaluateBattingImpact(
          over, innings, battingOrder, availBattingSubs, [...battingOrder], nextIdx,
        );
        if (decision) {
          const outIdx = battingOrder.indexOf(decision.subOut);
          if (outIdx >= 0 && outIdx >= nextIdx) {
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
            const fi = fieldXI.indexOf(decision.subOut);
            if (fi >= 0) { fieldXI[fi] = decision.subIn; fieldingUnit = buildFieldingUnit(fieldXI); }
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

    const ableBowlers = bowlers.filter(b => !unavailable.has(b.id));
    let eligibleBowlers = ableBowlers.filter(b =>
      (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler &&
      (b.id !== lastBowlerId || consecutiveOvers < fmt.maxConsecutiveOvers)
    );

    // If no one eligible (consecutive-over rule conflict), relax the consecutive rule
    if (eligibleBowlers.length === 0) {
      eligibleBowlers = ableBowlers.filter(b =>
        (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler
      );
    }

    // A bowler lost to injury can leave the side a bowler short: anyone in the XI with overs to spare steps in
    if (eligibleBowlers.length === 0 && unavailable.size > 0) {
      eligibleBowlers = fieldXI.filter(b => !unavailable.has(b.id) && (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler)
        .sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr);
      for (const b of eligibleBowlers) if (!bowlers.includes(b)) { bowlers.push(b); bowlerOvers.set(b.id, bowlerOvers.get(b.id) ?? 0); }
    }

    if (eligibleBowlers.length === 0) {
      throw new Error(
        `No eligible bowler available for over ${over + 1}. ` +
        `Bowling XI must provide at least ${Math.ceil(maxOvers / maxOversPerBowler)} unique bowling options.`,
      );
    }

    let bowler = eligibleBowlers.sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr)[
      Math.floor(rng() * Math.min(3, eligibleBowlers.length))
    ];

    const streakBefore = consecutiveOvers; // how many overs in a row the last over's bowler had bowled
    consecutiveOvers = bowler.id === lastBowlerId ? consecutiveOvers + 1 : 1;

    let legalBalls = 0;

    while (legalBalls < ballsPerOver) {
      const striker = battingOrder[strikerIdx];
      const nonStriker = battingOrder[nonStrikerIdx];
      const ballsRemaining = (maxOvers - over) * ballsPerOver - legalBalls;

      // ── An over left incomplete: the bowler goes off hurt and another bowler finishes it ──
      if (!so && legalBalls > 0 && rng() < rp.bowlerLeavesPerOver / ballsPerOver) {
        const replPool = [...ableBowlers, ...fieldXI.filter(p => !ableBowlers.includes(p))];
        const repl = replPool
          .filter(b => b.id !== bowler.id && !unavailable.has(b.id) && (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler
            // the bowler who finishes an over may not then be bowling too many overs in a row (Law 17.?: not the previous over's bowler in a T20)
            && (b.id !== lastBowlerId || streakBefore + 1 <= fmt.maxConsecutiveOvers))
          .sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr)[0];
        if (repl) {
          if (!bowlers.includes(repl)) { bowlers.push(repl); bowlerOvers.set(repl.id, 0); }
          unavailable.add(bowler.id);
          bowlerOvers.set(bowler.id, (bowlerOvers.get(bowler.id) ?? 0) + 1);
          consecutiveOvers = repl.id === lastBowlerId ? streakBefore + 1 : 1;
          bowler = repl;
        }
      }

      // ── Mankad: the bowler runs out the non-striker before delivering; no ball is bowled ──
      if (!so && rng() < rp.mankadPerDelivery) {
        const ev: BallEvent = {
          over, ball: legalBalls, bowler: bowler.id, batter: striker.id, nonStriker: nonStriker.id, outcome: "wicket", runs: 0, extras: 0, isWicket: true,
          wicketType: "run_out", playerOutId: nonStriker.id, fielderId: bowler.id, deadBall: true, newBatterFaces: false,
          commentary: describeDelivery({
            detail: { outcome: "wicket", batRuns: 0, wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0, overthrow: 0, dismissal: { kind: "run_out", out: "nonStriker", bowlerCredit: false, newBatterFaces: false } },
            bowler: bowler.name, batter: striker.name, nonStriker: nonStriker.name, deadBall: true, rng,
          })!,
        };
        innings.ballLog.push(ev);
        innings.batterStats.get(nonStriker.id)!.isOut = true;
        innings.wickets++;
        const idx = arrive(over, legalBalls);
        if (idx < 0) { inningsOver = true; break; }
        nonStrikerIdx = idx;
        continue;
      }

      const event = simulateBall(
        striker,
        bowler,
        phaseOver(over, fmt),
        isSecondInnings,
        target,
        innings.runs,
        ballsRemaining,
        innings.wickets,
        venue,
        rng,
        fieldingUnit,
        fmt.totalBalls,
        { freeHit, fmt, gender, bench, superOver: !!so },
        nonStriker,
      );
      event.over = over;
      event.ball = legalBalls + 1;
      const isLegal = event.outcome !== "wide" && event.outcome !== "noball";
      innings.ballLog.push(event);

      // Update scores
      innings.runs += event.runs + event.extras;
      innings.extras += event.extras;
      const eb = innings.extrasBreakdown!;
      eb.wides += event.wides ?? 0; eb.noBalls += event.noBalls ?? 0; eb.byes += event.byes ?? 0;
      eb.legByes += event.legByes ?? 0; eb.penalty += event.penaltyRuns ?? 0;

      const bs = innings.bowlerStats.get(bowler.id) ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
      bs.runs += event.runs + (event.wides ?? 0) + (event.noBalls ?? 0);
      if (event.wides) bs.wides++;
      if (event.noBalls) bs.noballs++;

      const batStat = innings.batterStats.get(striker.id)!;
      // A ball the batter faced: every legal ball and every no-ball, not a wide
      if (event.outcome !== "wide") batStat.balls++;
      batStat.runs += event.runs;
      if (event.boundary === 4) { batStat.fours++; innings.fours++; }
      if (event.boundary === 6) { batStat.sixes++; innings.sixes++; }

      if (isLegal) {
        legalBalls++;
        innings.totalBalls++;
        bs.balls++;
        if (bs.balls === ballsPerOver) {
          bs.overs++;
          bs.balls = 0;
        }
      }
      innings.bowlerStats.set(bowler.id, bs);
      freeHit = event.outcome === "noball" || (freeHit && event.outcome === "wide");

      if (event.isWicket) {
        // Who is out, and who stays
        const outIsNonStriker = event.playerOutId !== undefined && event.playerOutId !== striker.id;
        const outIdx = outIsNonStriker ? nonStrikerIdx : strikerIdx;
        const survivorIdx = outIsNonStriker ? strikerIdx : nonStrikerIdx;
        innings.batterStats.get(battingOrder[outIdx].id)!.isOut = true;
        innings.wickets++;
        if (isBowlerWicket(event.wicketType)) bs.wickets++;
        const idx = arrive(over, legalBalls);
        if (idx < 0) { inningsOver = true; }
        else if (event.newBatterFaces !== false) { strikerIdx = idx; nonStrikerIdx = survivorIdx; }
        else { strikerIdx = survivorIdx; nonStrikerIdx = idx; }
      } else if (event.runsRun !== undefined ? event.runsRun % 2 === 1 : event.runs % 2 === 1) {
        // Odd runs run = swap strike
        [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
      }

      // ── A batter goes off hurt ──
      if (!inningsOver && !so && !(isSecondInnings && innings.runs >= target) && rng() < 2 * rp.hurtPerBatterBall) {
        const strikerHurt = rng() < 0.67;
        const goIdx = strikerHurt ? strikerIdx : nonStrikerIdx;
        const stay = strikerHurt ? nonStrikerIdx : strikerIdx;
        innings.batterStats.get(battingOrder[goIdx].id)!.retiredHurt = true;
        logOffBall(battingOrder[goIdx].id, "retired_hurt", over, legalBalls);
        // he is not out and can come back; the next batter arrives (a retired-hurt batter may only come back at a wicket)
        const n = nextIdx < battingOrder.length ? nextIdx++ : -1;
        if (n < 0) { inningsOver = true; }
        else {
          retiredHurt.push(goIdx);
          if (strikerHurt) strikerIdx = n; else nonStrikerIdx = n;
          void stay;
        }
      }

      // Check if target reached
      if (isSecondInnings && innings.runs >= target) { inningsOver = true; }
      if (innings.wickets >= maxWickets) inningsOver = true;
      if (inningsOver) break;
    }

    // Update over count (a part-bowled over still counts towards the bowler's four)
    bowlerOvers.set(bowler.id, (bowlerOvers.get(bowler.id) ?? 0) + 1);
    innings.overs = over + 1;
    innings.balls = 0;
    if (inningsOver) break;

    // Swap strike at end of over
    [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];

    // ── Retired out (a tactical retirement in the death overs; not a wicket, cannot return) ──
    if (!so && over >= 13 && over < maxOvers - 1 && nextIdx < battingOrder.length && rng() < rp.retiredOutPerInning / 6) {
      const sIdx = strikerIdx;
      const goIdx = (innings.batterStats.get(battingOrder[sIdx].id)!.balls >= innings.batterStats.get(battingOrder[nonStrikerIdx].id)!.balls) ? sIdx : nonStrikerIdx;
      const st = innings.batterStats.get(battingOrder[goIdx].id)!;
      st.isOut = true;
      logOffBall(battingOrder[goIdx].id, "retired_out", over + 1, 0);
      const n = nextIdx++;
      if (goIdx === strikerIdx) strikerIdx = n; else nonStrikerIdx = n;
    }
  }

  return innings;
}

/** Update player season stats from innings */
function updatePlayerStats(
  team: Team,
  innings: InningsScore,
  matchId: string,
  bowlingInnings: InningsScore,
  ballsPerOver = 6,
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

    // Catches taken in the field (the opposing innings is the one this side bowled in)
    for (const ev of bowlingInnings.ballLog) {
      if (!ev.isWicket || ev.substitute) continue; // a substitute fielder's credit is nobody's in the XI
      if ((ev.wicketType === "caught" || ev.wicketType === "caught_and_bowled") && ev.fielderId === player.id) player.stats.catches++;
      else if (ev.wicketType === "stumped" && ev.fielderId === player.id) player.stats.stumpings = (player.stats.stumpings ?? 0) + 1;
      else if (ev.wicketType === "run_out" && (ev.fielderId === player.id || ev.fielder2Id === player.id)) player.stats.runOuts = (player.stats.runOuts ?? 0) + 1;
    }

    if (bowlStat && (bowlStat.overs > 0 || bowlStat.balls > 0)) {
      const overs = bowlStat.overs + bowlStat.balls / 10; // display format
      player.stats.overs += overs;
      player.stats.runsConceded += bowlStat.runs;
      player.stats.wickets += bowlStat.wickets;

      // Track best bowling figures (most wickets, then fewest runs)
      const currentBest = player.stats.bestBowling;
      const [bestW, bestR] = currentBest.split("/").map(Number);
      if (bowlStat.wickets > bestW || (bowlStat.wickets === bestW && bowlStat.runs < bestR)) {
        player.stats.bestBowling = `${bowlStat.wickets}/${bowlStat.runs}`;
      }
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

    // Record form performance for rolling form system
    if (batStat || bowlStat) {
      const runs = batStat?.runs ?? 0;
      const balls = batStat?.balls ?? 0;
      const wickets = bowlStat?.wickets ?? 0;
      // economy is always runs per 6 balls so form scores are comparable across formats
      const bowlOvers = bowlStat ? (bowlStat.overs * ballsPerOver + bowlStat.balls) / 6 : 0;
      const bowlRuns = bowlStat?.runs ?? 0;
      const sr = balls > 0 ? (runs / balls) * 100 : 0;
      const econ = bowlOvers > 0 ? bowlRuns / bowlOvers : 99;
      const formScore = Player.calculateFormScore({
        runs,
        wickets,
        strikeRate: sr,
        economy: econ,
      });
      player.recordMatchPerformance(formScore);
    }
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
  rng: RNG = Math.random,
): InningsScorecard {
  const ballsPerOver = inningsScore.ballsPerOver ?? 6;
  const playerMap = new Map<string, Player>();
  for (const p of [...battingTeam.roster, ...bowlingTeam.roster]) {
    playerMap.set(p.id, p);
  }

  const battingOrder = battingTeam.getBattingOrder(battingXI);
  // an impact player who came on is not in the XI the match started with
  for (const id of inningsScore.batterStats.keys()) {
    if (!battingOrder.some(p => p.id === id) && playerMap.get(id)) battingOrder.push(playerMap.get(id)!);
  }
  const batters: BatterInnings[] = [];
  const fallOfWickets: string[] = [];

  let runsSoFar = 0;
  let wicketsSoFar = 0;
  const fowMap = new Map<string, string>();

  // Wickets in the order they fell: off-ball ones (timed out) sit between deliveries, so merge by position in the log
  const offWickets = (inningsScore.offBall ?? []).filter(o => o.kind === "timed_out");
  const fowAt = (ball: BallEvent | undefined, runs: number, outId: string | undefined) => {
    wicketsSoFar++;
    const overBall = ball ? `${ball.over}.${ball.outcome === "wide" || ball.outcome === "noball" || ball.deadBall ? Math.max(0, ball.ball - 1) : ball.ball}` : "";
    const fowStr = `${runs}/${wicketsSoFar} (${overBall} ov)`;
    if (outId) fowMap.set(outId, fowStr);
    fallOfWickets.push(fowStr);
  };
  for (const ball of inningsScore.ballLog) {
    runsSoFar += ball.runs + ball.extras;
    if (ball.isWicket) fowAt(ball, runsSoFar, ball.playerOutId ?? ball.batter);
  }
  void offWickets;

  let totalWides = 0;
  let totalNoBalls = 0;
  let totalLegByes = 0;
  let totalByes = 0;
  let totalPenalty = 0;
  for (const ball of inningsScore.ballLog) {
    if (ball.wides !== undefined || ball.noBalls !== undefined || ball.byes !== undefined || ball.legByes !== undefined || ball.penaltyRuns !== undefined) {
      totalWides += ball.wides ?? 0; totalNoBalls += ball.noBalls ?? 0; totalLegByes += ball.legByes ?? 0;
      totalByes += ball.byes ?? 0; totalPenalty += ball.penaltyRuns ?? 0;
    } else if (ball.outcome === "wide") totalWides += ball.extras;
    else if (ball.outcome === "noball") totalNoBalls += ball.extras;
    else if (ball.outcome === "legbye") totalLegByes += ball.extras;
  }

  for (const batter of battingOrder) {
    const stat = inningsScore.batterStats.get(batter.id);
    if (!stat) continue;
    if (stat.balls === 0 && !stat.isOut && !stat.retiredHurt) continue;

    let howOut = "not out";
    const off = (inningsScore.offBall ?? []).find(o => o.playerId === batter.id && o.kind !== "retired_hurt");
    if (off) {
      howOut = dismissalText({ kind: off.kind as DismissalKind });
    } else if (stat.isOut) {
      const dismissalBall = inningsScore.ballLog.find(
        b => (b.playerOutId ?? b.batter) === batter.id && b.isWicket
      );
      if (dismissalBall) {
        const bowlerPlayer = playerMap.get(dismissalBall.bowler);
        const bowlerName = bowlerPlayer?.name ?? "unknown";
        const kind = (dismissalBall.wicketType ?? randomWicketType(rng)) as DismissalKind;
        let involved = dismissalBall.fielderId ? playerMap.get(dismissalBall.fielderId) : undefined;
        if (kind === "caught" && !involved) {
          const fielders = bowlingXI.filter(p => p.id !== dismissalBall.bowler);
          involved = fielders[Math.floor(rng() * fielders.length)];
        }
        if (kind === "stumped" && !involved) involved = pickKeeper(bowlingXI);
        const fielder2 = dismissalBall.fielder2Id ? playerMap.get(dismissalBall.fielder2Id) : undefined;
        howOut = dismissalText({
          kind,
          bowler: bowlerName,
          fielder: involved?.name ?? (kind === "caught" ? randomFielderPosition(rng) : undefined),
          fielder2: fielder2?.name,
          substitute: dismissalBall.substitute,
        });
      }
    } else if (stat.retiredHurt) {
      howOut = RETIRED_HURT_TEXT;
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
  for (const id of inningsScore.bowlerStats.keys()) {
    if (!bowlingOrder.some(p => p.id === id) && playerMap.get(id)) bowlingOrder.push(playerMap.get(id)!);
  }

  for (const bowler of bowlingOrder) {
    const stat = inningsScore.bowlerStats.get(bowler.id);
    if (!stat) continue;
    if (stat.overs === 0 && stat.balls === 0) continue;

    // The Hundred has no overs: bowlers' figures are in balls
    const oversStr = ballsPerOver !== 6
      ? String(stat.overs * ballsPerOver + stat.balls)
      : stat.balls > 0 ? `${stat.overs}.${stat.balls}` : `${stat.overs}.0`;

    let dots = 0;
    let maidens = 0;
    const overBuckets = new Map<number, number[]>();

    // Runs charged to the bowler: off the bat, wides and no-balls (not byes / leg byes / penalty). A maiden is a full
    // over of legal balls with nothing charged; a dot is a legal ball with nothing charged.
    const legalInOver = new Map<number, number>();
    for (const ball of inningsScore.ballLog) {
      if (ball.bowler !== bowler.id || ball.deadBall) continue;
      const legal = ball.outcome !== "wide" && ball.outcome !== "noball";
      const charged = ball.wides !== undefined || ball.noBalls !== undefined
        ? ball.runs + (ball.wides ?? 0) + (ball.noBalls ?? 0)
        : ball.runs + (legal ? 0 : ball.extras);
      if (legal && charged === 0) dots++;
      const overIdx = ball.over;
      if (!overBuckets.has(overIdx)) overBuckets.set(overIdx, []);
      overBuckets.get(overIdx)!.push(charged);
      if (legal) legalInOver.set(overIdx, (legalInOver.get(overIdx) ?? 0) + 1);
    }

    for (const [overIdx, ballRuns] of overBuckets) {
      if (ballsPerOver === 6 && (legalInOver.get(overIdx) ?? 0) === 6 && ballRuns.every(r => r === 0)) {
        maidens++;
      }
    }

    const effectiveOvers = (stat.overs * ballsPerOver + stat.balls) / 6; // economy is runs per 6 balls in every format
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
  if (ballsPerOver !== 6) {
    oversDisplay = `${inningsScore.totalBalls} balls`;
  } else if (lastBall) {
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
      total: totalWides + totalNoBalls + totalLegByes + totalByes + totalPenalty,
      ...(totalByes > 0 ? { byes: totalByes } : {}),
      ...(totalPenalty > 0 ? { penalty: totalPenalty } : {}),
    },
    fallOfWickets,
  };
}

function buildDetailedBallLog(
  innings: InningsScore,
  inningsNumber: 1 | 2,
  playerMap: Map<string, Player>,
  rng: RNG = Math.random,
): DetailedBallEvent[] {
  let runsSoFar = 0;
  let wicketsSoFar = 0;

  return innings.ballLog.map(ball => {
    const batterPlayer = playerMap.get(ball.batter);
    const bowlerPlayer = playerMap.get(ball.bowler);

    runsSoFar += ball.runs + ball.extras;
    if (ball.isWicket) wicketsSoFar++;

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
      wicketType = ball.wicketType ?? randomWicketType(rng);
      const involved = ball.fielderId ? playerMap.get(ball.fielderId) : undefined;
      if (involved) fielderName = involved.name;
      else if (wicketType === "caught") fielderName = randomFielderPosition(rng);
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
      ...(ball.playerOutId ? { playerOutName: playerMap.get(ball.playerOutId)?.name } : {}),
      ...(ball.freeHit ? { freeHit: true } : {}),
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
  venueName: string,
  rng: RNG = Math.random,
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

  const inn1Scorecard = buildInningsScorecard(innings1, battingFirst, bowlingFirst, firstXI, firstBowlXI, rng);
  const inn2Scorecard = buildInningsScorecard(innings2, bowlingFirst, battingFirst, secondXI, secondBowlXI, rng);

  const ballLog1 = buildDetailedBallLog(innings1, 1, playerMap, rng);
  const ballLog2 = buildDetailedBallLog(innings2, 2, playerMap, rng);

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
    venue: venueName,
  };
}

let matchCounter = 0;

/** Simulate a full T20 match between two teams */
export function simulateMatch(
  homeTeam: Team,
  awayTeam: Team,
  rules: RuleSet = DEFAULT_RULES,
  seed?: number,
  options?: MatchOptions,
): MatchResult {
  const rng = createRNG(seed ?? randomSeed());
  const matchId = `match_${++matchCounter}`;

  const fmt = matchFormatFor(rules);
  const homeXI = homeTeam.getPlayingXI(rules.maxOverseasInXI);
  const awayXI = awayTeam.getPlayingXI(rules.maxOverseasInXI);

  // Impact player subs (empty arrays if rule is off)
  const homeSubs = rules.impactPlayer ? homeTeam.getImpactSubs(homeXI) : [];
  const awaySubs = rules.impactPlayer ? awayTeam.getImpactSubs(awayXI) : [];

  // Toss
  const tossWinner = rng() < 0.5 ? homeTeam : awayTeam;
  const venue = getVenueContext(homeTeam, rules, options);
  // Measured grounds: follow the chase record. Unmapped (custom) venues keep the dew/pitch heuristic.
  const tossDecision = decideTossChoice({
    ...venue,
    chaseAdvantage: venue.profile ? venue.chaseAdvantage : undefined,
    rng,
  });

  const battingFirst = tossDecision === "bat" ? tossWinner : (tossWinner === homeTeam ? awayTeam : homeTeam);
  const bowlingFirst = battingFirst === homeTeam ? awayTeam : homeTeam;

  // Determine XIs and subs for each side
  const firstXI = battingFirst === homeTeam ? homeXI : awayXI;
  const firstBowlXI = battingFirst === homeTeam ? awayXI : homeXI;
  const firstBatSubs = battingFirst === homeTeam ? homeSubs : awaySubs;
  const firstBowlSubs = battingFirst === homeTeam ? awaySubs : homeSubs;

  // First innings
  const innings1 = simulateInnings(
    battingFirst, bowlingFirst,
    firstXI, firstBowlXI,
    false, 0, venue, fmt.overs,
    firstBatSubs, firstBowlSubs,
    rng, fmt,
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
    true, target, venue, fmt.overs,
    secondBatSubs, secondBowlSubs,
    rng, fmt,
  );

  // Determine winner
  let winnerId: string | null = null;
  let margin: string;
  let superOverRounds: [InningsScore, InningsScore][] | undefined;

  if (innings2.runs >= target) {
    winnerId = bowlingFirst.id;
    margin = `${10 - innings2.wickets} wickets`;
  } else if (innings2.runs < innings1.runs) {
    winnerId = battingFirst.id;
    margin = `${innings1.runs - innings2.runs} runs`;
  } else {
    // Tie -> Super Over(s): one over each, two wickets end it, three nominated batters and one bowler, the side that
    // batted second in the match bats first. Further super overs follow while it stays tied (repeated-super-over), and
    // a bowler or dismissed batter of the previous super over cannot be nominated again. The old boundary count-back
    // looks at every boundary in the match including the super over.
    const rounds: [InningsScore, InningsScore][] = [];
    let first = bowlingFirst;
    let prev: { bowlerOf: Map<string, string>; outOf: Map<string, Set<string>> } = { bowlerOf: new Map(), outOf: new Map() };
    const xiOf = (t: Team) => (t === homeTeam ? homeXI : awayXI);
    for (let round = 0; round < 25; round++) {
      const second = first === homeTeam ? awayTeam : homeTeam;
      const nominate = (bat: Team, bowl: Team) => {
        const outs = prev.outOf.get(bat.id) ?? new Set<string>();
        let pool = xiOf(bat).filter(p => !outs.has(p.id));
        if (pool.length < 3) pool = [...xiOf(bat)];
        const batters = [...pool].sort((a, b) => b.battingOvr - a.battingOvr).slice(0, 3);
        const banned = prev.bowlerOf.get(bowl.id);
        let bowlPool = xiOf(bowl).filter(p => p.id !== banned && p.bowlingOvr > 0);
        if (bowlPool.length === 0) bowlPool = xiOf(bowl);
        const bowler = [...bowlPool].sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr)[0];
        return { batters, bowler, fieldXI: xiOf(bowl) };
      };
      const n1 = nominate(first, second);
      const so1 = simulateInnings(first, second, xiOf(first), xiOf(second), false, 0, venue, 1, [], [], rng, fmt, { superOver: n1 });
      const n2 = nominate(second, first);
      const so2 = simulateInnings(second, first, xiOf(second), xiOf(first), true, so1.runs + 1, venue, 1, [], [], rng, fmt, { superOver: n2 });
      rounds.push([so1, so2]);
      if (so1.runs !== so2.runs) {
        winnerId = so2.runs > so1.runs ? second.id : first.id;
        break;
      }
      if (rules.superOverTieBreaker !== "repeated-super-over") {
        // Boundary count-back over the match and the super over
        const count = (t: Team) => {
          const main = t === battingFirst ? innings1 : innings2;
          const so = t === first ? so1 : so2;
          return main.fours + main.sixes + so.fours + so.sixes;
        };
        winnerId = count(homeTeam) >= count(awayTeam) ? homeTeam.id : awayTeam.id;
        break;
      }
      prev = {
        bowlerOf: new Map([[second.id, n1.bowler.id], [first.id, n2.bowler.id]]),
        outOf: new Map([
          [first.id, new Set(so1.ballLog.filter(b => b.isWicket && !b.deadBall).map(b => b.playerOutId ?? b.batter))],
          [second.id, new Set(so2.ballLog.filter(b => b.isWicket && !b.deadBall).map(b => b.playerOutId ?? b.batter))],
        ]),
      };
      first = second; // alternate who bats first
      winnerId = null;
    }
    if (winnerId === null) winnerId = homeTeam.id; // 25 tied super overs: coin-flip stand-in
    superOverRounds = rounds;
    margin = "Super Over";
  }

  if (options?.countTowardStandings ?? true) {
    const winner = winnerId === homeTeam.id ? homeTeam : awayTeam;
    const loser = winner === homeTeam ? awayTeam : homeTeam;

    winner.wins++;
    loser.losses++;

    // Group-stage standings use official NRR treatment: a bowled-out side is charged the full quota.
    const homeBatting = battingFirst === homeTeam ? innings1 : innings2;
    const homeBowling = battingFirst === homeTeam ? innings2 : innings1;
    const awayBatting = battingFirst === awayTeam ? innings1 : innings2;
    const awayBowling = battingFirst === awayTeam ? innings2 : innings1;

    homeTeam.runsFor += homeBatting.runs;
    homeTeam.ballsFacedFor += getNRRBallDenominator(homeBatting, fmt.totalBalls);
    homeTeam.runsAgainst += homeBowling.runs;
    homeTeam.ballsFacedAgainst += homeBowling.totalBalls;
    homeTeam.wicketsTaken += homeBowling.wickets;
    homeTeam.updateNRR();

    awayTeam.runsFor += awayBatting.runs;
    awayTeam.ballsFacedFor += getNRRBallDenominator(awayBatting, fmt.totalBalls);
    awayTeam.runsAgainst += awayBowling.runs;
    awayTeam.ballsFacedAgainst += awayBowling.totalBalls;
    awayTeam.wicketsTaken += awayBowling.wickets;
    awayTeam.updateNRR();
  }

  // Update player stats
  updatePlayerStats(battingFirst, innings1, matchId, innings2, fmt.ballsPerOver);
  updatePlayerStats(bowlingFirst, innings2, matchId, innings1, fmt.ballsPerOver);

  // Run injury checks using the injury system (WT3)
  const injuries: MatchInjuryEvent[] = [];
  const injuriesEnabled = rules.injuriesEnabled ?? true;
  const homeInjuries = runPostMatchInjuryChecks(homeXI, injuriesEnabled, { gender: rules.gender });
  for (const { player, injury } of homeInjuries) {
    injuries.push({
      playerId: player.id,
      playerName: player.name,
      teamId: homeTeam.id,
      injury,
    });
  }
  const awayInjuries = runPostMatchInjuryChecks(awayXI, injuriesEnabled, { gender: rules.gender });
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
    options?.venueName ?? (options?.neutralVenue ? "Neutral venue" : homeTeam.config.city),
    rng,
  );

  return {
    id: matchId,
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    tossWinner: tossWinner.id,
    tossDecision,
    innings: [innings1, innings2],
    ...(superOverRounds ? { superOver: superOverRounds[superOverRounds.length - 1], superOverRounds } : {}),
    winnerId,
    margin,
    motm: motm.playerId,
    injuries,
    detailed,
  };
}

// ── MVP Points ──────────────────────────────────────────────────────────

export interface MVPPlayerPoints {
  playerId: string;
  playerName: string;
  points: number;
}

/**
 * Calculate MVP points for all players in a match.
 * Points = runs * 1 + fours * 2.5 + sixes * 3.5 + wickets * 3.5 + dots * 1 + catches * 2.5
 *
 * Dots = dot balls bowled. Catches are approximated from caught dismissals in both innings.
 */
export function calculateMVPPoints(result: MatchResult, allPlayers: { id: string; name: string }[]): MVPPlayerPoints[] {
  const playerMap = new Map<string, string>();
  for (const p of allPlayers) playerMap.set(p.id, p.name);

  const pointsMap = new Map<string, number>();

  for (const innings of result.innings) {
    // Batting contributions
    for (const [playerId, stats] of innings.batterStats) {
      const prev = pointsMap.get(playerId) ?? 0;
      const pts = stats.runs * 1 + stats.fours * 2.5 + stats.sixes * 3.5;
      pointsMap.set(playerId, prev + pts);
    }

    // Bowling contributions: wickets and dots from ball log
    const bowlerDots = new Map<string, number>();
    const bowlerWickets = new Map<string, number>();
    for (const ball of innings.ballLog) {
      if (ball.outcome === "wide" || ball.outcome === "noball" || ball.deadBall) continue;
      if (ball.runs === 0 && !ball.isWicket && ball.outcome !== "legbye") {
        bowlerDots.set(ball.bowler, (bowlerDots.get(ball.bowler) ?? 0) + 1);
      }
      if (ball.isWicket && isBowlerWicket(ball.wicketType)) {
        bowlerWickets.set(ball.bowler, (bowlerWickets.get(ball.bowler) ?? 0) + 1);
      }
    }

    for (const [bowlerId, dots] of bowlerDots) {
      const prev = pointsMap.get(bowlerId) ?? 0;
      pointsMap.set(bowlerId, prev + dots * 1);
    }
    for (const [bowlerId, wickets] of bowlerWickets) {
      const prev = pointsMap.get(bowlerId) ?? 0;
      pointsMap.set(bowlerId, prev + wickets * 3.5);
    }

    // Catches: approximate from caught wickets — credit a random fielding-side player
    // Since we don't track individual catches in InningsScore, we estimate:
    // caught dismissals give 2.5 pts to the bowler (already counted via wickets)
    // For a more accurate model, we'd track catches per player, but for now
    // catches are not individually attributed in the basic InningsScore.
  }

  const mvpList: MVPPlayerPoints[] = [];
  for (const [playerId, points] of pointsMap) {
    mvpList.push({
      playerId,
      playerName: playerMap.get(playerId) ?? playerId,
      points: Math.round(points * 10) / 10,
    });
  }

  mvpList.sort((a, b) => b.points - a.points);
  return mvpList;
}
