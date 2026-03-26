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
      contractYears: 1,
      ...(playerOverrides[i] ?? {}),
    }));
    team.addPlayer(p, 1);
  }
  return team;
}

describe("getContractLength", () => {
  it("returns 1 for all sources (IPL annual)", () => {
    expect(getContractLength("retained")).toBe(1);
    expect(getContractLength("auction")).toBe(1);
    expect(getContractLength("mini-auction")).toBe(1);
    expect(getContractLength("free-agent")).toBe(1);
  });
});

describe("assignTeamContracts", () => {
  it("activates all players with expired contracts", () => {
    const team = makeTeam([
      { contractYears: 0 },
      { contractYears: 0 },
      { contractYears: 0 },
    ]);
    assignTeamContracts(team, "retained");
    for (const p of team.roster) {
      expect(p.contractYears).toBe(1);
    }
  });

  it("does not overwrite active contracts", () => {
    const team = makeTeam([
      { contractYears: 1 },
    ]);
    assignTeamContracts(team, "retained");
    expect(team.roster[0].contractYears).toBe(1);
  });
});

describe("tickContracts", () => {
  it("expires all contracts (1 → 0)", () => {
    const team = makeTeam([
      { contractYears: 1 },
      { contractYears: 1 },
      { contractYears: 1 },
    ]);
    const report = tickContracts(team);
    expect(team.roster[0].contractYears).toBe(0);
    expect(team.roster[1].contractYears).toBe(0);
    expect(team.roster[2].contractYears).toBe(0);
    expect(report.freeAgents.length).toBe(3);
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
  it("reports players with expired contracts without modifying data", () => {
    const team = makeTeam([
      { contractYears: 1 },
      { contractYears: 0 },
      { contractYears: 0 },
    ]);
    const report = getExpiringContracts(team);
    expect(report.freeAgents.length).toBe(2);
    // Data unchanged
    expect(team.roster[0].contractYears).toBe(1);
    expect(team.roster[1].contractYears).toBe(0);
  });
});

describe("releaseFreeAgents", () => {
  it("removes players with contractYears=0", () => {
    const team = makeTeam([
      { contractYears: 1 },
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
      { contractYears: 1 },
      { contractYears: 1 },
    ]);

    expect(team.totalSpent).toBe(3);
    releaseFreeAgents(team);
    expect(team.totalSpent).toBe(2);
  });
});

describe("extendContract", () => {
  it("re-signs a player (sets contractYears to 1)", () => {
    const p = new Player(makePlayerData({ contractYears: 0 }));
    extendContract(p);
    expect(p.contractYears).toBe(1);
  });
});

describe("getContractBadge", () => {
  it("returns FA for expired contracts", () => {
    expect(getContractBadge(0)).toBe("FA");
  });

  it("returns empty string for active contracts", () => {
    expect(getContractBadge(1)).toBe("");
  });
});
