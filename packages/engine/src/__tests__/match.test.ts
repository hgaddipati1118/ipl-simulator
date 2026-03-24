import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { simulateMatch } from "../match.js";
import { RULE_PRESETS } from "../rules.js";

function makePlayer(id: string, role: "batsman" | "bowler" | "all-rounder", isIntl = false, isWicketKeeper = false): Player {
  const batHeavy = role === "batsman";
  const bowlHeavy = role === "bowler";
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: isIntl ? "Australia" : "India",
    role,
    ratings: {
      battingIQ: batHeavy ? 70 : bowlHeavy ? 25 : 55,
      timing: batHeavy ? 68 : bowlHeavy ? 25 : 50,
      power: batHeavy ? 65 : bowlHeavy ? 20 : 50,
      running: batHeavy ? 60 : 40,
      wicketTaking: bowlHeavy ? 70 : batHeavy ? 20 : 55,
      economy: bowlHeavy ? 68 : batHeavy ? 20 : 55,
      accuracy: bowlHeavy ? 65 : batHeavy ? 20 : 50,
      clutch: 55,
    },
    isInternational: isIntl,
    isWicketKeeper,
    injured: false,
    injuryGamesLeft: 0,
  });
}

function buildTeam(configIdx: number): Team {
  const team = new Team(IPL_TEAMS[configIdx]);
  // 5 batsmen (1 WK) + 3 all-rounders + 4 bowlers = 12
  let id = configIdx * 100;
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bat_${++id}`, "batsman"), 5);
  team.addPlayer(makePlayer(`wk_${++id}`, "batsman", false, true), 5);
  for (let i = 0; i < 3; i++) team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder"), 5);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bow_${++id}`, "bowler"), 5);
  return team;
}

describe("simulateMatch", () => {
  it("produces a valid MatchResult", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.id).toBeTruthy();
    expect(result.homeTeamId).toBe(home.id);
    expect(result.awayTeamId).toBe(away.id);
    expect(result.tossWinner).toBeTruthy();
    expect(["bat", "bowl"]).toContain(result.tossDecision);
    expect(result.innings).toHaveLength(2);
    expect(result.winnerId).toBeTruthy();
    expect(result.margin).toBeTruthy();
    expect(result.motm).toBeTruthy();
  });

  it("first innings scores reasonable runs", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);
    const firstInnings = result.innings[0];

    expect(firstInnings.runs).toBeGreaterThan(50);
    expect(firstInnings.runs).toBeLessThan(350);
    expect(firstInnings.wickets).toBeGreaterThanOrEqual(0);
    expect(firstInnings.wickets).toBeLessThanOrEqual(10);
    expect(firstInnings.overs).toBeGreaterThanOrEqual(1);
    expect(firstInnings.overs).toBeLessThanOrEqual(20);
  });

  it("second innings respects target", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);
    const [inn1, inn2] = result.innings;

    if (result.margin.includes("wickets")) {
      // Chasing team won: scored >= target
      expect(inn2.runs).toBeGreaterThanOrEqual(inn1.runs + 1);
    } else if (result.margin.includes("runs")) {
      // Batting first won: second innings scored less
      expect(inn2.runs).toBeLessThan(inn1.runs + 1);
    }
  });

  it("updates team win/loss records", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    simulateMatch(home, away);

    expect(home.wins + home.losses).toBe(1);
    expect(away.wins + away.losses).toBe(1);
    // One wins, one loses
    expect(home.wins + away.wins).toBe(1);
  });

  it("updates NRR after match", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    simulateMatch(home, away);

    // At least one team should have non-zero NRR
    expect(home.runsFor).toBeGreaterThan(0);
    expect(away.runsFor).toBeGreaterThan(0);
  });

  it("updates player stats", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    simulateMatch(home, away);

    const allPlayers = [...home.roster, ...away.roster];
    const playersWithMatches = allPlayers.filter(p => p.stats.matches > 0);
    expect(playersWithMatches.length).toBeGreaterThan(0);

    // At least some players should have scored runs or taken wickets
    const totalRuns = allPlayers.reduce((s, p) => s + p.stats.runs, 0);
    expect(totalRuns).toBeGreaterThan(0);
  });

  it("ball log has entries", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    for (const inn of result.innings) {
      expect(inn.ballLog.length).toBeGreaterThan(0);
      for (const ball of inn.ballLog) {
        expect(ball.bowler).toBeTruthy();
        expect(ball.batter).toBeTruthy();
        expect(ball.outcome).toBeTruthy();
        expect(ball.commentary).toBeTruthy();
      }
    }
  });

  it("man of the match is a valid player", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);
    const allIds = [...home.roster, ...away.roster].map(p => p.id);
    expect(allIds).toContain(result.motm);
  });

  it("simulating multiple matches accumulates stats", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);

    simulateMatch(home, away);
    simulateMatch(home, away);
    simulateMatch(home, away);

    expect(home.matchesPlayed).toBe(3);
    expect(away.matchesPlayed).toBe(3);
  });

  it("second innings wickets are within 0-10", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);
    const [inn1, inn2] = result.innings;

    expect(inn1.wickets).toBeGreaterThanOrEqual(0);
    expect(inn1.wickets).toBeLessThanOrEqual(10);
    expect(inn2.wickets).toBeGreaterThanOrEqual(0);
    expect(inn2.wickets).toBeLessThanOrEqual(10);
  });

  it("second innings overs are 0-20", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.innings[1].overs).toBeGreaterThanOrEqual(1);
    expect(result.innings[1].overs).toBeLessThanOrEqual(20);
  });

  it("a winner is always determined", () => {
    // Simulate several matches to increase chance of all outcomes
    for (let i = 0; i < 5; i++) {
      const home = buildTeam(0);
      const away = buildTeam(1);
      const result = simulateMatch(home, away);
      expect(result.winnerId).toBeTruthy();
      expect([home.id, away.id]).toContain(result.winnerId);
    }
  });

  it("batting scorecard has entries for players who batted", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    for (const inn of result.innings) {
      // batterStats initializes all XI players; at least 2 should have faced balls
      const batted = [...inn.batterStats.values()].filter(s => s.balls > 0 || s.isOut);
      expect(batted.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("bowling scorecard has bowlers", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    for (const inn of result.innings) {
      expect(inn.bowlerStats.size).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("DetailedMatchResult", () => {
  it("is populated when simulateMatch is called", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.detailed).toBeDefined();
    expect(result.detailed!.matchId).toBe(result.id);
  });

  it("has ball log with entries", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.detailed!.ballLog.length).toBeGreaterThan(0);
    for (const ball of result.detailed!.ballLog) {
      expect(ball.batterName).toBeTruthy();
      expect(ball.bowlerName).toBeTruthy();
      expect(ball.commentary).toBeTruthy();
      expect([1, 2]).toContain(ball.innings);
    }
  });

  it("innings1 scorecard has batters and bowlers", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    const inn1 = result.detailed!.innings1;
    expect(inn1.batters.length).toBeGreaterThan(0);
    expect(inn1.bowlers.length).toBeGreaterThan(0);
    expect(inn1.totalRuns).toBeGreaterThan(0);

    for (const batter of inn1.batters) {
      expect(batter.playerName).toBeTruthy();
      expect(batter.howOut).toBeTruthy();
      expect(batter.strikeRate).toBeGreaterThanOrEqual(0);
    }

    for (const bowler of inn1.bowlers) {
      expect(bowler.playerName).toBeTruthy();
      expect(bowler.overs).toBeTruthy();
      expect(bowler.economy).toBeGreaterThanOrEqual(0);
    }
  });

  it("innings2 scorecard is populated", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    const inn2 = result.detailed!.innings2;
    expect(inn2.batters.length).toBeGreaterThan(0);
    expect(inn2.bowlers.length).toBeGreaterThan(0);
  });

  it("man of the match is populated with name and reason", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.detailed!.manOfTheMatch.playerId).toBeTruthy();
    expect(result.detailed!.manOfTheMatch.playerName).toBeTruthy();
  });

  it("venue is set from home team city", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.detailed!.venue).toBe(home.config.city);
  });

  it("result string describes the winner", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(result.detailed!.result).toMatch(/won by/);
  });
});

describe("Match injuries", () => {
  it("injuries array is present on match result", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const result = simulateMatch(home, away);

    expect(Array.isArray(result.injuries)).toBe(true);
  });

  it("injuries have valid structure when present", () => {
    // Run multiple matches to increase chance of an injury occurring
    for (let i = 0; i < 20; i++) {
      const home = buildTeam(0);
      const away = buildTeam(1);
      const result = simulateMatch(home, away);

      for (const injury of result.injuries) {
        expect(injury.playerId).toBeTruthy();
        expect(injury.playerName).toBeTruthy();
        expect(injury.teamId).toBeTruthy();
        expect([home.id, away.id]).toContain(injury.teamId);
        expect(injury.injury.isInjured).toBe(true);
        expect(injury.injury.matchesRemaining).toBeGreaterThan(0);
        expect(["minor", "moderate", "severe"]).toContain(injury.injury.severity);
      }
    }
  });

  it("no injuries when injuriesEnabled is false", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);
    const rulesNoInjury = { ...RULE_PRESETS.modern, injuriesEnabled: false };

    for (let i = 0; i < 10; i++) {
      const result = simulateMatch(home, away, rulesNoInjury);
      expect(result.injuries).toHaveLength(0);
    }
  });

  it("player stats accumulate correctly across matches", () => {
    const home = buildTeam(0);
    const away = buildTeam(1);

    simulateMatch(home, away);
    const run1 = home.roster.reduce((s, p) => s + p.stats.runs, 0);
    simulateMatch(home, away);
    const run2 = home.roster.reduce((s, p) => s + p.stats.runs, 0);

    expect(run2).toBeGreaterThanOrEqual(run1);
  });
});
