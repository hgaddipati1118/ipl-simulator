import { describe, it, expect } from "vitest";
import { clamp, normSInv, shuffle, weightedRandom } from "../math.js";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it("clamps to min when below", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });

  it("clamps to max when above", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it("handles equal min and max", () => {
    expect(clamp(50, 10, 10)).toBe(10);
  });

  it("handles boundary values exactly", () => {
    expect(clamp(0, 0, 100)).toBe(0);
    expect(clamp(100, 0, 100)).toBe(100);
  });
});

describe("normSInv", () => {
  it("returns 0 for p=0.5 (median)", () => {
    expect(normSInv(0.5)).toBeCloseTo(0, 5);
  });

  it("returns negative for p < 0.5", () => {
    expect(normSInv(0.1)).toBeLessThan(0);
  });

  it("returns positive for p > 0.5", () => {
    expect(normSInv(0.9)).toBeGreaterThan(0);
  });

  it("handles low tail correctly", () => {
    const val = normSInv(0.01);
    expect(val).toBeCloseTo(-2.326, 2);
  });

  it("handles high tail correctly", () => {
    const val = normSInv(0.99);
    expect(val).toBeCloseTo(2.326, 2);
  });

  it("is symmetric around 0.5", () => {
    const low = normSInv(0.2);
    const high = normSInv(0.8);
    expect(low + high).toBeCloseTo(0, 4);
  });
});

describe("shuffle", () => {
  it("preserves array length", () => {
    const arr = [1, 2, 3, 4, 5];
    shuffle(arr);
    expect(arr).toHaveLength(5);
  });

  it("preserves all elements", () => {
    const arr = [1, 2, 3, 4, 5];
    shuffle(arr);
    expect(arr.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("mutates in place and returns same reference", () => {
    const arr = [1, 2, 3];
    const result = shuffle(arr);
    expect(result).toBe(arr);
  });

  it("handles empty array", () => {
    const arr: number[] = [];
    shuffle(arr);
    expect(arr).toEqual([]);
  });

  it("handles single element", () => {
    const arr = [42];
    shuffle(arr);
    expect(arr).toEqual([42]);
  });
});

describe("weightedRandom", () => {
  it("returns the only item when single element", () => {
    const result = weightedRandom([["only", 1]]);
    expect(result).toBe("only");
  });

  it("returns an item from the list", () => {
    const items: [string, number][] = [["a", 1], ["b", 2], ["c", 3]];
    const result = weightedRandom(items);
    expect(["a", "b", "c"]).toContain(result);
  });

  it("heavily weighted item is selected most often", () => {
    const items: [string, number][] = [["rare", 0.001], ["common", 999]];
    const counts = { rare: 0, common: 0 };
    for (let i = 0; i < 1000; i++) {
      counts[weightedRandom(items) as "rare" | "common"]++;
    }
    expect(counts.common).toBeGreaterThan(990);
  });
});
