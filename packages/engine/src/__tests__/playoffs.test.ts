import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS, WPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { runSeason, generateIPLSchedule, getStandings } from "../schedule.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";

// ── Test Helpers ─────────────────────────────────────────────────────────

function makePlayer(id: string, role: "batsman" | "bowler" | "all-rounder", isWicketKeeper = false): Player {
  const batHeavy = role === "batsman";
  const bowlHeavy = role === "bowler";
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role,
    ratings: {
      battingIQ: batHeavy ? 65 : bowlHeavy ? 25 : 50,
      timing: batHeavy ? 63 : bowlHeavy ? 25 : 48,
      power: batHeavy ? 60 : bowlHeavy ? 20 : 48,
      running: batHeavy ? 55 : 40,
      wicketTaking: bowlHeavy ? 65 : batHeavy ? 20 : 50,
      economy: bowlHeavy ? 63 : batHeavy ? 20 : 50,
      accuracy: bowlHeavy ? 60 : batHeavy ? 20 : 48,
      clutch: 50,
    },
    isInternational: false,
    isWicketKeeper,
    injured: false,
    injuryGamesLeft: 0,
  });
}

function fillTeam(team: Team, teamIdx: number): void {
  let id = teamIdx * 100;
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bat_${++id}`, "batsman"), 3);
  team.addPlayer(makePlayer(`wk_${++id}`, "batsman", true), 3);
  for (let i = 0; i < 3; i++) team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder"), 3);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bow_${++id}`, "bowler"), 3);
}

function buildTeams(configs: typeof IPL_TEAMS): Team[] {
  return configs.map((config, i) => {
    const team = new Team(config);
    fillTeam(team, i);
    return team;
  });
}

function makeCustomRules(overrides: Partial<RuleSet>): RuleSet {
  return { ...RULE_PRESETS.modern, ...overrides };
}

// ── Schedule Generation ──────────────────────────────────────────────────

describe("Schedule generation", () => {
  it("generates correct number of group matches for 10 teams x 14 matches", () => {
    const teams = buildTeams(IPL_TEAMS);
    const schedule = generateIPLSchedule(teams, 14);
    expect(schedule.length).toBe(70); // 10 * 14 / 2
    expect(schedule.every(m => m.type === "group")).toBe(true);
  });

  it("generates correct number of group matches for 5 teams x 8 matches", () => {
    const teams = buildTeams(WPL_TEAMS);
    const schedule = generateIPLSchedule(teams, 8);
    expect(schedule.length).toBe(20); // 5 * 8 / 2
  });

  it("handles small team counts (2 teams)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 2));
    // Only 2 possible matchups (home/away), so 4 matches/team can't be fulfilled
    const schedule = generateIPLSchedule(teams, 4);
    expect(schedule.length).toBeLessThanOrEqual(4);
    expect(schedule.length).toBeGreaterThanOrEqual(2);
  });

  it("handles 3 teams x 4 matches each", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 3));
    const schedule = generateIPLSchedule(teams, 4);
    expect(schedule.length).toBe(6); // 3 * 4 / 2
  });

  it("handles small matches per team (2 matches each)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const schedule = generateIPLSchedule(teams, 2);
    expect(schedule.length).toBe(4); // 4 * 2 / 2
  });
});

// ── Eliminator Format Playoffs ──────────────────────────────────────────

describe("Eliminator playoff format", () => {
  it("runs 4-team eliminator playoffs (Q1, Elim, Q2, Final)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 6,
      playoffTeams: 4,
      playoffFormat: "eliminator",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(4); // Q1 + Elim + Q2 + Final

    const types = playoffMatches.map(m => m.type);
    expect(types).toContain("qualifier1");
    expect(types).toContain("eliminator");
    expect(types).toContain("qualifier2");
    expect(types).toContain("final");

    // Champion must be a valid team
    expect(teams.some(t => t.id === result.champion)).toBe(true);
  });

  it("runs 3-team eliminator playoffs (Q1, Elim, Final)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 3));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 3,
      playoffFormat: "eliminator",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(3); // Q1 + Elim + Final

    const types = playoffMatches.map(m => m.type);
    expect(types).toContain("qualifier1");
    expect(types).toContain("qualifier2");
    expect(types).toContain("final");
  });

  it("runs 2-team eliminator (just a final)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 3));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 2,
      playoffFormat: "eliminator",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(1);
    expect(playoffMatches[0].type).toBe("final");
  });

  it("runs 5-team eliminator (eliminators among bottom 3, then Q2, Final)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 5));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 5,
      playoffFormat: "eliminator",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    // Q1 + at least 1 eliminator round for bottom 3 + Q2 + Final = 4-5 matches
    expect(playoffMatches.length).toBeGreaterThanOrEqual(4);
    expect(playoffMatches.some(m => m.type === "qualifier1")).toBe(true);
    expect(playoffMatches.some(m => m.type === "final")).toBe(true);
    expect(teams.some(t => t.id === result.champion)).toBe(true);
  });
});

// ── Simple Bracket Format ───────────────────────────────────────────────

describe("Simple bracket playoff format", () => {
  it("runs 4-team simple bracket (Semi1, Semi2, Final)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 6,
      playoffTeams: 4,
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(3); // Semi1 + Semi2 + Final
    expect(playoffMatches.some(m => m.type === "final")).toBe(true);
    expect(teams.some(t => t.id === result.champion)).toBe(true);
  });

  it("runs 3-team simple bracket (Semi + Final, top seed gets bye)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 3));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 3,
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(2); // Semi + Final (top seed bye)
    expect(playoffMatches.some(m => m.type === "final")).toBe(true);
  });

  it("runs 2-team simple bracket (just a Final)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 3));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 2,
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(1);
    expect(playoffMatches[0].type).toBe("final");
  });

  it("runs 8-team simple bracket (3 rounds)", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 8));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 8,
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(7); // 4 QFs + 2 SFs + 1 Final
    expect(playoffMatches.some(m => m.type === "final")).toBe(true);
    expect(teams.some(t => t.id === result.champion)).toBe(true);
  });
});

// ── No Playoffs ─────────────────────────────────────────────────────────

describe("No playoffs format", () => {
  it("crowns table-topper as champion with no playoff matches", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 6,
      playoffTeams: 0,
      playoffFormat: "none",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(0);

    // Champion should be the top of standings
    expect(result.champion).toBe(result.standings[0].teamId);
  });

  it("no playoffs even if playoffTeams > 0 but format is none", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 4,
      playoffFormat: "none",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    const playoffMatches = result.schedule.filter(m => m.isPlayoff);
    expect(playoffMatches.length).toBe(0);
    expect(result.champion).toBe(result.standings[0].teamId);
  });
});

// ── Season Result Integrity ─────────────────────────────────────────────

describe("Season result integrity", () => {
  it("all matches have results after runSeason", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 4,
      playoffFormat: "eliminator",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);

    for (const match of result.schedule) {
      expect(match.result).toBeDefined();
      expect(match.result!.winnerId).toBeTruthy();
    }
  });

  it("champion is always a valid team ID", () => {
    for (const format of ["eliminator", "simple", "none"] as const) {
      const teams = buildTeams(IPL_TEAMS.slice(0, 4));
      const rules = makeCustomRules({
        teamIds: teams.map(t => t.id),
        matchesPerTeam: 4,
        playoffTeams: format === "none" ? 0 : 4,
        playoffFormat: format,
        injuriesEnabled: false,
      });
      const result = runSeason(teams, rules);
      expect(teams.some(t => t.id === result.champion)).toBe(true);
    }
  });

  it("standings have correct number of entries", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 6));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 4,
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);
    expect(result.standings.length).toBe(6);
  });

  it("orange and purple caps are awarded", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 2,
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);
    expect(result.orangeCap.playerId).toBeTruthy();
    expect(result.orangeCap.runs).toBeGreaterThan(0);
    expect(result.purpleCap.playerId).toBeTruthy();
    expect(result.purpleCap.wickets).toBeGreaterThan(0);
  });
});

// ── Rules Presets ────────────────────────────────────────────────────────

describe("Rule presets", () => {
  it("all presets have required fields", () => {
    for (const [name, preset] of Object.entries(RULE_PRESETS)) {
      expect(preset.name).toBeTruthy();
      expect(preset.league).toBeTruthy();
      expect(preset.teamIds.length).toBeGreaterThan(0);
      expect(preset.matchesPerTeam).toBeGreaterThan(0);
      expect(preset.playoffTeams).toBeGreaterThanOrEqual(0);
      expect(preset.playoffFormat).toBeTruthy();
      expect(["eliminator", "simple", "none"]).toContain(preset.playoffFormat);
      expect(preset.salaryCap).toBeGreaterThan(0);
      expect(preset.maxOverseasInXI).toBeGreaterThan(0);
      expect(preset.maxSquadSize).toBeGreaterThan(0);
    }
  });

  it("classic preset runs a full season", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 8));
    const rules = { ...RULE_PRESETS.classic, matchesPerTeam: 4, injuriesEnabled: false };
    const result = runSeason(teams, rules);
    expect(result.champion).toBeTruthy();
  });

  it("modern preset runs a full season", () => {
    const teams = buildTeams(IPL_TEAMS);
    const rules = { ...RULE_PRESETS.modern, matchesPerTeam: 4, injuriesEnabled: false };
    const result = runSeason(teams, rules);
    expect(result.champion).toBeTruthy();
  });

  it("WPL preset runs a full season", () => {
    const teams = buildTeams(WPL_TEAMS);
    const rules = { ...RULE_PRESETS.wpl, matchesPerTeam: 4, injuriesEnabled: false };
    const result = runSeason(teams, rules);
    expect(result.champion).toBeTruthy();
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("2 teams with no playoffs works", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 2));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 0,
      playoffFormat: "none",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);
    expect(result.champion).toBeTruthy();
    expect(result.schedule.filter(m => m.isPlayoff).length).toBe(0);
  });

  it("playoffTeams exceeding team count gets clamped", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 3));
    const rules = makeCustomRules({
      teamIds: teams.map(t => t.id),
      matchesPerTeam: 4,
      playoffTeams: 10, // more than 3 teams
      playoffFormat: "simple",
      injuriesEnabled: false,
    });
    const result = runSeason(teams, rules);
    // Should still work — clamped to 3
    expect(result.champion).toBeTruthy();
  });

  it("backward compatibility: rules without playoffFormat default to eliminator", () => {
    const teams = buildTeams(IPL_TEAMS.slice(0, 4));
    const rules = { ...RULE_PRESETS.modern, matchesPerTeam: 4, injuriesEnabled: false };
    // playoffFormat is already "eliminator" in presets, but test the fallback
    delete (rules as any).playoffFormat;
    const result = runSeason(teams, rules);
    expect(result.champion).toBeTruthy();
    // Should have Q1, Elim, Q2, Final (eliminator format)
    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs.some(m => m.type === "qualifier1")).toBe(true);
  });
});
