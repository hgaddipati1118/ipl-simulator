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

/** Build state for a mega auction offseason (season 5 → 6).
 *  CPU team has 8 players so some get released (maxRetentions = 6). */
function buildMegaAuctionState(): GameState {
  const userTeam = new Team(IPL_TEAMS[0]);
  const cpuTeam = new Team(IPL_TEAMS[1]);

  // User team: 2 players — both expire at mega auction
  userTeam.addPlayer(makePlayer("user_a", { contractYears: 1 }), 8);
  userTeam.addPlayer(makePlayer("user_b", { contractYears: 1 }), 7);

  // CPU team: 8 players — at mega auction, retain top 6, release 2
  for (let i = 0; i < 8; i++) {
    cpuTeam.addPlayer(
      makePlayer(`cpu_${i}`, {
        contractYears: 1,
        // Lower-indexed players have higher overall (will be retained)
        ratings: {
          battingIQ: 80 - i * 5,
          timing: 78 - i * 5,
          power: 75 - i * 5,
          running: 70 - i * 3,
          wicketTaking: 30,
          economy: 25,
          accuracy: 30,
          clutch: 65 - i * 3,
        },
      }),
      10 - i,
    );
  }

  const teams = [userTeam, cpuTeam];

  return {
    phase: "results",
    rules: { ...DEFAULT_RULES, teamIds: teams.map(team => team.id) },
    teams,
    userTeamId: userTeam.id,
    playerPool: [],
    auctionResult: null,
    seasonResult: null,
    seasonNumber: 5, // Next season (6) will be mega auction
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
    scoutingAssignments: [],
    scoutingInbox: [],
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
    contractsResolved: true,
  };
}

describe("offseason contract flow — mega auction", () => {
  it("at mega auction, user gets expiry report and CPU releases excess players", () => {
    const next = nextSeason(buildMegaAuctionState());

    expect(next.phase).toBe("trade");
    // User has unresolved expired contracts
    expect(next.contractsResolved).toBe(false);
    expect(next.tradeOffers).toEqual([]);
    // All user players show as free agents (contractYears=0 after tick)
    expect(next.contractReport?.freeAgents.map(p => p.playerId)).toContain("user_a");
    expect(next.contractReport?.freeAgents.map(p => p.playerId)).toContain("user_b");
    // CPU retained top 6, released bottom 2
    expect(next.teams[1].roster.length).toBe(6);
    // Released CPU players end up in pool
    expect(next.playerPool.some(p => p.id === "cpu_6")).toBe(true);
    expect(next.playerPool.some(p => p.id === "cpu_7")).toBe(true);
  });

  it("renewing ALL expired user players resolves contracts", () => {
    const offseason = nextSeason(buildMegaAuctionState());
    // Must extend both to resolve all
    let state = extendUserPlayerContract(offseason, "user_a", 1);
    state = extendUserPlayerContract(state, "user_b", 1);

    expect(state.contractsResolved).toBe(true);
    expect(state.contractReport?.freeAgents).toHaveLength(0);
    expect(state.teams[0].roster.find(p => p.id === "user_a")?.contractYears).toBe(1);
    expect(state.teams[0].roster.find(p => p.id === "user_b")?.contractYears).toBe(1);
  });

  it("releasing all expired user players puts them in the pool", () => {
    const offseason = nextSeason(buildMegaAuctionState());
    const released = releaseExpiredUserContracts(offseason);

    expect(released.contractsResolved).toBe(true);
    expect(released.teams[0].roster.some(p => p.id === "user_a")).toBe(false);
    expect(released.teams[0].roster.some(p => p.id === "user_b")).toBe(false);
    expect(released.playerPool.some(p => p.id === "user_a")).toBe(true);
    expect(released.playerPool.some(p => p.id === "user_b")).toBe(true);
  });
});

describe("offseason contract flow — mini auction", () => {
  it("at mini auction, all contracts auto-renew and no players released", () => {
    const state = buildMegaAuctionState();
    // Season 2 → 3 is a mini auction
    state.seasonNumber = 2;
    const next = nextSeason(state);

    expect(next.phase).toBe("trade");
    // All contracts resolved (auto-renewed)
    expect(next.contractsResolved).toBe(true);
    // All user players kept
    expect(next.teams[0].roster.some(p => p.id === "user_a")).toBe(true);
    // All CPU players kept
    expect(next.teams[1].roster.length).toBe(8);
    // All players have 1-year contracts (renewed)
    for (const team of next.teams) {
      for (const p of team.roster) {
        expect(p.contractYears).toBe(1);
      }
    }
  });
});
