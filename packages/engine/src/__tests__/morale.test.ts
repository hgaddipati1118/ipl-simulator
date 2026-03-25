import { describe, expect, it } from "vitest";
import { Player, type PlayerData } from "../player.js";
import { Team, type TeamConfig } from "../team.js";
import {
  updateTeamMorale,
  getMoraleModifier,
  getClutchMoraleModifier,
  initSeasonMorale,
  getMoraleLabel,
  getDisgruntledPlayers,
  getConsecutiveResults,
} from "../morale.js";

function makePlayerData(overrides?: Partial<PlayerData>): PlayerData {
  return {
    id: "test_1",
    name: "Test Player",
    age: 28,
    country: "India",
    role: "batsman",
    ratings: {
      battingIQ: 80, timing: 75, power: 70, running: 60,
      wicketTaking: 30, economy: 25, accuracy: 35, clutch: 65,
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
    morale: 70,
    ...overrides,
  };
}

const testTeamConfig: TeamConfig = {
  id: "test",
  name: "Test Team",
  shortName: "TST",
  city: "Test City",
  primaryColor: "#000",
  secondaryColor: "#FFF",
};

function makeTeamWithPlayers(playerOverrides: Partial<PlayerData>[] = []): Team {
  const team = new Team(testTeamConfig);
  for (let i = 0; i < Math.max(3, playerOverrides.length); i++) {
    const p = new Player(makePlayerData({
      id: `p_${i}`,
      name: `Player ${i}`,
      morale: 70,
      ...(playerOverrides[i] ?? {}),
    }));
    team.addPlayer(p, 1);
  }
  return team;
}

describe("updateTeamMorale", () => {
  it("increases morale on win", () => {
    const team = makeTeamWithPlayers();
    const startMorale = team.roster[0].morale;
    updateTeamMorale(team, {
      won: true,
      marginText: "5 wickets",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 1,
      consecutiveLosses: 0,
    });
    expect(team.roster[0].morale).toBeGreaterThan(startMorale);
  });

  it("decreases morale on loss", () => {
    const team = makeTeamWithPlayers();
    const startMorale = team.roster[0].morale;
    updateTeamMorale(team, {
      won: false,
      marginText: "3 wickets",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 0,
      consecutiveLosses: 1,
    });
    expect(team.roster[0].morale).toBeLessThan(startMorale);
  });

  it("extra penalty for big loss", () => {
    const team = makeTeamWithPlayers();
    updateTeamMorale(team, {
      won: false,
      marginText: "87 runs",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 0,
      consecutiveLosses: 1,
    });
    // Should have bigger penalty due to big margin
    expect(team.roster[0].morale).toBeLessThanOrEqual(64);
  });

  it("gives MoM bonus", () => {
    const team = makeTeamWithPlayers();
    updateTeamMorale(team, {
      won: true,
      marginText: "5 wickets",
      motmPlayerId: "p_0",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 1,
      consecutiveLosses: 0,
    });
    expect(team.roster[0].morale).toBeGreaterThan(team.roster[1].morale);
  });

  it("penalizes dropped players", () => {
    const team = makeTeamWithPlayers();
    updateTeamMorale(team, {
      won: true,
      marginText: "5 wickets",
      playingXIIds: new Set(["p_0", "p_1"]), // p_2 dropped
      consecutiveWins: 1,
      consecutiveLosses: 0,
    });
    // p_2 was dropped (not in XI, not injured)
    expect(team.roster[2].morale).toBeLessThan(70);
  });

  it("streak bonus on 3+ consecutive wins", () => {
    const team = makeTeamWithPlayers();
    updateTeamMorale(team, {
      won: true,
      marginText: "5 wickets",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 3,
      consecutiveLosses: 0,
    });
    // Base win (+3) + selected (+1) + streak (+5) = +9
    expect(team.roster[0].morale).toBe(79);
  });

  it("streak penalty on 3+ consecutive losses", () => {
    const team = makeTeamWithPlayers();
    updateTeamMorale(team, {
      won: false,
      marginText: "3 wickets",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 0,
      consecutiveLosses: 3,
    });
    // Base loss (-2) + selected (+1) + streak (-8) = -9
    expect(team.roster[0].morale).toBe(61);
  });

  it("clamps morale between 0 and 100", () => {
    const team = makeTeamWithPlayers([{ morale: 5 }]);
    updateTeamMorale(team, {
      won: false,
      marginText: "90 runs",
      playingXIIds: new Set(team.roster.map(p => p.id)),
      consecutiveWins: 0,
      consecutiveLosses: 5,
    });
    expect(team.roster[0].morale).toBeGreaterThanOrEqual(0);
  });
});

describe("getMoraleModifier", () => {
  it("returns boost for high morale", () => {
    const p = new Player(makePlayerData({ morale: 85 }));
    expect(getMoraleModifier(p)).toBe(1.03);
  });

  it("returns penalty for low morale", () => {
    const p = new Player(makePlayerData({ morale: 25 }));
    expect(getMoraleModifier(p)).toBe(0.93);
  });

  it("returns neutral for average morale", () => {
    const p = new Player(makePlayerData({ morale: 50 }));
    expect(getMoraleModifier(p)).toBe(1.0);
  });
});

describe("getClutchMoraleModifier", () => {
  it("returns +5% for high morale", () => {
    const p = new Player(makePlayerData({ morale: 90 }));
    expect(getClutchMoraleModifier(p)).toBe(1.05);
  });

  it("returns -10% for low morale", () => {
    const p = new Player(makePlayerData({ morale: 30 }));
    expect(getClutchMoraleModifier(p)).toBe(0.90);
  });
});

describe("initSeasonMorale", () => {
  it("boosts retained players", () => {
    const team = makeTeamWithPlayers([{ morale: 60 }]);
    initSeasonMorale(team, new Set(["p_0"]));
    expect(team.roster[0].morale).toBe(70); // 60 + 10
  });

  it("sets new signings to 65", () => {
    const team = makeTeamWithPlayers([{ morale: 80 }]);
    initSeasonMorale(team, new Set([])); // no one retained
    expect(team.roster[0].morale).toBe(65);
  });
});

describe("getMoraleLabel", () => {
  it("returns Happy for high morale", () => {
    expect(getMoraleLabel(80).label).toBe("Happy");
    expect(getMoraleLabel(80).color).toBe("green");
  });

  it("returns Content for medium morale", () => {
    expect(getMoraleLabel(55).label).toBe("Content");
  });

  it("returns Unhappy for low morale", () => {
    expect(getMoraleLabel(25).label).toBe("Unhappy");
    expect(getMoraleLabel(25).color).toBe("red");
  });
});

describe("getDisgruntledPlayers", () => {
  it("returns players with morale below 30", () => {
    const team = makeTeamWithPlayers([
      { morale: 20 },
      { morale: 70 },
      { morale: 15 },
    ]);
    const disgruntled = getDisgruntledPlayers(team);
    expect(disgruntled.length).toBe(2);
  });

  it("excludes injured players", () => {
    const team = makeTeamWithPlayers([
      { morale: 20, injured: true, injuryGamesLeft: 3 },
    ]);
    const disgruntled = getDisgruntledPlayers(team);
    expect(disgruntled.length).toBe(0);
  });
});

describe("getConsecutiveResults", () => {
  it("counts consecutive wins", () => {
    const results = [
      { winnerId: "a", homeTeamId: "a", awayTeamId: "b" },
      { winnerId: "a", homeTeamId: "a", awayTeamId: "c" },
      { winnerId: "a", homeTeamId: "d", awayTeamId: "a" },
    ];
    const { consecutiveWins, consecutiveLosses } = getConsecutiveResults(results, "a");
    expect(consecutiveWins).toBe(3);
    expect(consecutiveLosses).toBe(0);
  });

  it("counts consecutive losses", () => {
    const results = [
      { winnerId: "b", homeTeamId: "a", awayTeamId: "b" },
      { winnerId: "c", homeTeamId: "a", awayTeamId: "c" },
    ];
    const { consecutiveWins, consecutiveLosses } = getConsecutiveResults(results, "a");
    expect(consecutiveWins).toBe(0);
    expect(consecutiveLosses).toBe(2);
  });

  it("stops counting when streak breaks", () => {
    const results = [
      { winnerId: "b", homeTeamId: "a", awayTeamId: "b" }, // loss
      { winnerId: "a", homeTeamId: "a", awayTeamId: "c" }, // win
      { winnerId: "a", homeTeamId: "d", awayTeamId: "a" }, // win
    ];
    const { consecutiveWins, consecutiveLosses } = getConsecutiveResults(results, "a");
    expect(consecutiveWins).toBe(2);
    expect(consecutiveLosses).toBe(0);
  });
});
