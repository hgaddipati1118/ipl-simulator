/**
 * The XIs that really played in the men's T20 leagues (docs/TACTICS.md section 7, "League XIs"): for every match of the nine men's
 * leagues with engine levels (IPL, BBL, PSL, SA20, CPL, ILT20, MLC, BPL, LPL) since 2021, the eleven each side fielded in the order of
 * its batting card and the overs each of them bowled. Used to compare the CPU's XI selection (Team.autoSelectPlayingXI) with real
 * selection on the same squads (the union of a franchise's XIs over a season) and to fit it (packages/app/src/__tests__/league-xi.test.ts).
 *
 *   npx tsx src/pipeline/generate-league-xi.ts            (reads data/cricsheet/<league>_json/*.json)   -> docs/data/league_xi.json
 *
 * Players are keyed like the rest of the app (`espn_<id>` in the game pool, else `ca_<id>` in the CricketArchive pool, senior and tier0
 * shards) through Cricsheet's people registry, as generate-actual-xi.ts does; a player neither pool has is null. Order of the card:
 * first appearance at the crease in the side's innings, then the players who did not bat in the order Cricsheet lists them. A side of twelve
 * (the impact player: IPL since 2023, ILT20 since 2023/24, LPL 2026) has `off`, the index of the one who was not in the side while it batted.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { ALL_PLAYERS } from "../all-players.js";
import { decodeShard, type PoolShard } from "../extended-pool.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const CS = `${ROOT}data/cricsheet/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const OUT = new URL("../../../../docs/data/league_xi.json", import.meta.url).pathname;

const LEAGUES: [string, string, string][] = [
  ["ipl", "Indian Premier League", "ipl_json"], ["bbl", "Big Bash League", "bbl_json"], ["psl", "Pakistan Super League", "psl_json"],
  ["sa20", "SA20", "sat_json"], ["cpl", "Caribbean Premier League", "cpl_json"], ["ilt20", "International League T20", "ilt_json"],
  ["mlc", "Major League Cricket", "mlc_json"], ["bpl", "Bangladesh Premier League", "bpl_json"], ["lpl", "Lanka Premier League", "lpl_json"],
];

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", "SET memory_limit='2GB'; " + sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

interface CsMatch {
  info: { players: Record<string, string[]>; registry: { people: Record<string, string> }; teams: string[] };
  innings?: { team: string; overs?: { over: number; deliveries: { batter: string; bowler: string; non_striker: string; replacements?: { match?: { in: string; out: string; team: string; reason: string }[] } }[] }[]; super_over?: boolean }[];
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

  const out: Record<string, unknown[]> = {};
  for (const [lg, event, folder] of LEAGUES) {
    const rows = duck<{ match_id: string; date: string; season: string }>(`SELECT match_id, strftime(date, '%Y-%m-%d') date, season FROM 'matches.parquet'
      WHERE event = '${event.replace(/'/g, "''")}' AND gender = 'male' AND date >= DATE '2021-01-01' ORDER BY date, match_id`);
    const list: unknown[] = [];
    let missing = 0, places = 0, nulls = 0;
    for (const r of rows) {
      const file = `${CS}${folder}/${r.match_id}.json`;
      if (!existsSync(file)) { missing++; continue; }
      const cs = JSON.parse(readFileSync(file, "utf-8")) as CsMatch;
      const reg = cs.info.registry.people;
      // Impact-player (and similar) substitutions: [innings index, team, in, out]
      const subs: [number, string, string, string][] = [];
      (cs.innings ?? []).forEach((inn, k) => { for (const o of inn.overs ?? []) for (const d of o.deliveries) for (const m of d.replacements?.match ?? []) if (m.reason !== "concussion_substitute") subs.push([k, m.team, m.in, m.out]); });
      const sides = cs.info.teams.map(team => {
        const names = cs.info.players[team] ?? [];
        const bats: string[] = [];
        const inn = (cs.innings ?? []).find(i => i.team === team && !i.super_over);
        for (const o of inn?.overs ?? []) for (const d of o.deliveries) for (const n of [d.batter, d.non_striker]) if (!bats.includes(n)) bats.push(n);
        const ordered = [...bats.filter(n => names.includes(n)), ...names.filter(n => !bats.includes(n))];
        // overs each of them bowled in the opposition's innings (an over is the first delivery's bowler's)
        const opp = (cs.innings ?? []).find(i => i.team !== team && !i.super_over);
        const ov = ordered.map(n => (opp?.overs ?? []).filter(o => o.deliveries[0]?.bowler === n).length);
        const xi = ordered.map(n => poolOf(reg[n]));
        // with a twelfth player (impact player): the one of the pair who was not in the side while it batted. The one who batted is in; if
        // neither batted, the man coming in after the side's innings (or the man going out before it) is the one left out.
        let off = -1;
        const k = (cs.innings ?? []).findIndex(i => i.team === team && !i.super_over);
        const sub = subs.find(x => x[1] === team);
        if (ordered.length > 11 && sub) {
          const [at, , sin, sout] = sub;
          const leftOut = bats.includes(sin) ? sout : bats.includes(sout) ? sin : at > k ? sin : sout;
          off = ordered.indexOf(leftOut);
        }
        places += xi.length; nulls += xi.filter(x => x === null).length;
        return { team, xi, ov, off, batted: inn ? bats.length : 0 };
      });
      list.push({ id: r.match_id, date: r.date, season: r.season, sides });
    }
    out[lg] = list;
    console.log(`${lg}: ${list.length} matches (${missing} without a json file), ${nulls}/${places} places not in the pool`);
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote " + OUT);
}
main();
