/**
 * Generated players against the real rated players (all-players.ts / wpl-players.ts): marginal ratings, correlations
 * between attributes and names. The generator is fitted on exactly this data, so these check that sampling
 * reproduces it.
 */

import { describe, it, expect } from "vitest";
import { generatePlayers, roleClassOfPlayer, type RoleClass, createPlayerFromData, createRNG, normaliseName, generateName } from "@ipl-sim/engine";
import { ALL_PLAYERS, WPL_PLAYERS } from "@ipl-sim/ratings";

const ATTRS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const;

function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy + 1e-9);
}

const realByClass = (data: typeof ALL_PLAYERS, rc: RoleClass) => data
  .map(d => createPlayerFromData({ ...(d as never as Record<string, unknown>), ...d.ratings } as never))
  .filter(p => roleClassOfPlayer(p) === rc);

describe("generated vs real ratings", () => {
  // classes that exist in both genders with enough players to compare
  const cases: { rc: RoleClass; gender: "male" | "female"; data: typeof ALL_PLAYERS }[] = [
    { rc: "batter", gender: "male", data: ALL_PLAYERS },
    { rc: "pace", gender: "male", data: ALL_PLAYERS },
    { rc: "spin", gender: "male", data: ALL_PLAYERS },
    { rc: "batter", gender: "female", data: WPL_PLAYERS as never },
    { rc: "pace", gender: "female", data: WPL_PLAYERS as never },
  ];

  for (const { rc, gender, data } of cases) {
    it(`${gender} ${rc}: marginals and attribute correlations look like the real players'`, () => {
      const real = realByClass(data, rc);
      // compare like with like: the real age profile and the real country mix
      const gen: ReturnType<typeof generatePlayers> = [];
      const rng = createRNG(500 + rc.length + (gender === "male" ? 0 : 7));
      for (let i = 0; i < 1500; i++) {
        const r = real[i % real.length];
        gen.push(...generatePlayers(1, rng, { gender, roleClass: rc, country: r.country, age: Math.min(43, Math.max(16, r.age)) }));
      }
      for (const a of ATTRS) {
        const rm = real.reduce((s, p) => s + p.ratings[a], 0) / real.length;
        const gm = gen.reduce((s, p) => s + p.ratings[a], 0) / gen.length;
        const rs = Math.sqrt(real.reduce((s, p) => s + (p.ratings[a] - rm) ** 2, 0) / real.length);
        const gs = Math.sqrt(gen.reduce((s, p) => s + (p.ratings[a] - gm) ** 2, 0) / gen.length);
        expect(Math.abs(gm - rm), `${a} mean`).toBeLessThan(4.5);
        expect(gs / (rs + 1e-9), `${a} sd`).toBeGreaterThan(0.8);
        expect(gs / (rs + 1e-9), `${a} sd`).toBeLessThan(1.3);
      }
      // correlation structure: mean absolute difference across the pairs of attributes the role is about (a batter's
      // bowling ratings are squashed to a floor by the game and carry no structure)
      const batBlock = ["battingIQ", "timing", "power", "running", "clutch"] as const;
      const bowlBlock = ["wicketTaking", "economy", "accuracy", "clutch"] as const;
      const block: readonly (typeof ATTRS)[number][] = rc === "batter" ? batBlock : bowlBlock;
      let total = 0, n = 0;
      for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
        const rc1 = corr(real.map(p => p.ratings[block[i]]), real.map(p => p.ratings[block[j]]));
        const gc1 = corr(gen.map(p => p.ratings[block[i]]), gen.map(p => p.ratings[block[j]]));
        total += Math.abs(rc1 - gc1);
        n++;
      }
      expect(total / n).toBeLessThan(0.1);
    });
  }

  it("batting attributes are strongly correlated with each other and not with bowling ones, as in the real data", () => {
    const gen = generatePlayers(2000, createRNG(31), { kind: "fill" });
    const c = (a: (typeof ATTRS)[number], b: (typeof ATTRS)[number]) => corr(gen.map(p => p.ratings[a]), gen.map(p => p.ratings[b]));
    expect(c("battingIQ", "timing")).toBeGreaterThan(0.6);
    expect(c("wicketTaking", "economy")).toBeGreaterThan(0.4);
    expect(Math.abs(c("timing", "accuracy"))).toBeLessThan(c("battingIQ", "timing"));
  });
});

describe("generated names vs real names", () => {
  it("no generated player carries a real player's full name (men's and women's pools)", () => {
    const real = new Set([...ALL_PLAYERS, ...WPL_PLAYERS].map(p => normaliseName(p.name)));
    const rng = createRNG(1234);
    const countries = ["India", "Pakistan", "England", "Australia", "South Africa", "Sri Lanka", "West Indies", "New Zealand", "Bangladesh", "Afghanistan", "Zimbabwe", "Ireland", "Nepal", "UAE", "USA"];
    for (const country of countries) {
      for (const gender of ["male", "female"] as const) {
        for (let i = 0; i < 300; i++) expect(real.has(normaliseName(generateName(rng, country, gender)))).toBe(false);
      }
    }
    const pool = generatePlayers(3000, rng, { kind: "pool" });
    expect(pool.filter(p => real.has(normaliseName(p.name)))).toHaveLength(0);
  });
});
