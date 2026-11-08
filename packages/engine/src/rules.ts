/**
 * League and rule set configuration.
 *
 * Supports IPL (men's, 8 or 10 teams), WPL (women's, 5 teams),
 * and fully custom leagues with configurable playoff formats.
 */

/** The extra T20 leagues (see leagues.ts and docs/LEAGUES.md). */
export type ExtraLeagueId =
  | "bbl" | "wbbl" | "psl" | "sa20" | "hundred-m" | "hundred-w" | "cpl" | "ilt20" | "mlc" | "bpl" | "lpl";
export type LeagueType = "ipl" | "wpl" | "custom" | ExtraLeagueId;
/**
 * - "eliminator": IPL-style (4 teams: Q1 1v2, Eliminator 3v4, Q2, Final; 3 teams: Q1 1v2, then loser v 3rd)
 * - "top3": 1st goes straight to the final, 2nd v 3rd eliminator (The Hundred)
 * - "wbbl": top 4, 1st goes straight to the final; Knockout 3v4, Challenger 2nd v Knockout winner, Final
 */
export type PlayoffFormat = "eliminator" | "simple" | "none" | "top3" | "wbbl";
/** "hundred": 100-ball innings of 20 five-ball sets, a bowler delivers at most 20 balls; "odi": 50 overs a side (see format.ts) */
export type MatchFormatId = "t20" | "hundred" | "odi";
export type GenderOption = "men" | "women" | "combined";
export type PlayerSource = "real" | "generated";

export interface RuleSet {
  name: string;
  league: LeagueType;
  leagueName?: string;           // custom display name (overrides "IPL"/"WPL")
  teamIds: string[];             // which team configs to use
  impactPlayer: boolean;
  salaryCap: number;             // in crores
  maxBouncersPerOver: 1 | 2;
  superOverTieBreaker: "boundary-count" | "repeated-super-over";
  maxOverseasInXI: number;       // 4 for IPL, 5 for WPL
  maxOverseasInSquad: number;    // 8 for IPL, 6 for WPL
  maxSquadSize: number;          // 25 for IPL, 18 for WPL
  matchesPerTeam: number;        // 14 for IPL, 8 for WPL
  playoffTeams: number;           // 0 = no playoffs, must be < total teams
  playoffFormat: PlayoffFormat;  // "eliminator" = IPL-style, "simple" = bracket, "none" = league only
  scoringMultiplier: number;     // 1.0 for IPL, ~0.82 for WPL (lower scoring)
  injuriesEnabled: boolean;      // whether injuries can occur during matches
  gender?: GenderOption;         // player pool gender filter
  playerSource?: PlayerSource;   // "real" = existing rated players, "generated" = all CPU
  poolDepth?: "standard" | "deep"; // "deep" adds the best active CricketArchive-only players to the auction pool (default "standard")
  megaAuctionCycle?: number;     // seasons between mega auctions (default 3 for IPL)
  maxRetentions?: number;        // max players retained at mega auction (default 6)
  maxMiniRetentions?: number;    // max players retained at mini auction (default 4)
  squadBuilding?: "auction" | "draft"; // how squads are built (default "auction")
  matchFormat?: MatchFormatId;         // innings format (default "t20"; The Hundred = "hundred"; one-day international = "odi")
  minSquadSize?: number;               // smallest legal squad (default 18)
  draftType?: "snake" | "linear";      // season draft pick order (default "snake")
  draftPickSeconds?: number;           // season draft pick clock, 0 = off (default 45)
}

/** 8 original IPL franchises (2014-2021 era) */
export const IPL_8_TEAM_IDS = ["srh", "dc", "rcb", "kkr", "rr", "csk", "mi", "pbks"];

/** 10 IPL franchises (2022+ era) */
export const IPL_10_TEAM_IDS = ["srh", "dc", "rcb", "kkr", "rr", "csk", "mi", "pbks", "gt", "lsg"];

/** 5 WPL franchises */
export const WPL_TEAM_IDS = ["mi-w", "dc-w", "rcb-w", "gg-w", "upw"];

/** All available team IDs (IPL + WPL) */
export const ALL_TEAM_IDS = [...IPL_10_TEAM_IDS, ...WPL_TEAM_IDS];

export const RULE_PRESETS = {
  classic: {
    name: "IPL Classic (2014-2021)",
    league: "ipl",
    teamIds: IPL_8_TEAM_IDS,
    impactPlayer: false,
    salaryCap: 90,
    maxBouncersPerOver: 1,
    superOverTieBreaker: "boundary-count",
    maxOverseasInXI: 4,
    maxOverseasInSquad: 8,
    maxSquadSize: 25,
    matchesPerTeam: 14,
    playoffTeams: 4,
    playoffFormat: "eliminator",
    scoringMultiplier: 1.0,
    injuriesEnabled: true,
    gender: "men",
    playerSource: "real",
  } satisfies RuleSet,

  modern: {
    name: "IPL Modern (2023+)",
    league: "ipl",
    teamIds: IPL_10_TEAM_IDS,
    impactPlayer: true,
    salaryCap: 120,
    maxBouncersPerOver: 2,
    superOverTieBreaker: "repeated-super-over",
    maxOverseasInXI: 4,
    maxOverseasInSquad: 8,
    maxSquadSize: 25,
    matchesPerTeam: 14,
    playoffTeams: 4,
    playoffFormat: "eliminator",
    scoringMultiplier: 1.0,
    injuriesEnabled: true,
    gender: "men",
    playerSource: "real",
  } satisfies RuleSet,

  modern2026: {
    name: "IPL 2026",
    league: "ipl",
    teamIds: IPL_10_TEAM_IDS,
    impactPlayer: true,
    salaryCap: 125,
    maxBouncersPerOver: 2,
    superOverTieBreaker: "repeated-super-over",
    maxOverseasInXI: 4,
    maxOverseasInSquad: 8,
    maxSquadSize: 25,
    // BCCI's March 11, 2026 first-phase schedule still allocates 7 home matches per franchise.
    matchesPerTeam: 14,
    playoffTeams: 4,
    playoffFormat: "eliminator",
    scoringMultiplier: 1.0,
    injuriesEnabled: true,
    gender: "men",
    playerSource: "real",
  } satisfies RuleSet,

  wpl: {
    name: "WPL (Women's Premier League)",
    league: "wpl",
    teamIds: WPL_TEAM_IDS,
    impactPlayer: false,
    salaryCap: 12,
    maxBouncersPerOver: 1,
    superOverTieBreaker: "repeated-super-over",
    maxOverseasInXI: 5,
    maxOverseasInSquad: 6,
    maxSquadSize: 18,
    matchesPerTeam: 8,
    playoffTeams: 3,
    playoffFormat: "eliminator",
    scoringMultiplier: 0.82,
    injuriesEnabled: true,
    gender: "women",
    playerSource: "real",
  } satisfies RuleSet,
};

export const DEFAULT_RULES: RuleSet = RULE_PRESETS.modern2026;

/**
 * Rules for a one-day international: 50 overs a side (format.ts ODI_FORMAT), no Impact Player, the men's or women's ODI
 * model (its scoring level is fitted, so the scoring multiplier is 1), no overseas limit in a national XI. Squad and
 * auction fields come from `base`. Play it with simulateMatch(home, away, odiRules()) or createMatchState(...).
 */
export function odiRules(gender: "men" | "women" = "men", base: RuleSet = DEFAULT_RULES): RuleSet {
  return {
    ...base,
    name: gender === "women" ? "Women's ODI" : "ODI",
    league: "custom",
    leagueName: gender === "women" ? "Women's ODI" : "ODI",
    matchFormat: "odi",
    impactPlayer: false,
    scoringMultiplier: 1.0,
    gender,
    maxOverseasInXI: 11,
  };
}

export type AuctionType = "mega" | "mini";

/** Determine if the current season should have a mega or mini auction.
 *  Mega auctions happen in season 1 and every `megaAuctionCycle` seasons.
 *  Mini auctions happen in between. */
export function getAuctionType(seasonNumber: number, rules: RuleSet): AuctionType {
  const cycle = rules.megaAuctionCycle ?? 3; // IPL: every 3 seasons (2022→2025→2028)
  // Season 1 is always mega. Then mega at season 4, 7, 10, etc.
  if (seasonNumber === 1) return "mega";
  return (seasonNumber - 1) % cycle === 0 ? "mega" : "mini";
}

/** Get max retentions for the current auction type.
 *  Mega: max 6 retentions (all others released, full auction pool).
 *  Mini: unlimited retentions — teams keep their roster, only release voluntarily. */
export function getMaxRetentions(auctionType: AuctionType, rules: RuleSet): number {
  if (auctionType === "mega") return rules.maxRetentions ?? 6;
  return rules.maxMiniRetentions ?? 25; // Mini: keep full roster (effectively unlimited)
}

/** The IPL's purse increases between seasons: +5 Cr a year, +20 Cr at a mega auction (2025 120 -> 2026 125 -> 2027 130 -> 2028 150) */
export const IPL_PURSE_RAISE = { mini: 5, mega: 20 } as const;
/** The purse those raises belong to */
const IPL_RAISE_BASE_PURSE = 120;

/** Get the effective salary cap for a given season.
 *  The IPL keeps its real pattern: a big jump at a mega auction (+20 Cr), a small rise in mini-auction years (+5 Cr),
 *  rounded to 5 Cr. Every other league grows by the same share of its own purse (WPL 12 Cr: +0.5 and +2 Cr), rounded
 *  to 0.5 Cr, instead of the IPL's crores (which took the WPL from 12 to 42 Cr by season 4). */
export function getSeasonSalaryCap(seasonNumber: number, rules: RuleSet): number {
  const baseCap = rules.salaryCap;
  const cycle = rules.megaAuctionCycle ?? 3;
  const ipl = rules.league === "ipl";
  const scale = ipl ? 1 : baseCap / IPL_RAISE_BASE_PURSE;
  let cap = baseCap;

  for (let s = 2; s <= seasonNumber; s++) {
    const isMega = (s - 1) % cycle === 0;
    cap += (isMega ? IPL_PURSE_RAISE.mega : IPL_PURSE_RAISE.mini) * scale;
  }

  const step = ipl ? 5 : 0.5;
  return Math.round(cap / step) * step;
}

/** Get the effective retention count for a given mega auction season.
 *  IPL history: 2022=4 retentions, 2025=6 retentions.
 *  We start at 6 (current rules) and increase by 1 every 3 mega cycles. */
export function getScaledRetentions(seasonNumber: number, rules: RuleSet): number {
  const base = rules.maxRetentions ?? 6;
  const cycle = rules.megaAuctionCycle ?? 3;
  const megaNumber = Math.floor((seasonNumber - 1) / cycle); // 0-indexed mega auction count
  const bonus = Math.floor(megaNumber / 3); // +1 every 3 mega auctions (~9 seasons)
  return Math.min(base + bonus, 8); // cap at 8 retentions
}

/** Get the auction pool size for a season.
 *  Pool grows over time as more players enter the system. */
export function getAuctionPoolSize(seasonNumber: number, rules: RuleSet): number {
  const basePool = rules.teamIds.length * rules.maxSquadSize; // enough for full squads
  // Pool grows ~5% per season as more players become available
  return Math.round(basePool * (1 + (seasonNumber - 1) * 0.05));
}
