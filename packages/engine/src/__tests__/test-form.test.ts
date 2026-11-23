/**
 * The men's Test match form (docs/FORMATS.md, Test section 6.13): each side's strength for the match, drawn from its own seeded
 * stream, shifts its wicket rate while it bats and the opponent's while it bowls. Men only; the rest of the match draws as before.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestMatch, currentInnings, simulateTestMatch, stepTestBall, testBallProbs, TEST_OUTCOMES, type TestMatchState } from "../test-match.js";
import { TEST_FORM } from "../test-level-data.js";
import { testTeam } from "./test-squads.js";

vi.setConfig({ testTimeout: 120_000 });

function withForm<T>(sd: number, f: () => T): T {
  const keep = TEST_FORM.sd;
  TEST_FORM.sd = sd;
  try { return f(); } finally { TEST_FORM.sd = keep; }
}

const start = (gender: "male" | "female", seed = 7): TestMatchState =>
  createTestMatch(testTeam("India", gender), testTeam("England", gender), { seed, country: "IND", gender });

describe("the men's Test match form", () => {
  it("ships sd 0.1 (fitted on the men's Tests of 2023-24 with the XIs that played)", () => {
    expect(TEST_FORM.sd).toBeCloseTo(0.1, 9);
  });

  it("each men's side draws its own form, seeded; the weather, pitch, wear and toss draw as with it off", () => {
    const on = start("male"), off = withForm(0, () => start("male"));
    const again = start("male");
    const f = on.teamOrder.map(id => on.teams[id].form!);
    expect(f.every(x => Number.isFinite(x) && x !== 0)).toBe(true);
    expect(f[0]).not.toBe(f[1]);
    expect(again.teamOrder.map(id => again.teams[id].form)).toEqual(f);
    expect(off.teamOrder.map(id => off.teams[id].form)).toEqual([undefined, undefined]);
    expect(on.cond).toEqual(off.cond);
    expect(on.dayPlan).toEqual(off.dayPlan);
    expect(on.wear).toBe(off.wear);
    expect(on.toss).toEqual(off.toss);
    expect(on.rng).toBe(off.rng);
  });

  it("the batting side's wicket rate is x exp(-form bat + form bowl - sd^2); every other class untouched", () => {
    const st = start("male");
    for (let b = 0; b < 5; b++) stepTestBall(st);
    const inn = currentInnings(st)!;
    const on = testBallProbs(st, inn);
    const keep = st.teamOrder.map(id => st.teams[id].form);
    for (const id of st.teamOrder) delete st.teams[id].form;
    const off = testBallProbs(st, inn);
    st.teamOrder.forEach((id, k) => { st.teams[id].form = keep[k]; });
    const want = Math.exp(-st.teams[inn.battingTeamId].form! + st.teams[inn.bowlingTeamId].form! - TEST_FORM.sd ** 2);
    TEST_OUTCOMES.forEach((k, i) => expect(on[i] / off[i]).toBeCloseTo(k === "W" ? want : 1, 9));
  });

  it("women's Tests draw no form and their balls are untouched", () => {
    const st = start("female");
    expect(st.teamOrder.map(id => st.teams[id].form)).toEqual([undefined, undefined]);
    for (let b = 0; b < 5; b++) stepTestBall(st);
    const p = testBallProbs(st, currentInnings(st)!);
    expect(withForm(0.5, () => testBallProbs(st, currentInnings(st)!))).toEqual(p);
    expect(withForm(0, () => start("female")).rng).toBe(start("female").rng);
  });

  it("over seeded Tests the forms are centred with the fitted spread, and the mean wicket multiplier is 1", () => {
    const fs: number[] = [];
    let mult = 0;
    for (let i = 0; i < 400; i++) {
      const st = start("male", 50_000 + i);
      const [a, b] = st.teamOrder.map(id => st.teams[id].form!);
      fs.push(a, b);
      mult += Math.exp(-a + b - TEST_FORM.sd ** 2);
    }
    const mean = fs.reduce((s, x) => s + x, 0) / fs.length;
    const sd = Math.sqrt(fs.reduce((s, x) => s + (x - mean) ** 2, 0) / fs.length);
    expect(Math.abs(mean)).toBeLessThan(0.012);
    expect(sd / TEST_FORM.sd).toBeGreaterThan(0.9);
    expect(sd / TEST_FORM.sd).toBeLessThan(1.1);
    expect(mult / 400).toBeGreaterThan(0.98);
    expect(mult / 400).toBeLessThan(1.02);
  });

  it("form moves the margin: over the same seeded Tests, the side in better form wins more often", () => {
    let better = 0, decided = 0;
    for (let i = 0; i < 40; i++) {
      const r = simulateTestMatch(testTeam("India"), testTeam("England"), { seed: 60_000 + i, country: "IND" });
      const st = r.state;
      if (r.result.kind !== "win") continue;
      decided++;
      const [a, b] = st.teamOrder;
      const fav = st.teams[a].form! > st.teams[b].form! ? a : b;
      if (r.result.winnerId === fav) better++;
    }
    expect(decided).toBeGreaterThan(25);
    expect(better / decided).toBeGreaterThan(0.5);
  });
});
