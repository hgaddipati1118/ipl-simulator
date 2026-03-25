/**
 * Integration tests for IPL rule sets and Impact Player feature.
 */

import { describe, it, expect } from "vitest";
import {
  Team, IPL_TEAMS, Player,
  generatePlayerPool, createPlayerFromData,
  runAuction, runSeason, simulateMatch,
  RULE_PRESETS, DEFAULT_RULES,
  type RuleSet,
} from "@ipl-sim/engine";
import { getRealPlayers } from "@ipl-sim/ratings";

// ── Helpers ──────────────────────────────────────────────────────────────

function buildTeamsWithRules(rules: RuleSet): Team[] {
  const teams = IPL_TEAMS.map(c => new Team(c, rules.salaryCap));
  const realPlayers = getRealPlayers();
  for (const data of realPlayers) {
    const player = createPlayerFromData(data);
    const team = teams.find(t => t.id === data.teamId);
    if (team) team.addPlayer(player, Math.min(player.marketValue, 15));
  }
  const pool = generatePlayerPool(200);
  runAuction(pool, teams);
  return teams;
}

// ── Rule Presets ─────────────────────────────────────────────────────────

describe("RULE_PRESETS", () => {
  it("classic preset has impact player off", () => {
    expect(RULE_PRESETS.classic.impactPlayer).toBe(false);
    expect(RULE_PRESETS.classic.salaryCap).toBe(90);
    expect(RULE_PRESETS.classic.superOverTieBreaker).toBe("boundary-count");
    expect(RULE_PRESETS.classic.maxBouncersPerOver).toBe(1);
  });

  it("modern preset has impact player on", () => {
    expect(RULE_PRESETS.modern.impactPlayer).toBe(true);
    expect(RULE_PRESETS.modern.salaryCap).toBe(120);
    expect(RULE_PRESETS.modern.superOverTieBreaker).toBe("repeated-super-over");
    expect(RULE_PRESETS.modern.maxBouncersPerOver).toBe(2);
  });

  it("modern2026 preset has correct values", () => {
    expect(RULE_PRESETS.modern2026.impactPlayer).toBe(true);
    expect(RULE_PRESETS.modern2026.salaryCap).toBe(125);
    expect(RULE_PRESETS.modern2026.matchesPerTeam).toBe(16);
    expect(RULE_PRESETS.modern2026.superOverTieBreaker).toBe("repeated-super-over");
    expect(RULE_PRESETS.modern2026.maxBouncersPerOver).toBe(2);
    expect(RULE_PRESETS.modern2026.name).toBe("IPL 2026+");
  });

  it("DEFAULT_RULES equals modern2026", () => {
    expect(DEFAULT_RULES).toEqual(RULE_PRESETS.modern2026);
  });
});

// ── Salary Cap ───────────────────────────────────────────────────────────

describe("salary cap varies by rule set", () => {
  it("classic teams have 90 Cr salary cap", () => {
    const teams = IPL_TEAMS.map(c => new Team(c, RULE_PRESETS.classic.salaryCap));
    for (const t of teams) {
      expect(t.salaryCap).toBe(90);
      expect(t.remainingBudget).toBe(90);
    }
  });

  it("modern teams have 120 Cr salary cap", () => {
    const teams = IPL_TEAMS.map(c => new Team(c, RULE_PRESETS.modern.salaryCap));
    for (const t of teams) {
      expect(t.salaryCap).toBe(120);
    }
  });
});

// ── Impact Player Subs ───────────────────────────────────────────────────

describe("Team.getImpactSubs", () => {
  it("returns non-XI players sorted by overall", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const team = teams[0];
    const xi = team.getPlayingXI();
    const subs = team.getImpactSubs(xi);

    // Subs should not overlap with XI
    const xiIds = new Set(xi.map(p => p.id));
    for (const sub of subs) {
      expect(xiIds.has(sub.id)).toBe(false);
    }

    // Subs should be sorted by overall (descending)
    for (let i = 1; i < subs.length; i++) {
      expect(subs[i - 1].overall).toBeGreaterThanOrEqual(subs[i].overall);
    }
  });

  it("returns up to 4 subs", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const team = teams[0];
    const xi = team.getPlayingXI();
    const subs = team.getImpactSubs(xi);
    expect(subs.length).toBeLessThanOrEqual(4);
    expect(subs.length).toBeGreaterThan(0);
  });

  it("excludes injured players", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const team = teams[0];
    const xi = team.getPlayingXI();

    // Injure all non-XI players
    for (const p of team.roster) {
      if (!xi.some(x => x.id === p.id)) {
        p.injured = true;
        p.injuryGamesLeft = 3;
      }
    }

    const subs = team.getImpactSubs(xi);
    expect(subs).toHaveLength(0);
  });
});

// ── Match Simulation with Rules ──────────────────────────────────────────

describe("simulateMatch with classic rules", () => {
  it("produces valid results without impact player", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.classic);
    const result = simulateMatch(teams[0], teams[1], RULE_PRESETS.classic);

    expect(result.winnerId).toBeTruthy();
    expect(result.innings).toHaveLength(2);
    // No impact subs should be used
    for (const inn of result.innings) {
      expect(inn.impactSub).toBeUndefined();
    }
  });
});

describe("simulateMatch with modern rules (impact player)", () => {
  it("produces valid results", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const result = simulateMatch(teams[0], teams[1], RULE_PRESETS.modern);

    expect(result.winnerId).toBeTruthy();
    expect(result.innings).toHaveLength(2);
    for (const inn of result.innings) {
      expect(inn.runs).toBeGreaterThan(0);
      expect(inn.wickets).toBeLessThanOrEqual(10);
    }
  });

  it("impact subs are used in at least some matches", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    let impactUsed = 0;

    for (let i = 0; i < 20; i++) {
      // Reset team records between matches
      teams[0].wins = 0; teams[0].losses = 0;
      teams[1].wins = 0; teams[1].losses = 0;
      teams[0].runsFor = 0; teams[0].ballsFacedFor = 0;
      teams[0].runsAgainst = 0; teams[0].ballsFacedAgainst = 0;
      teams[1].runsFor = 0; teams[1].ballsFacedFor = 0;
      teams[1].runsAgainst = 0; teams[1].ballsFacedAgainst = 0;

      const result = simulateMatch(teams[0], teams[1], RULE_PRESETS.modern);
      for (const inn of result.innings) {
        if (inn.impactSub) impactUsed++;
      }
    }

    // With collapse/death-over triggers, impact subs should fire in at least some innings
    expect(impactUsed).toBeGreaterThan(0);
  });

  it("impact sub player IDs are valid roster members", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const allIds = new Set([...teams[0].roster, ...teams[1].roster].map(p => p.id));

    for (let i = 0; i < 10; i++) {
      teams[0].wins = 0; teams[0].losses = 0;
      teams[1].wins = 0; teams[1].losses = 0;
      teams[0].runsFor = 0; teams[0].ballsFacedFor = 0;
      teams[0].runsAgainst = 0; teams[0].ballsFacedAgainst = 0;
      teams[1].runsFor = 0; teams[1].ballsFacedFor = 0;
      teams[1].runsAgainst = 0; teams[1].ballsFacedAgainst = 0;

      const result = simulateMatch(teams[0], teams[1], RULE_PRESETS.modern);
      for (const inn of result.innings) {
        if (inn.impactSub) {
          expect(allIds.has(inn.impactSub.subIn)).toBe(true);
          expect(allIds.has(inn.impactSub.subOut)).toBe(true);
          expect(inn.impactSub.subIn).not.toBe(inn.impactSub.subOut);
          expect(inn.impactSub.overUsed).toBeGreaterThanOrEqual(0);
          expect(inn.impactSub.overUsed).toBeLessThanOrEqual(19);
          expect(["batting", "bowling"]).toContain(inn.impactSub.side);
        }
      }
    }
  });
});

// ── Full Season with Each Rule Set ───────────────────────────────────────

describe("full season with classic rules", () => {
  it("completes a season with 90 Cr cap and no impact player", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.classic);
    const result = runSeason(teams, RULE_PRESETS.classic);

    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(10);
    expect(result.orangeCap.runs).toBeGreaterThan(0);
    expect(result.orangeCap.strikeRate).toBeGreaterThan(0);
    expect(result.purpleCap.wickets).toBeGreaterThan(0);
    expect(result.purpleCap.economy).toBeLessThan(99);
    expect(result.mvp.name).toBeTruthy();
    expect(result.mvp.points).toBeGreaterThan(0);
  }, 30000);
});

describe("full season with modern rules", () => {
  it("completes a season with 120 Cr cap and impact player", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const result = runSeason(teams, RULE_PRESETS.modern);

    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(10);
    expect(result.orangeCap.runs).toBeGreaterThan(0);
    expect(result.orangeCap.strikeRate).toBeGreaterThan(0);
    expect(result.purpleCap.wickets).toBeGreaterThan(0);
    expect(result.purpleCap.economy).toBeLessThan(99);
    expect(result.mvp.name).toBeTruthy();
    expect(result.mvp.points).toBeGreaterThan(0);
  }, 30000);

  it("impact subs are used across the season", () => {
    const teams = buildTeamsWithRules(RULE_PRESETS.modern);
    const result = runSeason(teams, RULE_PRESETS.modern);

    let impactCount = 0;
    for (const match of result.schedule) {
      if (match.result) {
        for (const inn of match.result.innings) {
          if (inn.impactSub) impactCount++;
        }
      }
    }

    // Across 74 matches (70 group + 4 playoff), impact subs should be used frequently
    expect(impactCount).toBeGreaterThan(5);
  }, 30000);
});

// ── Backward Compatibility ───────────────────────────────────────────────

describe("backward compatibility", () => {
  it("simulateMatch works without rules parameter (uses default)", () => {
    const teams = buildTeamsWithRules(DEFAULT_RULES);
    // Call without the rules argument
    const result = simulateMatch(teams[0], teams[1]);
    expect(result.winnerId).toBeTruthy();
  });

  it("runSeason works without rules parameter (uses default)", () => {
    const teams = buildTeamsWithRules(DEFAULT_RULES);
    const result = runSeason(teams);
    expect(result.champion).toBeTruthy();
  }, 30000);
});
