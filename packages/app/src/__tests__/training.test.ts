import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({
  getRealPlayers: () => [],
}));

vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({
  getWPLPlayers: () => [],
}));

import { DEFAULT_RULES, Player, Team, IPL_TEAMS, type PlayerData } from "@ipl-sim/engine";
import {
  getBoardExpectation,
  getBoardExpectationStatus,
  nextSeason,
  setPlayerTrainingFocus,
  setTeamTrainingIntensity,
  type GameState,
} from "../game-state";
import { createRecruitmentState } from "../recruitment";

function makePlayer(id: string, overrides?: Partial<PlayerData>): Player {
  return new Player({
    id,
    name: `Player ${id}`,
    age: 24,
    country: "India",
    role: "all-rounder",
    ratings: {
      battingIQ: 64,
      timing: 64,
      power: 62,
      running: 60,
      wicketTaking: 63,
      economy: 62,
      accuracy: 61,
      clutch: 60,
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  });
}

function buildState(): GameState {
  const team = new Team(IPL_TEAMS[0]);
  team.addPlayer(makePlayer("p1"), 5);
  team.addPlayer(makePlayer("p2"), 5);

  return {
    phase: "season",
    rules: DEFAULT_RULES,
    teams: [team],
    userTeamId: team.id,
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
    scouting: { reports: {} },
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
  };
}

function buildLeagueState(): GameState {
  const teams = [0, 1, 2].map(index => {
    const team = new Team(IPL_TEAMS[index]);
    team.addPlayer(makePlayer(`t${index}_p1`, {
      ratings: {
        battingIQ: 78 - index * 6,
        timing: 78 - index * 6,
        power: 76 - index * 5,
        running: 64 - index * 3,
        wicketTaking: 74 - index * 5,
        economy: 72 - index * 5,
        accuracy: 70 - index * 5,
        clutch: 68 - index * 3,
      },
    }), 5);
    team.addPlayer(makePlayer(`t${index}_p2`, {
      ratings: {
        battingIQ: 76 - index * 6,
        timing: 75 - index * 6,
        power: 74 - index * 5,
        running: 62 - index * 3,
        wicketTaking: 72 - index * 5,
        economy: 70 - index * 5,
        accuracy: 68 - index * 5,
        clutch: 66 - index * 3,
      },
    }), 5);
    return team;
  });

  teams[0].wins = 2;
  teams[0].losses = 10;
  teams[1].wins = 9;
  teams[1].losses = 3;
  teams[2].wins = 8;
  teams[2].losses = 4;

  return {
    phase: "season",
    rules: { ...DEFAULT_RULES, teamIds: teams.map(team => team.id), playoffTeams: 2 },
    teams,
    userTeamId: teams[0].id,
    playerPool: [],
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
    scouting: { reports: {} },
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("training game state helpers", () => {
  it("updates a player's training focus", () => {
    const state = buildState();
    const updated = setPlayerTrainingFocus(state, "p1", "power");

    expect(updated.teams[0].roster.find(player => player.id === "p1")?.trainingFocus).toBe("power");
  });

  it("updates a team's training intensity", () => {
    const state = buildState();
    const updated = setTeamTrainingIntensity(state, state.teams[0].id, "hard");

    expect(updated.teams[0].trainingIntensity).toBe("hard");
  });

  it("builds a training report during season rollover", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const state = setTeamTrainingIntensity(
      setPlayerTrainingFocus(buildState(), "p1", "batting"),
      IPL_TEAMS[0].id,
      "hard",
    );

    const next = nextSeason(state);

    expect(next.seasonNumber).toBe(2);
    expect(next.trainingReport.length).toBe(2);
    expect(next.trainingReport[0].projectedReadiness).toBeLessThan(100);
    expect(next.trainingReport.some(entry => entry.focus === "batting")).toBe(true);
  });

  it("flags board pressure when a strong squad falls below target pace", () => {
    const state = buildLeagueState();
    const expectation = getBoardExpectation(state);
    const status = getBoardExpectationStatus(state, expectation);

    expect(expectation).not.toBeNull();
    expect(status?.label).toBe("Under Pressure");
    expect(status?.currentPosition).toBe(3);
  });
});
