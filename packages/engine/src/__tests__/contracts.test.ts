import { describe, expect, it } from "vitest";
import { Player, type PlayerData } from "../player.js";
import { Team, type TeamConfig } from "../team.js";
import {
  getContractLength,
  assignTeamContracts,
  tickContracts,
  getExpiringContracts,
  releaseFreeAgents,
  extendContract,
  getContractBadge,
} from "../contracts.js";

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

function makeTeam(playerOverrides: Partial<PlayerData>[] = []): Team {
  const team = new Team(testTeamConfig);
  for (let i = 0; i < Math.max(3, playerOverrides.length); i++) {
    const p = new Player(makePlayerData({
      id: `p_${i}`,
      name: `Player ${i}`,
      contractYears: 3,
      ...(playerOverrides[i] ?? {}),
    }));
    team.addPlayer(p, 1);
  }
  return team;
}

describe("getContractLength", () => {
  it("returns 3 for retained players", () => {
    expect(getContractLength("retained")).toBe(3);
  });

  it("returns 3 for auction buys", () => {
    expect(getContractLength("auction")).toBe(3);
  });

  it("returns 2 for mini-auction", () => {
    expect(getContractLength("mini-auction")).toBe(2);
  });

  it("returns 1 for free agents", () => {
    expect(getContractLength("free-agent")).toBe(1);
  });
});

describe("assignTeamContracts", () => {
  it("assigns contract years to all players with 0 contracts", () => {
    const team = makeTeam([
      { contractYears: 0 },
      { contractYears: 0 },
      { contractYears: 0 },
    ]);
    assignTeamContracts(team, "retained");
    for (const p of team.roster) {
      expect(p.contractYears).toBe(3);
    }
  });

  it("does not overwrite existing contracts", () => {
    const team = makeTeam([
      { contractYears: 5 },
    ]);
    assignTeamContracts(team, "retained");
    expect(team.roster[0].contractYears).toBe(5);
  });
});

describe("tickContracts", () => {
  it("decreases contract years by 1", () => {
    const team = makeTeam([
      { contractYears: 3 },
      { contractYears: 2 },
      { contractYears: 1 },
    ]);
    tickContracts(team);
    expect(team.roster[0].contractYears).toBe(2);
    expect(team.roster[1].contractYears).toBe(1);
    expect(team.roster[2].contractYears).toBe(0);
  });

  it("reports final year players", () => {
    const team = makeTeam([
      { contractYears: 2 },
    ]);
    const report = tickContracts(team);
    expect(report.finalYear.length).toBe(1);
    expect(report.finalYear[0].playerName).toBe("Player 0");
  });

  it("reports free agents", () => {
    const team = makeTeam([
      { contractYears: 1 },
    ]);
    const report = tickContracts(team);
    expect(report.freeAgents.length).toBe(1);
  });

  it("does not go below 0", () => {
    const team = makeTeam([
      { contractYears: 0 },
    ]);
    tickContracts(team);
    expect(team.roster[0].contractYears).toBe(0);
  });
});

describe("getExpiringContracts", () => {
  it("returns correct report without modifying data", () => {
    const team = makeTeam([
      { contractYears: 1 },
      { contractYears: 3 },
      { contractYears: 0 },
    ]);
    const report = getExpiringContracts(team);
    expect(report.finalYear.length).toBe(1);
    expect(report.freeAgents.length).toBe(1);
    // Data unchanged
    expect(team.roster[0].contractYears).toBe(1);
    expect(team.roster[2].contractYears).toBe(0);
  });
});

describe("releaseFreeAgents", () => {
  it("removes players with 0 contract years", () => {
    const team = makeTeam([
      { contractYears: 2 },
      { contractYears: 0 },
      { contractYears: 1 },
    ]);
    const released = releaseFreeAgents(team);
    expect(released.length).toBe(1);
    expect(released[0].name).toBe("Player 1");
    expect(team.roster.length).toBe(2);
  });

  it("clears teamId on released players", () => {
    const team = makeTeam([
      { contractYears: 0 },
    ]);
    const released = releaseFreeAgents(team);
    expect(released[0].teamId).toBeUndefined();
  });

  it("refunds their salary from team spend", () => {
    const team = makeTeam([
      { contractYears: 0 },
      { contractYears: 3 },
      { contractYears: 3 },
    ]);

    expect(team.totalSpent).toBe(3);

    releaseFreeAgents(team);

    expect(team.totalSpent).toBe(2);
  });
});

describe("extendContract", () => {
  it("adds years to existing contract", () => {
    const p = new Player(makePlayerData({ contractYears: 1 }));
    extendContract(p, 2);
    expect(p.contractYears).toBe(3);
  });
});

describe("getContractBadge", () => {
  it("returns FA for 0 years", () => {
    expect(getContractBadge(0)).toBe("FA");
  });

  it("returns yr badge for positive years", () => {
    expect(getContractBadge(2)).toBe("2yr");
    expect(getContractBadge(1)).toBe("1yr");
  });
});
