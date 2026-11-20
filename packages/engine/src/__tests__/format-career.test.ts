/**
 * ODI / Test ratings over a career (format-career.ts): generated players get derived sets, sets follow the T20 ratings as a
 * player develops, and saves from before sets existed still load.
 */
import { describe, expect, it } from "vitest";
import { Player, type FormatRatings, type PlayerData } from "../player.js";
import { generatePlayer, generatePlayers } from "../player-generator.js";
import { generateYouthProspects } from "../youth-academy.js";
import { generatePlayerPool } from "../create-player.js";
import { coupleFormatChange, deriveFormatSets } from "../format-career.js";
import { FORMAT_COUPLING } from "../format-career-data.js";
import { createRNG } from "../rng.js";

const ATTRS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const;

function realPlayer(extra: Partial<PlayerData> = {}): Player {
  return new Player({
    id: "r1", sourceId: "espn_1", name: "Real Player", age: 24, country: "India", role: "batsman",
    ratings: { battingIQ: 70, timing: 72, power: 68, running: 60, wicketTaking: 20, economy: 22, accuracy: 25, clutch: 55, fielding: 55 },
    formatRatings: {
      odi: { source: "data", ratings: { battingIQ: 76, timing: 66, power: 58, running: 62, wicketTaking: 20, economy: 22, accuracy: 25, clutch: 57, fielding: 55 } },
      test: { source: "data", ratings: { battingIQ: 80, timing: 60, power: 50, running: 64, wicketTaking: 20, economy: 22, accuracy: 25, clutch: 58, fielding: 55 } },
    },
    isInternational: false, injured: false, injuryGamesLeft: 0,
    ...extra,
  });
}

describe("generated players have derived ODI / Test sets", () => {
  it("every kind, men and women, gets a complete derived set for both formats", () => {
    const rng = createRNG(5);
    const players = [
      ...generatePlayers(40, rng, { kind: "pool" }),
      ...generatePlayers(40, rng, { kind: "regen", gender: "female" }),
      ...generatePlayers(40, rng, { kind: "youth" }),
      ...generatePlayers(40, rng, { kind: "fill", gender: "female" }),
      ...generatePlayerPool(30, rng),
      ...generateYouthProspects("mi", 6, rng, { idPrefix: "y" }).map(y => y.player),
    ];
    for (const p of players) {
      for (const fmt of ["odi", "test"] as const) {
        const set = p.formatRatings?.[fmt];
        expect(set?.source, `${p.name} ${fmt}`).toBe("derived");
        for (const a of ATTRS) {
          expect(Number.isInteger(set!.ratings[a])).toBe(true);
          expect(set!.ratings[a]).toBeGreaterThanOrEqual(1);
          expect(set!.ratings[a]).toBeLessThanOrEqual(99);
        }
        // fielding / keeping are the T20 values, as in a stored set
        expect(set!.ratings.fielding).toBe(p.ratings.fielding);
        expect(set!.ratings.keeping).toBe(p.ratings.keeping);
        expect(p.forFormat(fmt)).not.toBe(p);
      }
    }
  });

  it("a derived set sits with the T20 rating, a little below at the top (the pipeline's shrink and cap)", () => {
    const pool = generatePlayers(600, createRNG(11), { kind: "pool" });
    let diff = 0, n = 0, topDiff = 0, topN = 0;
    for (const p of pool) {
      for (const fmt of ["odi", "test"] as const) {
        const d = p.forFormat(fmt).overall - p.overall;
        diff += d; n++;
        if (p.overall >= 70) { topDiff += d; topN++; }
      }
    }
    expect(Math.abs(diff / n)).toBeLessThan(12);
    expect(topN).toBeGreaterThan(0);
    expect(topDiff / topN).toBeLessThan(0); // a player with no record is not rated as high as his T20 form
  });

  it("is deterministic and leaves the generation stream and T20 ratings alone", () => {
    const a = generatePlayers(25, createRNG(77), { kind: "pool" }, "x");
    const b = generatePlayers(25, createRNG(77), { kind: "pool" }, "x");
    expect(a.map(p => p.toJSON())).toEqual(b.map(p => p.toJSON()));
    // a later draw from the same rng is the same whether or not sets exist: derivation draws nothing
    const r1 = createRNG(3); generatePlayer(r1, { kind: "pool" }); const n1 = r1();
    const r2 = createRNG(3); const p2 = generatePlayer(r2, { kind: "pool" }); delete p2.formatRatings; const n2 = r2();
    expect(n1).toBe(n2);
  });

  it("a woman's set comes from the women's fit", () => {
    const w = generatePlayer(createRNG(8), { kind: "pool", gender: "female" });
    const expected = deriveFormatSets(w.ratings, w.battingOvr, w.bowlingOvr, "female");
    expect(w.formatRatings?.odi?.ratings).toEqual(expected.odi!.ratings);
  });
});

describe("format sets follow a player's development", () => {
  it("progress() moves ODI / Test attributes with the T20 change, keeping the offsets", () => {
    const withSets = realPlayer();
    const without = realPlayer({ formatRatings: undefined });
    const before = JSON.parse(JSON.stringify(withSets.formatRatings)) as Record<string, FormatRatings>;
    const rA = createRNG(21), rB = createRNG(21);
    let totalT20 = 0, totalOdi = 0;
    for (let s = 0; s < 6; s++) {
      const o0 = withSets.battingOvr, f0 = withSets.forFormat("odi").battingOvr;
      withSets.progress({ rng: rA });
      without.progress({ rng: rB });
      totalT20 += withSets.battingOvr - o0;
      totalOdi += withSets.forFormat("odi").battingOvr - f0;
    }
    // sets draw nothing: the T20 path is the same with or without them
    expect(withSets.ratings).toEqual(without.ratings);
    expect(without.formatRatings).toBeUndefined();
    // the format sets moved, in the direction of the T20 change, by roughly the fitted share of it
    const after = withSets.formatRatings!;
    expect(after.odi!.ratings).not.toEqual(before.odi.ratings);
    expect(Math.sign(totalOdi)).toBe(Math.sign(totalT20));
    expect(Math.abs(totalOdi)).toBeLessThanOrEqual(Math.abs(totalT20) + 2);
    expect(after.odi!.source).toBe("data");
    // fielding follows the T20 value
    expect(after.odi!.ratings.fielding).toBe(withSets.ratings.fielding);
    // the format-specific offset (ODI battingIQ above T20 battingIQ) is not erased: it changes by far less than the level did
    const offsetBefore = before.test.ratings.battingIQ - 70;
    const offsetAfter = after.test!.ratings.battingIQ - withSets.ratings.battingIQ;
    expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(Math.abs(withSets.ratings.battingIQ - 70) + 3);
  });

  it("a rising T20 player rises in ODI and Test, a falling one falls (averaged over careers)", () => {
    const low = { battingIQ: 42, timing: 44, power: 40, running: 40, wicketTaking: 20, economy: 22, accuracy: 25, clutch: 45 };
    const lowSets = { odi: { source: "data" as const, ratings: { ...low, battingIQ: 46 } }, test: { source: "data" as const, ratings: { ...low, battingIQ: 48 } } };
    const mean = (age: number) => {
      let t20 = 0, odi = 0, test = 0;
      for (let seed = 0; seed < 30; seed++) {
        const p = age < 25 ? realPlayer({ age, ratings: low, formatRatings: lowSets }) : realPlayer({ age });
        const t0 = p.battingOvr, o0 = p.forFormat("odi").battingOvr, x0 = p.forFormat("test").battingOvr;
        for (let s = 0; s < 5; s++) p.progress({ rng: createRNG(seed * 10 + s + 1) });
        t20 += p.battingOvr - t0; odi += p.forFormat("odi").battingOvr - o0; test += p.forFormat("test").battingOvr - x0;
      }
      return { t20: t20 / 30, odi: odi / 30, test: test / 30 };
    };
    const young = mean(19), old = mean(37); // a 42-rated teenager, a 37-year-old star
    expect(young.t20).toBeGreaterThan(0);
    expect(young.odi).toBeGreaterThan(0);
    expect(young.test).toBeGreaterThan(0);
    expect(old.t20).toBeLessThan(0);
    expect(old.odi).toBeLessThan(0);
    expect(old.test).toBeLessThan(0);
    // a share of the T20 move, not all of it and not none
    expect(Math.abs(young.odi)).toBeLessThan(Math.abs(young.t20));
  });

  it("derived and generated players develop in step too", () => {
    const p = generatePlayer(createRNG(4), { kind: "youth" });
    const odi0 = p.forFormat("odi").overall, t0 = p.overall;
    for (let s = 0; s < 6; s++) p.progress({ rng: createRNG(40 + s) });
    expect(p.overall).not.toBe(t0);
    expect(Math.sign(p.forFormat("odi").overall - odi0)).toBe(Math.sign(p.overall - t0));
    expect(p.formatRatings!.odi!.source).toBe("derived");
  });

  it("small changes are carried, not lost to rounding or rounded up every time", () => {
    const sets: Partial<Record<"odi" | "test", FormatRatings>> = {
      odi: { source: "data", ratings: { battingIQ: 50, timing: 50, power: 50, running: 50, wicketTaking: 50, economy: 50, accuracy: 50, clutch: 50 } },
    };
    const k = FORMAT_COUPLING.male.odi.bat;
    for (let i = 0; i < 20; i++) coupleFormatChange(sets, { battingIQ: 1 }, {}, "male");
    expect(sets.odi!.ratings.battingIQ).toBe(50 + Math.round(20 * k));
    for (let i = 0; i < 20; i++) coupleFormatChange(sets, { battingIQ: -1 }, {}, "male");
    expect(Math.abs(sets.odi!.ratings.battingIQ - 50)).toBeLessThanOrEqual(1); // up and down by the same amounts ends where it started
  });

  it("a set stays within 1-99 and a player without sets is unaffected", () => {
    const sets: Partial<Record<"odi" | "test", FormatRatings>> = {
      odi: { source: "data", ratings: { battingIQ: 98, timing: 2, power: 50, running: 50, wicketTaking: 50, economy: 50, accuracy: 50, clutch: 50 } },
    };
    coupleFormatChange(sets, { battingIQ: 12, timing: -12 }, {}, "male");
    expect(sets.odi!.ratings.battingIQ).toBe(99);
    expect(sets.odi!.ratings.timing).toBe(1);
    expect(() => coupleFormatChange(undefined, { battingIQ: 3 }, {}, "male")).not.toThrow();
  });

  it("the carry survives a save", () => {
    const p = realPlayer();
    p.progress({ rng: createRNG(9) });
    const back = Player.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
    expect(back.formatRatings).toEqual(p.formatRatings);
  });
});

describe("saves from before format sets", () => {
  it("a saved generated player without sets gets them derived on load; a real one is left for the ratings file", () => {
    const gen = generatePlayer(createRNG(6), { kind: "regen" });
    const old = JSON.parse(JSON.stringify(gen.toJSON()));
    delete old.formatRatings;
    const loaded = Player.fromJSON(old);
    expect(loaded.formatRatings?.odi?.source).toBe("derived");
    expect(loaded.formatRatings).toEqual(deriveFormatSets(loaded.ratings, loaded.battingOvr, loaded.bowlingOvr, "male"));
    expect(loaded.formatRatings).toEqual(gen.formatRatings);

    const real = JSON.parse(JSON.stringify(realPlayer({ formatRatings: undefined }).toJSON()));
    expect(Player.fromJSON(real).formatRatings).toBeUndefined();
  });

  it("a save that has sets keeps them exactly", () => {
    const p = realPlayer();
    const back = Player.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
    expect(back.formatRatings).toEqual(p.formatRatings);
    const g = generatePlayer(createRNG(12), { kind: "pool", gender: "female" });
    const gb = Player.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(gb.formatRatings).toEqual(g.formatRatings);
  });

  it("an old woman's save derives from the women's fit", () => {
    const g = generatePlayer(createRNG(14), { kind: "pool", gender: "female" });
    const old = JSON.parse(JSON.stringify(g.toJSON())); delete old.formatRatings;
    const loaded = Player.fromJSON(old);
    expect(loaded.isFemale).toBe(true);
    expect(loaded.formatRatings).toEqual(g.formatRatings);
  });
});
