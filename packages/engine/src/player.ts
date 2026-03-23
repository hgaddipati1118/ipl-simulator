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

export type InjurySeverity = "minor" | "moderate" | "severe";

export interface PlayerData {
  id: string;
  name: string;
  age: number;
  country: string;
  role: PlayerRole;
  ratings: PlayerRatings;
  isInternational: boolean; // non-Indian = international (foreign player slot)
  teamId?: string;
  bid?: number; // auction price in crores
  injured: boolean;
  injuryGamesLeft: number;
  injuryType?: string;          // "hamstring", "shoulder", "back", "finger", "ankle", "side strain"
  injurySeverity?: InjurySeverity;
}

export class Player implements PlayerData {
  id: string;
  name: string;
  age: number;
  country: string;
  role: PlayerRole;
  ratings: PlayerRatings;
  isInternational: boolean;
  teamId?: string;
  bid: number;
  injured: boolean;
  injuryGamesLeft: number;
  injuryType?: string;
  injurySeverity?: InjurySeverity;
  stats: PlayerStats;

  constructor(data: PlayerData) {
    this.id = data.id;
    this.name = data.name;
    this.age = data.age;
    this.country = data.country;
    this.role = data.role;
    this.ratings = { ...data.ratings };
    this.isInternational = data.isInternational;
    this.teamId = data.teamId;
    this.bid = data.bid ?? 0;
    this.injured = data.injured ?? false;
    this.injuryGamesLeft = data.injuryGamesLeft ?? 0;
    this.injuryType = data.injuryType;
    this.injurySeverity = data.injurySeverity;
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
    const { battingIQ, timing, power, running } = this.ratings;
    return Math.round(battingIQ * 0.35 + timing * 0.30 + power * 0.30 + running * 0.05);
  }

  /** Bowling overall: weighted composite of bowling attributes */
  get bowlingOvr(): number {
    const { wicketTaking, economy, accuracy, clutch } = this.ratings;
    return Math.round(wicketTaking * 0.40 + economy * 0.40 + accuracy * 0.10 + clutch * 0.10);
  }

  /** Overall rating: stronger discipline as base, weaker adds diminishing bonus */
  get overall(): number {
    const bat = this.battingOvr;
    const bowl = this.bowlingOvr;
    const stronger = Math.max(bat, bowl);
    const weaker = Math.min(bat, bowl);
    return Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));
  }

  /** Market value in crores, used for auction AI */
  get marketValue(): number {
    const ovr = this.overall;
    if (ovr <= 50) return 0.2;
    const base = Math.pow((ovr - 50) / 50, 1.8);
    const ageFactor = Math.pow(30 / this.age, 0.5);
    let value = Math.pow(base * ageFactor, 4) * 150;
    if (this.isInternational) value *= 0.5;
    return Math.max(0.2, Math.round(value * 100) / 100);
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
      teamId: this.teamId,
      bid: this.bid,
      injured: this.injured,
      injuryGamesLeft: this.injuryGamesLeft,
      injuryType: this.injuryType,
      injurySeverity: this.injurySeverity,
      stats: this.stats,
    };
  }

  /** Reconstruct from serialized data */
  static fromJSON(data: PlayerData & { stats?: PlayerStats }): Player {
    const player = new Player(data);
    if (data.stats) player.stats = data.stats;
    return player;
  }
}
