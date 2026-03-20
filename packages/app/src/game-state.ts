/**
 * Central game state management.
 * Persists to localStorage so the game survives page reloads.
 */

import {
  Player, Team, IPL_TEAMS, TeamConfig,
  generatePlayerPool, createPlayerFromData,
  runAuction, runSeason,
  type SeasonResult, type AuctionResult,
} from "@ipl-sim/engine";
import { getRealPlayers } from "@ipl-sim/ratings";

export interface GameState {
  phase: "setup" | "auction" | "season" | "results";
  teams: Team[];
  userTeamId: string | null;
  playerPool: Player[];
  auctionResult: AuctionResult | null;
  seasonResult: SeasonResult | null;
  seasonNumber: number;
  history: SeasonSummary[];
}

export interface SeasonSummary {
  seasonNumber: number;
  champion: string;
  orangeCap: { name: string; runs: number };
  purpleCap: { name: string; wickets: number };
}

/** Initialize fresh game state */
export function createGameState(): GameState {
  const teams = IPL_TEAMS.map(config => new Team(config));

  // Load real players and assign to teams
  const realPlayers = getRealPlayers();
  for (const data of realPlayers) {
    const player = createPlayerFromData(data);
    const team = teams.find(t => t.id === data.teamId);
    if (team) {
      team.addPlayer(player, Math.min(player.marketValue, 15));
    }
  }

  // Generate additional random players to fill rosters
  const additionalPlayers = generatePlayerPool(200);

  return {
    phase: "setup",
    teams,
    userTeamId: null,
    playerPool: additionalPlayers,
    auctionResult: null,
    seasonResult: null,
    seasonNumber: 1,
    history: [],
  };
}

/** Run the auction phase */
export function runAuctionPhase(state: GameState): GameState {
  const result = runAuction(state.playerPool, state.teams);
  return {
    ...state,
    phase: "season",
    auctionResult: result,
    playerPool: result.unsold,
  };
}

/** Run a full season */
export function runSeasonPhase(state: GameState): GameState {
  const result = runSeason(state.teams);

  const allPlayers = state.teams.flatMap(t => t.roster);
  const orangePlayer = allPlayers.find(p => p.id === result.orangeCap.playerId);
  const purplePlayer = allPlayers.find(p => p.id === result.purpleCap.playerId);
  const championTeam = state.teams.find(t => t.id === result.champion);

  const summary: SeasonSummary = {
    seasonNumber: state.seasonNumber,
    champion: championTeam?.name ?? result.champion,
    orangeCap: { name: orangePlayer?.name ?? "Unknown", runs: result.orangeCap.runs },
    purpleCap: { name: purplePlayer?.name ?? "Unknown", wickets: result.purpleCap.wickets },
  };

  return {
    ...state,
    phase: "results",
    seasonResult: result,
    history: [...state.history, summary],
  };
}

/** Progress players and prepare for next season */
export function nextSeason(state: GameState): GameState {
  for (const team of state.teams) {
    for (const player of team.roster) {
      player.progress();
    }
  }

  // Add new young players to pool
  const newPlayers = generatePlayerPool(50);
  return {
    ...state,
    phase: "season",
    seasonNumber: state.seasonNumber + 1,
    seasonResult: null,
    playerPool: [...state.playerPool, ...newPlayers],
  };
}

// --- localStorage persistence ---

const STORAGE_KEY = "ipl-sim-state";

export function saveState(state: GameState): void {
  try {
    const serializable = {
      ...state,
      teams: state.teams.map(t => ({
        config: t.config,
        roster: t.roster.map(p => p.toJSON()),
        totalSpent: t.totalSpent,
        wins: t.wins, losses: t.losses, ties: t.ties,
        nrr: t.nrr, runsFor: t.runsFor, ballsFacedFor: t.ballsFacedFor,
        runsAgainst: t.runsAgainst, ballsFacedAgainst: t.ballsFacedAgainst,
      })),
      playerPool: state.playerPool.map(p => p.toJSON()),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // localStorage might be full
  }
}

export function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);

    const teams = data.teams.map((t: any) => {
      const team = new Team(t.config);
      team.roster = t.roster.map((p: any) => Player.fromJSON(p));
      team.totalSpent = t.totalSpent;
      team.wins = t.wins; team.losses = t.losses; team.ties = t.ties;
      team.nrr = t.nrr; team.runsFor = t.runsFor; team.ballsFacedFor = t.ballsFacedFor;
      team.runsAgainst = t.runsAgainst; team.ballsFacedAgainst = t.ballsFacedAgainst;
      return team;
    });

    const playerPool = data.playerPool.map((p: any) => Player.fromJSON(p));

    return {
      ...data,
      teams,
      playerPool,
    };
  } catch {
    return null;
  }
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY);
}
