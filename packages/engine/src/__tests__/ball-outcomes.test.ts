import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  determineDismissalType,
  isCatchDropped,
  determineWideType,
  runsOffWide,
  runsOffNoBall,
  isFreeHitBall,
  canBeDismissedOnFreeHit,
  checkRunOut,
  checkOverthrow,
  checkMidMatchInjury,
  determineInjuryResponse,
  isLikeForLikeReplacement,
  processDRSReview,
} from "../ball-outcomes.js";
import type { DismissalType, WideType, MatchInjuryType } from "../ball-outcomes.js";

// ── Helper: run a function many times and collect results ─────────────
function sample<T>(fn: () => T, n: number): T[] {
  return Array.from({ length: n }, () => fn());
}

function countOccurrences<T>(arr: T[], value: T): number {
  return arr.filter(v => v === value).length;
}

// ── determineDismissalType ────────────────────────────────────────────

describe("determineDismissalType", () => {
  const baseParams = {
    bowlingStyle: "right-arm-fast" as const,
    batterRunning: 60,
    fieldingQuality: 70,
    isSpinner: false,
    batterRuns: 10,
  };

  it("returns a valid dismissal type", () => {
    const validTypes: DismissalType[] = [
      "bowled", "caught", "caught-behind", "lbw",
      "run-out", "stumped", "hit-wicket",
    ];
    for (let i = 0; i < 200; i++) {
      const result = determineDismissalType(baseParams);
      expect(validTypes).toContain(result);
    }
  });

  it("all 7 dismissal types can occur", () => {
    const results = sample(() => determineDismissalType(baseParams), 10_000);
    const types = new Set(results);
    expect(types.has("bowled")).toBe(true);
    expect(types.has("caught")).toBe(true);
    expect(types.has("caught-behind")).toBe(true);
    expect(types.has("lbw")).toBe(true);
    expect(types.has("run-out")).toBe(true);
    expect(types.has("stumped")).toBe(true);
    expect(types.has("hit-wicket")).toBe(true);
  });

  it("spinners produce more stumpings than pace", () => {
    const spinResults = sample(
      () => determineDismissalType({ ...baseParams, bowlingStyle: "off-spin", isSpinner: true }),
      10_000,
    );
    const paceResults = sample(
      () => determineDismissalType({ ...baseParams, bowlingStyle: "right-arm-fast", isSpinner: false }),
      10_000,
    );
    const spinStumpings = countOccurrences(spinResults, "stumped");
    const paceStumpings = countOccurrences(paceResults, "stumped");
    expect(spinStumpings).toBeGreaterThan(paceStumpings);
  });

  it("pace produces more caught-behind than spin", () => {
    const paceResults = sample(
      () => determineDismissalType({ ...baseParams, bowlingStyle: "right-arm-fast", isSpinner: false }),
      10_000,
    );
    const spinResults = sample(
      () => determineDismissalType({ ...baseParams, bowlingStyle: "off-spin", isSpinner: true }),
      10_000,
    );
    const paceCB = countOccurrences(paceResults, "caught-behind");
    const spinCB = countOccurrences(spinResults, "caught-behind");
    expect(paceCB).toBeGreaterThan(spinCB);
  });

  it("high fielding quality increases catch/run-out rate", () => {
    const eliteResults = sample(
      () => determineDismissalType({ ...baseParams, fieldingQuality: 95 }),
      10_000,
    );
    const poorResults = sample(
      () => determineDismissalType({ ...baseParams, fieldingQuality: 30 }),
      10_000,
    );
    const eliteCatches = countOccurrences(eliteResults, "caught") + countOccurrences(eliteResults, "caught-behind");
    const poorCatches = countOccurrences(poorResults, "caught") + countOccurrences(poorResults, "caught-behind");
    expect(eliteCatches).toBeGreaterThan(poorCatches);

    const eliteRunOuts = countOccurrences(eliteResults, "run-out");
    const poorRunOuts = countOccurrences(poorResults, "run-out");
    expect(eliteRunOuts).toBeGreaterThan(poorRunOuts);
  });

  it("poor running increases run-out rate", () => {
    const poorRunnerResults = sample(
      () => determineDismissalType({ ...baseParams, batterRunning: 10 }),
      10_000,
    );
    const goodRunnerResults = sample(
      () => determineDismissalType({ ...baseParams, batterRunning: 95 }),
      10_000,
    );
    const poorRunOuts = countOccurrences(poorRunnerResults, "run-out");
    const goodRunOuts = countOccurrences(goodRunnerResults, "run-out");
    expect(poorRunOuts).toBeGreaterThan(goodRunOuts);
  });

  it("set batters (30+ runs) are less likely run out", () => {
    const newBatterResults = sample(
      () => determineDismissalType({ ...baseParams, batterRuns: 5 }),
      10_000,
    );
    const setBatterResults = sample(
      () => determineDismissalType({ ...baseParams, batterRuns: 50 }),
      10_000,
    );
    const newRunOuts = countOccurrences(newBatterResults, "run-out");
    const setRunOuts = countOccurrences(setBatterResults, "run-out");
    expect(newRunOuts).toBeGreaterThan(setRunOuts);
  });
});

// ── isCatchDropped ────────────────────────────────────────────────────

describe("isCatchDropped", () => {
  it("base drop rate is around 8% for average fielders", () => {
    const results = sample(
      () => isCatchDropped({ fieldingQuality: 70, matchPressure: 0, isEdge: false }),
      10_000,
    );
    const dropRate = countOccurrences(results, true) / results.length;
    // With fieldingQuality=70: dropChance = 0.08 * (30/30) * 1 = 0.08, so expect ~8%
    expect(dropRate).toBeGreaterThan(0.03);
    expect(dropRate).toBeLessThan(0.15);
  });

  it("elite fielders (90+) rarely drop catches", () => {
    const results = sample(
      () => isCatchDropped({ fieldingQuality: 95, matchPressure: 0, isEdge: false }),
      10_000,
    );
    const dropRate = countOccurrences(results, true) / results.length;
    // With fieldingQuality=95: dropChance = 0.08 * (5/30) = ~0.013, clamped to 0.02
    expect(dropRate).toBeLessThan(0.05);
  });

  it("pressure increases drop rate", () => {
    const noPressure = sample(
      () => isCatchDropped({ fieldingQuality: 60, matchPressure: 0, isEdge: false }),
      10_000,
    );
    const highPressure = sample(
      () => isCatchDropped({ fieldingQuality: 60, matchPressure: 1.0, isEdge: false }),
      10_000,
    );
    const noPressureRate = countOccurrences(noPressure, true) / noPressure.length;
    const highPressureRate = countOccurrences(highPressure, true) / highPressure.length;
    expect(highPressureRate).toBeGreaterThan(noPressureRate);
  });

  it("edge catches are harder to hold", () => {
    const normal = sample(
      () => isCatchDropped({ fieldingQuality: 60, matchPressure: 0.3, isEdge: false }),
      10_000,
    );
    const edge = sample(
      () => isCatchDropped({ fieldingQuality: 60, matchPressure: 0.3, isEdge: true }),
      10_000,
    );
    const normalRate = countOccurrences(normal, true) / normal.length;
    const edgeRate = countOccurrences(edge, true) / edge.length;
    expect(edgeRate).toBeGreaterThan(normalRate);
  });
});

// ── determineWideType ─────────────────────────────────────────────────

describe("determineWideType", () => {
  it("pace in death overs produces mostly down-leg", () => {
    const results = sample(
      () => determineWideType("right-arm-fast", 18),
      5_000,
    );
    const downLeg = countOccurrences(results, "down-leg");
    // 70% should be down-leg
    expect(downLeg / results.length).toBeGreaterThan(0.55);
  });

  it("spin produces mostly outside-off", () => {
    const results = sample(
      () => determineWideType("off-spin", 10),
      5_000,
    );
    const outsideOff = countOccurrences(results, "outside-off");
    // 60% should be outside-off
    expect(outsideOff / results.length).toBeGreaterThan(0.45);
  });

  it("returns valid wide types", () => {
    const validTypes: WideType[] = ["down-leg", "outside-off", "bouncer-wide"];
    for (let i = 0; i < 500; i++) {
      expect(validTypes).toContain(determineWideType("right-arm-fast", 10));
      expect(validTypes).toContain(determineWideType("off-spin", 5));
    }
  });
});

// ── runsOffWide / runsOffNoBall ───────────────────────────────────────

describe("runsOffWide", () => {
  it("returns 0-4 runs", () => {
    const results = sample(runsOffWide, 2_000);
    for (const r of results) {
      expect([0, 1, 2, 4]).toContain(r);
    }
  });

  it("most common is 0 additional runs", () => {
    const results = sample(runsOffWide, 2_000);
    const zeros = countOccurrences(results, 0);
    // Should be ~70%
    expect(zeros / results.length).toBeGreaterThan(0.55);
  });
});

describe("runsOffNoBall", () => {
  it("returns 0, 1, 4, or 6 runs", () => {
    const results = sample(runsOffNoBall, 2_000);
    for (const r of results) {
      expect([0, 1, 4, 6]).toContain(r);
    }
  });

  it("most common is 0 additional runs", () => {
    const results = sample(runsOffNoBall, 2_000);
    const zeros = countOccurrences(results, 0);
    // Should be ~55%
    expect(zeros / results.length).toBeGreaterThan(0.40);
  });
});

// ── Free Hit ──────────────────────────────────────────────────────────

describe("isFreeHitBall", () => {
  it("free hit only follows a no-ball", () => {
    expect(isFreeHitBall(true)).toBe(true);
    expect(isFreeHitBall(false)).toBe(false);
  });
});

describe("canBeDismissedOnFreeHit", () => {
  it("only run-out dismissals valid on free hit", () => {
    expect(canBeDismissedOnFreeHit("run-out")).toBe(true);
    expect(canBeDismissedOnFreeHit("bowled")).toBe(false);
    expect(canBeDismissedOnFreeHit("caught")).toBe(false);
    expect(canBeDismissedOnFreeHit("caught-behind")).toBe(false);
    expect(canBeDismissedOnFreeHit("lbw")).toBe(false);
    expect(canBeDismissedOnFreeHit("stumped")).toBe(false);
    expect(canBeDismissedOnFreeHit("hit-wicket")).toBe(false);
  });
});

// ── checkRunOut ───────────────────────────────────────────────────────

describe("checkRunOut", () => {
  const baseParams = {
    runsAttempted: 1,
    batterRunning: 60,
    nonStrikerRunning: 60,
    fieldingQuality: 70,
  };

  it("returns false when 0 runs attempted", () => {
    const results = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 0 }),
      1_000,
    );
    expect(countOccurrences(results, true)).toBe(0);
  });

  it("singles rarely cause run outs", () => {
    const results = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 1 }),
      10_000,
    );
    const runOutRate = countOccurrences(results, true) / results.length;
    expect(runOutRate).toBeLessThan(0.03);
  });

  it("twos and threes have increasing risk", () => {
    const singlesRO = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 1 }),
      10_000,
    );
    const twosRO = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 2 }),
      10_000,
    );
    const threesRO = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 3 }),
      10_000,
    );

    const singleRate = countOccurrences(singlesRO, true) / singlesRO.length;
    const twoRate = countOccurrences(twosRO, true) / twosRO.length;
    const threeRate = countOccurrences(threesRO, true) / threesRO.length;

    expect(twoRate).toBeGreaterThan(singleRate);
    expect(threeRate).toBeGreaterThan(twoRate);
  });

  it("good running reduces risk", () => {
    const goodRunner = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 2, batterRunning: 90, nonStrikerRunning: 90 }),
      10_000,
    );
    const poorRunner = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 2, batterRunning: 20, nonStrikerRunning: 20 }),
      10_000,
    );
    const goodRate = countOccurrences(goodRunner, true) / goodRunner.length;
    const poorRate = countOccurrences(poorRunner, true) / poorRunner.length;
    expect(poorRate).toBeGreaterThan(goodRate);
  });

  it("good fielding increases risk", () => {
    const goodFielding = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 2, fieldingQuality: 90 }),
      10_000,
    );
    const poorFielding = sample(
      () => checkRunOut({ ...baseParams, runsAttempted: 2, fieldingQuality: 30 }),
      10_000,
    );
    const goodRate = countOccurrences(goodFielding, true) / goodFielding.length;
    const poorRate = countOccurrences(poorFielding, true) / poorFielding.length;
    expect(goodRate).toBeGreaterThan(poorRate);
  });

  it("respects injected RNG for deterministic run-out checks", () => {
    expect(checkRunOut({ ...baseParams, runsAttempted: 3, rng: () => 0 })).toBe(true);
    expect(checkRunOut({ ...baseParams, runsAttempted: 3, rng: () => 0.999 })).toBe(false);
  });
});

// ── checkOverthrow ────────────────────────────────────────────────────

describe("checkOverthrow", () => {
  it("is a rare event", () => {
    const results = sample(() => checkOverthrow(70), 10_000);
    const happened = results.filter(r => r.happened).length;
    expect(happened / results.length).toBeLessThan(0.02);
  });

  it("poor fielding increases chance", () => {
    const poorField = sample(() => checkOverthrow(20), 10_000);
    const eliteField = sample(() => checkOverthrow(90), 10_000);
    const poorRate = poorField.filter(r => r.happened).length / poorField.length;
    const eliteRate = eliteField.filter(r => r.happened).length / eliteField.length;
    expect(poorRate).toBeGreaterThan(eliteRate);
  });

  it("gives 4 extra runs when overthrow happens", () => {
    const results = sample(() => checkOverthrow(20), 10_000);
    const overthrows = results.filter(r => r.happened);
    for (const ot of overthrows) {
      expect(ot.extraRuns).toBe(4);
    }
  });

  it("gives 0 extra runs when no overthrow", () => {
    const results = sample(() => checkOverthrow(70), 10_000);
    const noOverthrows = results.filter(r => !r.happened);
    for (const r of noOverthrows) {
      expect(r.extraRuns).toBe(0);
    }
  });
});

// ── checkMidMatchInjury ───────────────────────────────────────────────

describe("checkMidMatchInjury", () => {
  const baseParams = {
    playerAge: 25,
    isBowling: false,
    oversBowled: 0,
    isSprinting: false,
  };

  it("very rare per ball", () => {
    const results = sample(() => checkMidMatchInjury(baseParams), 10_000);
    const injuries = results.filter(r => r !== null).length;
    // 0.1% for young non-bowling non-sprinting = ~10 in 10000
    expect(injuries / results.length).toBeLessThan(0.05);
  });

  it("bowlers more likely than batters", () => {
    const bowlerResults = sample(
      () => checkMidMatchInjury({ ...baseParams, isBowling: true, oversBowled: 2 }),
      100_000,
    );
    const batterResults = sample(
      () => checkMidMatchInjury({ ...baseParams, isBowling: false }),
      100_000,
    );
    const bowlerInjuries = bowlerResults.filter(r => r !== null).length;
    const batterInjuries = batterResults.filter(r => r !== null).length;
    // Bowler base rate (0.0005) is 5x higher than batter (0.0001)
    expect(bowlerInjuries).toBeGreaterThan(batterInjuries);
  });

  it("age increases risk", () => {
    const youngResults = sample(
      () => checkMidMatchInjury({ ...baseParams, playerAge: 22, isBowling: true, oversBowled: 2 }),
      100_000,
    );
    const oldResults = sample(
      () => checkMidMatchInjury({ ...baseParams, playerAge: 36, isBowling: true, oversBowled: 2 }),
      100_000,
    );
    const youngInjuries = youngResults.filter(r => r !== null).length;
    const oldInjuries = oldResults.filter(r => r !== null).length;
    expect(oldInjuries).toBeGreaterThan(youngInjuries);
  });

  it("returns injury type when injury occurs", () => {
    const validTypes: MatchInjuryType[] = [
      "hamstring", "side-strain", "groin", "concussion", "finger", "ankle",
    ];
    // Force high probability scenario
    const results = sample(
      () => checkMidMatchInjury({
        playerAge: 37,
        isBowling: true,
        oversBowled: 4,
        isSprinting: true,
      }),
      10_000,
    );
    const injuries = results.filter(r => r !== null);
    expect(injuries.length).toBeGreaterThan(0);
    for (const inj of injuries) {
      expect(inj!.injured).toBe(true);
      expect(validTypes).toContain(inj!.type);
    }
  });
});

// ── determineInjuryResponse ───────────────────────────────────────────

describe("determineInjuryResponse", () => {
  it("concussion always returns concussion-sub", () => {
    // Test both batting and bowling
    for (let i = 0; i < 50; i++) {
      expect(determineInjuryResponse("concussion", true)).toBe("concussion-sub");
      expect(determineInjuryResponse("concussion", false)).toBe("concussion-sub");
    }
  });

  it("hamstring/groin for batters returns retired-hurt", () => {
    for (let i = 0; i < 50; i++) {
      expect(determineInjuryResponse("hamstring", true)).toBe("retired-hurt");
      expect(determineInjuryResponse("groin", true)).toBe("retired-hurt");
    }
  });

  it("hamstring/groin for bowlers returns bowling-breakdown", () => {
    for (let i = 0; i < 50; i++) {
      expect(determineInjuryResponse("hamstring", false)).toBe("bowling-breakdown");
      expect(determineInjuryResponse("groin", false)).toBe("bowling-breakdown");
    }
  });

  it("ankle for batters returns retired-hurt", () => {
    for (let i = 0; i < 50; i++) {
      expect(determineInjuryResponse("ankle", true)).toBe("retired-hurt");
    }
  });

  it("side-strain for batters can be retired-hurt or continues", () => {
    const results = sample(
      () => determineInjuryResponse("side-strain", true),
      200,
    );
    const retiredHurt = countOccurrences(results, "retired-hurt");
    const continues = countOccurrences(results, "continues");
    expect(retiredHurt).toBeGreaterThan(0);
    expect(continues).toBeGreaterThan(0);
  });

  it("side-strain for bowlers returns bowling-breakdown", () => {
    for (let i = 0; i < 50; i++) {
      expect(determineInjuryResponse("side-strain", false)).toBe("bowling-breakdown");
    }
  });

  it("uses injected RNG for borderline batter injury calls", () => {
    expect(determineInjuryResponse("side-strain", true, () => 0.2)).toBe("retired-hurt");
    expect(determineInjuryResponse("side-strain", true, () => 0.8)).toBe("continues");
  });
});

// ── isLikeForLikeReplacement ──────────────────────────────────────────

describe("isLikeForLikeReplacement", () => {
  it("same role is valid replacement", () => {
    expect(isLikeForLikeReplacement("batsman", "batsman")).toBe(true);
    expect(isLikeForLikeReplacement("bowler", "bowler")).toBe(true);
    expect(isLikeForLikeReplacement("all-rounder", "all-rounder")).toBe(true);
  });

  it("all-rounder can replace anyone", () => {
    expect(isLikeForLikeReplacement("batsman", "all-rounder")).toBe(true);
    expect(isLikeForLikeReplacement("bowler", "all-rounder")).toBe(true);
  });

  it("anyone can replace an all-rounder", () => {
    expect(isLikeForLikeReplacement("all-rounder", "batsman")).toBe(true);
    expect(isLikeForLikeReplacement("all-rounder", "bowler")).toBe(true);
  });

  it("batter cannot replace bowler", () => {
    expect(isLikeForLikeReplacement("bowler", "batsman")).toBe(false);
  });

  it("bowler cannot replace batter", () => {
    expect(isLikeForLikeReplacement("batsman", "bowler")).toBe(false);
  });
});

// ── processDRSReview ──────────────────────────────────────────────────

describe("processDRSReview", () => {
  it("no review when 0 reviews remaining", () => {
    const result = processDRSReview({ dismissalType: "lbw", reviewsRemaining: 0 });
    expect(result.reviewed).toBe(false);
    expect(result.overturned).toBe(false);
    expect(result.reviewsRemaining).toBe(0);
  });

  it("LBW has meaningful overturn chance (~35%)", () => {
    const results = sample(
      () => processDRSReview({ dismissalType: "lbw", reviewsRemaining: 2 }),
      10_000,
    );
    const reviewed = results.filter(r => r.reviewed);
    expect(reviewed.length).toBe(results.length); // all LBW should be reviewed
    const overturned = reviewed.filter(r => r.overturned);
    const overturnRate = overturned.length / reviewed.length;
    expect(overturnRate).toBeGreaterThan(0.20);
    expect(overturnRate).toBeLessThan(0.50);
  });

  it("non-reviewable dismissals return reviewed: false", () => {
    const nonReviewable: DismissalType[] = ["bowled", "caught", "run-out", "hit-wicket"];
    for (const type of nonReviewable) {
      const result = processDRSReview({ dismissalType: type, reviewsRemaining: 2 });
      expect(result.reviewed).toBe(false);
      expect(result.overturned).toBe(false);
      expect(result.reviewsRemaining).toBe(2);
    }
  });

  it("umpire's call retains review", () => {
    const results = sample(
      () => processDRSReview({ dismissalType: "lbw", reviewsRemaining: 1 }),
      10_000,
    );
    const umpiresCallResults = results.filter(r => r.umpiresCall);
    expect(umpiresCallResults.length).toBeGreaterThan(0);
    for (const r of umpiresCallResults) {
      expect(r.reviewed).toBe(true);
      expect(r.overturned).toBe(false);
      expect(r.reviewsRemaining).toBe(1); // review retained
    }
  });

  it("overturned review retains review count", () => {
    const results = sample(
      () => processDRSReview({ dismissalType: "lbw", reviewsRemaining: 1 }),
      10_000,
    );
    const overturned = results.filter(r => r.overturned);
    expect(overturned.length).toBeGreaterThan(0);
    for (const r of overturned) {
      expect(r.reviewsRemaining).toBe(1);
    }
  });

  it("unsuccessful review reduces review count by 1", () => {
    const results = sample(
      () => processDRSReview({ dismissalType: "lbw", reviewsRemaining: 2 }),
      10_000,
    );
    const unsuccessful = results.filter(r => r.reviewed && !r.overturned && !r.umpiresCall);
    expect(unsuccessful.length).toBeGreaterThan(0);
    for (const r of unsuccessful) {
      expect(r.reviewsRemaining).toBe(1);
    }
  });

  it("caught-behind is reviewable", () => {
    const results = sample(
      () => processDRSReview({ dismissalType: "caught-behind", reviewsRemaining: 1 }),
      5_000,
    );
    const reviewed = results.filter(r => r.reviewed);
    expect(reviewed.length).toBe(results.length);
    const overturned = reviewed.filter(r => r.overturned);
    expect(overturned.length).toBeGreaterThan(0);
  });

  it("stumped is reviewable", () => {
    const results = sample(
      () => processDRSReview({ dismissalType: "stumped", reviewsRemaining: 1 }),
      5_000,
    );
    const reviewed = results.filter(r => r.reviewed);
    expect(reviewed.length).toBe(results.length);
  });

  it("uses injected RNG for deterministic review outcomes", () => {
    expect(processDRSReview({ dismissalType: "lbw", reviewsRemaining: 1, rng: () => 0.2 })).toEqual({
      reviewed: true,
      overturned: true,
      umpiresCall: false,
      reviewsRemaining: 1,
    });
    expect(processDRSReview({ dismissalType: "lbw", reviewsRemaining: 1, rng: () => 0.44 })).toEqual({
      reviewed: true,
      overturned: false,
      umpiresCall: true,
      reviewsRemaining: 1,
    });
  });
});
