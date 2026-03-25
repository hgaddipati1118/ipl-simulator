import { describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({
  getRealPlayers: () => [],
}));

vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({
  getWPLPlayers: () => [],
}));

import { DEFAULT_RULES, IPL_TEAMS, Player, Team, type PlayerData } from "@ipl-sim/engine";
import {
  extendUserPlayerContract,
  nextSeason,
  releaseExpiredUserContracts,
  type GameState,
} from "../game-state";
import { createRecruitmentState } from "../recruitment";
import { createScoutingState } from "../scouting";

function makePlayer(id: string, overrides?: Partial<PlayerData>): Player {
  return new Player({
    id,
    name: `Player ${id}`,
    age: 27,
    country: "India",
    role: "all-rounder",
    ratings: {
      battingIQ: 70,
      timing: 69,
      power: 68,
      running: 65,
      wicketTaking: 67,
      economy: 66,
      accuracy: 65,
      clutch: 64,
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  });
}

function buildState(): GameState {
  const userTeam = new Team(IPL_TEAMS[0]);
  const cpuTeam = new Team(IPL_TEAMS[1]);

  userTeam.addPlayer(makePlayer("user_expiring", { contractYears: 1 }), 8);
  userTeam.addPlayer(makePlayer("user_core", { contractYears: 3 }), 7);
  cpuTeam.addPlayer(makePlayer("cpu_expiring", { contractYears: 1 }), 6);
  cpuTeam.addPlayer(makePlayer("cpu_core", { contractYears: 3 }), 6);

  const teams = [userTeam, cpuTeam];

  return {
    phase: "results",
    rules: { ...DEFAULT_RULES, teamIds: teams.map(team => team.id) },
    teams,
    userTeamId: userTeam.id,
    playerPool: [],
    auctionResult: null,
    seasonResult: null,
    seasonNumber: 1,
    history: [],
    tradeOffers: [],
    completedTrades: [],
    schedule: [],
    currentMatchIndex: 0,
    matchResults: [],
    playoffsStarted: false,
    needsLineup: false,
    recentInjuries: [],
    narrativeEvents: [],
    trainingReport: [],
    scouting: createScoutingState(teams, [], userTeam.id, 1),
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
    contractsResolved: true,
  };
}

describe("offseason contract flow", () => {
  it("locks the trade window when the user has expired deals and releases CPU free agents", () => {
    const next = nextSeason(buildState());

    expect(next.phase).toBe("trade");
    expect(next.contractsResolved).toBe(false);
    expect(next.tradeOffers).toEqual([]);
    expect(next.contractReport?.freeAgents.map(player => player.playerId)).toContain("user_expiring");
    expect(next.teams[0].roster.some(player => player.id === "user_expiring")).toBe(true);
    expect(next.teams[1].roster.some(player => player.id === "cpu_expiring")).toBe(false);
    expect(next.playerPool.some(player => player.id === "cpu_expiring")).toBe(true);
  });

  it("can renew an expired user player and unlock contracts", () => {
    const offseason = nextSeason(buildState());
    const renewed = extendUserPlayerContract(offseason, "user_expiring", 2);

    expect(renewed.contractsResolved).toBe(true);
    expect(renewed.contractReport?.freeAgents).toHaveLength(0);
    expect(renewed.teams[0].roster.find(player => player.id === "user_expiring")?.contractYears).toBe(2);
  });

  it("can release expired user players into the pool", () => {
    const offseason = nextSeason(buildState());
    const released = releaseExpiredUserContracts(offseason);

    expect(released.contractsResolved).toBe(true);
    expect(released.teams[0].roster.some(player => player.id === "user_expiring")).toBe(false);
    expect(released.playerPool.some(player => player.id === "user_expiring")).toBe(true);
    expect(released.contractReport?.freeAgents).toHaveLength(0);
  });
});
