/**
 * The men's Test level (test-level-data.ts; docs/FORMATS.md, Test section 6.12): multipliers on the men's base rates, fitted on
 * the 2023-24 Tests with the XIs that played. Seeded, so deterministic.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestMatch, currentInnings, simulateTestMatch, stepTestBall, testBallProbs, TEST_OUTCOMES, type TestMatchResult, type TestMatchState } from "../test-match.js";
import { TEST_LEVEL_CAL } from "../test-level-data.js";
import { testTeam } from "./test-squads.js";
import { poolTestTeam } from "./test-pool-squads.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** A Test a few balls in */
function started(gender: "male" | "female"): TestMatchState {
  const st = createTestMatch(testTeam("India", gender), testTeam("England", gender), { seed: 7, country: "IND", gender });
  for (let b = 0; b < 5; b++) stepTestBall(st);
  return st;
}

/** The ball's probabilities at the shipped level and with the level off (same state) */
function withAndWithout(st: TestMatchState): [number[], number[]] {
  const keep = { ...TEST_LEVEL_CAL };
  const on = testBallProbs(st, currentInnings(st)!);
  TEST_LEVEL_CAL.wickets = 1; TEST_LEVEL_CAL.runs = 1;
  try { return [on, testBallProbs(st, currentInnings(st)!)]; } finally { Object.assign(TEST_LEVEL_CAL, keep); }
}

describe("the men's Test level", () => {
  it("ships the 2023-24 fit: wickets x0.96, scoring x0.99", () => {
    expect(TEST_LEVEL_CAL.wickets).toBeCloseTo(0.96, 6);
    expect(TEST_LEVEL_CAL.runs).toBeCloseTo(0.99, 6);
  });

  it("men's ball: the wicket class by the wicket level, the scoring classes by the run level, extras untouched", () => {
    const [on, off] = withAndWithout(started("male"));
    TEST_OUTCOMES.forEach((k, i) => {
      const want = k === "W" ? TEST_LEVEL_CAL.wickets : ["1", "2", "3", "4", "6"].includes(k) ? TEST_LEVEL_CAL.runs : 1;
      expect(on[i] / off[i]).toBeCloseTo(want, 9);
    });
  });

  it("women's Tests are untouched by it", () => {
    const st = started("female");
    const before = testBallProbs(st, currentInnings(st)!);
    const keep = { ...TEST_LEVEL_CAL };
    TEST_LEVEL_CAL.wickets = 2; TEST_LEVEL_CAL.runs = 0.5;
    try { expect(testBallProbs(st, currentInnings(st)!)).toEqual(before); } finally { Object.assign(TEST_LEVEL_CAL, keep); }
  });
});

describe("the level against real men's Tests of 2023-24 (the national squads from the shipped pool, 240 seeded Tests)", () => {
  // real 2023-24 (Cricsheet, 83 men's Tests): 50.3 balls per wicket, 30.1 runs per wicket, 3.59 an over
  const REAL = { bpw: 50.3, rpw: 30.1, rpo: 3.59 };
  const NAMES = ["India", "England", "Australia", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "West Indies"];
  const CODE: Record<string, string> = { India: "IND", England: "ENG", Australia: "AUS", "South Africa": "RSA", "New Zealand": "NZ", Pakistan: "PAK", "Sri Lanka": "SL", "West Indies": "WI" };
  let batch: TestMatchResult[] = [];
  let runs = 0, balls = 0, wkts = 0;
  beforeAll(() => {
    const teams = NAMES.map(n => poolTestTeam(n).team);
    for (let i = 0; i < 240; i++) {
      const h = i % teams.length, a = (h + 1 + Math.floor(i / teams.length) % (teams.length - 1)) % teams.length;
      const eng = [teams[h], teams[a]].find(t => t.name === "England");
      batch.push(simulateTestMatch(teams[h], teams[a], { seed: 90_000 + i, country: CODE[NAMES[h]], ...(eng ? { bazballTeamId: eng.id } : {}) }));
    }
    for (const r of batch) for (const inn of r.state.innings) { runs += inn.runs; balls += inn.legalBalls; wkts += inn.wickets; }
  });

  it("balls per wicket, runs per wicket and the run rate within 5% of real", () => {
    expect(balls / wkts / REAL.bpw).toBeGreaterThan(0.95);
    expect(balls / wkts / REAL.bpw).toBeLessThan(1.05);
    expect(runs / wkts / REAL.rpw).toBeGreaterThan(0.95);
    expect(runs / wkts / REAL.rpw).toBeLessThan(1.05);
    expect((6 * runs) / balls / REAL.rpo).toBeGreaterThan(0.95);
    expect((6 * runs) / balls / REAL.rpo).toBeLessThan(1.05);
  });

  it("the level off takes wickets faster: the fit is what holds balls per wicket up", () => {
    const keep = { ...TEST_LEVEL_CAL };
    TEST_LEVEL_CAL.wickets = 1; TEST_LEVEL_CAL.runs = 1;
    let b = 0, w = 0;
    try {
      const teams = NAMES.slice(0, 4).map(n => poolTestTeam(n).team);
      for (let i = 0; i < 60; i++) {
        const r = simulateTestMatch(teams[i % 4], teams[(i + 1) % 4], { seed: 90_000 + i, country: CODE[NAMES[i % 4]] });
        for (const inn of r.state.innings) { b += inn.legalBalls; w += inn.wickets; }
      }
    } finally { Object.assign(TEST_LEVEL_CAL, keep); }
    let b2 = 0, w2 = 0;
    const teams = NAMES.slice(0, 4).map(n => poolTestTeam(n).team);
    for (let i = 0; i < 60; i++) {
      const r = simulateTestMatch(teams[i % 4], teams[(i + 1) % 4], { seed: 90_000 + i, country: CODE[NAMES[i % 4]] });
      for (const inn of r.state.innings) { b2 += inn.legalBalls; w2 += inn.wickets; }
    }
    expect(b2 / w2).toBeGreaterThan(b / w);
  });

  it("draws and decisive results in range of 2023-24 (9.6% drawn)", () => {
    const draws = batch.filter(r => r.result.kind === "draw").length / batch.length;
    expect(draws).toBeGreaterThan(0.03);
    expect(draws).toBeLessThan(0.18);
  });
});
