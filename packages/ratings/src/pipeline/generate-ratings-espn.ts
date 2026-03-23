/**
 * Generate player ratings from ESPN Cricinfo scraped data.
 *
 * Reads espn-players.json (6,696 profiles with career stats),
 * filters for male players with 3+ T20 matches,
 * uses the same rating formula as generate-ratings.ts (via calculator.ts),
 * but leverages REAL fours/sixes data (fo/si fields) instead of estimating them.
 *
 * Outputs:
 *   - data/scraped/espn-ratings.json  (full rated player objects)
 *   - src/all-players.ts              (TypeScript module for the app)
 *
 * Usage: npx tsx src/pipeline/generate-ratings-espn.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { calculateRatings, inferRole } from "../calculator.js";
import { OUTPUT_DIR } from "./config.js";
import { IPL_2026_ROSTERS } from "../ipl-rosters.js";

// ── Input / output paths ──────────────────────────────────────────────

const ESPN_FILE = join(OUTPUT_DIR, "espn-players.json");
const OUTPUT_JSON = join(OUTPUT_DIR, "espn-ratings.json");
const OUTPUT_TS = join(dirname(OUTPUT_DIR), "..", "src", "all-players.ts");

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
  battingHand: string;
  bowlingStyle: string;
  role: "batsman" | "bowler" | "all-rounder";
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
 * Prefers cl=6 (all T20s), falls back to cl=3 (T20I).
 */
function getT20Stat(
  stats: EspnCareerStat[],
  type: "BATTING" | "BOWLING",
): { stat: EspnCareerStat; cl: number } | null {
  // Prefer cl=6 (all T20s including franchise)
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
 * Convert ESPN player data to the calculator input format.
 * Uses REAL fours and sixes from ESPN data (fo/si fields).
 */
function toCalculatorInput(player: EspnPlayer) {
  const batResult = getT20Stat(player.careerStats, "BATTING");
  const bowlResult = getT20Stat(player.careerStats, "BOWLING");
  const bat = batResult?.stat ?? null;
  const bowl = bowlResult?.stat ?? null;

  const matches = bat ? bat.mt : 0;
  const battingInnings = bat ? bat.in : 0;
  const notOuts = bat ? safeNum(bat.no) : 0;
  const runs = bat ? safeNum(bat.rn) : 0;
  const ballsFaced = bat ? safeNum(bat.bl) : 0;

  // REAL fours and sixes from ESPN data — the key improvement over the CricketArchive pipeline
  const fours = bat ? safeNum(bat.fo) : 0;
  const sixes = bat ? safeNum(bat.si) : 0;

  // If fo/si are null (some older players), estimate like the original pipeline
  const hasBoundaryData = bat !== null && bat.fo !== null && bat.si !== null;
  let finalFours = fours;
  let finalSixes = sixes;
  if (!hasBoundaryData && runs > 0 && ballsFaced > 0) {
    const sr = (runs / ballsFaced) * 100;
    const boundaryPct = Math.min(0.75, 0.3 + (sr - 100) * 0.003);
    const boundaryRuns = runs * boundaryPct;
    finalSixes = Math.round(boundaryRuns * 0.35 / 6);
    finalFours = Math.round(boundaryRuns * 0.65 / 4);
  }

  const bowlBalls = bowl ? safeNum(bowl.bl) : 0;
  const bowlRuns = bowl ? safeNum(bowl.rn) : 0;
  const wickets = bowl ? safeNum(bowl.wk) : 0;
  const bowlInnings = bowl ? safeNum(bowl.in) : 0;

  // Must have bowled at least 300 balls (50 overs) AND taken 15+ wickets to count as a bowler
  // This filters out part-timers like SKY (138 balls, 8 wickets) and Babar (4 wickets)
  const hasMeaningfulBowling = bowlBalls >= 300 && wickets >= 15;

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
      battingHand: "right-hand bat",
      bowlingStyle: "right-arm medium",
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
      battingHand: "right-hand bat",
      bowlingStyle: "left-arm fast-medium",
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
      battingHand: "right-hand bat",
      bowlingStyle: "right-arm fast-medium",
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
      battingHand: "left-hand bat",
      bowlingStyle: "unknown",
      role: "batsman",
      isInternational: true,
      ratings: { battingIQ: 72, timing: 70, power: 92, running: 60, wicketTaking: 10, economy: 8, accuracy: 12, clutch: 68 },
      overalls: { battingOvr: 78, bowlingOvr: 10, overall: 78 },
      sourceStats: { t20Matches: 310, t20Runs: 5800, t20Average: 26.8, t20StrikeRate: 155, t20Fours: 380, t20Sixes: 340, t20Wickets: 0, t20Economy: 0, statClass: 6 },
      espnId: 0,
    },
    {
      id: "manual_rovman_powell",
      name: "Rovman Powell",
      fullName: "Rovman Powell",
      age: 31,
      country: "West Indies",
      battingHand: "right-hand bat",
      bowlingStyle: "right-arm medium",
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
      battingHand: "left-hand bat",
      bowlingStyle: "right-arm medium",
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
      battingHand: "right-hand bat",
      bowlingStyle: "right-arm fast-medium",
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
      ratings.battingOvr = Math.round(ratings.battingIQ * 0.30 + ratings.timing * 0.30 + ratings.power * 0.35 + ratings.running * 0.05);
      ratings.bowlingOvr = Math.round(ratings.wicketTaking * 0.45 + ratings.economy * 0.30 + ratings.accuracy * 0.10 + ratings.clutch * 0.15);
      const stronger = Math.max(ratings.battingOvr, ratings.bowlingOvr);
      const weaker = Math.min(ratings.battingOvr, ratings.bowlingOvr);
      ratings.overall = Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));
    }

    const role = inferRole(ratings);
    const age = calculateAge(player.profile.dateOfBirth);
    const country = extractCountry(player.profile);

    const battingHand = player.profile.battingStyles?.[0] ?? "unknown";
    const bowlingStyle = player.profile.bowlingStyles?.[0] ?? "unknown";

    rated.push({
      id: `espn_${player.profile.espnId}`,
      name: player.profile.longName || player.profile.name,
      fullName: player.profile.longName || player.profile.name,
      age,
      country,
      battingHand,
      bowlingStyle,
      role,
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
    isInternational: ${p.isInternational},${teamIdLine}${bidLine}
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

// ── CLI entry point ───────────────────────────────────────────────────

if (
  process.argv[1]?.endsWith("generate-ratings-espn.ts") ||
  process.argv[1]?.endsWith("generate-ratings-espn.js")
) {
  generateAllRatings();
}
