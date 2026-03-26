/**
 * Generate player ratings from ESPN Cricinfo scraped data.
 *
 * Reads espn-players.json (6,696 profiles with career stats),
 * filters for male players with 3+ T20 matches,
 * uses the same rating formula as generate-ratings.ts (via calculator.ts),
 * but leverages REAL fours/sixes data (fo/si fields) instead of estimating them.
 *
 * Also generates women's ratings from the same ESPN data:
 *   - Uses cl=10 (WT20I) instead of cl=6/cl=3 for T20 stats
 *   - Minimum 10 WT20I matches
 *   - Same rating formula (z-scores naturally produce lower ratings for women)
 *   - Age 38+ hard cutoff for retirement
 *
 * Outputs:
 *   - data/scraped/espn-ratings.json       (full rated male player objects)
 *   - data/scraped/espn-ratings-women.json  (full rated female player objects)
 *   - src/all-players.ts                    (TypeScript module for men)
 *   - src/wpl-players.ts                    (TypeScript module for women/WPL)
 *
 * Usage: npx tsx src/pipeline/generate-ratings-espn.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { calculateRatings, inferRole, type GenderPop, type CalculatedRatings } from "../calculator.js";
import { OUTPUT_DIR } from "./config.js";
import { IPL_2026_ROSTERS } from "../ipl-rosters.js";
import { WPL_2025_ROSTERS } from "../wpl-rosters.js";
import {
  clamp,
  calculateBattingOverall,
  calculateBowlingOverall,
  calculateOverallRating,
  type BowlingStyle,
  type BattingHand,
} from "@ipl-sim/engine";

// ── Input / output paths ──────────────────────────────────────────────

const ESPN_FILE = join(OUTPUT_DIR, "espn-players.json");
const OUTPUT_JSON = join(OUTPUT_DIR, "espn-ratings.json");
const OUTPUT_JSON_WOMEN = join(OUTPUT_DIR, "espn-ratings-women.json");
const OUTPUT_TS = join(dirname(OUTPUT_DIR), "..", "src", "all-players.ts");
const OUTPUT_TS_WOMEN = join(dirname(OUTPUT_DIR), "..", "src", "wpl-players.ts");

// ── ESPN data types ───────────────────────────────────────────────────

interface EspnDateOfBirth {
  year: number;
  month: number;
  date: number;
}

interface EspnProfile {
  espnId: number;
  name: string;         // short name, e.g. "V Kohli"
  longName: string;     // full name, e.g. "Virat Kohli"
  slug: string;
  dateOfBirth: EspnDateOfBirth | null;
  gender: "M" | "F";
  countryTeamId: number;
  battingStyles: string[];
  bowlingStyles: string[];
  playingRoles: string[];
  teams: string[];
  imageUrl: string;
  intlCareerSpan: string;
}

interface EspnCareerStat {
  type: "BATTING" | "BOWLING";
  cl: number;           // 1=Test, 2=ODI, 3=T20I, 4=FC, 5=List A, 6=All T20s
  mt: number;           // matches
  in: number;           // innings
  rn: number;           // runs
  bl: number | null;    // balls (faced for batting, bowled for bowling)
  avg: number | string; // average (can be "-" if 0 wickets)
  sr: number | string;  // strike rate (can be "-")
  // Batting-specific
  no?: number;          // not outs
  fo?: number | null;   // fours
  si?: number | null;   // sixes
  hs?: string;          // highest score
  hn?: number;          // hundreds
  ft?: number;          // fifties
  ct?: number;          // catches
  st?: number;          // stumpings
  // Bowling-specific
  wk?: number;          // wickets
  bbi?: string;         // best bowling in innings
  bbm?: string;         // best bowling in match
  bwe?: number;         // economy rate
  fwk?: number;         // five-wicket hauls
  fw?: number;          // five-wicket hauls (alternate)
  tw?: number;          // ten-wicket hauls
}

interface EspnPlayer {
  profile: EspnProfile;
  careerStats: EspnCareerStat[];
  scrapedAt: string;
}

// ── Rated player output type ──────────────────────────────────────────

interface RatedPlayer {
  id: string;
  name: string;
  fullName: string;
  age: number;
  country: string;
  imageUrl?: string;
  battingHand: BattingHand;
  bowlingStyle: BowlingStyle;
  role: "batsman" | "bowler" | "all-rounder";
  isWicketKeeper?: boolean;
  isInternational: boolean;
  teamId?: string;
  price?: number;  // auction/retention price in crores
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
  overalls: {
    battingOvr: number;
    bowlingOvr: number;
    overall: number;
  };
  sourceStats: {
    t20Matches: number;
    t20Runs: number;
    t20Average: number;
    t20StrikeRate: number;
    t20Fours: number;
    t20Sixes: number;
    t20Wickets: number;
    t20Economy: number;
    statClass: number;  // which cl was used (6 = all T20s, 3 = T20I)
  };
  espnId: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Calculate age from ESPN's dateOfBirth object.
 */
function calculateAge(dob: EspnDateOfBirth | null): number {
  if (!dob) return 28; // default if missing
  const birthDate = new Date(dob.year, dob.month - 1, dob.date);
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  if (
    now.getMonth() < birthDate.getMonth() ||
    (now.getMonth() === birthDate.getMonth() && now.getDate() < birthDate.getDate())
  ) {
    age--;
  }
  return Math.max(16, Math.min(55, age));
}

/**
 * Map countryTeamId to actual country name.
 * ESPN's countryTeamId reliably identifies nationality.
 */
const COUNTRY_MAP: Record<number, string> = {
  1: "England", 2: "Australia", 3: "South Africa", 4: "West Indies",
  5: "New Zealand", 6: "India", 7: "Pakistan", 8: "Sri Lanka",
  9: "Zimbabwe", 11: "USA", 15: "Netherlands", 17: "Canada",
  19: "Hong Kong", 20: "Papua New Guinea", 25: "Bangladesh",
  26: "Kenya", 27: "UAE", 28: "Namibia", 29: "Ireland",
  30: "Scotland", 31: "Italy", 32: "Nepal", 34: "Uganda",
  35: "Singapore", 36: "Oman", 37: "Jersey", 40: "Afghanistan",
  41: "Austria", 42: "Germany", 43: "Malaysia", 44: "Bermuda",
  45: "Bahrain", 46: "Kuwait", 47: "Qatar", 48: "Saudi Arabia",
  49: "Tanzania", 50: "Vanuatu", 51: "Czech Republic", 52: "Spain",
  53: "Romania", 54: "Hungary", 55: "Sweden", 56: "Portugal",
  57: "Luxembourg", 58: "Belgium", 59: "Norway", 60: "Bulgaria",
  61: "Croatia", 62: "Finland", 63: "France", 64: "Greece",
  65: "Guernsey", 66: "Isle of Man", 67: "Denmark", 68: "Japan",
  100: "Bhutan", 101: "Maldives", 102: "Thailand", 103: "Philippines",
  104: "South Korea", 105: "China", 106: "Mongolia", 107: "Myanmar",
  108: "Cambodia", 109: "Indonesia", 110: "Nigeria", 111: "Ghana",
  112: "Rwanda", 113: "Cameroon", 114: "Mozambique", 115: "Malawi",
  116: "Botswana", 117: "Zambia", 118: "Sierra Leone", 119: "Brazil",
  120: "Cayman Islands", 121: "Malta", 122: "Cyprus", 123: "Croatia",
  124: "Estonia", 125: "Bahamas", 126: "Cook Islands",
};

function extractCountry(profile: EspnProfile): string {
  // Use countryTeamId for reliable nationality
  if (profile.countryTeamId && COUNTRY_MAP[profile.countryTeamId]) {
    return COUNTRY_MAP[profile.countryTeamId];
  }
  // Fallback: first team name
  if (profile.teams && profile.teams.length > 0) {
    return profile.teams[0];
  }
  return "Unknown";
}

/**
 * Get a stat record for a given type and class from the career stats array.
 * For men: Prefers cl=6 (all T20s), falls back to cl=3 (T20I).
 * For women: Uses cl=10 (WT20I) — women's T20 stats are stored separately on ESPN.
 */
function getT20Stat(
  stats: EspnCareerStat[],
  type: "BATTING" | "BOWLING",
  gender: "M" | "F" = "M",
): { stat: EspnCareerStat; cl: number } | null {
  if (gender === "F") {
    // Women's T20I stats are in cl=10 (WT20I)
    const cl10 = stats.find(s => s.type === type && s.cl === 10);
    if (cl10) return { stat: cl10, cl: 10 };
    return null;
  }
  // Men: Prefer cl=6 (all T20s including franchise)
  const cl6 = stats.find(s => s.type === type && s.cl === 6);
  if (cl6) return { stat: cl6, cl: 6 };
  // Fallback to cl=3 (T20 Internationals)
  const cl3 = stats.find(s => s.type === type && s.cl === 3);
  if (cl3) return { stat: cl3, cl: 3 };
  return null;
}

/**
 * Safely parse a number that might be a string like "-" or null.
 */
function safeNum(val: number | string | null | undefined, fallback: number = 0): number {
  if (val === null || val === undefined || val === "-" || val === "") return fallback;
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? fallback : n;
}

/**
 * Map ESPN batting style string to our BattingHand type.
 */
function mapBattingHand(espnStyle: string): BattingHand {
  const s = espnStyle.toLowerCase().trim();
  if (s.includes("left")) return "left";
  return "right"; // default to right for "Right hand bat", unknown, etc.
}

/**
 * Map ESPN bowling style string to our BowlingStyle type.
 */
function mapBowlingStyle(espnStyle: string): BowlingStyle {
  const s = espnStyle.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();

  // Right-arm pace — preserve ESPN's granularity
  if (s === "right arm fast") return "right-arm-fast";
  if (s === "right arm fast medium") return "right-arm-fast-medium";
  if (s === "right arm medium fast") return "right-arm-medium-fast";
  if (s === "right arm medium") return "right-arm-medium";

  // Left-arm pace
  if (s === "left arm fast") return "left-arm-fast";
  if (s === "left arm fast medium") return "left-arm-fast-medium";
  if (s === "left arm medium fast") return "left-arm-medium-fast";
  if (s === "left arm medium") return "left-arm-medium";

  // Spin
  if (s === "right arm offbreak" || s === "right arm off break") return "off-spin";
  if (s === "slow left arm orthodox") return "left-arm-orthodox";
  if (s === "legbreak" || s === "legbreak googly" || s === "leg break" || s === "leg break googly") return "leg-spin";
  if (s === "left arm wrist spin" || s === "slow left arm chinaman") return "left-arm-wrist-spin";

  return "unknown";
}

function getEspnRoleHint(espnRoles: string[]): "batsman" | "bowler" | "all-rounder" | undefined {
  const normalized = espnRoles.map((role) => role.toLowerCase().replace(/-/g, " ").trim());

  if (normalized.some((role) => role.includes("allrounder") || role.includes("all rounder"))) {
    return "all-rounder";
  }

  if (normalized.some((role) => role.includes("bowler"))) {
    return "bowler";
  }

  if (normalized.some((role) => role.includes("batter") || role.includes("batsman") || role.includes("keeper"))) {
    return "batsman";
  }

  return undefined;
}

function recomputeOveralls(ratings: CalculatedRatings): void {
  ratings.battingOvr = calculateBattingOverall(ratings);
  ratings.bowlingOvr = calculateBowlingOverall(ratings);
  ratings.overall = calculateOverallRating(ratings.battingOvr, ratings.bowlingOvr);
}

function resolveRoleFromHint(
  hintedRole: "batsman" | "bowler" | "all-rounder" | undefined,
  inferredRole: "batsman" | "bowler" | "all-rounder",
  ratings: CalculatedRatings,
): "batsman" | "bowler" | "all-rounder" {
  if (!hintedRole) return inferredRole;

  if (hintedRole === "all-rounder") {
    const weaker = Math.min(ratings.battingOvr, ratings.bowlingOvr);
    const stronger = Math.max(ratings.battingOvr, ratings.bowlingOvr);
    const diff = Math.abs(ratings.battingOvr - ratings.bowlingOvr);
    return weaker >= 60 && stronger >= 72 && diff <= 25 ? "all-rounder" : inferredRole;
  }

  if (hintedRole === "batsman") {
    return ratings.battingOvr >= ratings.bowlingOvr ? "batsman" : inferredRole;
  }

  const bowlingCloseCall =
    ratings.bowlingOvr >= 60 &&
    ratings.battingOvr - ratings.bowlingOvr <= 8;
  return ratings.bowlingOvr >= ratings.battingOvr || bowlingCloseCall ? "bowler" : inferredRole;
}

/**
 * Convert ESPN player data to the calculator input format.
 * Uses REAL fours and sixes from ESPN data (fo/si fields).
 * For women, uses cl=10 (WT20I) and relaxed bowling threshold.
 */
function toCalculatorInput(player: EspnPlayer, gender: "M" | "F" = "M") {
  const batResult = getT20Stat(player.careerStats, "BATTING", gender);
  const bowlResult = getT20Stat(player.careerStats, "BOWLING", gender);
  const bat = batResult?.stat ?? null;
  const bowl = bowlResult?.stat ?? null;

  const matches = bat ? bat.mt : 0;
  const battingInnings = bat ? bat.in : 0;
  const notOuts = bat ? safeNum(bat.no) : 0;
  const runs = bat ? safeNum(bat.rn) : 0;
  let ballsFaced = bat ? safeNum(bat.bl) : 0;

  // If balls faced is missing but we have runs, estimate from average strike rate.
  // Some older ESPN profiles (especially women's WT20I) have null bl/sr fields.
  if (ballsFaced === 0 && runs > 0 && battingInnings > 0) {
    // Estimate SR based on gender: women's WT20I average ~115, men's T20 ~130
    const estimatedSR = gender === "F" ? 115 : 130;
    ballsFaced = Math.round((runs / estimatedSR) * 100);
  }

  // REAL fours and sixes from ESPN data — the key improvement over the CricketArchive pipeline
  const fours = bat ? safeNum(bat.fo) : 0;
  const sixes = bat ? safeNum(bat.si) : 0;

  // If fo/si are null (some older players), estimate like the original pipeline
  const hasBoundaryData = bat !== null && bat.fo !== null && bat.si !== null;
  let finalFours = fours;
  let finalSixes = sixes;
  if (!hasBoundaryData && runs > 0 && ballsFaced > 0) {
    // Use actual SR if we computed/have balls, else use estimated SR
    const sr = (runs / ballsFaced) * 100;
    // Women have lower boundary percentage than men
    const baseBdryPct = gender === "F" ? 0.25 : 0.3;
    const bdrySlope = gender === "F" ? 0.0025 : 0.003;
    const boundaryPct = Math.min(0.75, baseBdryPct + (sr - 100) * bdrySlope);
    const boundaryRuns = runs * Math.max(boundaryPct, 0.15);
    // Women hit fewer sixes relative to fours
    const sixPct = gender === "F" ? 0.20 : 0.35;
    finalSixes = Math.round(boundaryRuns * sixPct / 6);
    finalFours = Math.round(boundaryRuns * (1 - sixPct) / 4);
  }

  const bowlBalls = bowl ? safeNum(bowl.bl) : 0;
  const bowlRuns = bowl ? safeNum(bowl.rn) : 0;
  const wickets = bowl ? safeNum(bowl.wk) : 0;
  const bowlInnings = bowl ? safeNum(bowl.in) : 0;
  const bowlShare = matches > 0 ? bowlInnings / matches : 0;
  const hasBowlingRoleHint = (player.profile.playingRoles ?? []).some((role) => {
    const normalized = role.toLowerCase().replace(/-/g, " ").trim();
    return normalized.includes("allrounder") || normalized.includes("all rounder") || normalized.includes("bowler");
  });

  // Must have bowled minimum balls AND taken minimum wickets to count as a bowler.
  // Men: 300 balls (50 overs) + 15 wickets — filters out part-timers like SKY, Babar.
  // Women: 150 balls (25 overs) + 8 wickets — lower thresholds due to fewer matches.
  // All-rounders get relaxed thresholds (they bowl regularly but may not hit strict minimums).
  const minBalls = hasBowlingRoleHint ? (gender === "F" ? 100 : 150) : (gender === "F" ? 150 : 300);
  const minWickets = hasBowlingRoleHint ? (gender === "F" ? 4 : 8) : (gender === "F" ? 8 : 15);
  const minBowlShare = gender === "F" ? 0.2 : 0.25;
  const hasMeaningfulBowling =
    bowlBalls >= minBalls &&
    wickets >= minWickets &&
    (bowlShare >= minBowlShare || hasBowlingRoleHint);

  return {
    name: player.profile.longName || player.profile.name,
    age: calculateAge(player.profile.dateOfBirth),
    country: extractCountry(player.profile),
    matches,
    battingInnings,
    notOuts,
    runs,
    ballsFaced,
    fours: finalFours,
    sixes: finalSixes,
    bowlingInnings: hasMeaningfulBowling ? bowlInnings : 0,
    ballsBowled: hasMeaningfulBowling ? bowlBalls : 0,
    runsConceded: hasMeaningfulBowling ? bowlRuns : 0,
    wickets: hasMeaningfulBowling ? wickets : 0,
    catches: bat ? safeNum(bat.ct) : 0,
  };
}

function applyBattingProfileAdjustment(
  ratings: CalculatedRatings,
  input: {
    matches: number;
    battingInnings: number;
    notOuts: number;
    runs: number;
    ballsFaced: number;
    fours: number;
    sixes: number;
  },
  espnRoles: string[],
): void {
  if (input.battingInnings < 20 || input.ballsFaced === 0 || input.runs === 0) return;

  const normalizedRoles = espnRoles.map((role) => role.toLowerCase().replace(/-/g, " ").trim());
  const isTopOrder = normalizedRoles.some((role) => role.includes("opening") || role.includes("top order"));
  const isMiddleOrder = normalizedRoles.some((role) => role.includes("middle order"));

  const runsPerInnings = input.runs / input.battingInnings;
  const ballsPerInnings = input.ballsFaced / input.battingInnings;
  const notOutRate = input.notOuts / input.battingInnings;
  const boundaryRuns = input.fours * 4 + input.sixes * 6;
  const boundaryRunPct = boundaryRuns / Math.max(1, input.runs);

  let battingIQDelta = 0;
  let timingDelta = 0;
  let powerDelta = 0;
  let clutchDelta = 0;

  const finisherInflationProfile =
    isMiddleOrder &&
    notOutRate >= 0.22 &&
    ballsPerInnings <= 15.5 &&
    boundaryRunPct >= 0.62;

  if (finisherInflationProfile) {
    battingIQDelta -= 4;
    timingDelta -= 4;
    powerDelta += 1;
    clutchDelta -= 2;
  }

  const smallSamplePowerSpike =
    input.matches < 80 &&
    boundaryRunPct >= 0.74 &&
    ballsPerInnings <= 17.5;

  if (smallSamplePowerSpike) {
    battingIQDelta -= 3;
    timingDelta -= 2;
    clutchDelta -= 2;
  }

  const stableVolumeProfile =
    input.matches >= 80 &&
    runsPerInnings >= 28 &&
    ballsPerInnings >= 20 &&
    boundaryRunPct <= 0.63;

  if (stableVolumeProfile) {
    battingIQDelta += 1;
    timingDelta += 1;
    clutchDelta += 1;
  }

  const topOrderAnchorProfile =
    isTopOrder &&
    runsPerInnings >= 30 &&
    ballsPerInnings >= 22 &&
    boundaryRunPct <= 0.60;

  if (topOrderAnchorProfile) {
    battingIQDelta += 1;
    timingDelta += 1;
  }

  ratings.battingIQ = clamp(ratings.battingIQ + battingIQDelta, 15, 99);
  ratings.timing = clamp(ratings.timing + timingDelta, 15, 99);
  ratings.power = clamp(ratings.power + powerDelta, 15, 99);
  ratings.clutch = clamp(ratings.clutch + clutchDelta, 15, 99);
  recomputeOveralls(ratings);
}

// ── Retirement detection ─────────────────────────────────────────────

/**
 * Detect if a player is retired based on career span and age.
 *
 * Rules:
 * - intlCareerSpan ends before 2024 AND age >= 36 → retired
 * - Age >= 42 → retired regardless (even franchise players)
 * - Exception: if they have T20 stats from recent seasons (cl=6 matches suggest active franchise)
 *   we check if their career span extends to 2025+
 */
function isRetired(player: EspnPlayer): boolean {
  const age = calculateAge(player.profile.dateOfBirth);
  const span = player.profile.intlCareerSpan;

  // Parse career span end year
  let lastYear = 0;
  if (span) {
    const match = span.match(/(\d{4})\s*$/);
    if (match) lastYear = parseInt(match[1]);
  }

  // Check if they play in top franchise leagues (likely still active)
  const teams = (player.profile.teams || []).map(t => t.toLowerCase());
  const hasRecentFranchise = teams.some(team =>
    TOP_LEAGUES.some(league => team.includes(league))
  );

  // Hard age cutoff — no one plays T20 at 44+
  if (age >= 44) return true;

  // If intl career span extends to 2025+ they're definitely active
  if (lastYear >= 2025) return false;

  // Franchise players: intlCareerSpan only tracks international retirement, not franchise
  // Many players (Narine, Faf, etc.) retired from internationals but still play IPL/CPL
  // If they're in a franchise league and under 42, assume active
  if (hasRecentFranchise && age < 42) return false;

  // Age 42+ without 2025+ career span → retired
  if (age >= 42) return true;

  // Career ended before 2022 and player is 36+ → retired
  if (lastYear > 0 && lastYear < 2022 && age >= 36) return true;

  // Career ended before 2020 and player is 33+ → long-retired
  if (lastYear > 0 && lastYear < 2020 && age >= 33) return true;

  // No career span and age 40+ → likely retired
  if (!span && age >= 40) return true;

  return false;
}

/**
 * Detect if a women's player is retired based on career span and age.
 * Women's cricket has less retirement — use age 38+ as hard cutoff.
 */
function isRetiredWomen(player: EspnPlayer): boolean {
  const age = calculateAge(player.profile.dateOfBirth);
  const span = player.profile.intlCareerSpan;

  // Parse career span end year
  let lastYear = 0;
  if (span) {
    const match = span.match(/(\d{4})\s*$/);
    if (match) lastYear = parseInt(match[1]);
  }

  // Hard age cutoff for women
  if (age >= 40) return true;

  // If intl career span extends to 2024+ they're definitely active
  if (lastYear >= 2024) return false;

  // Career ended before 2022 and player is 35+ → retired
  if (lastYear > 0 && lastYear < 2022 && age >= 35) return true;

  // Career ended before 2020 and player is 32+ → long-retired
  if (lastYear > 0 && lastYear < 2020 && age >= 32) return true;

  // No career span and age 38+ → likely retired
  if (!span && age >= 38) return true;

  return false;
}

// ── Competition quality ──────────────────────────────────────────────

// Top franchise leagues and full-member national teams
const TOP_LEAGUES = [
  // IPL teams
  "chennai super kings", "mumbai indians", "royal challengers", "kolkata knight riders",
  "delhi capitals", "rajasthan royals", "sunrisers hyderabad", "punjab kings",
  "lucknow super giants", "gujarat titans",
  // BBL
  "sydney sixers", "sydney thunder", "melbourne stars", "melbourne renegades",
  "hobart hurricanes", "brisbane heat", "perth scorchers", "adelaide strikers",
  // PSL
  "karachi kings", "lahore qalandars", "islamabad united", "multan sultans",
  "peshawar zalmi", "quetta gladiators",
  // CPL
  "trinbago knight riders", "guyana amazon warriors", "barbados royals",
  "jamaica tallawahs", "st kitts", "st lucia kings",
  // T20 Blast / Hundred
  "yorkshire", "surrey", "lancashire", "nottinghamshire", "hampshire", "kent",
  "oval invincibles", "trent rockets", "manchester originals", "london spirit",
  "birmingham phoenix", "northern superchargers", "southern brave", "welsh fire",
  // SA20
  "joburg super kings", "pretoria capitals", "mi cape town", "durban super giants",
  "sunrisers eastern cape", "paarl royals",
  // ILT20
  "dubai capitals", "abu dhabi knight riders", "gulf giants", "desert vipers",
  "sharjah warriors", "mi emirates",
];

// ICC Full Member countries (top-tier cricket nations)
const FULL_MEMBERS = new Set([
  "india", "australia", "england", "south africa", "new zealand",
  "pakistan", "west indies", "sri lanka", "bangladesh", "afghanistan",
  "zimbabwe", "ireland",
]);

// ICC Associate members with established T20 programs
const STRONG_ASSOCIATES = new Set([
  "netherlands", "scotland", "nepal", "usa", "namibia", "oman",
  "united arab emirates", "papua new guinea", "canada", "hong kong",
]);

/**
 * Compute a quality factor (0.5 – 1.0) based on the leagues a player competes in.
 * - 1.0 = plays in top franchise leagues or for Full Member nations
 * - 0.85 = strong associate nations or domestic cricket of full members
 * - 0.7 = weaker associates with some T20I exposure
 * - 0.55 = weakest associates / minimal competition
 */
function getCompetitionQuality(player: EspnPlayer): number {
  const teams = (player.profile.teams || []).map(t => t.toLowerCase());
  const country = extractCountry(player.profile).toLowerCase();

  // Check if player has played in any top franchise league
  const hasTopLeague = teams.some(team =>
    TOP_LEAGUES.some(league => team.includes(league))
  );
  if (hasTopLeague) return 1.0;

  // Full member national team
  if (FULL_MEMBERS.has(country)) return 0.95;

  // Strong associate
  if (STRONG_ASSOCIATES.has(country)) return 0.8;

  // Check if they have T20I stats (class 3) — played international cricket
  const hasT20I = player.careerStats.some(s => s.cl === 3 && s.mt > 0);
  if (hasT20I) return 0.7;

  // Weakest tier — only domestic cricket in weak nations
  return 0.55;
}

// ── IPL Roster Matching ──────────────────────────────────────────────

/**
 * Name aliases to handle mismatches between roster names and ESPN database names.
 * Key: roster name (lowercase), Value: ESPN name (lowercase).
 */
const ROSTER_NAME_ALIASES: Record<string, string> = {
  "shahrukh khan": "m shahrukh khan",
  "mitch owen": "mitchell owen",
  "vyshak vijaykumar": "vijaykumar vyshak",
  "pravin dubey": "praveen dubey",
  "vaibhav suryavanshi": "vaibhav sooryavanshi",
  "kumar kartikeya singh": "kumar kartikeya",
  "raj bawa": "raj\u00a0bawa",  // non-breaking space in ESPN data
};

/**
 * Roster entry with team and price info.
 */
interface RosterEntry {
  teamId: string;
  price: number;
}

/**
 * Build a map from ESPN player name (lowercase) -> { teamId, price } for IPL 2026 rosters.
 * Handles name aliases and normalization.
 */
function buildRosterTeamMap(): Map<string, RosterEntry> {
  const map = new Map<string, RosterEntry>();

  for (const roster of IPL_2026_ROSTERS) {
    for (const player of roster.players) {
      const lowerName = player.name.toLowerCase();
      // Check if there's an alias
      const espnName = ROSTER_NAME_ALIASES[lowerName] ?? lowerName;
      map.set(espnName, { teamId: roster.teamId, price: player.price });
    }
  }

  return map;
}

/**
 * Try to match a rated player name to a roster entry.
 * Uses exact match first, then tries normalized matching.
 */
function findRosterEntry(
  playerName: string,
  rosterMap: Map<string, RosterEntry>,
): RosterEntry | undefined {
  const lower = playerName.toLowerCase();

  // Direct match
  if (rosterMap.has(lower)) return rosterMap.get(lower);

  // Try matching with normalized whitespace (handles non-breaking spaces in ESPN data)
  const normalized = lower.replace(/\s+/g, " ").trim();
  if (rosterMap.has(normalized)) return rosterMap.get(normalized);

  // Try matching against normalized roster entries
  for (const [rosterName, entry] of rosterMap.entries()) {
    const normalizedRoster = rosterName.replace(/\s+/g, " ").trim();
    if (normalized === normalizedRoster) return entry;
  }

  return undefined;
}

// ── Manual Player Entries ────────────────────────────────────────────

/**
 * Key players missing from ESPN scraped data (retired from internationals,
 * or not scraped). These get manual ratings based on known T20 performance.
 */
function getManualPlayers(): RatedPlayer[] {
  return [
    {
      id: "manual_msd",
      name: "MS Dhoni",
      fullName: "Mahendra Singh Dhoni",
      age: 43,
      country: "India",
      battingHand: "right",
      bowlingStyle: "right-arm-medium",
      role: "batsman",
      isInternational: false,
      ratings: { battingIQ: 80, timing: 78, power: 82, running: 50, wicketTaking: 15, economy: 12, accuracy: 18, clutch: 95 },
      overalls: { battingOvr: 80, bowlingOvr: 14, overall: 80 },
      sourceStats: { t20Matches: 272, t20Runs: 5243, t20Average: 37.45, t20StrikeRate: 135.2, t20Fours: 350, t20Sixes: 229, t20Wickets: 0, t20Economy: 0, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_trent_boult",
      name: "Trent Boult",
      fullName: "Trent Alexander Boult",
      age: 35,
      country: "New Zealand",
      battingHand: "right",
      bowlingStyle: "left-arm-fast",
      role: "bowler",
      isInternational: true,
      ratings: { battingIQ: 22, timing: 20, power: 18, running: 25, wicketTaking: 82, economy: 78, accuracy: 80, clutch: 75 },
      overalls: { battingOvr: 20, bowlingOvr: 80, overall: 80 },
      sourceStats: { t20Matches: 310, t20Runs: 300, t20Average: 6.5, t20StrikeRate: 95, t20Fours: 20, t20Sixes: 10, t20Wickets: 380, t20Economy: 7.8, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_andre_russell",
      name: "Andre Russell",
      fullName: "Andre Dwayne Russell",
      age: 36,
      country: "West Indies",
      battingHand: "right",
      bowlingStyle: "right-arm-fast",
      role: "all-rounder",
      isInternational: true,
      ratings: { battingIQ: 65, timing: 60, power: 95, running: 50, wicketTaking: 65, economy: 55, accuracy: 52, clutch: 78 },
      overalls: { battingOvr: 73, bowlingOvr: 61, overall: 75 },
      sourceStats: { t20Matches: 420, t20Runs: 7500, t20Average: 27.5, t20StrikeRate: 170, t20Fours: 450, t20Sixes: 520, t20Wickets: 300, t20Economy: 8.9, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_nicholas_pooran",
      name: "Nicholas Pooran",
      fullName: "Nicholas Pooran",
      age: 29,
      country: "West Indies",
      battingHand: "left",
      bowlingStyle: "unknown",
      role: "batsman",
      isInternational: true,
      ratings: { battingIQ: 80, timing: 81, power: 93, running: 62, wicketTaking: 10, economy: 8, accuracy: 12, clutch: 82 },
      overalls: { battingOvr: 84, bowlingOvr: 14, overall: 84 },
      sourceStats: { t20Matches: 310, t20Runs: 5800, t20Average: 26.8, t20StrikeRate: 155, t20Fours: 380, t20Sixes: 340, t20Wickets: 0, t20Economy: 0, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_rovman_powell",
      name: "Rovman Powell",
      fullName: "Rovman Powell",
      age: 31,
      country: "West Indies",
      battingHand: "right",
      bowlingStyle: "right-arm-medium",
      role: "batsman",
      isInternational: true,
      ratings: { battingIQ: 60, timing: 58, power: 90, running: 55, wicketTaking: 20, economy: 18, accuracy: 22, clutch: 62 },
      overalls: { battingOvr: 69, bowlingOvr: 19, overall: 69 },
      sourceStats: { t20Matches: 220, t20Runs: 3800, t20Average: 22, t20StrikeRate: 148, t20Fours: 200, t20Sixes: 220, t20Wickets: 15, t20Economy: 9.5, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_sherfane_rutherford",
      name: "Sherfane Rutherford",
      fullName: "Sherfane Rutherford",
      age: 27,
      country: "West Indies",
      battingHand: "left",
      bowlingStyle: "right-arm-medium",
      role: "batsman",
      isInternational: true,
      ratings: { battingIQ: 62, timing: 60, power: 85, running: 58, wicketTaking: 18, economy: 15, accuracy: 20, clutch: 60 },
      overalls: { battingOvr: 69, bowlingOvr: 17, overall: 69 },
      sourceStats: { t20Matches: 180, t20Runs: 3200, t20Average: 24, t20StrikeRate: 150, t20Fours: 180, t20Sixes: 190, t20Wickets: 5, t20Economy: 10, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_romario_shepherd",
      name: "Romario Shepherd",
      fullName: "Romario Shepherd",
      age: 30,
      country: "West Indies",
      battingHand: "right",
      bowlingStyle: "right-arm-fast",
      role: "all-rounder",
      isInternational: true,
      ratings: { battingIQ: 55, timing: 52, power: 78, running: 50, wicketTaking: 68, economy: 60, accuracy: 58, clutch: 62 },
      overalls: { battingOvr: 62, bowlingOvr: 63, overall: 65 },
      sourceStats: { t20Matches: 160, t20Runs: 1800, t20Average: 18, t20StrikeRate: 145, t20Fours: 100, t20Sixes: 110, t20Wickets: 140, t20Economy: 8.5, statClass: 6 },
      espnId: 0,
    },
  ];
}

// ── Main generator ────────────────────────────────────────────────────

/**
 * Generate ratings for all ESPN-scraped players.
 */
export function generateAllRatings(): RatedPlayer[] {
  if (!existsSync(ESPN_FILE)) {
    throw new Error(`ESPN players file not found at ${ESPN_FILE}. Run espn-scraper.ts first.`);
  }

  const allPlayers: EspnPlayer[] = JSON.parse(readFileSync(ESPN_FILE, "utf-8"));

  // Filter: male players only
  const malePlayers = allPlayers.filter(p => p.profile.gender === "M");

  console.log(`\n=== Generating ESPN Ratings ===`);
  console.log(`Total scraped: ${allPlayers.length} (male: ${malePlayers.length}, female: ${allPlayers.length - malePlayers.length})`);

  const rated: RatedPlayer[] = [];

  for (const player of malePlayers) {
    const batResult = getT20Stat(player.careerStats, "BATTING");
    const bowlResult = getT20Stat(player.careerStats, "BOWLING");
    const bat = batResult?.stat ?? null;
    const bowl = bowlResult?.stat ?? null;

    // Require at least 10 T20 matches for meaningful ratings
    const matches = bat ? bat.mt : 0;
    if (matches < 10) continue;

    // Filter out retired players
    if (isRetired(player)) continue;

    const input = toCalculatorInput(player);
    const ratings = calculateRatings(input);

    // Competition quality adjustment — regress individual attributes for weak leagues
    const qualityFactor = getCompetitionQuality(player);
    if (qualityFactor < 1.0) {
      ratings.battingIQ = Math.round(50 + (ratings.battingIQ - 50) * qualityFactor);
      ratings.timing = Math.round(50 + (ratings.timing - 50) * qualityFactor);
      ratings.power = Math.round(50 + (ratings.power - 50) * qualityFactor);
      ratings.running = Math.round(50 + (ratings.running - 50) * qualityFactor);
      ratings.wicketTaking = Math.round(50 + (ratings.wicketTaking - 50) * qualityFactor);
      ratings.economy = Math.round(50 + (ratings.economy - 50) * qualityFactor);
      ratings.accuracy = Math.round(50 + (ratings.accuracy - 50) * qualityFactor);
      ratings.clutch = Math.round(50 + (ratings.clutch - 50) * qualityFactor);

      // Recompute overalls from adjusted attributes (must stay consistent with Player class getters)
      recomputeOveralls(ratings);
    }

    // Use ESPN's playingRoles to detect wicket-keepers (inferRole can't distinguish them)
    const espnRoles = player.profile.playingRoles ?? [];
    applyBattingProfileAdjustment(ratings, input, espnRoles);
    const isWicketKeeper = espnRoles.some((r: string) => r.toLowerCase().includes("keeper"));
    const role = resolveRoleFromHint(getEspnRoleHint(espnRoles), inferRole(ratings), ratings);
    const age = calculateAge(player.profile.dateOfBirth);
    const country = extractCountry(player.profile);

    const battingHand = mapBattingHand(player.profile.battingStyles?.[0] ?? "unknown");
    let bowlingStyle = mapBowlingStyle(player.profile.bowlingStyles?.[0] ?? "unknown");
    // Infer bowling style from economy when ESPN has no data but player has bowling stats
    if (bowlingStyle === "unknown" && role === "bowler" && input.wickets > 0) {
      const econ = input.ballsBowled > 0 ? (input.runsConceded / input.ballsBowled) * 6 : 99;
      bowlingStyle = econ < 7.0 ? "off-spin" : "right-arm-medium";
    }

    rated.push({
      id: `espn_${player.profile.espnId}`,
      name: player.profile.longName || player.profile.name,
      fullName: player.profile.longName || player.profile.name,
      age,
      country,
      battingHand,
      bowlingStyle,
      role,
      isWicketKeeper: isWicketKeeper || undefined,
      isInternational: country !== "India",
      ratings: {
        battingIQ: ratings.battingIQ,
        timing: ratings.timing,
        power: ratings.power,
        running: ratings.running,
        wicketTaking: ratings.wicketTaking,
        economy: ratings.economy,
        accuracy: ratings.accuracy,
        clutch: ratings.clutch,
      },
      overalls: {
        battingOvr: ratings.battingOvr,
        bowlingOvr: ratings.bowlingOvr,
        overall: ratings.overall,
      },
      sourceStats: {
        t20Matches: matches,
        t20Runs: bat ? safeNum(bat.rn) : 0,
        t20Average: bat ? safeNum(bat.avg) : 0,
        t20StrikeRate: bat ? safeNum(bat.sr) : 0,
        t20Fours: bat ? safeNum(bat.fo) : 0,
        t20Sixes: bat ? safeNum(bat.si) : 0,
        t20Wickets: bowl ? safeNum(bowl.wk) : 0,
        t20Economy: bowl ? safeNum(bowl.bwe) : 0,
        statClass: batResult?.cl ?? bowlResult?.cl ?? 6,
      },
      espnId: player.profile.espnId,
      imageUrl: player.profile.imageUrl || undefined,
    });
  }

  // ── Assign teamId + price from IPL 2026 rosters ──────────────────
  const rosterMap = buildRosterTeamMap();
  let rosterMatches = 0;
  const unmatchedRoster = new Set(rosterMap.keys());

  for (const p of rated) {
    const entry = findRosterEntry(p.name, rosterMap);
    if (entry) {
      p.teamId = entry.teamId;
      p.price = entry.price;
      rosterMatches++;
      // Remove from unmatched set (normalize to find the key)
      const lower = p.name.toLowerCase();
      unmatchedRoster.delete(lower);
      // Also try alias-resolved name
      for (const [rosterName] of rosterMap.entries()) {
        const normalizedRoster = rosterName.replace(/\s+/g, " ").trim();
        if (lower.replace(/\s+/g, " ").trim() === normalizedRoster) {
          unmatchedRoster.delete(rosterName);
        }
      }
    }
  }

  // ── Add manual players (missing from ESPN data) ──────────────────
  const manualPlayers = getManualPlayers();
  for (const mp of manualPlayers) {
    const entry = findRosterEntry(mp.name, rosterMap);
    if (entry) {
      mp.teamId = entry.teamId;
      mp.price = entry.price;
      unmatchedRoster.delete(mp.name.toLowerCase());
      // Also remove alias
      const alias = ROSTER_NAME_ALIASES[mp.name.toLowerCase()];
      if (alias) unmatchedRoster.delete(alias);
    }
    rated.push(mp);
  }

  // Sort by overall rating descending
  rated.sort((a, b) => b.overalls.overall - a.overalls.overall);

  console.log(`Rated players (10+ T20 matches, male): ${rated.length}`);
  console.log(`\nTop 20:`);
  for (const p of rated.slice(0, 20)) {
    const team = p.teamId ? ` [${p.teamId}]` : "";
    console.log(
      `  ${p.overalls.overall.toString().padStart(2)} ${p.name.padEnd(30)} (${p.country.padEnd(15)}) ${p.role.padEnd(12)} bat:${p.overalls.battingOvr} bowl:${p.overalls.bowlingOvr}${team}`,
    );
  }

  // Show stats about boundary data usage
  const withRealBoundaries = rated.filter(p => p.sourceStats.t20Fours > 0 || p.sourceStats.t20Sixes > 0).length;
  console.log(`\nPlayers with real 4s/6s data: ${withRealBoundaries}/${rated.length}`);

  // Show roster matching stats
  const rosterPlayers = rated.filter(p => p.teamId);
  console.log(`\n=== IPL 2026 Roster Matching ===`);
  console.log(`Roster players matched to ESPN data: ${rosterMatches}`);
  console.log(`Manual players added: ${manualPlayers.length}`);
  console.log(`Total players with teamId: ${rosterPlayers.length}`);
  if (unmatchedRoster.size > 0) {
    console.log(`Unmatched roster names (${unmatchedRoster.size}):`);
    for (const name of unmatchedRoster) {
      console.log(`  - ${name}`);
    }
  }

  // Show per-team breakdown
  console.log(`\nPer-team roster counts:`);
  const teamCounts = new Map<string, number>();
  for (const p of rosterPlayers) {
    teamCounts.set(p.teamId!, (teamCounts.get(p.teamId!) ?? 0) + 1);
  }
  for (const [teamId, count] of [...teamCounts.entries()].sort()) {
    console.log(`  ${teamId.padEnd(5)}: ${count} players`);
  }

  // Save as JSON
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(rated, null, 2), "utf-8");
  console.log(`\nJSON output: ${OUTPUT_JSON}`);

  // Generate TypeScript module
  generateTypeScriptModule(rated);

  return rated;
}

// ── TypeScript module output ──────────────────────────────────────────

/**
 * Write all-players.ts as a const array matching the PlayerData interface.
 */
function generateTypeScriptModule(players: RatedPlayer[]): void {
  const dir = dirname(OUTPUT_TS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entries = players.map(p => {
    const teamIdLine = p.teamId ? `\n    teamId: ${JSON.stringify(p.teamId)},` : "";
    const bidLine = p.price != null ? `\n    bid: ${p.price},` : "";
    return `  {
    id: ${JSON.stringify(p.id)},
    name: ${JSON.stringify(p.name)},
    age: ${p.age},
    country: ${JSON.stringify(p.country)},
    role: ${JSON.stringify(p.role)},
    ratings: { battingIQ: ${p.ratings.battingIQ}, timing: ${p.ratings.timing}, power: ${p.ratings.power}, running: ${p.ratings.running}, wicketTaking: ${p.ratings.wicketTaking}, economy: ${p.ratings.economy}, accuracy: ${p.ratings.accuracy}, clutch: ${p.ratings.clutch} },
    isInternational: ${p.isInternational},${p.isWicketKeeper ? `\n    isWicketKeeper: true,` : ""}
    bowlingStyle: ${JSON.stringify(p.bowlingStyle)},
    battingHand: ${JSON.stringify(p.battingHand)},${p.imageUrl ? `\n    imageUrl: ${JSON.stringify(p.imageUrl)},` : ""}
    careerStats: { m: ${p.sourceStats?.t20Matches ?? 0}, r: ${p.sourceStats?.t20Runs ?? 0}, avg: ${Number(p.sourceStats?.t20Average ?? 0).toFixed(1)}, sr: ${Number(p.sourceStats?.t20StrikeRate ?? 0).toFixed(1)}, w: ${p.sourceStats?.t20Wickets ?? 0}, econ: ${Number(p.sourceStats?.t20Economy ?? 0).toFixed(2)} },${teamIdLine}${bidLine}
  }`;
  }).join(",\n");

  const content = `/**
 * AUTO-GENERATED — Do not edit manually.
 * Generated by: npx tsx src/pipeline/generate-ratings-espn.ts
 * Source: ESPN Cricinfo T20 career stats (cl=6 preferred, cl=3 fallback)
 * Players: ${players.length} (male, 3+ T20 matches)
 * Generated: ${new Date().toISOString()}
 */

import type { PlayerData } from "@ipl-sim/engine";

export const ALL_PLAYERS: Omit<PlayerData, "injured" | "injuryGamesLeft">[] = [
${entries}
];

export const PLAYER_COUNT = ${players.length};
`;

  writeFileSync(OUTPUT_TS, content, "utf-8");
  console.log(`TypeScript output: ${OUTPUT_TS} (${players.length} players)`);
}

// ── Women's League Franchises (for competition quality) ──────────────

const WOMEN_LEAGUES = [
  // WPL
  "mumbai indians", "delhi capitals", "royal challengers",
  "gujarat giants", "up warriorz",
  // WBBL
  "sydney sixers women", "sydney thunder women", "melbourne stars women",
  "melbourne renegades women", "hobart hurricanes women", "brisbane heat women",
  "perth scorchers women", "adelaide strikers women",
  // The Hundred (Women's)
  "oval invincibles", "trent rockets", "manchester originals", "london spirit",
  "birmingham phoenix", "northern superchargers", "southern brave", "welsh fire",
  // WPL team variations
  "royal challengers bangalore women", "royal challengers bengaluru women",
  "trailblazers", "velocity", "supernovas",
];

/**
 * Competition quality for women's cricket.
 * Simpler than men's — most WT20I players are from Full Member nations.
 */
function getCompetitionQualityWomen(player: EspnPlayer): number {
  const teams = (player.profile.teams || []).map(t => t.toLowerCase());
  const country = extractCountry(player.profile).toLowerCase();

  // Check if player has played in top women's leagues
  const hasTopLeague = teams.some(team =>
    WOMEN_LEAGUES.some(league => team.includes(league))
  );
  if (hasTopLeague) return 1.0;

  // Full member national team
  if (FULL_MEMBERS.has(country)) return 0.95;

  // Strong associate women's teams
  const strongWomenAssociates = new Set(["thailand", "nepal", "usa", "scotland", "ireland"]);
  if (strongWomenAssociates.has(country)) return 0.8;

  // Others
  return 0.65;
}

// ── WPL Roster Matching ──────────────────────────────────────────────

/**
 * Name aliases for WPL roster names that differ from ESPN database names.
 * Key: roster name (lowercase), Value: ESPN longName (lowercase).
 */
const WPL_ROSTER_NAME_ALIASES: Record<string, string> = {
  // Name variations between roster and ESPN
  "danielle gibson": "dani gibson",
  // Players listed differently in ESPN vs roster
};

/**
 * Build a map from ESPN player name (lowercase) -> { teamId, price } for WPL 2025 rosters.
 */
function buildWPLRosterTeamMap(): Map<string, RosterEntry> {
  const map = new Map<string, RosterEntry>();

  for (const roster of WPL_2025_ROSTERS) {
    for (const player of roster.players) {
      const lowerName = player.name.toLowerCase();
      const espnName = WPL_ROSTER_NAME_ALIASES[lowerName] ?? lowerName;
      map.set(espnName, { teamId: roster.teamId, price: player.price });
    }
  }

  return map;
}

// ── Women's ratings generator ────────────────────────────────────────

/**
 * Generate ratings for all female ESPN-scraped players.
 * Uses cl=10 (WT20I) stats, minimum 10 matches, age < 38 cutoff.
 */
export function generateWomenRatings(): RatedPlayer[] {
  if (!existsSync(ESPN_FILE)) {
    throw new Error(`ESPN players file not found at ${ESPN_FILE}. Run espn-scraper.ts first.`);
  }

  const allPlayers: EspnPlayer[] = JSON.parse(readFileSync(ESPN_FILE, "utf-8"));
  const femalePlayers = allPlayers.filter(p => p.profile.gender === "F");

  console.log(`\n=== Generating Women's ESPN Ratings ===`);
  console.log(`Total female players scraped: ${femalePlayers.length}`);

  const rated: RatedPlayer[] = [];

  for (const player of femalePlayers) {
    const batResult = getT20Stat(player.careerStats, "BATTING", "F");
    const bowlResult = getT20Stat(player.careerStats, "BOWLING", "F");
    const bat = batResult?.stat ?? null;
    const bowl = bowlResult?.stat ?? null;

    // Require at least 10 WT20I matches for meaningful ratings
    const matches = bat ? bat.mt : 0;
    if (matches < 10) continue;

    // Filter out retired players
    if (isRetiredWomen(player)) continue;

    const input = toCalculatorInput(player, "F");
    const ratings = calculateRatings(input, "women");

    // Competition quality adjustment
    const qualityFactor = getCompetitionQualityWomen(player);
    if (qualityFactor < 1.0) {
      ratings.battingIQ = Math.round(50 + (ratings.battingIQ - 50) * qualityFactor);
      ratings.timing = Math.round(50 + (ratings.timing - 50) * qualityFactor);
      ratings.power = Math.round(50 + (ratings.power - 50) * qualityFactor);
      ratings.running = Math.round(50 + (ratings.running - 50) * qualityFactor);
      ratings.wicketTaking = Math.round(50 + (ratings.wicketTaking - 50) * qualityFactor);
      ratings.economy = Math.round(50 + (ratings.economy - 50) * qualityFactor);
      ratings.accuracy = Math.round(50 + (ratings.accuracy - 50) * qualityFactor);
      ratings.clutch = Math.round(50 + (ratings.clutch - 50) * qualityFactor);

      // Recompute overalls
      recomputeOveralls(ratings);
    }

    // Use ESPN's playingRoles to detect wicket-keepers (inferRole can't distinguish them)
    const espnRoles = player.profile.playingRoles ?? [];
    const isWicketKeeper = espnRoles.some((r: string) => r.toLowerCase().includes("keeper"));
    const role = resolveRoleFromHint(getEspnRoleHint(espnRoles), inferRole(ratings), ratings);
    const age = calculateAge(player.profile.dateOfBirth);
    const country = extractCountry(player.profile);

    const battingHand = mapBattingHand(player.profile.battingStyles?.[0] ?? "unknown");
    let bowlingStyle = mapBowlingStyle(player.profile.bowlingStyles?.[0] ?? "unknown");
    // Infer bowling style from economy when ESPN has no data but player has bowling stats
    if (bowlingStyle === "unknown" && role === "bowler" && input.wickets > 0) {
      const econ = input.ballsBowled > 0 ? (input.runsConceded / input.ballsBowled) * 6 : 99;
      bowlingStyle = econ < 7.0 ? "off-spin" : "right-arm-medium";
    }

    rated.push({
      id: `espn_${player.profile.espnId}`,
      name: player.profile.longName || player.profile.name,
      fullName: player.profile.longName || player.profile.name,
      age,
      country,
      battingHand,
      bowlingStyle,
      role,
      isWicketKeeper: isWicketKeeper || undefined,
      isInternational: country !== "India",
      ratings: {
        battingIQ: ratings.battingIQ,
        timing: ratings.timing,
        power: ratings.power,
        running: ratings.running,
        wicketTaking: ratings.wicketTaking,
        economy: ratings.economy,
        accuracy: ratings.accuracy,
        clutch: ratings.clutch,
      },
      overalls: {
        battingOvr: ratings.battingOvr,
        bowlingOvr: ratings.bowlingOvr,
        overall: ratings.overall,
      },
      sourceStats: {
        t20Matches: matches,
        t20Runs: bat ? safeNum(bat.rn) : 0,
        t20Average: bat ? safeNum(bat.avg) : 0,
        t20StrikeRate: bat ? safeNum(bat.sr) : 0,
        t20Fours: bat ? safeNum(bat.fo) : 0,
        t20Sixes: bat ? safeNum(bat.si) : 0,
        t20Wickets: bowl ? safeNum(bowl.wk) : 0,
        t20Economy: bowl ? safeNum(bowl.bwe) : 0,
        statClass: batResult?.cl ?? bowlResult?.cl ?? 10,
      },
      espnId: player.profile.espnId,
    });
  }

  // ── Assign teamId + price from WPL 2025 rosters ──────────────────
  const rosterMap = buildWPLRosterTeamMap();
  let rosterMatches = 0;
  const unmatchedRoster = new Set(rosterMap.keys());

  for (const p of rated) {
    const entry = findRosterEntry(p.name, rosterMap);
    if (entry) {
      p.teamId = entry.teamId;
      p.price = entry.price;
      rosterMatches++;
      const lower = p.name.toLowerCase();
      unmatchedRoster.delete(lower);
      for (const [rosterName] of rosterMap.entries()) {
        const normalizedRoster = rosterName.replace(/\s+/g, " ").trim();
        if (lower.replace(/\s+/g, " ").trim() === normalizedRoster) {
          unmatchedRoster.delete(rosterName);
        }
      }
    }
  }

  // Sort by overall rating descending
  rated.sort((a, b) => b.overalls.overall - a.overalls.overall);

  console.log(`Rated women players (10+ WT20I matches): ${rated.length}`);
  console.log(`\nTop 20 women:`);
  for (const p of rated.slice(0, 20)) {
    const team = p.teamId ? ` [${p.teamId}]` : "";
    console.log(
      `  ${p.overalls.overall.toString().padStart(2)} ${p.name.padEnd(30)} (${p.country.padEnd(15)}) ${p.role.padEnd(12)} bat:${p.overalls.battingOvr} bowl:${p.overalls.bowlingOvr}${team}`,
    );
  }

  // Show roster matching stats
  const rosterPlayers = rated.filter(p => p.teamId);
  console.log(`\n=== WPL 2025 Roster Matching ===`);
  console.log(`Roster players matched to ESPN data: ${rosterMatches}`);
  console.log(`Total players with teamId: ${rosterPlayers.length}`);
  if (unmatchedRoster.size > 0) {
    console.log(`Unmatched WPL roster names (${unmatchedRoster.size}):`);
    for (const name of unmatchedRoster) {
      console.log(`  - ${name}`);
    }
  }

  // Show per-team breakdown
  console.log(`\nPer-team roster counts:`);
  const teamCounts = new Map<string, number>();
  for (const p of rosterPlayers) {
    teamCounts.set(p.teamId!, (teamCounts.get(p.teamId!) ?? 0) + 1);
  }
  for (const [teamId, count] of [...teamCounts.entries()].sort()) {
    console.log(`  ${teamId.padEnd(5)}: ${count} players`);
  }

  // Save as JSON
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_JSON_WOMEN, JSON.stringify(rated, null, 2), "utf-8");
  console.log(`\nJSON output: ${OUTPUT_JSON_WOMEN}`);

  // Generate TypeScript module for WPL
  generateWPLTypeScriptModule(rated);

  return rated;
}

// ── WPL TypeScript module output ──────────────────────────────────────

/**
 * Write wpl-players.ts with both a compact tuple format and an interface-based accessor.
 */
function generateWPLTypeScriptModule(players: RatedPlayer[]): void {
  const dir = dirname(OUTPUT_TS_WOMEN);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entries = players.map(p => {
    const teamIdLine = p.teamId ? `\n    teamId: ${JSON.stringify(p.teamId)},` : "";
    const bidLine = p.price != null ? `\n    bid: ${p.price},` : "";
    return `  {
    id: ${JSON.stringify(p.id)},
    name: ${JSON.stringify(p.name)},
    age: ${p.age},
    country: ${JSON.stringify(p.country)},
    role: ${JSON.stringify(p.role)},
    ratings: { battingIQ: ${p.ratings.battingIQ}, timing: ${p.ratings.timing}, power: ${p.ratings.power}, running: ${p.ratings.running}, wicketTaking: ${p.ratings.wicketTaking}, economy: ${p.ratings.economy}, accuracy: ${p.ratings.accuracy}, clutch: ${p.ratings.clutch} },
    isInternational: ${p.isInternational},${p.isWicketKeeper ? `\n    isWicketKeeper: true,` : ""}
    bowlingStyle: ${JSON.stringify(p.bowlingStyle)},
    battingHand: ${JSON.stringify(p.battingHand)},${p.imageUrl ? `\n    imageUrl: ${JSON.stringify(p.imageUrl)},` : ""}
    careerStats: { m: ${p.sourceStats?.t20Matches ?? 0}, r: ${p.sourceStats?.t20Runs ?? 0}, avg: ${Number(p.sourceStats?.t20Average ?? 0).toFixed(1)}, sr: ${Number(p.sourceStats?.t20StrikeRate ?? 0).toFixed(1)}, w: ${p.sourceStats?.t20Wickets ?? 0}, econ: ${Number(p.sourceStats?.t20Economy ?? 0).toFixed(2)} },${teamIdLine}${bidLine}
  }`;
  }).join(",\n");

  const content = `/**
 * AUTO-GENERATED — Do not edit manually.
 * Generated by: npx tsx src/pipeline/generate-ratings-espn.ts
 * Source: ESPN Cricinfo WT20I career stats (cl=10)
 * Players: ${players.length} (female, 10+ WT20I matches)
 * Generated: ${new Date().toISOString()}
 */

import type { PlayerData } from "@ipl-sim/engine";
import type { BowlingStyle, BattingHand } from "@ipl-sim/engine";

export const WPL_PLAYERS: Omit<PlayerData, "injured" | "injuryGamesLeft">[] = [
${entries}
];

export const WPL_PLAYER_COUNT = ${players.length};

export interface WPLPlayerData {
  name: string;
  age: number;
  country: string;
  role: string;
  bowlingStyle?: BowlingStyle;
  battingHand?: BattingHand;
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  teamId: string;
  isWicketKeeper?: boolean;
}

export function getWPLPlayers(): WPLPlayerData[] {
  return WPL_PLAYERS
    .filter((p): p is typeof p & { teamId: string } => !!p.teamId)
    .map(p => ({
      name: p.name,
      age: p.age,
      country: p.country,
      role: p.isWicketKeeper ? p.role : p.role,
      bowlingStyle: p.bowlingStyle,
      battingHand: p.battingHand,
      battingIQ: p.ratings.battingIQ,
      timing: p.ratings.timing,
      power: p.ratings.power,
      running: p.ratings.running,
      wicketTaking: p.ratings.wicketTaking,
      economy: p.ratings.economy,
      accuracy: p.ratings.accuracy,
      clutch: p.ratings.clutch,
      teamId: p.teamId,
      isWicketKeeper: p.isWicketKeeper,
    }));
}
`;

  writeFileSync(OUTPUT_TS_WOMEN, content, "utf-8");
  console.log(`TypeScript output: ${OUTPUT_TS_WOMEN} (${players.length} players)`);
}

// ── CLI entry point ───────────────────────────────────────────────────

if (
  process.argv[1]?.endsWith("generate-ratings-espn.ts") ||
  process.argv[1]?.endsWith("generate-ratings-espn.js")
) {
  generateAllRatings();
  generateWomenRatings();
}
