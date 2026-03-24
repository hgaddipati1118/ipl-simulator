/**
 * Player model for the IPL simulator.
 * Ported and modernized from IndianCricketLeague/PlayerClass.js
 */

import { clamp, randomNormal } from "./math.js";

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
  | "right-arm-fast" | "right-arm-medium" | "left-arm-fast" | "left-arm-medium"
  | "off-spin" | "left-arm-orthodox" | "leg-spin" | "left-arm-wrist-spin"
  | "unknown";

export type BattingHand = "right" | "left";

export type InjurySeverity = "minor" | "moderate" | "severe";

export interface PlayerData {
  id: string;
  name: string;
  age: number;
  country: string;
  role: PlayerRole;
  ratings: PlayerRatings;
  isInternational: boolean; // non-Indian = international (foreign player slot)
  isWicketKeeper?: boolean; // WK is a tag, not a role
  bowlingStyle?: BowlingStyle;
  battingHand?: BattingHand;
  teamId?: string;
  bid?: number; // auction price in crores
  injured: boolean;
  injuryGamesLeft: number;
  injuryType?: string;          // "hamstring", "shoulder", "back", "finger", "ankle", "side strain"
  injurySeverity?: InjurySeverity;
  formHistory?: number[];       // last 5 match performance scores (0-100)
}

export function calculateBattingOverall(ratings: PlayerRatings): number {
  const { battingIQ, timing, power, running } = ratings;
  return Math.round(battingIQ * 0.30 + timing * 0.30 + power * 0.35 + running * 0.05);
}

export function calculateBowlingOverall(ratings: PlayerRatings): number {
  const { wicketTaking, economy, accuracy, clutch } = ratings;
  return Math.round(wicketTaking * 0.55 + economy * 0.20 + accuracy * 0.10 + clutch * 0.15);
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

export class Player implements PlayerData {
  id: string;
  name: string;
  age: number;
  country: string;
  role: PlayerRole;
  ratings: PlayerRatings;
  isInternational: boolean;
  isWicketKeeper: boolean;
  bowlingStyle: BowlingStyle;
  battingHand: BattingHand;
  teamId?: string;
  bid: number;
  injured: boolean;
  injuryGamesLeft: number;
  injuryType?: string;
  injurySeverity?: InjurySeverity;
  formHistory: number[];
  stats: PlayerStats;

  constructor(data: PlayerData) {
    this.id = data.id;
    this.name = data.name;
    this.age = data.age;
    this.country = data.country;
    this.role = data.role;
    this.ratings = { ...data.ratings };
    this.isInternational = data.isInternational;
    this.isWicketKeeper = data.isWicketKeeper ?? false;
    this.bowlingStyle = data.bowlingStyle ?? "unknown";
    this.battingHand = data.battingHand ?? "right";
    this.teamId = data.teamId;
    this.bid = data.bid ?? 0;
    this.injured = data.injured ?? false;
    this.injuryGamesLeft = data.injuryGamesLeft ?? 0;
    this.injuryType = data.injuryType;
    this.injurySeverity = data.injurySeverity;
    this.formHistory = data.formHistory ? [...data.formHistory] : [];
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
    return this.stats.overs > 0 ? this.stats.runsConceded / this.stats.overs : 0;
  }

  /** Bowling strike rate (balls per wicket) */
  get bowlingStrikeRate(): number {
    return this.stats.wickets > 0
      ? (this.stats.overs * 6) / this.stats.wickets
      : 999;
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

  /** Season-to-season progression: attributes shift based on age */
  progress(): void {
    this.age++;
    const ageBias = (30 - this.age) * 0.3; // positive for young, negative for old
    const deviation = Math.pow(Math.abs(30 - this.age), 0.7);

    const attrs: (keyof PlayerRatings)[] = [
      "battingIQ", "timing", "power", "running",
      "wicketTaking", "economy", "accuracy", "clutch",
    ];

    for (const attr of attrs) {
      const change = randomNormal(ageBias, deviation);
      this.ratings[attr] = clamp(Math.round(this.ratings[attr] + change), 1, 99);
    }

    this.stats = this.emptyStats();
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
      role: this.role,
      ratings: { ...this.ratings },
      isInternational: this.isInternational,
      isWicketKeeper: this.isWicketKeeper,
      bowlingStyle: this.bowlingStyle,
      battingHand: this.battingHand,
      teamId: this.teamId,
      bid: this.bid,
      injured: this.injured,
      injuryGamesLeft: this.injuryGamesLeft,
      injuryType: this.injuryType,
      injurySeverity: this.injurySeverity,
      formHistory: [...this.formHistory],
      stats: this.stats,
    };
  }

  /** Reconstruct from serialized data */
  static fromJSON(data: PlayerData & { stats?: PlayerStats }): Player {
    const player = new Player(data);
    if (data.stats) player.stats = data.stats;
    if (data.formHistory) player.formHistory = [...data.formHistory];
    return player;
  }
}
