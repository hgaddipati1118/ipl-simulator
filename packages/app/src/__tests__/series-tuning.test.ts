/**
 * The series tuning (series-tuning.ts): a Test (like a T20I and an ODI) has its own entry, the home side's six batting and bowling
 * attributes move by half the home term (and the away side's the other way) at a ground that is not neutral, and the user's pitch /
 * light / weather act through other terms: choosing a pitch preset does not change the home shift (a host's home term is not counted
 * again with the pitch).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Player } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { createSeries, seriesSquads, teamsForMatch, type IntlSeries } from "../international";
import { applySeriesTuning, tuningFor } from "../series-tuning";
import { SERIES_TUNING } from "../series-tuning-data";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
const SIX = ["battingIQ", "timing", "power", "wicketTaking", "economy", "accuracy"] as const;

const series = (format: "test" | "odi", host: "a" | "b" | "neutral", nations: [string, string] = ["India", "England"]): IntlSeries =>
  createSeries({ format, gender: "men", nations, length: 1, host, userSide: null, seed: 5 }, FILE);

/** The mean shift of each series side's six attributes against the same players in a neutral series (the neutral one carries no home term), by player */
function shifts(s: IntlSeries, neutral: IntlSeries): { a: number[]; b: number[] } {
  const players = (x: IntlSeries) => { const t = teamsForMatch(x, 0, seriesSquads(x, FILE)); return new Map([...t.home.roster, ...t.away.roster].map(p => [p.id, p])); };
  const mine = players(s), base = players(neutral);
  const side = (i: 0 | 1) => s.sides[i].squad.filter(id => mine.has(id)).map(id => SIX.reduce((m, k) => m + (mine.get(id)!.ratings[k] - base.get(id)!.ratings[k]), 0) / SIX.length);
  return { a: side(0), b: side(1) };
}

describe("series tuning for the Test", () => {
  it("has a Test entry with a home term below the engine's own home edge, and no stretch", () => {
    const t = tuningFor("test", "men");
    expect(t).toBeDefined();
    expect(t!.spread).toBe(1);
    expect(t!.home).toBeLessThan(0);
    expect(SERIES_TUNING.test.men).toBe(t);
  });

  it("moves the home side by half the home term and the away side the other way; a neutral ground moves nobody", () => {
    const t = tuningFor("test", "men")!;
    const home = (c: string) => t.homeBy?.[c] ?? t.home;
    const s = series("test", "a"), n = series("test", "neutral");
    const d = shifts(s, n);
    const want = home("India") / 2;
    // clamped at 1-99 and rounded nowhere: a player at a limit moves less, so compare the median
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(med(d.a)).toBeCloseTo(want, 5);
    expect(med(d.b)).toBeCloseTo(-want, 5);
    const db = shifts(series("test", "b"), n);
    expect(med(db.b)).toBeCloseTo(home("England") / 2, 5);
    expect(med(db.a)).toBeCloseTo(-home("England") / 2, 5);
    expect(med(shifts(n, n).a)).toBe(0);
  });

  it("a side with a strength term (set here: none ships) gains its rating points wherever it plays, home, away or neutral", () => {
    const sa = 2;
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const nations: [string, string] = ["South Africa", "Pakistan"];
    const n = series("test", "neutral", nations);
    // neutral ground: no home term, so the whole shift is the strength term (the stretch is 1)
    const base = (s: IntlSeries) => { const tn = teamsForMatch(s, 0, seriesSquads(s, FILE)); return new Map([...tn.home.roster, ...tn.away.roster].map(p => [p.id, p])); };
    const saved = SERIES_TUNING.test.men;
    SERIES_TUNING.test.men = { ...saved!, strengthBy: {} };
    const without = base(n);
    SERIES_TUNING.test.men = { ...saved!, strengthBy: { "South Africa": sa } };
    const withTerm = base(n);
    SERIES_TUNING.test.men = saved;
    const d = n.sides[0].squad.filter(id => withTerm.has(id)).map(id => SIX.reduce((m, k) => m + (withTerm.get(id)!.ratings[k] - without.get(id)!.ratings[k]), 0) / SIX.length);
    expect(med(d)).toBeCloseTo(sa, 5);
    const dPak = n.sides[1].squad.filter(id => withTerm.has(id)).map(id => SIX.reduce((m, k) => m + (withTerm.get(id)!.ratings[k] - without.get(id)!.ratings[k]), 0) / SIX.length);
    expect(med(dPak)).toBe(0);
  });

  it("the user's pitch, light and weather do not change the home shift (the home term is not counted again with the pitch)", () => {
    const n = series("test", "neutral");
    for (const conditions of [{ pitch: "seaming" as const }, { pitch: "flat" as const, weather: "unsettled" as const }]) {
      const s = { ...series("test", "a"), conditions };
      const plain = shifts(series("test", "a"), n), set = shifts(s, n);
      expect(set).toEqual(plain);
    }
    // the ODI the same, with a pitch and a light
    const on = series("odi", "neutral");
    const plain = shifts(series("odi", "a"), on), set = shifts({ ...series("odi", "a"), conditions: { pitch: "turning" as const, light: "night" as const } }, on);
    expect(set).toEqual(plain);
  });

  it("applySeriesTuning with the Test entry leaves the two sides' mean attributes symmetric around the unshifted pair", () => {
    const s = series("test", "a");
    const sq = seriesSquads(s, FILE);
    const copy = (sqd: Player[]) => sqd.map(p => Player.fromJSON(p.toJSON()));
    const a = copy(sq[0]), b = copy(sq[1]);
    applySeriesTuning([a, b], { spread: 1, home: 2 }, 0);
    const mean = (xs: Player[], k: "battingIQ") => xs.reduce((m, p) => m + p.ratings[k], 0) / xs.length;
    const base = (xs: Player[], k: "battingIQ") => xs.reduce((m, p) => m + p.ratings[k], 0) / xs.length;
    expect(mean(a, "battingIQ")).toBeGreaterThan(base(sq[0], "battingIQ"));
    expect(mean(b, "battingIQ")).toBeLessThan(base(sq[1], "battingIQ"));
  });
});
