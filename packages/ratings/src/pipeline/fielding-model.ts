/**
 * Fielding and wicketkeeping ratings (src/analysis/fielding-ratings.py) for the game's players.
 *
 * data/analysis/fielding_ratings.csv is keyed by Cricsheet player with the Cricinfo id from Cricsheet's register,
 * which is the id the game's ESPN players carry, so no fuzzy matching is needed. `fielding` and `keeping` are 0-99
 * on a scale where 50 is the average player (the engine's neutral point); the CSV leaves `keeping` empty for
 * players who never kept.
 */

import { existsSync, readFileSync } from "fs";

const FILE = new URL("../../data/analysis/fielding_ratings.csv", import.meta.url).pathname;

/** Keeping rating given to a player the data tags as a keeper (ESPN role) but has no usable keeping record for */
export const UNRATED_KEEPER = 50;
/** Fielding innings before a player's own fielding rating is written (below that he gets the engine default) */
const MIN_FIELD_INNINGS = 1;

export interface FieldingRow {
  cricinfoId: number;
  gender: "male" | "female";
  fieldInns: number;
  keepInns: number;
  fielding?: number;
  keeping?: number;
}

export function fieldingAvailable(): boolean {
  return existsSync(FILE);
}

/** Minimal CSV line split (the file has no quoted commas except names, which are quoted) */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Rows by Cricinfo id for one gender. A player listed twice (two Cricsheet ids) keeps the row with more innings. */
export function loadFielding(gender: "male" | "female"): Map<number, FieldingRow> {
  const out = new Map<number, FieldingRow>();
  if (!fieldingAvailable()) return out;
  const lines = readFileSync(FILE, "utf-8").split(/\r?\n/).filter(Boolean);
  const head = splitCsv(lines[0]);
  const ix = (n: string) => head.indexOf(n);
  const [iId, iG, iF, iK, iFld, iKeep] = ["cricinfo_id", "gender", "field_inns", "keep_inns", "fielding", "keeping"].map(ix);
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    if (c[iG] !== gender || !c[iId]) continue;
    const row: FieldingRow = {
      cricinfoId: Number(c[iId]),
      gender,
      fieldInns: Number(c[iF] || 0),
      keepInns: Number(c[iK] || 0),
      fielding: c[iFld] !== "" ? Number(c[iFld]) : undefined,
      keeping: c[iKeep] !== "" ? Number(c[iKeep]) : undefined,
    };
    const seen = out.get(row.cricinfoId);
    if (!seen || row.fieldInns + row.keepInns > seen.fieldInns + seen.keepInns) out.set(row.cricinfoId, row);
  }
  return out;
}

/** Hand-entered players (espnId 0 in the generator) and their Cricinfo ids */
const MANUAL_CRICINFO: Record<string, number> = {
  manual_msd: 28081,
  manual_trent_boult: 277912,
};

export interface FieldingTarget {
  id?: string;
  espnId: number;
  isWicketKeeper?: boolean;
  ratings: { fielding?: number; keeping?: number };
}

/**
 * Add `fielding` / `keeping` to each rated player. Fielding comes from the player's own record; keeping from his
 * keeper innings, or the neutral UNRATED_KEEPER for a keeper (by ESPN role) with no record. Players Cricsheet
 * doesn't know keep the engine defaults (fielding 50, keeping 25, or 50 for a keeper).
 */
export function applyFieldingRatings(players: FieldingTarget[], gender: "male" | "female"): { fielding: number; keeping: number; unmatched: number } {
  const rows = loadFielding(gender);
  let fielding = 0, keeping = 0, unmatched = 0;
  for (const p of players) {
    const r = rows.get(p.espnId || (p.id ? MANUAL_CRICINFO[p.id] : 0) || 0);
    if (!r) { unmatched++; if (p.isWicketKeeper) { p.ratings.keeping = UNRATED_KEEPER; keeping++; } continue; }
    if (r.fielding !== undefined && r.fieldInns >= MIN_FIELD_INNINGS) { p.ratings.fielding = r.fielding; fielding++; }
    if (r.keeping !== undefined) { p.ratings.keeping = r.keeping; keeping++; }
    else if (p.isWicketKeeper) { p.ratings.keeping = UNRATED_KEEPER; keeping++; }
  }
  return { fielding, keeping, unmatched };
}
