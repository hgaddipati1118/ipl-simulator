/**
 * The Impact Player in the real IPL (docs/TACTICS.md section 9): every IPL match since 2023 (the Impact Player era) from the Cricsheet
 * json, each side's twelve (or eleven, with no sub) in the order of its batting card, what each did (batting position, balls faced,
 * overs bowled) and the substitution itself: the innings and the ball at which Cricsheet records it (`replacements.match`, reason
 * `impact_player`; a concussion substitute is left out), the score then, who came in and who went out. Also the toss, the venue
 * and the result, so the same file drives the IPL actual-XI match benchmark (packages/app/src/__tests__/impact-player.test.ts).
 *
 *   npx tsx src/pipeline/generate-impact-player.ts           (reads data/cricsheet/ipl_json/*.json)   -> docs/data/impact_player.json
 *
 * Players are keyed as in generate-league-xi.ts (`espn_<id>` in the game pool, else `ca_<id>`; null when neither pool has him).
 * Cricsheet does not record the five named substitutes, only the one who came on.
 */
import { execFileSync } from "child_process";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { ALL_PLAYERS } from "../all-players.js";
import { decodeShard, type PoolShard } from "../extended-pool.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const CS = `${ROOT}data/cricsheet/ipl_json/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const OUT = new URL("../../../../docs/data/impact_player.json", import.meta.url).pathname;

interface Delivery {
  batter: string; bowler: string; non_striker: string;
  runs: { total: number };
  extras?: Record<string, number>;
  wickets?: { player_out: string; kind: string }[];
  replacements?: { match?: { in: string; out: string; team: string; reason: string }[] };
}
interface CsMatch {
  info: {
    dates: string[]; season: string | number; venue: string; city?: string; teams: string[];
    players: Record<string, string[]>; registry: { people: Record<string, string> };
    toss: { winner: string; decision: string };
    outcome: { winner?: string; result?: string; method?: string; eliminator?: string; by?: Record<string, number> };
    overs?: number;
  };
  innings?: { team: string; overs?: { over: number; deliveries: Delivery[] }[]; super_over?: boolean; target?: { overs?: number; runs?: number } }[];
}

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", "SET memory_limit='2GB'; " + sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

function main() {
  const ids = new Set<string>();
  const manifest = JSON.parse(readFileSync(`${POOL_DIR}manifest.json`, "utf-8")) as { shards: { file: string; gender: string; tier: string }[] };
  for (const s of manifest.shards.filter(s => s.gender === "men" && (s.tier === "senior" || s.tier === "tier0"))) {
    const shard = JSON.parse(gunzipSync(readFileSync(POOL_DIR + s.file)).toString()) as PoolShard;
    for (const p of decodeShard(shard)) ids.add(p.id);
  }
  for (const p of ALL_PLAYERS as unknown as { id: string; sourceId?: string }[]) ids.add(p.sourceId ?? p.id);
  const people = duck<{ pid: string; ci: string | null; ca: string | null }>(`SELECT identifier pid, key_cricinfo ci, key_cricketarchive ca FROM read_csv('../cricsheet/people.csv', header=true, all_varchar=true)`);
  const peopleBy = new Map(people.map(p => [p.pid, p]));
  const poolOf = (pid: string): string | null => {
    const p = peopleBy.get(pid);
    if (!p) return null;
    return [p.ci ? `espn_${p.ci}` : "", p.ca ? `ca_${p.ca}` : "", p.ci ? `ca_${9e9 + Number(p.ci)}` : ""].find(i => i && ids.has(i)) ?? null;
  };
  const legal = (d: Delivery) => !(d.extras && (d.extras.wides !== undefined || d.extras.noballs !== undefined));

  const out: unknown[] = [];
  let nulls = 0, places = 0;
  for (const f of readdirSync(CS).filter(f => f.endsWith(".json")).sort()) {
    const cs = JSON.parse(readFileSync(CS + f, "utf-8")) as CsMatch;
    const date = cs.info.dates[0];
    if (date < "2023-01-01") continue;
    const reg = cs.info.registry.people;
    const inns = (cs.innings ?? []).filter(i => !i.super_over);
    // the substitutions: where Cricsheet puts them (the delivery they come before) and the score then
    const subs: { team: string; inn: number; over: number; ball: number; wkts: number; runs: number; in: string; out: string }[] = [];
    inns.forEach((inn, k) => {
      let wkts = 0, runs = 0;
      for (const o of inn.overs ?? []) {
        let ball = 0;
        for (const d of o.deliveries) {
          for (const m of d.replacements?.match ?? []) if (m.reason === "impact_player") subs.push({ team: m.team, inn: k, over: o.over, ball, wkts, runs, in: m.in, out: m.out });
          if (legal(d)) ball++;
          runs += d.runs.total;
          wkts += d.wickets?.length ?? 0;
        }
      }
    });
    const sides = cs.info.teams.map(team => {
      const names = cs.info.players[team] ?? [];
      const k = inns.findIndex(i => i.team === team);
      const bats: string[] = [];
      const balls = new Map<string, number>();
      for (const o of inns[k]?.overs ?? []) for (const d of o.deliveries) {
        for (const n of [d.batter, d.non_striker]) if (!bats.includes(n)) bats.push(n);
        if (legal(d)) balls.set(d.batter, (balls.get(d.batter) ?? 0) + 1);
      }
      const ordered = [...bats.filter(n => names.includes(n)), ...names.filter(n => !bats.includes(n))];
      const opp = inns.find(i => i.team !== team);
      const ov = ordered.map(n => (opp?.overs ?? []).filter(o => o.deliveries[0]?.bowler === n).length);
      const sub = subs.find(s => s.team === team);
      places += ordered.length; nulls += ordered.filter(n => poolOf(reg[n]) === null).length;
      return {
        team, inn: k,
        xi: ordered.map(n => poolOf(reg[n])),
        names: ordered,
        bat: ordered.map(n => bats.indexOf(n)),
        balls: ordered.map(n => balls.get(n) ?? 0),
        ov,
        sub: sub ? { inn: sub.inn, over: sub.over, ball: sub.ball, wkts: sub.wkts, runs: sub.runs, in: ordered.indexOf(sub.in), out: ordered.indexOf(sub.out), batting: inns[sub.inn]?.team === team } : null,
      };
    });
    const o = cs.info.outcome;
    out.push({
      id: f.replace(".json", ""), date, season: String(cs.info.season), venue: cs.info.venue, city: cs.info.city ?? null,
      toss: { winner: cs.info.toss.winner, decision: cs.info.toss.decision },
      batFirst: inns[0]?.team ?? null,
      winner: o.winner ?? o.eliminator ?? null, result: o.result ?? null, method: o.method ?? null,
      // each innings' wickets as they fell: [over, legal balls bowled in it, wickets down after]
      fow: inns.map(i => { const w: [number, number, number][] = []; let n = 0; for (const o of i.overs ?? []) { let b = 0; for (const d of o.deliveries) { if (legal(d)) b++; if (d.wickets?.length) { n += d.wickets.length; w.push([o.over, b, n]); } } } return w; }),
      overs: inns.map(i => (i.overs ?? []).length), runs: inns.map(i => (i.overs ?? []).reduce((t, ov) => t + ov.deliveries.reduce((s, d) => s + d.runs.total, 0), 0)),
      sides,
    });
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`${out.length} matches, ${nulls}/${places} places not in the pool; wrote ${OUT}`);
}
main();
