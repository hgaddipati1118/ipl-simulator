/**
 * The T20 ball model's response to the striker's batting rating (batter-response.ts, docs/TACTICS.md section 5): a piecewise-linear
 * correction fitted from Cricsheet that makes the bottom of the order score and survive as real tails do. It acts on the rating
 * wherever the batter bats (no positional term), leaves the top of the order where it was and the batter-independent classes alone.
 */
import { describe, expect, it } from "vitest";
import { BATTER_RESPONSE, BATTER_RESPONSE_KNOTS } from "../batter-response-data.js";
import { ODI_BATTER_RESPONSE, ODI_BATTER_RESPONSE_KNOTS } from "../odi-batter-response-data.js";
import { applyBatterResponse, batterResponseLog } from "../batter-response.js";
import { ballProbabilities, type BallModelPlayer, type BallOutcome, type VenueContext } from "../match.js";
import { T20_FORMAT } from "../format.js";

const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];
const ones = () => Object.fromEntries(CLASSES.map(k => [k, 1])) as Record<BallOutcome, number>;

/** A batter whose (battingOvr + timing) / 200 is `rating`, against a fixed average bowler */
const batter = (rating: number): BallModelPlayer => ({
  battingOvr: rating * 100, bowlingOvr: 20, bowlingStyle: "right-arm-medium", battingHand: "right",
  ratings: { timing: rating * 100, power: rating * 100, wicketTaking: 20, accuracy: 20, clutch: 50 }, morale: 70,
});
const bowler: BallModelPlayer = { battingOvr: 20, bowlingOvr: 70, bowlingStyle: "right-arm-fast", battingHand: "right", ratings: { timing: 20, power: 20, wicketTaking: 70, accuracy: 70, clutch: 50 }, morale: 70 };
const venue = (gender: "male" | "female"): VenueContext => ({ stadiumBowlRating: 1, pitchType: "balanced", boundarySize: "medium", dewFactor: "none", profile: null, chaseAdvantage: 0, gender });
const ball = (rating: number, gender: "male" | "female") => ballProbabilities(batter(rating), bowler, {
  over: 10, isSecondInnings: false, target: 0, currentScore: 80, ballsRemaining: 60, wicketsDown: 3, venue: venue(gender), inningsBalls: 120,
  rules: { freeHit: false, fmt: T20_FORMAT, gender },
});
/** Expected runs off the bat and the wicket share of a ball's normalised weights */
function summary(p: Record<BallOutcome, number>) {
  const t = CLASSES.reduce((s, k) => s + p[k], 0);
  return { runs: (p["1"] + 2 * p["2"] + 3 * p["3"] + 4 * p["4"] + 6 * p["6"]) / t, wicket: p.wicket / t };
}

describe("the fitted tables", () => {
  for (const [name, table, knots] of [["T20", BATTER_RESPONSE, BATTER_RESPONSE_KNOTS], ["ODI", ODI_BATTER_RESPONSE, ODI_BATTER_RESPONSE_KNOTS]] as const) {
    it(`${name}: knots rise, every class has a value at every knot, all finite and bounded`, () => {
      expect([...knots].sort((a, b) => a - b)).toEqual([...knots]);
      for (const g of ["male", "female"] as const) {
        expect(Object.keys(table[g]).sort()).toEqual(["1", "2", "3", "4", "6", "dot", "wicket"]);
        for (const row of Object.values(table[g])) {
          expect(row).toHaveLength(knots.length);
          for (const v of row) { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v)).toBeLessThan(1.5); }
        }
      }
    });
  }

  it("T20: the top of the order is left alone (a rating of 0.85 moves each class by under 30%) and the extras are not in the table", () => {
    for (const g of ["male", "female"] as const) {
      for (const row of Object.values(BATTER_RESPONSE[g])) expect(Math.abs(row[row.length - 1])).toBeLessThan(0.3);
      for (const k of ["wide", "noball", "legbye"]) expect(BATTER_RESPONSE[g][k]).toBeUndefined();
    }
  });

  it("linear between the knots, constant beyond the ends", () => {
    const row = [0, 1, 2, 3, 4];
    const knots = [0.25, 0.4, 0.55, 0.7, 0.85];
    expect(batterResponseLog(row, 0.1, knots)).toBe(0);
    expect(batterResponseLog(row, 0.95, knots)).toBe(4);
    expect(batterResponseLog(row, 0.475, knots)).toBeCloseTo(1.5, 10);
    expect(batterResponseLog(row, 0.55, knots)).toBeCloseTo(2, 10);
  });
});

describe("what it does to a ball", () => {
  it("applyBatterResponse multiplies only the classes in the table", () => {
    const p = ones();
    applyBatterResponse(p, "male", 0.3);
    expect(p.wide).toBe(1);
    expect(p.noball).toBe(1);
    expect(p.legbye).toBe(1);
    const row = BATTER_RESPONSE.male["4"];
    expect(p["4"]).toBeCloseTo(Math.exp(batterResponseLog(row, 0.3)), 10);
  });

  for (const g of ["male", "female"] as const) {
    it(`${g}: runs a ball rise and the wicket share falls with the batter's rating, smoothly from 0.25 to 0.9`, () => {
      const ratings = Array.from({ length: 14 }, (_, i) => 0.25 + 0.05 * i);
      const s = ratings.map(r => summary(ball(r, g)));
      for (let i = 1; i < s.length; i++) {
        expect(s[i].runs).toBeGreaterThan(s[i - 1].runs - 1e-9);
        expect(s[i].wicket).toBeLessThan(s[i - 1].wicket + 1e-9);
      }
    });

    it(`${g}: a tail-ender scores a lot less a ball than a top-order batter, the gap wider than the base matrix alone leaves`, () => {
      const tail = summary(ball(0.3, g)), top = summary(ball(0.8, g));
      const saved = Object.fromEntries(Object.keys(BATTER_RESPONSE[g]).map(k => [k, BATTER_RESPONSE[g][k]]));
      for (const k of Object.keys(BATTER_RESPONSE[g])) BATTER_RESPONSE[g][k] = BATTER_RESPONSE[g][k].map(() => 0);
      const tail0 = summary(ball(0.3, g)), top0 = summary(ball(0.8, g));
      for (const k of Object.keys(saved)) BATTER_RESPONSE[g][k] = saved[k];
      expect(tail.runs / top.runs).toBeLessThan(tail0.runs / top0.runs);
      // the top of the order moved by little
      expect(Math.abs(top.runs / top0.runs - 1)).toBeLessThan(0.05);
    });
  }

  it("no positional term: the response depends on the rating alone, whatever the state of the innings", () => {
    const a = ballProbabilities(batter(0.3), bowler, {
      over: 18, isSecondInnings: false, target: 0, currentScore: 150, ballsRemaining: 12, wicketsDown: 9, venue: venue("male"), inningsBalls: 120,
      rules: { freeHit: false, fmt: T20_FORMAT, gender: "male" },
    });
    const b = ballProbabilities(batter(0.3), bowler, {
      over: 18, isSecondInnings: false, target: 0, currentScore: 150, ballsRemaining: 12, wicketsDown: 9, venue: venue("male"), inningsBalls: 120,
      rules: { freeHit: false, fmt: T20_FORMAT, gender: "male" },
    });
    expect(a).toEqual(b);
    // a star batting late is a star: at the same state a 0.85 batter's runs a ball exceed a 0.3 batter's by far
    const star = summary(ballProbabilities(batter(0.85), bowler, {
      over: 18, isSecondInnings: false, target: 0, currentScore: 150, ballsRemaining: 12, wicketsDown: 9, venue: venue("male"), inningsBalls: 120,
      rules: { freeHit: false, fmt: T20_FORMAT, gender: "male" },
    }));
    expect(star.runs).toBeGreaterThan(1.3 * summary(a).runs);
  });
});
