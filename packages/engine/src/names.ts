/**
 * Realistic names for generated players: first and last names are drawn independently from pools built from the
 * real players of the same region and gender (name-model.ts), so the combination is new. A hashed blocklist of the
 * real full names those pools could reproduce guarantees a generated player never shares a real person's name.
 */

import { NAME_POOLS, NAME_GROUP_OF, REAL_NAME_HASHES, type NamePool } from "./name-model.js";
import type { RNG } from "./rng.js";

export type NameGender = "male" | "female";

const FALLBACK_GROUP: Record<string, string> = { afghanistan: "pakistan", nepal: "india" };

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lower-case, accents and punctuation removed (the same normalisation the blocklist was built with) */
export function normaliseName(full: string): string {
  return full.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}

let blocked: Set<number> | null = null;
function blocklist(): Set<number> {
  if (!blocked) blocked = new Set(REAL_NAME_HASHES.split(",").filter(Boolean).map(h => parseInt(h, 36)));
  return blocked;
}

/** True when this exact first + last combination belongs to a real player the pools were built from */
export function isRealName(full: string): boolean {
  return blocklist().has(fnv(normaliseName(full)));
}

export function nameGroupOf(country: string): string {
  return NAME_GROUP_OF[country.replace(/\s+Women$/, "").trim()] ?? "europe";
}

function poolFor(group: string, gender: NameGender): NamePool {
  const direct = NAME_POOLS[`${group}/${gender}`];
  if (direct && direct.first.length >= 25 && direct.last.length >= 25) return direct;
  const fb = FALLBACK_GROUP[group];
  if (fb && NAME_POOLS[`${fb}/${gender}`]) return NAME_POOLS[`${fb}/${gender}`];
  if (direct) return direct;
  return NAME_POOLS[`europe/${gender}`] ?? NAME_POOLS["europe/male"];
}

function pick(rng: RNG, items: string[], weights: number[]): string {
  // flatten the head of the distribution so common names do not dominate
  let total = 0;
  const w = weights.map(x => { const v = Math.pow(x, 0.75); total += v; return v; });
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= w[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** A new full name for a player of this country and gender; never the name of a real player */
export function generateName(rng: RNG, country: string, gender: NameGender = "male"): string {
  const pool = poolFor(nameGroupOf(country), gender);
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = pick(rng, pool.first, pool.firstW);
    const last = pick(rng, pool.last, pool.lastW);
    if (first.toLowerCase() === last.toLowerCase()) continue;
    const full = `${first} ${last}`;
    if (!isRealName(full)) return full;
  }
  // practically unreachable: fall back to a first name with a different pool's surname
  const other = NAME_POOLS["europe/male"];
  return `${pick(rng, pool.first, pool.firstW)} ${pick(rng, other.last, other.lastW)}`;
}
