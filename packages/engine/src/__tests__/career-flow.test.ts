/**
 * Integration tests for the full multi-season career flow.
 * Tests the FM-style management systems working together.
 */
import { describe, it, expect } from "vitest";
import {
  Team, IPL_TEAMS, Player, createPlayerFromData,
  runSeason, RULE_PRESETS,
  getAuctionType, getMaxRetentions,
  generateBoardObjectives, evaluateBoardObjectives, createBoardState,
  updateTeamMorale, getMoraleModifier, initSeasonMorale,
  getContractLength, assignTeamContracts, tickContracts, getExpiringContracts,
  generateYouthProspects,
  calculateWinProbability,
  getDLSResource, calculateDLSTarget,
  getMatchupModifiers, isPaceBowler, isSpinBowler,
} from "../index.js";
import { getRealPlayers } from "@ipl-sim/ratings";

function buildTeams() {
  const teams = IPL_TEAMS.map(c => new Team(c, 125));
  for (const d of getRealPlayers()) {
    const p = createPlayerFromData(d);
    const t = teams.find(t => t.id === d.teamId);
    if (!t || t.roster.length >= 25) continue;
    if (p.isInternational && t.internationalCount >= 8) continue;
    t.addPlayer(p, Math.min(p.marketValue, 15));
  }
  return teams;
}

describe("Auction Cycle", () => {
  it("mega auction at season 1, 4, 7, 10", () => {
    const rules = RULE_PRESETS.modern2026;
    expect(getAuctionType(1, rules)).toBe("mega");
    expect(getAuctionType(2, rules)).toBe("mini");
    expect(getAuctionType(3, rules)).toBe("mini");
    expect(getAuctionType(4, rules)).toBe("mega");
    expect(getAuctionType(7, rules)).toBe("mega");
    expect(getAuctionType(10, rules)).toBe("mega");
  });

  it("mega allows 6 retentions, mini allows unlimited (full roster)", () => {
    const rules = RULE_PRESETS.modern2026;
    expect(getMaxRetentions("mega", rules)).toBe(6);
    expect(getMaxRetentions("mini", rules)).toBe(25); // Keep full roster
  });
});

describe("Board Expectations", () => {
  it("generates objectives for strong teams", () => {
    const objectives = generateBoardObjectives({ seasonNumber: 1, teamPower: 88 });
    expect(objectives.length).toBeGreaterThan(0);
    const types = objectives.map(o => o.type);
    expect(types).toContain("title"); // Strong team should target title
  });

  it("generates easier objectives for weak teams", () => {
    const objectives = generateBoardObjectives({ seasonNumber: 1, teamPower: 72 });
    const types = objectives.map(o => o.type);
    // Should not expect title from a weak team
    expect(types.includes("title")).toBe(false);
  });

  it("evaluates meeting objectives positively", () => {
    const objectives = generateBoardObjectives({ seasonNumber: 1, teamPower: 85 });
    const result = evaluateBoardObjectives({
      objectives,
      finalPosition: 1,
      isChampion: true,
      youthMatchesGiven: 5,
      currentNRR: 1.5,
    });
    expect(result.satisfaction).toBeGreaterThan(0);
    expect(result.budgetModifier).toBeGreaterThanOrEqual(1.0);
  });
});

describe("Player Morale", () => {
  it("winning boosts morale", () => {
    const teams = buildTeams();
    const team = teams[0];
    const initialMorale = team.roster[0].morale;
    const xiIds = new Set(team.roster.slice(0, 11).map(p => p.id));

    updateTeamMorale(team, {
      won: true, marginText: "23 runs", playingXIIds: xiIds,
      consecutiveWins: 1, consecutiveLosses: 0,
    });
    expect(team.roster[0].morale).toBeGreaterThanOrEqual(initialMorale);
  });

  it("losing decreases morale", () => {
    const teams = buildTeams();
    const team = teams[0];
    const initialMorale = team.roster[0].morale;
    const xiIds = new Set(team.roster.slice(0, 11).map(p => p.id));

    updateTeamMorale(team, {
      won: false, marginText: "5 wickets", playingXIIds: xiIds,
      consecutiveWins: 0, consecutiveLosses: 1,
    });
    expect(team.roster[0].morale).toBeLessThanOrEqual(initialMorale);
  });

  it("morale modifier is within expected range", () => {
    const highMorale = getMoraleModifier(90);
    const lowMorale = getMoraleModifier(20);

    expect(highMorale).toBeGreaterThanOrEqual(1.0);
    expect(lowMorale).toBeLessThanOrEqual(1.0);
  });
});

describe("Contract System", () => {
  it("assigns contracts based on source", () => {
    expect(getContractLength("retention")).toBeGreaterThanOrEqual(2);
    expect(getContractLength("mega-auction")).toBeGreaterThanOrEqual(2);
    expect(getContractLength("free-agent")).toBe(1);
  });

  it("tick reduces contract years", () => {
    const teams = buildTeams();
    const team = teams[0];
    assignTeamContracts(team, "mega-auction");

    const initialYears = team.roster[0].contractYears;
    tickContracts(team);
    expect(team.roster[0].contractYears).toBe(initialYears - 1);
  });

  it("identifies expiring contracts", () => {
    const teams = buildTeams();
    const team = teams[0];
    // Set one player to final year
    team.roster[0].contractYears = 1;
    team.roster[1].contractYears = 0;

    const report = getExpiringContracts(team);
    expect(report.finalYear.length).toBeGreaterThanOrEqual(1);
    expect(report.freeAgents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Youth Academy", () => {
  it("generates prospects with valid attributes", () => {
    const prospects = generateYouthProspects("csk", 3);
    expect(prospects.length).toBe(3);

    for (const p of prospects) {
      expect(p.player.age).toBeGreaterThanOrEqual(17);
      expect(p.player.age).toBeLessThanOrEqual(20);
      expect(p.player.country).toBe("India");
      expect(p.potential).toBeGreaterThanOrEqual(60);
      expect(p.potential).toBeLessThanOrEqual(99);
      expect(["Diamond", "Gold", "Silver", "Bronze"]).toContain(p.scoutRating);
      expect(p.player.overall).toBeGreaterThan(0);
    }
  });

  it("higher potential = better scout rating", () => {
    // Run many times to verify correlation
    let highPotentialHighRating = 0;
    for (let i = 0; i < 50; i++) {
      const prospects = generateYouthProspects("mi", 3);
      for (const p of prospects) {
        if (p.potential >= 85 && (p.scoutRating === "Diamond" || p.scoutRating === "Gold")) {
          highPotentialHighRating++;
        }
      }
    }
    // Most high-potential players should get good scout ratings
    expect(highPotentialHighRating).toBeGreaterThan(0);
  });
});

describe("Win Probability", () => {
  it("first innings at par ≈ 50%", () => {
    const prob = calculateWinProbability({
      score: 85, wickets: 2, overs: 10, balls: 0,
      innings: 1, battingTeamPower: 80, bowlingTeamPower: 80,
    });
    expect(prob).toBeGreaterThan(35);
    expect(prob).toBeLessThan(65);
  });

  it("chasing team with easy target has high probability", () => {
    const prob = calculateWinProbability({
      score: 150, wickets: 2, overs: 15, balls: 0,
      innings: 2, target: 160, battingTeamPower: 80, bowlingTeamPower: 80,
    });
    expect(prob).toBeGreaterThan(70);
  });

  it("chasing team needing lots from few balls has low probability", () => {
    const prob = calculateWinProbability({
      score: 100, wickets: 5, overs: 18, balls: 0,
      innings: 2, target: 200, battingTeamPower: 80, bowlingTeamPower: 80,
    });
    expect(prob).toBeLessThan(20);
  });
});

describe("DLS System", () => {
  it("full innings = score + 1 target", () => {
    expect(calculateDLSTarget(180, 20)).toBe(181);
  });

  it("reduced overs = reduced target", () => {
    const full = calculateDLSTarget(180, 20);
    const reduced = calculateDLSTarget(180, 10);
    expect(reduced).toBeLessThan(full);
  });

  it("more overs = more resources at 0 wickets", () => {
    let prev = 0;
    for (let o = 0; o <= 20; o++) {
      const res = getDLSResource(o, 0);
      expect(res).toBeGreaterThanOrEqual(prev);
      prev = res;
    }
  });
});

describe("Matchup System", () => {
  it("left-arm pace vs right-hand batter increases wicket chance", () => {
    const mods = getMatchupModifiers({
      bowlingStyle: "left-arm-fast",
      battingHand: "right",
      over: 5,
    });
    expect(mods.wicketMod).toBeGreaterThan(1.0);
  });

  it("spin in middle overs is more effective than powerplay", () => {
    const pp = getMatchupModifiers({
      bowlingStyle: "off-spin",
      battingHand: "right",
      over: 3, // powerplay
    });
    const mid = getMatchupModifiers({
      bowlingStyle: "off-spin",
      battingHand: "right",
      over: 10, // middle
    });
    expect(mid.wicketMod).toBeGreaterThan(pp.wicketMod);
  });

  it("turning pitch boosts spin", () => {
    const flat = getMatchupModifiers({
      bowlingStyle: "leg-spin",
      battingHand: "right",
      over: 10,
      pitchType: "flat",
    });
    const turning = getMatchupModifiers({
      bowlingStyle: "leg-spin",
      battingHand: "right",
      over: 10,
      pitchType: "turning",
    });
    expect(turning.wicketMod).toBeGreaterThan(flat.wicketMod);
  });
});

describe("Full Season Flow", { timeout: 30000 }, () => {
  it("completes a full season with all systems", () => {
    const teams = buildTeams();
    const result = runSeason(teams, RULE_PRESETS.modern2026);

    expect(result.champion).toBeTruthy();
    expect(result.orangeCap.name).toBeTruthy();
    expect(result.orangeCap.runs).toBeGreaterThan(0);
    expect(result.purpleCap.name).toBeTruthy();
    expect(result.purpleCap.wickets).toBeGreaterThan(0);
    expect(result.mvp.name).toBeTruthy();
    expect(result.mvp.points).toBeGreaterThan(0);
    expect(result.standings.length).toBe(10);
    expect(result.schedule.filter(m => m.result).length).toBeGreaterThanOrEqual(80);
  });
});
