import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesSquads } from "../international";
import { SERIES_TUNING, type SeriesTuning } from "../series-tuning-data";
import { createPoolLoader } from "../extended-pool";
import { testFixture } from "../test-match/test-series";
import { playTestInstantly } from "../test-match/test-entry";
import { TEST_BAZBALL_CAL, TEST_FORM, TEST_LEVEL_CAL } from "@ipl-sim/engine";

/**
 * Test results by country, three-way (docs/COUNTRY-VALIDATION.md, "Test results by country"; skipped unless BENCH_TEST3=1).
 * Every men's Test between full members since 2019, draws included (docs/data/actual_xi_test.json, `TEST_ALL=1
 * generate-actual-xi.ts`), played BENCH_REPLAYS times with the XIs that really played and the real host, instant engine. England
 * bat with the Bazball factor only from June 2022. A match's loss is -log of the simulated probability of the real result
 * (side a wins / draw / side b wins; counts + 0.5 over replays + 1.5), so draws count.
 *
 *   BENCH_TEST3=1 BENCH_HALF=fit|hold|all [BENCH_FROM=2023-01-01] BENCH_REPLAYS=128 BENCH_OUT=/path/out.json \
 *     [BENCH_TUNE='{"spread":1,"home":-1.5}'] [BENCH_LEVEL=w,r] [BENCH_FORM=sd] [BENCH_BAZCAL=w,r] npx vitest run packages/app/src/__tests__/benchmark-test-countries.test.ts -t "three-way"
 *   BENCH_COMPARE3=a.json,b.json ... -t "paired"      paired per-match difference (b - a) and its standard error, by half
 * Fit half: to 2024-12-31; holdout: 2025+.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = process.env.BENCH_PUBLIC ?? join(HERE, "..", "..", "public");

interface ActualTest {
  id: string; date: string; a: string; b: string; host: "a" | "b" | null; venue: string; winner: "a" | "b" | null;
  xi: { a: (string | null)[]; b: (string | null)[] };
}
/** Per match: replays won by a / by b / drawn, the real result, and each side's runs and wickets summed over replays */
export interface Test3Out {
  id: string; date: string; a: string; b: string; host: string | null; res: "a" | "b" | "d";
  aw: number; bw: number; d: number; ar: number; awk: number; br: number; bwk: number; ab: number; bb: number;
  /** Replays won by an innings, with the follow-on enforced, drawn after the 4th innings began, and the days played summed */
  inn?: number; fo?: number; d4?: number; days?: number;
  /** Sum and sum of squares over replays of log(a's runs per wicket / b's), wickets + 0.5 (the spread of the margin) */
  lr?: number; lr2?: number;
}

export function loss3(m: Test3Out): number {
  const n = m.aw + m.bw + m.d;
  const c = m.res === "a" ? m.aw : m.res === "b" ? m.bw : m.d;
  return -Math.log((c + 0.5) / (n + 1.5));
}

export function paired3(a: Test3Out[], b: Test3Out[]): { diff: number; se: number; n: number } {
  const bm = new Map(b.map(m => [m.id, m]));
  const d = a.filter(m => bm.has(m.id)).map(m => loss3(bm.get(m.id)!) - loss3(m));
  const mean = d.reduce((s, x) => s + x, 0) / Math.max(1, d.length);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, d.length - 1));
  return { diff: mean, se: sd / Math.sqrt(Math.max(1, d.length)), n: d.length };
}

interface Cell { n: number; rw: number; rd: number; sw: number; sd: number; v: number }
/** Per country (all / home / away): real wins and draws, the sim's expected wins and draws, and the variance of wins under the sim */
export function byCountry(ms: Test3Out[]): Record<string, { all: Cell; home: Cell; away: Cell; runs: number; wkts: number }> {
  const out: Record<string, { all: Cell; home: Cell; away: Cell; runs: number; wkts: number }> = {};
  const cell = (): Cell => ({ n: 0, rw: 0, rd: 0, sw: 0, sd: 0, v: 0 });
  for (const m of ms) {
    const n = m.aw + m.bw + m.d;
    for (const side of ["a", "b"] as const) {
      const t = side === "a" ? m.a : m.b;
      const o = (out[t] ??= { all: cell(), home: cell(), away: cell(), runs: 0, wkts: 0 });
      const pw = (side === "a" ? m.aw : m.bw) / n, pd = m.d / n;
      const rw = m.res === side ? 1 : 0, rd = m.res === "d" ? 1 : 0;
      const cells = [o.all, m.host === t ? o.home : m.host ? o.away : null].filter((c): c is Cell => !!c);
      for (const c of cells) { c.n++; c.rw += rw; c.rd += rd; c.sw += pw; c.sd += pd; c.v += pw * (1 - pw); }
      o.runs += side === "a" ? m.ar : m.br; o.wkts += side === "a" ? m.awk : m.bwk;
    }
  }
  return out;
}

export function summary3(ms: Test3Out[]): string {
  const l = ms.map(loss3);
  const mean = l.reduce((s, x) => s + x, 0) / l.length;
  const se = Math.sqrt(l.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, l.length - 1) / l.length);
  let rd = 0, sd = 0, hn = 0, hw = 0, rhw = 0;
  for (const m of ms) {
    const n = m.aw + m.bw + m.d;
    rd += m.res === "d" ? 1 : 0; sd += m.d / n;
    if (m.host) { hn++; hw += (m.host === m.a ? m.aw : m.bw) / n; rhw += m.res === (m.host === m.a ? "a" : "b") ? 1 : 0; }
  }
  const lines = [`loss3 ${mean.toFixed(4)} +- ${se.toFixed(4)} (${ms.length} Tests); draws real ${(100 * rd / ms.length).toFixed(1)}% sim ${(100 * sd / ms.length).toFixed(1)}%; home wins real ${(100 * rhw / hn).toFixed(1)}% sim ${(100 * hw / hn).toFixed(1)}% (of ${hn} hosted)`];
  const f = (c: Cell) => c.n ? `${(c.rw / c.n).toFixed(2)}/${(c.sw / c.n).toFixed(2)} d ${(c.rd / c.n).toFixed(2)}/${(c.sd / c.n).toFixed(2)} n ${String(c.n).padStart(3)} z ${((c.rw - c.sw) / Math.sqrt(Math.max(0.25, c.v))).toFixed(1).padStart(4)}` : "-";
  lines.push(`${"country".padEnd(13)} ${"all: win real/sim, draw real/sim, n, z".padEnd(44)} | ${"home".padEnd(44)} | away | sim runs/wkt`);
  for (const [t, o] of Object.entries(byCountry(ms)).sort()) lines.push(`${t.padEnd(13)} ${f(o.all).padEnd(44)} | ${f(o.home).padEnd(44)} | ${f(o.away).padEnd(44)} | ${(o.runs / Math.max(1, o.wkts)).toFixed(1)}`);
  for (const b of byFavourite(ms)) if (b.n) lines.push(`sim favourite ${b.lo.toFixed(2)}-${Math.min(1, b.hi).toFixed(2)}: n ${b.n}, favourite wins real ${(100 * b.realWin).toFixed(1)}% sim ${(100 * b.simWin).toFixed(1)}%, draws real ${(100 * b.realDraw).toFixed(1)}% sim ${(100 * b.simDraw).toFixed(1)}%, sim innings wins ${(100 * b.simInn).toFixed(1)}%`);
  return lines.join("\n");
}

/** One bucket of Tests by the sim's favourite: real and sim win share of the favourite, draws and innings victories */
export interface FavBucket { lo: number; hi: number; n: number; realWin: number; simWin: number; realDraw: number; simDraw: number; simInn: number }
/**
 * Favourite calibration (docs/FORMATS.md, Test section 6.13): Tests put in buckets by the sim's win probability of its favourite
 * (the side with more replay wins), with the real share the favourite won and drew against the sim's. A sim whose favourites win
 * too often shows real below sim in the top buckets. `simInn` is the share of replays won by an innings (when recorded).
 */
export function byFavourite(ms: Test3Out[], edges: number[] = [0, 0.5, 0.65, 0.8, 1.01]): FavBucket[] {
  const out: FavBucket[] = edges.slice(0, -1).map((lo, k) => ({ lo, hi: edges[k + 1], n: 0, realWin: 0, simWin: 0, realDraw: 0, simDraw: 0, simInn: 0 }));
  for (const m of ms) {
    const n = m.aw + m.bw + m.d;
    const fav = m.aw >= m.bw ? "a" : "b";
    const p = (fav === "a" ? m.aw : m.bw) / n;
    const b = out.find(x => p >= x.lo && p < x.hi);
    if (!b) continue;
    b.n++; b.realWin += m.res === fav ? 1 : 0; b.simWin += p; b.realDraw += m.res === "d" ? 1 : 0; b.simDraw += m.d / n; b.simInn += (m.inn ?? 0) / n;
  }
  for (const b of out) if (b.n) { b.realWin /= b.n; b.simWin /= b.n; b.realDraw /= b.n; b.simDraw /= b.n; b.simInn /= b.n; }
  return out;
}

const half = (date: string, h: string) => h === "all" || (h === "fit" ? date <= "2024-12-31" : date >= "2025-01-01");

it("byFavourite buckets Tests by the sim favourite's win probability", () => {
  const m = (aw: number, bw: number, d: number, res: Test3Out["res"], inn = 0): Test3Out => ({ id: "x", date: "2025-01-01", a: "A", b: "B", host: null, res, aw, bw, d, ar: 0, awk: 0, br: 0, bwk: 0, ab: 0, bb: 0, inn });
  const [b0, b1, b2, b3] = byFavourite([m(90, 5, 5, "a", 30), m(10, 85, 5, "d"), m(60, 30, 10, "b"), m(40, 45, 15, "b")]);
  expect(b3.n).toBe(2);
  expect(b3.realWin).toBeCloseTo(0.5);
  expect(b3.simWin).toBeCloseTo(0.875);
  expect(b3.realDraw).toBeCloseTo(0.5);
  expect(b3.simInn).toBeCloseTo(0.15);
  expect(b2.n).toBe(0);
  expect(b1.n).toBe(1);
  expect(b1.realWin).toBe(0);
  expect(b0.n).toBe(1);
  expect(b0.simWin).toBeCloseTo(0.45);
});

it.skipIf(!process.env.BENCH_TEST3)("Test by country: three-way actual-XI replay", async () => {
  const replays = Number(process.env.BENCH_REPLAYS ?? 64);
  const h = process.env.BENCH_HALF ?? "all";
  const from = process.env.BENCH_FROM ?? "2019-01-01";
  if (process.env.BENCH_LEVEL) { const [w, r] = process.env.BENCH_LEVEL.split(",").map(Number); TEST_LEVEL_CAL.wickets = w; TEST_LEVEL_CAL.runs = r; }
  if (process.env.BENCH_FORM) TEST_FORM.sd = Number(process.env.BENCH_FORM);
  if (process.env.BENCH_BAZCAL) { const [w, r] = process.env.BENCH_BAZCAL.split(",").map(Number); TEST_BAZBALL_CAL.wickets = w; TEST_BAZBALL_CAL.runs = r; }
  if (process.env.BENCH_TUNE) SERIES_TUNING.test = { ...(SERIES_TUNING.test ?? {}), men: JSON.parse(process.env.BENCH_TUNE) as SeriesTuning };
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const loader = createPoolLoader(async file => new Uint8Array(readFileSync(join(PUBLIC, "pool", file))));
  const extended = await loader.players("men", ["senior"]);
  const all = (JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi_test.json"), "utf-8")) as Record<string, ActualTest[]>)["test-men"];
  const out: Test3Out[] = [];
  const t0 = Date.now();
  all.forEach((m, i) => {
    if (m.date < from || !half(m.date, h)) return;
    if (process.env.BENCH_TEAM && m.a !== process.env.BENCH_TEAM && m.b !== process.env.BENCH_TEAM) return;
    const hostName = m.host === "a" ? m.a : m.host === "b" ? m.b : null;
    const series = createSeries({ format: "test", gender: "men", nations: [m.a, m.b], length: 1, host: m.host ?? "neutral", userSide: null, seed: 5000 + i }, FILE, ACTIVITY, extended);
    series.ground = m.venue;
    const fallback = seriesSquads(series, FILE, extended);
    for (const side of [0, 1] as const) {
      let ids = [...new Set((side === 0 ? m.xi.a : m.xi.b).filter((x): x is string => x !== null))];
      for (let pass = 0; pass < 2; pass++) {
        series.sides[side].squad = ids;
        const have = new Set(seriesSquads(series, FILE, extended)[side].map(p => p.id));
        ids = ids.filter(id => have.has(id));
        for (const p of fallback[side]) if (ids.length < 11 && !ids.includes(p.id)) ids.push(p.id);
      }
      series.sides[side].squad = ids;
      (series.lineups ??= [null, null])[side] = { xi: ids.slice(0, 11), order: ids.slice(0, 11) };
    }
    const squads = seriesSquads(series, FILE, extended);
    const rec: Test3Out = { id: m.id, date: m.date, a: m.a, b: m.b, host: hostName, res: m.winner ?? "d", aw: 0, bw: 0, d: 0, ar: 0, awk: 0, br: 0, bwk: 0, ab: 0, bb: 0, inn: 0, fo: 0, d4: 0, days: 0, lr: 0, lr2: 0 };
    for (let j = 0; j < replays; j++) {
      const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + 1), key: undefined };
      const fx = testFixture(ctx);
      if (m.date < "2022-06-01" || process.env.BENCH_BAZBALL === "0") delete fx.bazballTeamId;
      const res = playTestInstantly(fx);
      const aId = series.sides[0].id;
      const w = res.result.kind === "win" ? res.result.winnerId : null;
      if (w === null) rec.d++; else if (w === aId) rec.aw++; else rec.bw++;
      if (res.result.margin.startsWith("an innings")) rec.inn!++;
      if (res.innings.some(x => x.followOn)) rec.fo!++;
      if (w === null && res.innings.length >= 4) rec.d4!++;
      rec.days! += res.result.day;
      const rw = [0, 0, 0, 0];
      for (const inn of res.innings) {
        const [ov, bl] = inn.overs.split(".").map(Number);
        const balls = 6 * ov + (bl || 0);
        if (inn.teamId === aId) { rec.ar += inn.runs; rec.awk += inn.wickets; rec.ab += balls; rw[0] += inn.runs; rw[1] += inn.wickets; } else { rec.br += inn.runs; rec.bwk += inn.wickets; rec.bb += balls; rw[2] += inn.runs; rw[3] += inn.wickets; }
      }
      const lr = Math.log(((rw[0] + 1) / (rw[1] + 0.5)) / ((rw[2] + 1) / (rw[3] + 0.5)));
      rec.lr! += lr; rec.lr2! += lr * lr;
    }
    out.push(rec);
  });
  console.log(`test-men ${h} from ${from} x${replays}, ${((Date.now() - t0) / 1000).toFixed(0)}s\n` + summary3(out));
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(out));
}, 36_000_000);

it.skipIf(!process.env.BENCH_COMPARE3)("Test by country: paired three-way comparison", () => {
  const [a, b] = process.env.BENCH_COMPARE3!.split(",").map(f => JSON.parse(readFileSync(f, "utf-8")) as Test3Out[]);
  for (const hh of ["fit", "hold", "all"]) {
    const d = paired3(a.filter(m => half(m.date, hh)), b.filter(m => half(m.date, hh)));
    console.log(`${hh}: paired (b - a) ${d.diff.toFixed(4)} +- ${d.se.toFixed(4)} over ${d.n} Tests`);
  }
  console.log("a:\n" + summary3(a) + "\nb:\n" + summary3(b));
});
