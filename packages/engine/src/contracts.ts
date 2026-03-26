/**
 * Roster management for the IPL auction cycle.
 *
 * IPL doesn't have multi-year contracts. Players belong to a team
 * until the next mega auction, when all non-retained players go to
 * the auction pool. Between mega auctions (mini auction years),
 * teams keep their full roster.
 *
 * The contractYears field is used internally as a release marker:
 *   1 = on roster (active)
 *   0 = marked for release / free agent
 */

import type { Player } from "./player.js";
import type { Team } from "./team.js";

export type ContractSource = "retained" | "auction" | "mini-auction" | "free-agent";

export interface ContractInfo {
  playerId: string;
  playerName: string;
  teamId: string;
  yearsRemaining: number;
  source: ContractSource;
}

export interface ExpiringContractReport {
  finalYear: ContractInfo[];   // unused in annual model, kept for API compat
  freeAgents: ContractInfo[];  // players marked for release (contractYears=0)
}

/** All IPL contracts are annual. */
export function getContractLength(_source: ContractSource): number {
  return 1;
}

/** Mark all uncontracted players as active (contractYears = 1) */
export function assignTeamContracts(team: Team, _source: ContractSource): void {
  for (const player of team.roster) {
    if (player.contractYears <= 0) {
      player.contractYears = 1;
    }
  }
}

/** At season end, expire all contracts (set to 0 = available for release). */
export function tickContracts(team: Team): ExpiringContractReport {
  const freeAgents: ContractInfo[] = [];

  for (const player of team.roster) {
    player.contractYears = Math.max(0, player.contractYears - 1);

    if (player.contractYears === 0) {
      freeAgents.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        yearsRemaining: 0,
        source: "free-agent",
      });
    }
  }

  return { finalYear: [], freeAgents };
}

/** Get a report of players marked for release (without modifying anything) */
export function getExpiringContracts(team: Team): ExpiringContractReport {
  const freeAgents: ContractInfo[] = [];

  for (const player of team.roster) {
    if (player.contractYears <= 0) {
      freeAgents.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        yearsRemaining: 0,
        source: "free-agent",
      });
    }
  }

  return { finalYear: [], freeAgents };
}

/** Release all players with contractYears=0 from a team, returning them */
export function releaseFreeAgents(team: Team): Player[] {
  const freeAgentIds = team.roster
    .filter(player => player.contractYears <= 0)
    .map(player => player.id);

  const freeAgents: Player[] = [];
  for (const playerId of freeAgentIds) {
    const released = team.removePlayer(playerId);
    if (released) freeAgents.push(released);
  }

  return freeAgents;
}

/** Re-sign a player (set contractYears back to 1 = active) */
export function extendContract(player: Player, _years?: number): void {
  player.contractYears = 1;
}

/** Contract badge — no longer shown since all IPL contracts are annual.
 *  @deprecated Use roster status instead */
export function getContractBadge(contractYears: number): string {
  if (contractYears <= 0) return "FA";
  return ""; // no badge needed — everyone on the roster is contracted
}
