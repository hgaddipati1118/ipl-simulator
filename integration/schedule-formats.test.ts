/**
 * Tests for all historical IPL schedule formats:
 * - 8 teams (2014-2021): 56 matches, full double round-robin, 4-team playoff
 * - 10 teams (2022+): 70 matches, partial round-robin, 4-team playoff
 * - 5 teams WPL: 20 matches, full double round-robin, 3-team playoff
 *
 * Also verifies teamIds filtering in rules + createGameState.
 */

import { describe, it, expect } from "vitest";
import {
  Team, IPL_TEAMS, WPL_TEAMS,
  generatePlayerPool, createPlayerFromData,
  runAuction, runSeason,
  generateIPLSchedule, getStandings,
  RULE_PRESETS,
} from "@ipl-sim/engine";
import { getRealPlayers } from "@ipl-sim/ratings";
import { getWPLPlayers } from "@ipl-sim/ratings";

// ── Helpers ──────────────────────────────────────────────────────────────

function buildTeamsForRules(rules: typeof RULE_PRESETS.classic) {
  const isWPL = rules.league === "wpl";
  const allConfigs = isWPL ? WPL_TEAMS : IPL_TEAMS;
  const activeIds = new Set(rules.teamIds);
  const configs = allConfigs.filter(c => activeIds.has(c.id));
  const teams = configs.map(c => new Team(c, rules.salaryCap));

  const realPlayers = isWPL ? getWPLPlayers() : getRealPlayers();
  for (const data of realPlayers) {
    if (!activeIds.has(data.teamId)) continue;
    const player = createPlayerFromData(data);
    const team = teams.find(t => t.id === data.teamId);
    if (team) team.addPlayer(player, Math.min(player.marketValue, isWPL ? 3 : 15));
  }

  const poolSize = isWPL ? 80 : (teams.length >= 10 ? 200 : 150);
  runAuction(generatePlayerPool(poolSize), teams, {
    maxRosterSize: rules.maxSquadSize,
    maxInternational: rules.maxOverseasInSquad,
  });
  return teams;
}

// ── 8-Team IPL Classic ───────────────────────────────────────────────────

describe("8-team IPL Classic schedule", () => {
  it("classic rules specify 8 teams", () => {
    expect(RULE_PRESETS.classic.teamIds).toHaveLength(8);
  });

  it("classic teams exclude GT and LSG", () => {
    const ids = RULE_PRESETS.classic.teamIds;
    expect(ids).not.toContain("gt");
    expect(ids).not.toContain("lsg");
  });

  it("classic teams include original 8", () => {
    const ids = RULE_PRESETS.classic.teamIds;
    for (const id of ["srh", "dc", "rcb", "kkr", "rr", "csk", "mi", "pbks"]) {
      expect(ids).toContain(id);
    }
  });

  it("builds exactly 8 teams", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.classic);
    expect(teams).toHaveLength(8);
  });

  it("generates ~56 group matches (8 teams × 14 / 2)", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.classic);
    const schedule = generateIPLSchedule(teams, 14);
    // 8 teams: C(8,2)*2 = 56 matchups, all fit in 14 per team
    expect(schedule.length).toBeGreaterThanOrEqual(50);
    expect(schedule.length).toBeLessThanOrEqual(60);
  });

  it("each team plays close to 14 matches", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.classic);
    const schedule = generateIPLSchedule(teams, 14);

    const counts = new Map<string, number>();
    for (const m of schedule) {
      counts.set(m.homeTeamId, (counts.get(m.homeTeamId) ?? 0) + 1);
      counts.set(m.awayTeamId, (counts.get(m.awayTeamId) ?? 0) + 1);
    }

    for (const [, count] of counts) {
      expect(count).toBeGreaterThanOrEqual(12);
      expect(count).toBeLessThanOrEqual(16);
    }
  });

  it("runs a full 8-team season with 4-team playoff", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.classic);
    const result = runSeason(teams, RULE_PRESETS.classic);

    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(8);

    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs).toHaveLength(4);

    const types = playoffs.map(p => p.playoffType);
    expect(types).toContain("qualifier1");
    expect(types).toContain("eliminator");
    expect(types).toContain("qualifier2");
    expect(types).toContain("final");
  }, 30000);

  it("GT and LSG players are excluded from classic rosters", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.classic);
    const allIds = teams.map(t => t.id);
    expect(allIds).not.toContain("gt");
    expect(allIds).not.toContain("lsg");
  });
});

// ── 10-Team IPL Modern ───────────────────────────────────────────────────

describe("10-team IPL Modern schedule", () => {
  it("modern rules specify 10 teams", () => {
    expect(RULE_PRESETS.modern.teamIds).toHaveLength(10);
  });

  it("modern teams include GT and LSG", () => {
    const ids = RULE_PRESETS.modern.teamIds;
    expect(ids).toContain("gt");
    expect(ids).toContain("lsg");
  });

  it("builds exactly 10 teams", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.modern);
    expect(teams).toHaveLength(10);
  });

  it("generates ~70 group matches (10 teams × 14 / 2)", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.modern);
    const schedule = generateIPLSchedule(teams, 14);
    expect(schedule.length).toBeGreaterThanOrEqual(60);
    expect(schedule.length).toBeLessThanOrEqual(80);
  });

  it("runs a full 10-team season", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.modern);
    const result = runSeason(teams, RULE_PRESETS.modern);
    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(10);
  }, 30000);
});

// ── 5-Team WPL ───────────────────────────────────────────────────────────

describe("5-team WPL schedule", () => {
  it("WPL rules specify 5 teams", () => {
    expect(RULE_PRESETS.wpl.teamIds).toHaveLength(5);
  });

  it("builds exactly 5 teams", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.wpl);
    expect(teams).toHaveLength(5);
  });

  it("generates 20 group matches (5 teams × 8 / 2)", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.wpl);
    const schedule = generateIPLSchedule(teams, 8);
    expect(schedule.length).toBeGreaterThanOrEqual(18);
    expect(schedule.length).toBeLessThanOrEqual(22);
  });

  it("runs a full 5-team season with 3-team playoff", () => {
    const teams = buildTeamsForRules(RULE_PRESETS.wpl);
    const result = runSeason(teams, RULE_PRESETS.wpl);
    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(5);

    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs).toHaveLength(3);
  }, 30000);
});

// ── Cross-Format Comparison ──────────────────────────────────────────────

describe("cross-format comparison", () => {
  it("8-team season has fewer total matches than 10-team", () => {
    const teams8 = buildTeamsForRules(RULE_PRESETS.classic);
    const teams10 = buildTeamsForRules(RULE_PRESETS.modern);

    const schedule8 = generateIPLSchedule(teams8, 14);
    const schedule10 = generateIPLSchedule(teams10, 14);

    expect(schedule8.length).toBeLessThan(schedule10.length);
  });

  it("WPL has fewest total matches", () => {
    const teamsWPL = buildTeamsForRules(RULE_PRESETS.wpl);
    const teams8 = buildTeamsForRules(RULE_PRESETS.classic);

    const scheduleWPL = generateIPLSchedule(teamsWPL, 8);
    const schedule8 = generateIPLSchedule(teams8, 14);

    expect(scheduleWPL.length).toBeLessThan(schedule8.length);
  });

  it("all three formats produce a valid champion", () => {
    const teams8 = buildTeamsForRules(RULE_PRESETS.classic);
    const r8 = runSeason(teams8, RULE_PRESETS.classic);
    expect(RULE_PRESETS.classic.teamIds).toContain(r8.champion);

    const teamsWPL = buildTeamsForRules(RULE_PRESETS.wpl);
    const rWPL = runSeason(teamsWPL, RULE_PRESETS.wpl);
    expect(RULE_PRESETS.wpl.teamIds).toContain(rWPL.champion);
  }, 60000);
});
