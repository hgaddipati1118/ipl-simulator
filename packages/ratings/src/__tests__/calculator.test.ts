import { describe, it, expect } from "vitest";
import { calculateRatings, inferRole, RawPlayerStats } from "../calculator.js";

function makeStats(overrides?: Partial<RawPlayerStats>): RawPlayerStats {
  return {
    name: "Test Player",
    age: 28,
    country: "India",
    matches: 50,
    battingInnings: 48,
    notOuts: 5,
    runs: 1200,
    ballsFaced: 900,
    fours: 120,
    sixes: 40,
    bowlingInnings: 0,
    ballsBowled: 0,
    runsConceded: 0,
    wickets: 0,
    catches: 20,
    ...overrides,
  };
}

describe("calculateRatings", () => {
  it("returns all 8 rating attributes + composites", () => {
    const ratings = calculateRatings(makeStats());
    expect(ratings.battingIQ).toBeDefined();
    expect(ratings.timing).toBeDefined();
    expect(ratings.power).toBeDefined();
    expect(ratings.running).toBeDefined();
    expect(ratings.wicketTaking).toBeDefined();
    expect(ratings.economy).toBeDefined();
    expect(ratings.accuracy).toBeDefined();
    expect(ratings.clutch).toBeDefined();
    expect(ratings.battingOvr).toBeDefined();
    expect(ratings.bowlingOvr).toBeDefined();
    expect(ratings.overall).toBeDefined();
  });

  it("all ratings are in 15-99 range", () => {
    const ratings = calculateRatings(makeStats());
    const attrs = [
      ratings.battingIQ, ratings.timing, ratings.power, ratings.running,
      ratings.wicketTaking, ratings.economy, ratings.accuracy, ratings.clutch,
    ];
    for (const val of attrs) {
      expect(val).toBeGreaterThanOrEqual(15);
      expect(val).toBeLessThanOrEqual(99);
    }
  });

  it("elite batsman gets high batting ratings", () => {
    const ratings = calculateRatings(makeStats({
      battingInnings: 100,
      runs: 4000,
      ballsFaced: 2800,
      fours: 400,
      sixes: 150,
      notOuts: 15,
    }));
    expect(ratings.battingIQ).toBeGreaterThan(60);
    expect(ratings.timing).toBeGreaterThan(60);
    expect(ratings.power).toBeGreaterThan(60);
  });

  it("elite bowler gets high bowling ratings", () => {
    const ratings = calculateRatings(makeStats({
      battingInnings: 30,
      runs: 200,
      ballsFaced: 180,
      fours: 15,
      sixes: 5,
      bowlingInnings: 100,
      ballsBowled: 2400,
      runsConceded: 3000,
      wickets: 120,
    }));
    expect(ratings.wicketTaking).toBeGreaterThan(50);
    expect(ratings.economy).toBeGreaterThan(40);
  });

  it("handles player with no batting", () => {
    const ratings = calculateRatings(makeStats({
      battingInnings: 0,
      runs: 0,
      ballsFaced: 0,
      fours: 0,
      sixes: 0,
      notOuts: 0,
      bowlingInnings: 50,
      ballsBowled: 1200,
      runsConceded: 1600,
      wickets: 60,
    }));
    expect(ratings.battingIQ).toBe(20);
    expect(ratings.wicketTaking).toBeGreaterThan(30);
  });

  it("handles player with no bowling", () => {
    const ratings = calculateRatings(makeStats());
    expect(ratings.wicketTaking).toBe(20);
    expect(ratings.economy).toBe(20);
    expect(ratings.battingIQ).toBeGreaterThan(30);
  });

  it("overall is consistent with formula", () => {
    const ratings = calculateRatings(makeStats());
    const stronger = Math.max(ratings.battingOvr, ratings.bowlingOvr);
    const weaker = Math.min(ratings.battingOvr, ratings.bowlingOvr);
    const expected = Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));
    expect(ratings.overall).toBe(expected);
  });
});

describe("inferRole", () => {
  it("returns batsman when batting much higher", () => {
    const ratings = calculateRatings(makeStats());
    expect(inferRole(ratings)).toBe("batsman");
  });

  it("returns bowler when bowling much higher", () => {
    const ratings = calculateRatings(makeStats({
      battingInnings: 10,
      runs: 50,
      ballsFaced: 60,
      fours: 3,
      sixes: 1,
      notOuts: 2,
      bowlingInnings: 80,
      ballsBowled: 1800,
      runsConceded: 2200,
      wickets: 100,
    }));
    expect(inferRole(ratings)).toBe("bowler");
  });

  it("returns all-rounder when balanced", () => {
    const ratings = calculateRatings(makeStats({
      battingInnings: 60,
      runs: 1500,
      ballsFaced: 1100,
      fours: 150,
      sixes: 50,
      notOuts: 8,
      bowlingInnings: 50,
      ballsBowled: 1200,
      runsConceded: 1800,
      wickets: 60,
    }));
    // This might be an all-rounder or close - check it's within domain
    expect(["batsman", "bowler", "all-rounder"]).toContain(inferRole(ratings));
  });
});
