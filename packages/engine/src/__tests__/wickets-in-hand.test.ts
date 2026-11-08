/**
 * Wickets in hand (wickets-in-hand.ts, docs/RULES-MATCH.md 12.9): the fitted table shows real sides consolidating after early
 * wickets and accelerating late with wickets in hand; it applies to a T20's first innings only, per competition (its power
 * and factors), and it cuts the engine's collapses while the mean first innings stays where it was. Seeded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WICKETS_IN_HAND, WICKETS_IN_HAND_SET } from "../wickets-in-hand-data.js";
import { WICKETS_IN_HAND_NORM } from "../wickets-in-hand-norm-data.js";
import { applyWicketsInHand, setLevel, wicketsInHandBand, wicketsInHandKey } from "../wickets-in-hand.js";
import { ballProbabilities, simulateMatch, type BallModelPlayer, type BallOutcome, type VenueContext } from "../match.js";
import { T20_FORMAT } from "../format.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });

const C = { dot: 0, one: 1, four: 4, six: 5, wicket: 6 };
const SAVED = { ...WICKETS_IN_HAND_NORM };
afterEach(() => { for (const k of Object.keys(WICKETS_IN_HAND_NORM)) delete WICKETS_IN_HAND_NORM[k]; Object.assign(WICKETS_IN_HAND_NORM, SAVED); });

describe("the fitted table", () => {
  const t = WICKETS_IN_HAND.male;
  it("consolidation after early wickets: overs 7-11 four down hit fewer fours and sixes and lose fewer wickets than none down", () => {
    expect(t[1][4][C.four]).toBeLessThan(t[1][0][C.four]);
    expect(t[1][4][C.six]).toBeLessThan(t[1][0][C.six]);
    expect(t[1][4][C.wicket]).toBeLessThan(t[1][0][C.wicket]);
  });
  it("late acceleration with wickets in hand: overs 16-18 two down hit more sixes than eight down", () => {
    expect(t[3][2][C.six]).toBeGreaterThan(t[3][8][C.six]);
    expect(t[3][2][C.four]).toBeGreaterThan(t[3][8][C.four]);
  });
  it("a new batter plays himself in, a set one takes risks: the set term rises with balls faced", () => {
    const set = WICKETS_IN_HAND_SET.male;
    expect([0, 1, 2, 3, 5, 6, 9, 10, 19, 20, 29, 30, 80].map(setLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    expect(set[0][C.wicket]).toBeLessThan(0.8);
    expect(set[6][C.wicket]).toBeGreaterThan(1.1);
    expect(set[0][C.six]).toBeLessThan(set[3][C.six]);
    expect(set[3][C.six]).toBeLessThan(set[6][C.six]);
  });
  it("bands: overs 1-6, 7-11, 12-15, 16-18, 19-20", () => {
    expect([0, 5, 6, 10, 11, 14, 15, 17, 18, 19].map(wicketsInHandBand)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe("where it applies", () => {
  it("a competition's own factors, a T20I's, else the gender's default; none at power 0", () => {
    expect(wicketsInHandKey({ league: "ipl" }, "male")).toBe("ipl");
    expect(wicketsInHandKey({ league: "custom", scoringContext: "t20i" }, "female")).toBe("t20i-female");
    expect(wicketsInHandKey({ league: "custom" }, "male")).toBe("default-male");
    // a league's factors are its gender's: the IPL's rules on women read the women's default
    expect(wicketsInHandKey({ league: "ipl" }, "female")).toBe("default-female");
    const probs = { dot: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1, wicket: 1, wide: 1, noball: 1, legbye: 1 } as Record<BallOutcome, number>;
    WICKETS_IN_HAND_NORM.none = { scale: 0, gender: "male", norm: [[2]] };
    applyWicketsInHand(probs, "male", "none", 8, 4);
    expect(Object.values(probs).every(v => v === 1)).toBe(true);
  });

  it("the first innings only", () => {
    const p: BallModelPlayer = { battingOvr: 60, bowlingOvr: 60, bowlingStyle: "right-arm-fast", battingHand: "right", ratings: { timing: 60, power: 60, wicketTaking: 60, accuracy: 60, clutch: 50 }, morale: 70 };
    const venue: VenueContext = { stadiumBowlRating: 1, pitchType: "balanced", boundarySize: "medium", dewFactor: "none", profile: null, chaseAdvantage: 0, gender: "male" };
    const at = (second: boolean, key?: string) => ballProbabilities(p, p, {
      over: 8, isSecondInnings: second, target: second ? 180 : 0, currentScore: 60, ballsRemaining: 66, wicketsDown: 4,
      venue: { ...venue, ...(key ? { wicketsInHandKey: key } : {}) }, inningsBalls: 120, rules: { freeHit: false, fmt: T20_FORMAT, gender: "male" },
    });
    expect(at(true, "ipl")).toEqual(at(true));
    expect(at(false, "ipl")["6"]).not.toBeCloseTo(at(false)["6"], 6);
  });
});

describe("collapses", () => {
  const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };
  const teams = (): Team[] => {
    const out = IPL_TEAMS.map(c => new Team(c, RULES.salaryCap));
    for (const d of getRealPlayers()) out.find(t => t.id === d.teamId)?.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
    return out;
  };
  it("an IPL side four to six down in overs 7-15 slows down and loses fewer wickets than without the table; the mean holds", () => {
    const N = 1500;
    const play = () => {
      const t = teams();
      let runs = 0;
      const cell = { early: [0, 0, 0], deep: [0, 0, 0] }; // runs, legal balls, wickets
      for (let i = 0; i < N; i++) {
        const a = t[i % t.length], b = t[(i * 3 + 1) % t.length === i % t.length ? (i + 1) % t.length : (i * 3 + 1) % t.length];
        const inn = simulateMatch(a, b, RULES, 6600 + i, { countTowardStandings: false }).innings[0];
        runs += inn.runs;
        let down = 0;
        for (const e of inn.ballLog) {
          if (!e.deadBall && e.over >= 6 && e.over <= 14 && (down <= 1 || (down >= 4 && down <= 6))) {
            const c = down <= 1 ? cell.early : cell.deep;
            c[0] += e.runs + e.extras; if (e.outcome !== "wide" && e.outcome !== "noball") c[1]++; if (e.isWicket) c[2]++;
          }
          if (e.isWicket) down++;
        }
      }
      const rate = (c: number[], k: 0 | 2) => c[k] / c[1];
      return { mean: runs / N, runRatio: rate(cell.deep, 0) / rate(cell.early, 0), wicketRatio: rate(cell.deep, 2) / rate(cell.early, 2) };
    };
    const withTable = play();
    WICKETS_IN_HAND_NORM.ipl = { scale: 0, gender: "male", norm: [] };
    const without = play();
    expect(withTable.runRatio).toBeLessThan(without.runRatio - 0.05);
    expect(withTable.wicketRatio).toBeLessThan(without.wicketRatio - 0.1);
    expect(Math.abs(withTable.mean - without.mean)).toBeLessThan(4);
  });
});
