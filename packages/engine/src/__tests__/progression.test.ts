import { describe, it, expect } from "vitest";
import cohorts from "./fixtures/progression-cohort.json";
import { validateCohort, formatValidation, type Cohort } from "../progression-validation.js";
import {
  sampleChange, expectedChange, changeSd, retirementProbability, sampleResidual, interp, type ProgressionState,
} from "../progression.js";
import { projectPlayer, simulateCareer } from "../progression-sim.js";
import { generatePlayers, generatePlayer, roleClassOfPlayer } from "../player-generator.js";
import { Player, type PlayerData } from "../player.js";
import { createRNG } from "../rng.js";
import { retirementRole } from "../progression.js";

const state = (over: Partial<ProgressionState> = {}): ProgressionState => ({
  gender: "male", age: 25, experience: 5,
  bat: { ovr: 65, regular: true, kind: "middle" }, bowl: { ovr: 40, regular: false, kind: "pace" }, ...over,
});

describe("progression model: validation against what actually happened", () => {
  // Men from 2015 (10 seasons forward), women from 2018 (8): real states simulated forward with Player.progress()
  // and the fitted retirement hazard, compared with the real later ratings (net of the rating scale's calendar drift)
  const men = validateCohort(cohorts.male as unknown as Cohort, { runs: 25, seed: 11 });
  const women = validateCohort(cohorts.female as unknown as Cohort, { runs: 25, seed: 12 });

  it("men: share still playing, ratings level and spread match at 1, 3, 5 and 8 seasons", () => {
    for (const { real, sim } of men.horizons) {
      expect(Math.abs(sim.active - real.active)).toBeLessThan(0.07);
      expect(Math.abs(sim.level.mean - real.level.mean)).toBeLessThan(2.5);
      expect(sim.level.sd / real.level.sd).toBeGreaterThan(0.85);
      expect(sim.level.sd / real.level.sd).toBeLessThan(1.15);
    }
  });

  it("men: share who improve, breakouts and collapses match", () => {
    for (const { real, sim } of men.horizons) {
      expect(Math.abs(sim.improved - real.improved)).toBeLessThan(0.1);
      expect(Math.abs(sim.change.mean - real.change.mean)).toBeLessThan(1.2);
    }
    const five = men.horizons[2];
    expect(Math.abs(five.sim.breakout - five.real.breakout)).toBeLessThan(0.06);
    expect(Math.abs(five.sim.collapse - five.real.collapse)).toBeLessThan(0.06);
  });

  it("men: peak age and retirement ages by role match", () => {
    expect(Math.abs(men.peakAge.sim.mean - men.peakAge.real.mean)).toBeLessThan(1.5);
    for (const [role, v] of Object.entries(men.retirementAge)) {
      if (v.real.n < 30) continue;
      expect(Math.abs(v.sim.p50 - v.real.p50), `${role} median last regular season`).toBeLessThanOrEqual(1.5);
    }
  });

  it("women: survival, level, spread and peak age are in the right range", () => {
    for (const { real, sim } of women.horizons) {
      expect(Math.abs(sim.active - real.active)).toBeLessThan(0.15);
      expect(Math.abs(sim.level.mean - real.level.mean)).toBeLessThan(3);
      expect(sim.level.sd / real.level.sd).toBeGreaterThan(0.8);
      expect(sim.level.sd / real.level.sd).toBeLessThan(1.25);
    }
    expect(Math.abs(women.peakAge.sim.mean - women.peakAge.real.mean)).toBeLessThan(2);
  });

  it("prints a readable comparison", () => {
    expect(formatValidation(men)).toContain("male cohort");
  });
});

describe("progression model: shape", () => {
  it("regresses to the mean: an outlier rating is pulled back and a weak one up", () => {
    expect(expectedChange("bat", "male", state({ bat: { ovr: 92, regular: true, kind: "middle" } })))
      .toBeLessThan(expectedChange("bat", "male", state({ bat: { ovr: 65, regular: true, kind: "middle" } })));
    expect(expectedChange("bat", "male", state({ bat: { ovr: 40, regular: true, kind: "middle" } })))
      .toBeGreaterThan(expectedChange("bat", "male", state({ bat: { ovr: 65, regular: true, kind: "middle" } })));
  });

  it("a big jump partly gives back (negative momentum)", () => {
    const flat = expectedChange("bat", "male", state({ bat: { ovr: 70, prevOvr: 70, regular: true, kind: "middle" } }));
    const jumped = expectedChange("bat", "male", state({ bat: { ovr: 70, prevOvr: 58, regular: true, kind: "middle" } }));
    expect(jumped).toBeLessThan(flat);
  });

  it("new players move more than established ones; the young more than the old", () => {
    expect(changeSd("bat", "male", state({ experience: 1 }))).toBeGreaterThan(changeSd("bat", "male", state({ experience: 12 })));
    expect(changeSd("bat", "male", state({ age: 20, experience: 4 }))).toBeGreaterThan(changeSd("bat", "male", state({ age: 36, experience: 4 })));
  });

  it("secondary disciplines move less than the one a player is picked for", () => {
    const s = state();
    expect(changeSd("bowl", "male", s)).toBeLessThan(changeSd("bat", "male", s));
  });

  it("outcomes have fat tails: breakouts and collapses of 3+ sd happen at a realistic, small rate", () => {
    const rng = createRNG(3);
    const zs = Array.from({ length: 20000 }, () => sampleResidual("bat", rng));
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    const sd = Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.93);
    expect(sd).toBeLessThan(1.07);
    const tail = zs.filter(z => Math.abs(z) > 3).length / zs.length;
    expect(tail).toBeGreaterThan(0.002); // a normal would give 0.0027; real changes are fatter
    expect(tail).toBeLessThan(0.03);
  });

  it("sampleChange is deterministic for a seed", () => {
    expect(sampleChange("bat", state(), createRNG(9))).toBe(sampleChange("bat", state(), createRNG(9)));
  });

  it("retirement hazard rises with age, falls with quality, and is a probability", () => {
    const at = (age: number, overall = 65, role: "bat" | "pace" | "spin" | "allround" = "bat") => retirementProbability({ age, overall, role });
    expect(at(24)).toBeLessThan(at(33));
    expect(at(33)).toBeLessThan(at(38));
    expect(at(30, 85)).toBeLessThan(at(30, 45));
    for (let age = 16; age <= 45; age++) {
      const p = at(age);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
    expect(interp([0, 10], [0, 100], 5)).toBe(50);
  });
});

describe("Player.progress with the fitted model", () => {
  it("keeps history, experience and potential-driven growth", () => {
    const rng = createRNG(21);
    const prospects = generatePlayers(60, rng, { kind: "youth", country: "India" }, "t");
    const before = prospects.map(p => p.potential!);
    const high = prospects.filter(p => p.potential! >= 70);
    expect(before.every(x => x >= 30 && x <= 99)).toBe(true);
    for (const p of prospects) for (let k = 0; k < 8; k++) p.progress({ rng, seasonNumber: k + 1 });
    expect(prospects[0].ratingHistory).toHaveLength(8);
    expect(prospects[0].experience).toBeGreaterThanOrEqual(9);
    const mean = (ps: Player[]) => ps.reduce((a, p) => a + p.overall, 0) / ps.length;
    // those who were promised more end up better
    const low = prospects.filter(p => p.potential! <= 62);
    expect(mean(high)).toBeGreaterThan(mean(low) + 3);
  });

  it("projectPlayer: seeded, ordered bands, shrinking active share", () => {
    const p = generatePlayer(createRNG(5), { kind: "fill", age: 31, roleClass: "pace" });
    const data: PlayerData = p.toJSON();
    const a = projectPlayer(data, { seasons: 8, runs: 150, seed: 4 });
    const b = projectPlayer(data, { seasons: 8, runs: 150, seed: 4 });
    expect(a).toEqual(b);
    expect(a[0].active).toBeGreaterThan(a[7].active);
    for (const pt of a) {
      if (pt.active === 0) continue;
      expect(pt.overall.p10).toBeLessThanOrEqual(pt.overall.p50);
      expect(pt.overall.p50).toBeLessThanOrEqual(pt.overall.p90);
    }
    expect(simulateCareer(data, 5, createRNG(1)).length).toBe(5);
  });
});

describe("20-season career sim stays balanced", () => {
  for (const gender of ["male", "female"] as const) {
    it(`${gender}: league average ratings do not drift up or down`, () => {
      const rng = createRNG(gender === "male" ? 101 : 202);
      let pool = generatePlayers(500, rng, { kind: "pool", gender, country: "India" }, "init");
      const top = (ps: Player[]) => {
        const best = [...ps].sort((a, b) => b.overall - a.overall).slice(0, 150);
        return best.reduce((a, p) => a + p.overall, 0) / best.length;
      };
      const all = (ps: Player[]) => ps.reduce((a, p) => a + p.overall, 0) / ps.length;
      const sd = (ps: Player[]) => { const m = all(ps); return Math.sqrt(ps.reduce((a, p) => a + (p.overall - m) ** 2, 0) / ps.length); };
      const fld = (ps: Player[]) => { const v = ps.filter(p => typeof p.ratings.fielding === "number"); return v.reduce((a, p) => a + p.ratings.fielding!, 0) / v.length; };
      const startFielding = fld(pool);
      const start = { all: all(pool), top: top(pool), sd: sd(pool), age: pool.reduce((a, p) => a + p.age, 0) / pool.length };
      for (let season = 1; season <= 20; season++) {
        const next: Player[] = [];
        const retired: Player[] = [];
        for (const p of pool) {
          let prob = retirementProbability({ age: p.age, overall: p.overall, gender, role: retirementRole(p.bowlingStyle, p.role) });
          if (p.age < 30) prob *= 0.5;
          if (rng() < prob) { retired.push(p); continue; }
          p.progress({ rng, gender, seasonNumber: season });
          next.push(p);
        }
        const regens = retired.map((r, i) => generatePlayer(rng, { kind: "regen", gender, country: r.country, roleClass: roleClassOfPlayer(r), id: `s${season}_r${i}` }));
        pool = [...next, ...regens, ...generatePlayers(6, rng, { kind: "youth", gender, country: "India" }, `s${season}_y`)];
      }
      const end = { all: all(pool), top: top(pool), sd: sd(pool), age: pool.reduce((a, p) => a + p.age, 0) / pool.length };
      expect(Math.abs(end.all - start.all)).toBeLessThan(2.5);
      expect(Math.abs(end.top - start.top)).toBeLessThan(2.5);
      // the spread narrows a little (about 15%): the youngest entrants are rated from little data and sit closer together
      expect(end.sd / start.sd).toBeGreaterThan(0.78);
      expect(end.sd / start.sd).toBeLessThan(1.2);
      // fielding: the youth prior and the decline from 28 balance against retirement and the regens' draws
      expect(Math.abs(fld(pool) - startFielding)).toBeLessThan(2);
      expect(Math.abs(end.age - start.age)).toBeLessThan(3.5); // the fitted hazards settle a young starting pool (women: mean age 26) near 28
    });
  }
});
