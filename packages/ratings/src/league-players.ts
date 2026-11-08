/**
 * Players for the extra T20 leagues (BBL, WBBL, PSL, SA20, The Hundred, CPL, ILT20, MLC, BPL, LPL).
 *
 * league-rosters.ts (generated from CricketArchive scorecards) lists each team's squad. Here each squad entry
 * is resolved to ratings, in order:
 *   1. the game pool by Cricinfo id (`espn_<id>`): men in ALL_PLAYERS, women in WPL_PLAYERS. These keep their
 *      pool ratings, so a player has the same ratings in every league;
 *   2. the full CricketArchive pool (`ca_<id>`), when registered via registerCaPlayerSource (the pool is loaded
 *      lazily elsewhere, so it plugs in here without this file knowing about it);
 *   3. the squad entry's fallback rating (`fb`, regressed from the ratings model at generation time).
 */

import { ALL_PLAYERS } from "./all-players.js";
import { WPL_PLAYERS } from "./wpl-players.js";
import { LEAGUE_ROSTERS } from "./league-rosters.js";
import type { BowlingStyle, BattingHand, PlayerData } from "@ipl-sim/engine";

export interface LeagueRosterPlayer {
  /** Display name */
  name: string;
  /** CricketArchive id (`ca_<ca>` in the full CricketArchive pool) */
  ca: number;
  /** Cricinfo id when known (`espn_<espn>` in the game pool) */
  espn?: number;
  country: string;
  age?: number;
  /** Matches in the XI during the source season (0 = topped up from the franchise's previous season) */
  apps: number;
  keeper?: boolean;
  hand: "left" | "right";
  /** Only present when the player was not in the game pool at generation time */
  role?: "batsman" | "bowler" | "all-rounder";
  bowl?: BowlingStyle;
  /** Fallback ratings: battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch */
  fb?: number[];
  fbSource?: "model" | "default";
}

export interface LeagueRosterTeam {
  teamId: string;
  /** Team name in the CricketArchive scorecards */
  caTeam: string;
  players: LeagueRosterPlayer[];
}

export interface LeagueRosters {
  season: string;
  source: string;
  teams: LeagueRosterTeam[];
}

export type LeaguePlayerSource = "pool" | "ca-pool" | "fallback";

/** Flat player record for createPlayerFromData (same shape as RealPlayerData / WPLPlayerData) plus provenance. */
export interface LeaguePlayerData {
  /** Stable id: `espn_<id>` when the player is in the game pool, else `ca_<id>` */
  id: string;
  name: string;
  age: number;
  country: string;
  role: string;
  isWicketKeeper?: boolean;
  bowlingStyle?: BowlingStyle;
  battingHand?: BattingHand;
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  teamId: string;
  imageUrl?: string;
  careerStats?: { m: number; r: number; avg: number; sr: number; w: number; econ: number };
  /** ODI / Test ratings, when the record carries them (extended-pool players); pool players get theirs from format-ratings.json */
  formatRatings?: PlayerData["formatRatings"];
  source: LeaguePlayerSource;
  caId: number;
  espnId?: number;
}

/**
 * Plug in the full CricketArchive pool: given a squad entry's ids, return its record (game id `ca_<ca>`) or undefined.
 * Called only for players that are not in the game pool. The record is the flat shape createPlayerFromData takes, the
 * same as the extended pool's `toRealPlayerData(player)` (the pool's shards are loaded lazily, so the app registers a
 * lookup over the loaded shards, e.g. `registerCaPlayerSource(({ ca }) => byCaId.get(ca))`).
 */
export type CaPlayerRecord = Omit<LeaguePlayerData, "id" | "teamId" | "source" | "caId" | "espnId"> & { id?: string };
export type CaPlayerSource = (ids: { ca: number; espn?: number; gender: "men" | "women" }) => CaPlayerRecord | undefined;

let caSource: CaPlayerSource | null = null;
export function registerCaPlayerSource(source: CaPlayerSource | null): void {
  caSource = source;
  cache.clear();
}

type PoolEntry = (typeof ALL_PLAYERS)[number];
let menIndex: Map<string, PoolEntry> | null = null;
let womenIndex: Map<string, PoolEntry> | null = null;

function poolIndex(gender: "men" | "women"): Map<string, PoolEntry> {
  if (gender === "men") {
    menIndex ??= new Map(ALL_PLAYERS.map(p => [p.id, p]));
    return menIndex;
  }
  womenIndex ??= new Map((WPL_PLAYERS as PoolEntry[]).map(p => [p.id, p]));
  return womenIndex;
}

export const EXTRA_LEAGUE_IDS = Object.keys(LEAGUE_ROSTERS);

function genderOf(leagueId: string): "men" | "women" {
  return leagueId === "wbbl" || leagueId === "hundred-w" ? "women" : "men";
}

const cache = new Map<string, LeaguePlayerData[]>();

/** Every squad player of one extra league, with ratings resolved as described at the top of this file. */
export function getLeaguePlayers(leagueId: string): LeaguePlayerData[] {
  const hit = cache.get(leagueId);
  if (hit) return hit;
  const rosters = LEAGUE_ROSTERS[leagueId];
  if (!rosters) throw new Error(`Unknown league "${leagueId}"`);
  const gender = genderOf(leagueId);
  const index = poolIndex(gender);
  const out: LeaguePlayerData[] = [];
  for (const team of rosters.teams) {
    for (const rp of team.players) {
      const entry = rp.espn !== undefined ? index.get(`espn_${rp.espn}`) : undefined;
      if (entry) {
        out.push({
          id: entry.id,
          name: entry.name,
          age: entry.age,
          country: entry.country.replace(/ Women$/, ""),
          role: entry.role,
          isWicketKeeper: rp.keeper || entry.isWicketKeeper || undefined,
          bowlingStyle: entry.bowlingStyle,
          battingHand: entry.battingHand,
          ...entry.ratings,
          teamId: team.teamId,
          imageUrl: entry.imageUrl,
          careerStats: (entry as { careerStats?: LeaguePlayerData["careerStats"] }).careerStats,
          source: "pool",
          caId: rp.ca,
          espnId: rp.espn,
        });
        continue;
      }
      const extra = caSource?.({ ca: rp.ca, espn: rp.espn, gender });
      if (extra) {
        // The squad's own scorecards say who kept wicket this season; keep that even if the CA record's
        // career-level flag doesn't (otherwise a squad can lose its only keeper)
        out.push({
          ...extra, id: extra.id ?? `ca_${rp.ca}`, isWicketKeeper: extra.isWicketKeeper || rp.keeper || undefined,
          teamId: team.teamId, source: "ca-pool", caId: rp.ca, espnId: rp.espn,
        });
        continue;
      }
      const [battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch] = rp.fb ?? [45, 45, 45, 45, 20, 20, 20, 45];
      out.push({
        id: `ca_${rp.ca}`,
        name: rp.name,
        age: rp.age ?? 25,
        country: rp.country,
        role: rp.role ?? "batsman",
        isWicketKeeper: rp.keeper || undefined,
        bowlingStyle: rp.bowl,
        battingHand: rp.hand,
        battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch,
        teamId: team.teamId,
        source: "fallback",
        caId: rp.ca,
        espnId: rp.espn,
      });
    }
  }
  cache.set(leagueId, out);
  return out;
}

export interface LeagueMatchStats {
  leagueId: string;
  players: number;
  /** In the game pool (ratings shared with every other league) */
  pool: number;
  /** Resolved from the full CricketArchive pool */
  caPool: number;
  /** Generated fallback ratings */
  generated: number;
}

/** How many squad players were matched to the pool versus generated. */
export function getLeagueMatchStats(leagueId: string): LeagueMatchStats {
  const players = getLeaguePlayers(leagueId);
  const count = (s: LeaguePlayerSource) => players.filter(p => p.source === s).length;
  return { leagueId, players: players.length, pool: count("pool"), caPool: count("ca-pool"), generated: count("fallback") };
}

export function getLeagueSeason(leagueId: string): string {
  return LEAGUE_ROSTERS[leagueId]?.season ?? "";
}

/** Ids (in the game pool) of the players rostered in an extra league: used to keep them out of its free-agent pool. */
export function getLeagueRosteredIds(leagueId: string): Set<string> {
  return new Set(getLeaguePlayers(leagueId).map(p => p.id));
}

/** The full men's / women's pool, for a league's auction pool and free agents (same shape as getLeaguePlayers). */
export function getPoolPlayersForLeague(leagueId: string, excludeIds: Set<string> = getLeagueRosteredIds(leagueId)): Omit<LeaguePlayerData, "teamId">[] {
  const gender = genderOf(leagueId);
  const list = gender === "men" ? ALL_PLAYERS : (WPL_PLAYERS as PoolEntry[]);
  return list
    .filter(p => !excludeIds.has(p.id))
    .map(p => ({
      id: p.id,
      name: p.name,
      age: p.age,
      country: p.country.replace(/ Women$/, ""),
      role: p.role,
      isWicketKeeper: p.isWicketKeeper,
      bowlingStyle: p.bowlingStyle,
      battingHand: p.battingHand,
      ...p.ratings,
      imageUrl: p.imageUrl,
      careerStats: (p as { careerStats?: LeaguePlayerData["careerStats"] }).careerStats,
      source: "pool" as const,
      caId: 0,
    }));
}
