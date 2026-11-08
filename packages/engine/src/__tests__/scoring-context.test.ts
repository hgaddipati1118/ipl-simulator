/**
 * Scoring contexts (scoring-context.ts): the T20I's (docs/FORMATS.md "T20I level"), read only by a T20 with
 * rules.scoringContext "t20i"; the women's leagues' (docs/RULES-MATCH.md 12.7), read by women's T20 and Hundred leagues.
 * Men's leagues and the ODI never read one. Both engines. Seeded.
 */
import { describe, expect, it, vi } from "vitest";
import { scoringContextFor, applyScoringContext } from "../scoring-context.js";
import { T20I_CONTEXT } from "../t20i-context-data.js";
import { WOMENS_LEAGUE_CONTEXT } from "../womens-league-context-data.js";
import { MENS_LEAGUE_CONTEXT } from "../mens-league-context-data.js";
import { EXTRA_LEAGUES } from "../leagues.js";
import { T20_FORMAT, HUNDRED_FORMAT, ODI_FORMAT } from "../format.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { simulateMatch, type BallOutcome } from "../match.js";
import { createMatchState, simulateRemaining } from "../live-match.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });

const T20I: RuleSet = { ...RULE_PRESETS.modern2026, league: "custom", impactPlayer: false, maxOverseasInXI: 11, injuriesEnabled: false, scoringContext: "t20i" };
const NO_CONTEXT: RuleSet = { ...T20I, scoringContext: undefined };

function teams(): Team[] {
  const out = IPL_TEAMS.map(c => new Team(c, T20I.salaryCap));
  for (const d of getRealPlayers()) out.find(t => t.id === d.teamId)?.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
  return out;
}

describe("T20I context", () => {
  it("applies to a T20I only: not to leagues, The Hundred or the ODI", () => {
    expect(scoringContextFor(T20I, T20_FORMAT)).toBe(T20I_CONTEXT.male);
    expect(scoringContextFor({ ...T20I, gender: "women" }, T20_FORMAT)).toBe(T20I_CONTEXT.female);
    expect(scoringContextFor(T20I, HUNDRED_FORMAT)).toBeUndefined();
    expect(scoringContextFor(T20I, ODI_FORMAT)).toBeUndefined();
    // the IPL presets read the IPL's fitted shape (12.8), the WPL its women's table; nothing reads the T20I's
    for (const rules of Object.values(RULE_PRESETS)) expect(scoringContextFor(rules, T20_FORMAT)).not.toBe(T20I_CONTEXT.male);
  });

  it("multiplies each phase's classes", () => {
    const probs = { dot: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1, wicket: 1, wide: 1, noball: 1, legbye: 1 } as Record<BallOutcome, number>;
    applyScoringContext(probs, { powerplay: { "6": 0.5, wicket: 2 }, middle: {}, death: {} }, "powerplay");
    expect(probs["6"]).toBe(0.5);
    expect(probs.wicket).toBe(2);
    expect(probs.dot).toBe(1);
  });

  it("the fitted level: a T20I's powerplay is slower and fewer innings are bowled out than on the league tables (both engines)", () => {
    const N = 40;
    const measure = (rules: RuleSet, live: boolean) => {
      let pp = 0, ppBalls = 0, allOut = 0, inns = 0;
      for (let i = 0; i < N; i++) {
        const t = teams();
        const a = t[i % t.length], b = t[(i * 3 + 1) % t.length === i % t.length ? (i + 1) % t.length : (i * 3 + 1) % t.length];
        const innings = live
          ? [simulateRemaining(createMatchState(a, b, rules, null, 600 + i, { neutralVenue: true })).state].flatMap(s => [s._internal.innings1Raw!, s._internal.currentInningsRaw!])
          : simulateMatch(a, b, rules, 600 + i, { countTowardStandings: false, neutralVenue: true }).innings;
        for (const inn of innings) {
          inns++;
          if (inn.wickets >= 10) allOut++;
          for (const ev of inn.ballLog) if (ev.over < 6) { pp += ev.runs + ev.extras; if (ev.outcome !== "wide" && ev.outcome !== "noball") ppBalls++; }
        }
      }
      return { ppRate: (6 * pp) / ppBalls, allOut: allOut / inns };
    };
    for (const live of [false, true]) {
      const ctx = measure(T20I, live), none = measure(NO_CONTEXT, live);
      expect(ctx.ppRate).toBeLessThan(none.ppRate - 1);
      expect(ctx.allOut).toBeLessThan(none.allOut);
    }
  });
});

describe("women's league contexts", () => {
  const extra = (id: string) => EXTRA_LEAGUES.find(l => l.id === id)!.rules;

  it("each women's league reads its own table, any other women's T20 the pooled one; men's leagues and the ODI none", () => {
    expect(scoringContextFor(RULE_PRESETS.wpl, T20_FORMAT)).toBe(WOMENS_LEAGUE_CONTEXT.wpl);
    expect(scoringContextFor(extra("wbbl"), T20_FORMAT)).toBe(WOMENS_LEAGUE_CONTEXT.wbbl);
    expect(scoringContextFor(extra("hundred-w"), HUNDRED_FORMAT)).toBe(WOMENS_LEAGUE_CONTEXT["hundred-w"]);
    expect(scoringContextFor({ ...RULE_PRESETS.modern2026, league: "custom", gender: "women" }, T20_FORMAT)).toBe(WOMENS_LEAGUE_CONTEXT.default);
    expect(scoringContextFor(RULE_PRESETS.wpl, ODI_FORMAT)).toBeUndefined();
    expect(scoringContextFor({ ...T20I, gender: "women" }, T20_FORMAT)).toBe(T20I_CONTEXT.female);
    // men's leagues: the IPL its shape, the others none
    expect(scoringContextFor(RULE_PRESETS.modern2026, T20_FORMAT)).toBe(MENS_LEAGUE_CONTEXT.ipl);
    for (const l of EXTRA_LEAGUES.filter(l => l.gender === "men")) {
      expect(scoringContextFor(l.rules, l.rules.matchFormat === "hundred" ? HUNDRED_FORMAT : T20_FORMAT)).toBeUndefined();
    }
    expect(scoringContextFor({ ...RULE_PRESETS.modern2026, gender: "combined" }, T20_FORMAT)).toBeUndefined();
  });

  it("the fitted WPL level: a slower powerplay and fewer sixes than on the league tables (both engines)", () => {
    const rules: RuleSet = { ...RULE_PRESETS.wpl, injuriesEnabled: false };
    const N = 30;
    const measure = (live: boolean) => {
      let pp = 0, ppBalls = 0, sixes = 0, inns = 0;
      for (let i = 0; i < N; i++) {
        const t = teams();
        const a = t[i % t.length], b = t[(i * 3 + 1) % t.length === i % t.length ? (i + 1) % t.length : (i * 3 + 1) % t.length];
        const innings = live
          ? [simulateRemaining(createMatchState(a, b, rules, null, 800 + i)).state].flatMap(s => [s._internal.innings1Raw!, s._internal.currentInningsRaw!])
          : simulateMatch(a, b, rules, 800 + i, { countTowardStandings: false }).innings;
        for (const inn of innings) {
          inns++; sixes += inn.sixes;
          for (const ev of inn.ballLog) if (ev.over < 6) { pp += ev.runs + ev.extras; if (ev.outcome !== "wide" && ev.outcome !== "noball") ppBalls++; }
        }
      }
      return { ppRate: (6 * pp) / ppBalls, sixes: sixes / inns };
    };
    const saved = { ...WOMENS_LEAGUE_CONTEXT.wpl };
    for (const live of [false, true]) {
      const ctx = measure(live);
      Object.assign(WOMENS_LEAGUE_CONTEXT.wpl, { powerplay: {}, middle: {}, death: {} });
      const none = measure(live);
      Object.assign(WOMENS_LEAGUE_CONTEXT.wpl, saved);
      expect(ctx.ppRate).toBeLessThan(none.ppRate - 1.5);
      expect(ctx.sixes).toBeLessThan(none.sixes * 0.75);
    }
  });
});

