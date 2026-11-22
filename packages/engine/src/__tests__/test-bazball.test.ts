/**
 * England's batting from June 2022 as the engine plays it (test-bazball-data.ts; docs/COUNTRY-VALIDATION.md, "Test results by
 * country"): the fitted Bazball factor times a wicket calibration fitted on England's 2022-24 Tests with the XIs that played.
 */
import { describe, expect, it } from "vitest";
import { createTestMatch, currentInnings, stepTestBall, testBallProbs, TEST_OUTCOMES, type TestMatchState } from "../test-match.js";
import { TEST_BAZBALL_CAL } from "../test-bazball-data.js";
import { TEST_MODEL } from "../test-model-data.js";
import { testTeam } from "./test-squads.js";

const ENG = testTeam("England"), IND = testTeam("India");
const BAZ = (TEST_MODEL as unknown as { factors: { bazball: Record<string, number> } }).factors.bazball;

/** A Test with the Bazball factor on England, a few balls into England's first innings */
function englandBatting(): TestMatchState {
  for (let seed = 1; seed < 200; seed++) {
    const st = createTestMatch(ENG, IND, { seed, country: "ENG", bazballTeamId: ENG.id });
    if (currentInnings(st)?.battingTeamId !== ENG.id) continue;
    for (let b = 0; b < 3; b++) stepTestBall(st);
    if (currentInnings(st)?.battingTeamId === ENG.id && currentInnings(st)!.wickets < 9) return st;
  }
  throw new Error("no seed with England batting first");
}

/** The ball's probabilities with England's Bazball flag on and off (same state) */
function both(st: TestMatchState): [number[], number[]] {
  const team = st.teams[ENG.id];
  const on = testBallProbs(st, currentInnings(st)!);
  team.bazball = false;
  const off = testBallProbs(st, currentInnings(st)!);
  team.bazball = true;
  return [on, off];
}

describe("Bazball on the mapped player terms", () => {
  it("ships the wicket calibration (x1.11) and leaves the scoring classes as fitted", () => {
    expect(TEST_BAZBALL_CAL.wickets).toBeCloseTo(1.11, 6);
    expect(TEST_BAZBALL_CAL.runs).toBe(1);
  });

  it("England's ball: the wicket class moves by the fitted factor times the calibration, the scoring classes by the fitted factor", () => {
    const [pb, pp] = both(englandBatting());
    TEST_OUTCOMES.forEach((k, i) => {
      const want = (BAZ[k] ?? 1) * (k === "W" ? TEST_BAZBALL_CAL.wickets : ["1", "2", "3", "4", "6"].includes(k) ? TEST_BAZBALL_CAL.runs : 1);
      expect(pb[i] / pp[i]).toBeCloseTo(want, 6);
    });
  });

  it("a side without the factor is untouched by the calibration", () => {
    const keep = TEST_BAZBALL_CAL.wickets;
    const st = englandBatting();
    st.teams[ENG.id].bazball = false;
    const before = testBallProbs(st, currentInnings(st)!);
    TEST_BAZBALL_CAL.wickets = 2;
    try {
      expect(testBallProbs(st, currentInnings(st)!)).toEqual(before);
    } finally { TEST_BAZBALL_CAL.wickets = keep; }
  });
});
