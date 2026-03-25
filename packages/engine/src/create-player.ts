/**
 * Player factory: creates players from data or generates random ones.
 * Ported from IndianCricketLeague/createPlayer.js
 */

import {
  Player,
  PlayerData,
  PlayerRatings,
  PlayerRole,
  BowlingStyle,
  BattingHand,
  calculateBattingOverall,
  calculateBowlingOverall,
} from "./player.js";
import { clamp, randomNormal } from "./math.js";

let playerIdCounter = 0;

export function nextPlayerId(): string {
  return `p_${++playerIdCounter}`;
}

/** Country weights for random generation (approximate representation in T20 cricket) */
const COUNTRY_WEIGHTS: [string, number, boolean][] = [
  // [country, weight, isInternational]
  ["India", 40, false],
  ["Australia", 8, true],
  ["England", 8, true],
  ["South Africa", 6, true],
  ["New Zealand", 5, true],
  ["West Indies", 5, true],
  ["Pakistan", 4, true],
  ["Sri Lanka", 4, true],
  ["Bangladesh", 3, true],
  ["Afghanistan", 3, true],
  ["Zimbabwe", 2, true],
  ["Ireland", 1, true],
  ["Netherlands", 1, true],
  ["Scotland", 1, true],
  ["Nepal", 1, true],
  ["Namibia", 1, true],
  ["USA", 1, true],
  ["UAE", 1, true],
  ["Oman", 1, true],
];

/** First names pool (subset) */
const FIRST_NAMES = [
  "Aarav","Aditya","Ajay","Akash","Amit","Anil","Arjun","Ashwin","Dev","Dhruv",
  "Gaurav","Harsh","Ishaan","Jai","Karan","Krishna","Lakshman","Manish","Naveen","Nikhil",
  "Om","Pranav","Rahul","Ravi","Rohit","Sachin","Sahil","Sanjay","Shreyas","Suresh",
  "Tanmay","Varun","Vikram","Virat","Yash","Ben","Chris","Dan","James","Josh",
  "Kane","Liam","Mark","Nick","Sam","Tom","Will","Aaron","Adam","Alex",
  "David","Glenn","Jake","Kyle","Luke","Matt","Pat","Ryan","Steve","Tim",
  "Hashim","Kagiso","Quinton","Temba","Aiden","Daryl","Devon","Faf","Lungi","Rassie",
  "Andre","Carlos","Dwayne","Jason","Kieron","Nicholas","Shai","Shimron","Sunil","Brandon",
];

const LAST_NAMES = [
  "Sharma","Patel","Kumar","Singh","Verma","Gupta","Chauhan","Yadav","Reddy","Nair",
  "Iyer","Gill","Pandey","Mishra","Joshi","Mehta","Shah","Malhotra","Kapoor","Bhat",
  "Smith","Jones","Brown","Wilson","Taylor","Anderson","Thomas","Jackson","White","Harris",
  "Clark","Lewis","Walker","Hall","Allen","Young","King","Wright","Scott","Green",
  "de Villiers","du Plessis","van der Dussen","Nortje","Rabada","Ngidi","Bavuma","Markram",
  "Pooran","Pollard","Russell","Narine","Holder","Bravo","Hope","Joseph","Hetmyer","Thomas",
  "Williamson","Conway","Ferguson","Boult","Southee","Latham","Mitchell","Nicholls","Phillips","Santner",
  "Starc","Cummins","Warner","Head","Marsh","Maxwell","Zampa","Hazlewood","Lyon","Carey",
];

/** Pick a random bowling style based on role */
function randomBowlingStyle(role: PlayerRole): BowlingStyle {
  const r = Math.random() * 100;
  if (role === "bowler") {
    // 40% right-arm-fast, 15% left-arm-fast, 15% off-spin, 10% leg-spin, 10% left-arm-orthodox, 5% right-arm-medium, 5% left-arm-medium
    if (r < 40) return "right-arm-fast";
    if (r < 55) return "left-arm-fast";
    if (r < 70) return "off-spin";
    if (r < 80) return "leg-spin";
    if (r < 90) return "left-arm-orthodox";
    if (r < 95) return "right-arm-medium";
    return "left-arm-medium";
  }
  if (role === "all-rounder") {
    // 30% right-arm-medium, 20% off-spin, 15% right-arm-fast, 15% leg-spin, 10% left-arm-orthodox, 10% left-arm-fast
    if (r < 30) return "right-arm-medium";
    if (r < 50) return "off-spin";
    if (r < 65) return "right-arm-fast";
    if (r < 80) return "leg-spin";
    if (r < 90) return "left-arm-orthodox";
    return "left-arm-fast";
  }
  // batsman (and wicket-keeper): 80% unknown, 10% off-spin, 5% right-arm-medium, 5% leg-spin
  if (r < 80) return "unknown";
  if (r < 90) return "off-spin";
  if (r < 95) return "right-arm-medium";
  return "leg-spin";
}

/** Pick a random batting hand — 70% right, 30% left (matches real cricket distribution) */
function randomBattingHand(): BattingHand {
  return Math.random() < 0.70 ? "right" : "left";
}

/** Generate a random player */
export function generateRandomPlayer(overrides?: Partial<PlayerData>): Player {
  // Pick country
  const totalWeight = COUNTRY_WEIGHTS.reduce((s, [,w]) => s + w, 0);
  let r = Math.random() * totalWeight;
  let country = "India";
  let isInternational = false;
  for (const [c, w, intl] of COUNTRY_WEIGHTS) {
    r -= w;
    if (r <= 0) {
      country = c;
      isInternational = intl;
      break;
    }
  }

  // Pick role
  const roleRoll = Math.random();
  let role: PlayerRole;
  if (roleRoll < 0.40) role = "batsman";
  else if (roleRoll < 0.60) role = "bowler";
  else role = "all-rounder";

  // ~30% of batsmen are wicket-keepers (ensures enough WKs for 2 per team in auction)
  const isWicketKeeper = role === "batsman" && Math.random() < 0.30;

  // Generate ratings based on role (WK uses batsman-style ratings with higher running)
  const ratings = generateRatings(role, isWicketKeeper);

  const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]
    + " " + LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];

  const age = Math.floor(18 + Math.random() * 20); // 18-37

  return new Player({
    id: nextPlayerId(),
    name,
    age,
    country,
    role,
    ratings,
    isInternational,
    isWicketKeeper,
    bowlingStyle: randomBowlingStyle(role),
    battingHand: randomBattingHand(),
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  });
}

/** Generate ratings appropriate for a role */
function generateRatings(role: PlayerRole, isWicketKeeper = false): PlayerRatings {
  const baseRating = () => clamp(Math.round(randomNormal(55, 18)), 15, 95);

  if (isWicketKeeper) {
    // WK-batsmen: good batting, higher running, minimal bowling
    return {
      battingIQ: clamp(Math.round(randomNormal(65, 14)), 30, 95),
      timing: clamp(Math.round(randomNormal(62, 14)), 28, 95),
      power: clamp(Math.round(randomNormal(55, 16)), 20, 90),
      running: clamp(Math.round(randomNormal(65, 14)), 30, 90),
      wicketTaking: clamp(Math.round(randomNormal(20, 8)), 10, 40),
      economy: clamp(Math.round(randomNormal(20, 8)), 10, 40),
      accuracy: clamp(Math.round(randomNormal(25, 10)), 10, 45),
      clutch: clamp(Math.round(randomNormal(58, 18)), 15, 95),
    };
  }

  switch (role) {
    case "batsman":
      return {
        battingIQ: clamp(Math.round(randomNormal(70, 14)), 30, 99),
        timing: clamp(Math.round(randomNormal(68, 14)), 30, 99),
        power: clamp(Math.round(randomNormal(60, 16)), 20, 99),
        running: clamp(Math.round(randomNormal(60, 15)), 20, 99),
        wicketTaking: clamp(Math.round(randomNormal(25, 10)), 10, 50),
        economy: clamp(Math.round(randomNormal(25, 10)), 10, 50),
        accuracy: clamp(Math.round(randomNormal(30, 12)), 10, 55),
        clutch: clamp(Math.round(randomNormal(50, 18)), 15, 95),
      };
    case "bowler":
      return {
        battingIQ: clamp(Math.round(randomNormal(30, 12)), 10, 55),
        timing: clamp(Math.round(randomNormal(28, 12)), 10, 50),
        power: clamp(Math.round(randomNormal(25, 12)), 10, 50),
        running: clamp(Math.round(randomNormal(35, 15)), 10, 60),
        wicketTaking: clamp(Math.round(randomNormal(70, 14)), 30, 99),
        economy: clamp(Math.round(randomNormal(68, 14)), 30, 99),
        accuracy: clamp(Math.round(randomNormal(65, 15)), 25, 99),
        clutch: clamp(Math.round(randomNormal(55, 18)), 15, 95),
      };
    case "all-rounder":
      return {
        battingIQ: clamp(Math.round(randomNormal(58, 15)), 25, 95),
        timing: clamp(Math.round(randomNormal(55, 15)), 25, 90),
        power: clamp(Math.round(randomNormal(52, 16)), 20, 90),
        running: clamp(Math.round(randomNormal(55, 14)), 25, 85),
        wicketTaking: clamp(Math.round(randomNormal(55, 15)), 25, 90),
        economy: clamp(Math.round(randomNormal(55, 15)), 25, 90),
        accuracy: clamp(Math.round(randomNormal(50, 15)), 20, 85),
        clutch: clamp(Math.round(randomNormal(55, 18)), 15, 95),
      };
    default:
      return {
        battingIQ: baseRating(), timing: baseRating(), power: baseRating(),
        running: baseRating(), wicketTaking: baseRating(), economy: baseRating(),
        accuracy: baseRating(), clutch: baseRating(),
      };
  }
}

/** Generate a pool of random players for auction */
export function generatePlayerPool(count: number): Player[] {
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generateRandomPlayer());
  }
  return players;
}

function inferRuntimeRole(
  ratings: PlayerRatings,
  explicitRole?: string,
  isWicketKeeper = false,
): PlayerRole {
  if (isWicketKeeper) return "batsman";

  const batOvr = calculateBattingOverall(ratings);
  const bowlOvr = calculateBowlingOverall(ratings);
  const diff = batOvr - bowlOvr;
  const weaker = Math.min(batOvr, bowlOvr);
  const stronger = Math.max(batOvr, bowlOvr);
  const canBeAllRounder = weaker >= 62 && stronger >= 70 && Math.abs(diff) <= 12;
  const explicitAllRounderThreshold = weaker >= 60 && stronger >= 72 && Math.abs(diff) <= 25;

  if (explicitRole === "all-rounder") {
    return explicitAllRounderThreshold ? "all-rounder" : diff >= 0 ? "batsman" : "bowler";
  }

  if (explicitRole === "batsman") {
    return diff <= -28 && bowlOvr >= 65 ? "bowler" : "batsman";
  }

  if (explicitRole === "bowler") {
    return diff >= 28 && batOvr >= 65 ? "batsman" : "bowler";
  }

  if (canBeAllRounder) return "all-rounder";
  return diff >= 0 ? "batsman" : "bowler";
}

function squashTowardBaseline(value: number, scale: number, baseline = 20): number {
  return clamp(Math.round(baseline + (value - baseline) * scale), 10, 99);
}

function normalizeSecondaryDiscipline(ratings: PlayerRatings, role: PlayerRole): PlayerRatings {
  const normalized = { ...ratings };

  if (role === "batsman") {
    const batOvr = calculateBattingOverall(normalized);
    const bowlOvr = calculateBowlingOverall(normalized);
    const maxBowlingOvr = Math.max(30, Math.min(44, batOvr - 30));

    if (bowlOvr > maxBowlingOvr) {
      const scale = (maxBowlingOvr - 20) / Math.max(1, bowlOvr - 20);
      normalized.wicketTaking = squashTowardBaseline(normalized.wicketTaking, scale);
      normalized.economy = squashTowardBaseline(normalized.economy, scale);
      normalized.accuracy = squashTowardBaseline(normalized.accuracy, scale);
    }
  }

  if (role === "bowler") {
    const batOvr = calculateBattingOverall(normalized);
    const bowlOvr = calculateBowlingOverall(normalized);
    const maxBattingOvr = Math.max(30, Math.min(54, bowlOvr - 24));

    if (batOvr > maxBattingOvr) {
      const scale = (maxBattingOvr - 20) / Math.max(1, batOvr - 20);
      normalized.battingIQ = squashTowardBaseline(normalized.battingIQ, scale);
      normalized.timing = squashTowardBaseline(normalized.timing, scale);
      normalized.power = squashTowardBaseline(normalized.power, scale);
      normalized.running = squashTowardBaseline(normalized.running, scale);
    }
  }

  return normalized;
}

function normalizeClutch(ratings: PlayerRatings, role: PlayerRole, isWicketKeeper = false): number {
  const batOvr = calculateBattingOverall(ratings);
  const bowlOvr = calculateBowlingOverall(ratings);

  if (role === "batsman" || isWicketKeeper) {
    return Math.max(ratings.clutch, clamp(Math.round(batOvr - 8), 35, 90));
  }

  if (role === "all-rounder") {
    return Math.max(ratings.clutch, clamp(Math.round(Math.max(batOvr, bowlOvr) - 10), 40, 92));
  }

  return Math.max(ratings.clutch, clamp(Math.round(bowlOvr - 8), 35, 95));
}

/** Create a player from raw rating data (for importing real players) */
export function createPlayerFromData(data: {
  name: string;
  age: number;
  country: string;
  imageUrl?: string;
  role?: string;
  isWicketKeeper?: boolean;
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
  teamId?: string;
  bid?: number;
}): Player {
  const indianCountries = ["India"];
  const isInternational = !indianCountries.includes(data.country);
  const isWicketKeeper = data.isWicketKeeper ?? data.role === "wicket-keeper";
  const rawRatings: PlayerRatings = {
    battingIQ: data.battingIQ,
    timing: data.timing,
    power: data.power,
    running: data.running,
    wicketTaking: data.wicketTaking,
    economy: data.economy,
    accuracy: data.accuracy,
    clutch: data.clutch,
  };
  const role = inferRuntimeRole(rawRatings, data.role, isWicketKeeper);
  let ratings = normalizeSecondaryDiscipline(rawRatings, role);
  ratings.clutch = normalizeClutch(ratings, role, isWicketKeeper);
  ratings = normalizeSecondaryDiscipline(ratings, role);

  return new Player({
    id: nextPlayerId(),
    name: data.name,
    age: data.age,
    country: data.country,
    imageUrl: data.imageUrl,
    role,
    ratings,
    isInternational,
    isWicketKeeper,
    bowlingStyle: data.bowlingStyle,
    battingHand: data.battingHand,
    teamId: data.teamId,
    bid: data.bid,
    injured: false,
    injuryGamesLeft: 0,
  });
}
