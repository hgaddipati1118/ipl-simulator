/**
 * Youth Academy: generates young domestic prospects between seasons.
 *
 * Each prospect has a `potential` ceiling (0-99) that governs
 * how fast their ratings grow during `progress()`.
 */

import { Player, type PlayerData, type PlayerRatings, type PlayerRole } from "./player.js";
import { clamp, randomNormal } from "./math.js";
import { nextPlayerId } from "./create-player.js";
import { type RNG, createRNG, randInt, randPick } from "./rng.js";

export interface YouthProspect {
  player: Player;
  potential: number; // 0-99, how high their ceiling is
  scoutRating: string; // "Diamond", "Gold", "Silver", "Bronze"
}

/** Indian first names for generated youth players */
const YOUTH_FIRST_NAMES = [
  "Aarav", "Aditya", "Arjun", "Dev", "Dhruv", "Harsh", "Ishaan", "Jai",
  "Karan", "Krishna", "Manish", "Naveen", "Om", "Pranav", "Rahul", "Rohit",
  "Sachin", "Sahil", "Shreyas", "Tanmay", "Varun", "Vikram", "Yash", "Ankit",
  "Prithvi", "Shubman", "Tilak", "Rinku", "Yashasvi", "Abhishek", "Rajvardhan",
  "Nitish", "Sai", "Venkatesh", "Ravi", "Harpreet", "Riyan", "Swapnil",
];

const YOUTH_LAST_NAMES = [
  "Sharma", "Patel", "Kumar", "Singh", "Verma", "Gupta", "Chauhan", "Yadav",
  "Reddy", "Nair", "Iyer", "Gill", "Pandey", "Mishra", "Joshi", "Mehta",
  "Shah", "Malhotra", "Kapoor", "Bhat", "Kishan", "Parag", "Varma", "Sudharsan",
  "Jaiswal", "Gaikwad", "Dube", "Samson", "Padikkal", "Hooda", "Tewatia",
];

function scoutLabel(potential: number): string {
  if (potential >= 90) return "Diamond";
  if (potential >= 80) return "Gold";
  if (potential >= 70) return "Silver";
  return "Bronze";
}

/** Roll a potential value with realistic rarity distribution.
 *  70-79: common (60%), 80-89: rare (30%), 90-99: generational (10%) */
function rollPotential(rng: RNG): number {
  const roll = rng();
  if (roll < 0.60) return randInt(rng, 70, 79);
  if (roll < 0.90) return randInt(rng, 80, 89);
  return randInt(rng, 90, 99);
}

/** Roll a role for a youth prospect.
 *  Batsman 40%, bowler 30%, all-rounder 20%, WK-batsman 10%. */
function rollRole(rng: RNG): { role: PlayerRole; isWicketKeeper: boolean } {
  const roll = rng();
  if (roll < 0.40) return { role: "batsman", isWicketKeeper: false };
  if (roll < 0.70) return { role: "bowler", isWicketKeeper: false };
  if (roll < 0.90) return { role: "all-rounder", isWicketKeeper: false };
  return { role: "batsman", isWicketKeeper: true };
}

/** Generate low-to-mid range ratings for a youth player based on role. */
function youthRatings(role: PlayerRole, isWicketKeeper: boolean, rng: RNG): PlayerRatings {
  const r = (mean: number, std: number) =>
    clamp(Math.round(randomNormal(mean, std, rng)), 15, 60);

  if (isWicketKeeper) {
    return {
      battingIQ: r(45, 10), timing: r(42, 10), power: r(38, 12),
      running: r(48, 10), wicketTaking: r(18, 5), economy: r(18, 5),
      accuracy: r(20, 6), clutch: r(40, 12),
    };
  }

  switch (role) {
    case "batsman":
      return {
        battingIQ: r(48, 10), timing: r(46, 10), power: r(40, 12),
        running: r(42, 10), wicketTaking: r(18, 5), economy: r(18, 5),
        accuracy: r(20, 6), clutch: r(38, 12),
      };
    case "bowler":
      return {
        battingIQ: r(22, 8), timing: r(20, 8), power: r(18, 8),
        running: r(28, 8), wicketTaking: r(48, 10), economy: r(46, 10),
        accuracy: r(44, 10), clutch: r(38, 12),
      };
    case "all-rounder":
      return {
        battingIQ: r(40, 10), timing: r(38, 10), power: r(36, 12),
        running: r(38, 10), wicketTaking: r(40, 10), economy: r(38, 10),
        accuracy: r(36, 10), clutch: r(38, 12),
      };
    default:
      return {
        battingIQ: r(35, 12), timing: r(35, 12), power: r(35, 12),
        running: r(35, 12), wicketTaking: r(35, 12), economy: r(35, 12),
        accuracy: r(35, 12), clutch: r(35, 12),
      };
  }
}

/** Pick a random bowling style for youth based on role */
function youthBowlingStyle(role: PlayerRole, rng: RNG): PlayerData["bowlingStyle"] {
  if (role === "bowler") {
    const roll = rng();
    if (roll < 0.35) return "right-arm-fast";
    if (roll < 0.50) return "left-arm-fast";
    if (roll < 0.65) return "off-spin";
    if (roll < 0.78) return "leg-spin";
    if (roll < 0.88) return "left-arm-orthodox";
    if (roll < 0.94) return "right-arm-medium";
    return "left-arm-medium";
  }
  if (role === "all-rounder") {
    const roll = rng();
    if (roll < 0.25) return "right-arm-medium";
    if (roll < 0.45) return "off-spin";
    if (roll < 0.60) return "right-arm-fast";
    if (roll < 0.75) return "leg-spin";
    if (roll < 0.88) return "left-arm-orthodox";
    return "left-arm-fast";
  }
  return "unknown";
}

/**
 * Generate 1-3 youth prospects for a team's academy.
 * All prospects are Indian domestic players aged 17-20.
 */
export function generateYouthProspects(
  teamId: string,
  count: number = 2,
  rng?: RNG,
): YouthProspect[] {
  const _rng = rng ?? createRNG();
  const prospects: YouthProspect[] = [];
  const safeCount = clamp(count, 1, 3);

  for (let i = 0; i < safeCount; i++) {
    const age = randInt(_rng, 17, 20);
    const { role, isWicketKeeper } = rollRole(_rng);
    const potential = rollPotential(_rng);
    const ratings = youthRatings(role, isWicketKeeper, _rng);

    const firstName = randPick(_rng, YOUTH_FIRST_NAMES);
    const lastName = randPick(_rng, YOUTH_LAST_NAMES);

    const player = new Player({
      id: nextPlayerId(),
      name: `${firstName} ${lastName}`,
      age,
      country: "India",
      role,
      ratings,
      isInternational: false,
      isWicketKeeper,
      bowlingStyle: youthBowlingStyle(role, _rng),
      battingHand: _rng() < 0.70 ? "right" : "left",
      teamId,
      bid: 0,
      injured: false,
      injuryGamesLeft: 0,
      potential,
    } as PlayerData);

    // Attach potential as an expando on the player object for later use
    (player as any).potential = potential;

    prospects.push({
      player,
      potential,
      scoutRating: scoutLabel(potential),
    });
  }

  return prospects;
}
