import { describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({
  getRealPlayers: () => [],
}));

vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({
  getWPLPlayers: () => [],
}));

import { DEFAULT_RULES, IPL_TEAMS, Player, Team, type PlayerData } from "@ipl-sim/engine";
import {
  advanceActiveScoutingAssignments,
  toggleScoutingAssignment,
  toggleShortlistPlayer,
  toggleWatchlistPlayer,
  type GameState,
} from "../game-state";
import {
  createRecruitmentState,
  getRecruitmentCounts,
  getRecruitmentTag,
  syncRecruitmentState,
} from "../recruitment";
import { createScoutingState } from "../scouting";

function makePlayer(id: string, overrides?: Partial<PlayerData>): Player {
  return new Player({
    id,
    name: `Player ${id}`,
    age: 24,
    country: "India",
    role: "all-rounder",
    ratings: {
      battingIQ: 68,
      timing: 67,
      power: 66,
      running: 63,
      wicketTaking: 65,
      economy: 64,
      accuracy: 63,
      clutch: 62,
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  });
}

function buildState(): GameState {
  const userTeam = new Team(IPL_TEAMS[0]);
  const targetTeam = new Team(IPL_TEAMS[1]);
  const userPlayer = makePlayer("user_one");
  const targetPlayer = makePlayer("target_one");
  const poolPlayer = makePlayer("pool_one");

  userTeam.addPlayer(userPlayer, 5);
  targetTeam.addPlayer(targetPlayer, 6);

  const playerPool = [poolPlayer];

  return {
    phase: "trade",
    rules: DEFAULT_RULES,
    teams: [userTeam, targetTeam],
    userTeamId: userTeam.id,
    playerPool,
    auctionResult: null,
    seasonResult: null,
    seasonNumber: 2,
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
    scouting: createScoutingState([userTeam, targetTeam], playerPool, userTeam.id, 2),
    scoutingAssignments: [],
    scoutingInbox: [],
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
  };
}

describe("recruitment helpers", () => {
  it("toggles shortlist on and off for a player", () => {
    const state = buildState();
    const playerId = state.teams[1].roster[0].id;

    const shortlisted = toggleShortlistPlayer(state, playerId);
    expect(getRecruitmentTag(shortlisted.recruitment, playerId)).toBe("shortlist");

    const cleared = toggleShortlistPlayer(shortlisted, playerId);
    expect(getRecruitmentTag(cleared.recruitment, playerId)).toBeNull();
  });

  it("moves a player between watchlist and shortlist tiers", () => {
    const state = buildState();
    const playerId = state.teams[1].roster[0].id;

    const watchlisted = toggleWatchlistPlayer(state, playerId);
    const shortlisted = toggleShortlistPlayer(watchlisted, playerId);

    expect(getRecruitmentTag(shortlisted.recruitment, playerId)).toBe("shortlist");
    expect(getRecruitmentCounts(shortlisted.recruitment)).toEqual({ shortlist: 1, watchlist: 0 });
  });

  it("prunes targets for players no longer in any squad or pool", () => {
    const state = buildState();
    const [targetPlayer] = state.teams[1].roster;
    const [poolPlayer] = state.playerPool;

    const tracked = toggleWatchlistPlayer(toggleShortlistPlayer(state, targetPlayer.id), poolPlayer.id);
    const synced = syncRecruitmentState(tracked.recruitment, [state.teams[0]], []);

    expect(synced.targets[targetPlayer.id]).toBeUndefined();
    expect(synced.targets[poolPlayer.id]).toBeUndefined();
  });

  it("lets the shortlist scouting assignment follow shortlist targets over time", () => {
    const state = buildState();
    const playerId = state.teams[1].roster[0].id;
    const shortlisted = toggleShortlistPlayer(state, playerId);
    const assigned = toggleScoutingAssignment(shortlisted, "shortlist");
    const progressed = advanceActiveScoutingAssignments(assigned);

    expect(assigned.scoutingAssignments.some(entry => entry.type === "shortlist")).toBe(true);
    expect(progressed.scoutingInbox.some(entry => entry.headline.includes("Shortlist report"))).toBe(true);
  });
});
