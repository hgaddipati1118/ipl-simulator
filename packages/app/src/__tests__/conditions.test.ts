/**
 * Conditions a user sets for a series (engine conditions.ts): pitch (flat / seaming / turning / slow), light (ODI) and weather (Test) act through
 * the fitted ground terms. Each moves play the way the real grounds it is built from do: flat and slow move totals, turning and seaming move
 * who takes the wickets, an ODI under lights chases worse than by day, a clear Test loses no time and an unsettled one loses some.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMatchState, isPaceBowler, isSpinBowler, simulateMatch, simulateRemaining, simulateTestMatch, PITCH_PRESETS, applyConditionsToProfile, type ConditionsSetting, type Player } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { createSeries, matchContext, seriesFormat, seriesSquads, type IntlSeries } from "../international";
import { testFixture } from "../test-match/test-series";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
const make = (format: "t20i" | "odi" | "test", host: "a" | "b" | "neutral" = "neutral"): IntlSeries =>
  createSeries({ format, gender: "men", nations: ["England", "Pakistan"], length: 1, host, userSide: null, seed: 11 }, FILE);

interface Tally { first: number; n: number; spinW: number; paceW: number; spinB: number; paceB: number; chaseWins: number; decided: number; wkts: number }

function play(format: "t20i" | "odi", conditions: ConditionsSetting | undefined, n: number): Tally {
  const s0 = make(format);
  const s = { ...s0, conditions };
  const squads = seriesSquads(s, FILE);
  const style = new Map<string, Player["bowlingStyle"]>();
  for (const sq of squads) for (const p of sq) style.set(p.name, p.bowlingStyle);
  const t: Tally = { first: 0, n: 0, spinW: 0, paceW: 0, spinB: 0, paceB: 0, chaseWins: 0, decided: 0, wkts: 0 };
  for (let i = 0; i < n; i++) {
    const ctx = { ...matchContext(s, 0, squads), seed: 100 + i, key: undefined };
    const res = simulateMatch(ctx.home, ctx.away, ctx.rules ?? seriesFormat(format).rules!("men"), ctx.seed,
      { countTowardStandings: false, rain: false, neutralVenue: true, ...(ctx.conditions ? { conditions: ctx.conditions } : {}) });
    const d = res.detailed!;
    t.first += d.innings1.totalRuns; t.n++;
    if (d.result.includes("won by")) { t.decided++; if (d.innings2.totalRuns >= (d.innings1.totalRuns + 1)) t.chaseWins++; }
    for (const b of d.ballLog) {
      const st = style.get(b.bowlerName);
      const legal = b.eventType !== "wide" && b.eventType !== "noball";
      if (st && isSpinBowler(st) && legal) t.spinB++;
      else if (st && isPaceBowler(st) && legal) t.paceB++;
      if (b.eventType === "wicket") { t.wkts++; if (st && isSpinBowler(st)) t.spinW++; else if (st && isPaceBowler(st)) t.paceW++; }
    }
  }
  return t;
}

describe("pitch presets", () => {
  it("a flat pitch scores more and a slow one less than the ground as it is (T20I and ODI)", () => {
    for (const [format, n] of [["t20i", 250], ["odi", 120]] as const) {
      const base = play(format, undefined, n), flat = play(format, { pitch: "flat" }, n), slow = play(format, { pitch: "slow" }, n);
      expect(flat.first / flat.n).toBeGreaterThan(base.first / base.n * 1.01); // 250 matches a side: a standard error of about 1.3% on the difference
      expect(slow.first / slow.n).toBeLessThan(base.first / base.n * 0.99);
    }
  }, 180_000);

  it("a turning pitch moves wickets to spin, a seaming one to pace (T20I)", () => {
    const base = play("t20i", undefined, 400), turn = play("t20i", { pitch: "turning" }, 400), seam = play("t20i", { pitch: "seaming" }, 400);
    const spinRate = (t: Tally) => t.spinW / t.spinB, paceRate = (t: Tally) => t.paceW / t.paceB;
    expect(spinRate(turn) / paceRate(turn)).toBeGreaterThan(spinRate(base) / paceRate(base));
    expect(spinRate(seam) / paceRate(seam)).toBeLessThan(spinRate(base) / paceRate(base));
  }, 180_000);

  it("the presets are the real grounds' top-tenth means: flat and slow are about 8% on runs either way, with the grounds' own wicket shrinkage", () => {
    expect(PITCH_PRESETS.t20.flat.run).toBeGreaterThan(1.05);
    expect(PITCH_PRESETS.t20.slow.run).toBeLessThan(0.95);
    const p = applyConditionsToProfile(null, { pitch: "flat" }, "t20", 0.03)!;
    expect(p.runMult).toBeCloseTo(PITCH_PRESETS.t20.flat.run, 5);
    // a quarter of the wicket factor, as the real grounds' (WICKET_FACTOR_WEIGHT)
    expect(p.wicketMult).toBeCloseTo(1 + (PITCH_PRESETS.t20.flat.wkt - 1) * 0.25, 5);
  });

  it("no conditions leaves the ground alone (the same profile object)", () => {
    const g = applyConditionsToProfile(null, undefined, "t20", 0.03);
    expect(g).toBeNull();
    expect(applyConditionsToProfile(null, { weather: "clear" }, "odi", 0.03)).toBeNull();
  });

  it("the live engine takes the pitch too (flat scores more than slow)", () => {
    const run = (conditions: ConditionsSetting) => {
      const s = { ...make("t20i"), conditions };
      const squads = seriesSquads(s, FILE);
      let total = 0;
      for (let i = 0; i < 80; i++) {
        const ctx = { ...matchContext(s, 0, squads), seed: 300 + i };
        const state = createMatchState(ctx.home, ctx.away, ctx.rules!, null, ctx.seed, { rain: false, neutralVenue: true, conditions });
        const done = simulateRemaining(state).state;
        total += done.innings1Score ?? 0;
      }
      return total / 80;
    };
    expect(run({ pitch: "flat" })).toBeGreaterThan(run({ pitch: "slow" }) * 1.05);
  }, 180_000);
});

describe("light (ODI)", () => {
  it("under lights the chasing side does worse than by day (List A: +4.6% by day, -1.2% day-night)", () => {
    const day = play("odi", { light: "day" }, 700), night = play("odi", { light: "night" }, 700);
    const d = day.chaseWins / day.decided, n = night.chaseWins / night.decided;
    expect(d - n).toBeGreaterThan(0.02);
  }, 300_000);
});

describe("a Test's pitch and weather", () => {
  const sim = (conditions: ConditionsSetting | undefined, n: number) => {
    const s = make("test", "a");
    const ctx = { ...matchContext(s, 0, seriesSquads(s, FILE)), seed: 5 };
    let runs = 0, wk = 0, lost = 0, balls = 0;
    for (let i = 0; i < n; i++) {
      const f = testFixture({ ...ctx, seed: 900 + i, conditions });
      const res = simulateTestMatch(f.home, f.away, { seed: f.seed, country: f.country, xi: f.xi, conditions: f.conditions });
      for (const inn of res.innings) { runs += inn.runs; wk += inn.wickets; balls += Math.round(parseFloat(inn.overs) * 6); }
      lost += res.state.weatherLost.reduce((a, b) => a + b, 0);
    }
    return { rpb: runs / Math.max(1, balls), wk, lost };
  };

  it("a flat pitch scores faster than a slow one", () => {
    expect(sim({ pitch: "flat" }, 40).rpb).toBeGreaterThan(sim({ pitch: "slow" }, 40).rpb);
  }, 120_000);

  it("clear weather loses no time, unsettled loses some (same seeds)", () => {
    const clear = sim({ weather: "clear" }, 30);
    expect(clear.lost).toBe(0);
    const wet = sim({ weather: "unsettled" }, 30);
    expect(wet.lost).toBeGreaterThan(0);
  }, 120_000);
});

/** BENCH_CONDITIONS=1: what each setting does to play (the table of docs/TACTICS.md): first-innings runs, wickets, pace and spin wicket rates, chase wins */
it.skipIf(!process.env.BENCH_CONDITIONS)("what the conditions do", () => {
  const rows: string[] = [];
  for (const [format, n] of [["t20i", 1500], ["odi", 800]] as const) {
    const settings: [string, ConditionsSetting | undefined][] = [["as the ground is", undefined], ["flat", { pitch: "flat" }], ["slow and low", { pitch: "slow" }], ["turning", { pitch: "turning" }], ["seaming", { pitch: "seaming" }],
      ...(format === "odi" ? [["day", { light: "day" }], ["day-night", { light: "night" }]] as [string, ConditionsSetting][] : [])];
    for (const [label, c] of settings) {
      const t = play(format, c, n);
      rows.push(`${format} | ${label.padEnd(16)} | 1st inns ${(t.first / t.n).toFixed(1)} | wkts/match ${(t.wkts / t.n).toFixed(1)} | pace w/100b ${(100 * t.paceW / t.paceB).toFixed(2)} | spin w/100b ${(100 * t.spinW / t.spinB).toFixed(2)} | chase wins ${(100 * t.chaseWins / t.decided).toFixed(1)}%`);
    }
  }
  console.log(rows.join("\n"));
}, 3_600_000);

/** BENCH_LIGHT=1: the chase-win gap between day and day-night at the shipped tilt (target: List A +4.6% by day, -1.2% day-night: 5.8 points) */
it.skipIf(!process.env.BENCH_LIGHT)("ODI light: the chase gap", () => {
  const n = Number(process.env.BENCH_LIGHT_N ?? 4000);
  const day = play("odi", { light: "day" }, n), night = play("odi", { light: "night" }, n);
  const d = day.chaseWins / day.decided, nn = night.chaseWins / night.decided;
  console.log(`ODI light (${n} matches each): chase wins by day ${(100 * d).toFixed(1)}%, day-night ${(100 * nn).toFixed(1)}%, gap ${(100 * (d - nn)).toFixed(1)} points (List A: 5.8)`);
}, 3_600_000);
