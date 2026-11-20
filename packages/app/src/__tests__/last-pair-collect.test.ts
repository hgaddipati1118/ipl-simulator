import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { EXTRA_LEAGUES, LAST_PAIR_SWITCH, simulateMatch, odiRules, RULE_PRESETS, type BallEvent, type Player, type RuleSet } from "@ipl-sim/engine";
import { createGameState } from "../game-state";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import { createSeries, matchContext, seriesSquads, type SeriesGender } from "../international";
import { createPoolLoader } from "../extended-pool";
import { playTestInstantly } from "../test-match/test-entry";
import { testFixture } from "../test-match/test-series";

/**
 * Last-pair state, simulated (skipped unless LP_COLLECT=1): the actual-XI matches (real batting orders, docs/data/actual_xi.json)
 * of the international sets played LP_REPLAYS times (default 4) by the engine, every delivery from LP_MIN_WK wickets down (default
 * 6) written as a csv row in the shape of the real table packages/ratings/src/analysis/last-pair.py builds from Cricsheet (wickets
 * down before the ball, the striker's and the non-striker's batting position by arrival and rating, balls faced by the striker,
 * legal balls bowled before this one in the over, outcome class). The same sql then reads both. docs/TACTICS.md section 5.
 *   LP_COLLECT=1 LP_OUT=/path/dir [LP_ONLY=t20i-men,odi-men,...] [LP_REPLAYS=4] [LP_FROM=2024-01-01] npx vitest run packages/app/src/__tests__/last-pair-collect.test.ts
 */
/** LP_OFF=t20,odi,test: play without the last-pair term in those formats (the engine as it was) */
for (const f of (process.env.LP_OFF ?? "").split(",").filter(Boolean)) LAST_PAIR_SWITCH.off[f as "t20" | "odi" | "test"] = true;
/** LP_WICKET=t20:-0.1: add a log offset to the wicket class of the term in those formats (calibrating the all-out shares) */
for (const kv of (process.env.LP_WICKET ?? "").split(",").filter(Boolean)) { const [f, v] = kv.split(":"); LAST_PAIR_SWITCH.wicket[f as "t20" | "odi" | "test"] = Number(v); }
/** LP_SCALE=t20:2,odi:1.5: scale the whole term in those formats */
for (const kv of (process.env.LP_SCALE ?? "").split(",").filter(Boolean)) { const [f, v] = kv.split(":"); LAST_PAIR_SWITCH.scale[f as "t20" | "odi" | "test"] = Number(v); }
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

interface ActualMatch { id: string; date: string; a: string; b: string; host: "a" | "b" | null; venue: string; winner: "a" | "b"; xi: { a: (string | null)[]; b: (string | null)[] } }

type Row = { ev: { over: number; batter: string; nonStriker: string; wides: number; noBalls: number; runs: number; extras: number; wicket: boolean; out: string | undefined; outcome: string; dead: boolean } };

function classOf(e: Row["ev"]): string {
  if (e.wides > 0 || e.outcome === "wide") return "wide";
  if (e.noBalls > 0 || e.outcome === "noball") return "noball";
  if (e.wicket) return "wicket";
  if (e.outcome === "legbye") return "legbye";
  if (e.runs >= 6) return "6";
  if (e.runs >= 4) return "4";
  return e.runs === 0 ? "dot" : String(e.runs);
}

/** One innings' ball log as csv lines (from LP_MIN_WK down) */
function inningsLines(tag: string, match: number, inn: number, log: Row["ev"][], rating: (id: string) => number | undefined, minWk: number, summary?: string[]): string[] {
  const out: string[] = [];
  let totRuns = 0, totWk = 0, totBalls = 0;
  const arrival = new Map<string, number>();
  const seen = (id: string) => { if (!arrival.has(id)) arrival.set(id, arrival.size + 1); return arrival.get(id)!; };
  const faced = new Map<string, number>();
  let wk = 0;
  let curOver = -1, legalInOver = 0;
  for (const e of log) {
    seen(e.batter); seen(e.nonStriker);
    if (e.over !== curOver) { curOver = e.over; legalInOver = 0; }
    if (e.dead) { if (e.wicket) { wk++; totWk++; } continue; }
    totRuns += e.runs + e.extras;
    if (e.wicket) totWk++;
    if (e.wides === 0 && e.noBalls === 0) totBalls++;
    const cls = classOf(e);
    if (wk >= minWk) {
      const r1 = rating(e.batter), r2 = rating(e.nonStriker);
      out.push([tag, match, inn, e.over, legalInOver, faced.get(e.batter) ?? 0, wk, arrival.get(e.batter), arrival.get(e.nonStriker), r1 ?? "", r2 ?? "", cls, e.runs, e.wides > 0 ? 1 : 0, e.noBalls > 0 ? 1 : 0, e.wicket ? 1 : 0, e.runs + e.extras].join(","));
    }
    if (e.wides === 0) faced.set(e.batter, (faced.get(e.batter) ?? 0) + 1);
    if (e.wides === 0 && e.noBalls === 0) legalInOver++;
    if (e.wicket) wk++;
  }
  summary?.push([tag, match, inn, totRuns, totWk, totBalls].join(","));
  return out;
}

/** LP_LEAGUES=1 [LP_MATCHES=1500]: the T20 leagues (the game's squads, random pairings; tag = the league id; The Hundred left out) */
it.skipIf(!process.env.LP_LEAGUES)("last pair: simulated league deliveries", () => {
  const OUT = process.env.LP_OUT ?? "lp-sim";
  mkdirSync(OUT, { recursive: true });
  const N = Number(process.env.LP_MATCHES ?? 1500);
  const minWk = Number(process.env.LP_MIN_WK ?? 6);
  const only = process.env.LP_ONLY?.split(",");
  const leagues: Array<[string, RuleSet]> = [["ipl", RULE_PRESETS.modern2026 as RuleSet], ["wpl", RULE_PRESETS.wpl as RuleSet], ...EXTRA_LEAGUES.map(l => [l.id, l.rules] as [string, RuleSet])];
  for (const [id, r0] of leagues) {
    if (only && !only.includes(id)) continue;
    const rules = { ...r0, injuriesEnabled: false } as RuleSet;
    if (rules.matchFormat === "hundred") continue;
    const teams = createGameState(rules).teams;
    const lines: string[] = ["tag,match,innings,over,legal_before_in_over,sballs,wk,spos,npos,srat,nrat,cls,runs_batter,wides,noballs,is_wicket,runs_total"];
    const summary: string[] = ["tag,match,innings,runs,wickets,balls"];
    for (let i = 0; i < N; i++) {
      const home = teams[i % teams.length];
      let away = teams[(i * 7 + 3) % teams.length];
      if (away === home) away = teams[(i * 7 + 4) % teams.length];
      const r = simulateMatch(home, away, rules, 5000 + i, { countTowardStandings: false });
      const byId = new Map<string, Player>([...home.roster, ...away.roster].map(p => [p.id, p]));
      const rating = (pid: string) => { const p = byId.get(pid); return p ? (p.battingOvr + p.ratings.timing) / 200 : undefined; };
      r.innings.forEach((inn, q) => {
        const log = (inn.ballLog as BallEvent[]).map(e => ({ over: e.over, batter: e.batter, nonStriker: e.nonStriker ?? "", wides: e.wides ?? 0, noBalls: e.noBalls ?? 0, runs: e.runs, extras: e.extras ?? 0, wicket: e.isWicket, out: e.playerOutId, outcome: e.outcome, dead: !!e.deadBall }));
        lines.push(...inningsLines(id, i, q + 1, log, rating, minWk, summary));
      });
    }
    writeFileSync(join(OUT, `sim-${id}.csv`), lines.join("\n"));
    writeFileSync(join(OUT, `inn-${id}.csv`), summary.join("\n"));
    console.log(`${id}: ${N} matches, ${lines.length - 1} rows`);
  }
}, 14_400_000);

it.skipIf(!process.env.LP_COLLECT)("last pair: simulated deliveries", async () => {
  const OUT = process.env.LP_OUT ?? "lp-sim";
  mkdirSync(OUT, { recursive: true });
  const replays = Number(process.env.LP_REPLAYS ?? 4);
  const minWk = Number(process.env.LP_MIN_WK ?? 6);
  const only = process.env.LP_ONLY?.split(",");
  const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
  const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
  const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  const ACT = JSON.parse(readFileSync(join(REPO, "docs", "data", "actual_xi.json"), "utf-8")) as Record<string, ActualMatch[]>;
  for (const key of Object.keys(ACT)) {
    if (only && !only.includes(key)) continue;
    const [fmt, gender] = key.split("-") as [string, SeriesGender];
    const extended = await loader.players(gender, ["senior"]);
    const ms = ACT[key].filter(m => m.date >= (process.env.LP_FROM ?? "0"));
    const lines: string[] = ["tag,match,innings,over,legal_before_in_over,sballs,wk,spos,npos,srat,nrat,cls,runs_batter,wides,noballs,is_wicket,runs_total"];
    const summary: string[] = ["tag,match,innings,runs,wickets,balls"];
    let matchNo = 0;
    ms.forEach((m, i) => {
      const series = createSeries({ format: fmt as "t20i", gender, nations: [m.a, m.b], length: 1, host: m.host === "a" ? "a" : m.host === "b" ? "b" : "neutral", userSide: null, seed: 3000 + i }, FILE, ACTIVITY, extended);
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
      const byId = new Map<string, Player>(squads.flat().map(p => [p.id, p]));
      const rating = (id: string) => { const p = byId.get(id); return p ? (p.battingOvr + p.ratings.timing) / 200 : undefined; };
      for (let j = 0; j < replays; j++) {
        const ctx = { ...matchContext(series, 0, squads), seed: 7919 * i + 104729 * (j + 1), key: undefined };
        matchNo++;
        if (fmt === "test") {
          const { state } = playTestInstantly(testFixture(ctx as Parameters<typeof testFixture>[0]));
          state.innings.forEach((inn, q) => {
            const log = inn.ballLog.map(e => ({ over: e.over, batter: e.batter, nonStriker: e.nonStriker, wides: e.wides ?? 0, noBalls: e.noBalls ?? 0, runs: e.runs, extras: e.extras ?? 0, wicket: e.isWicket, out: e.playerOutId, outcome: e.outcome, dead: false }));
            lines.push(...inningsLines(key, matchNo, q + 1, log, rating, minWk, summary));
          });
        } else {
          const rules = (ctx.rules ?? (fmt === "odi" ? odiRules(gender) : (RULE_PRESETS.modern2026 as RuleSet))) as RuleSet;
          const res = simulateMatch(ctx.home, ctx.away, rules, ctx.seed, { countTowardStandings: false, rain: true, ...(ctx.venue.neutral ? { neutralVenue: true } : { venueName: ctx.venue.name }) });
          res.innings.forEach((inn, q) => {
            const log = (inn.ballLog as BallEvent[]).map(e => ({ over: e.over, batter: e.batter, nonStriker: e.nonStriker ?? "", wides: e.wides ?? 0, noBalls: e.noBalls ?? 0, runs: e.runs, extras: e.extras ?? 0, wicket: e.isWicket, out: e.playerOutId, outcome: e.outcome, dead: !!e.deadBall }));
            lines.push(...inningsLines(key, matchNo, q + 1, log, rating, minWk, summary));
          });
        }
      }
    });
    writeFileSync(join(OUT, `sim-${key}.csv`), lines.join("\n"));
    writeFileSync(join(OUT, `inn-${key}.csv`), summary.join("\n"));
    console.log(`${key}: ${matchNo} matches, ${lines.length - 1} rows`);
  }
}, 14_400_000);
