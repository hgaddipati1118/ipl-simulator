/**
 * Generate player ratings from ESPN Cricinfo scraped data.
 *
 * Reads espn-players.json (6,696 profiles with career stats),
 * filters for male players with 3+ T20 matches,
 * uses the same rating formula as generate-ratings.ts (via calculator.ts),
 * but leverages REAL fours/sixes data (fo/si fields) instead of estimating them.
 *
 * Also generates women's ratings from the same ESPN data:
 *   - Uses women's T20 rows (prefers cl=9, falls back to cl=10)
 *   - Current WPL roster players can still rate from thinner recent data
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL } from "url";
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
const CRICSHEET_T20I_DIR = join(OUTPUT_DIR, "..", "cricsheet", "t20s_json");

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
    statClass: number;  // which cl was used (6 = all T20s, 3 = T20I, 9/10 = women's T20s)
  };
  espnId: number;
}

interface EliteTournamentPlayerStats {
  matches: number;
  weightedMatches: number;
  knockoutMatches: number;
  battingInnings: number;
  notOuts: number;
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  bowlingInnings: number;
  ballsBowled: number;
  runsConceded: number;
  wickets: number;
}

interface EliteTournamentWeight {
  weight: number;
  isKnockout: boolean;
}

let eliteTournamentStatsCache:
  | { male: Map<string, EliteTournamentPlayerStats>; female: Map<string, EliteTournamentPlayerStats> }
  | null = null;

let recentInternationalStatsCache:
  | { male: Map<string, EliteTournamentPlayerStats>; female: Map<string, EliteTournamentPlayerStats> }
  | null = null;

let recentWomenT20StatsCache: Map<string, EliteTournamentPlayerStats> | null = null;

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
 * For women: Prefers cl=9 (women's T20s), falls back to cl=10 (WT20I).
 */
function getT20Stat(
  stats: EspnCareerStat[],
  type: "BATTING" | "BOWLING",
  gender: "M" | "F" = "M",
): { stat: EspnCareerStat; cl: number } | null {
  if (gender === "F") {
    const cl9 = stats.find(s => s.type === type && s.cl === 9);
    if (cl9) return { stat: cl9, cl: 9 };
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

function isSpinBowlingStyle(style: BowlingStyle): boolean {
  return (
    style === "off-spin" ||
    style === "leg-spin" ||
    style === "left-arm-orthodox" ||
    style === "left-arm-wrist-spin"
  );
}

function normalizePlayerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getNormalizedNameTokens(name: string): string[] {
  return normalizePlayerName(name).split(" ").filter(Boolean);
}

function levenshteinDistance(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    let rowMin = current[0];

    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      const value = Math.min(
        previous[j + 1] + 1,
        current[j] + 1,
        previous[j] + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[previous.length - 1];
}

function isMinorNameVariant(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  const maxDistance = Math.max(a.length, b.length) >= 8 ? 2 : 1;
  return levenshteinDistance(a, b, maxDistance) <= maxDistance;
}

function areNearFullNames(tokensA: string[], tokensB: string[]): boolean {
  if (tokensA.length !== tokensB.length || tokensA.length < 2) return false;

  const candidateOrders = [tokensB];
  if (tokensB.length === 2) {
    candidateOrders.push([tokensB[1], tokensB[0]]);
  }

  for (const candidateTokens of candidateOrders) {
    let exactMatches = 0;
    let compatible = true;

    for (let i = 0; i < tokensA.length; i++) {
      if (tokensA[i] === candidateTokens[i]) {
        exactMatches += 1;
        continue;
      }
      if (!isMinorNameVariant(tokensA[i], candidateTokens[i])) {
        compatible = false;
        break;
      }
    }

    if (compatible && exactMatches >= tokensA.length - 1) {
      return true;
    }
  }

  return false;
}

function getGivenNameInitials(tokens: string[]): string {
  return tokens
    .slice(0, -1)
    .map((token) => (token.length <= 2 ? token : token[0]))
    .join("");
}

function hasAbbreviatedGivenTokens(tokens: string[]): boolean {
  return tokens.slice(0, -1).some((token) => token.length <= 2);
}

function sharesExpandedGivenToken(aTokens: string[], bTokens: string[]): boolean {
  const aExpanded = new Set(aTokens.slice(0, -1).filter((token) => token.length > 2));
  const bExpanded = bTokens.slice(0, -1).filter((token) => token.length > 2);
  return bExpanded.some((token) => aExpanded.has(token));
}

function areNamesCompatible(a: string, b: string): boolean {
  const normalizedA = normalizePlayerName(a);
  const normalizedB = normalizePlayerName(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;

  const tokensA = getNormalizedNameTokens(normalizedA);
  const tokensB = getNormalizedNameTokens(normalizedB);
  if (areNearFullNames(tokensA, tokensB)) return true;
  if (tokensA.length < 2 || tokensB.length < 2) return false;

  const surnameA = tokensA[tokensA.length - 1];
  const surnameB = tokensB[tokensB.length - 1];
  if (surnameA !== surnameB) return false;

  if (!hasAbbreviatedGivenTokens(tokensA) && !hasAbbreviatedGivenTokens(tokensB)) {
    return false;
  }

  if (sharesExpandedGivenToken(tokensA, tokensB)) return true;

  const initialsA = getGivenNameInitials(tokensA);
  const initialsB = getGivenNameInitials(tokensB);
  if (!initialsA || !initialsB) return false;

  return (
    initialsA === initialsB ||
    initialsA.startsWith(initialsB) ||
    initialsB.startsWith(initialsA)
  );
}

function buildNameCandidatesFromString(name: string): string[] {
  const candidates = new Set<string>();
  const normalized = normalizePlayerName(name);
  if (normalized) candidates.add(normalized);

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const initials = parts
      .slice(0, -1)
      .map((part) => (part.length <= 2 ? part : part[0]))
      .join("");
    candidates.add(`${parts[0][0]} ${lastName}`);
    candidates.add(`${initials} ${lastName}`);
  }

  return [...candidates];
}

function createEmptyEliteTournamentStats(): EliteTournamentPlayerStats {
  return {
    matches: 0,
    weightedMatches: 0,
    knockoutMatches: 0,
    battingInnings: 0,
    notOuts: 0,
    runs: 0,
    ballsFaced: 0,
    fours: 0,
    sixes: 0,
    bowlingInnings: 0,
    ballsBowled: 0,
    runsConceded: 0,
    wickets: 0,
  };
}

function getOrCreateEliteTournamentStats(
  map: Map<string, EliteTournamentPlayerStats>,
  playerName: string,
): EliteTournamentPlayerStats {
  const normalizedName = normalizePlayerName(playerName);
  const existing = map.get(normalizedName);
  if (existing) return existing;

  const created = createEmptyEliteTournamentStats();
  map.set(normalizedName, created);
  return created;
}

function getEliteTournamentWeight(info: Record<string, any> | undefined): EliteTournamentWeight | null {
  const event = info?.event;
  const eventName = typeof event === "string" ? event : event?.name ?? "";
  if (!eventName) return null;

  if (/qualifier|region|sub regional|division/i.test(eventName)) {
    return null;
  }

  let baseWeight = 0;
  if (/icc (men'?s|women'?s) t20 world cup|world twenty20|women's world t20|world t20/i.test(eventName)) {
    baseWeight = 1.0;
  } else if (/asia cup/i.test(eventName) && /t20/i.test(eventName)) {
    baseWeight = 0.82;
  } else {
    return null;
  }

  const stageText = `${info?.stage ?? ""} ${typeof event === "object" ? event?.stage ?? "" : ""}`.trim();
  const groupText = typeof event === "object" ? event?.group ?? "" : "";

  let stageWeight = 1.0;
  if (/final/i.test(stageText)) {
    stageWeight = 1.4;
  } else if (/semi/i.test(stageText)) {
    stageWeight = 1.22;
  } else if (/super/i.test(groupText)) {
    stageWeight = 1.08;
  }

  return {
    weight: baseWeight * stageWeight,
    isKnockout: /semi|final/i.test(stageText),
  };
}

function isBowlerCreditedDismissal(kind: string | undefined): boolean {
  if (!kind) return false;
  const normalized = kind.toLowerCase();
  return !(
    normalized === "run out" ||
    normalized === "retired hurt" ||
    normalized === "retired out" ||
    normalized === "obstructing the field"
  );
}

function buildEliteTournamentNameCandidates(player: EspnPlayer): string[] {
  const candidates = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    candidates.add(normalizePlayerName(value));
  };

  add(player.profile.longName);
  add(player.profile.name);

  const fullName = player.profile.longName || player.profile.name;
  if (fullName) {
    const parts = fullName.replace(/\./g, "").split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      const initials = parts.slice(0, -1).map((part) => part[0]).join("");
      add(`${parts[0][0]} ${lastName}`);
      add(`${initials} ${lastName}`);
    }
  }

  return [...candidates];
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

function resolveWomenRoleFromHint(
  hintedRole: "batsman" | "bowler" | "all-rounder" | undefined,
  inferredRole: "batsman" | "bowler" | "all-rounder",
  ratings: CalculatedRatings,
  input: {
    matches: number;
    battingInnings: number;
    runs: number;
    ballsFaced: number;
    bowlingInnings: number;
    ballsBowled: number;
    wickets: number;
  },
): "batsman" | "bowler" | "all-rounder" {
  const weaker = Math.min(ratings.battingOvr, ratings.bowlingOvr);
  const stronger = Math.max(ratings.battingOvr, ratings.bowlingOvr);
  const diff = Math.abs(ratings.battingOvr - ratings.bowlingOvr);
  const bowlShare = input.matches > 0 ? input.bowlingInnings / input.matches : 0;
  const batShare = input.matches > 0 ? input.battingInnings / input.matches : 0;
  const ballsPerMatch = input.matches > 0 ? input.ballsBowled / input.matches : 0;
  const wicketsPerMatch = input.matches > 0 ? input.wickets / input.matches : 0;
  const runsPerMatch = input.matches > 0 ? input.runs / input.matches : 0;
  const bowlingWorkload =
    input.bowlingInnings >= Math.max(8, Math.round(input.matches * 0.35)) &&
    input.ballsBowled >= 60 &&
    input.wickets >= 8;

  const hintedAllRounderProfile =
    bowlingWorkload &&
    weaker >= 56 &&
    stronger >= 68 &&
    diff <= 30;

  const battingAllRounderProfile =
    ratings.battingOvr >= 72 &&
    ratings.bowlingOvr >= 54 &&
    bowlingWorkload &&
    bowlShare >= 0.35 &&
    ballsPerMatch >= 4 &&
    wicketsPerMatch >= 0.2;

  const bowlingAllRounderProfile =
    ratings.bowlingOvr >= 70 &&
    ratings.battingOvr >= 58 &&
    batShare >= 0.35 &&
    runsPerMatch >= 7;

  if (!hintedRole) {
    if (battingAllRounderProfile || bowlingAllRounderProfile) {
      return "all-rounder";
    }
    return inferredRole;
  }

  if (hintedRole === "all-rounder") {
    if (hintedAllRounderProfile || battingAllRounderProfile || bowlingAllRounderProfile) {
      return "all-rounder";
    }
    return inferredRole;
  }

  if (hintedRole === "batsman") {
    if (battingAllRounderProfile) {
      return "all-rounder";
    }
    return ratings.battingOvr >= ratings.bowlingOvr ? "batsman" : inferredRole;
  }

  if (bowlingAllRounderProfile) {
    return "all-rounder";
  }

  const hintedBowlerProfile =
    bowlingWorkload &&
    bowlShare >= 0.45 &&
    wicketsPerMatch >= 0.35 &&
    ratings.bowlingOvr >= 55;
  if (hintedBowlerProfile) {
    return "bowler";
  }

  const bowlingCloseCall =
    ratings.bowlingOvr >= 58 &&
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

  const battingMatches = bat ? safeNum(bat.mt) : 0;
  const bowlingMatches = bowl ? safeNum(bowl.mt) : 0;
  const matches = Math.max(battingMatches, bowlingMatches);
  const battingInnings = bat ? safeNum(bat.in) : 0;
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

function loadRecentInternationalT20Stats():
  { male: Map<string, EliteTournamentPlayerStats>; female: Map<string, EliteTournamentPlayerStats> } {
  if (recentInternationalStatsCache) return recentInternationalStatsCache;

  const empty = {
    male: new Map<string, EliteTournamentPlayerStats>(),
    female: new Map<string, EliteTournamentPlayerStats>(),
  };

  if (!existsSync(CRICSHEET_T20I_DIR)) {
    recentInternationalStatsCache = empty;
    return empty;
  }

  const files = readdirSync(CRICSHEET_T20I_DIR).filter((file) => file.endsWith(".json") && !file.startsWith("README"));

  for (const file of files) {
    try {
      const match = JSON.parse(readFileSync(join(CRICSHEET_T20I_DIR, file), "utf-8"));
      const info = match.info as Record<string, any> | undefined;
      const matchDate = info?.dates?.[0];
      if (!matchDate || parseInt(String(matchDate).slice(0, 4), 10) < 2021) continue;

      const statsByName = info?.gender === "female" ? empty.female : empty.male;
      const matchPlayers = new Set<string>();
      const infoPlayers = info?.players ?? {};
      for (const teamPlayers of Object.values(infoPlayers)) {
        if (!Array.isArray(teamPlayers)) continue;
        for (const playerName of teamPlayers) {
          if (typeof playerName !== "string") continue;
          matchPlayers.add(normalizePlayerName(playerName));
        }
      }

      for (const playerName of matchPlayers) {
        const playerStats = getOrCreateEliteTournamentStats(statsByName, playerName);
        playerStats.matches += 1;
        playerStats.weightedMatches += 1;
      }

      for (const inning of match.innings ?? []) {
        const battingThisInnings = new Set<string>();
        const dismissedThisInnings = new Set<string>();
        const bowlingThisInnings = new Set<string>();

        for (const over of inning.overs ?? []) {
          for (const delivery of over.deliveries ?? []) {
            const batterName = typeof delivery.batter === "string" ? normalizePlayerName(delivery.batter) : "";
            const bowlerName = typeof delivery.bowler === "string" ? normalizePlayerName(delivery.bowler) : "";
            const extras = delivery.extras ?? {};
            const batterRuns = safeNum(delivery.runs?.batter);
            const totalRuns = safeNum(delivery.runs?.total);

            if (batterName) {
              battingThisInnings.add(batterName);
              const batterStats = getOrCreateEliteTournamentStats(statsByName, batterName);
              batterStats.runs += batterRuns;
              if (!extras.wides) batterStats.ballsFaced += 1;
              if (batterRuns === 4) batterStats.fours += 1;
              if (batterRuns === 6) batterStats.sixes += 1;
            }

            if (bowlerName) {
              bowlingThisInnings.add(bowlerName);
              const bowlerStats = getOrCreateEliteTournamentStats(statsByName, bowlerName);
              if (!extras.wides && !extras.noballs) {
                bowlerStats.ballsBowled += 1;
              }
              const byes = safeNum(extras.byes);
              const legByes = safeNum(extras.legbyes);
              bowlerStats.runsConceded += Math.max(0, totalRuns - byes - legByes);
            }

            for (const wicket of delivery.wickets ?? []) {
              const playerOut = typeof wicket.player_out === "string" ? normalizePlayerName(wicket.player_out) : "";
              if (playerOut) dismissedThisInnings.add(playerOut);
              if (bowlerName && isBowlerCreditedDismissal(wicket.kind)) {
                getOrCreateEliteTournamentStats(statsByName, bowlerName).wickets += 1;
              }
            }
          }
        }

        const battingInningsPlayers = new Set([...battingThisInnings, ...dismissedThisInnings]);
        for (const playerName of battingInningsPlayers) {
          const playerStats = getOrCreateEliteTournamentStats(statsByName, playerName);
          playerStats.battingInnings += 1;
          if (!dismissedThisInnings.has(playerName)) {
            playerStats.notOuts += 1;
          }
        }

        for (const playerName of bowlingThisInnings) {
          getOrCreateEliteTournamentStats(statsByName, playerName).bowlingInnings += 1;
        }
      }
    } catch {
      // Ignore malformed Cricsheet files and keep generation deterministic.
    }
  }

  recentInternationalStatsCache = empty;
  return empty;
}

function loadRecentWomenT20Stats(): Map<string, EliteTournamentPlayerStats> {
  if (recentWomenT20StatsCache) return recentWomenT20StatsCache;

  const statsByName = new Map<string, EliteTournamentPlayerStats>();
  if (!existsSync(CRICSHEET_T20I_DIR)) {
    recentWomenT20StatsCache = statsByName;
    return statsByName;
  }

  const files = readdirSync(CRICSHEET_T20I_DIR).filter((file) => file.endsWith(".json") && !file.startsWith("README"));

  for (const file of files) {
    try {
      const match = JSON.parse(readFileSync(join(CRICSHEET_T20I_DIR, file), "utf-8"));
      const info = match.info as Record<string, any> | undefined;
      const matchDate = info?.dates?.[0];
      if (info?.gender !== "female") continue;
      if (!matchDate || parseInt(String(matchDate).slice(0, 4), 10) < 2023) continue;

      const matchPlayers = new Set<string>();
      const infoPlayers = info?.players ?? {};
      for (const teamPlayers of Object.values(infoPlayers)) {
        if (!Array.isArray(teamPlayers)) continue;
        for (const playerName of teamPlayers) {
          if (typeof playerName !== "string") continue;
          matchPlayers.add(normalizePlayerName(playerName));
        }
      }

      for (const playerName of matchPlayers) {
        const playerStats = getOrCreateEliteTournamentStats(statsByName, playerName);
        playerStats.matches += 1;
        playerStats.weightedMatches += 1;
      }

      for (const inning of match.innings ?? []) {
        const battingThisInnings = new Set<string>();
        const dismissedThisInnings = new Set<string>();
        const bowlingThisInnings = new Set<string>();

        for (const over of inning.overs ?? []) {
          for (const delivery of over.deliveries ?? []) {
            const batterName = typeof delivery.batter === "string" ? normalizePlayerName(delivery.batter) : "";
            const bowlerName = typeof delivery.bowler === "string" ? normalizePlayerName(delivery.bowler) : "";
            const extras = delivery.extras ?? {};
            const batterRuns = safeNum(delivery.runs?.batter);
            const totalRuns = safeNum(delivery.runs?.total);

            if (batterName) {
              battingThisInnings.add(batterName);
              const batterStats = getOrCreateEliteTournamentStats(statsByName, batterName);
              batterStats.runs += batterRuns;
              if (!extras.wides) batterStats.ballsFaced += 1;
              if (batterRuns === 4) batterStats.fours += 1;
              if (batterRuns === 6) batterStats.sixes += 1;
            }

            if (bowlerName) {
              bowlingThisInnings.add(bowlerName);
              const bowlerStats = getOrCreateEliteTournamentStats(statsByName, bowlerName);
              if (!extras.wides && !extras.noballs) {
                bowlerStats.ballsBowled += 1;
              }
              const byes = safeNum(extras.byes);
              const legByes = safeNum(extras.legbyes);
              bowlerStats.runsConceded += Math.max(0, totalRuns - byes - legByes);
            }

            for (const wicket of delivery.wickets ?? []) {
              const playerOut = typeof wicket.player_out === "string" ? normalizePlayerName(wicket.player_out) : "";
              if (playerOut) dismissedThisInnings.add(playerOut);
              if (bowlerName && isBowlerCreditedDismissal(wicket.kind)) {
                getOrCreateEliteTournamentStats(statsByName, bowlerName).wickets += 1;
              }
            }
          }
        }

        const battingInningsPlayers = new Set([...battingThisInnings, ...dismissedThisInnings]);
        for (const playerName of battingInningsPlayers) {
          const playerStats = getOrCreateEliteTournamentStats(statsByName, playerName);
          playerStats.battingInnings += 1;
          if (!dismissedThisInnings.has(playerName)) {
            playerStats.notOuts += 1;
          }
        }

        for (const playerName of bowlingThisInnings) {
          getOrCreateEliteTournamentStats(statsByName, playerName).bowlingInnings += 1;
        }
      }
    } catch {
      // Ignore malformed Cricsheet files and keep generation deterministic.
    }
  }

  recentWomenT20StatsCache = statsByName;
  return statsByName;
}

function applyWomenRecentT20Fallback(
  input: ReturnType<typeof toCalculatorInput>,
  recentStats: EliteTournamentPlayerStats | null,
): ReturnType<typeof toCalculatorInput> {
  if (!recentStats) return input;

  const hasRecentBatting = recentStats.battingInnings >= 2 && recentStats.ballsFaced >= 18 && recentStats.runs >= 20;
  const hasRecentBowling = recentStats.bowlingInnings >= 2 && recentStats.ballsBowled >= 24;

  const merged = {
    ...input,
    matches: Math.max(input.matches, recentStats.matches),
  };

  const shouldUseBatting =
    hasRecentBatting &&
    (input.battingInnings === 0 || recentStats.battingInnings > input.battingInnings || recentStats.ballsFaced > input.ballsFaced);
  if (shouldUseBatting) {
    merged.battingInnings = recentStats.battingInnings;
    merged.notOuts = recentStats.notOuts;
    merged.runs = recentStats.runs;
    merged.ballsFaced = recentStats.ballsFaced;
    merged.fours = recentStats.fours;
    merged.sixes = recentStats.sixes;
  }

  const shouldUseBowling =
    hasRecentBowling &&
    (input.bowlingInnings === 0 || recentStats.bowlingInnings > input.bowlingInnings || recentStats.ballsBowled > input.ballsBowled);
  if (shouldUseBowling) {
    merged.bowlingInnings = recentStats.bowlingInnings;
    merged.ballsBowled = recentStats.ballsBowled;
    merged.runsConceded = recentStats.runsConceded;
    merged.wickets = recentStats.wickets;
  }

  return merged;
}

function applyRecentInternationalFallback(
  input: ReturnType<typeof toCalculatorInput>,
  recentStats: EliteTournamentPlayerStats | null,
): ReturnType<typeof toCalculatorInput> {
  if (!recentStats) return input;

  const hasRecentBatting = recentStats.battingInnings >= 2 && recentStats.ballsFaced >= 18 && recentStats.runs >= 20;
  const hasRecentBowling = recentStats.bowlingInnings >= 2 && recentStats.ballsBowled >= 24 && recentStats.wickets >= 1;

  const merged = {
    ...input,
    matches: Math.max(input.matches, recentStats.matches),
  };

  if (input.battingInnings === 0 && hasRecentBatting) {
    merged.battingInnings = recentStats.battingInnings;
    merged.notOuts = recentStats.notOuts;
    merged.runs = recentStats.runs;
    merged.ballsFaced = recentStats.ballsFaced;
    merged.fours = recentStats.fours;
    merged.sixes = recentStats.sixes;
  }

  if (input.bowlingInnings === 0 && hasRecentBowling) {
    merged.bowlingInnings = recentStats.bowlingInnings;
    merged.ballsBowled = recentStats.ballsBowled;
    merged.runsConceded = recentStats.runsConceded;
    merged.wickets = recentStats.wickets;
  }

  return merged;
}

function loadEliteTournamentStats():
  { male: Map<string, EliteTournamentPlayerStats>; female: Map<string, EliteTournamentPlayerStats> } {
  if (eliteTournamentStatsCache) return eliteTournamentStatsCache;

  const empty = {
    male: new Map<string, EliteTournamentPlayerStats>(),
    female: new Map<string, EliteTournamentPlayerStats>(),
  };

  if (!existsSync(CRICSHEET_T20I_DIR)) {
    eliteTournamentStatsCache = empty;
    return empty;
  }

  const files = readdirSync(CRICSHEET_T20I_DIR).filter((file) => file.endsWith(".json") && !file.startsWith("README"));

  for (const file of files) {
    try {
      const match = JSON.parse(readFileSync(join(CRICSHEET_T20I_DIR, file), "utf-8"));
      const info = match.info as Record<string, any> | undefined;
      const matchDate = info?.dates?.[0];
      if (!matchDate || parseInt(String(matchDate).slice(0, 4), 10) < 2021) continue;

      const tournamentWeight = getEliteTournamentWeight(info);
      if (!tournamentWeight) continue;

      const statsByName = info?.gender === "female" ? empty.female : empty.male;
      const matchPlayers = new Set<string>();
      const infoPlayers = info?.players ?? {};
      for (const teamPlayers of Object.values(infoPlayers)) {
        if (!Array.isArray(teamPlayers)) continue;
        for (const playerName of teamPlayers) {
          if (typeof playerName !== "string") continue;
          matchPlayers.add(normalizePlayerName(playerName));
        }
      }

      for (const playerName of matchPlayers) {
        const playerStats = getOrCreateEliteTournamentStats(statsByName, playerName);
        playerStats.matches += 1;
        playerStats.weightedMatches += tournamentWeight.weight;
        if (tournamentWeight.isKnockout) playerStats.knockoutMatches += 1;
      }

      for (const inning of match.innings ?? []) {
        const battingThisInnings = new Set<string>();
        const dismissedThisInnings = new Set<string>();
        const bowlingThisInnings = new Set<string>();

        for (const over of inning.overs ?? []) {
          for (const delivery of over.deliveries ?? []) {
            const batterName = typeof delivery.batter === "string" ? normalizePlayerName(delivery.batter) : "";
            const bowlerName = typeof delivery.bowler === "string" ? normalizePlayerName(delivery.bowler) : "";
            const extras = delivery.extras ?? {};
            const batterRuns = safeNum(delivery.runs?.batter);
            const totalRuns = safeNum(delivery.runs?.total);

            if (batterName) {
              battingThisInnings.add(batterName);
              const batterStats = getOrCreateEliteTournamentStats(statsByName, batterName);
              batterStats.runs += batterRuns;
              if (!extras.wides) batterStats.ballsFaced += 1;
              if (batterRuns === 4) batterStats.fours += 1;
              if (batterRuns === 6) batterStats.sixes += 1;
            }

            if (bowlerName) {
              bowlingThisInnings.add(bowlerName);
              const bowlerStats = getOrCreateEliteTournamentStats(statsByName, bowlerName);
              if (!extras.wides && !extras.noballs) {
                bowlerStats.ballsBowled += 1;
              }
              const byes = safeNum(extras.byes);
              const legByes = safeNum(extras.legbyes);
              bowlerStats.runsConceded += Math.max(0, totalRuns - byes - legByes);
            }

            for (const wicket of delivery.wickets ?? []) {
              const playerOut = typeof wicket.player_out === "string" ? normalizePlayerName(wicket.player_out) : "";
              if (playerOut) dismissedThisInnings.add(playerOut);
              if (bowlerName && isBowlerCreditedDismissal(wicket.kind)) {
                getOrCreateEliteTournamentStats(statsByName, bowlerName).wickets += 1;
              }
            }
          }
        }

        const battingInningsPlayers = new Set([...battingThisInnings, ...dismissedThisInnings]);
        for (const playerName of battingInningsPlayers) {
          const playerStats = getOrCreateEliteTournamentStats(statsByName, playerName);
          playerStats.battingInnings += 1;
          if (!dismissedThisInnings.has(playerName)) {
            playerStats.notOuts += 1;
          }
        }

        for (const playerName of bowlingThisInnings) {
          getOrCreateEliteTournamentStats(statsByName, playerName).bowlingInnings += 1;
        }
      }
    } catch {
      // Ignore malformed Cricsheet files and keep generation deterministic.
    }
  }

  eliteTournamentStatsCache = empty;
  return empty;
}

function findEliteTournamentStatsForPlayer(
  player: EspnPlayer,
  statsByName: Map<string, EliteTournamentPlayerStats>,
): EliteTournamentPlayerStats | null {
  for (const candidate of buildEliteTournamentNameCandidates(player)) {
    const match = statsByName.get(candidate);
    if (match) return match;
  }
  return null;
}

function applyEliteTournamentAdjustment(
  ratings: CalculatedRatings,
  baseInput: ReturnType<typeof toCalculatorInput>,
  eliteStats: EliteTournamentPlayerStats | null,
  gender: "M" | "F" = "M",
): void {
  if (!eliteStats || eliteStats.matches < 2) return;

  const hasEliteBatting = eliteStats.battingInnings >= 2 && eliteStats.ballsFaced >= 20 && eliteStats.runs > 0;
  const hasEliteBowling = eliteStats.bowlingInnings >= 2 && eliteStats.ballsBowled >= 24 && eliteStats.wickets > 0;
  if (!hasEliteBatting && !hasEliteBowling) return;

  const eliteInput = {
    ...baseInput,
    matches: eliteStats.matches,
    battingInnings: eliteStats.battingInnings,
    notOuts: eliteStats.notOuts,
    runs: eliteStats.runs,
    ballsFaced: eliteStats.ballsFaced,
    fours: eliteStats.fours,
    sixes: eliteStats.sixes,
    bowlingInnings: eliteStats.bowlingInnings,
    ballsBowled: eliteStats.ballsBowled,
    runsConceded: eliteStats.runsConceded,
    wickets: eliteStats.wickets,
    catches: 0,
  };
  const eliteRatings = calculateRatings(eliteInput, gender === "F" ? "women" : "men");

  const volumeFactor = Math.min(1, eliteStats.weightedMatches / 9);
  const knockoutLift = Math.min(0.08, eliteStats.knockoutMatches * 0.02);
  const blend = Math.min(0.28, 0.08 + volumeFactor * 0.14 + knockoutLift);

  let clutchBonus = 0;

  if (hasEliteBatting && eliteRatings.battingOvr > ratings.battingOvr + 2) {
    const battingWeight = Math.max(0, eliteRatings.battingOvr - ratings.battingOvr) * blend;
    ratings.battingIQ = clamp(
      ratings.battingIQ + Math.max(0, Math.min(4, Math.round((eliteRatings.battingIQ - ratings.battingIQ) * blend * 0.55))),
      15,
      99,
    );
    ratings.timing = clamp(
      ratings.timing + Math.max(0, Math.min(4, Math.round((eliteRatings.timing - ratings.timing) * blend * 0.55))),
      15,
      99,
    );
    ratings.power = clamp(
      ratings.power + Math.max(0, Math.min(3, Math.round((eliteRatings.power - ratings.power) * blend * 0.4))),
      15,
      99,
    );
    ratings.running = clamp(
      ratings.running + Math.max(0, Math.min(2, Math.round((eliteRatings.running - ratings.running) * blend * 0.3))),
      15,
      99,
    );
    clutchBonus = Math.max(clutchBonus, Math.round(battingWeight * 0.8));
  }

  if (hasEliteBowling && eliteRatings.bowlingOvr > ratings.bowlingOvr + 2) {
    const bowlingWeight = Math.max(0, eliteRatings.bowlingOvr - ratings.bowlingOvr) * blend;
    ratings.wicketTaking = clamp(
      ratings.wicketTaking + Math.max(0, Math.min(4, Math.round((eliteRatings.wicketTaking - ratings.wicketTaking) * blend * 0.6))),
      15,
      99,
    );
    ratings.economy = clamp(
      ratings.economy + Math.max(0, Math.min(4, Math.round((eliteRatings.economy - ratings.economy) * blend * 0.55))),
      15,
      99,
    );
    ratings.accuracy = clamp(
      ratings.accuracy + Math.max(0, Math.min(4, Math.round((eliteRatings.accuracy - ratings.accuracy) * blend * 0.6))),
      15,
      99,
    );
    clutchBonus = Math.max(clutchBonus, Math.round(bowlingWeight * 0.85));
  }

  if (clutchBonus > 0) {
    ratings.clutch = clamp(ratings.clutch + Math.min(6, clutchBonus + eliteStats.knockoutMatches), 15, 99);
  }

  recomputeOveralls(ratings);
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

function applyBowlingRoleAdjustment(
  ratings: CalculatedRatings,
  input: {
    matches: number;
    bowlingInnings: number;
    ballsBowled: number;
    runsConceded: number;
    wickets: number;
  },
  espnRoles: string[],
  bowlingStyle: BowlingStyle,
): void {
  if (input.matches === 0 || input.ballsBowled === 0 || input.wickets === 0) return;

  const normalizedRoles = espnRoles.map((role) => role.toLowerCase().replace(/-/g, " ").trim());
  const bowlShare = input.bowlingInnings / input.matches;
  const ballsPerMatch = input.ballsBowled / input.matches;
  const strikeRate = input.ballsBowled / input.wickets;
  const economyRate = input.runsConceded / Math.max(1, input.ballsBowled / 6);
  const wicketsPerMatch = input.wickets / input.matches;

  const isBowlingPrimary = normalizedRoles.some(
    (role) => role.includes("bowler") || role.includes("bowling allrounder"),
  );
  const isBattingPrimary = normalizedRoles.some((role) =>
    role.includes("batter") ||
    role.includes("batting allrounder") ||
    role.includes("middle order") ||
    role.includes("top order") ||
    role.includes("opening") ||
    role.includes("keeper"),
  );
  const isBattingAllRounder = normalizedRoles.some((role) => role.includes("batting allrounder"));

  const frontlineBowler =
    isBowlingPrimary ||
    (bowlShare >= 0.82 && ballsPerMatch >= 18 && wicketsPerMatch >= 0.75);
  const isSpinBowler = isSpinBowlingStyle(bowlingStyle);

  if (frontlineBowler) {
    let bowlingFloor = Math.round(
      48 +
      wicketsPerMatch * 16 +
      Math.max(0, 22 - strikeRate) * 1.2 -
      Math.max(0, economyRate - 8.4) * 7,
    );
    bowlingFloor = clamp(bowlingFloor, 56, 72);
    if (economyRate <= 8.8 && wicketsPerMatch >= 1.0) {
      bowlingFloor = Math.min(74, bowlingFloor + 2);
    }

    const gap = bowlingFloor - ratings.bowlingOvr;
    if (gap > 0) {
      ratings.wicketTaking = clamp(ratings.wicketTaking + Math.round(gap * 1.2), 15, 99);
      ratings.economy = clamp(ratings.economy + Math.round(gap * 0.8), 15, 99);
      ratings.accuracy = clamp(ratings.accuracy + Math.round(gap * 0.9), 15, 99);
      ratings.clutch = clamp(ratings.clutch + Math.round(gap * 0.7), 15, 99);
      recomputeOveralls(ratings);
    }
  }

  const lowExperienceSpecialistSpin =
    frontlineBowler &&
    isSpinBowler &&
    input.matches < 40 &&
    bowlShare >= 0.82 &&
    ballsPerMatch >= 16;

  if (lowExperienceSpecialistSpin) {
    let bowlingCap = Math.round(
      68 +
      Math.max(0, input.matches - 10) * 0.18 +
      Math.max(0, wicketsPerMatch - 0.8) * 4 -
      Math.max(0, economyRate - 7.8) * 2,
    );
    bowlingCap = clamp(bowlingCap, 68, 74);
    if (input.matches < 24) bowlingCap = Math.min(bowlingCap, 71);
    else if (input.matches < 36) bowlingCap = Math.min(bowlingCap, 72);

    const gap = ratings.bowlingOvr - bowlingCap;
    if (gap > 0) {
      ratings.wicketTaking = clamp(ratings.wicketTaking - Math.round(gap * 1.0), 15, 99);
      ratings.economy = clamp(ratings.economy - Math.round(gap * 0.7), 15, 99);
      ratings.accuracy = clamp(ratings.accuracy - Math.round(gap * 0.9), 15, 99);
      ratings.clutch = clamp(ratings.clutch - Math.round(gap * 0.6), 15, 99);
      recomputeOveralls(ratings);
    }
  }

  if (isBattingPrimary && !isBowlingPrimary) {
    let bowlingCap = Math.round(50 + ballsPerMatch * 1.5 + bowlShare * 10.5);
    bowlingCap = clamp(bowlingCap, 42, 74);
    if (isBattingAllRounder && ballsPerMatch >= 6 && wicketsPerMatch >= 0.25) {
      bowlingCap = Math.max(bowlingCap, 66);
    }

    const gap = ratings.bowlingOvr - bowlingCap;
    if (gap > 0) {
      ratings.wicketTaking = clamp(ratings.wicketTaking - Math.round(gap * 1.0), 15, 99);
      ratings.economy = clamp(ratings.economy - Math.round(gap * 0.75), 15, 99);
      ratings.accuracy = clamp(ratings.accuracy - Math.round(gap * 0.85), 15, 99);
      ratings.clutch = clamp(ratings.clutch - Math.round(gap * 0.55), 15, 99);
      recomputeOveralls(ratings);
    }
  }
}

function applyWomenAllRounderFloor(
  ratings: CalculatedRatings,
  input: {
    matches: number;
    battingInnings: number;
    bowlingInnings: number;
  },
  espnRoles: string[],
): void {
  if (getEspnRoleHint(espnRoles) !== "all-rounder") return;

  const weaker = Math.min(ratings.battingOvr, ratings.bowlingOvr);
  const stronger = Math.max(ratings.battingOvr, ratings.bowlingOvr);
  const diff = Math.abs(ratings.battingOvr - ratings.bowlingOvr);
  const battingShare = input.matches > 0 ? input.battingInnings / input.matches : 0;
  const bowlingShare = input.matches > 0 ? input.bowlingInnings / input.matches : 0;
  const dualDisciplineUsage =
    battingShare >= 0.35 &&
    bowlingShare >= 0.3 &&
    input.battingInnings >= 8 &&
    input.bowlingInnings >= 8;

  if (!dualDisciplineUsage) return;
  if (weaker < 56 || diff > 24) return;
  if (weaker >= 60 && stronger >= 72) return;

  if (ratings.battingOvr >= ratings.bowlingOvr) {
    const bowlingGap = Math.max(0, 60 - ratings.bowlingOvr);
    const battingGap = Math.max(0, 72 - ratings.battingOvr);
    ratings.wicketTaking = clamp(ratings.wicketTaking + Math.min(5, Math.round(bowlingGap * 1.0)), 15, 99);
    ratings.economy = clamp(ratings.economy + Math.min(4, Math.round(bowlingGap * 0.7)), 15, 99);
    ratings.accuracy = clamp(ratings.accuracy + Math.min(4, Math.round(bowlingGap * 0.8)), 15, 99);
    ratings.battingIQ = clamp(ratings.battingIQ + Math.min(2, Math.round(battingGap * 0.5)), 15, 99);
    ratings.timing = clamp(ratings.timing + Math.min(2, Math.round(battingGap * 0.5)), 15, 99);
  } else {
    const battingGap = Math.max(0, 60 - ratings.battingOvr);
    const bowlingGap = Math.max(0, 72 - ratings.bowlingOvr);
    ratings.battingIQ = clamp(ratings.battingIQ + Math.min(4, Math.round(battingGap * 0.8)), 15, 99);
    ratings.timing = clamp(ratings.timing + Math.min(4, Math.round(battingGap * 0.8)), 15, 99);
    ratings.power = clamp(ratings.power + Math.min(3, Math.round(battingGap * 0.5)), 15, 99);
    ratings.running = clamp(ratings.running + Math.min(2, Math.round(battingGap * 0.4)), 15, 99);
    ratings.wicketTaking = clamp(ratings.wicketTaking + Math.min(2, Math.round(bowlingGap * 0.4)), 15, 99);
    ratings.economy = clamp(ratings.economy + Math.min(2, Math.round(bowlingGap * 0.3)), 15, 99);
    ratings.accuracy = clamp(ratings.accuracy + Math.min(2, Math.round(bowlingGap * 0.4)), 15, 99);
  }

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
  name: string;
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
      map.set(espnName, { name: player.name, teamId: roster.teamId, price: player.price });
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
  options?: { allowFuzzyInitialMatch?: boolean },
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

  if (!options?.allowFuzzyInitialMatch) return undefined;

  const fuzzyMatches = [...rosterMap.entries()].filter(([rosterName]) => areNamesCompatible(playerName, rosterName));
  return fuzzyMatches.length === 1 ? fuzzyMatches[0][1] : undefined;
}

function findStatsForName(
  playerName: string,
  statsByName: Map<string, EliteTournamentPlayerStats>,
): EliteTournamentPlayerStats | null {
  for (const candidate of buildNameCandidatesFromString(playerName)) {
    const exact = statsByName.get(candidate);
    if (exact) return exact;
  }

  let fuzzyMatch: EliteTournamentPlayerStats | null = null;
  for (const [candidateName, stats] of statsByName.entries()) {
    if (!areNamesCompatible(playerName, candidateName)) continue;
    if (fuzzyMatch) return null;
    fuzzyMatch = stats;
  }

  return fuzzyMatch;
}

function findWomenProfileByName(
  playerName: string,
  femalePlayers: EspnPlayer[],
): EspnPlayer | undefined {
  const exactCandidates = new Set(buildNameCandidatesFromString(playerName));
  const exact = femalePlayers.find((player) =>
    [player.profile.longName, player.profile.name]
      .filter(Boolean)
      .some((candidate) => exactCandidates.has(normalizePlayerName(candidate!))),
  );
  if (exact) return exact;

  const fuzzy = femalePlayers.filter((player) =>
    [player.profile.longName, player.profile.name]
      .filter(Boolean)
      .some((candidate) => areNamesCompatible(playerName, candidate!)),
  );
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
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
  const eliteTournamentStats = loadEliteTournamentStats().male;

  for (const player of malePlayers) {
    const batResult = getT20Stat(player.careerStats, "BATTING");
    const bowlResult = getT20Stat(player.careerStats, "BOWLING");
    const bat = batResult?.stat ?? null;
    const bowl = bowlResult?.stat ?? null;

    // Filter out retired players
    if (isRetired(player)) continue;

    const input = toCalculatorInput(player);
    const matches = input.matches;
    if (matches < 1) continue;

    let ratings = calculateRatings(input);
    if (matches < 10) {
      const espnRoles = player.profile.playingRoles ?? [];
      const hintedRole = getEspnRoleHint(espnRoles);
      const isWicketKeeper = espnRoles.some((r: string) => r.toLowerCase().includes("keeper"));
      const baseRatings = createLowSampleBaseRatings(
        resolveRoleFromHint(hintedRole, inferRole(ratings), ratings),
        "M",
        extractCountry(player.profile) !== "India",
        isWicketKeeper,
      );
      ratings = blendCalculatedRatings(baseRatings, ratings, matches / 10);
    }

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
    const bowlingStyle = mapBowlingStyle(player.profile.bowlingStyles?.[0] ?? "unknown");
    applyBattingProfileAdjustment(ratings, input, espnRoles);
    applyBowlingRoleAdjustment(ratings, input, espnRoles, bowlingStyle);
    applyEliteTournamentAdjustment(ratings, input, findEliteTournamentStatsForPlayer(player, eliteTournamentStats));
    const isWicketKeeper = espnRoles.some((r: string) => r.toLowerCase().includes("keeper"));
    const role = resolveRoleFromHint(getEspnRoleHint(espnRoles), inferRole(ratings), ratings);
    const age = calculateAge(player.profile.dateOfBirth);
    const country = extractCountry(player.profile);

    const battingHand = mapBattingHand(player.profile.battingStyles?.[0] ?? "unknown");
    let resolvedBowlingStyle = bowlingStyle;
    // Infer bowling style from economy when ESPN has no data but player has bowling stats
    if (resolvedBowlingStyle === "unknown" && role === "bowler" && input.wickets > 0) {
      const econ = input.ballsBowled > 0 ? (input.runsConceded / input.ballsBowled) * 6 : 99;
      resolvedBowlingStyle = econ < 7.0 ? "off-spin" : "right-arm-medium";
    }

    rated.push({
      id: `espn_${player.profile.espnId}`,
      name: player.profile.longName || player.profile.name,
      fullName: player.profile.longName || player.profile.name,
      age,
      country,
      battingHand,
      bowlingStyle: resolvedBowlingStyle,
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

    console.log(`Rated players (1+ T20 matches, male): ${rated.length}`);
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

type PlayerEntry = Omit<PlayerData, "injured" | "injuryGamesLeft">;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_PLAYERS: PlayerEntry[] = (([
${entries}
]) as any) as PlayerEntry[];

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

function createCalculatedRatingsFromAttributes(
  ratings: Omit<CalculatedRatings, "battingOvr" | "bowlingOvr" | "overall">,
): CalculatedRatings {
  const calculated: CalculatedRatings = {
    ...ratings,
    battingOvr: 0,
    bowlingOvr: 0,
    overall: 0,
  };
  recomputeOveralls(calculated);
  return calculated;
}

function inferWomenRosterFallbackRole(
  hintedRole: "batsman" | "bowler" | "all-rounder" | undefined,
  input: ReturnType<typeof toCalculatorInput>,
  bowlingStyle: BowlingStyle,
  isWicketKeeper: boolean,
  price: number,
): "batsman" | "bowler" | "all-rounder" {
  if (isWicketKeeper) return "batsman";
  if (hintedRole) return hintedRole;

  const battingSignal =
    input.battingInnings >= Math.max(2, Math.round(input.matches * 0.35)) &&
    (input.runs >= 35 || input.ballsFaced >= 24);
  const bowlingSignal =
    input.bowlingInnings >= Math.max(2, Math.round(input.matches * 0.25)) &&
    input.ballsBowled >= 24;

  if (battingSignal && bowlingSignal && (input.wickets >= 2 || input.runs >= 60)) {
    return "all-rounder";
  }

  if (bowlingStyle !== "unknown" && (bowlingSignal || input.wickets > 0)) {
    return battingSignal && input.runs >= 45 ? "all-rounder" : "bowler";
  }

  if (bowlingSignal && input.wickets >= 2) return battingSignal ? "all-rounder" : "bowler";
  if (price >= 0.8) return "batsman";
  return battingSignal ? "batsman" : "bowler";
}

function createWomenRosterFallbackBaseRatings(
  role: "batsman" | "bowler" | "all-rounder",
  price: number,
  isInternational: boolean,
  isWicketKeeper: boolean,
): CalculatedRatings {
  const boost = clamp(Math.round(Math.max(0, price - 0.1) * 8), 0, 16);

  const base = isWicketKeeper
    ? createCalculatedRatingsFromAttributes({
        battingIQ: 60 + boost,
        timing: 58 + boost,
        power: 46 + Math.round(boost * 0.8),
        running: 64 + Math.round(boost * 0.4),
        wicketTaking: 22,
        economy: 22,
        accuracy: 24,
        clutch: 54 + Math.round(boost * 0.6),
      })
    : role === "batsman"
      ? createCalculatedRatingsFromAttributes({
          battingIQ: 56 + boost,
          timing: 54 + boost,
          power: 48 + Math.round(boost * 0.8),
          running: 60 + Math.round(boost * 0.4),
          wicketTaking: 24 + Math.round(boost * 0.2),
          economy: 24 + Math.round(boost * 0.2),
          accuracy: 26 + Math.round(boost * 0.25),
          clutch: 50 + Math.round(boost * 0.6),
        })
      : role === "bowler"
        ? createCalculatedRatingsFromAttributes({
            battingIQ: 26 + Math.round(boost * 0.15),
            timing: 25 + Math.round(boost * 0.15),
            power: 24 + Math.round(boost * 0.2),
            running: 42 + Math.round(boost * 0.3),
            wicketTaking: 59 + boost,
            economy: 58 + Math.round(boost * 0.8),
            accuracy: 55 + Math.round(boost * 0.8),
            clutch: 52 + Math.round(boost * 0.6),
          })
        : createCalculatedRatingsFromAttributes({
            battingIQ: 50 + Math.round(boost * 0.75),
            timing: 48 + Math.round(boost * 0.75),
            power: 46 + Math.round(boost * 0.65),
            running: 58 + Math.round(boost * 0.4),
            wicketTaking: 49 + Math.round(boost * 0.75),
            economy: 50 + Math.round(boost * 0.65),
            accuracy: 46 + Math.round(boost * 0.7),
            clutch: 53 + Math.round(boost * 0.6),
          });

  if (!isInternational) return base;

  const adjusted = createCalculatedRatingsFromAttributes({
    battingIQ: base.battingIQ + (role === "bowler" ? 1 : 2),
    timing: base.timing + (role === "bowler" ? 1 : 2),
    power: base.power + (role === "bowler" ? 0 : 1),
    running: base.running + 1,
    wicketTaking: base.wicketTaking + (role === "batsman" ? 1 : 2),
    economy: base.economy + (role === "batsman" ? 1 : 2),
    accuracy: base.accuracy + (role === "batsman" ? 1 : 2),
    clutch: base.clutch + 2,
  });
  return adjusted;
}

function createMenLowSampleBaseRatings(
  role: "batsman" | "bowler" | "all-rounder",
  isInternational: boolean,
  isWicketKeeper: boolean,
): CalculatedRatings {
  const base = isWicketKeeper
    ? createCalculatedRatingsFromAttributes({
        battingIQ: 58,
        timing: 56,
        power: 48,
        running: 62,
        wicketTaking: 22,
        economy: 22,
        accuracy: 24,
        clutch: 52,
      })
    : role === "batsman"
      ? createCalculatedRatingsFromAttributes({
          battingIQ: 54,
          timing: 52,
          power: 50,
          running: 58,
          wicketTaking: 22,
          economy: 22,
          accuracy: 24,
          clutch: 48,
        })
      : role === "bowler"
        ? createCalculatedRatingsFromAttributes({
            battingIQ: 24,
            timing: 24,
            power: 26,
            running: 42,
            wicketTaking: 57,
            economy: 56,
            accuracy: 54,
            clutch: 49,
          })
        : createCalculatedRatingsFromAttributes({
            battingIQ: 48,
            timing: 46,
            power: 46,
            running: 56,
            wicketTaking: 47,
            economy: 48,
            accuracy: 46,
            clutch: 50,
          });

  if (!isInternational) return base;

  return createCalculatedRatingsFromAttributes({
    battingIQ: base.battingIQ + (role === "bowler" ? 1 : 2),
    timing: base.timing + (role === "bowler" ? 1 : 2),
    power: base.power + (role === "bowler" ? 1 : 2),
    running: base.running + 1,
    wicketTaking: base.wicketTaking + (role === "batsman" ? 1 : 2),
    economy: base.economy + (role === "batsman" ? 1 : 2),
    accuracy: base.accuracy + (role === "batsman" ? 1 : 2),
    clutch: base.clutch + 2,
  });
}

function createLowSampleBaseRatings(
  role: "batsman" | "bowler" | "all-rounder",
  gender: "M" | "F",
  isInternational: boolean,
  isWicketKeeper: boolean,
): CalculatedRatings {
  return gender === "F"
    ? createWomenRosterFallbackBaseRatings(role, 0.1, isInternational, isWicketKeeper)
    : createMenLowSampleBaseRatings(role, isInternational, isWicketKeeper);
}

function blendCalculatedRatings(
  base: CalculatedRatings,
  sample: CalculatedRatings,
  sampleWeight: number,
): CalculatedRatings {
  const weight = clamp(sampleWeight, 0.15, 0.75);
  return createCalculatedRatingsFromAttributes({
    battingIQ: Math.round(base.battingIQ * (1 - weight) + sample.battingIQ * weight),
    timing: Math.round(base.timing * (1 - weight) + sample.timing * weight),
    power: Math.round(base.power * (1 - weight) + sample.power * weight),
    running: Math.round(base.running * (1 - weight) + sample.running * weight),
    wicketTaking: Math.round(base.wicketTaking * (1 - weight) + sample.wicketTaking * weight),
    economy: Math.round(base.economy * (1 - weight) + sample.economy * weight),
    accuracy: Math.round(base.accuracy * (1 - weight) + sample.accuracy * weight),
    clutch: Math.round(base.clutch * (1 - weight) + sample.clutch * weight),
  });
}

function createInputFromEliteTournamentStats(
  name: string,
  age: number,
  country: string,
  stats: EliteTournamentPlayerStats,
): ReturnType<typeof toCalculatorInput> {
  return {
    name,
    age,
    country,
    matches: stats.matches,
    battingInnings: stats.battingInnings,
    notOuts: stats.notOuts,
    runs: stats.runs,
    ballsFaced: stats.ballsFaced,
    fours: stats.fours,
    sixes: stats.sixes,
    bowlingInnings: stats.bowlingInnings,
    ballsBowled: stats.ballsBowled,
    runsConceded: stats.runsConceded,
    wickets: stats.wickets,
    catches: 0,
  };
}

function makeSyntheticEspnId(name: string): number {
  let hash = 0;
  for (const ch of normalizePlayerName(name)) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 100000000;
  }
  return 1500000000 + hash;
}

function createWomenRosterFallbackPlayer(
  rosterName: string,
  entry: RosterEntry,
  femalePlayers: EspnPlayer[],
  recentInternationalStats: Map<string, EliteTournamentPlayerStats>,
  recentWomenT20Stats: Map<string, EliteTournamentPlayerStats>,
): RatedPlayer {
  const profile = findWomenProfileByName(rosterName, femalePlayers);
  const recentIntl = profile
    ? findEliteTournamentStatsForPlayer(profile, recentInternationalStats)
    : findStatsForName(rosterName, recentInternationalStats);
  const recentT20 = profile
    ? findEliteTournamentStatsForPlayer(profile, recentWomenT20Stats)
    : findStatsForName(rosterName, recentWomenT20Stats);

  const age = profile ? calculateAge(profile.profile.dateOfBirth) : 24;
  const country = profile ? extractCountry(profile.profile) : "India";
  const isInternational = country !== "India";
  const battingHand = profile ? mapBattingHand(profile.profile.battingStyles?.[0] ?? "unknown") : "right";
  const espnRoles = profile?.profile.playingRoles ?? [];
  const isWicketKeeper = espnRoles.some((role) => role.toLowerCase().includes("keeper"));
  const mappedBowlingStyle = profile ? mapBowlingStyle(profile.profile.bowlingStyles?.[0] ?? "unknown") : "unknown";

  let input = profile
    ? toCalculatorInput(profile, "F")
    : recentT20
      ? createInputFromEliteTournamentStats(rosterName, age, country, recentT20)
      : createInputFromEliteTournamentStats(rosterName, age, country, createEmptyEliteTournamentStats());

  input = applyRecentInternationalFallback(input, recentIntl);
  input = applyWomenRecentT20Fallback(input, recentT20);

  const fallbackRole = inferWomenRosterFallbackRole(
    getEspnRoleHint(espnRoles),
    input,
    mappedBowlingStyle,
    isWicketKeeper,
    entry.price,
  );
  const baseRatings = createWomenRosterFallbackBaseRatings(fallbackRole, entry.price, isInternational, isWicketKeeper);

  let ratings = baseRatings;
  if (input.matches > 0 || input.battingInnings > 0 || input.bowlingInnings > 0) {
    const sampleRatings = calculateRatings(input, "women");
    ratings = blendCalculatedRatings(baseRatings, sampleRatings, input.matches / 8);
  }

  if (profile) {
    const qualityFactor = getCompetitionQualityWomen(profile);
    if (qualityFactor < 1.0) {
      ratings.battingIQ = Math.round(50 + (ratings.battingIQ - 50) * qualityFactor);
      ratings.timing = Math.round(50 + (ratings.timing - 50) * qualityFactor);
      ratings.power = Math.round(50 + (ratings.power - 50) * qualityFactor);
      ratings.running = Math.round(50 + (ratings.running - 50) * qualityFactor);
      ratings.wicketTaking = Math.round(50 + (ratings.wicketTaking - 50) * qualityFactor);
      ratings.economy = Math.round(50 + (ratings.economy - 50) * qualityFactor);
      ratings.accuracy = Math.round(50 + (ratings.accuracy - 50) * qualityFactor);
      ratings.clutch = Math.round(50 + (ratings.clutch - 50) * qualityFactor);
      recomputeOveralls(ratings);
    }
  }

  applyBowlingRoleAdjustment(ratings, input, espnRoles, mappedBowlingStyle);
  applyWomenAllRounderFloor(ratings, input, espnRoles);
  applyEliteTournamentAdjustment(ratings, input, recentIntl, "F");

  const role = profile
    ? resolveWomenRoleFromHint(getEspnRoleHint(espnRoles), inferRole(ratings), ratings, input)
    : resolveWomenRoleFromHint(fallbackRole, inferRole(ratings), ratings, input);

  let bowlingStyle = mappedBowlingStyle;
  if (bowlingStyle === "unknown" && (role === "bowler" || role === "all-rounder") && input.ballsBowled > 0) {
    const econ = input.runsConceded > 0 && input.ballsBowled > 0
      ? (input.runsConceded / input.ballsBowled) * 6
      : 99;
    bowlingStyle = econ < 7.0 ? "off-spin" : "right-arm-medium";
  }

  return {
    id: profile ? `espn_${profile.profile.espnId}` : `wpl_fallback_${normalizePlayerName(entry.name).replace(/\s+/g, "_")}`,
    name: entry.name,
    fullName: entry.name,
    age,
    country,
    battingHand,
    bowlingStyle,
    role,
    isWicketKeeper: isWicketKeeper || undefined,
    isInternational,
    teamId: entry.teamId,
    price: entry.price,
    imageUrl: profile?.profile.imageUrl || undefined,
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
      t20Matches: input.matches,
      t20Runs: input.runs,
      t20Average: input.battingInnings > input.notOuts ? input.runs / Math.max(1, input.battingInnings - input.notOuts) : input.runs,
      t20StrikeRate: input.ballsFaced > 0 ? (input.runs / input.ballsFaced) * 100 : 0,
      t20Fours: input.fours,
      t20Sixes: input.sixes,
      t20Wickets: input.wickets,
      t20Economy: input.ballsBowled > 0 ? (input.runsConceded / input.ballsBowled) * 6 : 0,
      statClass: profile ? (getT20Stat(profile.careerStats, "BATTING", "F")?.cl ?? getT20Stat(profile.careerStats, "BOWLING", "F")?.cl ?? 90) : 90,
    },
    espnId: profile?.profile.espnId ?? makeSyntheticEspnId(entry.name),
  };
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
      map.set(espnName, { name: player.name, teamId: roster.teamId, price: player.price });
    }
  }

  return map;
}

// ── Women's ratings generator ────────────────────────────────────────

/**
 * Generate ratings for all female ESPN-scraped players.
 * Uses women's T20 stats, recent Cricsheet T20 support, and WPL roster fallbacks.
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
  const rosterMap = buildWPLRosterTeamMap();
  const eliteTournamentStats = loadEliteTournamentStats().female;
  const recentInternationalStats = loadRecentInternationalT20Stats().female;
  const recentWomenT20Stats = loadRecentWomenT20Stats();

  for (const player of femalePlayers) {
    const batResult = getT20Stat(player.careerStats, "BATTING", "F");
    const bowlResult = getT20Stat(player.careerStats, "BOWLING", "F");
    const bat = batResult?.stat ?? null;
    const bowl = bowlResult?.stat ?? null;
    const rosterEntry = findRosterEntry(player.profile.longName || player.profile.name, rosterMap, { allowFuzzyInitialMatch: true });

    // Filter out retired players
    if (isRetiredWomen(player) && !rosterEntry) continue;

    let input = toCalculatorInput(player, "F");
    input = applyRecentInternationalFallback(input, findEliteTournamentStatsForPlayer(player, recentInternationalStats));
    input = applyWomenRecentT20Fallback(input, findEliteTournamentStatsForPlayer(player, recentWomenT20Stats));

    // Keep any real women's-T20 sample in the pool, but regress very small samples heavily.
    const matches = input.matches;
    if (matches < 1) continue;

    let ratings = calculateRatings(input, "women");
    if (rosterEntry && matches < 8) {
      const country = extractCountry(player.profile);
      const isWicketKeeper = (player.profile.playingRoles ?? []).some((r: string) => r.toLowerCase().includes("keeper"));
      const fallbackRole = inferWomenRosterFallbackRole(
        getEspnRoleHint(player.profile.playingRoles ?? []),
        input,
        mapBowlingStyle(player.profile.bowlingStyles?.[0] ?? "unknown"),
        isWicketKeeper,
        rosterEntry.price,
      );
      const baseRatings = createWomenRosterFallbackBaseRatings(
        fallbackRole,
        rosterEntry.price,
        country !== "India",
        isWicketKeeper,
      );
      ratings = blendCalculatedRatings(baseRatings, ratings, matches / 8);
    } else if (matches < 10) {
      const country = extractCountry(player.profile);
      const espnRoles = player.profile.playingRoles ?? [];
      const isWicketKeeper = espnRoles.some((r: string) => r.toLowerCase().includes("keeper"));
      const hintedRole = getEspnRoleHint(espnRoles);
      const baseRatings = createLowSampleBaseRatings(
        resolveWomenRoleFromHint(hintedRole, inferRole(ratings), ratings, input),
        "F",
        country !== "India",
        isWicketKeeper,
      );
      ratings = blendCalculatedRatings(baseRatings, ratings, matches / 10);
    }

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
    const bowlingStyle = mapBowlingStyle(player.profile.bowlingStyles?.[0] ?? "unknown");
    applyBowlingRoleAdjustment(ratings, input, espnRoles, bowlingStyle);
    applyWomenAllRounderFloor(ratings, input, espnRoles);
    applyEliteTournamentAdjustment(ratings, input, findEliteTournamentStatsForPlayer(player, eliteTournamentStats), "F");
    const isWicketKeeper = espnRoles.some((r: string) => r.toLowerCase().includes("keeper"));
    const role = resolveWomenRoleFromHint(getEspnRoleHint(espnRoles), inferRole(ratings), ratings, input);
    const age = calculateAge(player.profile.dateOfBirth);
    const country = extractCountry(player.profile);

    const battingHand = mapBattingHand(player.profile.battingStyles?.[0] ?? "unknown");
    let resolvedBowlingStyle = bowlingStyle;
    // Infer bowling style from economy when ESPN has no data but player has bowling stats
    if (resolvedBowlingStyle === "unknown" && (role === "bowler" || role === "all-rounder") && input.wickets > 0) {
      const econ = input.ballsBowled > 0 ? (input.runsConceded / input.ballsBowled) * 6 : 99;
      resolvedBowlingStyle = econ < 7.0 ? "off-spin" : "right-arm-medium";
    }

    rated.push({
      id: `espn_${player.profile.espnId}`,
      name: player.profile.longName || player.profile.name,
      fullName: player.profile.longName || player.profile.name,
      age,
      country,
      battingHand,
      bowlingStyle: resolvedBowlingStyle,
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
  let rosterMatches = 0;
  const unmatchedRoster = new Set(rosterMap.keys());

  for (const p of rated) {
    const entry = findRosterEntry(p.name, rosterMap, { allowFuzzyInitialMatch: true });
    if (entry) {
      p.teamId = entry.teamId;
      p.price = entry.price;
      rosterMatches++;
      for (const [rosterName, rosterEntry] of rosterMap.entries()) {
        if (
          rosterEntry.name === entry.name &&
          rosterEntry.teamId === entry.teamId &&
          rosterEntry.price === entry.price
        ) {
          unmatchedRoster.delete(rosterName);
        }
      }
    }
  }

  const rosterFallbacks: RatedPlayer[] = [];
  for (const [rosterName, entry] of rosterMap.entries()) {
    if (!unmatchedRoster.has(rosterName)) continue;
    rosterFallbacks.push(
      createWomenRosterFallbackPlayer(
        rosterName,
        entry,
        femalePlayers,
        recentInternationalStats,
        recentWomenT20Stats,
      ),
    );
    unmatchedRoster.delete(rosterName);
  }

  rated.push(...rosterFallbacks);

  // Sort by overall rating descending
  rated.sort((a, b) => b.overalls.overall - a.overalls.overall);

  console.log(`Generated women players (women's-T20-led + WPL fallbacks): ${rated.length}`);
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
  console.log(`Roster fallbacks generated: ${rosterFallbacks.length}`);
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

type WPLPlayerEntry = Omit<PlayerData, "injured" | "injuryGamesLeft">;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WPL_PLAYERS: WPLPlayerEntry[] = (([
${entries}
]) as any) as WPLPlayerEntry[];

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

const isDirectExecution = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  generateAllRatings();
  generateWomenRatings();
}
