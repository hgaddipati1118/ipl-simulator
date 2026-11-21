/**
 * A league's run level (LEAGUE_LEVELS.run, venues.ts; docs/TACTICS.md section 10): it rides on the ground profile as `levelRun`, a multiplier on
 * every scoring class, so a refit moves the league's runs and leaves its grounds' runMult and stadium labels (and so a team's stored stadium
 * rating) where they are. A T20I at a franchise ground plays without it; the IPL's neutral grounds play it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEAGUE_LEVELS, LEAGUE_LEVEL_RUN, VENUE_RUN_GAIN, applyVenueProfile, deriveStadiumBowlingRating, derivePitchType, getNeutralVenueProfile, getVenueProfileForTeam } from "../venues.js";
import { simulateMatch, stadiumRatingFor } from "../match.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });
const SAVED = { ...LEAGUE_LEVELS.ipl };
afterEach(() => { LEAGUE_LEVELS.ipl = { ...SAVED }; });
const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };

describe("league run level", () => {
  it("rides on levelRun: the grounds' runMult, the stadium labels and the stored stadium rating do not move with it", () => {
    const before = IPL_TEAMS.map(c => getVenueProfileForTeam(c.id)!);
    expect(before[0].levelRun ?? 1).toBeCloseTo(SAVED.run / LEAGUE_LEVEL_RUN, 9);
    LEAGUE_LEVELS.ipl = { ...SAVED, run: SAVED.run * 1.1 };
    IPL_TEAMS.forEach((c, i) => {
      const p = getVenueProfileForTeam(c.id)!;
      expect(p.runMult).toBe(before[i].runMult);
      expect(p.levelRun).toBeCloseTo((SAVED.run * 1.1) / LEAGUE_LEVEL_RUN, 9);
      expect(deriveStadiumBowlingRating(p)).toBe(deriveStadiumBowlingRating(before[i]));
      expect(derivePitchType(p)).toBe(derivePitchType(before[i]));
      // the team's config was labelled at load: the stadium effect stays neutral
      expect(stadiumRatingFor(new Team(c), p)).toBe(1);
    });
  });

  it("scales every scoring class, sixes included, by levelRun to the ground gain", () => {
    const p = { ...getVenueProfileForTeam("rcb")!, levelRun: undefined };
    const base = { dot: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1, wicket: 1, wide: 1, noball: 1, legbye: 1 };
    const a = { ...base }, b = { ...base };
    applyVenueProfile(a, p, "off-spin");
    applyVenueProfile(b, { ...p, levelRun: 1.1 }, "off-spin");
    const k = Math.pow(1.1, VENUE_RUN_GAIN);
    for (const c of ["1", "2", "3", "4", "6"] as const) expect(b[c] / a[c]).toBeCloseTo(k, 9);
    for (const c of ["dot", "wicket", "wide"] as const) expect(b[c]).toBe(a[c]);
  });

  it("a T20I at a franchise ground leaves it out; the IPL's neutral grounds carry it", () => {
    LEAGUE_LEVELS.ipl = { ...SAVED, run: 1.2 };
    const t20i = getVenueProfileForTeam("rcb", { league: false })!;
    expect(t20i.levelRun).toBeUndefined();
    expect(t20i.wicketMult / getVenueProfileForTeam("rcb")!.wicketMult).toBeCloseTo(1 / SAVED.wicket, 9);
    expect(t20i.dotMult).toBeUndefined();
    const n = getNeutralVenueProfile("ipl")!;
    expect(n.runMult).toBe(LEAGUE_LEVEL_RUN);
    expect(n.levelRun).toBeCloseTo(1.2 / LEAGUE_LEVEL_RUN, 9);
    expect(n.wicketMult).toBe(SAVED.wicket);
    expect(getNeutralVenueProfile("wpl")).toBeNull();
    expect(getNeutralVenueProfile("custom")).toBeNull();
  });

  it("moves the IPL's runs (the same seeds, a level 8% up)", () => {
    const teams = () => {
      const out = IPL_TEAMS.map(c => new Team(c, RULES.salaryCap));
      for (const d of getRealPlayers()) out.find(t => t.id === d.teamId)?.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
      return out;
    };
    const runs = () => {
      const ts = teams();
      let r = 0, n = 0;
      for (let i = 0; i < 60; i++) {
        const res = simulateMatch(ts[i % ts.length], ts[(i * 3 + 1) % ts.length] === ts[i % ts.length] ? ts[(i + 1) % ts.length] : ts[(i * 3 + 1) % ts.length], RULES, 500 + i, { countTowardStandings: false });
        for (const inn of res.innings) { r += inn.runs; n++; }
      }
      return r / n;
    };
    const lo = runs();
    LEAGUE_LEVELS.ipl = { ...SAVED, run: SAVED.run * 1.08 };
    const hi = runs();
    expect(hi - lo).toBeGreaterThan(4);
  });
});
