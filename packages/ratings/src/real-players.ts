/**
 * Real IPL player data sourced from the auto-generated ESPN ratings.
 * Filters ALL_PLAYERS to only those with a teamId (i.e., on an IPL 2026 roster).
 * Flattens the nested ratings format to the flat RealPlayerData interface
 * expected by the game state.
 */

import { ALL_PLAYERS } from "./all-players.js";
import type { BowlingStyle, BattingHand } from "@ipl-sim/engine";

/**
 * Known wicket-keepers. The ESPN pipeline classifies them as "batsman"
 * since WK stats look identical to batting stats. Override their role here.
 */
const KNOWN_WICKET_KEEPERS = new Set([
  // Primary WKs — fallback for when ESPN playingRoles data is missing
  "MS Dhoni", "Rishabh Pant", "KL Rahul", "Sanju Samson",
  "Ishan Kishan", "Jos Buttler", "Quinton de Kock", "Nicholas Pooran",
  "Heinrich Klaasen", "Dhruv Jurel", "Jitesh Sharma",
  "Srikar Bharat", "Wriddhiman Saha", "Phil Salt",
  "Dinesh Karthik", "Anuj Rawat", "Ryan Rickelton",
  "Kumar Kushagra", "Abishek Porel", "Aryan Juyal",
  "Tim Seifert", "Prabhsimran Singh", "Vishnu Vinod",
]);

export interface RealPlayerData {
  /** The pool id (`espn_<id>`), kept as the game player's sourceId */
  id: string;
  name: string;
  age: number;
  country: string;
  role: string;
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
  fielding?: number; // 0-99, 50 = average (absent = engine default)
  keeping?: number;  // 0-99, 50 = average keeper (absent = engine default)
  teamId?: string;
  bid?: number;  // auction/retention price in crores
  imageUrl?: string; // ESPN player photo path
  careerStats?: { m: number; r: number; avg: number; sr: number; w: number; econ: number };
}

/**
 * Get all real IPL players that are assigned to a team roster.
 * Sources from the ESPN-generated ALL_PLAYERS, filtered to rostered players.
 */
function mapPlayer(p: typeof ALL_PLAYERS[number]): RealPlayerData {
  return {
    id: p.id,
    name: p.name,
    age: p.age,
    country: p.country,
    role: p.role,
    // The curated list, plus anyone the ESPN data tags as a keeper (so squads and drafts see the real keepers)
    isWicketKeeper: KNOWN_WICKET_KEEPERS.has(p.name) || p.isWicketKeeper === true,
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
    ...(p.ratings.fielding !== undefined ? { fielding: p.ratings.fielding } : {}),
    ...(p.ratings.keeping !== undefined ? { keeping: p.ratings.keeping } : {}),
    teamId: p.teamId,
    bid: p.bid,
    imageUrl: p.imageUrl,
    careerStats: (p as any).careerStats,
  };
}

/**
 * Get all real IPL players that are assigned to a team roster.
 */
export function getRealPlayers(): RealPlayerData[] {
  return ALL_PLAYERS
    .filter((p): p is typeof p & { teamId: string } => !!p.teamId)
    .map(mapPlayer);
}

/**
 * Get all real players NOT on a team — available for the auction pool.
 * These are real cricketers from the ESPN database who aren't currently rostered.
 */
export function getPoolPlayers(): RealPlayerData[] {
  return ALL_PLAYERS
    .filter(p => !p.teamId)
    .map(mapPlayer);
}

/**
 * Legacy export for backward compatibility.
 * @deprecated Use getRealPlayers() instead.
 */
export const REAL_PLAYERS: [string, number, string, string, number, number, number, number, number, number, number, number, string][] =
  getRealPlayers().map(p => [
    p.name, p.age, p.country, p.role,
    p.battingIQ, p.timing, p.power, p.running,
    p.wicketTaking, p.economy, p.accuracy, p.clutch,
    p.teamId ?? "",
  ]);
