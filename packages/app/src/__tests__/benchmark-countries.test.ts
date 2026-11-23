import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { ATTACK_MODEL, BATTER_RESPONSE, LAST_PAIR, INNINGS_CLOCK_SWITCH as CLOCK_SWITCH, CAPTAIN_MODEL, INNINGS_CLOCK, INNINGS_CLOCK_SWITCH, IN_MATCH_INJURY_SWITCH, LAST_PAIR_SWITCH, LEAGUE_LEVELS, MATCH_CONDITIONS, ODI_CAL, T20_BOWLER_TYPE, VENUE_LEVEL_SWITCH, setRuleOverrides, type Player } from "@ipl-sim/engine";
import { XI_SHARPEN } from "../realistic-xi";
import { availabilitySource, createSeries, matchContext, seriesFormat, seriesSquads, type SeriesGender, type SeriesMatchRecord } from "../international";
import { SERIES_TUNING, type SeriesTuning } from "../series-tuning-data";
import { createPoolLoader } from "../extended-pool";
// LEVELS_FILE=levels.json: LEAGUE_LEVELS entries replaced (a T20I at a league's ground plays its wicket and dot levels: docs/TACTICS.md section 10)
if (process.env.LEVELS_FILE) Object.assign(LEAGUE_LEVELS, JSON.parse(readFileSync(process.env.LEVELS_FILE, "utf-8")));

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
 * BENCH_ONLY=t20i-men,odi-men limits the sets; BENCH_MD=1 prints markdown tables. BENCH_REALISTIC=1 plays realistic line-ups (an XI
 * sampled per match from the side's pool by real selection rates, realistic-xi.ts); BENCH_AVAIL_2024=1 uses the rates of 2024 matches
 * only, BENCH_HOLDOUT=1 scores against the real fixtures of 2025+ (BENCH_HOLDOUT=fit: those up to 2024, where the sharpening is fitted).
 */
/** WT_OFF=1: no innings clock (docs/TACTICS.md section 6); WT_FILE=table.json: its tables replaced by those of a t20-wicket-timing.py fit */
if (process.env.WT_OFF) INNINGS_CLOCK_SWITCH.off = true;
if (process.env.WT_FILE) { const t = JSON.parse(readFileSync(process.env.WT_FILE, "utf-8")).tables; for (const k of Object.keys(INNINGS_CLOCK)) delete INNINGS_CLOCK[k]; Object.assign(INNINGS_CLOCK, t); }
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
function runSet(key: string, real: RealSet, replays: number, FILE: FormatRatingsFile, ACTIVITY: PlayerActivityFile, extended: Awaited<ReturnType<ReturnType<typeof createPoolLoader>["players"]>>, realisticOn = !!process.env.BENCH_REALISTIC): SetRun {
  const [fmt, gender] = key.split("-") as [string, SeriesGender];
  const teams = new Map<string, Acc>();
  const h2h = new Map<string, { n: number; wins: Record<string, number> }>();
  const acc = (t: string) => { let a = teams.get(t); if (!a) { a = newAcc(); teams.set(t, a); } return a; };
  const def = seriesFormat(fmt);
  let seed = 1;
  const fixtureWins: number[] = [], fixtureN: number[] = [];
  real.fixtures.forEach(([a, b, host, n], i) => {
    let fw = 0, fn = 0;
    const series = createSeries({ format: fmt, gender, nations: [a, b], length: 1, host: host === a ? "a" : host === b ? "b" : "neutral", userSide: null, seed: 3000 + i, realistic: realisticOn }, FILE, ACTIVITY, extended);
    const squads = seriesSquads(series, FILE, extended);
    for (let j = 0; j < n * replays; j++) {
      // realistic line-ups: a fresh XI per replayed match (the XI is sampled from the match seed)
      const ctx = { ...matchContext(realisticOn ? { ...series, seedBase: 104729 * (j + seed) + i } : series, 0, squads), seed: 7919 * i + 104729 * (j + seed), key: undefined };
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
  // BENCH_CAL_FILE / BENCH_TUNING_FILE: replace the ODI calibration / the series tuning with the values in a json file (regression attribution, refits)
  if (process.env.BENCH_CAL_FILE) { const c = JSON.parse(readFileSync(process.env.BENCH_CAL_FILE, "utf-8")); for (const g of ["male", "female"] as const) c[g].forEach((row: number[], i: number) => row.forEach((v, j) => { ODI_CAL[g][i][j] = v; })); }
  if (process.env.BENCH_TUNING_FILE) { const t = JSON.parse(readFileSync(process.env.BENCH_TUNING_FILE, "utf-8")); for (const k of Object.keys(SERIES_TUNING)) delete SERIES_TUNING[k]; Object.assign(SERIES_TUNING, t); }
  // women's T20I variants: BENCH_CAPTAIN_WOMEN=off plays their bowling by the former rule, BENCH_WTYPE=neutral drops the women's bowler type x phase table,
  // BENCH_NO_RESPONSE=1 the refitted batter response (the engine before docs/TACTICS.md section 5's refit, with the contexts as they stand)
  if (process.env.BENCH_CAPTAIN_WOMEN === "off") CAPTAIN_MODEL.womenT20I = false;
  // BENCH_ATTACK=t20i: the men's T20I chooses its bowlers from the whole eleven with its attack table (docs/TACTICS.md section 8); =off: no attack table anywhere
  if (process.env.BENCH_ATTACK === "t20i") ATTACK_MODEL.t20i = true;
  if (process.env.BENCH_ATTACK === "off") { ATTACK_MODEL.t20i = false; ATTACK_MODEL.league = false; }
  if (process.env.BENCH_WTYPE === "neutral") for (const t of T20_BOWLER_TYPE.female) for (const b of t) b.fill(1);
  // BENCH_BR_FILE=table.json: another batter response (the json of t20-batter-response.py, BR_DUMP) in place of the shipped one
  if (process.env.BENCH_BR_FILE) { const t = JSON.parse(readFileSync(process.env.BENCH_BR_FILE, "utf-8")); for (const g of ["male", "female"] as const) for (const k of Object.keys(t[g])) BATTER_RESPONSE[g][k] = t[g][k]; }
  if (process.env.BENCH_NO_RESPONSE) for (const g of ["male", "female"] as const) for (const k of Object.keys(BATTER_RESPONSE[g])) BATTER_RESPONSE[g][k] = BATTER_RESPONSE[g][k].map(() => 0);
  // BENCH_LP_OFF=t20,odi,test: no last-pair term (docs/TACTICS.md section 5) in those formats; BENCH_LP_SCALE=t20:0.5,odi:1 scales it
  for (const f of (process.env.BENCH_LP_OFF ?? "").split(",").filter(Boolean)) LAST_PAIR_SWITCH.off[f as "t20" | "odi" | "test"] = true;
  // BENCH_WT20I_LEVELS=on: a women's T20I at a franchise ground plays the league's wicket and dot levels (the engine before docs/COUNTRY-VALIDATION.md, "Women's T20I tails")
  if (process.env.BENCH_WT20I_LEVELS === "on") VENUE_LEVEL_SWITCH.womenT20I = false;
  // BENCH_LP_WOMEN=1: the women's T20I last-pair table of docs/data/last_pair.json (fitted, not shipped: docs/TACTICS.md section 5) played
  if (process.env.BENCH_LP_WOMEN) LAST_PAIR.t20i.female = JSON.parse(readFileSync(join(REPO, "docs", "data", "last_pair.json"), "utf-8")).tables.t20i.female;
  // BENCH_WCLOCK=off: no women's T20I innings clock (the engine before docs/COUNTRY-VALIDATION.md, "Women's T20I tails")
  if (process.env.BENCH_WCLOCK === "off") CLOCK_SWITCH.womenT20I = false;
  // IMI_OFF=1: no concussion substitutes (in-match-injury.ts; the engine before them)
  if (process.env.IMI_OFF) IN_MATCH_INJURY_SWITCH.off = true;
  for (const kv of (process.env.BENCH_LP_SCALE ?? "").split(",").filter(Boolean)) { const [f, v] = kv.split(":"); LAST_PAIR_SWITCH.scale[f as "t20" | "odi" | "test"] = Number(v); }
  if (process.env.BENCH_GAMMA) for (const k of ["t20i-men", "t20i-women", "odi-men", "odi-women", "test-men"]) XI_SHARPEN[k] = Number(process.env.BENCH_GAMMA);
  // BENCH_HOLDOUT=1: selection rates from 2024 matches only, scored against the real fixtures of 2025+ (docs/data/country_validation_2025.json)
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", process.env.BENCH_HOLDOUT === "fit" ? "country_validation_to2024.json" : process.env.BENCH_HOLDOUT ? "country_validation_2025.json" : "country_validation.json"), "utf-8")) as Record<string, RealSet>;
  if (process.env.BENCH_AVAIL_2024) availabilitySource.data = JSON.parse(readFileSync(join(REPO, "docs", "data", "intl_availability_2024.json"), "utf-8"));
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  if (process.env.BENCH_NO_ADJUST) delete FILE.adjust;
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
    const { teams, h2h, fixtureWins, fixtureN } = runSet(key, real, replays, FILE, ACTIVITY, await ext(gender));
    let nll = 0, tot = 0;
    real.fixtures.forEach(([, , , n, w], k) => {
      const p = Math.min(0.97, Math.max(0.03, (fixtureWins[k] + 1) / (fixtureN[k] + 2)));
      nll -= w * Math.log(p) + (n - w) * Math.log(1 - p); tot += n;
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
    summary.push(`${key}: ${flags.length} OFF, log loss ${(nll / tot).toFixed(4)}${flags.length ? ` (${flags.join("; ")})` : ""}`);
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
      const run = playFit(key, real, replays, FILE, ACTIVITY, players);
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

/** BENCH_EVAL=1: the log loss per real match at the current tuning, per limited-overs set (BENCH_NO_ADJUST=1: without the opposition adjustment) */
it.skipIf(!process.env.BENCH_EVAL)("log loss at the current tuning", async () => {
  const { REAL, FILE, ACTIVITY, ext } = await setup();
  const replays = Number(process.env.BENCH_REPLAYS ?? 8);
  for (const key of ["t20i-men", "t20i-women", "odi-men", "odi-women"]) {
    const real = REAL[key];
    const run = playFit(key, real, replays, FILE, ACTIVITY, await ext(key.split("-")[1] as SeriesGender));
    let nll = 0, tot = 0;
    real.fixtures.forEach(([, , , n, w], k) => {
      const p = Math.min(0.97, Math.max(0.03, (run.fixtureWins[k] + 1) / (run.fixtureN[k] + 2)));
      nll -= w * Math.log(p) + (n - w) * Math.log(1 - p); tot += n;
    });
    console.log(`${key}: log loss ${(nll / tot).toFixed(4)}`);
  }
}, 14_400_000);

/**
 * BENCH_FITHOME=1: each host country's own home advantage (SeriesTuning.homeBy) per limited-overs set. Every fixture is replayed
 * (BENCH_REPLAYS, default 8) at a grid of uniform home advantages; a host country's loss at each is the negative log-likelihood of
 * the real results of the fixtures it hosted, plus (h - h0)^2 / (2 x 4^2) pulling it toward the set's own uniform best h0 (a prior
 * of 4 rating points). CALIBRATE_WRITE=1 writes `home` (= h0) and `homeBy` (the countries that differ) into series-tuning-data.ts.
 */
it.skipIf(!process.env.BENCH_FITHOME)("home advantage per country", async () => {
  const { REAL, FILE, ACTIVITY, ext } = await setup();
  const replays = Number(process.env.BENCH_REPLAYS ?? 8);
  const grid = [0, 2, 4, 6, 8, 10, 12, 14];
  const only = process.env.BENCH_ONLY?.split(",");
  const out: Record<string, Partial<Record<"men" | "women", SeriesTuning>>> = JSON.parse(JSON.stringify(SERIES_TUNING));
  for (const key of ["t20i-men", "t20i-women", "odi-men", "odi-women"]) {
    if (only && !only.includes(key)) continue;
    const [fmt, gender] = key.split("-") as [string, "men" | "women"];
    const real = REAL[key];
    const players = await ext(gender);
    const base = SERIES_TUNING[fmt]![gender]!;
    const nllBy = new Map<string, number[]>();
    const total: number[] = [];
    for (const [gi, h] of grid.entries()) {
      SERIES_TUNING[fmt] = { ...(SERIES_TUNING[fmt] ?? {}), [gender]: { spread: base.spread, home: h } };
      const run = playFit(key, real, replays, FILE, ACTIVITY, players);
      let all = 0;
      real.fixtures.forEach(([, , host, n, w], k) => {
        if (!host) return;
        const p = Math.min(0.97, Math.max(0.03, (run.fixtureWins[k] + 1) / (run.fixtureN[k] + 2)));
        const nll = -(w * Math.log(p) + (n - w) * Math.log(1 - p));
        const arr = nllBy.get(host) ?? grid.map(() => 0); arr[gi] += nll; nllBy.set(host, arr); all += nll;
      });
      total.push(all);
    }
    const h0 = grid[total.indexOf(Math.min(...total))];
    const homeBy: Record<string, number> = {};
    for (const [country, arr] of nllBy) {
      const pen = grid.map((h, gi) => arr[gi] + ((h - h0) ** 2) / (2 * 16));
      const best = grid[pen.indexOf(Math.min(...pen))];
      if (best !== h0) homeBy[country] = best;
      console.log(`${key} ${country}: ${grid.map((h, gi) => `${h}:${arr[gi].toFixed(1)}`).join(" ")} -> ${best}`);
    }
    console.log(`${key}: uniform best home ${h0}; per country ${JSON.stringify(homeBy)}`);
    out[fmt] = { ...(out[fmt] ?? {}), [gender]: { spread: base.spread, home: h0, ...(Object.keys(homeBy).length ? { homeBy } : {}) } };
    SERIES_TUNING[fmt] = { ...(SERIES_TUNING[fmt] ?? {}), [gender]: out[fmt]![gender]! };
  }
  if (process.env.CALIBRATE_WRITE) {
    const file = join(HERE, "..", "series-tuning-data.ts");
    const src = readFileSync(file, "utf-8");
    const fmtT = (v: SeriesTuning) => `{ spread: ${v.spread}, home: ${v.home}${v.homeBy ? `, homeBy: { ${Object.entries(v.homeBy).map(([c, x]) => `"${c}": ${x}`).join(", ")} }` : ""} }`;
    const body = Object.entries(out).map(([f, g]) => `  ${f}: {\n${Object.entries(g).map(([k, v]) => `    ${k}: ${fmtT(v!)},`).join("\n")}\n  },`).join("\n");
    writeFileSync(file, src.replace(/SeriesTuning>>> = \{[\s\S]*\};\n$/, `SeriesTuning>>> = {\n${body}\n};\n`));
    console.log("wrote " + file);
  }
}, 14_400_000);

// ── Actual XI ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// docs/COUNTRY-VALIDATION.md, "Actual XI": each real match is played with the eleven each side really fielded (and their real
// batting order), host and ground as real, through the same series code path a user's XI takes (IntlSeries.lineups).

interface ActualMatch {
  id: string; date: string; a: string; b: string; host: "a" | "b" | null; venue: string; winner: "a" | "b";
  xi: { a: (string | null)[]; b: (string | null)[] };
  bat: { a: [number, number][]; b: [number, number][] };
}
type Extended = Awaited<ReturnType<ReturnType<typeof createPoolLoader>["players"]>>;

/** The figures of a run outside their tolerance (the same tests as the per-country benchmark) */
function offFigures(key: string, real: RealSet, run: SetRun): string[] {
  const flags: string[] = [];
  const cmp = (name: string, label: string, sim: number | null, r: number | null, tol: number) => {
    if (sim !== null && r !== null && Math.abs(sim - r) > tol) flags.push(`${key} ${name} ${label}`);
  };
  for (const [t, r] of Object.entries(real.teams)) {
    const s = run.teams.get(t);
    if (!s) continue;
    const total = s.first.length ? s.first.reduce((x, y) => x + y, 0) / s.first.length : null;
    const rpw = s.wkts ? s.runs / s.wkts : null;
    cmp(t, "win", s.w / s.n, r.winRate, Math.max(0.08, 2 * se(r.winRate, r.n)));
    if (r.homeWinRate !== null && s.hn) cmp(t, "home", s.hw / s.hn, r.homeWinRate, Math.max(0.10, 2 * se(r.homeWinRate, r.homeN)));
    if (r.awayWinRate !== null && s.an) cmp(t, "away", s.aw / s.an, r.awayWinRate, Math.max(0.10, 2 * se(r.awayWinRate, r.awayN)));
    if (r.firstInnings) cmp(t, "1st inns", total, r.firstInnings, Math.max(0.08 * r.firstInnings, (2 * (r.firstSd ?? 0)) / Math.sqrt(Math.max(1, r.firstN))));
    if (r.runsPerWicket) cmp(t, "runs/wkt", rpw, r.runsPerWicket, 0.10 * r.runsPerWicket);
  }
  for (const [pair, r] of Object.entries(real.h2h)) {
    const [a] = pair.split(" v ");
    const h = run.h2h.get(pair);
    if (h) cmp(pair, "h2h", (h.wins[a] ?? 0) / h.n, r.winRate[a], Math.max(0.15, 2 * se(r.winRate[a], r.n)));
  }
  return flags;
}

/** Log loss per real match of a run's fixture-level win probabilities (the figure of the other sections of this file) */
function fixtureLoss(real: RealSet, run: SetRun): number {
  let nll = 0, tot = 0;
  real.fixtures.forEach(([, , , n, w], k) => {
    const p = Math.min(0.97, Math.max(0.03, (run.fixtureWins[k] + 1) / (run.fixtureN[k] + 2)));
    nll -= w * Math.log(p) + (n - w) * Math.log(1 - p); tot += n;
  });
  return nll / tot;
}

interface ActualRun extends SetRun { matchLoss: number; matches: number; perMatch: { id: string; date: string; a: string; b: string; winner: string; mw: number; mn: number; aw: number; host: string | null }[] }
interface ActualOpts {
  /** the real batting order (default); false: the engine's order for the real XI */
  order?: boolean;
  /** the real ground by name (default); false: the host's busiest ground */
  ground?: boolean;
  /** false: the series' own sides (their best XIs, the engine's order) on the real match's ground and date (diagnostics) */
  actualXI?: boolean;
  /** true: every match at a neutral venue (no ground, no home side; diagnostics) */
  neutral?: boolean;
  /** called with every replayed match's record, the real match and the XI's squads (BENCH_POSITIONS) */
  collect?: (m: ActualMatch, rec: SeriesMatchRecord, sideOf: (teamId: string) => "a" | "b", order: [string[], string[]], squads: [Player[], Player[]]) => void;
}

/**
 * What the fit tests play (BENCH_FIT, BENCH_EVAL, BENCH_FITHOME): the best XIs against the real fixtures, or with BENCH_FIT_ON=actual the XIs that
 * really played, on the half BENCH_HOLDOUT names (fit: to 2024; 1: 2025+; none: all). The tuning terms are then fitted for the line-ups a user sets.
 */
function playFit(key: string, real: RealSet, replays: number, FILE: FormatRatingsFile, ACTIVITY: PlayerActivityFile, players: Extended): SetRun {
  if (process.env.BENCH_FIT_ON !== "actual") return runSet(key, real, replays, FILE, ACTIVITY, players);
  const all = (JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>)[key];
  const h = process.env.BENCH_HOLDOUT;
  return runActual(key, real, all.filter(m => (h === "fit" ? m.date <= "2024-12-31" : h ? m.date >= "2025-01-01" : true)), replays, FILE, ACTIVITY, players);
}

/** Play every real match of `matches` `replays` times with the XIs that really played */
function runActual(key: string, real: RealSet, matches: ActualMatch[], replays: number, FILE: FormatRatingsFile, ACTIVITY: PlayerActivityFile, extended: Extended, opts: ActualOpts = {}): ActualRun {
  const [fmt, gender] = key.split("-") as [string, SeriesGender];
  const teams = new Map<string, Acc>();
  const h2h = new Map<string, { n: number; wins: Record<string, number> }>();
  const acc = (t: string) => { let a = teams.get(t); if (!a) { a = newAcc(); teams.set(t, a); } return a; };
  const def = seriesFormat(fmt);
  const fixtureIdx = new Map(real.fixtures.map(([a, b, host], i) => [`${a} v ${b}|${host}`, i]));
  const fixtureWins = real.fixtures.map(() => 0), fixtureN = real.fixtures.map(() => 0);
  let matchNll = 0, matchCount = 0;
  const perMatch: ActualRun["perMatch"] = [];
  matches.forEach((m, i) => {
    const hostName = m.host === "a" ? m.a : m.host === "b" ? m.b : null;
    const [fa, fb] = [m.a, m.b].sort();
    const k = fixtureIdx.get(`${fa} v ${fb}|${hostName}`);
    if (k === undefined) return;
    const series = createSeries({ format: fmt, gender, nations: [m.a, m.b], length: 1, host: opts.neutral ? "neutral" : m.host === "a" ? "a" : m.host === "b" ? "b" : "neutral", userSide: null, seed: 3000 + i }, FILE, ACTIVITY, extended);
    if (opts.ground !== false) series.ground = m.venue;
    // the real eleven (unknown places filled from the side's best), in the real batting order
    const fallback = seriesSquads(series, FILE, extended);
    for (const side of [0, 1] as const) {
      if (opts.actualXI === false) break;
      const real11 = (side === 0 ? m.xi.a : m.xi.b).filter((x): x is string => x !== null);
      let ids = [...new Set(real11)];
      for (let pass = 0; pass < 2; pass++) {
        series.sides[side].squad = ids;
        const have = new Set(seriesSquads(series, FILE, extended)[side].map(p => p.id));
        ids = ids.filter(id => have.has(id));
        for (const p of fallback[side]) if (ids.length < 11 && !ids.includes(p.id)) ids.push(p.id);
      }
      series.sides[side].squad = ids;
      (series.lineups ??= [null, null])[side] = { xi: ids.slice(0, 11), order: opts.order === false ? [] : ids.slice(0, 11) };
    }
    const squads = seriesSquads(series, FILE, extended);
    if (opts.actualXI === false) series.lineups = [{ xi: squads[0].slice(0, 11).map(p => p.id), order: [] }, { xi: squads[1].slice(0, 11).map(p => p.id), order: [] }];
    const sideOf = (teamId: string) => (teamId === series.sides[0].id ? m.a : m.b);
    const winnerName = m.winner === "a" ? m.a : m.b;
    let mw = 0, mn = 0, aw = 0;
    for (let j = 0; j < replays; j++) {
      const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + 1), key: undefined };
      const rec = def.simulate(ctx as Parameters<typeof def.simulate>[0]);
      const winner = rec.winnerId ? sideOf(rec.winnerId) : null;
      opts.collect?.(m, rec, t => (t === series.sides[0].id ? "a" : "b"), [series.lineups![0]!.order, series.lineups![1]!.order], squads);
      if (!winner) continue;
      mn++; if (winner === winnerName) mw++; if (winner === m.a) aw++;
      fixtureN[k]++; if (winner === fa) fixtureWins[k]++;
      const pair = [m.a, m.b].sort().join(" v ");
      const h = h2h.get(pair) ?? { n: 0, wins: {} as Record<string, number> };
      h.n++; h.wins[winner] = (h.wins[winner] ?? 0) + 1; h2h.set(pair, h);
      for (const t of [m.a, m.b]) {
        const s = acc(t);
        s.n++; if (winner === t) s.w++;
        if (hostName === t) { s.hn++; if (winner === t) s.hw++; } else if (hostName !== null) { s.an++; if (winner === t) s.aw++; }
      }
      rec.innings.forEach((inn, q) => {
        const s = acc(sideOf(inn.battingTeamId));
        if (q === 0) s.first.push(inn.totalRuns);
        s.runs += inn.totalRuns; s.wkts += inn.totalWickets;
      });
    }
    perMatch.push({ id: m.id, date: m.date, a: m.a, b: m.b, winner: winnerName, mw, mn, aw, host: hostName });
    if (mn > 0) {
      const p = Math.min(0.97, Math.max(0.03, (mw + 1) / (mn + 2)));
      matchNll -= Math.log(p); matchCount++;
    }
  });
  return { teams, h2h, fixtureWins, fixtureN, matchLoss: matchNll / Math.max(1, matchCount), matches: matchCount, perMatch };
}

/**
 * BENCH_ACTUAL=1 [BENCH_REPLAYS=16] [BENCH_ONLY=t20i-men,...] [BENCH_MODES=best,realistic,actual,actual-auto-order,actual-default-ground]:
 * log loss per real match (and countries OFF) of the three ways to field a side, on the fit half (to 2024) and the 2025+ holdout.
 * Realistic line-ups use the rates of 2024 matches only and the shipped sharpening (XI_SHARPEN, BENCH_GAMMA); the actual XIs need no rates.
 */
it.skipIf(!process.env.BENCH_ACTUAL)("actual XI against best and realistic line-ups", async () => {
  const { FILE, ACTIVITY, ext } = await setup();
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>;
  availabilitySource.data = JSON.parse(readFileSync(join(REPO, "docs", "data", "intl_availability_2024.json"), "utf-8"));
  const replays = Number(process.env.BENCH_REPLAYS ?? 16);
  const only = process.env.BENCH_ONLY?.split(",");
  const modes = (process.env.BENCH_MODES ?? "best,realistic,actual,actual-auto-order").split(",");
  const halves: [string, string, (d: string) => boolean][] = [
    ["fit (to 2024)", "country_validation_to2024.json", d => d <= "2024-12-31"],
    ["holdout (2025+)", "country_validation_2025.json", d => d >= "2025-01-01"],
  ];
  const rows: string[] = [];
  for (const key of Object.keys(ACT)) {
    if (only && !only.includes(key)) continue;
    const players = await ext(key.split("-")[1] as SeriesGender);
    for (const [label, file, inHalf] of halves) {
      const real = (JSON.parse(readFileSync(join(REPO, "docs", "data", file), "utf-8")) as Record<string, RealSet>)[key];
      const ms = ACT[key].filter(m => inHalf(m.date));
      for (const mode of modes) {
        const t0 = Date.now();
        let run: SetRun, matchLoss = NaN;
        if (mode === "best" || mode === "realistic") run = runSet(key, real, replays, FILE, ACTIVITY, players, mode === "realistic");
        else {
          const r = runActual(key, real, ms, replays, FILE, ACTIVITY, players, { order: mode !== "actual-auto-order", ground: mode !== "actual-default-ground" });
          run = r; matchLoss = r.matchLoss;
          if (process.env.BENCH_DUMP) writeFileSync(`${process.env.BENCH_DUMP}-${key}-${label.startsWith("fit") ? "fit" : "hold"}-${mode}.json`, JSON.stringify(r.perMatch));
        }
        const off = offFigures(key, real, run);
        const line = `${key} | ${label} | ${mode} | log loss ${fixtureLoss(real, run).toFixed(4)} | per match ${Number.isNaN(matchLoss) ? "-" : matchLoss.toFixed(4)} | ${off.length} OFF | ${((Date.now() - t0) / 1000).toFixed(0)}s`;
        console.log(line);
        rows.push(line);
        if (process.env.BENCH_LIST) console.log("   " + off.join("; "));
      }
    }
  }
  console.log("\nSummary\n" + rows.join("\n"));
}, 14_400_000);

/**
 * BENCH_POSITIONS=1 [BENCH_REPLAYS=4] [BENCH_ONLY=...]: does the batting order matter as it does in real cricket? For the matches played with the real XIs, mean runs
 * and balls faced by batting position (first innings, the order the batters came to the crease) in the sim against the real record, with the real batting order and
 * with the engine's own order for the same XI.
 */
it.skipIf(!process.env.BENCH_POSITIONS)("batting position against real", async () => {
  const { FILE, ACTIVITY, ext } = await setup();
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>;
  const replays = Number(process.env.BENCH_REPLAYS ?? 4);
  const only = process.env.BENCH_ONLY?.split(",");
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "country_validation.json"), "utf-8")) as Record<string, RealSet>;
  for (const key of Object.keys(ACT)) {
    if (only && !only.includes(key)) continue;
    const players = await ext(key.split("-")[1] as SeriesGender);
    // BENCH_FROM=2024-01-01 / BENCH_TO=2023-12-31: only the matches from / to that date (the out-of-sample half of a refit, and the half it was fitted on)
    const ms = ACT[key].filter(m => m.date >= (process.env.BENCH_FROM ?? "0") && m.date <= (process.env.BENCH_TO ?? "9"));
    const real = Array.from({ length: 11 }, () => ({ r: 0, b: 0, n: 0 }));
    for (const m of ms) for (const side of ["a", "b"] as const) m.bat[side].forEach(([r, b], i) => { if (i < 11) { real[i].r += r; real[i].b += b; real[i].n++; } });
    const out: string[] = [`${key}: position | real runs / balls (n) | sim runs / balls (real order) | sim runs / balls (engine order)`];
    const sims: Record<string, { r: number; b: number; n: number }[]> = {};
    for (const mode of ["real", "engine"]) {
      const acc = Array.from({ length: 11 }, () => ({ r: 0, b: 0, n: 0 }));
      const rate = Array(11).fill(0) as number[];
      runActual(key, REAL[key], ms, replays, FILE, ACTIVITY, players, {
        order: mode === "real",
        collect: (_m, rec, _sideOf, _order, squads) => {
          const byName = new Map(squads.flat().map(p => [p.name, p]));
          // each side's first innings
          for (const inn of rec.innings.slice(0, 2)) {
            inn.batters.forEach((bt, i) => {
              if (i < 11) { acc[i].r += bt.runs; acc[i].b += bt.balls; acc[i].n++; const p = byName.get(bt.playerName); if (p) { rate[i] += (p.battingOvr + p.ratings.timing) / 200; } }
            });
          }
        },
      });
      sims[mode] = acc;
      if (mode === "real") out.push("  mean batting rating (batOvr + timing) / 200 by position: " + rate.map((x, i) => (acc[i].n ? x / acc[i].n : 0).toFixed(2)).join(" "));
    }
    for (let i = 0; i < 11; i++) {
      const f1 = (x: { r: number; b: number; n: number }) => (x.n ? `${(x.r / x.n).toFixed(1)} / ${(x.b / x.n).toFixed(1)}` : "-");
      out.push(`  ${i + 1} | ${f1(real[i])} (${real[i].n}) | ${f1(sims.real[i])} | ${f1(sims.engine[i])}`);
    }
    console.log(out.join("\n"));
  }
}, 14_400_000);

/**
 * BENCH_TAILS=out.json [BENCH_REPLAYS=8] [BENCH_ONLY=t20i-women]: the lower order against real (docs/COUNTRY-VALIDATION.md, "Women's T20I tails").
 * For the matches played with the real XIs, per innings: runs / balls by batting position (a not-out batter who came in and faced no ball counted 0 / 0,
 * as the real record has him), legal balls / runs / wickets by wickets down (from the fall of wickets), the last-wicket stand, first-innings all-out and
 * total; the XI's places that are not in the pool (played by a stand-in from the side's best) by position. Per real match, so the real side
 * (packages/ratings/src/analysis/t20-tails.py) can be read on the same matches and the halves split by date. Dumps json.
 */
it.skipIf(!process.env.BENCH_TAILS)("tails against real (dump)", async () => {
  const { FILE, ACTIVITY, ext } = await setup();
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>;
  const REAL = JSON.parse(readFileSync(join(REPO, "docs", "data", "country_validation.json"), "utf-8")) as Record<string, RealSet>;
  const replays = Number(process.env.BENCH_REPLAYS ?? 8);
  const only = (process.env.BENCH_ONLY ?? "t20i-women").split(",");
  // BENCH_TAILS_RAIN=off: no rain (the real matches of actual_xi.json were all played out)
  if (process.env.BENCH_TAILS_RAIN === "off") setRuleOverrides({ rainNoResult: 0, rainReduced: 0 });
  const out: Record<string, unknown> = {};
  for (const key of only) {
    const players = await ext(key.split("-")[1] as SeriesGender);
    const perMatch = new Map<string, { date: string; n: number; pos: number[][]; rat: number[][]; state: number[][]; state2: number[][]; phase: number[][]; over1: number[][]; last: number[]; first: number[]; firstW: number; allOut: number; standIn: number[] }>();
    const ballsOf = (s: string) => { const m = /\((\d+)\.(\d+) ov\)/.exec(s); return m ? Number(m[1]) * 6 + Number(m[2]) : NaN; };
    // BENCH_TAILS_GROUND=default: the host's busiest ground in place of the real one
    runActual(key, REAL[key], ACT[key], replays, FILE, ACTIVITY, players, {
      ground: process.env.BENCH_TAILS_GROUND !== "default",
      actualXI: process.env.BENCH_TAILS_XI !== "series",
      neutral: process.env.BENCH_TAILS_GROUND === "neutral",
      collect: (m, rec, sideOf, order, squads) => {
        let pm = perMatch.get(m.id);
        if (!pm) {
          pm = { date: m.date, n: 0, pos: Array.from({ length: 11 }, () => [0, 0, 0, 0]), rat: Array.from({ length: 11 }, () => [0, 0]), state: Array.from({ length: 10 }, () => [0, 0, 0]), state2: Array.from({ length: 10 }, () => [0, 0, 0]), phase: Array.from({ length: 6 }, () => [0, 0, 0]), over1: Array.from({ length: 20 }, () => [0, 0, 0]), last: [0, 0, 0], first: [0, 0], firstW: 0, allOut: 0, standIn: Array(11).fill(0) };
          perMatch.set(m.id, pm);
          // a place of the real XI the pool does not have: its batters move up and a stand-in bats last
          for (const side of [0, 1] as const) {
            const have = new Set(order[side]);
            const real = side === 0 ? m.xi.a : m.xi.b;
            real.forEach((id, i) => { if (i < 11 && (id === null || !have.has(id))) pm!.standIn[i]++; });
          }
        }
        pm.n++;
        const byName = new Map(squads.flat().map(p => [p.name, p]));
        rec.innings.slice(0, 2).forEach((inn, q) => {
          const w = inn.totalWickets;
          const bats = inn.batters.map(b => [b.runs, b.balls, byName.get(b.playerName), b.howOut !== "not out" && !/retired hurt/i.test(b.howOut) ? 1 : 0]) as [number, number, Player | undefined, number][];
          if (w < 10 && bats.length === w + 1) bats.push([0, 0, undefined, 0]); // the not-out partner who faced no ball (the scorecard leaves him off)
          bats.forEach(([r, b, p, o], i) => { if (i < 11) { pm!.pos[i][0] += r; pm!.pos[i][1] += b; pm!.pos[i][2]++; pm!.pos[i][3] += o; if (p) { pm!.rat[i][0] += (p.battingOvr + p.ratings.timing) / 200; pm!.rat[i][1]++; } } });
          let pr = 0, pb = 0;
          inn.fallOfWickets.forEach((s, k) => {
            const r = Number(s.split("/")[0]), b = ballsOf(s);
            if (k < 10) for (const st of q === 0 ? [pm!.state, pm!.state2] : [pm!.state]) { st[k][0] += b - pb; st[k][1] += r - pr; st[k][2]++; }
            pr = r; pb = b;
          });
          const [ov, bl] = inn.totalOvers.split(".").map(Number);
          const tb = ov * 6 + (bl || 0);
          if (w < 10) for (const st of q === 0 ? [pm!.state, pm!.state2] : [pm!.state]) { st[w][0] += tb - pb; st[w][1] += inn.totalRuns - pr; }
          // by innings and phase (overs 1-6, 7-15, 16-20): legal balls, runs (the worm), wickets
          const ph = (b: number) => (b <= 36 ? 0 : b <= 90 ? 1 : 2);
          const wm = rec.worm[q] ?? [];
          const at = (o: number) => (o <= 0 ? 0 : wm[Math.min(o, wm.length) - 1] ?? 0);
          for (let k = 0; k < 3; k++) {
            const [b0, b1] = [[0, 36], [36, 90], [90, 120]][k];
            const e = pm!.phase[3 * q + k];
            e[0] += Math.max(0, Math.min(tb, b1) - b0);
            e[1] += (k === 2 ? inn.totalRuns : at(b1 / 6)) - at(b0 / 6);
          }
          inn.fallOfWickets.forEach(s => { pm!.phase[3 * q + ph(ballsOf(s))][2]++; });
          // first innings by over: legal balls, wickets, runs
          if (q === 0) {
            for (let o = 0; o < 20; o++) { pm!.over1[o][0] += Math.max(0, Math.min(tb, 6 * o + 6) - 6 * o); pm!.over1[o][2] += (o === 19 ? inn.totalRuns : at(o + 1)) - at(o); }
            inn.fallOfWickets.forEach(s => { const b = ballsOf(s); pm!.over1[Math.max(0, Math.min(19, Math.floor((b - 1) / 6)))][1]++; });
          }
          if (w >= 9) {
            const nine = inn.fallOfWickets[8];
            const r9 = Number(nine.split("/")[0]), b9 = ballsOf(nine);
            const end = w === 10 ? inn.fallOfWickets[9] : null;
            pm!.last[0] += (end ? ballsOf(end) : tb) - b9; pm!.last[1] += (end ? Number(end.split("/")[0]) : inn.totalRuns) - r9; pm!.last[2]++;
          }
          if (q === 0) { pm!.first[0] += inn.totalRuns; pm!.first[1] += inn.totalRuns ** 2; pm!.firstW += w; if (w === 10) pm!.allOut++; }
          void sideOf;
        });
      },
    });
    out[key] = Object.fromEntries(perMatch);
    console.log(`${key}: ${perMatch.size} matches x ${replays}`);
  }
  writeFileSync(process.env.BENCH_TAILS!, JSON.stringify(out));
}, 14_400_000);
