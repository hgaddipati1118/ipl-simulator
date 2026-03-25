/**
 * Contract system — players have multi-year deals.
 *
 * When contractYears reaches 0, the player becomes a free agent.
 * Contract length depends on how the player was acquired.
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
  finalYear: ContractInfo[];   // 1 year remaining (expiring this season)
  freeAgents: ContractInfo[];  // 0 years remaining (contract expired)
}

/** Get the initial contract length for a player acquisition */
export function getContractLength(source: ContractSource): number {
  switch (source) {
    case "retained": return 3;
    case "auction": return 3;
    case "mini-auction": return 2;
    case "free-agent": return 1;
    default: return 2;
  }
}

/** Assign contracts to all players on a team */
export function assignTeamContracts(team: Team, source: ContractSource): void {
  const years = getContractLength(source);
  for (const player of team.roster) {
    if (player.contractYears <= 0) {
      player.contractYears = years;
    }
  }
}

/** Tick down contracts at season end (reduce by 1) */
export function tickContracts(team: Team): ExpiringContractReport {
  const finalYear: ContractInfo[] = [];
  const freeAgents: ContractInfo[] = [];

  for (const player of team.roster) {
    player.contractYears = Math.max(0, player.contractYears - 1);

    if (player.contractYears === 1) {
      finalYear.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        yearsRemaining: 1,
        source: "auction", // source doesn't matter at this point
      });
    } else if (player.contractYears === 0) {
      freeAgents.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        yearsRemaining: 0,
        source: "free-agent",
      });
    }
  }

  return { finalYear, freeAgents };
}

/** Get a report of expiring contracts (without modifying anything) */
export function getExpiringContracts(team: Team): ExpiringContractReport {
  const finalYear: ContractInfo[] = [];
  const freeAgents: ContractInfo[] = [];

  for (const player of team.roster) {
    if (player.contractYears === 1) {
      finalYear.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        yearsRemaining: 1,
        source: "auction",
      });
    } else if (player.contractYears <= 0) {
      freeAgents.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        yearsRemaining: 0,
        source: "free-agent",
      });
    }
  }

  return { finalYear, freeAgents };
}

/** Release all free agents (contractYears === 0) from a team, returning them */
export function releaseFreeAgents(team: Team): Player[] {
  const freeAgents: Player[] = [];
  const remaining: Player[] = [];

  for (const player of team.roster) {
    if (player.contractYears <= 0) {
      player.teamId = undefined;
      freeAgents.push(player);
    } else {
      remaining.push(player);
    }
  }

  team.roster = remaining;
  return freeAgents;
}

/** Extend a player's contract */
export function extendContract(player: Player, years: number): void {
  player.contractYears += years;
}

/** Get contract badge text for UI */
export function getContractBadge(contractYears: number): string {
  if (contractYears <= 0) return "FA";
  return `${contractYears}yr`;
}
