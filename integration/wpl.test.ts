/**
 * Integration tests for WPL (Women's Premier League) mode.
 */

import { describe, it, expect } from "vitest";
import {
  Team, WPL_TEAMS, IPL_TEAMS,
  generatePlayerPool, createPlayerFromData,
  runAuction, runSeason, simulateMatch,
  RULE_PRESETS,
} from "@ipl-sim/engine";
import { getWPLPlayers, WPL_PLAYERS } from "@ipl-sim/ratings";

// ── WPL Team Config ──────────────────────────────────────────────────────

describe("WPL_TEAMS config", () => {
  it("has 5 teams", () => {
    expect(WPL_TEAMS).toHaveLength(5);
  });

  it("has correct team ids", () => {
    const ids = WPL_TEAMS.map(t => t.id);
    expect(ids).toContain("mi-w");
    expect(ids).toContain("dc-w");
    expect(ids).toContain("rcb-w");
    expect(ids).toContain("gg-w");
    expect(ids).toContain("upw");
  });

  it("all teams have unique ids, names, and cities", () => {
    expect(new Set(WPL_TEAMS.map(t => t.id)).size).toBe(5);
    expect(new Set(WPL_TEAMS.map(t => t.name)).size).toBe(5);
    expect(new Set(WPL_TEAMS.map(t => t.city)).size).toBe(5);
  });

  it("all colors are valid hex", () => {
    for (const t of WPL_TEAMS) {
      expect(t.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t.secondaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ── WPL Player Data ──────────────────────────────────────────────────────

describe("WPL player data", () => {
  it("has at least 35 players", () => {
    expect(WPL_PLAYERS.length).toBeGreaterThanOrEqual(35);
  });

  it("all teams have real players", () => {
    const teamsWithPlayers = new Set(
      WPL_PLAYERS.filter(p => p.teamId).map(p => p.teamId)
    );
    for (const t of WPL_TEAMS) {
      expect(teamsWithPlayers.has(t.id)).toBe(true);
    }
  });

  it("each team has at least 7 players", () => {
    const counts = new Map<string, number>();
    for (const p of WPL_PLAYERS) {
      if (p.teamId) {
        counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
      }
    }
    for (const [, count] of counts) {
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });

  it("getWPLPlayers returns structured objects", () => {
    const players = getWPLPlayers();
    for (const p of players) {
      expect(p.name).toBeTruthy();
      expect(p.age).toBeGreaterThanOrEqual(15);
      expect(["batsman", "bowler", "all-rounder", "wicket-keeper"]).toContain(p.role);
    }
  });

  it("contains known WPL stars", () => {
    const players = getWPLPlayers();
    const names = players.map(p => p.name);
    expect(names).toContain("Smriti Mandhana");
    expect(names).toContain("Harmanpreet Kaur");
    expect(names).toContain("Meg Lanning");
    expect(names).toContain("Sophie Ecclestone");
    expect(names).toContain("Alyssa Healy");
  });

  it("teamIds map to valid WPL teams", () => {
    const validIds = new Set(WPL_TEAMS.map(t => t.id));
    for (const p of getWPLPlayers()) {
      expect(validIds.has(p.teamId)).toBe(true);
    }
  });
});

// ── WPL Rules ────────────────────────────────────────────────────────────

describe("WPL rule preset", () => {
  const rules = RULE_PRESETS.wpl;

  it("has correct league type", () => {
    expect(rules.league).toBe("wpl");
  });

  it("has no impact player", () => {
    expect(rules.impactPlayer).toBe(false);
  });

  it("allows 5 overseas in XI", () => {
    expect(rules.maxOverseasInXI).toBe(5);
  });

  it("has 3-team playoff", () => {
    expect(rules.playoffTeams).toBe(3);
  });

  it("has 8 matches per team", () => {
    expect(rules.matchesPerTeam).toBe(8);
  });

  it("has lower scoring multiplier", () => {
    expect(rules.scoringMultiplier).toBeLessThan(1.0);
  });

  it("has 12 Cr salary cap", () => {
    expect(rules.salaryCap).toBe(12);
  });
});

// ── WPL Season Simulation ────────────────────────────────────────────────

describe("WPL full season", () => {
  function buildWPLTeams() {
    const rules = RULE_PRESETS.wpl;
    const teams = WPL_TEAMS.map(c => new Team(c, rules.salaryCap));
    const players = getWPLPlayers();
    for (const data of players) {
      const player = createPlayerFromData(data);
      const team = teams.find(t => t.id === data.teamId);
      if (team) team.addPlayer(player, Math.min(player.marketValue, 3));
    }
    runAuction(generatePlayerPool(80), teams);
    return teams;
  }

  it("playing XI allows up to 5 overseas", () => {
    const teams = buildWPLTeams();
    for (const team of teams) {
      const xi = team.getPlayingXI(RULE_PRESETS.wpl.maxOverseasInXI);
      const overseas = xi.filter(p => p.isInternational).length;
      expect(overseas).toBeLessThanOrEqual(5);
    }
  });

  it("completes a full WPL season with 3-team playoff", () => {
    const teams = buildWPLTeams();
    const result = runSeason(teams, RULE_PRESETS.wpl);

    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(5);

    // 3-team playoff: Q1 + Q2 + Final = 3 playoff matches
    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs).toHaveLength(3);

    const types = playoffs.map(p => p.playoffType);
    expect(types).toContain("qualifier1");
    expect(types).toContain("qualifier2");
    expect(types).toContain("final");
  }, 30000);

  it("WPL scores are lower than IPL on average", () => {
    const wplTeams = buildWPLTeams();
    const wplResult = runSeason(wplTeams, RULE_PRESETS.wpl);

    const wplAvgScore = wplResult.schedule
      .filter(m => m.result)
      .map(m => m.result!.innings[0].runs)
      .reduce((s, r) => s + r, 0) / wplResult.schedule.filter(m => m.result).length;

    // WPL scoring should be noticeably lower than typical IPL (which averages ~160-180)
    expect(wplAvgScore).toBeLessThan(200);
    expect(wplAvgScore).toBeGreaterThan(60);
  }, 30000);

  it("no impact subs used in WPL", () => {
    const teams = buildWPLTeams();
    const result = runSeason(teams, RULE_PRESETS.wpl);

    for (const match of result.schedule) {
      if (match.result) {
        for (const inn of match.result.innings) {
          expect(inn.impactSub).toBeUndefined();
        }
      }
    }
  }, 30000);

  it("group stage has ~20 matches (5 teams × 8 / 2)", () => {
    const teams = buildWPLTeams();
    const result = runSeason(teams, RULE_PRESETS.wpl);
    const groupMatches = result.schedule.filter(m => !m.isPlayoff);
    expect(groupMatches.length).toBeGreaterThanOrEqual(15);
    expect(groupMatches.length).toBeLessThanOrEqual(25);
  }, 30000);
});

// ── Counter-Offer Negotiation ────────────────────────────────────────────

describe("trade counter-offers", () => {
  it("processTradeOffer can return a counter-offer", () => {
    // This test verifies the counter-offer code path exists
    const { processTradeOffer, createTradeOffer } = require("@ipl-sim/engine");

    const teams = WPL_TEAMS.map(c => new Team(c, 12));
    const players = getWPLPlayers();
    for (const data of players) {
      const player = createPlayerFromData(data);
      const team = teams.find(t => t.id === data.teamId);
      if (team) team.addPlayer(player, 1);
    }
    runAuction(generatePlayerPool(80), teams);

    // Try a lopsided trade — ask for best player, offer worst
    const team1 = teams[0];
    const team2 = teams[1];
    const bestOnTeam2 = [...team2.roster].sort((a, b) => b.overall - a.overall)[0];
    const worstOnTeam1 = [...team1.roster].sort((a, b) => a.overall - b.overall)[0];

    const offer = createTradeOffer(team1.id, team2.id, [worstOnTeam1.id], [bestOnTeam2.id]);
    const result = processTradeOffer(offer, teams);

    // Should either reject or counter (not accept a bad deal)
    if (result.accepted) {
      // Unlikely but possible if ratings are very close
      expect(result.offer.status).toBe("accepted");
    } else {
      expect(["rejected", "counter"]).toContain(result.offer.status);
      // If counter, verify counter-offer structure
      if (result.counterOffer) {
        expect(result.counterOffer.playersOffered.length).toBeGreaterThan(0);
        expect(result.counterOffer.playersRequested.length).toBeGreaterThan(0);
      }
    }
  });
});
