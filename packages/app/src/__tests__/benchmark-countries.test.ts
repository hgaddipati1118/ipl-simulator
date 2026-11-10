import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesFormat, seriesSquads, type SeriesGender } from "../international";
import { createPoolLoader } from "../extended-pool";

/**
 * Per-country benchmark (skipped unless BENCH_COUNTRIES=1): the national sides' simulated results against the real ones
 * over the window each engine was fitted on (docs/data/country_validation.json, from
 * packages/ratings/src/analysis/country-validation.py): men's and women's T20Is and ODIs since 2019, men's Tests since 2023,
 * between the twelve full members.
 *
 * The real fixtures (pairing, host country or neutral, count) are replayed BENCH_REPLAYS times (default 3) with the series'
 * own sides (national squads of active players on the format's ratings, the extended pool's senior players among the
 * candidates), instant engine. Per country it prints: win rate overall, at home and away; the mean first-innings total when
 * batting first; runs per wicket over all its innings; then the head-to-head win rates of the pairs with 8+ real matches.
 * A row is marked OFF when the simulated figure is outside the tolerance of the real one (the larger of a fixed band and two
 * standard errors of the real figure): win rates 0.08 / 0.10 home-away, total 8%, runs per wicket 10%, head-to-head 0.15.
 *   BENCH_COUNTRIES=1 npx vitest run packages/app/src/__tests__/benchmark-countries.test.ts --reporter=verbose
 * BENCH_ONLY=t20i-men,odi-men limits the sets; BENCH_MD=1 prints markdown tables.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

interface RealTeam {
  n: number; winRate: number; homeN: number; homeWinRate: number | null; awayN: number; awayWinRate: number | null;
  firstN: number; firstInnings: number | null; runsPerWicket: number | null;
}
interface RealSet {
  window: string; matches: number; teams: Record<string, RealTeam>;
  h2h: Record<string, { n: number; winRate: Record<string, number> }>; fixtures: [string, string, string | null, number][];
}

interface Acc { n: number; w: number; hn: number; hw: number; an: number; aw: number; first: number[]; runs: number; wkts: number }
const newAcc = (): Acc => ({ n: 0, w: 0, hn: 0, hw: 0, an: 0, aw: 0, first: [], runs: 0, wkts: 0 });

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d));
const se = (p: number, n: number) => Math.sqrt((p * (1 - p)) / Math.max(1, n));

it.skipIf(!process.env.BENCH_COUNTRIES)("per-country results against real", async () => {
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "country_validation.json"), "utf-8")) as Record<string, RealSet>;
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const replays = Number(process.env.BENCH_REPLAYS ?? 3);
  const only = process.env.BENCH_ONLY?.split(",");
  const md = !!process.env.BENCH_MD;
  const summary: string[] = [];

  for (const key of Object.keys(REAL)) {
    if (only && !only.includes(key)) continue;
    const [fmt, gender] = key.split("-") as [string, SeriesGender];
    const real = REAL[key];
    const extended = await createPoolLoader(async file => new Uint8Array(readFileSync(join(PUBLIC, "pool", file)))).players(gender, ["senior"]);
    const teams = new Map<string, Acc>();
    const h2h = new Map<string, { n: number; wins: Record<string, number> }>();
    const acc = (t: string) => { let a = teams.get(t); if (!a) { a = newAcc(); teams.set(t, a); } return a; };
    const def = seriesFormat(fmt);
    let seed = 1;
    real.fixtures.forEach(([a, b, host, n], i) => {
      const series = createSeries({ format: fmt, gender, nations: [a, b], length: 1, host: host === a ? "a" : host === b ? "b" : "neutral", userSide: null, seed: 3000 + i }, FILE, ACTIVITY, extended);
      const squads = seriesSquads(series, FILE, extended);
      for (let j = 0; j < n * replays; j++) {
        const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + seed), key: undefined };
        const rec = def.simulate(ctx as Parameters<typeof def.simulate>[0]);
        const sideOf = (teamId: string) => (teamId === series.sides[0].id ? a : b);
        const winner = rec.winnerId ? sideOf(rec.winnerId) : null;
        if (!winner) continue; // tie, no result, drawn Test: the real set has none
        const pair = [a, b].sort().join(" v ");
        const h = h2h.get(pair) ?? { n: 0, wins: {} as Record<string, number> };
        h.n++; h.wins[winner] = (h.wins[winner] ?? 0) + 1; h2h.set(pair, h);
        for (const t of [a, b]) {
          const s = acc(t);
          s.n++; if (winner === t) s.w++;
          if (host === t) { s.hn++; if (winner === t) s.hw++; } else if (host !== null) { s.an++; if (winner === t) s.aw++; }
        }
        rec.innings.forEach((inn, k) => {
          const s = acc(sideOf(inn.battingTeamId));
          if (k === 0) s.first.push(inn.totalRuns);
          s.runs += inn.totalRuns; s.wkts += inn.totalWickets;
        });
      }
      seed += 17;
    });

    const flags: string[] = [];
    const cmp = (name: string, label: string, sim: number | null, real: number | null, tol: number) => {
      const bad = sim !== null && real !== null && Math.abs(sim - real) > tol;
      if (bad) flags.push(`${key} ${name} ${label}: sim ${f(sim, 2)} real ${f(real, 2)}`);
      return bad ? " OFF" : "";
    };
    console.log(`\n${key}: real ${real.window}, ${real.matches} matches; sim ${[...teams.values()].reduce((x, t) => x + t.n, 0) / 2} matches (${replays} replays of each fixture)`);
    const head = "| country | win rate sim / real | home sim / real | away sim / real | 1st inns sim / real | runs per wicket sim / real |";
    console.log(md ? `${head}\n|---|---|---|---|---|---|` : head);
    for (const [t, r] of Object.entries(real.teams)) {
      const s = teams.get(t);
      if (!s) continue;
      const total = s.first.length ? s.first.reduce((x, y) => x + y, 0) / s.first.length : null;
      const rpw = s.wkts ? s.runs / s.wkts : null;
      const wTol = Math.max(0.08, 2 * se(r.winRate, r.n));
      const cells = [
        `${f(s.w / s.n, 2)} / ${f(r.winRate, 2)}${cmp(t, "win", s.w / s.n, r.winRate, wTol)}`,
        `${f(s.hn ? s.hw / s.hn : null, 2)} / ${f(r.homeWinRate, 2)} (n ${r.homeN})${r.homeWinRate !== null && s.hn ? cmp(t, "home", s.hw / s.hn, r.homeWinRate, Math.max(0.10, 2 * se(r.homeWinRate, r.homeN))) : ""}`,
        `${f(s.an ? s.aw / s.an : null, 2)} / ${f(r.awayWinRate, 2)} (n ${r.awayN})${r.awayWinRate !== null && s.an ? cmp(t, "away", s.aw / s.an, r.awayWinRate, Math.max(0.10, 2 * se(r.awayWinRate, r.awayN))) : ""}`,
        `${f(total, 0)} / ${f(r.firstInnings, 0)}${r.firstInnings ? cmp(t, "1st inns", total, r.firstInnings, 0.08 * r.firstInnings) : ""}`,
        `${f(rpw, 1)} / ${f(r.runsPerWicket, 1)}${r.runsPerWicket ? cmp(t, "runs/wkt", rpw, r.runsPerWicket, 0.10 * r.runsPerWicket) : ""}`,
      ];
      console.log(`| ${t} | ${cells.join(" | ")} |`);
    }
    console.log("\nhead to head (win rate of the first side; sim / real):");
    for (const [pair, r] of Object.entries(real.h2h)) {
      const [a, b] = pair.split(" v ");
      const h = h2h.get(pair);
      if (!h) continue;
      const sim = (h.wins[a] ?? 0) / h.n;
      console.log(`  ${a} v ${b}: ${f(sim, 2)} / ${f(r.winRate[a], 2)} (n ${r.n})${cmp(`${a} v ${b}`, "h2h", sim, r.winRate[a], Math.max(0.15, 2 * se(r.winRate[a], r.n)))}`);
    }
    summary.push(`${key}: ${flags.length} OFF${flags.length ? ` (${flags.join("; ")})` : ""}`);
  }
  console.log("\nSummary\n" + summary.join("\n"));
}, 14_400_000);
