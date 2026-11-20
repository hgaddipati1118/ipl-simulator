/**
 * The last pair (last-pair.ts, docs/TACTICS.md section 5): with nine down the senior partner farms the strike and the junior one does not.
 * A state term (nine wickets down), not a positional one: it reads only the two batters' ratings and the ball of the over.
 */
import { describe, expect, it } from "vitest";
import { LAST_PAIR, LAST_PAIR_CLASSES, LAST_PAIR_STRENGTH } from "../last-pair-data.js";
import { LAST_PAIR_SWITCH, applyLastPair, applyLastPairTest, lastPairBucket, lastPairGap, lastPairLogs, lastPairSenior } from "../last-pair.js";
import { ballProbabilities, type BallModelPlayer, type BallOutcome, type VenueContext } from "../match.js";
import { T20_FORMAT, ODI_FORMAT } from "../format.js";

const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];
const ones = () => Object.fromEntries(CLASSES.map(k => [k, 1])) as Record<BallOutcome, number>;
const batter = (rating: number): BallModelPlayer => ({
  battingOvr: rating * 100, bowlingOvr: 20, bowlingStyle: "right-arm-medium", battingHand: "right",
  ratings: { timing: rating * 100, power: rating * 100, wicketTaking: 20, accuracy: 20, clutch: 50 }, morale: 70,
});
const bowler: BallModelPlayer = { battingOvr: 20, bowlingOvr: 70, bowlingStyle: "right-arm-fast", battingHand: "right", ratings: { timing: 20, power: 20, wicketTaking: 70, accuracy: 70, clutch: 50 }, morale: 70 };
const venue = (gender: "male" | "female"): VenueContext => ({ stadiumBowlRating: 1, pitchType: "balanced", boundarySize: "medium", dewFactor: "none", profile: null, chaseAdvantage: 0, gender });
const ball = (fmt: "t20" | "odi", s: number, partner: number | undefined, wicketsDown: number, ballInOver: number) => ballProbabilities(batter(s), bowler, {
  over: 17, isSecondInnings: false, target: 0, currentScore: 120, ballsRemaining: 18, wicketsDown, venue: venue("male"), inningsBalls: fmt === "t20" ? 120 : 300,
  rules: { freeHit: false, fmt: fmt === "t20" ? T20_FORMAT : ODI_FORMAT, gender: "male", ...(partner !== undefined ? { partnerRating: partner, ballInOver } : {}), ...(fmt === "odi" ? { scheduledOvers: 50 } : {}) },
});
const share = (p: Record<BallOutcome, number>, k: BallOutcome) => p[k] / CLASSES.reduce((s, c) => s + p[c], 0);

describe("the fitted tables", () => {
  it("every shipped table has three ball-of-the-over buckets of seven classes, all finite and bounded", () => {
    for (const fmt of ["t20", "t20i", "odi", "test"] as const) {
      for (const g of ["male", "female"] as const) {
        const t = LAST_PAIR[fmt][g];
        if (!t) continue;
        for (const m of [t.a, t.c]) {
          expect(m).toHaveLength(3);
          for (const row of m) { expect(row).toHaveLength(LAST_PAIR_CLASSES.length); for (const v of row) { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v)).toBeLessThan(2); } }
        }
        expect(t.b).toHaveLength(LAST_PAIR_CLASSES.length);
        for (const v of t.b) { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v)).toBeLessThan(2); }
        // a 3 takes the 2's term (too rare to fit alone); the ball of the over moves only the strike classes in c
        for (let b = 0; b < 3; b++) { expect(t.a[b][3]).toBe(t.a[b][2]); expect(t.c[b][3]).toBe(0); }
        expect(t.b[3]).toBe(t.b[2]);
      }
    }
  });
  it("the ball of the over buckets: 0-2, 3-4, 5 legal balls bowled", () => {
    expect([0, 1, 2, 3, 4, 5].map(lastPairBucket)).toEqual([0, 0, 0, 1, 1, 2]);
  });
  it("the rating gap is clamped to -1..1 and is zero at a tie", () => {
    expect(lastPairGap(0.5, 0.5)).toBe(0);
    expect(lastPairGap(0.9, 0.2)).toBe(1);
    expect(lastPairGap(0.2, 0.9)).toBe(-1);
  });
  it("the senior-partner curve is odd, steep about a tie and bounded", () => {
    expect(lastPairSenior(0.5, 0.5)).toBe(0);
    expect(lastPairSenior(0.6, 0.5)).toBeCloseTo(-lastPairSenior(0.5, 0.6), 12);
    expect(lastPairSenior(0.55, 0.5)).toBeGreaterThan(0.7);
    expect(lastPairSenior(0.9, 0.2)).toBeLessThanOrEqual(1);
  });
});

describe("a state, not a position", () => {
  it("nothing happens before nine are down, or when no partner is given", () => {
    for (const fmt of ["t20", "odi"] as const) {
      const base = ball(fmt, 0.3, undefined, 9, 0);
      for (const wd of [0, 4, 8]) expect(ball(fmt, 0.3, 0.8, wd, 0)).toEqual(ball(fmt, 0.3, undefined, wd, 0));
      expect(ball(fmt, 0.3, undefined, 9, 0)).toEqual(base);
      if (LAST_PAIR[fmt === "t20" ? "t20" : "odi"].male) expect(ball(fmt, 0.3, 0.8, 9, 0)).not.toEqual(base);
    }
  });
  it("the term reads only the two ratings and the ball of the over: the same pair gives the same weights wherever the batters came in", () => {
    // the call carries no batting position; two calls with the same ratings are identical
    expect(ball("t20", 0.75, 0.3, 9, 1)).toEqual(ball("t20", 0.75, 0.3, 9, 1));
  });
  it("a star at number 11 bats as himself: the stronger of the pair, whoever he is, takes the stronger one's term", () => {
    const logs = (s: number, p: number, b: number) => lastPairLogs("t20", "male", s, p, b)!;
    // the star striker with a tail-ender partner against the same two ratings with the roles swapped
    const star = logs(0.8, 0.3, 0), tail = logs(0.3, 0.8, 0);
    const iSingle = LAST_PAIR_CLASSES.indexOf("1");
    // the senior partner refuses singles early in the over (his single weight falls), the junior one takes them
    expect(star[iSingle]).toBeLessThan(tail[iSingle]);
    // and on the last ball it is the other way round: the senior takes one to keep the end, the junior refuses it
    expect(logs(0.8, 0.3, 5)[iSingle]).toBeGreaterThan(logs(0.3, 0.8, 5)[iSingle]);
    // a pair of equals shows only the common part: the table's `a`, the strike classes' ball-of-the-over pattern at the format's strength about its mean
    const eq = logs(0.5, 0.5, 0);
    const A = LAST_PAIR.t20.male!.a, st = LAST_PAIR_STRENGTH.t20.male;
    LAST_PAIR_CLASSES.forEach((_, i) => {
      const mean = i <= 1 ? (A[0][i] + A[1][i] + A[2][i]) / 3 : A[0][i];
      expect(eq[i]).toBeCloseTo(mean + st * (A[0][i] - mean), 10);
    });
    // and even a small edge makes a senior partner (the strike follows who is the better of the two)
    expect(lastPairLogs("t20", "male", 0.52, 0.5, 0)![iSingle]).toBeLessThan(lastPairLogs("t20", "male", 0.5, 0.52, 0)![iSingle]);
  });
  it("applies to the weights it should and not to the extras", () => {
    const p = ones();
    applyLastPair(p, "t20", "male", 0.8, 0.3, 5);
    for (const k of ["wide", "noball", "legbye"] as const) expect(p[k]).toBe(1);
  });
  it("the T20I plays its own table, falling back on the league one", () => {
    const a = ones(), b = ones();
    applyLastPair(a, "t20i", "male", 0.8, 0.3, 0);
    applyLastPair(b, "t20", "male", 0.8, 0.3, 0);
    if (LAST_PAIR.t20i.male) expect(a).not.toEqual(b);
  });
  it("the switch turns a format off (the T20I with the T20) and scales the strength, which leaves the pair's level alone", () => {
    const off = ones(), on = ones(), half = ones(), zero = ones();
    LAST_PAIR_SWITCH.off.t20 = true;
    applyLastPair(off, "t20i", "male", 0.8, 0.3, 0);
    LAST_PAIR_SWITCH.off.t20 = false;
    LAST_PAIR_SWITCH.scale.t20 = 0;
    applyLastPair(zero, "t20", "male", 0.8, 0.3, 0);
    LAST_PAIR_SWITCH.scale.t20 = 0.5;
    applyLastPair(half, "t20", "male", 0.8, 0.3, 0);
    LAST_PAIR_SWITCH.scale.t20 = undefined;
    applyLastPair(on, "t20", "male", 0.8, 0.3, 0);
    expect(off).toEqual(ones());
    // at strength 0 only the level remains: the same for the stronger and the weaker striker, and for every ball of the over in the classes the ball does not move
    const weak = ones();
    LAST_PAIR_SWITCH.scale.t20 = 0;
    applyLastPair(weak, "t20", "male", 0.3, 0.8, 0);
    LAST_PAIR_SWITCH.scale.t20 = undefined;
    CLASSES.forEach(k => expect(weak[k]).toBeCloseTo(zero[k], 10));
    CLASSES.forEach(k => expect(Math.log(half[k]) - Math.log(zero[k])).toBeCloseTo(0.5 * (Math.log(on[k]) - Math.log(zero[k])), 8));
  });
});

describe("the Test model's probabilities", () => {
  const classes = ["1", "2", "3", "4", "6", "W", "wide", "nb", "bye"];
  it("stay probabilities (a dot is what is left) and move as the term says", () => {
    const p = [0.1, 0.03, 0.002, 0.04, 0.003, 0.03, 0.01, 0.002, 0.005];
    const q = [...p];
    applyLastPairTest(q, classes, "male", 0.8, 0.3, 0);
    expect(q.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(1);
    for (const v of q) expect(v).toBeGreaterThan(0);
    if (LAST_PAIR.test.male) expect(q).not.toEqual(p);
  });
});
