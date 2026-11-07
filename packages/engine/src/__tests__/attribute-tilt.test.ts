import { describe, expect, it } from "vitest";
import fixture from "./fixtures/attribute-tilt-cohort.json";
import { Player } from "../player.js";
import { attributeTilt, TILT_WEIGHTS, type TiltedAttribute } from "../attribute-tilt.js";
import { ATTRIBUTE_TILT } from "../attribute-tilt-model.js";
import { createRNG } from "../rng.js";

const BAT: TiltedAttribute[] = ["battingIQ", "timing", "power", "running"];
const BOWL: TiltedAttribute[] = ["wicketTaking", "economy", "accuracy", "clutch"];
const ALL = [...BAT, ...BOWL];

const make = (age: number, id = "t"): Player => new Player({
  id, name: "T", age, country: "India", role: "all-rounder", isInternational: false, injured: false, injuryGamesLeft: 0, bowlingStyle: "off-spin",
  ratings: { battingIQ: 60, timing: 60, power: 60, running: 60, wicketTaking: 60, economy: 60, accuracy: 60, clutch: 60 },
});

describe("per-attribute age tilts", () => {
  it("sum to zero in each discipline's overall at every age, for both genders", () => {
    for (const gender of ["male", "female"] as const) {
      for (let age = 18; age <= 45; age++) {
        expect(BAT.reduce((s, a) => s + TILT_WEIGHTS[a] * attributeTilt(a, age, gender), 0)).toBeCloseTo(0, 2);
        expect(BOWL.reduce((s, a) => s + TILT_WEIGHTS[a] * attributeTilt(a, age, gender), 0)).toBeCloseTo(0, 2);
      }
    }
  });

  it("are small, finite, and flat outside the fitted ages", () => {
    for (const gender of ["male", "female"] as const) {
      for (const a of ALL) {
        for (const age of [16, 20, 28, 34, 40, 50]) {
          const t = attributeTilt(a, age, gender);
          expect(Number.isFinite(t)).toBe(true);
          expect(Math.abs(t)).toBeLessThanOrEqual(1.5);
        }
        expect(attributeTilt(a, 50, gender)).toBe(attributeTilt(a, 40, gender));
        expect(ATTRIBUTE_TILT[gender][a].ageNodes.length).toBe(ATTRIBUTE_TILT[gender][a].tilt.length);
      }
    }
  });

  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const p = make(33);
      const rng = createRNG(seed);
      for (let s = 0; s < 4; s++) p.progress({ rng });
      return JSON.stringify(p.ratings);
    };
    expect(run(8)).toBe(run(8));
    expect(run(8)).not.toBe(run(9));
  });

  // mean change of an attribute relative to its discipline's weighted change over many simulated players, per season
  function simulatedRelative(startAge: number, seasons: number, gender: "male" | "female", n = 1500) {
    const sum: Record<string, number> = {};
    for (const a of ALL) sum[a] = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const p = make(startAge, `s${i}`);
      const rng = createRNG(7000 + i);
      for (let s = 0; s < seasons; s++) {
        const b = { ...p.ratings };
        p.progress({ rng, gender, historyLimit: 1 });
        const dBat = BAT.reduce((acc, a) => acc + TILT_WEIGHTS[a] * (p.ratings[a] - b[a]), 0);
        const dBowl = BOWL.reduce((acc, a) => acc + TILT_WEIGHTS[a] * (p.ratings[a] - b[a]), 0);
        for (const a of BAT) sum[a] += p.ratings[a] - b[a] - dBat;
        for (const a of BOWL) sum[a] += p.ratings[a] - b[a] - dBowl;
        count++;
      }
    }
    for (const a of ALL) sum[a] /= count;
    return sum;
  }

  it("a 34-year-old's running falls faster than his battingIQ, and wicket-taking faster than economy, on average", () => {
    const rel = simulatedRelative(33, 1, "male");
    expect(rel.running).toBeLessThan(rel.battingIQ - 0.1);
    expect(rel.wicketTaking).toBeLessThan(rel.economy);
    // and the real data agree on the direction (34+ band, men)
    const real = (fixture as Record<string, Record<string, { group: string; mean: number }[]>>).male;
    const at = (a: string, g: string) => real[a].find(x => x.group === g)!.mean;
    expect(at("running", "34+")).toBeLessThan(at("battingIQ", "34+"));
  });

  it("the attribute mix shifts with age as in the real data (34+ vs 30-33, men and women, every attribute)", () => {
    // The tilts keep only each attribute's ageing shape: a level the real data shows at every age (clutch about +1 a
    // season relative to its discipline, from the experience-based clutch rating) is removed so league averages
    // don't drift. So compare the change from the 30-33 band to the 34+ band, simulated vs real.
    type Row = { group: string; lo: number; hi: number; n: number; mean: number; se: number };
    for (const gender of ["male", "female"] as const) {
      const data = (fixture as unknown as Record<string, Record<string, Row[]>>)[gender];
      const early = simulatedRelative(30, 1, gender, 800), late = simulatedRelative(34, 1, gender, 800);
      for (const a of ALL) {
        const r1 = data[a].find(r => r.group === "30-33"), r2 = data[a].find(r => r.group === "34+");
        if (!r1 || !r2) continue;
        const sim = late[a] - early[a], real = r2.mean - r1.mean, se = Math.hypot(r1.se, r2.se);
        expect(Math.abs(sim - real), `${gender} ${a}: simulated ${sim.toFixed(2)} real ${real.toFixed(2)} (se ${se.toFixed(2)})`).toBeLessThan(2 * se + 0.3);
      }
    }
  });
});
