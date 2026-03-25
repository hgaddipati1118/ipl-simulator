import { describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({
  getRealPlayers: () => [],
}));

vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({
  getWPLPlayers: () => [],
}));

import { DEFAULT_RULES, IPL_TEAMS, Player, Team, type PlayerData } from "@ipl-sim/engine";
import { recordTeamScoutingExposure, type GameState } from "../game-state";
import { createRecruitmentState } from "../recruitment";
import { boostPlayerScouting, createScoutingState, getPlayerScoutingView } from "../scouting";

function makePlayer(id: string, overrides?: Partial<PlayerData>): Player {
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role: "all-rounder",
    ratings: {
      battingIQ: 72,
      timing: 70,
      power: 69,
      running: 65,
      wicketTaking: 68,
      economy: 67,
      accuracy: 66,
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
  userTeam.addPlayer(makePlayer("user_star"), 8);

  const targetTeam = new Team(IPL_TEAMS[1]);
  targetTeam.addPlayer(makePlayer("target_star", {
    isInternational: true,
    country: "England",
    ratings: {
      battingIQ: 84,
      timing: 83,
      power: 85,
      running: 72,
      wicketTaking: 32,
      economy: 35,
      accuracy: 34,
      clutch: 82,
    },
    role: "batsman",
  }), 10);
  targetTeam.addPlayer(makePlayer("target_depth"), 4);

  const playerPool = [makePlayer("pool_one", { age: 21 })];
  const scouting = createScoutingState([userTeam, targetTeam], playerPool, userTeam.id, 1);

  return {
    phase: "trade",
    rules: DEFAULT_RULES,
    teams: [userTeam, targetTeam],
    userTeamId: userTeam.id,
    playerPool,
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
    scouting,
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
  };
}

describe("scouting helpers", () => {
  it("keeps user roster exact while external players stay estimate-based", () => {
    const state = buildState();
    const ownPlayer = state.teams[0].roster[0];
    const externalPlayer = state.teams[1].roster[0];

    const ownView = getPlayerScoutingView(ownPlayer, state.teams[0].id, state.scouting, state.userTeamId);
    const externalView = getPlayerScoutingView(externalPlayer, state.teams[1].id, state.scouting, state.userTeamId);

    expect(ownView.exactRatings).toBe(true);
    expect(ownView.overall.display).toBe(String(ownPlayer.overall));
    expect(externalView.exactRatings).toBe(false);
    expect(externalView.overall.display).not.toBe(String(externalPlayer.overall));
  });

  it("caps confidence gains at 100", () => {
    const state = buildState();
    const externalPlayer = state.teams[1].roster[0];

    const boosted = boostPlayerScouting(
      state.scouting,
      state.teams,
      state.playerPool,
      state.userTeamId,
      state.seasonNumber,
      [externalPlayer.id],
      80,
    );

    expect(boosted.reports[externalPlayer.id].confidence).toBe(100);
  });

  it("boosts the full target roster when a team scouting action is recorded", () => {
    const state = buildState();
    const targetTeam = state.teams[1];
    const before = targetTeam.roster.map(player => state.scouting.reports[player.id].confidence);

    const next = recordTeamScoutingExposure(state, targetTeam.id, 12);
    const after = targetTeam.roster.map(player => next.scouting.reports[player.id].confidence);

    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[1]).toBeGreaterThan(before[1]);
  });
});
