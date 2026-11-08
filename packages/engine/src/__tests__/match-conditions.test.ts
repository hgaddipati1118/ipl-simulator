/**
 * A T20 match's own conditions (match-conditions.ts, docs/RULES-MATCH.md 12.8): a run multiplier drawn per match from its
 * league's fitted two-piece shape (the men's default for other men's T20s; none for the women and for leagues fitted with
 * none), shared by both innings, in both engines; none in an ODI. It widens the spread of totals and leaves their mean
 * where it was. Seeded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMatchConditions, conditionsShapeFor, drawMatchConditions } from "../match-conditions.js";
import { MATCH_CONDITIONS } from "../match-conditions-data.js";
import { simulateMatch, type BallOutcome } from "../match.js";
import { createMatchState } from "../live-match.js";
import { RULE_PRESETS, odiRules, type RuleSet } from "../rules.js";
import { EXTRA_LEAGUES } from "../leagues.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { createRNG } from "../rng.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });

const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };
const SAVED = { male: { ...MATCH_CONDITIONS.male }, female: { ...MATCH_CONDITIONS.female } };
afterEach(() => { MATCH_CONDITIONS.male = { ...SAVED.male }; MATCH_CONDITIONS.female = { ...SAVED.female }; });

function teams(): Team[] {
  const out = IPL_TEAMS.map(c => new Team(c, RULES.salaryCap));
  for (const d of getRealPlayers()) out.find(t => t.id === d.teamId)?.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
  return out;
}

describe("match conditions", () => {
  it("each league its own shape; the men's default elsewhere; none for the women or a league fitted with none", () => {
    expect(conditionsShapeFor("male", "ipl")).toBe(MATCH_CONDITIONS.male.ipl);
    expect(conditionsShapeFor("male", "custom")).toBe(MATCH_CONDITIONS.male.default);
    expect(conditionsShapeFor("female", "wpl")).toBeUndefined();
    for (const [league, shape] of Object.entries(MATCH_CONDITIONS.male)) if (shape === null) expect(conditionsShapeFor("male", league)).toBeUndefined();
    let draws = 0;
    expect(drawMatchConditions("female", "wpl", () => { draws++; return 0.5; })).toBeUndefined();
    expect(draws).toBe(0);
  });

  it("draws the two-piece log multiplier: below the centre with probability lo / (lo + hi), each side with its own spread", () => {
    const s = MATCH_CONDITIONS.male.ipl!;
    expect(s.hi).not.toBe(s.lo);
    const rng = createRNG(5);
    const logs = Array.from({ length: 40000 }, () => Math.log(drawMatchConditions("male", "ipl", rng)!.run) - s.center);
    const below = logs.filter(x => x < 0), above = logs.filter(x => x >= 0);
    expect(below.length / logs.length).toBeCloseTo(s.lo / (s.lo + s.hi), 2);
    // a half-normal's root mean square is its sd
    const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
    expect(rms(below)).toBeCloseTo(s.lo, 2);
    expect(rms(above)).toBeCloseTo(s.hi, 2);
  });

  it("multiplies the scoring classes only", () => {
    const probs = { dot: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1, wicket: 1, wide: 1, noball: 1, legbye: 1 } as Record<BallOutcome, number>;
    applyMatchConditions(probs, { run: 1.2 });
    expect(probs["4"]).toBeCloseTo(1.2);
    expect(probs.dot).toBe(1);
    expect(probs.wicket).toBe(1);
  });

  it("the live engine draws them for a T20, not for an ODI", () => {
    const [a, b] = teams();
    expect(createMatchState(a, b, RULES, null, 11)._internal.conditions?.run).toBeGreaterThan(0);
    expect(createMatchState(a, b, odiRules("men", RULES), null, 11)._internal.conditions).toBeUndefined();
  });

  it("widens the spread of first-innings totals and keeps the mean (SA20 rules: its term is the widest)", () => {
    const N = 1500;
    const sa20: RuleSet = { ...EXTRA_LEAGUES.find(l => l.id === "sa20")!.rules, injuriesEnabled: false };
    const play = () => {
      const first: number[] = [];
      const t = teams();
      for (let i = 0; i < N; i++) {
        const a = t[i % t.length], b = t[(i * 3 + 1) % t.length === i % t.length ? (i + 1) % t.length : (i * 3 + 1) % t.length];
        first.push(simulateMatch(a, b, sa20, 4400 + i, { countTowardStandings: false }).innings[0].runs);
      }
      const mean = first.reduce((x, y) => x + y, 0) / N;
      const sd = Math.sqrt(first.reduce((x, y) => x + (y - mean) ** 2, 0) / (N - 1));
      return { mean, sd };
    };
    const withConditions = play();
    MATCH_CONDITIONS.male = {};
    const without = play();
    expect(withConditions.sd).toBeGreaterThan(without.sd + 2);
    expect(Math.abs(withConditions.mean - without.mean)).toBeLessThan(3);
  });
});
