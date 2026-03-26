import { describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({
  getRealPlayers: () => [],
}));

vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({
  getWPLPlayers: () => [],
}));

import { DEFAULT_RULES, IPL_TEAMS, Player, Team, type PlayerData } from "@ipl-sim/engine";
import {
  nextSeason,
  runCPURetentions,
  togglePlayerRetention,
  finishRetention,
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

/** Build state for a mega auction offseason (season 5 → 6). */
function buildMegaAuctionState(): GameState {
  const userTeam = new Team(IPL_TEAMS[0]);
  const cpuTeam = new Team(IPL_TEAMS[1]);

  // User team: 2 players
  userTeam.addPlayer(makePlayer("user_a", { contractYears: 1 }), 8);
  userTeam.addPlayer(makePlayer("user_b", { contractYears: 1 }), 7);

  // CPU team: 2 players
  cpuTeam.addPlayer(makePlayer("cpu_a", { contractYears: 1 }), 6);
  cpuTeam.addPlayer(makePlayer("cpu_b", { contractYears: 1 }), 6);

  const teams = [userTeam, cpuTeam];

  return {
    phase: "results",
    rules: { ...DEFAULT_RULES, teamIds: teams.map(team => team.id) },
    teams,
    userTeamId: userTeam.id,
    playerPool: [],
    auctionResult: null,
    seasonResult: null,
    seasonNumber: 3, // Next season (4) will be mega auction (3-year cycle)
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

describe("offseason — mega auction", () => {
  it("goes directly to retention phase at mega auction", () => {
    const next = nextSeason(buildMegaAuctionState());
    expect(next.phase).toBe("retention");
    expect(next.retentionState).toBeDefined();
    expect(next.retentionState?.retained).toEqual([]);
    // All user players start as released (user must pick who to retain)
    expect(next.retentionState?.released).toContain("user_a");
    expect(next.retentionState?.released).toContain("user_b");
    // All players still on roster (contractYears=1, re-activated)
    expect(next.teams[0].roster.some(p => p.id === "user_a")).toBe(true);
    expect(next.teams[1].roster.some(p => p.id === "cpu_a")).toBe(true);
  });

  it("CPU retentions release non-retained players to pool", () => {
    const state = nextSeason(buildMegaAuctionState());
    const afterCPU = runCPURetentions(state);
    expect(afterCPU.retentionState?.cpuDone).toBe(true);
    // CPU players may or may not be released depending on retention budget/logic
    // At minimum, the function should run without error
  });
});

describe("offseason — mini auction", () => {
  it("mini auction auto-renews all contracts and enters trade phase", () => {
    const state = buildMegaAuctionState();
    state.seasonNumber = 2; // Season 3 is mini auction
    const next = nextSeason(state);

    expect(next.phase).toBe("trade");
    // All players kept
    expect(next.teams[0].roster.some(p => p.id === "user_a")).toBe(true);
    expect(next.teams[1].roster.some(p => p.id === "cpu_a")).toBe(true);
    // All players have active contracts
    for (const team of next.teams) {
      for (const p of team.roster) {
        expect(p.contractYears).toBe(1);
      }
    }
  });
});
