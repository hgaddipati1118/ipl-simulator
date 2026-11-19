/**
 * Selection / availability rates of national sides (docs/COUNTRY-VALIDATION.md, "Realistic line-ups").
 *
 *   npx tsx src/pipeline/generate-intl-availability.ts [--dry]            -> app/src/intl-availability-data.ts (matches since 2024-01-01)
 *   AVAIL_TO=2024-12-31 npx tsx ... --out ../../docs/data/intl_availability_2024.json   (the held-out check: 2024 only, JSON)
 *
 * For every national side (the app's nations), format (T20I, ODI, Test) and gender: each player's share of the side's matches
 * he played (he batted, bowled or stood at the non-striker's end in at least one ball of it; the rare player who only fielded
 * is not counted). Cricsheet international matches (match_type T20 / IT20, ODI / ODM, Test) from AVAIL_FROM (default 2024-01-01)
 * to AVAIL_TO (default: all). Players are keyed like the rest of the app (`sourceId ?? id`: `espn_<id>`, `ca_<id>`) through
 * Cricsheet's people.csv, as generate-intl-adjust.ts does. A player the pool does not have is dropped (the sampler renormalises).
 *
 * Output: { "<fmt>-<gender>": { "<country>": { "<player id>": rate (2 decimals) } } } with `matches` per side in `_n`.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import { decodeShard, type PoolShard } from "../extended-pool.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const OUT_TS = new URL("../../../app/src/intl-availability-data.ts", import.meta.url).pathname;
const FROM = process.env.AVAIL_FROM ?? "2024-01-01";
const TO = process.env.AVAIL_TO ?? "2100-01-01";
const argOut = process.argv.indexOf("--out");
const OUT_JSON = argOut > 0 ? process.argv[argOut + 1] : null;
const DRY = process.argv.includes("--dry");
const NATIONS = ["India", "Australia", "England", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "West Indies", "Bangladesh", "Afghanistan", "Zimbabwe", "Ireland",
  "Netherlands", "Scotland", "Nepal", "United Arab Emirates", "United States of America", "Namibia", "Oman", "Canada", "Kenya", "Thailand"];
const COUNTRY: Record<string, string> = { "United Arab Emirates": "UAE", "United States of America": "USA" };
type Gender = "male" | "female";
const SETS: [string, "men" | "women", Gender, string[]][] = [
  ["t20i", "men", "male", ["T20", "IT20"]], ["t20i", "women", "female", ["T20", "IT20"]],
  ["odi", "men", "male", ["ODI", "ODM"]], ["odi", "women", "female", ["ODI", "ODM"]],
  ["test", "men", "male", ["Test"]],
];

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 2 * 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

interface Pooled { id: string; name: string; country: string; gender: Gender }

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
  const poolOf = (p: { name: string; ci: string | null; ca: string | null }, team: string, g: Gender) =>
    [p.ci ? `espn_${p.ci}` : "", p.ca ? `ca_${p.ca}` : "", p.ci ? `ca_${9e9 + Number(p.ci)}` : ""].map(i => byId.get(i)).find(Boolean) ?? byName.get(nameKey(p.name, COUNTRY[team] ?? team, g));
  const peopleBy = new Map(people.map(p => [p.pid, p]));

  const out: Record<string, Record<string, Record<string, number>>> = {};
  const nOut: Record<string, Record<string, number>> = {};
  const teams = NATIONS.map(n => `'${n}'`).join(",");
  for (const [fmt, gender, g, types] of SETS) {
    const mt = types.map(t => `'${t}'`).join(",");
    const rows = duck<{ team: string; pid: string; n: number }>(`
WITH m AS (SELECT match_id FROM 'matches.parquet' WHERE team_type = 'international' AND gender = '${g}' AND match_type IN (${mt}) AND date >= DATE '${FROM}' AND date <= DATE '${TO}'),
pm AS (SELECT DISTINCT d.match_id, d.batting_team team, d.batter_id pid FROM 'deliveries.parquet' d JOIN m USING(match_id)
  UNION SELECT DISTINCT d.match_id, d.batting_team, d.non_striker_id FROM 'deliveries.parquet' d JOIN m USING(match_id)
  UNION SELECT DISTINCT d.match_id, d.bowling_team, d.bowler_id FROM 'deliveries.parquet' d JOIN m USING(match_id))
SELECT team, pid, count(*)::INT n FROM pm WHERE team IN (${teams}) GROUP BY 1, 2`);
    const matches = duck<{ team: string; n: number }>(`
WITH m AS (SELECT match_id FROM 'matches.parquet' WHERE team_type = 'international' AND gender = '${g}' AND match_type IN (${mt}) AND date >= DATE '${FROM}' AND date <= DATE '${TO}'),
tm AS (SELECT DISTINCT d.match_id, d.batting_team team FROM 'deliveries.parquet' d JOIN m USING(match_id) UNION SELECT DISTINCT d.match_id, d.bowling_team FROM 'deliveries.parquet' d JOIN m USING(match_id))
SELECT team, count(*)::INT n FROM tm WHERE team IN (${teams}) GROUP BY 1`);
    const nTeam = new Map(matches.map(r => [r.team, r.n]));
    const set: Record<string, Record<string, number>> = {};
    let dropped = 0, kept = 0;
    for (const r of rows) {
      const n = nTeam.get(r.team) ?? 0;
      if (n < 3) continue; // too few matches to say anything
      const p = peopleBy.get(r.pid);
      const pl = p ? poolOf(p, r.team, g) : undefined;
      if (!pl) { dropped++; continue; }
      kept++;
      const country = pl.country;
      (set[country] ??= {})[pl.id] = Math.round((r.n / n) * 100) / 100;
    }
    out[`${fmt}-${gender}`] = set;
    nOut[`${fmt}-${gender}`] = Object.fromEntries(matches.filter(r => r.n >= 3).map(r => [COUNTRY[r.team] ?? r.team, r.n]));
    console.log(`${fmt}-${gender}: ${kept} player-sides kept, ${dropped} not in the pool; sides ${Object.keys(set).length}`);
  }
  if (DRY) return;
  const payload = { from: FROM, to: TO === "2100-01-01" ? null : TO, matches: nOut, rates: out };
  if (OUT_JSON) { writeFileSync(OUT_JSON, JSON.stringify(payload)); console.log("wrote " + OUT_JSON); return; }
  const header = `/**
 * GENERATED by packages/ratings/src/pipeline/generate-intl-availability.ts. Do not edit by hand.
 *
 * Each national side's selection rates (share of its matches a player played) since ${FROM}, per format-gender set and country,
 * from Cricsheet (the realistic line-ups of international.ts: docs/COUNTRY-VALIDATION.md, "Realistic line-ups").
 */
export interface IntlAvailability { from: string; to: string | null; matches: Record<string, Record<string, number>>; rates: Record<string, Record<string, Record<string, number>>> }

export const INTL_AVAILABILITY: IntlAvailability = ${JSON.stringify(payload)};
`;
  writeFileSync(OUT_TS, header);
  console.log("wrote " + OUT_TS);
}
main();
