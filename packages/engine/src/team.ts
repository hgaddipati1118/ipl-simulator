/**
 * Team model for the IPL simulator.
 * Ported from IndianCricketLeague/TeamClass.js
 */

import { Player, type TrainingIntensity } from "./player.js";
import { fieldingValueBonus, keepingRating, pickKeeper } from "./fielding.js";
import {
  getVenueProfileForTeam,
  deriveStadiumBowlingRating,
  derivePitchType,
  deriveBoundarySize,
  deriveDewFactor,
} from "./venues.js";

const MIN_BOWLING_OPTIONS = 5;
const EXTRA_BOWLING_DEPTH_SELECTION_GAP = 3;

/**
 * What a player brings to an XI in points of overall: fatigue-adjusted overall (selectionScore) plus the worth of his
 * fielding (fieldingValueBonus, the match-engine-measured exchange rate, RULES-AUCTION.md section 9). Keeping is left
 * out: only the man who keeps uses it, see keeperSelectionValue. Players with no fielding rating add zero.
 */
export function xiSelectionValue(player: Player): number {
  return player.selectionScore + fieldingValueBonus({ fielding: player.ratings.fielding });
}

/** Selection value of a player as the XI's keeper: xiSelectionValue plus the worth of his keeping rating. */
export function keeperSelectionValue(player: Player): number {
  return player.selectionScore + fieldingValueBonus({
    fielding: player.ratings.fielding,
    keeping: player.ratings.keeping,
    isWicketKeeper: true,
  });
}

function compareKeeperValue(a: Player, b: Player): number {
  const diff = keeperSelectionValue(b) - keeperSelectionValue(a);
  if (diff !== 0) return diff;
  return keepingRating(b) - keepingRating(a);
}

function compareSelectionScore(a: Player, b: Player): number {
  const scoreDiff = xiSelectionValue(b) - xiSelectionValue(a);
  if (scoreDiff !== 0) return scoreDiff;
  return b.overall - a.overall;
}

function bowlingRolePriority(player: Player): number {
  if (player.role === "bowler") return 0;
  if (player.role === "all-rounder") return 1;
  return 2;
}

function compareBowlingSuitability(a: Player, b: Player): number {
  const effectiveDiff = b.effectiveBowlingOvr - a.effectiveBowlingOvr;
  if (effectiveDiff !== 0) return effectiveDiff;

  const roleDiff = bowlingRolePriority(a) - bowlingRolePriority(b);
  if (roleDiff !== 0) return roleDiff;

  const selectionDiff = b.selectionScore - a.selectionScore;
  if (selectionDiff !== 0) return selectionDiff;

  return b.bowlingOvr - a.bowlingOvr;
}

function dedupePlayers(players: Player[]): Player[] {
  const seen = new Set<string>();
  return players.filter(player => {
    if (seen.has(player.id)) return false;
    seen.add(player.id);
    return true;
  });
}

function isExtraBowlingDepthCandidate(player: Player): boolean {
  return !player.isWicketKeeper && (
    player.role === "bowler" ||
    player.role === "all-rounder" ||
    player.effectiveBowlingOvr >= 50
  );
}

export interface BowlingPlan {
  powerplay: string[]; // player IDs preferred for overs 1-6
  middle: string[];    // player IDs preferred for overs 7-15
  death: string[];     // player IDs preferred for overs 16-20
}

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
  /** Play home games at this franchise's ground (its measured venue data). For sides without a
   *  ground of their own, e.g. Draft Match XIs. Defaults to the team's own id. */
  venueTeamId?: string;
}

/**
 * Hand-set venue values the game shipped with before measured venue data. Old saves still
 * carry these in team.config; getVenueContext treats a rating equal to its legacy default as
 * "not edited" so those saves pick up the measured ground instead of a stale override.
 */
export const LEGACY_STADIUM_BOWLING_RATINGS: Record<string, number> = {
  srh: 0.92, dc: 0.88, rcb: 0.78, kkr: 0.98, rr: 1.03, csk: 1.12, mi: 0.85, pbks: 0.87, gt: 0.97, lsg: 0.96,
  "mi-w": 0.90, "dc-w": 0.93, "rcb-w": 0.82, "gg-w": 0.97, upw: 0.95,
};

/**
 * Fill a franchise's venue fields from the measured home-ground data (venue-data.ts):
 * stadiumBowlingRating (editor scale, >1 = bowler-friendly), pitchType, boundarySize and dewFactor
 * are labels derived from the run / six / bowler-type / chase measurements. The match engine
 * uses the measurements directly; these labels drive UI, lineup advice and live-mode extras.
 */
export function withMeasuredVenue(config: TeamConfig): TeamConfig {
  const profile = getVenueProfileForTeam(config.venueTeamId ?? config.id);
  if (!profile) return config;
  return {
    ...config,
    stadiumBowlingRating: deriveStadiumBowlingRating(profile),
    pitchType: derivePitchType(profile),
    boundarySize: deriveBoundarySize(profile),
    dewFactor: deriveDewFactor(profile),
  };
}

export const IPL_TEAMS: TeamConfig[] = [
  { id: "srh", name: "Sunrisers Hyderabad", shortName: "SRH", city: "Hyderabad", primaryColor: "#FF822A", secondaryColor: "#000000", stadiumName: "Rajiv Gandhi Intl. Cricket Stadium" },
  { id: "dc",  name: "Delhi Capitals", shortName: "DC",  city: "Delhi", primaryColor: "#004C93", secondaryColor: "#EF1B23", stadiumName: "Arun Jaitley Stadium" },
  { id: "rcb", name: "Royal Challengers Bengaluru", shortName: "RCB", city: "Bengaluru", primaryColor: "#EC1C24", secondaryColor: "#2B2A29", stadiumName: "M. Chinnaswamy Stadium" },
  { id: "kkr", name: "Kolkata Knight Riders", shortName: "KKR", city: "Kolkata", primaryColor: "#3A225D", secondaryColor: "#B3A123", stadiumName: "Eden Gardens" },
  { id: "rr",  name: "Rajasthan Royals", shortName: "RR",  city: "Jaipur", primaryColor: "#EA1A85", secondaryColor: "#254AA5", stadiumName: "Sawai Mansingh Stadium" },
  { id: "csk", name: "Chennai Super Kings", shortName: "CSK", city: "Chennai", primaryColor: "#FFFF3C", secondaryColor: "#0081E9", stadiumName: "MA Chidambaram Stadium" },
  { id: "mi",  name: "Mumbai Indians", shortName: "MI",  city: "Mumbai", primaryColor: "#004BA0", secondaryColor: "#D1AB3E", stadiumName: "Wankhede Stadium" },
  { id: "pbks",name: "Punjab Kings", shortName: "PBKS", city: "Mohali", primaryColor: "#ED1B24", secondaryColor: "#A7A9AC", stadiumName: "Maharaja Yadavindra Singh Stadium" },
  { id: "gt",  name: "Gujarat Titans", shortName: "GT",  city: "Ahmedabad", primaryColor: "#1C1C1C", secondaryColor: "#0B4973", stadiumName: "Narendra Modi Stadium" },
  { id: "lsg", name: "Lucknow Super Giants", shortName: "LSG", city: "Lucknow", primaryColor: "#A72056", secondaryColor: "#FFCC00", stadiumName: "BRSABV Ekana Stadium" },
].map(withMeasuredVenue);

export const WPL_TEAMS: TeamConfig[] = [
  { id: "mi-w",  name: "Mumbai Indians",               shortName: "MI",  city: "Mumbai",    primaryColor: "#004BA0", secondaryColor: "#D1AB3E", stadiumName: "DY Patil Stadium" },
  { id: "dc-w",  name: "Delhi Capitals",               shortName: "DC",  city: "Delhi",     primaryColor: "#004C93", secondaryColor: "#EF1B23", stadiumName: "Arun Jaitley Stadium" },
  { id: "rcb-w", name: "Royal Challengers Bengaluru",   shortName: "RCB", city: "Bengaluru", primaryColor: "#EC1C24", secondaryColor: "#2B2A29", stadiumName: "M. Chinnaswamy Stadium" },
  { id: "gg-w",  name: "Gujarat Giants",               shortName: "GG",  city: "Ahmedabad", primaryColor: "#1C1C1C", secondaryColor: "#E04F16", stadiumName: "Narendra Modi Stadium" },
  { id: "upw",   name: "UP Warriorz",                  shortName: "UPW", city: "Lucknow",   primaryColor: "#6B3FA0", secondaryColor: "#F5C518", stadiumName: "BRSABV Ekana Stadium" },
].map(withMeasuredVenue);

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
  wicketsTaken: number;

  // user lineup management (from WT3)
  isUserControlled: boolean;
  userPlayingXI?: string[];      // player IDs for playing 11
  userBattingOrder?: string[];   // player IDs in batting order
  userBowlingOrder?: string[];   // player IDs for bowling rotation
  bowlingPlan?: BowlingPlan;     // phase-specific bowling preferences
  /** Per-batter aggression presets (0-100, 50=normal). Applied when batter comes in. */
  batterAggression?: Record<string, number>;
  /** Per-bowler default field setting. Applied when bowler starts an over. */
  bowlerFieldSettings?: Record<string, "aggressive" | "standard" | "defensive" | "spin-attack" | "boundary-save">;
  trainingIntensity: TrainingIntensity;

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
    this.wicketsTaken = 0;
    this.isUserControlled = false;
    this.trainingIntensity = "balanced";
  }

  get id(): string { return this.config.id; }
  get name(): string { return this.config.name; }
  get shortName(): string { return this.config.shortName; }
  get points(): number { return this.wins * 2 + this.ties; } // IPL: 2 for win, 1 for tie/NR
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

  /**
   * Auto-select best playing XI (guarantees at least 1 wicket-keeper). Players are ranked by xiSelectionValue
   * (overall + fielding worth); the keeper is the designated keeper with the best keeperSelectionValue (overall +
   * fielding + keeping worth), so a specialist gloveman beats a slightly better batter who keeps badly.
   */
  autoSelectPlayingXI(maxOverseas = 4): Player[] {
    const available = this.roster.filter(p => !p.injured);
    const sorted = [...available].sort(compareSelectionScore);
    const wicketKeepers = sorted.filter(p => p.isWicketKeeper).sort(compareKeeperValue);
    const preferredWicketKeeper = wicketKeepers[0];
    const bowlingCandidates = available
      .filter(p => !p.isWicketKeeper)
      .sort(compareBowlingSuitability);

    const xi: Player[] = [];
    let intCount = 0;

    const addToXI = (player?: Player): boolean => {
      if (!player || xi.includes(player)) return false;
      if (player.isInternational && intCount >= maxOverseas) return false;
      xi.push(player);
      if (player.isInternational) intCount++;
      return true;
    };

    // CPU XIs should lock in a keeper first, then ensure the best bowling core
    // based on current availability and fatigue before filling with pure batting value.
    addToXI(preferredWicketKeeper);

    let selectedBowlingOptions = 0;
    for (const player of bowlingCandidates) {
      if (selectedBowlingOptions >= MIN_BOWLING_OPTIONS) break;
      if (addToXI(player)) selectedBowlingOptions++;
    }

    const canAddToXI = (player?: Player): player is Player =>
      !!player && !xi.includes(player) && (!player.isInternational || intCount < maxOverseas);

    while (xi.length < 11) {
      const bestAvailable = sorted.find(canAddToXI);
      if (!bestAvailable) break;

      const bowlingDepthCount = xi.filter(isExtraBowlingDepthCandidate).length;
      if (bowlingDepthCount >= MIN_BOWLING_OPTIONS) {
        const extraBowlingDepth = bowlingCandidates.find(player =>
          canAddToXI(player) && isExtraBowlingDepthCandidate(player)
        );

        if (
          extraBowlingDepth &&
          extraBowlingDepth.id !== bestAvailable.id &&
          xiSelectionValue(bestAvailable) - xiSelectionValue(extraBowlingDepth) <= EXTRA_BOWLING_DEPTH_SELECTION_GAP
        ) {
          addToXI(extraBowlingDepth);
          continue;
        }
      }

      addToXI(bestAvailable);
    }

    // Ensure at least 1 wicket-keeper
    const hasWK = xi.some(p => p.isWicketKeeper);
    if (!hasWK && xi.length === 11) {
      const bestWK = wicketKeepers.find(p =>
        !xi.includes(p) &&
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

    // No designated keeper in the squad at all (or none fit): the XI still needs someone who can keep. Bring in the
    // squad's best keeping rating if he is clearly better than anyone already in the XI; the match engine
    // (fielding.ts pickKeeper) then has him keep.
    if (!xi.some(p => p.isWicketKeeper) && xi.length === 11) {
      const inXI = pickKeeper(xi);
      const standIn = available
        .filter(p => !xi.includes(p) && !p.isWicketKeeper)
        .sort((a, b) => keepingRating(b) - keepingRating(a))[0];
      if (standIn && inXI && keepingRating(standIn) >= keepingRating(inXI) + 10) {
        // Swap for the lowest-rated batter-only player in the XI that keeps the overseas limit and the bowling core
        const swapOut = [...xi]
          .filter(p => p !== inXI && !isExtraBowlingDepthCandidate(p))
          .sort((a, b) => xiSelectionValue(a) - xiSelectionValue(b))[0];
        if (swapOut) {
          const newIntl = xi.filter(p => p.isInternational).length - (swapOut.isInternational ? 1 : 0) + (standIn.isInternational ? 1 : 0);
          if (newIntl <= maxOverseas) xi[xi.indexOf(swapOut)] = standIn;
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

  /** Auto-generate batting order from playing XI.
   *  Sorts by batting ability: all-rounders with strong batting
   *  slot in alongside pure batsmen rather than always batting below them. */
  autoBattingOrder(xi: Player[]): Player[] {
    return [...xi].sort((a, b) => {
      // Wicket-keepers who are primary batsmen bat top 3
      if (a.isWicketKeeper && !b.isWicketKeeper && a.battingOvr >= 60) return -1;
      if (b.isWicketKeeper && !a.isWicketKeeper && b.battingOvr >= 60) return 1;
      // Pure bowlers always bat last
      const aIsBowler = a.role === "bowler";
      const bIsBowler = b.role === "bowler";
      if (aIsBowler && !bIsBowler) return 1;
      if (bIsBowler && !aIsBowler) return -1;
      // Among batsmen and all-rounders, sort by batting OVR
      return b.battingOvr - a.battingOvr;
    });
  }

  /** Get bowling order (5-6 bowlers). Respects user bowling order if set. */
  getBowlingOrder(xi: Player[]): Player[] {
    if (this.isUserControlled && this.userBowlingOrder && this.userBowlingOrder.length > 0) {
      const ordered = dedupePlayers(this.userBowlingOrder
        .map(id => xi.find(p => p.id === id))
        .filter((p): p is Player => p !== undefined));
      // Need at least 5 bowlers, append auto-selected if user didn't provide enough.
      // Do not truncate when the XI has more than five legitimate bowling options.
      if (ordered.length >= MIN_BOWLING_OPTIONS) return ordered;
      const autoExtra = this.autoBowlingOrder(xi).filter(p => !ordered.includes(p));
      return [...ordered, ...autoExtra];
    }

    return this.autoBowlingOrder(xi);
  }

  /** Auto-generate bowling order from playing XI.
   *  Includes bowlers/ARs plus part-timers who can genuinely contribute.
   *  Excludes the wicket keeper. Targets 5-6 bowlers. */
  autoBowlingOrder(xi: Player[]): Player[] {
    const bowlers = xi
      .filter(p => (p.role === "bowler" || p.role === "all-rounder") && !p.isWicketKeeper)
      .sort(compareBowlingSuitability);

    // Part-time batsmen are fallback options, not automatic members of the attack.
    // If we already have five genuine bowlers/ARs, keep the rotation tight.
    const partTimers = xi
      .filter(p => p.role === "batsman" && !p.isWicketKeeper)
      .sort(compareBowlingSuitability);

    for (const pt of partTimers) {
      if (bowlers.length >= 5) break;

      // Prefer only credible sixth-bowler types when we need padding.
      if (pt.effectiveBowlingOvr >= 60) {
        bowlers.push(pt);
      } else if (bowlers.length < 4 && pt.effectiveBowlingOvr >= 45) {
        // Emergency only: avoid impossible XIs getting stuck without enough overs.
        bowlers.push(pt);
      }
    }

    if (bowlers.length < MIN_BOWLING_OPTIONS) {
      for (const pt of partTimers) {
        if (bowlers.includes(pt)) continue;
        bowlers.push(pt);
        if (bowlers.length >= MIN_BOWLING_OPTIONS) break;
      }
    }

    // Last resort for very thin squads: a keeper can bowl (it is legal), so a side that
    // cannot find five other options still completes its overs instead of the engine throwing.
    if (bowlers.length < MIN_BOWLING_OPTIONS) {
      const keepers = xi
        .filter(p => p.isWicketKeeper && !bowlers.includes(p))
        .sort(compareBowlingSuitability);
      for (const wk of keepers) {
        bowlers.push(wk);
        if (bowlers.length >= MIN_BOWLING_OPTIONS) break;
      }
    }

    return dedupePlayers(bowlers);
  }

  /** Set phase-specific bowling plan */
  setBowlingPlan(plan: BowlingPlan): void {
    this.bowlingPlan = plan;
  }

  /** Get bowling plan (returns undefined if not set) */
  getBowlingPlan(): BowlingPlan | undefined {
    return this.bowlingPlan;
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
    this.wicketsTaken = 0;
    // Clear lineup selections (user can re-set each season)
    this.userPlayingXI = undefined;
    this.userBattingOrder = undefined;
    this.userBowlingOrder = undefined;
    this.bowlingPlan = undefined;
    for (const p of this.roster) {
      p.resetSeasonStats();
      p.applyPreseasonTrainingLoad(this.trainingIntensity);
      // Clear injuries at season start; this season's injury count becomes last season's
      p.injuryHistory = [0, p.injuryHistory?.[0] ?? 0];
      p.injured = false;
      p.injuryGamesLeft = 0;
      p.injuryType = undefined;
      p.injurySeverity = undefined;
    }
  }

  /** Get impact player substitutes (best available non-XI players) */
  getImpactSubs(xi: Player[], count = 5): Player[] {
    const xiIds = new Set(xi.map(p => p.id));
    const available = this.roster.filter(p => !p.injured && !xiIds.has(p.id));
    return [...available].sort((a, b) => b.overall - a.overall).slice(0, count);
  }

  /** Power rating: average overall of best XI */
  get powerRating(): number {
    const xi = this.getPlayingXI();
    if (xi.length === 0) return 0;
    return Math.round(xi.reduce((s, p) => s + p.selectionScore, 0) / xi.length);
  }
}
