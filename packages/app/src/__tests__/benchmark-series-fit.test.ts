import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesFormat, seriesSquads, type SeriesGender } from "../international";
import { SERIES_TUNING, type SeriesTuning } from "../series-tuning-data";
import { createPoolLoader } from "../extended-pool";

/**
 * Series-tuning fit and paired comparison on actual-XI play (skipped unless BENCH_SERIES=1). Used for the Test tuning and the ODI refit
 * (docs/COUNTRY-VALIDATION.md, "Test and ODI series tuning"). Every real match of a set (docs/data/actual_xi.json) is played BENCH_REPLAYS
 * times with the XIs that really played, the real host and ground, instant engine; a match's loss is -log of the simulated probability
 * of the real winner among decided replays ((w + 1) / (n + 2)), the figure of docs/COUNTRY-VALIDATION.md.
 *
 *   BENCH_SERIES=1 BENCH_KEY=test-men BENCH_HALF=fit|hold|all BENCH_REPLAYS=256 BENCH_OUT=/path/out.json \
 *     [BENCH_TUNE='{"test":{"men":{"spread":1,"home":0,"homeBy":{"India":-2}}}}'] [BENCH_ONLY_HOST=India,England] \
 *     npx vitest run packages/app/src/__tests__/benchmark-series-fit.test.ts
 * BENCH_PUBLIC=dir reads data/format-ratings.json, player-activity.json and pool/ from another directory (a variant of the ratings). BENCH_TUNE replaces the shipped tuning of that format and gender. The output file holds, per match, wins / decided / draws of the
 * real winner and of side a, so two runs are compared per match (paired standard errors) by `pairedDiff` below.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = process.env.BENCH_PUBLIC ?? join(HERE, "..", "..", "public");

interface ActualMatch {
  id: string; date: string; a: string; b: string; host: "a" | "b" | null; venue: string; winner: "a" | "b";
  xi: { a: (string | null)[]; b: (string | null)[] };
}
export interface MatchOut { id: string; date: string; a: string; b: string; host: string | null; winner: string; mw: number; mn: number; draws: number; aw: number }

const loss = (m: MatchOut) => -Math.log(Math.min(0.97, Math.max(0.03, (m.mw + 1) / (m.mn + 2))));

/** Paired difference of two runs' per-match loss: mean (b - a) and its standard error over matches */
export function pairedDiff(a: MatchOut[], b: MatchOut[]): { diff: number; se: number; n: number } {
  const bm = new Map(b.map(m => [m.id, m]));
  const d = a.filter(m => bm.has(m.id)).map(m => loss(bm.get(m.id)!) - loss(m));
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, d.length - 1));
  return { diff: mean, se: sd / Math.sqrt(d.length), n: d.length };
}

export function summarise(ms: MatchOut[]): { loss: number; se: number; draw: number; homeDecisive: number | null; byTeam: Record<string, { n: number; w: number; hn: number; hw: number; an: number; aw: number }> } {
  const l = ms.map(loss);
  const mean = l.reduce((s, x) => s + x, 0) / l.length;
  const se = Math.sqrt(l.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, l.length - 1) / l.length);
  let draws = 0, tot = 0, hn = 0, hw = 0;
  const byTeam: Record<string, { n: number; w: number; hn: number; hw: number; an: number; aw: number }> = {};
  for (const m of ms) {
    draws += m.draws; tot += m.mn + m.draws;
    // wins of the real winner / decided: to get each side's wins use aw (side a wins) over decided
    const bName = m.winner === m.a ? undefined : m.winner; void bName;
    const aWin = m.aw / Math.max(1, m.mn), bWin = 1 - aWin;
    for (const [t, p] of [[m.a, aWin], [m.b, bWin]] as [string, number][]) {
      const s = (byTeam[t] ??= { n: 0, w: 0, hn: 0, hw: 0, an: 0, aw: 0 });
      s.n += m.mn; s.w += p * m.mn;
      if (m.host === t) { s.hn += m.mn; s.hw += p * m.mn; } else if (m.host) { s.an += m.mn; s.aw += p * m.mn; }
    }
    if (m.host) { const pa = m.host === m.a ? m.aw / m.mn : 1 - m.aw / m.mn; hn += m.mn; hw += pa * m.mn; }
  }
  return { loss: mean, se, draw: draws / tot, homeDecisive: hn ? hw / hn : null, byTeam };
}

it.skipIf(!process.env.BENCH_SERIES)("series tuning: actual-XI replay", async () => {
  const key = process.env.BENCH_KEY ?? "test-men";
  const [fmt, gender] = key.split("-") as [string, SeriesGender];
  const replays = Number(process.env.BENCH_REPLAYS ?? 64);
  const half = process.env.BENCH_HALF ?? "all";
  const only = process.env.BENCH_ONLY_HOST?.split(",");
  if (process.env.BENCH_TUNE) {
    const t = JSON.parse(process.env.BENCH_TUNE) as Record<string, Partial<Record<"men" | "women", SeriesTuning | null>>>;
    for (const [f, g] of Object.entries(t)) for (const [k, v] of Object.entries(g)) {
      if (v === null) { if (SERIES_TUNING[f]) delete SERIES_TUNING[f][k as "men"]; } else SERIES_TUNING[f] = { ...(SERIES_TUNING[f] ?? {}), [k]: v };
    }
  }
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const loader = createPoolLoader(async file => new Uint8Array(readFileSync(join(PUBLIC, "pool", file))));
  const extended = await loader.players(gender, ["senior"]);
  const all = (JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>)[key];
  const matches = all.filter(m => half === "all" || (half === "fit" ? m.date <= "2024-12-31" : m.date >= "2025-01-01"));
  const def = seriesFormat(fmt);
  const out: MatchOut[] = [];
  const t0 = Date.now();
  matches.forEach((m, i0) => {
    const i = all.indexOf(m); // the seed of a match does not depend on the half
    const hostName = m.host === "a" ? m.a : m.host === "b" ? m.b : null;
    if (only && !(hostName && only.includes(hostName))) return;
    const series = createSeries({ format: fmt, gender, nations: [m.a, m.b], length: 1, host: m.host === "a" ? "a" : m.host === "b" ? "b" : "neutral", userSide: null, seed: 3000 + i }, FILE, ACTIVITY, extended);
    series.ground = m.venue;
    const fallback = seriesSquads(series, FILE, extended);
    for (const side of [0, 1] as const) {
      const real11 = (side === 0 ? m.xi.a : m.xi.b).filter((x): x is string => x !== null);
      let ids = [...new Set(real11)];
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
    const winnerName = m.winner === "a" ? m.a : m.b;
    let mw = 0, mn = 0, aw = 0, draws = 0;
    for (let j = 0; j < replays; j++) {
      const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + 1), key: undefined };
      const rec = def.simulate(ctx as Parameters<typeof def.simulate>[0]);
      const winner = rec.winnerId ? (rec.winnerId === series.sides[0].id ? m.a : m.b) : null;
      if (!winner) { draws++; continue; }
      mn++; if (winner === winnerName) mw++; if (winner === m.a) aw++;
    }
    out.push({ id: m.id, date: m.date, a: m.a, b: m.b, host: hostName, winner: winnerName, mw, mn, draws, aw });
    void i0;
  });
  const s = summarise(out);
  const line = (t: string, x: { n: number; w: number; hn: number; hw: number; an: number; aw: number }) =>
    `${t.padEnd(14)} win ${(x.w / x.n).toFixed(2)} home ${x.hn ? (x.hw / x.hn).toFixed(2) : "-"} away ${x.an ? (x.aw / x.an).toFixed(2) : "-"}`;
  console.log(`${key} ${half} x${replays}: loss ${s.loss.toFixed(4)} +- ${s.se.toFixed(4)} (${out.length} matches), draw ${(100 * s.draw).toFixed(1)}%, home of decided ${s.homeDecisive === null ? "-" : (100 * s.homeDecisive).toFixed(1)}%, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const [t, x] of Object.entries(s.byTeam).sort()) console.log("  " + line(t, x));
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(out));
}, 14_400_000);

/** BENCH_COMPARE=a.json,b.json: paired difference of per-match loss (b - a) */
it.skipIf(!process.env.BENCH_COMPARE)("series tuning: paired comparison of two runs", () => {
  const [a, b] = process.env.BENCH_COMPARE!.split(",").map(f => JSON.parse(readFileSync(f, "utf-8")) as MatchOut[]);
  const d = pairedDiff(a, b);
  console.log(`paired (b - a): ${d.diff.toFixed(4)} +- ${d.se.toFixed(4)} over ${d.n} matches; a ${summarise(a).loss.toFixed(4)}, b ${summarise(b).loss.toFixed(4)}`);
});
