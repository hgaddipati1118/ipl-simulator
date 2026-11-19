/**
 * Realistic line-ups (realistic-xi.ts, international.ts `realistic` series): sampled XIs follow the real selection rates, are
 * deterministic for a seed, are legal (eleven, a keeper, bowling options), and the default series is unchanged.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateBowlingOverall } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { createSeries, seriesSquads, selectionRates, teamsForMatch } from "../international";
import { sampleXI } from "../realistic-xi";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;

describe("realistic line-ups", () => {
  const make = (format: "t20i" | "odi" | "test", realistic: boolean) =>
    createSeries({ format, gender: "men", nations: ["West Indies", "India"], length: 1, host: "neutral", userSide: null, seed: 11, realistic }, FILE);

  it("a default series keeps the 16-man best squads and the engine's own XI", () => {
    const s = make("t20i", false);
    expect(s.realistic).toBeUndefined();
    expect(seriesSquads(s, FILE)[0]).toHaveLength(16);
  });

  it("a realistic series' squads are the pools of recent players, and each match samples a legal, repeatable XI", () => {
    const s = make("t20i", true);
    expect(s.realistic).toBe(true);
    const squads = seriesSquads(s, FILE);
    expect(squads[0].length).toBeGreaterThan(16);
    const a = teamsForMatch(s, 0, squads).home.roster.map(p => p.id);
    const b = teamsForMatch(s, 0, squads).home.roster.map(p => p.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(11);
    const other = teamsForMatch({ ...s, seedBase: s.seedBase + 1 }, 0, squads).home.roster.map(p => p.id);
    expect(other).not.toEqual(a);
    for (let k = 0; k < 40; k++) {
      const xi = teamsForMatch({ ...s, seedBase: 100 + k }, 0, squads).home.roster;
      expect(xi.some(p => p.isWicketKeeper)).toBe(true);
      expect(xi.filter(p => calculateBowlingOverall(p.ratings) >= 60).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("players are picked at about their real selection rates, and a regular nearly always plays", () => {
    const s = make("t20i", true);
    const squads = seriesSquads(s, FILE);
    const rates = selectionRates("t20i", "men", "West Indies")!;
    const pool = squads[0];
    const N = 1500, count = new Map<string, number>();
    for (let k = 0; k < N; k++) for (const p of sampleXI(pool, rates, 7 + k)) count.set(p.sourceId ?? p.id, (count.get(p.sourceId ?? p.id) ?? 0) + 1);
    const top = [...pool].sort((x, y) => (rates[y.sourceId ?? y.id] ?? 0) - (rates[x.sourceId ?? x.id] ?? 0))[0];
    const share = (count.get(top.sourceId ?? top.id) ?? 0) / N;
    expect(share).toBeGreaterThan(0.6);
    // the XI always has eleven
    expect([...count.values()].reduce((x, y) => x + y, 0)).toBe(11 * N);
  });

  it("the user's side is never sampled", () => {
    const s = createSeries({ format: "odi", gender: "men", nations: ["India", "Australia"], length: 1, host: "neutral", userSide: 0, seed: 3, realistic: true }, FILE);
    expect(s.realistic).toBeUndefined();
    expect(seriesSquads(s, FILE)[0]).toHaveLength(16);
  });
});
