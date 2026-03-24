/**
 * Injury system for the IPL simulator.
 * Handles injury checks after matches, healing, and availability tracking.
 */

import { Player, PlayerRole } from "./player.js";
import { Team } from "./team.js";

export type InjurySeverity = "minor" | "moderate" | "severe";

export interface InjuryStatus {
  isInjured: boolean;
  injuryType: string;
  matchesRemaining: number;
  severity: InjurySeverity;
}

/** Possible injury types */
const INJURY_TYPES = [
  "hamstring",
  "shoulder",
  "back",
  "finger",
  "ankle",
  "side strain",
];

/** Base injury chance per match by role */
const BASE_INJURY_CHANCE: Record<PlayerRole, number> = {
  "batsman": 0.015,
  "bowler": 0.04,         // fast bowlers have the highest workload
  "all-rounder": 0.03,
  "wicket-keeper": 0.02,  // moderate risk from keeping duties
};

/** Additional injury chance for players over 34 */
const AGE_PENALTY_THRESHOLD = 34;
const AGE_PENALTY_CHANCE = 0.02;

/** Severity distribution and match durations */
const SEVERITY_DISTRIBUTION: { severity: InjurySeverity; probability: number; minMatches: number; maxMatches: number }[] = [
  { severity: "minor",    probability: 0.60, minMatches: 1, maxMatches: 2 },
  { severity: "moderate", probability: 0.30, minMatches: 3, maxMatches: 5 },
  { severity: "severe",   probability: 0.10, minMatches: 6, maxMatches: 10 },
];

/**
 * Roll an injury check for a player after a match.
 * Returns an InjuryStatus if the player gets injured, or null if not.
 */
export function checkForInjury(player: Player): InjuryStatus | null {
  if (player.injured) return null; // already injured

  let chance = BASE_INJURY_CHANCE[player.role] ?? 0.015;

  // Age penalty
  if (player.age > AGE_PENALTY_THRESHOLD) {
    chance += AGE_PENALTY_CHANCE;
  }

  if (Math.random() >= chance) return null;

  // Player is injured — determine severity
  const sevRoll = Math.random();
  let cumulative = 0;
  let severity: InjurySeverity = "minor";
  let minMatches = 1;
  let maxMatches = 2;

  for (const entry of SEVERITY_DISTRIBUTION) {
    cumulative += entry.probability;
    if (sevRoll <= cumulative) {
      severity = entry.severity;
      minMatches = entry.minMatches;
      maxMatches = entry.maxMatches;
      break;
    }
  }

  const matchesRemaining = minMatches + Math.floor(Math.random() * (maxMatches - minMatches + 1));
  const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];

  return {
    isInjured: true,
    injuryType,
    matchesRemaining,
    severity,
  };
}

/**
 * Apply injury to a player from an InjuryStatus.
 */
export function applyInjury(player: Player, injury: InjuryStatus): void {
  player.injured = true;
  player.injuryGamesLeft = injury.matchesRemaining;
  player.injuryType = injury.injuryType;
  player.injurySeverity = injury.severity;
}

/**
 * Run injury checks for all players in a playing XI after a match.
 * Returns an array of newly injured players with their injury details.
 * If injuriesEnabled is false, skips all checks and returns empty array.
 */
export function runPostMatchInjuryChecks(
  playingXI: Player[],
  injuriesEnabled = true,
): { player: Player; injury: InjuryStatus }[] {
  if (!injuriesEnabled) return [];

  const newInjuries: { player: Player; injury: InjuryStatus }[] = [];

  for (const player of playingXI) {
    const injury = checkForInjury(player);
    if (injury) {
      applyInjury(player, injury);
      newInjuries.push({ player, injury });
    }
  }

  return newInjuries;
}

/**
 * Heal injuries for all players in a team. Decrements matchesRemaining by 1.
 * Clears injury status when matchesRemaining reaches 0.
 */
export function healInjuries(team: Team): Player[] {
  const healed: Player[] = [];

  for (const player of team.roster) {
    if (player.injured) {
      player.injuryGamesLeft--;
      if (player.injuryGamesLeft <= 0) {
        player.injured = false;
        player.injuryGamesLeft = 0;
        player.injuryType = undefined;
        player.injurySeverity = undefined;
        healed.push(player);
      }
    }
  }

  return healed;
}

/**
 * Get all available (non-injured) players from a team's roster.
 */
export function getAvailablePlayers(team: Team): Player[] {
  return team.roster.filter(p => !p.injured);
}

/**
 * Check if any players in a proposed playing XI are injured.
 * Returns the list of injured players found in the XI.
 */
export function getInjuredPlayersInXI(playingXI: Player[]): Player[] {
  return playingXI.filter(p => p.injured);
}

/**
 * Get the injury summary for a team (for UI display).
 */
export function getTeamInjuryReport(team: Team): { player: Player; matchesLeft: number; type: string; severity: InjurySeverity }[] {
  return team.roster
    .filter(p => p.injured)
    .map(p => ({
      player: p,
      matchesLeft: p.injuryGamesLeft,
      type: p.injuryType ?? "unknown",
      severity: (p.injurySeverity ?? "minor") as InjurySeverity,
    }));
}
