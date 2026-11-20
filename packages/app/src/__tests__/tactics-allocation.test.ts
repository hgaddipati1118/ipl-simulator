import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { ATTACK_MODEL, isFastBowler, isPaceBowler, isSpinBowler, simulateMatch, type Player } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesFormat, seriesSquads, type SeriesGender } from "../international";
import { createPoolLoader } from "../extended-pool";

/**
 * Bowling-allocation benchmark (skipped unless BENCH_TACTICS=1): who bowls which overs in the sim against the real record.
 * Every match of docs/data/actual_xi.json is played with the XIs that really played (the path a user's XI takes); the real overs
 * come from the file's `bowl` lists (the bowler of each over, per bowling side), the simulated ones from the ball log. Both are scored
 * on the same figures, with the sim's own ratings for rank and type:
 *   - usage: mean overs of the k-th most used bowler of an innings
 *   - rank: mean overs by the XI's bowlers ranked on bowling rating (1 = best)
 *   - phase x type: share of a phase's overs bowled by fast / medium pace / spin / slow (part-time) bowlers
 *   - first and last over: share bowled by the XI's 1st, 2nd, 3rd best bowler
 *   BENCH_TACTICS=1 [BENCH_REPLAYS=3] [BENCH_ONLY=t20i-men,odi-men] [BENCH_JSON=path]  npx vitest run packages/app/src/__tests__/tactics-allocation.test.ts
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

interface ActualMatch {
  id: string; date: string; a: string; b: string; host: "a" | "b" | null; venue: string; winner: "a" | "b";
  xi: { a: (string | null)[]; b: (string | null)[] };
  bowl: { a: string[]; b: string[] };
}

let total20 = 20;
const TYPES = ["fast", "medium", "spin", "slow"] as const;
const typeOf = (p: Player): (typeof TYPES)[number] => {
  const s = p.bowlingStyle;
  if (isSpinBowler(s)) return "spin";
  if (isFastBowler(s)) return "fast";
  if (isPaceBowler(s)) return "medium";
  return "slow";
};

/** One bowling side's innings: the bowler of each over, the XI's bowlers by rating */
interface Inn { overs: string[]; rank: Map<string, number>; type: Map<string, (typeof TYPES)[number]> }

class Stats {
  n = 0;
  usage: number[] = Array(8).fill(0);
  byRank: number[] = Array(8).fill(0);
  phase: Record<string, Record<string, number>> = { pp: {}, mid: {}, death: {} };
  first: number[] = Array(4).fill(0);
  last: number[] = Array(4).fill(0);
  /** overs 1..k: share of overs by spin */
  spinByOver: number[] = Array(50).fill(0);
  overN: number[] = Array(50).fill(0);
  extraByOver: number[] = Array(50).fill(0);
  add(inn: Inn, total: number) {
    if (inn.overs.length < Math.min(total, 15)) return;
    this.n++;
    const cnt = new Map<string, number>();
    for (const id of inn.overs) cnt.set(id, (cnt.get(id) ?? 0) + 1);
    [...cnt.values()].sort((a, b) => b - a).slice(0, 8).forEach((c, i) => { this.usage[i] += c; });
    for (const [id, c] of cnt) { const r = inn.rank.get(id); if (r !== undefined && r < 8) this.byRank[r] += c; }
    const ppEnd = total <= 20 ? 6 : 10, deathFrom = total <= 20 ? 15 : 40;
    inn.overs.forEach((id, o) => {
      const t = inn.type.get(id) ?? "slow";
      const ph = o < ppEnd ? "pp" : o < deathFrom ? "mid" : "death";
      this.phase[ph][t] = (this.phase[ph][t] ?? 0) + 1;
      this.overN[o]++; if (t === "spin") this.spinByOver[o]++;
      if ((inn.rank.get(id) ?? 9) >= 5) this.extraByOver[o]++;
    });
    const r0 = inn.rank.get(inn.overs[0]), rl = inn.rank.get(inn.overs[inn.overs.length - 1]);
    if (r0 !== undefined) this.first[Math.min(3, r0)]++;
    if (rl !== undefined) this.last[Math.min(3, rl)]++;
  }
  summary() {
    const f = (x: number) => Math.round(x * 1000) / 1000;
    const phase: Record<string, Record<string, number>> = {};
    for (const ph of Object.keys(this.phase)) {
      const tot = TYPES.reduce((s, t) => s + (this.phase[ph][t] ?? 0), 0) || 1;
      phase[ph] = Object.fromEntries(TYPES.map(t => [t, f((this.phase[ph][t] ?? 0) / tot)]));
    }
    return {
      n: this.n,
      usage: this.usage.map(x => f(x / this.n)),
      byRank: this.byRank.map(x => f(x / this.n)),
      phase,
      first: this.first.map(x => f(x / this.n)),
      last: this.last.map(x => f(x / this.n)),
      spinByOver: this.spinByOver.map((x, i) => f(x / Math.max(1, this.overN[i]))).slice(0, total20),
      extraByOver: this.extraByOver.map((x, i) => f(x / Math.max(1, this.overN[i]))).slice(0, total20),
    };
  }
}

it.skipIf(!process.env.BENCH_TACTICS)("bowling allocation against real", async () => {
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const loader = createPoolLoader(async file => new Uint8Array(readFileSync(join(PUBLIC, "pool", file))));
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>;
  const replays = Number(process.env.BENCH_REPLAYS ?? 3);
  // BENCH_ATTACK=t20i: the men's T20I with the attack table (docs/TACTICS.md section 8)
  if (process.env.BENCH_ATTACK === "t20i") ATTACK_MODEL.t20i = true;
  const only = process.env.BENCH_ONLY?.split(",");
  const out: Record<string, unknown> = {};
  const train: unknown[] = [];
  for (const key of Object.keys(ACT)) {
    if (only && !only.includes(key)) continue;
    if (key.startsWith("test")) continue;
    const [fmt, gender] = key.split("-") as [string, SeriesGender];
    const players = await loader.players(gender, ["senior"]);
    const def = seriesFormat(fmt);
    const total = fmt === "odi" ? 50 : 20;
    total20 = total;
    const real = new Stats(), sim = new Stats();
    const limit = Number(process.env.BENCH_LIMIT ?? 100000);
    const ms = ACT[key].filter(m => (process.env.BENCH_FROM ? m.date >= process.env.BENCH_FROM : true)).slice(0, limit);
    ms.forEach((m, i) => {
      const series = createSeries({ format: fmt, gender, nations: [m.a, m.b], length: 1, host: m.host === "a" ? "a" : m.host === "b" ? "b" : "neutral", userSide: null, seed: 3000 + i }, FILE, ACTIVITY, players);
      series.ground = m.venue;
      const fallback = seriesSquads(series, FILE, players);
      for (const side of [0, 1] as const) {
        const real11 = (side === 0 ? m.xi.a : m.xi.b).filter((x): x is string => x !== null);
        let ids = [...new Set(real11)];
        for (let pass = 0; pass < 2; pass++) {
          series.sides[side].squad = ids;
          const have = new Set(seriesSquads(series, FILE, players)[side].map(p => p.id));
          ids = ids.filter(id => have.has(id));
          for (const p of fallback[side]) if (ids.length < 11 && !ids.includes(p.id)) ids.push(p.id);
        }
        series.sides[side].squad = ids;
        (series.lineups ??= [null, null])[side] = { xi: ids.slice(0, 11), order: ids.slice(0, 11) };
      }
      const squads = seriesSquads(series, FILE, players);
      const innOf = (side: 0 | 1, overs: string[]): Inn => {
        const xi = squads[side].filter(p => series.lineups![side]!.xi.includes(p.id));
        const ranked = xi.filter(p => !p.isWicketKeeper || p.role === "all-rounder").sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr);
        return { overs, rank: new Map(ranked.map((p, r) => [p.id, r])), type: new Map(xi.map(p => [p.id, typeOf(p)])) };
      };
      real.add(innOf(0, m.bowl.a), total); real.add(innOf(1, m.bowl.b), total);
      if (process.env.BENCH_EXPORT) {
        // the training rows of the bowling-choice fit (packages/ratings/src/analysis/bowling-choice.py): XI with the ratings the engine plays on
        for (const side of [0, 1] as const) {
          const xi = squads[side].filter(p => series.lineups![side]!.xi.includes(p.id));
          train.push({ key, id: m.id, date: m.date, host: m.host, side, overs: side === 0 ? m.bowl.a : m.bowl.b,
            xi: xi.map(p => ({ id: p.id, ovr: p.effectiveBowlingOvr, wt: p.ratings.wicketTaking, acc: p.ratings.accuracy, style: p.bowlingStyle, kp: !!p.isWicketKeeper, role: p.role, bat: p.battingOvr })) });
        }
      }
      for (let j = 0; j < replays; j++) {
        const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + 1), key: undefined };
        const res = simulateMatch(ctx.home, ctx.away, ctx.rules ?? def.rules!(gender), ctx.seed, { countTowardStandings: false, rain: false, ...(ctx.venue.neutral ? { neutralVenue: true } : { venueName: ctx.venue.name }) });
        const d = res.detailed!;
        for (const k of [1, 2] as const) {
          const inn = k === 1 ? d.innings1 : d.innings2;
          const side: 0 | 1 = inn.bowlingTeamId === series.sides[0].id ? 0 : 1;
          const idByName = new Map(squads[side].map(p => [p.name, p.id]));
          const overs: string[] = [];
          for (const b of d.ballLog) if (b.innings === k) overs[b.over] = idByName.get(b.bowlerName) ?? b.bowlerName;
          sim.add(innOf(side, overs.filter(Boolean)), total);
        }
      }
    });
    const r = real.summary(), s = sim.summary();
    out[key] = { real: r, sim: s };
    console.log(`\n=== ${key} (${ms.length} matches, ${replays} replays)`);
    console.log("usage  real", r.usage.join(" "), "\n       sim ", s.usage.join(" "));
    console.log("rank   real", r.byRank.join(" "), "\n       sim ", s.byRank.join(" "));
    for (const ph of ["pp", "mid", "death"]) console.log(ph.padEnd(6), "real", JSON.stringify(r.phase[ph]), "\n       sim ", JSON.stringify(s.phase[ph]));
    console.log("spin/over real", r.spinByOver.map(x => Math.round(x * 100)).join(" "), "\n       sim ", s.spinByOver.map(x => Math.round(x * 100)).join(" "));
    console.log("extra/over real", r.extraByOver.map(x => Math.round(x * 100)).join(" "), "\n       sim ", s.extraByOver.map(x => Math.round(x * 100)).join(" "));
    console.log("first  real", r.first.join(" "), " sim", s.first.join(" "));
    console.log("last   real", r.last.join(" "), " sim", s.last.join(" "));
  }
  if (process.env.BENCH_EXPORT) writeFileSync(process.env.BENCH_EXPORT, JSON.stringify(train));
  if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify(out, null, 1));
}, 14_400_000);
