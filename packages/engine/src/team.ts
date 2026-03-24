/**
 * Team model for the IPL simulator.
 * Ported from IndianCricketLeague/TeamClass.js
 */

import { Player } from "./player.js";

export interface TeamConfig {
  id: string;
  name: string;
  shortName: string;
  city: string;
  primaryColor: string;
  secondaryColor: string;
  stadiumBowlingRating?: number; // 0.7 - 1.5, affects home bowling
  stadiumName?: string;          // Real-life home ground name
  pitchType?: "flat" | "seaming" | "turning" | "balanced";
  boundarySize?: "small" | "medium" | "large";
  dewFactor?: "none" | "moderate" | "heavy";
}

// Stadium bowling ratings based on real IPL venue averages (2022-2025 seasons):
//   < 0.85 = batting paradise (high-scoring), 0.85-0.95 = batting-friendly,
//   0.95-1.05 = balanced, 1.05-1.15 = bowling-friendly, > 1.15 = bowling paradise
export const IPL_TEAMS: TeamConfig[] = [
  { id: "srh", name: "Sunrisers Hyderabad", shortName: "SRH", city: "Hyderabad", primaryColor: "#FF822A", secondaryColor: "#000000", stadiumBowlingRating: 0.92, stadiumName: "Rajiv Gandhi Intl. Cricket Stadium", pitchType: "balanced", boundarySize: "large", dewFactor: "moderate" },
  { id: "dc",  name: "Delhi Capitals", shortName: "DC",  city: "Delhi", primaryColor: "#004C93", secondaryColor: "#EF1B23", stadiumBowlingRating: 0.88, stadiumName: "Arun Jaitley Stadium", pitchType: "flat", boundarySize: "medium", dewFactor: "moderate" },
  { id: "rcb", name: "Royal Challengers Bengaluru", shortName: "RCB", city: "Bengaluru", primaryColor: "#EC1C24", secondaryColor: "#2B2A29", stadiumBowlingRating: 0.78, stadiumName: "M. Chinnaswamy Stadium", pitchType: "flat", boundarySize: "small", dewFactor: "moderate" },
  { id: "kkr", name: "Kolkata Knight Riders", shortName: "KKR", city: "Kolkata", primaryColor: "#3A225D", secondaryColor: "#B3A123", stadiumBowlingRating: 0.98, stadiumName: "Eden Gardens", pitchType: "turning", boundarySize: "medium", dewFactor: "heavy" },
  { id: "rr",  name: "Rajasthan Royals", shortName: "RR",  city: "Jaipur", primaryColor: "#EA1A85", secondaryColor: "#254AA5", stadiumBowlingRating: 1.03, stadiumName: "Sawai Mansingh Stadium", pitchType: "balanced", boundarySize: "medium", dewFactor: "none" },
  { id: "csk", name: "Chennai Super Kings", shortName: "CSK", city: "Chennai", primaryColor: "#FFFF3C", secondaryColor: "#0081E9", stadiumBowlingRating: 1.12, stadiumName: "MA Chidambaram Stadium", pitchType: "turning", boundarySize: "medium", dewFactor: "moderate" },
  { id: "mi",  name: "Mumbai Indians", shortName: "MI",  city: "Mumbai", primaryColor: "#004BA0", secondaryColor: "#D1AB3E", stadiumBowlingRating: 0.85, stadiumName: "Wankhede Stadium", pitchType: "flat", boundarySize: "small", dewFactor: "heavy" },
  { id: "pbks",name: "Punjab Kings", shortName: "PBKS", city: "Mohali", primaryColor: "#ED1B24", secondaryColor: "#A7A9AC", stadiumBowlingRating: 0.87, stadiumName: "IS Bindra Stadium", pitchType: "flat", boundarySize: "large", dewFactor: "none" },
  { id: "gt",  name: "Gujarat Titans", shortName: "GT",  city: "Ahmedabad", primaryColor: "#1C1C1C", secondaryColor: "#0B4973", stadiumBowlingRating: 0.97, stadiumName: "Narendra Modi Stadium", pitchType: "balanced", boundarySize: "large", dewFactor: "moderate" },
  { id: "lsg", name: "Lucknow Super Giants", shortName: "LSG", city: "Lucknow", primaryColor: "#A72056", secondaryColor: "#FFCC00", stadiumBowlingRating: 0.96, stadiumName: "BRSABV Ekana Stadium", pitchType: "balanced", boundarySize: "medium", dewFactor: "none" },
];

export const WPL_TEAMS: TeamConfig[] = [
  { id: "mi-w",  name: "Mumbai Indians",               shortName: "MI",  city: "Mumbai",    primaryColor: "#004BA0", secondaryColor: "#D1AB3E", stadiumBowlingRating: 0.90, stadiumName: "DY Patil Stadium" },
  { id: "dc-w",  name: "Delhi Capitals",               shortName: "DC",  city: "Delhi",     primaryColor: "#004C93", secondaryColor: "#EF1B23", stadiumBowlingRating: 0.93, stadiumName: "Arun Jaitley Stadium" },
  { id: "rcb-w", name: "Royal Challengers Bengaluru",   shortName: "RCB", city: "Bengaluru", primaryColor: "#EC1C24", secondaryColor: "#2B2A29", stadiumBowlingRating: 0.82, stadiumName: "M. Chinnaswamy Stadium" },
  { id: "gg-w",  name: "Gujarat Giants",               shortName: "GG",  city: "Ahmedabad", primaryColor: "#1C1C1C", secondaryColor: "#E04F16", stadiumBowlingRating: 0.97, stadiumName: "Narendra Modi Stadium" },
  { id: "upw",   name: "UP Warriorz",                  shortName: "UPW", city: "Lucknow",   primaryColor: "#6B3FA0", secondaryColor: "#F5C518", stadiumBowlingRating: 0.95, stadiumName: "BRSABV Ekana Stadium" },
];

export class Team {
  config: TeamConfig;
  roster: Player[];
  salaryCap: number;
  totalSpent: number;

  // season record
  wins: number;
  losses: number;
  ties: number;
  nrr: number; // net run rate
  runsFor: number;
  ballsFacedFor: number;
  runsAgainst: number;
  ballsFacedAgainst: number;

  // user lineup management (from WT3)
  isUserControlled: boolean;
  userPlayingXI?: string[];      // player IDs for playing 11
  userBattingOrder?: string[];   // player IDs in batting order
  userBowlingOrder?: string[];   // player IDs for bowling rotation

  constructor(config: TeamConfig, salaryCap = 120) {
    this.config = config;
    this.roster = [];
    this.salaryCap = salaryCap;
    this.totalSpent = 0;
    this.wins = 0;
    this.losses = 0;
    this.ties = 0;
    this.nrr = 0;
    this.runsFor = 0;
    this.ballsFacedFor = 0;
    this.runsAgainst = 0;
    this.ballsFacedAgainst = 0;
    this.isUserControlled = false;
  }

  get id(): string { return this.config.id; }
  get name(): string { return this.config.name; }
  get shortName(): string { return this.config.shortName; }
  get points(): number { return this.wins * 2; }
  get matchesPlayed(): number { return this.wins + this.losses + this.ties; }
  get remainingBudget(): number { return this.salaryCap - this.totalSpent; }

  get internationalCount(): number {
    return this.roster.filter(p => p.isInternational).length;
  }

  get domesticCount(): number {
    return this.roster.filter(p => !p.isInternational).length;
  }

  addPlayer(player: Player, bid: number): void {
    player.teamId = this.id;
    player.bid = bid;
    this.roster.push(player);
    this.totalSpent += bid;
  }

  removePlayer(playerId: string): Player | undefined {
    const idx = this.roster.findIndex(p => p.id === playerId);
    if (idx === -1) return undefined;
    const [player] = this.roster.splice(idx, 1);
    this.totalSpent -= player.bid;
    player.teamId = undefined;
    return player;
  }

  /** Get best playing XI (max overseas players configurable, default 4). Respects user selections if set. */
  getPlayingXI(maxOverseas = 4): Player[] {
    // If user-controlled and has a manual XI set, validate and use it
    if (this.isUserControlled && this.userPlayingXI && this.userPlayingXI.length === 11) {
      const userXI = this.userPlayingXI
        .map(id => this.roster.find(p => p.id === id))
        .filter((p): p is Player => p !== undefined && !p.injured);

      // Validate: exactly 11, max overseas, at least 1 WK, all available
      const intCount = userXI.filter(p => p.isInternational).length;
      const hasWK = userXI.some(p => p.isWicketKeeper);
      if (userXI.length === 11 && intCount <= maxOverseas && hasWK) {
        return userXI;
      }
      // Invalid user XI — fall through to auto selection
    }

    return this.autoSelectPlayingXI(maxOverseas);
  }

  /** Auto-select best playing XI (guarantees at least 1 wicket-keeper) */
  autoSelectPlayingXI(maxOverseas = 4): Player[] {
    const available = this.roster.filter(p => !p.injured);
    const sorted = [...available].sort((a, b) => b.overall - a.overall);

    const xi: Player[] = [];
    let intCount = 0;

    // First pass: pick best 11 by overall
    for (const player of sorted) {
      if (xi.length >= 11) break;
      if (player.isInternational) {
        if (intCount >= maxOverseas) continue;
        intCount++;
      }
      xi.push(player);
    }

    // Ensure at least 1 wicket-keeper
    const hasWK = xi.some(p => p.isWicketKeeper);
    if (!hasWK && xi.length === 11) {
      const bestWK = sorted.find(p =>
        p.isWicketKeeper && !xi.includes(p) &&
        (!p.isInternational || intCount < maxOverseas ||
          xi.some(x => x.isInternational && !x.isWicketKeeper))
      );
      if (bestWK) {
        // Replace the weakest non-WK player that satisfies overseas constraints
        for (let i = xi.length - 1; i >= 0; i--) {
          const candidate = xi[i];
          if (candidate.isWicketKeeper) continue;
          // Check overseas balance: if swapping out a domestic for an intl WK, need room
          const outIsIntl = candidate.isInternational;
          const inIsIntl = bestWK.isInternational;
          const newIntlCount = intCount - (outIsIntl ? 1 : 0) + (inIsIntl ? 1 : 0);
          if (newIntlCount <= maxOverseas) {
            xi[i] = bestWK;
            break;
          }
        }
      }
    }

    return xi;
  }

  /** Get batting order from playing XI. Respects user batting order if set. */
  getBattingOrder(xi: Player[]): Player[] {
    if (this.isUserControlled && this.userBattingOrder && this.userBattingOrder.length > 0) {
      const ordered = this.userBattingOrder
        .map(id => xi.find(p => p.id === id))
        .filter((p): p is Player => p !== undefined);
      // If user order covers all XI, use it; otherwise append missing players
      const remaining = xi.filter(p => !ordered.includes(p));
      return [...ordered, ...remaining];
    }

    return this.autoBattingOrder(xi);
  }

  /** Auto-generate batting order from playing XI */
  autoBattingOrder(xi: Player[]): Player[] {
    return [...xi].sort((a, b) => {
      // Wicket-keeper bats 1-3
      if (a.isWicketKeeper && !b.isWicketKeeper) return -1;
      if (b.isWicketKeeper && !a.isWicketKeeper) return 1;
      // Batsmen first, then all-rounders, then bowlers
      const roleOrder: Record<string, number> = { batsman: 0, "all-rounder": 1, bowler: 2 };
      const diff = (roleOrder[a.role] ?? 2) - (roleOrder[b.role] ?? 2);
      if (diff !== 0) return diff;
      // Within same role, higher batting OVR first
      return b.battingOvr - a.battingOvr;
    });
  }

  /** Get bowling order (5-6 bowlers). Respects user bowling order if set. */
  getBowlingOrder(xi: Player[]): Player[] {
    if (this.isUserControlled && this.userBowlingOrder && this.userBowlingOrder.length > 0) {
      const ordered = this.userBowlingOrder
        .map(id => xi.find(p => p.id === id))
        .filter((p): p is Player => p !== undefined);
      // Need at least 5 bowlers, append auto-selected if user didn't provide enough
      if (ordered.length >= 5) return ordered;
      const autoExtra = this.autoBowlingOrder(xi).filter(p => !ordered.includes(p));
      return [...ordered, ...autoExtra].slice(0, Math.max(5, ordered.length));
    }

    return this.autoBowlingOrder(xi);
  }

  /** Auto-generate bowling order from playing XI */
  autoBowlingOrder(xi: Player[]): Player[] {
    const bowlers = xi
      .filter(p => p.role === "bowler" || p.role === "all-rounder")
      .sort((a, b) => b.bowlingOvr - a.bowlingOvr);

    // Need at least 5 bowlers for 20 overs (max 4 each)
    // If fewer than 5 role-based bowlers, add best part-timers
    if (bowlers.length < 5) {
      const partTimers = xi
        .filter(p => p.role === "batsman")
        .sort((a, b) => b.bowlingOvr - a.bowlingOvr);
      while (bowlers.length < 5 && partTimers.length > 0) {
        bowlers.push(partTimers.shift()!);
      }
    }

    return bowlers;
  }

  /** Update net run rate after a match */
  updateNRR(): void {
    if (this.ballsFacedFor === 0 || this.ballsFacedAgainst === 0) {
      this.nrr = 0;
      return;
    }
    const runRateFor = (this.runsFor / this.ballsFacedFor) * 6;
    const runRateAgainst = (this.runsAgainst / this.ballsFacedAgainst) * 6;
    this.nrr = Math.round((runRateFor - runRateAgainst) * 1000) / 1000;
  }

  /** Reset season record */
  resetSeason(): void {
    this.wins = 0;
    this.losses = 0;
    this.ties = 0;
    this.nrr = 0;
    this.runsFor = 0;
    this.ballsFacedFor = 0;
    this.runsAgainst = 0;
    this.ballsFacedAgainst = 0;
    // Clear lineup selections (user can re-set each season)
    this.userPlayingXI = undefined;
    this.userBattingOrder = undefined;
    this.userBowlingOrder = undefined;
    for (const p of this.roster) {
      p.resetSeasonStats();
      // Clear injuries at season start
      p.injured = false;
      p.injuryGamesLeft = 0;
      p.injuryType = undefined;
      p.injurySeverity = undefined;
    }
  }

  /** Get impact player substitutes (best available non-XI players) */
  getImpactSubs(xi: Player[], count = 4): Player[] {
    const xiIds = new Set(xi.map(p => p.id));
    const available = this.roster.filter(p => !p.injured && !xiIds.has(p.id));
    return [...available].sort((a, b) => b.overall - a.overall).slice(0, count);
  }

  /** Power rating: average overall of best XI */
  get powerRating(): number {
    const xi = this.getPlayingXI();
    if (xi.length === 0) return 0;
    return Math.round(xi.reduce((s, p) => s + p.overall, 0) / xi.length);
  }
}
