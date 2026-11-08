/**
 * When each shipped player last played: his last international season per format (T20I, ODI, Test) and his last senior
 * domestic season, from the CricketArchive cells (data/analysis/ca_cells.parquet: senior matches, internationals split by
 * opponent as "T20I v India", "ListAI v India", "FCI v India"; comp_class intl_full / intl_assoc / dom_<country>).
 * National squads (app: international.ts) pick from players who are still playing.
 *
 *   npx tsx src/pipeline/generate-player-activity.ts
 *
 * Inputs: data/analysis/ca_cells.parquet, ca_espn_map.csv (ESPN id -> CricketArchive id), data/scraped/espn-players.json
 * (the hand-added players' ESPN ids). Output: ../app/public/data/player-activity.json, format in src/player-activity.ts.
 * Players the map does not reach (no CricketArchive id) are left out: the app treats them as unknown.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { gzipSync } from "zlib";
import { WPL_PLAYERS } from "../wpl-players.js";
import { getRealPlayers, getPoolPlayers } from "../real-players.js";
import { PLAYER_ACTIVITY_VERSION, type PlayerActivityFile } from "../player-activity.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const OUT_JSON = new URL("../../../app/public/data/player-activity.json", import.meta.url).pathname;

function duck<T>(sql: string): T[] {
  return JSON.parse(execFileSync("duckdb", ["-json", "-c", `SET memory_limit='2GB'; ${sql}`], { encoding: "utf-8", cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }) || "[]") as T[];
}

function espnToCa(): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of readFileSync(`${DIR}ca_espn_map.csv`, "utf-8").split("\n").slice(1)) {
    const [e, c] = line.split(",");
    if (e && c && !out.has(Number(e))) out.set(Number(e), Number(c));
  }
  return out;
}

/** Hand-added players (`manual_<name>`) by name in the ESPN profiles */
function manualEspnIds(names: string[]): Map<string, number> {
  const file = `${ROOT}data/scraped/espn-players.json`;
  const out = new Map<string, number>();
  if (!existsSync(file) || names.length === 0) return out;
  const want = new Set(names);
  const profiles = JSON.parse(readFileSync(file, "utf-8")) as { profile: { espnId: number; name: string; longName: string } }[];
  for (const { profile } of profiles) for (const n of [profile.longName, profile.name]) if (want.has(n) && !out.has(n)) out.set(n, Number(profile.espnId));
  return out;
}

// Last season per CricketArchive player: T20I, ODI (List A internationals), Test (first-class internationals), domestic
const rows = duck<{ player_id: number; t20i: number | null; odi: number | null; test: number | null; dom: number | null }>(`
  SELECT player_id,
    max(year) FILTER (WHERE format = 'T20' AND comp_class LIKE 'intl%') AS t20i,
    max(year) FILTER (WHERE format = 'ListA' AND comp_class LIKE 'intl%') AS odi,
    max(year) FILTER (WHERE format = 'FC' AND comp_class LIKE 'intl%') AS test,
    max(year) FILTER (WHERE comp_class LIKE 'dom%') AS dom
  FROM '${DIR}ca_cells.parquet' GROUP BY 1`);
const byCa = new Map(rows.map(r => [Number(r.player_id), [r.t20i ?? 0, r.odi ?? 0, r.test ?? 0, r.dom ?? 0].map(Number) as [number, number, number, number]]));
const asOf = rows.reduce((m, r) => Math.max(m, Number(r.t20i ?? 0), Number(r.odi ?? 0), Number(r.test ?? 0), Number(r.dom ?? 0)), 0);

const map = espnToCa();
const records = [...getRealPlayers(), ...getPoolPlayers(), ...WPL_PLAYERS];
const manual = manualEspnIds(records.filter(r => r.id.startsWith("manual_")).map(r => r.name));
const file: PlayerActivityFile = { v: PLAYER_ACTIVITY_VERSION, generated: new Date().toISOString().slice(0, 10), asOf, players: {} };
let missing = 0;
for (const r of records) {
  if (file.players[r.id]) continue;
  const espn = r.id.startsWith("espn_") ? Number(r.id.slice(5)) : manual.get(r.name);
  const ca = espn !== undefined ? map.get(espn) : undefined;
  const last = ca !== undefined ? byCa.get(ca) : undefined;
  if (!last) { missing++; continue; }
  file.players[r.id] = last;
}
writeFileSync(OUT_JSON, JSON.stringify(file));
const bytes = readFileSync(OUT_JSON);
console.log(`player-activity.json: ${Object.keys(file.players).length} players (${missing} without a CricketArchive record), as of ${asOf}, ${(bytes.length / 1024).toFixed(0)} KB (${(gzipSync(bytes).length / 1024).toFixed(0)} KB gzipped)`);
