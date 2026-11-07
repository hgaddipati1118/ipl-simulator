/**
 * Player model for the IPL simulator.
 * Ported and modernized from IndianCricketLeague/PlayerClass.js
 */

import { clamp, randomNormal, displayOversToReal } from "./math.js";
import type { RNG } from "./rng.js";
import {
  sampleChange, estimateExperience, meanPathOvr, type ProgressionState, type ProgressionGender,
  type BatKind, type BowlKind,
} from "./progression.js";

export interface PlayerRatings {
  battingIQ: number;    // 0-99: shot selection, rotation, game sense
  timing: number;       // 0-99: batting technique and consistency
  power: number;        // 0-99: boundary hitting, six clearing
  running: number;      // 0-99: between-the-wickets speed, quick singles
  wicketTaking: number; // 0-99: ability to take wickets
  economy: number;      // 0-99: ability to restrict runs
  accuracy: number;     // 0-99: line and length consistency
  clutch: number;       // 0-99: performance under pressure
}

export interface PlayerStats {
  matches: number;
  // batting
  innings: number;
  notOuts: number;
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  fifties: number;
  hundreds: number;
  highScore: number;
  // bowling
  overs: number;
  runsConceded: number;
  wickets: number;
  bestBowling: string;
  maidens: number;
  // fielding
  catches: number;
  // per-match tracking
  matchLog: MatchPerformance[];
}

export interface MatchPerformance {
  matchId: string;
  runsScored: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  wicketsTaken: number;
  oversBowled: number;
  runsConceded: number;
}

export type PlayerRole = "batsman" | "bowler" | "all-rounder" | "wicket-keeper";

export type BowlingStyle =
  | "right-arm-fast" | "right-arm-fast-medium" | "right-arm-medium-fast" | "right-arm-medium" | "right-arm-slow"
  | "left-arm-fast" | "left-arm-fast-medium" | "left-arm-medium-fast" | "left-arm-medium" | "left-arm-slow"
  | "off-spin" | "left-arm-orthodox" | "leg-spin" | "left-arm-wrist-spin"
  | "unknown";

function isPaceBowlerStyle(style: BowlingStyle): boolean {
  return style.includes("fast") || style === "right-arm-medium" || style === "left-arm-medium";
}

export type BattingHand = "right" | "left";

export type BattingPosition = "opener" | "top-order" | "middle-order" | "finisher" | "lower-order";

export type InjurySeverity = "minor" | "moderate" | "severe";
export type TrainingFocus = "balanced" | "batting" | "power" | "bowling" | "control" | "fitness" | "clutch";
export type TrainingIntensity = "light" | "balanced" | "hard";

/** Ratings during a season, recorded when the player progresses to the next one */
export interface RatingHistoryEntry {
  season: number;
  overall: number;
  batting: number;
  bowling: number;
  /** Age during that season */
  age?: number;
}

export interface PlayerProgressReport {
  focus: TrainingFocus;
  intensity: TrainingIntensity;
  battingChange: number;
  bowlingChange: number;
  overallChange: number;
  ratingChanges: Partial<Record<keyof PlayerRatings, number>>;
}

export interface PlayerData {
  id: string;
  name: string;
  age: number;
  country: string;
  imageUrl?: string;
  role: PlayerRole;
  ratings: PlayerRatings;
  battingPosition?: BattingPosition; // opener, top-order, middle-order, finisher, lower-order
  isInternational: boolean; // non-Indian = international (foreign player slot)
  isWicketKeeper?: boolean; // WK is a tag, not a role
  bowlingStyle?: BowlingStyle;
  battingHand?: BattingHand;
  careerStats?: { m: number; r: number; avg: number; sr: number; w: number; econ: number };
  teamId?: string;
  bid?: number; // auction price in crores
  injured: boolean;
  injuryGamesLeft: number;
  injuryType?: string;          // "hamstring", "shoulder", "back", "finger", "ankle", "side strain"
  injurySeverity?: InjurySeverity;
  /** Injuries this season [0] and last season [1] (drives the previous-injury risk multiplier) */
  injuryHistory?: number[];
  trainingFocus?: TrainingFocus;
  formHistory?: number[];       // last 5 match performance scores (0-100)
  fatigue?: number;             // 0-100 accumulated workload, lower is fresher
  workloadHistory?: number[];   // last 5 workload scores for management surfaces
  potential?: number;           // 0-99 ceiling for youth academy prospects (higher = develops faster)
  ratingHistory?: RatingHistoryEntry[];
  /** Seasons of rating evidence behind the rating (new players move more); estimated from age and matches when absent */
  experience?: number;
  /** Points of talent (above or below the typical path) still to realise on the way to `potential` */
  talentLeft?: number;
  morale?: number;              // 0-100 player happiness, affects clutch (default 70)
  contractYears?: number;       // years remaining on contract (0 = free agent)
}

function conditionPenalty(fatigue: number): number {
  return Math.max(0, Math.round(Math.max(0, fatigue - 20) / 4.5));
}

function applyConditionPenalty(value: number, fatigue: number): number {
  return Math.max(1, value - conditionPenalty(fatigue));
}

const TRAINING_GAIN_MULTIPLIER: Record<TrainingIntensity, number> = {
  light: 0.65,
  balanced: 1,
  hard: 1.2,
};

const TRAINING_VOLATILITY: Record<TrainingIntensity, number> = {
  light: 0.9,
  balanced: 1,
  hard: 1.15,
};

const TRAINING_CAMP_BASE_FATIGUE: Record<TrainingIntensity, number> = {
  light: 2,
  balanced: 7,
  hard: 13,
};

const TRAINING_CAMP_FOCUS_MOD: Record<TrainingFocus, number> = {
  balanced: 0,
  batting: 1,
  power: 2,
  bowling: 1,
  control: 1,
  fitness: -4,
  clutch: 0,
};

const TRAINING_FOCUS_BIAS: Record<TrainingFocus, Partial<Record<keyof PlayerRatings, number>>> = {
  balanced: {},
  batting: { battingIQ: 0.7, timing: 0.8, running: 0.1 },
  power: { power: 1.0, timing: 0.2, battingIQ: -0.1, running: -0.1 },
  bowling: { wicketTaking: 0.85, economy: 0.2, accuracy: 0.4 },
  control: { economy: 0.8, accuracy: 0.9, wicketTaking: 0.15 },
  fitness: { running: 0.8, clutch: 0.25 },
  clutch: { clutch: 1.0, battingIQ: 0.2, accuracy: 0.15 },
};

/** Infer batting position from player role, ratings, and age */
function inferBattingPosition(data: Partial<PlayerData>): BattingPosition {
  const role = data.role ?? "batsman";
  if (role === "bowler") return "lower-order";

  const ratings = data.ratings;
  if (!ratings) return role === "all-rounder" ? "middle-order" : "top-order";

  const batOvr = calculateBattingOverall(ratings);
  const power = ratings.power;
  const timing = ratings.timing;
  const iq = ratings.battingIQ;
  const running = ratings.running;
  const age = data.age ?? 25;

  // Finishers: high power, typically bat at 5-7
  // Power-heavy batters who are either older (experienced finishers like Dhoni/Pollard)
  // or have significantly more power than timing (explosive, not classical)
  if (power >= 80 && (power >= timing + 5 || age >= 33)) {
    if (role === "all-rounder" || batOvr >= 70) return "finisher";
  }

  // Openers: classical technique — high IQ + timing + running, young-to-prime age
  // They need to play the new ball, so timing and IQ matter more than raw power
  if (role === "batsman" && iq >= 80 && timing >= 80 && running >= 55 && age <= 30) return "opener";

  // Top order (#3-4): high overall, balanced, anchor types
  if (role === "batsman" && batOvr >= 80 && iq >= 75) return "top-order";

  // All-rounders default to middle order
  if (role === "all-rounder") return "middle-order";

  // Remaining batsmen: middle order if decent, lower order if weak
  if (batOvr >= 70) return "middle-order";
  return batOvr >= 50 ? "middle-order" : "lower-order";
}

export function getTrainingCampFatigue(
  focus: TrainingFocus = "balanced",
  intensity: TrainingIntensity = "balanced",
): number {
  return clamp(TRAINING_CAMP_BASE_FATIGUE[intensity] + TRAINING_CAMP_FOCUS_MOD[focus], 0, 24);
}

export function calculateBattingOverall(ratings: PlayerRatings): number {
  const { battingIQ, timing, power, running } = ratings;
  return Math.round(battingIQ * 0.30 + timing * 0.30 + power * 0.35 + running * 0.05);
}

export function calculateBowlingOverall(ratings: PlayerRatings): number {
  const { wicketTaking, economy, accuracy, clutch } = ratings;
  return Math.round(wicketTaking * 0.55 + economy * 0.20 + accuracy * 0.10 + clutch * 0.15);
}

const SPIN_STYLES: readonly BowlingStyle[] = ["off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"];
function isSpinStyle(style: BowlingStyle): boolean {
  return SPIN_STYLES.includes(style);
}

export function calculateOverallRating(battingOvr: number, bowlingOvr: number): number {
  const stronger = Math.max(battingOvr, bowlingOvr);
  const weaker = Math.min(battingOvr, bowlingOvr);
  return Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));
}

export function calculateMarketValue(input: {
  age: number;
  role: PlayerRole;
  isInternational: boolean;
  isWicketKeeper: boolean;
  battingOvr: number;
  bowlingOvr: number;
}): number {
  const ovr = calculateOverallRating(input.battingOvr, input.bowlingOvr);
  if (ovr <= 50) return 0.2;

  const normalized = Math.max(0, (ovr - 50) / 40);
  const qualityValue = 0.2 + Math.pow(normalized, 1.7) * 18;

  let ageFactor = 1;
  if (input.age <= 21) ageFactor = 1.18;
  else if (input.age <= 24) ageFactor = 1.12;
  else if (input.age <= 27) ageFactor = 1.05;
  else if (input.age <= 31) ageFactor = 1.0;
  else if (input.age <= 34) ageFactor = 0.94;
  else ageFactor = 0.84;

  const roleFactor = input.role === "all-rounder"
    ? 1.10
    : input.isWicketKeeper
      ? 1.06
      : 1.0;
  const domesticFactor = input.isInternational ? 0.92 : 1.08;
  const value = qualityValue * ageFactor * roleFactor * domesticFactor;

  return Math.max(0.2, Math.min(20, Math.round(value * 100) / 100));
}

/** Seasons of ratings kept per player (the "ratings over time" chart reads these) */
export const RATING_HISTORY_MAX = 25;
/** Age at which prospects are assumed to reach their potential */
const PEAK_AGE = 27;
/** Prospects' own luck is scaled down so their talent plus luck spread what real careers show (TALENT_SD = 3.5 of ~8) */
const TALENT_LUCK_SCALE = 0.9;
/** Individual attribute noise around the discipline's fitted change (points); not identifiable from per-discipline data */
const ATTRIBUTE_NOISE = 1.8;

function battingKind(position: BattingPosition): BatKind {
  if (position === "opener" || position === "top-order") return "top";
  if (position === "lower-order") return "lower";
  return "middle";
}

function bowlingKind(style: BowlingStyle): BowlKind {
  if (style === "unknown") return "unknown";
  return isSpinStyle(style) ? "spin" : "pace";
}

export class Player implements PlayerData {
  id: string;
  name: string;
  age: number;
  country: string;
  imageUrl?: string;
  role: PlayerRole;
  ratings: PlayerRatings;
  isInternational: boolean;
  isWicketKeeper: boolean;
  bowlingStyle: BowlingStyle;
  battingHand: BattingHand;
  battingPosition: BattingPosition;
  careerStats?: { m: number; r: number; avg: number; sr: number; w: number; econ: number };
  teamId?: string;
  bid: number;
  injured: boolean;
  injuryGamesLeft: number;
  injuryType?: string;
  injurySeverity?: InjurySeverity;
  injuryHistory: number[];
  trainingFocus: TrainingFocus;
  formHistory: number[];
  fatigue: number;
  workloadHistory: number[];
  potential?: number;
  ratingHistory: RatingHistoryEntry[];
  experience?: number;
  talentLeft?: number;
  morale: number;
  contractYears: number;
  stats: PlayerStats;

  constructor(data: PlayerData) {
    this.id = data.id;
    this.name = data.name;
    this.age = data.age;
    this.country = data.country;
    this.imageUrl = data.imageUrl;
    this.role = data.role;
    this.ratings = { ...data.ratings };
    this.isInternational = data.isInternational;
    this.isWicketKeeper = data.isWicketKeeper ?? false;
    this.bowlingStyle = data.bowlingStyle ?? "unknown";
    this.battingHand = data.battingHand ?? "right";
    this.battingPosition = data.battingPosition ?? inferBattingPosition(data);
    this.careerStats = data.careerStats;
    this.teamId = data.teamId;
    this.bid = data.bid ?? 0;
    this.injured = data.injured ?? false;
    this.injuryGamesLeft = data.injuryGamesLeft ?? 0;
    this.injuryType = data.injuryType;
    this.injurySeverity = data.injurySeverity;
    this.injuryHistory = data.injuryHistory ? [...data.injuryHistory] : [];
    this.trainingFocus = data.trainingFocus ?? "balanced";
    this.formHistory = data.formHistory ? [...data.formHistory] : [];
    this.fatigue = data.fatigue ?? 0;
    this.workloadHistory = data.workloadHistory ? [...data.workloadHistory] : [];
    this.potential = data.potential;
    this.ratingHistory = data.ratingHistory ? [...data.ratingHistory] : [];
    this.experience = data.experience;
    this.talentLeft = data.talentLeft;
    this.morale = data.morale ?? 70;
    this.contractYears = data.contractYears ?? 1; // IPL annual contracts
    this.stats = this.emptyStats();
  }

  private emptyStats(): PlayerStats {
    return {
      matches: 0, innings: 0, notOuts: 0, runs: 0, ballsFaced: 0,
      fours: 0, sixes: 0, fifties: 0, hundreds: 0, highScore: 0,
      overs: 0, runsConceded: 0, wickets: 0, bestBowling: "0/0",
      maidens: 0, catches: 0, matchLog: [],
    };
  }

  /** Batting overall: weighted composite of batting attributes */
  get battingOvr(): number {
    return calculateBattingOverall(this.ratings);
  }

  /** Bowling overall: weighted composite of bowling attributes */
  get bowlingOvr(): number {
    return calculateBowlingOverall(this.ratings);
  }

  /** Overall rating: stronger discipline as base, weaker adds diminishing bonus */
  get overall(): number {
    return calculateOverallRating(this.battingOvr, this.bowlingOvr);
  }

  /** Match readiness derived from accumulated fatigue (0-100, higher is fresher). */
  get readiness(): number {
    return clamp(Math.round(100 - this.fatigue), 0, 100);
  }

  /** Effective ratings for selection and management advice when fatigue is considered. */
  get effectiveBattingOvr(): number {
    return applyConditionPenalty(this.battingOvr, this.fatigue);
  }

  get effectiveBowlingOvr(): number {
    return applyConditionPenalty(this.bowlingOvr, this.fatigue);
  }

  get selectionScore(): number {
    return applyConditionPenalty(this.overall, this.fatigue);
  }

  /** Smoothed recent workload used in management UI. */
  get recentWorkload(): number {
    if (this.workloadHistory.length === 0) return 0;
    return Math.round(this.workloadHistory.reduce((sum, value) => sum + value, 0) / this.workloadHistory.length);
  }

  /** Market value in crores, used for auction AI */
  get marketValue(): number {
    return calculateMarketValue({
      age: this.age,
      role: this.role,
      isInternational: this.isInternational,
      isWicketKeeper: this.isWicketKeeper,
      battingOvr: this.battingOvr,
      bowlingOvr: this.bowlingOvr,
    });
  }

  /** Batting average */
  get average(): number {
    const dismissals = this.stats.innings - this.stats.notOuts;
    return dismissals > 0 ? this.stats.runs / dismissals : this.stats.runs;
  }

  /** Batting strike rate */
  get strikeRate(): number {
    return this.stats.ballsFaced > 0
      ? (this.stats.runs / this.stats.ballsFaced) * 100
      : 0;
  }

  /** Bowling economy rate */
  get economyRate(): number {
    if (this.stats.overs <= 0) return 0;
    const realOvers = displayOversToReal(this.stats.overs);
    return realOvers > 0 ? this.stats.runsConceded / realOvers : 0;
  }

  /** Bowling strike rate (balls per wicket) */
  get bowlingStrikeRate(): number {
    if (this.stats.wickets <= 0) return 999;
    const realOvers = displayOversToReal(this.stats.overs);
    return (realOvers * 6) / this.stats.wickets;
  }

  /** Rolling form from last 5 matches (0-100, 50 = neutral) */
  get form(): number {
    if (this.formHistory.length === 0) return 50;
    const sum = this.formHistory.reduce((a, b) => a + b, 0);
    return sum / this.formHistory.length;
  }

  /** Record a match performance and update rolling form (keeps last 5) */
  recordMatchPerformance(score: number): void {
    this.formHistory.push(clamp(score, 0, 100));
    if (this.formHistory.length > 5) {
      this.formHistory = this.formHistory.slice(-5);
    }
  }

  /** Increase fatigue from a match appearance and store a compact workload history. */
  applyMatchWorkload(input: {
    ballsFaced: number;
    oversBowled: number;
    keptWicket?: boolean;
  }): void {
    const roleLoad = this.role === "all-rounder" ? 2 : this.role === "bowler" ? 1 : 0;
    const battingLoad = Math.min(input.ballsFaced, 60) * 0.16;
    const bowlingLoad = Math.min(input.oversBowled, 4) * 4;
    const keepingLoad = input.keptWicket ? 4 : 0;
    const workload = clamp(Math.round(9 + battingLoad + bowlingLoad + keepingLoad + roleLoad), 8, 32);

    this.fatigue = clamp(Math.round(this.fatigue + workload), 0, 100);
    this.workloadHistory.push(workload);
    if (this.workloadHistory.length > 5) {
      this.workloadHistory = this.workloadHistory.slice(-5);
    }
  }

  /** Recover fatigue during rest periods or between fixtures.
   *  Base amount is modified by age, role, and training focus:
   *  - Young players (< 25) recover +1 faster
   *  - Veterans (> 32) recover 1 slower
   *  - Fast bowlers recover 1 slower (physical toll)
   *  - Fitness training focus gives +1 recovery bonus */
  recoverCondition(amount = 5): void {
    let recovery = amount;
    if (this.age < 25) recovery += 1;
    if (this.age > 32) recovery -= 1;
    if (this.role === "bowler" && isPaceBowlerStyle(this.bowlingStyle)) recovery -= 1;
    if (this.trainingFocus === "fitness") recovery += 1;
    this.fatigue = clamp(Math.round(this.fatigue - Math.max(1, recovery)), 0, 100);
  }

  /** Fully reset condition for a new season. */
  resetCondition(): void {
    this.fatigue = 0;
    this.workloadHistory = [];
  }

  /** Apply the start-of-season freshness cost of the current training plan. */
  applyPreseasonTrainingLoad(intensity: TrainingIntensity): void {
    this.resetCondition();
    this.fatigue = getTrainingCampFatigue(this.trainingFocus, intensity);
  }

  /** Mid-season training tick: small attribute boost based on training focus.
   *  Called every ~5 matches to simulate ongoing practice between games.
   *  Returns changes for inbox notifications (empty if no meaningful change). */
  applyMidSeasonTraining(): { attr: string; from: number; to: number }[] {
    const focus = this.trainingFocus ?? "balanced";
    const bias = TRAINING_FOCUS_BIAS[focus];
    const changes: { attr: string; from: number; to: number }[] = [];
    for (const [attr, weight] of Object.entries(bias) as [keyof PlayerRatings, number][]) {
      if (weight > 0) {
        const from = this.ratings[attr];
        const gain = Math.round(randomNormal(weight * 0.4, 0.3));
        if (gain > 0) {
          this.ratings[attr] = clamp(from + gain, 15, 99);
          if (this.ratings[attr] !== from) {
            changes.push({ attr, from, to: this.ratings[attr] });
          }
        }
      }
    }
    return changes;
  }

  /** Calculate form score from match stats */
  static calculateFormScore(stats: {
    runs: number;
    wickets: number;
    strikeRate: number;
    economy: number;
  }): number {
    const score =
      (stats.runs / 30) * 25 +
      stats.wickets * 15 +
      (stats.strikeRate > 150 ? 10 : 0) +
      (stats.economy < 7 ? 10 : 0);
    return clamp(Math.round(score), 0, 100);
  }

  /** The state the progression model works from (ages are those after the coming birthday) */
  getProgressionState(
    gender: ProgressionGender = "male",
    experience = this.experience ?? estimateExperience(this.age, this.careerStats?.m ?? 0),
    prev: RatingHistoryEntry | undefined = this.ratingHistory[this.ratingHistory.length - 1],
  ): ProgressionState {
    const batting = this.battingOvr;
    const bowling = this.bowlingOvr;
    return {
      gender,
      age: this.age + 1,
      experience,
      bat: { ovr: batting, prevOvr: prev?.batting, regular: this.role !== "bowler", kind: battingKind(this.battingPosition) },
      bowl: {
        ovr: bowling, prevOvr: prev?.bowling, regular: this.role !== "batsman" || bowling >= 55,
        kind: bowlingKind(this.bowlingStyle),
      },
    };
  }

  /**
   * Season-to-season progression, fitted on real careers (CricketArchive per-year ratings, see progression.ts):
   * each discipline's overall moves by an expected change (age, level, last season's change, experience) plus a
   * draw from the real spread of outcomes (fat tails: breakouts and collapses). The change is then spread over
   * the discipline's attributes with a little individual noise. Training focus and intensity work on top of it,
   * and youth `potential` steers prospects toward the mature rating it promises.
   * Pass `rng` for a deterministic result.
   */
  progress(input?: {
    focus?: TrainingFocus;
    intensity?: TrainingIntensity;
    seasonNumber?: number;
    /** Which league's fit to use; defaults to men's */
    gender?: ProgressionGender;
    rng?: RNG;
    /** Seasons of rating history to keep (default RATING_HISTORY_MAX) */
    historyLimit?: number;
  }): PlayerProgressReport {
    const rng = input?.rng ?? Math.random;
    const gender = input?.gender ?? "male";
    const prev = this.ratingHistory[this.ratingHistory.length - 1];
    const experience = this.experience ?? estimateExperience(this.age, this.careerStats?.m ?? 0);
    const state = this.getProgressionState(gender, experience, prev);

    // Snapshot current ratings before progression
    this.ratingHistory.push({
      season: input?.seasonNumber ?? this.ratingHistory.length + 1,
      overall: this.overall,
      batting: this.battingOvr,
      bowling: this.bowlingOvr,
      age: this.age,
    });
    const keep = input?.historyLimit ?? RATING_HISTORY_MAX;
    if (this.ratingHistory.length > keep) this.ratingHistory = this.ratingHistory.slice(-keep);

    this.age++;
    this.experience = experience + 1;
    const focus = input?.focus ?? this.trainingFocus ?? "balanced";
    const intensity = input?.intensity ?? "balanced";
    const gainMultiplier = TRAINING_GAIN_MULTIPLIER[intensity];
    const volatility = TRAINING_VOLATILITY[intensity];
    const focusBias = TRAINING_FOCUS_BIAS[focus];
    const beforeBatting = this.battingOvr;
    const beforeBowling = this.bowlingOvr;
    const beforeOverall = this.overall;
    const ratingChanges: Partial<Record<keyof PlayerRatings, number>> = {};

    const batRegular = state.bat.regular;
    const bowlRegular = state.bowl.regular;

    // Potential (prospects): the talent drawn at creation is realised evenly over the years up to the peak age, on top
    // of the usual path. Prospects get a little less luck of their own so the total spread stays what real careers show.
    let talent = 0;
    let luck = 1;
    if (this.potential !== undefined && this.age <= PEAK_AGE) {
      if (this.talentLeft === undefined) {
        // older save or hand-made prospect: the whole gap to potential from the typical path is the talent
        const main = beforeBatting >= beforeBowling ? "bat" : "bowl";
        this.talentLeft = this.potential - meanPathOvr(main, state, PEAK_AGE);
      }
      const yearsLeft = Math.max(1, PEAK_AGE - this.age + 1);
      talent = this.talentLeft / yearsLeft;
      this.talentLeft -= talent;
      luck = TALENT_LUCK_SCALE;
    }

    const dBat = sampleChange("bat", state, rng, { volatility: volatility * luck, extraDrift: batRegular ? talent : 0 });
    const dBowl = sampleChange("bowl", state, rng, { volatility: volatility * luck, extraDrift: bowlRegular ? talent : 0 });
    // Clutch follows the discipline the player is picked for
    const dClutch = this.role === "bowler" ? dBowl : this.role === "all-rounder" ? (dBat + dBowl) / 2 : dBat;

    const apply = (attrs: (keyof PlayerRatings)[], weights: number[], delta: number, clutchDelta?: number) => {
      // individual noise with zero effect on the discipline overall, so the fitted overall change is kept
      const e = attrs.map(() => randomNormal(0, ATTRIBUTE_NOISE, rng));
      const ww = weights.reduce((acc, w) => acc + w * w, 0);
      const we = weights.reduce((acc, w, i) => acc + w * e[i], 0);
      attrs.forEach((attr, i) => {
        const noise = e[i] - (we / ww) * weights[i];
        const focusBoost = (focusBias[attr] ?? 0) * gainMultiplier;
        const d = attr === "clutch" && clutchDelta !== undefined ? clutchDelta : delta;
        const next = clamp(Math.round(this.ratings[attr] + d + noise + focusBoost), 1, 99);
        ratingChanges[attr] = (ratingChanges[attr] ?? 0) + next - this.ratings[attr];
        this.ratings[attr] = next;
      });
    };
    apply(["battingIQ", "timing", "power", "running"], [0.30, 0.30, 0.35, 0.05], dBat);
    apply(["wicketTaking", "economy", "accuracy", "clutch"], [0.55, 0.20, 0.10, 0.15], dBowl, dClutch);

    this.trainingFocus = focus;
    this.stats = this.emptyStats();
    this.resetCondition();

    return {
      focus,
      intensity,
      battingChange: this.battingOvr - beforeBatting,
      bowlingChange: this.bowlingOvr - beforeBowling,
      overallChange: this.overall - beforeOverall,
      ratingChanges,
    };
  }

  /** Reset season stats (keep ratings) */
  resetSeasonStats(): void {
    this.stats = this.emptyStats();
  }

  /** Serialize to plain object */
  toJSON(): PlayerData & { stats: PlayerStats } {
    return {
      id: this.id,
      name: this.name,
      age: this.age,
      country: this.country,
      imageUrl: this.imageUrl,
      role: this.role,
      ratings: { ...this.ratings },
      isInternational: this.isInternational,
      isWicketKeeper: this.isWicketKeeper,
      bowlingStyle: this.bowlingStyle,
      battingHand: this.battingHand,
      battingPosition: this.battingPosition,
      teamId: this.teamId,
      bid: this.bid,
      injured: this.injured,
      injuryGamesLeft: this.injuryGamesLeft,
      injuryType: this.injuryType,
      injurySeverity: this.injurySeverity,
      injuryHistory: [...this.injuryHistory],
      trainingFocus: this.trainingFocus,
      formHistory: [...this.formHistory],
      fatigue: this.fatigue,
      workloadHistory: [...this.workloadHistory],
      potential: this.potential,
      ratingHistory: [...this.ratingHistory],
      experience: this.experience,
      talentLeft: this.talentLeft,
      morale: this.morale,
      contractYears: this.contractYears,
      stats: this.stats,
    };
  }

  /** Reconstruct from serialized data */
  static fromJSON(data: PlayerData & { stats?: PlayerStats }): Player {
    const player = new Player(data);
    if (data.stats) player.stats = data.stats;
    if (data.formHistory) player.formHistory = [...data.formHistory];
    if (data.workloadHistory) player.workloadHistory = [...data.workloadHistory];
    if (data.potential !== undefined) player.potential = data.potential;
    if (data.morale !== undefined) player.morale = data.morale;
    if (data.contractYears !== undefined) player.contractYears = data.contractYears;
    return player;
  }
}
