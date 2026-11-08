/**
 * ODI and Test ratings of the shipped players, written by pipeline/generate-format-ratings.ts.
 *
 * The ESPN pool (all-players.ts / wpl-players.ts) and the league squads' fallback players live in a compact JSON file
 * outside the JS bundle (app/public/data/format-ratings.json), keyed by the record id a game Player keeps as its
 * `sourceId` (`espn_<id>`, `ca_<id>`, `manual_<name>`); the extended pool's shards carry their own sets (extended-pool.ts).
 * This module is pure (no I/O, browser-safe): the file format, decoding, and attaching sets to players.
 *
 * File: { v, generated, players: { [sourceId]: [odi, test] } }, each set [battingIQ, timing, power, running,
 *   wicketTaking, economy, accuracy, clutch, source] with source 1 = "data" (measured in List A / ODI or first-class /
 *   Test), 0 = "derived" (translated from the player's other formats). Fielding and keeping are not stored: a set takes
 *   the player's own T20 values. Sets are already normalised the way createPlayerFromData normalises T20 ratings.
 */

import type { FormatRatings, LongFormat, PlayerRatings } from "@ipl-sim/engine";

export const FORMAT_RATINGS_VERSION = 1;
export const LONG_FORMATS: LongFormat[] = ["odi", "test"];
export const CORE_KEYS = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const;

/** One format's set: the eight attributes in CORE_KEYS order, then 1 = "data", 0 = "derived" */
export type EncodedSet = number[];

export interface FormatRatingsFile {
  v: number;
  generated: string;
  /** sourceId -> [odi, test] */
  players: Record<string, [EncodedSet, EncodedSet]>;
}

type Core = Pick<PlayerRatings, (typeof CORE_KEYS)[number]>;

export function encodeSet(ratings: Core, source: FormatRatings["source"]): EncodedSet {
  return [...CORE_KEYS.map(k => Math.round(ratings[k])), source === "data" ? 1 : 0];
}

/** A stored set as engine FormatRatings, with fielding / keeping taken from `base` (the player's T20 ratings) */
export function decodeSet(set: EncodedSet, base?: Pick<PlayerRatings, "fielding" | "keeping">): FormatRatings {
  const ratings = Object.fromEntries(CORE_KEYS.map((k, i) => [k, set[i]])) as unknown as PlayerRatings;
  if (base?.fielding !== undefined) ratings.fielding = base.fielding;
  if (base?.keeping !== undefined) ratings.keeping = base.keeping;
  return { ratings, source: set[8] === 1 ? "data" : "derived" };
}

export function decodeFormatSets(sets: [EncodedSet, EncodedSet], base?: Pick<PlayerRatings, "fielding" | "keeping">): Partial<Record<LongFormat, FormatRatings>> {
  const out: Partial<Record<LongFormat, FormatRatings>> = {};
  LONG_FORMATS.forEach((f, i) => { if (sets[i]?.length >= 9) out[f] = decodeSet(sets[i], base); });
  return out;
}

/** A player's ODI / Test sets from the file, or undefined if the file has none for him */
export function formatRatingsFor(file: FormatRatingsFile | null | undefined, sourceId: string | undefined, base?: Pick<PlayerRatings, "fielding" | "keeping">): Partial<Record<LongFormat, FormatRatings>> | undefined {
  if (!file || !sourceId) return undefined;
  const sets = file.players[sourceId];
  return sets ? decodeFormatSets(sets, base) : undefined;
}

export interface AttachablePlayer {
  sourceId?: string;
  ratings: PlayerRatings;
  formatRatings?: Partial<Record<LongFormat, FormatRatings>>;
}

/**
 * Give every player the file has sets for, and that has none yet, his ODI / Test ratings (in place). Players that
 * already carry sets (from a save, or an extended-pool shard) keep them. Returns how many were attached.
 */
export function attachFormatRatings(players: Iterable<AttachablePlayer>, file: FormatRatingsFile | null | undefined): number {
  if (!file || file.v !== FORMAT_RATINGS_VERSION) return 0;
  let n = 0;
  for (const p of players) {
    if (p.formatRatings && Object.keys(p.formatRatings).length > 0) continue;
    const fr = formatRatingsFor(file, p.sourceId, p.ratings);
    if (!fr) continue;
    p.formatRatings = fr;
    n++;
  }
  return n;
}
