import { describe, it, expect } from "vitest";
import {
  getDLSResource,
  calculateDLSTarget,
  checkRainInterruption,
  canProduceResult,
  getRainDelayNarrative,
} from "../dls.js";
import { createRNG } from "../rng.js";

describe("DLS Resource Table", () => {
  it("full innings (20 overs, 0 wickets) = 100%", () => {
    expect(getDLSResource(20, 0)).toBe(100);
  });

  it("0 overs remaining = 0% for all wickets", () => {
    for (let w = 0; w <= 10; w++) {
      expect(getDLSResource(0, w)).toBe(0);
    }
  });

  it("10 wickets lost = 0% regardless of overs", () => {
    for (let o = 0; o <= 20; o++) {
      expect(getDLSResource(o, 10)).toBe(0);
    }
  });

  it("resources decrease as wickets increase", () => {
    const at10overs = getDLSResource(10, 0);
    const at10overs3wkts = getDLSResource(10, 3);
    const at10overs6wkts = getDLSResource(10, 6);
    expect(at10overs).toBeGreaterThan(at10overs3wkts);
    expect(at10overs3wkts).toBeGreaterThan(at10overs6wkts);
  });

  it("resources increase as overs remaining increase", () => {
    const at5overs = getDLSResource(5, 2);
    const at10overs = getDLSResource(10, 2);
    const at15overs = getDLSResource(15, 2);
    expect(at15overs).toBeGreaterThan(at10overs);
    expect(at10overs).toBeGreaterThan(at5overs);
  });

  it("handles edge cases gracefully", () => {
    expect(getDLSResource(-1, 0)).toBe(0); // negative overs clamped
    expect(getDLSResource(25, 0)).toBe(100); // over 20 clamped
    expect(getDLSResource(10, -1)).toBe(41.5); // negative wickets clamped to 0
    expect(getDLSResource(10, 15)).toBe(0); // over 10 wickets clamped
  });
});

describe("DLS Target Calculation", () => {
  it("full 20 overs available = target equals score + 1", () => {
    const target = calculateDLSTarget(180, 20, 0, 20);
    expect(target).toBe(181); // Same resources, target = score + 1
  });

  it("reduced overs = lower target", () => {
    const fullTarget = calculateDLSTarget(180, 20, 0, 20);
    const reducedTarget = calculateDLSTarget(180, 10, 0, 20);
    expect(reducedTarget).toBeLessThan(fullTarget);
  });

  it("10 overs available with 180 target gives reasonable revised target", () => {
    const target = calculateDLSTarget(180, 10, 0, 20);
    // 10 overs = ~41.5% resources, 20 overs = 100%. Target ≈ 180 * 0.415 + 1 ≈ 76
    expect(target).toBeGreaterThan(60);
    expect(target).toBeLessThan(120);
  });

  it("5 overs available (minimum) gives low target", () => {
    const target = calculateDLSTarget(180, 5, 0, 20);
    expect(target).toBeGreaterThan(30);
    expect(target).toBeLessThan(60);
  });

  it("target never below par (1 per over)", () => {
    const target = calculateDLSTarget(50, 15, 0, 20);
    expect(target).toBeGreaterThanOrEqual(16); // at least 15+1
  });

  it("wickets lost reduces available resources", () => {
    const noWickets = calculateDLSTarget(180, 10, 0, 20);
    const threeWickets = calculateDLSTarget(180, 10, 3, 20);
    expect(threeWickets).toBeLessThan(noWickets);
  });
});

describe("Rain Interruption", () => {
  it("mostly returns 0 (no rain)", () => {
    const rng = createRNG(42);
    let rainCount = 0;
    for (let i = 0; i < 100; i++) {
      if (checkRainInterruption(10, rng) > 0) rainCount++;
    }
    // Rain should be rare (<10% of overs)
    expect(rainCount).toBeLessThan(10);
  });

  it("returns 1-5 overs when rain occurs", () => {
    // Use a seed that produces rain
    for (let seed = 0; seed < 1000; seed++) {
      const rng = createRNG(seed);
      const result = checkRainInterruption(10, rng);
      if (result > 0) {
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(5);
        break;
      }
    }
  });
});

describe("Match Validity", () => {
  it("5+ overs = valid result possible", () => {
    expect(canProduceResult(5, false)).toBe(true);
    expect(canProduceResult(10, false)).toBe(true);
    expect(canProduceResult(20, false)).toBe(true);
  });

  it("less than 5 overs = no result", () => {
    expect(canProduceResult(4, false)).toBe(false);
    expect(canProduceResult(1, false)).toBe(false);
    expect(canProduceResult(0, false)).toBe(false);
  });
});

describe("Rain Delay Narrative", () => {
  it("heavy rain for 5+ overs lost", () => {
    const text = getRainDelayNarrative(5, 10);
    expect(text).toContain("Heavy rain");
    expect(text).toContain("5");
  });

  it("moderate rain for 3-4 overs", () => {
    const text = getRainDelayNarrative(3, 12);
    expect(text).toContain("Rain delay");
  });

  it("brief rain for 1-2 overs", () => {
    const text = getRainDelayNarrative(1, 14);
    expect(text).toContain("Brief");
  });
});
