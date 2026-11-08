/**
 * Extended player pool: every CricketArchive player the ESPN pool (all-players.ts / wpl-players.ts) doesn't have, from
 * senior cricket without an ESPN profile down to second XIs, university, club, youth and veterans cricket.
 *
 * Shipped as gzip JSON shards (app/public/pool/, written by pipeline/generate-ca-pool.ts) so none of it is in the app
 * bundle, listed by manifest.json and loaded on demand. This module is pure (no I/O, browser-safe): the shard format,
 * decoding to engine `PlayerData`, and search. Fetching + gunzipping lives with the caller (app/src/extended-pool.ts,
 * Node tests use zlib).
 *
 * Shard: { v, gender, tier, countries[], styles[], rows: [[id, name, age, country#, role#, style#, hand, keeper,
 *   battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch, matches, runs, avg, sr, wickets, econ, lastYear]] }
 * tier: "senior" (Twenty20 / List A / First-Class cards) or "tier0".."tier4" for event-only cards by their lowest-tier
 * appearance (0 domestic second XI / touring / other senior-side, 1 university, 2 club / league, 3 youth, 4 veterans).
 * Version 2 rows add two trailing elements, the player's ODI and Test sets (format-ratings.ts EncodedSet: eight
 * attributes + source), written by pipeline/generate-format-ratings.ts. Version 1 shards still decode (no format sets).
 */

import { calculateBattingOverall, calculateBowlingOverall, calculateOverallRating, type PlayerData, type BowlingStyle } from "@ipl-sim/engine";
import { decodeFormatSets, type EncodedSet } from "./format-ratings.js";

export const POOL_VERSION = 2;
/** Shard versions decodeShard reads */
const READABLE_VERSIONS = [1, 2];
/** Fields of a version 1 row (the version 2 format sets come after them) */
const BASE_FIELDS = 23;

export type PoolGender = "men" | "women";
export type PoolRole = "batsman" | "bowler" | "all-rounder";
const ROLES: PoolRole[] = ["batsman", "bowler", "all-rounder"];

export interface PoolRow {
  /** CricketArchive id; the player's game id is `ca_<id>` */
  id: number;
  name: string;
  age: number;
  country: string;
  role: PoolRole;
  /** battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch */
  ratings: [number, number, number, number, number, number, number, number];
  bowlingStyle: string;
  battingHand: "left" | "right";
  isWicketKeeper: boolean;
  matches: number; runs: number; average: number; strikeRate: number; wickets: number; economy: number;
  /** Last season he played (2000-2026) */
  lastYear: number;
  /** ODI and Test sets (version 2) */
  formats?: [EncodedSet, EncodedSet];
}

export interface PoolShard {
  v: number;
  gender: PoolGender;
  tier: string;
  countries: string[];
  styles: string[];
  rows: (string | number | EncodedSet)[][];
}

export interface PoolShardInfo {
  file: string;
  gender: PoolGender;
  tier: string;
  /** Human label of the tier: senior, senior-event, university, club, youth, veterans */
  level: string;
  count: number;
  bytes: number;
  topOverall: number;
  minOverall: number;
}

export interface PoolManifest { version: number; generated: string; shards: PoolShardInfo[] }

export function encodeShard(gender: PoolGender, tier: string, rows: PoolRow[]): PoolShard {
  const countries: string[] = [], styles: string[] = [];
  const idx = (list: string[], v: string) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
  return {
    v: POOL_VERSION, gender, tier, countries, styles,
    rows: rows.map(r => [
      r.id, r.name, r.age, idx(countries, r.country), ROLES.indexOf(r.role), idx(styles, r.bowlingStyle), r.battingHand === "left" ? 1 : 0, r.isWicketKeeper ? 1 : 0,
      ...r.ratings, r.matches, r.runs, r.average, r.strikeRate, r.wickets, r.economy, r.lastYear,
      ...(r.formats ? r.formats : []),
    ]),
  };
}

/** An extended-pool player: engine PlayerData (without the injury fields, like all-players.ts) plus where he plays */
export type ExtendedPlayer = Omit<PlayerData, "injured" | "injuryGamesLeft"> & { gender: PoolGender; tier: string; lastYear: number };

export function decodeShard(shard: PoolShard): ExtendedPlayer[] {
  if (!READABLE_VERSIONS.includes(shard.v)) throw new Error(`Unsupported pool shard version ${shard.v}`);
  return shard.rows.map(r => {
    const country = shard.countries[r[3] as number];
    const keeper = r[7] === 1;
    const sets = r.length > BASE_FIELDS ? (r.slice(BASE_FIELDS, BASE_FIELDS + 2) as unknown as [EncodedSet, EncodedSet]) : undefined;
    return {
      id: `ca_${r[0]}`,
      name: r[1] as string,
      age: r[2] as number,
      country,
      role: ROLES[r[4] as number],
      ratings: { battingIQ: r[8] as number, timing: r[9] as number, power: r[10] as number, running: r[11] as number, wicketTaking: r[12] as number, economy: r[13] as number, accuracy: r[14] as number, clutch: r[15] as number },
      isInternational: country !== "India",
      ...(keeper ? { isWicketKeeper: true } : {}),
      bowlingStyle: shard.styles[r[5] as number] as BowlingStyle,
      battingHand: r[6] === 1 ? "left" : "right",
      careerStats: { m: r[16] as number, r: r[17] as number, avg: r[18] as number, sr: r[19] as number, w: r[20] as number, econ: r[21] as number },
      ...(sets ? { formatRatings: decodeFormatSets(sets) } : {}),
      gender: shard.gender,
      tier: shard.tier,
      lastYear: r[22] as number,
    } as ExtendedPlayer;
  });
}

/** Case- and accent-insensitive name search over decoded players, best matches first (prefix, then word prefix, then substring) */
export function searchPlayers<T extends { name: string; country: string }>(players: T[], query: string, limit = 50): T[] {
  const q = query.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  if (!q) return [];
  const scored: [number, T][] = [];
  for (const p of players) {
    const n = p.name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    let score = -1;
    if (n.startsWith(q)) score = 0;
    else if (n.split(/[\s-]+/).some(w => w.startsWith(q))) score = 1;
    else if (n.includes(q)) score = 2;
    else if (p.country.toLowerCase().startsWith(q)) score = 3;
    if (score >= 0) scored.push([score, p]);
    if (scored.length > limit * 20) break;
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, p]) => p);
}

/** Batting, bowling and overall rating of an extended-pool player (the engine's formulas) */
export function overallsOf(p: { ratings: ExtendedPlayer["ratings"] }): { batting: number; bowling: number; overall: number } {
  const batting = calculateBattingOverall(p.ratings);
  const bowling = calculateBowlingOverall(p.ratings);
  return { batting, bowling, overall: calculateOverallRating(batting, bowling) };
}

/** The flat shape the app's createPlayerFromData takes (same as real-players.ts RealPlayerData) */
export function toRealPlayerData(p: ExtendedPlayer) {
  return {
    id: p.id, name: p.name, age: p.age, country: p.country, role: p.role, isWicketKeeper: p.isWicketKeeper,
    bowlingStyle: p.bowlingStyle, battingHand: p.battingHand, careerStats: p.careerStats,
    battingIQ: p.ratings.battingIQ, timing: p.ratings.timing, power: p.ratings.power, running: p.ratings.running,
    wicketTaking: p.ratings.wicketTaking, economy: p.ratings.economy, accuracy: p.ratings.accuracy, clutch: p.ratings.clutch,
    ...(p.formatRatings ? { formatRatings: p.formatRatings } : {}),
  };
}

/**
 * Players for a default (deep) auction pool: the best `count` of a set by overall, among those still playing
 * (lastYear >= minLastYear) and not older than maxAge. Lower-level players are never part of it: pass senior players only.
 */
export function topActive(players: ExtendedPlayer[], count: number, minLastYear = 2022, maxAge = 40): ExtendedPlayer[] {
  return players
    .filter(p => p.lastYear >= minLastYear && p.age <= maxAge)
    .map(p => [overallsOf(p).overall, p] as const)
    .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, count)
    .map(([, p]) => p);
}
