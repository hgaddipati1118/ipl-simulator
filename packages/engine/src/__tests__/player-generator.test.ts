import { describe, it, expect } from "vitest";
import { generatePlayer, generatePlayers, roleClassOfPlayer, regionOf, type RoleClass } from "../player-generator.js";
import { generateName, isRealName, nameGroupOf } from "../names.js";
import { generateYouthProspects } from "../youth-academy.js";
import { generatePlayerPool } from "../create-player.js";
import { createRNG } from "../rng.js";

const ATTRS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const;

describe("generated players: determinism", () => {
  it("the same seed gives the same players, names and ids", () => {
    const a = generatePlayers(40, createRNG(77), { kind: "pool" }, "x");
    const b = generatePlayers(40, createRNG(77), { kind: "pool" }, "x");
    expect(a.map(p => p.toJSON())).toEqual(b.map(p => p.toJSON()));
    expect(a[0].id).toBe("x_1");
  });

  it("different seeds give different players", () => {
    const a = generatePlayers(20, createRNG(1), { kind: "pool" }, "x");
    const b = generatePlayers(20, createRNG(2), { kind: "pool" }, "x");
    expect(a.map(p => p.name)).not.toEqual(b.map(p => p.name));
  });

  it("seeded youth prospects and pools reproduce", () => {
    const y1 = generateYouthProspects("mi", 3, createRNG(5), { idPrefix: "y" });
    const y2 = generateYouthProspects("mi", 3, createRNG(5), { idPrefix: "y" });
    expect(y1.map(y => [y.player.name, y.potential, y.player.ratings])).toEqual(y2.map(y => [y.player.name, y.potential, y.player.ratings]));
    const p1 = generatePlayerPool(30, createRNG(9)).map(p => [p.name, p.ratings]);
    const p2 = generatePlayerPool(30, createRNG(9)).map(p => [p.name, p.ratings]);
    expect(p1).toEqual(p2);
  });
});

describe("generated players: attributes", () => {
  const rng = createRNG(2024);
  const pool = generatePlayers(1500, rng, { kind: "pool" });

  it("ratings are integers within 1-99, ages and ids are valid", () => {
    for (const p of pool) {
      for (const a of ATTRS) {
        expect(Number.isInteger(p.ratings[a])).toBe(true);
        expect(p.ratings[a]).toBeGreaterThanOrEqual(1);
        expect(p.ratings[a]).toBeLessThanOrEqual(99);
      }
      expect(p.age).toBeGreaterThanOrEqual(16);
      expect(p.age).toBeLessThanOrEqual(43);
    }
    expect(new Set(pool.map(p => p.id)).size).toBe(pool.length);
  });

  it("asked-for role, country, gender and age window are honoured", () => {
    const classes: RoleClass[] = ["batter", "keeper", "allround", "pace", "spin"];
    for (const rc of classes) {
      const ps = generatePlayers(40, createRNG(3), { roleClass: rc, country: "England", age: [24, 28] });
      for (const p of ps) {
        expect(p.country).toBe("England");
        expect(p.age).toBeGreaterThanOrEqual(24);
        expect(p.age).toBeLessThanOrEqual(28);
        expect(p.isInternational).toBe(true);
      }
      const matching = ps.filter(p => roleClassOfPlayer(p) === rc).length;
      expect(matching / ps.length).toBeGreaterThan(0.9);
    }
  });

  it("roles have the right shape: bowlers bowl, batters bat, keepers keep, all-rounders do both", () => {
    const by = (rc: RoleClass) => generatePlayers(150, createRNG(8), { roleClass: rc, age: [22, 32] });
    const mean = (ps: ReturnType<typeof by>, f: (p: ReturnType<typeof by>[number]) => number) => ps.reduce((a, p) => a + f(p), 0) / ps.length;
    const bowlers = by("pace"), batters = by("batter"), ars = by("allround"), keepers = by("keeper");
    expect(mean(bowlers, p => p.bowlingOvr) - mean(bowlers, p => p.battingOvr)).toBeGreaterThan(15);
    expect(mean(batters, p => p.battingOvr) - mean(batters, p => p.bowlingOvr)).toBeGreaterThan(15);
    expect(Math.min(mean(ars, p => p.battingOvr), mean(ars, p => p.bowlingOvr))).toBeGreaterThan(55);
    expect(keepers.every(p => p.isWicketKeeper)).toBe(true);
  });

  it("age and region shift the ratings like the real data: veterans and top-tier nations are better than teenagers and small nations", () => {
    const mean = (ps: ReturnType<typeof generatePlayers>) => ps.reduce((a, p) => a + p.overall, 0) / ps.length;
    const young = generatePlayers(300, createRNG(4), { roleClass: "batter", country: "India", age: 18 });
    const prime = generatePlayers(300, createRNG(4), { roleClass: "batter", country: "India", age: 28 });
    expect(mean(prime)).toBeGreaterThan(mean(young) + 1);
    const anglo = generatePlayers(300, createRNG(6), { roleClass: "batter", country: "Australia", age: 27 });
    const small = generatePlayers(300, createRNG(6), { roleClass: "batter", country: "Cambodia", age: 27 });
    expect(mean(anglo)).toBeGreaterThan(mean(small) + 3);
    expect(regionOf("Cambodia")).toBe("other");
  });

  it("youth prospects have a potential and a growth path", () => {
    const ys = generatePlayers(100, createRNG(12), { kind: "youth", country: "India" });
    for (const y of ys) {
      expect(y.age).toBeGreaterThanOrEqual(17);
      expect(y.age).toBeLessThanOrEqual(20);
      expect(y.potential).toBeGreaterThanOrEqual(30);
      expect(y.talentLeft).toBeDefined();
      expect(y.experience).toBe(1);
    }
    const mean = (f: (p: (typeof ys)[number]) => number) => ys.reduce((a, p) => a + f(p), 0) / ys.length;
    // the typical prospect is expected to end up better than he starts
    expect(mean(p => p.potential!)).toBeGreaterThan(mean(p => p.overall));
  });

  it("the overall window option constrains the draw", () => {
    const ps = generatePlayers(60, createRNG(2), { overall: [40, 55], age: [22, 30], roleClass: "batter" });
    for (const p of ps) {
      expect(p.overall).toBeGreaterThanOrEqual(40);
      expect(p.overall).toBeLessThanOrEqual(55);
    }
    expect(ps.reduce((a, p) => a + p.overall, 0) / ps.length).toBeLessThan(55);
  });
});

describe("generated players: names", () => {
  it("names are first + last from the country's pools, mixed, and never a real full name", () => {
    const rng = createRNG(99);
    const names = new Set<string>();
    for (const country of ["India", "Pakistan", "England", "Australia", "South Africa", "Sri Lanka", "West Indies", "Afghanistan", "New Zealand", "Bangladesh"]) {
      for (let i = 0; i < 400; i++) {
        const n = generateName(rng, country, "male");
        expect(isRealName(n)).toBe(false);
        expect(n.split(" ").length).toBeGreaterThanOrEqual(2);
        names.add(n);
      }
    }
    expect(names.size).toBeGreaterThan(3000); // plenty of variety
  });

  it("the blocklist knows famous names", () => {
    expect(isRealName("Virat Kohli")).toBe(true);
    expect(isRealName("virat   KOHLI")).toBe(true);
    expect(isRealName("Jasprit Bumrah")).toBe(true);
    expect(isRealName("Zxqv Nobody")).toBe(false);
  });

  it("regional pools differ: Indian names are not drawn from English ones", () => {
    const rng = createRNG(5);
    const first = (c: string) => new Set(Array.from({ length: 300 }, () => generateName(rng, c).split(" ")[0]));
    const india = first("India"), england = first("England");
    const overlap = [...india].filter(n => england.has(n)).length;
    expect(overlap / india.size).toBeLessThan(0.1);
    expect(nameGroupOf("Malawi Women")).toBe("africa");
    expect(nameGroupOf("Atlantis")).toBe("europe");
  });

  it("women get women's first names", () => {
    const rng = createRNG(5);
    const men = new Set(Array.from({ length: 400 }, () => generateName(rng, "England", "male").split(" ")[0]));
    const women = Array.from({ length: 400 }, () => generateName(rng, "England", "female").split(" ")[0]);
    const shared = women.filter(n => men.has(n)).length / women.length;
    expect(shared).toBeLessThan(0.15);
  });
});
