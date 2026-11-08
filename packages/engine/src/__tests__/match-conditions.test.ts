/**
 * A T20 match's own conditions (match-conditions.ts, docs/RULES-MATCH.md 12.8): a run multiplier drawn per match from the
 * fitted spread, shared by both innings, in both engines; none in an ODI. It widens the spread of totals and leaves their
 * mean where it was. Seeded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMatchConditions, drawMatchConditions } from "../match-conditions.js";
import { MATCH_CONDITIONS } from "../match-conditions-data.js";
import { simulateMatch, type BallOutcome } from "../match.js";
import { createMatchState } from "../live-match.js";
import { RULE_PRESETS, odiRules, type RuleSet } from "../rules.js";
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
  it("draws a lognormal run multiplier with the fitted spread, and nothing (no draw) at zero spread", () => {
    const rng = createRNG(5);
    const logs = Array.from({ length: 20000 }, () => Math.log(drawMatchConditions("male", rng)!.run));
    const m = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, x) => a + (x - m) ** 2, 0) / logs.length);
    const s = MATCH_CONDITIONS.male;
    expect(s.match).toBeGreaterThan(0.1);
    expect(sd).toBeCloseTo(s.match, 2);
    expect(m).toBeCloseTo(-(s.match ** 2) / 2 + s.center, 2);
    MATCH_CONDITIONS.male = { match: 0, innings: 0, center: 0 };
    let draws = 0;
    expect(drawMatchConditions("male", () => { draws++; return 0.5; })).toBeUndefined();
    expect(draws).toBe(0);
  });

  it("multiplies the scoring classes only", () => {
    const probs = { dot: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1, wicket: 1, wide: 1, noball: 1, legbye: 1 } as Record<BallOutcome, number>;
    applyMatchConditions(probs, { run: 1.2, innings: [1, 0.5] }, false);
    expect(probs["4"]).toBeCloseTo(1.2);
    expect(probs.dot).toBe(1);
    expect(probs.wicket).toBe(1);
    applyMatchConditions(probs, { run: 1, innings: [1, 0.5] }, true);
    expect(probs["6"]).toBeCloseTo(0.6);
  });

  it("the live engine draws them for a T20, not for an ODI", () => {
    const [a, b] = teams();
    expect(createMatchState(a, b, RULES, null, 11)._internal.conditions?.run).toBeGreaterThan(0);
    expect(createMatchState(a, b, odiRules("men", RULES), null, 11)._internal.conditions).toBeUndefined();
  });

  it("widens the spread of first-innings totals and keeps their mean; both innings of a match move together", () => {
    const N = 1500;
    const play = () => {
      const first: number[] = [], pairs: [number, number][] = [];
      const t = teams();
      for (let i = 0; i < N; i++) {
        const a = t[i % t.length], b = t[(i * 3 + 1) % t.length === i % t.length ? (i + 1) % t.length : (i * 3 + 1) % t.length];
        const r = simulateMatch(a, b, RULES, 4400 + i, { countTowardStandings: false });
        first.push(r.innings[0].runs);
        const r10 = (k: number) => r.innings[k].ballLog.filter(e => e.over < 10).reduce((s, e) => s + e.runs + e.extras, 0);
        if (r.innings[1].ballLog.some(e => e.over >= 9)) pairs.push([r10(0), r10(1)]);
      }
      const mean = first.reduce((x, y) => x + y, 0) / N;
      const sd = Math.sqrt(first.reduce((x, y) => x + (y - mean) ** 2, 0) / (N - 1));
      const ma = pairs.reduce((s, p) => s + p[0], 0) / pairs.length, mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      const cov = pairs.reduce((s, p) => s + (p[0] - ma) * (p[1] - mb), 0) / pairs.length;
      return { mean, sd, cov };
    };
    const withConditions = play();
    MATCH_CONDITIONS.male = { match: 0, innings: 0, center: 0 };
    const without = play();
    expect(withConditions.sd).toBeGreaterThan(without.sd + 2);
    expect(Math.abs(withConditions.mean - without.mean)).toBeLessThan(4);
    expect(withConditions.cov).toBeGreaterThan(without.cov + 15);
  });
});
