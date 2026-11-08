import { describe, expect, it } from "vitest";
import {
  doesSide, doesSideNow, estimateFormat, formatRole, fitLine, fitWls, linkCurve, percentile, quantile, readCurve, translatedPrior,
  type CaPlayerFormats, type EstimateContext, type SideRating,
} from "../pipeline/format-model.js";

const side = (rating: number, sd: number, year: number, balls: number, matches = Math.ceil(balls / 30)): SideRating => ({ rating, sd, year, balls, matches });

const ctx = (over: Partial<EstimateContext> = {}): EstimateContext => ({
  asOf: 2026,
  dataVar: 1,
  dataBalls: 240,
  translations: { "bat/T20>ListA": { a: 2, b: 0.7, residVar: 90, n: 1000 }, "bat/FC>ListA": { a: 0, b: 0.5, residVar: 150, n: 800 } },
  params: Object.fromEntries(["bat", "bowl"].flatMap(s => ["T20", "ListA", "FC"].map(f => [`${s}/${f}`, { half_life: 1, K: 400 }]))) as EstimateContext["params"],
  prior: { bat: { mean: -8, sd: 17 }, bowl: { mean: -5, sd: 7 } },
  ...over,
});

describe("format model: fits", () => {
  it("fitLine recovers a line and its residual variance", () => {
    const pairs = Array.from({ length: 200 }, (_, i) => ({ x: i / 10, y: 3 + 0.5 * (i / 10) + (i % 2 ? 1 : -1), w: 1 }));
    const t = fitLine(pairs);
    expect(t.a).toBeCloseTo(3, 1);
    expect(t.b).toBeCloseTo(0.5, 2);
    expect(t.residVar).toBeCloseTo(1, 1);
    expect(fitLine(pairs.slice(0, 10)).n).toBe(10); // too few pairs: identity with a wide residual
    expect(fitLine(pairs.slice(0, 10)).b).toBe(1);
  });

  it("fitWls solves a multiple regression", () => {
    const rows = Array.from({ length: 300 }, (_, i) => {
      const x1 = (i % 17) - 8, x2 = ((i * 7) % 13) - 6;
      return { xs: [x1, x2], y: 1 + 2 * x1 - 0.5 * x2, w: 1 + (i % 3) };
    });
    const fit = fitWls(rows)!;
    expect(fit.coef[0]).toBeCloseTo(1, 6);
    expect(fit.coef[1]).toBeCloseTo(2, 6);
    expect(fit.coef[2]).toBeCloseTo(-0.5, 6);
    expect(fit.residVar).toBeCloseTo(0, 6);
    expect(fitWls(rows.map(r => ({ ...r, xs: [r.xs[0], r.xs[0]] })))).toBeUndefined(); // collinear
  });
});

describe("format model: the estimate", () => {
  it("a side done for fewer than 6 balls a match is not one the player does", () => {
    expect(doesSide(side(10, 8, 2026, 600, 50))).toBe(true);
    expect(doesSide(side(10, 8, 2026, 250, 50))).toBe(false); // 5 balls a match: a part-timer
    expect(doesSide(side(10, 8, 2026, 40, 2))).toBe(false); // below the evidence floor
  });

  it("a side done over a career but not in the last seasons of the format is not one he does now", () => {
    expect(doesSideNow({ ...side(5, 9, 2026, 2000, 200), recentPerMatch: 1.5 })).toBe(false); // a batter's old leg-spin
    expect(doesSideNow({ ...side(5, 9, 2026, 2000, 200), recentPerMatch: 12 })).toBe(true);
    expect(doesSideNow(side(5, 9, 2026, 2000, 200))).toBe(true); // no recent figure (lower-level records): career rule
    expect(doesSideNow({ ...side(5, 9, 2026, 250, 50), recentPerMatch: 30 })).toBe(false); // career rule still applies
  });

  it("blends the format's own record with the translated prior by precision", () => {
    const p: CaPlayerFormats = { ListA: { bat: side(30, 6, 2026, 5000) }, T20: { bat: side(40, 5, 2026, 3000) } };
    const e = estimateFormat(p, "ListA", "bat", ctx())!;
    const prior = 2 + 0.7 * 40, vP = 0.49 * 25 + 90, vD = 36;
    expect(e.mean).toBeCloseTo((30 / vD + prior / vP) / (1 / vD + 1 / vP), 6);
    expect(e.dataWeight).toBeCloseTo((1 / vD) / (1 / vD + 1 / vP), 6);
    expect(e.source).toBe("data");
    expect(e.from).toBe("T20");
    // trusting the record more moves the estimate toward it
    expect(Math.abs(estimateFormat(p, "ListA", "bat", ctx({ dataVar: 0.25 }))!.mean - 30)).toBeLessThan(Math.abs(e.mean - 30));
  });

  it("an old record counts for less, but for no more than two seasons of staleness", () => {
    const fresh: CaPlayerFormats = { ListA: { bat: side(5, 8, 2026, 4000) }, T20: { bat: side(45, 5, 2026, 4000) } };
    const old = (year: number): CaPlayerFormats => ({ ...fresh, ListA: { bat: side(5, 8, year, 4000) } });
    const w = (p: CaPlayerFormats) => estimateFormat(p, "ListA", "bat", ctx())!.dataWeight;
    expect(w(old(2024))).toBeLessThan(w(fresh));
    expect(w(old(2018))).toBeCloseTo(w(old(2024)), 9);
    // still "data" within five seasons, "derived" after
    expect(estimateFormat(old(2022), "ListA", "bat", ctx())!.source).toBe("data");
    expect(estimateFormat(old(2019), "ListA", "bat", ctx())!.source).toBe("derived");
    // a retired player is rated as of his last season: an old record is not stale against his own career
    const retired: CaPlayerFormats = { ListA: { bat: side(5, 8, 2012, 4000) }, T20: { bat: side(45, 5, 2013, 4000) } };
    expect(estimateFormat(retired, "ListA", "bat", ctx())!.source).toBe("data");
    const active: CaPlayerFormats = { ListA: { bat: side(5, 8, 2025, 4000) }, T20: { bat: side(45, 5, 2026, 4000) } };
    expect(estimateFormat(retired, "ListA", "bat", ctx())!.dataWeight).toBeCloseTo(estimateFormat(active, "ListA", "bat", ctx())!.dataWeight, 9);
  });

  it("a thin record (under DATA_BALLS) still informs the estimate but is labelled derived", () => {
    const p: CaPlayerFormats = { ListA: { bat: side(25, 15, 2026, 150, 6) }, T20: { bat: side(30, 5, 2026, 3000) } };
    const e = estimateFormat(p, "ListA", "bat", ctx())!;
    expect(e.source).toBe("derived");
    expect(e.dataWeight).toBeGreaterThan(0);
  });

  it("no record in the format: the translation shrunk toward the below-average prior", () => {
    const p: CaPlayerFormats = { T20: { bat: side(50, 5, 2026, 5000) } };
    const e = estimateFormat(p, "ListA", "bat", ctx())!;
    const t = translatedPrior(p, "ListA", "bat", ctx())!;
    expect(t.mean).toBeCloseTo(37, 6);
    expect(e.source).toBe("derived");
    expect(e.dataWeight).toBe(0);
    expect(e.mean).toBeLessThan(t.mean);
    expect(e.mean).toBeGreaterThan(-8);
    expect(e.sd).toBeLessThan(Math.sqrt(t.var));
  });

  it("the prior comes from whichever other format is most precise, and uses T20 style when the translation has it", () => {
    const p: CaPlayerFormats = { T20: { bat: side(20, 5, 2026, 3000) }, FC: { bat: side(40, 4, 2026, 20000) } };
    expect(translatedPrior(p, "ListA", "bat", ctx())!.from).toBe("T20"); // FC residual 150 > T20's 90 + 12
    const styled = ctx({ translations: { "bowl/T20>ListA": { a: 1, b: 0.5, residVar: 40, n: 900, c: [2, -1] } } });
    const bowler: CaPlayerFormats = { T20: { bowl: side(10, 4, 2026, 2000) }, style: { bowl: [1, 2] } };
    expect(translatedPrior(bowler, "ListA", "bowl", styled)!.mean).toBeCloseTo(1 + 0.5 * 10 + 2 * 1 - 1 * 2, 9);
    expect(estimateFormat({}, "ListA", "bat", ctx())).toBeUndefined();
  });
});

describe("format model: role in a format", () => {
  const rec = (workload: number, pos: number) => ({
    bowl: { ...side(0, 8, 2026, workload * 40, 40), recentPerMatch: workload }, bat: { ...side(0, 8, 2026, 1200, 40), meanPos: pos },
  });
  it("comes from the format's bowling workload and batting position, not the T20 role", () => {
    const batsman = { id: "ca_1", role: "batsman" as const };
    expect(formatRole(batsman, "odi", rec(42, 9.5))).toBe("bowler");
    expect(formatRole(batsman, "odi", rec(42, 5))).toBe("all-rounder");
    expect(formatRole({ id: "ca_2", role: "bowler" as const }, "odi", rec(8, 4))).toBe("batsman");
    expect(formatRole({ ...batsman, isWicketKeeper: true }, "odi", rec(42, 5))).toBe("batsman");
    expect(formatRole({ id: "ca_3", role: "all-rounder" as const }, "odi", undefined)).toBe("all-rounder"); // no record: T20 role
  });

  it("in Tests the Test profile decides when it has the player (test-profile-data.ts)", () => {
    // Shoaib Bashir (a T20 batsman) is a front-line Test spinner batting at the bottom; Ben Stokes bowls and bats in the top seven;
    // Joe Root is a part-timer. Their List A / first-class records here are deliberately misleading: the profile wins.
    expect(formatRole({ id: "espn_1334872", role: "batsman" }, "test", rec(0, 3))).toBe("bowler");
    expect(formatRole({ id: "espn_311158", role: "batsman" }, "test", rec(0, 3))).toBe("all-rounder");
    expect(formatRole({ id: "espn_303669", role: "batsman" }, "test", rec(60, 3))).toBe("batsman");
  });
});

describe("format model: score -> overall curve", () => {
  it("links scores to values by rank and reads monotonically, flat beyond the ends", () => {
    const curve = linkCurve([3, 1, 2, 2, 5], [60, 90, 70, 80, 50]);
    expect(curve.map(c => c.x)).toEqual([1, 2, 3, 5]);
    expect(curve[0].y).toBe(50);
    expect(curve[curve.length - 1].y).toBe(90);
    expect(curve[1].y).toBe(65); // tied scores share the mean of their values
    expect(readCurve(curve, 0)).toBe(50);
    expect(readCurve(curve, 99)).toBe(90);
    expect(readCurve(curve, 4)).toBeCloseTo(85, 9);
    const xs = Array.from({ length: 50 }, (_, i) => i / 5);
    const ys = xs.map(x => readCurve(curve, x));
    ys.slice(1).forEach((y, i) => expect(y).toBeGreaterThanOrEqual(ys[i]));
  });

  it("quantile and percentile are inverse on a sorted list", () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(quantile(sorted, 0)).toBe(10);
    expect(quantile(sorted, 0.5)).toBe(30);
    expect(quantile(sorted, 1)).toBe(50);
    expect(percentile(sorted, 30)).toBe(0.5);
    expect(percentile(sorted, 5)).toBe(0);
    expect(percentile(sorted, 99)).toBe(1);
  });
});
