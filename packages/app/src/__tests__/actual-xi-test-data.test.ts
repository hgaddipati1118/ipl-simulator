/**
 * The three-way Test benchmark's fixtures (docs/data/actual_xi_test.json, `TEST_ALL=1 generate-actual-xi.ts`; docs/COUNTRY-VALIDATION.md,
 * "Test results by country"): men's Tests between full members since 2019 with the elevens that played, draws included, and the
 * benchmark's three-way loss on a hand-made record.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loss3, paired3, type Test3Out } from "./benchmark-test-countries.test";

const HERE = dirname(fileURLToPath(import.meta.url));
interface T { id: string; date: string; a: string; b: string; host: "a" | "b" | null; winner: "a" | "b" | null; xi: { a: (string | null)[]; b: (string | null)[] } }
const ALL = (JSON.parse(readFileSync(join(HERE, "..", "..", "..", "..", "docs", "data", "actual_xi_test.json"), "utf-8")) as Record<string, T[]>)["test-men"];

describe("actual_xi_test.json", () => {
  it("holds men's Tests since 2019 with draws, split at 2025 into the fit and holdout halves", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(280);
    expect(ALL.every(m => m.date >= "2019-01-01")).toBe(true);
    const draws = ALL.filter(m => m.winner === null).length;
    expect(draws / ALL.length).toBeGreaterThan(0.08);
    expect(draws / ALL.length).toBeLessThan(0.2);
    expect(ALL.filter(m => m.date >= "2025-01-01").length).toBeGreaterThanOrEqual(60);
  });

  it("names nearly every player of both elevens in the pool", () => {
    const places = ALL.flatMap(m => [...m.xi.a, ...m.xi.b]);
    expect(places.filter(x => x === null).length / places.length).toBeLessThan(0.02);
    for (const m of ALL) expect(m.xi.a.length).toBeGreaterThanOrEqual(11);
  });
});

describe("three-way loss", () => {
  const rec = (res: "a" | "b" | "d", aw: number, bw: number, d: number): Test3Out =>
    ({ id: `${res}${aw}${bw}${d}`, date: "2025-01-01", a: "A", b: "B", host: null, res, aw, bw, d, ar: 0, awk: 0, br: 0, bwk: 0, ab: 0, bb: 0 });
  it("scores the real result, draws included", () => {
    expect(loss3(rec("d", 50, 40, 10))).toBeCloseTo(-Math.log(10.5 / 101.5), 9);
    expect(loss3(rec("a", 50, 40, 10))).toBeLessThan(loss3(rec("b", 50, 40, 10)));
  });
  it("pairs matches by id", () => {
    const a = [{ ...rec("a", 50, 40, 10), id: "x" }], b = [{ ...rec("a", 70, 20, 10), id: "x" }];
    const p = paired3(a, b);
    expect(p.n).toBe(1);
    expect(p.diff).toBeLessThan(0);
  });
});
