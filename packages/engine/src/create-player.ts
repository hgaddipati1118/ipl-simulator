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
  type FormatRatings,
  type LongFormat,
  calculateBattingOverall,
  calculateBowlingOverall,
} from "./player.js";
import { clamp } from "./math.js";
import type { RNG } from "./rng.js";
import { generatePlayer } from "./player-generator.js";

let playerIdCounter = 0;

export function nextPlayerId(): string {
  return `p_${++playerIdCounter}`;
}

/**
 * Generate a random player. The attributes, role, bowling style and name are sampled from the real joint distribution
 * of rated players (see player-generator.ts); `overrides` replace any field afterwards.
 */
export function generateRandomPlayer(overrides?: Partial<PlayerData>, rng: RNG = Math.random, gender: "male" | "female" = "male"): Player {
  const player = generatePlayer(rng, { kind: "pool", age: [18, 37], gender });
  if (overrides) {
    const { ratings, ...rest } = overrides;
    Object.assign(player, rest);
    if (ratings) player.ratings = { ...player.ratings, ...ratings };
  }
  return player;
}

/** Generate a pool of random players for auction (pass a seeded `rng` for a reproducible pool) */
export function generatePlayerPool(count: number, rng: RNG = Math.random, gender: "male" | "female" = "male"): Player[] {
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generateRandomPlayer(undefined, rng, gender));
  }
  return players;
}

export function inferRuntimeRole(
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

/**
 * The secondary-discipline and clutch normalisation createPlayerFromData applies to imported ratings, for a known role.
 * The ratings pipeline runs a player's ODI / Test sets through it with his (T20) role, which his format views share.
 */
export function normalizeRatingsForRole(ratings: PlayerRatings, role: PlayerRole, isWicketKeeper = false): PlayerRatings {
  let out = normalizeSecondaryDiscipline(ratings, role);
  out.clutch = normalizeClutch(out, role, isWicketKeeper);
  out = normalizeSecondaryDiscipline(out, role);
  return out;
}

/** Create a player from raw rating data (for importing real players) */
export function createPlayerFromData(data: {
  /** The source record's id (`espn_<id>` / `ca_<id>`); kept as the player's sourceId */
  id?: string;
  name: string;
  age: number;
  country: string;
  imageUrl?: string;
  role?: string;
  isWicketKeeper?: boolean;
  bowlingStyle?: BowlingStyle;
  battingHand?: BattingHand;
  careerStats?: { m: number; r: number; avg: number; sr: number; w: number; econ: number };
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  /** Optional 0-99 fielding / keeping ratings (fielding.ts); absent = engine defaults */
  fielding?: number;
  keeping?: number;
  /** ODI / Test ratings, kept as given (the ratings pipeline ships them already normalised); absent = T20 ratings */
  formatRatings?: Partial<Record<LongFormat, FormatRatings>>;
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
    ...(typeof data.fielding === "number" ? { fielding: data.fielding } : {}),
    ...(typeof data.keeping === "number" ? { keeping: data.keeping } : {}),
  };
  const role = inferRuntimeRole(rawRatings, data.role, isWicketKeeper);
  const ratings = normalizeRatingsForRole(rawRatings, role, isWicketKeeper);

  return new Player({
    id: nextPlayerId(),
    sourceId: data.id,
    name: data.name,
    age: data.age,
    country: data.country,
    imageUrl: data.imageUrl,
    role,
    ratings,
    ...(data.formatRatings ? { formatRatings: data.formatRatings } : {}),
    isInternational,
    isWicketKeeper,
    bowlingStyle: data.bowlingStyle,
    battingHand: data.battingHand,
    careerStats: data.careerStats,
    teamId: data.teamId,
    bid: data.bid,
    injured: false,
    injuryGamesLeft: 0,
  });
}
