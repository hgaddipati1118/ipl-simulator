import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { MATCH_CONDITIONS } from "@ipl-sim/engine";
import { createSeries, matchContext, seriesFormat, seriesSquads, type SeriesGender } from "../international";
import { SERIES_TUNING, type SeriesTuning } from "../series-tuning-data";
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
 * standard errors of the real figure): win rates 0.08 / 0.10 home-away, total the larger of 8% and two standard errors of the real mean, runs per wicket 10%, head-to-head 0.15.
 *   BENCH_COUNTRIES=1 npx vitest run packages/app/src/__tests__/benchmark-countries.test.ts --reporter=verbose
 * BENCH_ONLY=t20i-men,odi-men limits the sets; BENCH_MD=1 prints markdown tables.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

interface RealTeam {
  n: number; winRate: number; homeN: number; homeWinRate: number | null; awayN: number; awayWinRate: number | null;
  firstN: number; firstInnings: number | null; firstSd?: number | null; runsPerWicket: number | null;
}
interface RealSet {
  window: string; matches: number; teams: Record<string, RealTeam>;
  h2h: Record<string, { n: number; winRate: Record<string, number> }>; fixtures: [string, string, string | null, number, number][];
}

interface Acc { n: number; w: number; hn: number; hw: number; an: number; aw: number; first: number[]; runs: number; wkts: number }
const newAcc = (): Acc => ({ n: 0, w: 0, hn: 0, hw: 0, an: 0, aw: 0, first: [], runs: 0, wkts: 0 });

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d));
const se = (p: number, n: number) => Math.sqrt((p * (1 - p)) / Math.max(1, n));

interface SetRun { teams: Map<string, Acc>; h2h: Map<string, { n: number; wins: Record<string, number> }>; fixtureWins: number[]; fixtureN: number[] }

/** Replay a set's real fixtures `replays` times with the series' own sides */
function runSet(key: string, real: RealSet, replays: number, FILE: FormatRatingsFile, ACTIVITY: PlayerActivityFile, extended: Awaited<ReturnType<ReturnType<typeof createPoolLoader>["players"]>>): SetRun {
  const [fmt, gender] = key.split("-") as [string, SeriesGender];
  const teams = new Map<string, Acc>();
  const h2h = new Map<string, { n: number; wins: Record<string, number> }>();
  const acc = (t: string) => { let a = teams.get(t); if (!a) { a = newAcc(); teams.set(t, a); } return a; };
  const def = seriesFormat(fmt);
  let seed = 1;
  const fixtureWins: number[] = [], fixtureN: number[] = [];
  real.fixtures.forEach(([a, b, host, n], i) => {
    let fw = 0, fn = 0;
    const series = createSeries({ format: fmt, gender, nations: [a, b], length: 1, host: host === a ? "a" : host === b ? "b" : "neutral", userSide: null, seed: 3000 + i }, FILE, ACTIVITY, extended);
    const squads = seriesSquads(series, FILE, extended);
    for (let j = 0; j < n * replays; j++) {
      const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + seed), key: undefined };
      const rec = def.simulate(ctx as Parameters<typeof def.simulate>[0]);
      const sideOf = (teamId: string) => (teamId === series.sides[0].id ? a : b);
      const winner = rec.winnerId ? sideOf(rec.winnerId) : null;
      if (!winner) continue; // tie, no result, drawn Test: the real set has none
      fn++; if (winner === a) fw++;
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
    fixtureWins.push(fw); fixtureN.push(fn);
    seed += 17;
  });
  return { teams, h2h, fixtureWins, fixtureN };
}

async function setup() {
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "country_validation.json"), "utf-8")) as Record<string, RealSet>;
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const loader = createPoolLoader(async file => new Uint8Array(readFileSync(join(PUBLIC, "pool", file))));
  return { REAL, FILE, ACTIVITY, ext: async (g: SeriesGender) => loader.players(g, ["senior"]) };
}

it.skipIf(!process.env.BENCH_COUNTRIES)("per-country results against real", async () => {
  // BENCH_BEFORE=1: the state before the per-country fit (no series tuning; the T20I conditions of RULES-MATCH.md 12.8 / FORMATS.md as first fitted)
  if (process.env.BENCH_BEFORE) {
    for (const k of Object.keys(SERIES_TUNING)) delete SERIES_TUNING[k];
    MATCH_CONDITIONS.male.t20i = { lo: 0.12, hi: 0.36, center: -0.1776 };
    MATCH_CONDITIONS.female.t20i = { lo: 0.29, hi: 0.435, center: -0.1013 };
  }
  const { REAL, FILE, ACTIVITY, ext } = await setup();
  const replays = Number(process.env.BENCH_REPLAYS ?? 3);
  const only = process.env.BENCH_ONLY?.split(",");
  const md = !!process.env.BENCH_MD;
  const summary: string[] = [];

  for (const key of Object.keys(REAL)) {
    if (only && !only.includes(key)) continue;
    const gender = key.split("-")[1] as SeriesGender;
    const real = REAL[key];
    const { teams, h2h } = runSet(key, real, replays, FILE, ACTIVITY, await ext(gender));
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
        `${f(total, 0)} / ${f(r.firstInnings, 0)}${r.firstInnings ? cmp(t, "1st inns", total, r.firstInnings, Math.max(0.08 * r.firstInnings, (2 * (r.firstSd ?? 0)) / Math.sqrt(Math.max(1, r.firstN)))) : ""}`,
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

/**
 * BENCH_FIT=1: the series tuning (series-tuning.ts) per limited-overs set, by a grid of the strength stretch and the home
 * advantage on BENCH_REPLAYS (default 2) replays of the real fixtures; the loss is the negative log-likelihood of the real
 * results of every fixture given the simulated win probability of its first-named side. CALIBRATE_WRITE=1 writes series-tuning-data.ts.
 */
it.skipIf(!process.env.BENCH_FIT)("series tuning fit", async () => {
  const { REAL, FILE, ACTIVITY, ext } = await setup();
  const replays = Number(process.env.BENCH_REPLAYS ?? 2);
  const spreads = (process.env.FIT_SPREADS ?? "1,1.5,2,2.5,3,3.5").split(",").map(Number);
  const homes = (process.env.FIT_HOMES ?? "0,2,4,6").split(",").map(Number);
  const only = process.env.BENCH_ONLY?.split(",");
  const out: Record<string, Partial<Record<"men" | "women", SeriesTuning>>> = JSON.parse(JSON.stringify(SERIES_TUNING));
  for (const key of ["t20i-men", "t20i-women", "odi-men", "odi-women"]) {
    if (only && !only.includes(key)) continue;
    const [fmt, gender] = key.split("-") as [string, "men" | "women"];
    const real = REAL[key];
    const players = await ext(gender);
    const grid: { spread: number; home: number; loss: number }[] = [];
    for (const spread of spreads) for (const home of homes) {
      SERIES_TUNING[fmt] = { ...(SERIES_TUNING[fmt] ?? {}), [gender]: { spread, home } };
      const run = runSet(key, real, replays, FILE, ACTIVITY, players);
      // the negative log-likelihood per real match of the real results given the simulated win probability of each fixture
      let nll = 0, tot = 0;
      real.fixtures.forEach(([, , , n, w], k) => {
        const p = Math.min(0.97, Math.max(0.03, (run.fixtureWins[k] + 1) / (run.fixtureN[k] + 2)));
        nll -= w * Math.log(p) + (n - w) * Math.log(1 - p); tot += n;
      });
      const loss = nll / tot;
      console.log(`${key} spread ${spread} home ${home}: nll ${loss.toFixed(4)}`);
      grid.push({ spread, home, loss });
    }
    // the grid is flat near its best: of the settings within 0.01 of it, the smallest stretch, then the smallest home advantage
    const floor = Math.min(...grid.map(g => g.loss));
    const best = grid.filter(g => g.loss <= floor + 0.01).sort((a, b) => a.spread - b.spread || a.home - b.home)[0];
    console.log(`${key}: best spread ${best.spread}, home ${best.home} (nll ${best.loss.toFixed(4)})`);
    out[fmt] = { ...(out[fmt] ?? {}), [gender]: { spread: best.spread, home: best.home } };
    SERIES_TUNING[fmt] = { ...(SERIES_TUNING[fmt] ?? {}), [gender]: { spread: best.spread, home: best.home } };
  }
  if (process.env.CALIBRATE_WRITE) {
    const file = join(HERE, "..", "series-tuning-data.ts");
    const src = readFileSync(file, "utf-8");
    const body = Object.entries(out).map(([fmt, g]) => `  ${fmt}: { ${Object.entries(g).map(([k, v]) => `${k}: { spread: ${v!.spread}, home: ${v!.home} }`).join(", ")} },`).join("\n");
    writeFileSync(file, src.replace(/SeriesTuning>>> = \{[\s\S]*\};\n$/, `SeriesTuning>>> = {\n${body}\n};\n`));
    console.log("wrote " + file);
  }
}, 14_400_000);
