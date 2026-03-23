/**
 * Real IPL player data sourced from the auto-generated ESPN ratings.
 * Filters ALL_PLAYERS to only those with a teamId (i.e., on an IPL 2026 roster).
 * Flattens the nested ratings format to the flat RealPlayerData interface
 * expected by the game state.
 */

import { ALL_PLAYERS } from "./all-players.js";

export interface RealPlayerData {
  name: string;
  age: number;
  country: string;
  role: string;
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  teamId: string;
  bid?: number;  // auction/retention price in crores
}

/**
 * Get all real IPL players that are assigned to a team roster.
 * Sources from the ESPN-generated ALL_PLAYERS, filtered to rostered players.
 */
export function getRealPlayers(): RealPlayerData[] {
  return ALL_PLAYERS
    .filter((p): p is typeof p & { teamId: string } => !!p.teamId)
    .map(p => ({
      name: p.name,
      age: p.age,
      country: p.country,
      role: p.role,
      battingIQ: p.ratings.battingIQ,
      timing: p.ratings.timing,
      power: p.ratings.power,
      running: p.ratings.running,
      wicketTaking: p.ratings.wicketTaking,
      economy: p.ratings.economy,
      accuracy: p.ratings.accuracy,
      clutch: p.ratings.clutch,
      teamId: p.teamId,
      bid: p.bid,
    }));
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
    p.teamId,
  ]);
