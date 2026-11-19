/**
 * The XIs that really played (docs/COUNTRY-VALIDATION.md, "Actual XI"): for every real international match of the per-country benchmark
 * (full members, a result, no DLS; same windows as packages/ratings/src/analysis/country-validation.py) the eleven each side fielded,
 * the batting order it used, the host (the venue's country is one of the two sides') and the bowlers' overs.
 *
 *   npx tsx src/pipeline/generate-actual-xi.ts <dir with the unzipped Cricsheet json: t20s/ odis/ tests/>   -> docs/data/actual_xi.json
 *
 * The Cricsheet ball-by-ball json (cricsheet.org/downloads/{t20s,odis,tests}_json.zip) lists each side's players (info.players), which
 * the parquet extracts do not keep. Players are keyed like the rest of the app (`sourceId ?? id`: `espn_<id>`, `ca_<id>`) through
 * Cricsheet's people registry, exactly as generate-intl-availability.ts does; a player the pool does not have (or one of another
 * nation's pool) is null and the benchmark fills the place. Order of the batting card: first appearance at the crease in the side's
 * first innings, then the players who did not bat in the order Cricsheet lists them.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import { decodeShard, type PoolShard } from "../extended-pool.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const OUT = new URL("../../../../docs/data/actual_xi.json", import.meta.url).pathname;
const JSON_DIR = process.argv[2];
if (!JSON_DIR) throw new Error("usage: generate-actual-xi.ts <dir with t20s/ odis/ tests/ of Cricsheet json>");

const FULL = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan", "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"];
const CODE: Record<string, string> = { India: "IND", England: "ENG", Australia: "AUS", "South Africa": "RSA", "New Zealand": "NZ", Pakistan: "PAK", "Sri Lanka": "SL", "West Indies": "WI", Bangladesh: "BDESH", Zimbabwe: "ZIM", Ireland: "IRELAND", Afghanistan: "AFG" };
type Gender = "male" | "female";
const SETS: [string, "men" | "women", Gender, string[], string, string][] = [
  ["t20i", "men", "male", ["T20", "IT20"], "2019-01-01", "t20s"], ["t20i", "women", "female", ["T20", "IT20"], "2019-01-01", "t20s"],
  ["odi", "men", "male", ["ODI", "ODM"], "2019-01-01", "odis"], ["odi", "women", "female", ["ODI", "ODM"], "2019-01-01", "odis"],
  ["test", "men", "male", ["Test"], "2023-01-01", "tests"],
];

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", "SET memory_limit='2GB'; " + sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 2 * 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

interface Pooled { id: string; name: string; country: string; gender: Gender }
interface CsMatch {
  info: { players: Record<string, string[]>; registry: { people: Record<string, string> } };
  innings?: { team: string; overs?: { over: number; deliveries: { batter: string; bowler: string; non_striker: string; runs: { batter: number }; extras?: { wides?: number } }[] }[]; super_over?: boolean }[];
}

function main() {
  const pooled: Pooled[] = [];
  for (const g of ["men", "women"] as const) {
    const shard = JSON.parse(gunzipSync(readFileSync(`${POOL_DIR}ca-${g}-senior.json.gz`)).toString()) as PoolShard;
    for (const p of decodeShard(shard)) pooled.push({ id: p.id, name: p.name, country: p.country, gender: g === "men" ? "male" : "female" });
  }
  for (const [list, g] of [[ALL_PLAYERS, "male"], [WPL_PLAYERS, "female"]] as const) {
    for (const p of list as unknown as { id: string; sourceId?: string; name: string; country: string }[]) pooled.push({ id: p.sourceId ?? p.id, name: p.name, country: p.country, gender: g });
  }
  const byId = new Map(pooled.map(p => [p.id, p]));
  const nameKey = (name: string, country: string, g: Gender) => { const w = name.toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").split(" ").filter(Boolean); return `${country}|${g}|${w[w.length - 1]}|${w[0]?.[0]}`; };
  const byName = new Map(pooled.map(p => [nameKey(p.name, p.country, p.gender), p]));
  const people = duck<{ pid: string; name: string; ci: string | null; ca: string | null }>(`SELECT identifier pid, name, key_cricinfo ci, key_cricketarchive ca FROM read_csv('../cricsheet/people.csv', header=true, all_varchar=true)`);
  const peopleBy = new Map(people.map(p => [p.pid, p]));
  const poolOf = (pid: string, team: string, g: Gender): string | null => {
    const p = peopleBy.get(pid);
    if (!p) return null;
    const hit = [p.ci ? `espn_${p.ci}` : "", p.ca ? `ca_${p.ca}` : "", p.ci ? `ca_${9e9 + Number(p.ci)}` : ""].map(i => byId.get(i)).find(Boolean) ?? byName.get(nameKey(p.name, team, g));
    return hit && hit.country === team ? hit.id : null;
  };

  const members = FULL.map(t => `'${t}'`).join(", ");
  const out: Record<string, unknown[]> = {};
  for (const [fmt, gender, g, types, since, folder] of SETS) {
    const mt = types.map(t => `'${t}'`).join(", ");
    const rows = duck<{ match_id: string; date: string; team1: string; team2: string; winner: string | null; result: string | null; outcome_method: string | null; vc: string; venue: string; city: string | null }>(`
WITH vm AS (SELECT raw_venue, coalesce(raw_city, '') raw_city, any_value(country) country FROM read_csv('venue_map.csv', header=true, all_varchar=true) WHERE source = 'cs' GROUP BY 1, 2)
SELECT m.match_id, strftime(m.date, '%Y-%m-%d') date, m.team1, m.team2, m.winner, m.result, m.outcome_method, coalesce(vm.country, 'UNK') vc, m.venue, m.city FROM 'matches.parquet' m
  LEFT JOIN vm ON vm.raw_venue = m.venue AND vm.raw_city = coalesce(m.city, '')
  WHERE m.match_type IN (${mt}) AND m.gender = '${g}' AND m.team_type = 'international' AND m.date >= DATE '${since}'
    AND m.team1 IN (${members}) AND m.team2 IN (${members}) ORDER BY m.date, m.match_id`);
    const list: unknown[] = [];
    let missingFile = 0, short = 0;
    for (const r of rows) {
      if (r.winner === null || (r.winner !== r.team1 && r.winner !== r.team2) || (r.outcome_method ?? "") !== "" || r.result === "tie" || r.result === "no result") continue;
      const file = `${JSON_DIR}/${folder}/${r.match_id}.json`;
      if (!existsSync(file)) { missingFile++; continue; }
      const cs = JSON.parse(readFileSync(file, "utf-8")) as CsMatch;
      const reg = cs.info.registry.people;
      const side = (team: string) => {
        const names = cs.info.players[team] ?? [];
        const bats: string[] = [];
        const inn = (cs.innings ?? []).find(i => i.team === team && !i.super_over);
        for (const o of inn?.overs ?? []) for (const d of o.deliveries) for (const n of [d.batter, d.non_striker]) if (!bats.includes(n)) bats.push(n);
        const ordered = [...bats.filter(n => names.includes(n)), ...names.filter(n => !bats.includes(n))];
        return ordered.map(n => poolOf(reg[n], team, g));
      };
      const bowlOvers = (team: string) => {
        if (fmt === "test") return undefined;
        const inn = (cs.innings ?? []).find(i => i.team !== team && !i.super_over);
        return inn?.overs?.map(o => poolOf(reg[o.deliveries[0].bowler], team, g)) ?? undefined;
      };
      // runs and balls faced by each batter of the side's first innings, in the order they came to the crease (the batting-order check)
      const card = (team: string): [number, number][] => {
        const inn = (cs.innings ?? []).find(i => i.team === team && !i.super_over);
        const seen = new Map<string, [number, number]>();
        for (const o of inn?.overs ?? []) for (const d of o.deliveries) {
          if (!seen.has(d.batter)) seen.set(d.batter, [0, 0]);
          if (!seen.has(d.non_striker)) seen.set(d.non_striker, [0, 0]);
          const e = seen.get(d.batter)!;
          e[0] += d.runs.batter; if (!d.extras?.wides) e[1]++;
        }
        return [...seen.values()];
      };
      const a = side(r.team1), b = side(r.team2);
      if (a.length !== 11 || b.length !== 11) short++;
      const host = r.vc === CODE[r.team1] ? "a" : r.vc === CODE[r.team2] ? "b" : null;
      list.push({
        id: r.match_id, date: r.date, a: r.team1, b: r.team2, host, venue: r.venue, city: r.city, winner: r.winner === r.team1 ? "a" : "b",
        xi: { a, b }, bat: { a: card(r.team1), b: card(r.team2) }, ...(fmt === "test" ? {} : { bowl: { a: bowlOvers(r.team1), b: bowlOvers(r.team2) } }),
      });
    }
    out[`${fmt}-${gender}`] = list;
    const known = (list as { xi: { a: (string | null)[]; b: (string | null)[] } }[]).flatMap(m => [m.xi.a, m.xi.b]);
    const ids = known.flat().length, nulls = known.flat().filter(x => x === null).length;
    console.log(`${fmt}-${gender}: ${list.length} matches (${missingFile} without a json file, ${short} with a side of other than 11 listed), ${nulls}/${ids} places not in the pool`);
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote " + OUT);
}
main();
