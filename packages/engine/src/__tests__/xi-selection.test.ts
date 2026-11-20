/**
 * The fitted league XI selection (xi-selection.ts; docs/TACTICS.md section 7): where it applies, that its XIs are legal (eleven, the
 * overseas limit, a keeper), that a match's draw is repeatable and varies across matches, that the user's own auto-pick is never drawn,
 * and that the former best-XI selection is unchanged without it.
 */
import { describe, expect, it } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player, type PlayerData } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { EXTRA_LEAGUES } from "../leagues.js";
import { LEAGUE_XI_SWITCH, leagueXiApplies, matchXiOptions, selectLeagueXI } from "../xi-selection.js";

let n = 0;
function mk(role: PlayerData["role"], bat: number, bowl: number, extra: Partial<PlayerData> = {}): Player {
  return new Player({
    id: `s${++n}`, name: `S${n}`, age: 26, country: "India", role,
    ratings: { battingIQ: bat, timing: bat, power: bat, running: 60, wicketTaking: bowl, economy: bowl, accuracy: bowl, clutch: 55 },
    isInternational: false, injured: false, injuryGamesLeft: 0, ...extra,
  });
}

/** A squad of 18: two keepers, six batters, four all-rounders, six bowlers; six overseas */
function squad(): Team {
  const t = new Team(IPL_TEAMS[0]);
  t.addPlayer(mk("batsman", 76, 20, { isWicketKeeper: true }), 1);
  t.addPlayer(mk("batsman", 64, 20, { isWicketKeeper: true, isInternational: true }), 1);
  [84, 81, 79, 74, 70, 66].forEach((b, i) => t.addPlayer(mk("batsman", b, 30, { isInternational: i < 2 }), 1));
  [72, 66, 60, 55].forEach((b, i) => t.addPlayer(mk("all-rounder", b, 70 - i * 3, { isInternational: i === 0 }), 1));
  [86, 82, 79, 75, 71, 68].forEach((w, i) => t.addPlayer(mk("bowler", 30 - i, w, { isInternational: i < 2 }), 1));
  return t;
}

describe("league XI selection", () => {
  it("applies to the men's T20 leagues only", () => {
    expect(leagueXiApplies(RULE_PRESETS.modern2026)).toBe(true);
    const men = EXTRA_LEAGUES.filter(l => l.gender === "men" && l.rules.matchFormat !== "hundred");
    for (const l of men) expect(leagueXiApplies(l.rules)).toBe(true);
    for (const l of EXTRA_LEAGUES.filter(l => !men.includes(l))) expect(leagueXiApplies(l.rules)).toBe(false);
    expect(leagueXiApplies(RULE_PRESETS.wpl)).toBe(false);
    expect(leagueXiApplies({ ...RULE_PRESETS.modern2026, league: "custom", maxOverseasInXI: 11, scoringContext: "t20i" })).toBe(false);
    LEAGUE_XI_SWITCH.off = true;
    expect(leagueXiApplies(RULE_PRESETS.modern2026)).toBe(false);
    LEAGUE_XI_SWITCH.off = false;
  });

  it("picks a legal XI, the same for a seed and different across matches", () => {
    const t = squad();
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const xi = selectLeagueXI(t.roster, 4, s);
      expect(xi).toHaveLength(11);
      expect(new Set(xi).size).toBe(11);
      expect(xi.filter(p => p.isInternational).length).toBeLessThanOrEqual(4);
      expect(xi.some(p => p.isWicketKeeper)).toBe(true);
      expect(selectLeagueXI(t.roster, 4, s).map(p => p.id)).toEqual(xi.map(p => p.id));
      seen.add(xi.map(p => p.id).sort().join());
    }
    expect(seen.size).toBeGreaterThan(1);
    // without a seed: the most likely XI, always the same
    expect(selectLeagueXI(t.roster, 4).map(p => p.id)).toEqual(selectLeagueXI(t.roster, 4).map(p => p.id));
  });

  it("leaves injured players out", () => {
    const t = squad();
    const best = t.autoSelectPlayingXI(4, { league: true });
    best[0].injured = true;
    expect(t.autoSelectPlayingXI(4, { league: true, seed: 3 })).not.toContain(best[0]);
  });

  it("draws a CPU side's XI per match, never the user's", () => {
    const t = squad();
    const opts = (seed: number) => matchXiOptions(RULE_PRESETS.modern2026, seed, 0);
    const cpu = new Set(Array.from({ length: 30 }, (_, s) => t.getPlayingXI(4, opts(s)).map(p => p.id).sort().join()));
    expect(cpu.size).toBeGreaterThan(1);
    t.isUserControlled = true;
    const user = new Set(Array.from({ length: 30 }, (_, s) => t.getPlayingXI(4, opts(s)).map(p => p.id).sort().join()));
    expect(user.size).toBe(1);
    expect([...user][0]).toBe(t.autoSelectPlayingXI(4, { league: true }).map(p => p.id).sort().join());
  });

  it("does not change the former selection when not asked for", () => {
    const t = squad();
    expect(t.getPlayingXI(4).map(p => p.id)).toEqual(t.autoSelectPlayingXI(4).map(p => p.id));
    expect(matchXiOptions({ ...RULE_PRESETS.modern2026, league: "custom", maxOverseasInXI: 11, scoringContext: "t20i" }, 5, 0)).toEqual({});
  });
});
