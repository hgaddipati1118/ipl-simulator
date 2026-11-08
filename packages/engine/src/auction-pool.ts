/**
 * Who goes under the hammer: the auction's shortlist, sized like a real IPL auction and scaled to the league
 * (docs/RULES-AUCTION.md section 10).
 *
 * The free agents of a career are every unsigned player in the database (5,000+ men), far more than any auction
 * holds. A real auction shortlists from its registrations: the IPL's mini auctions put about 350 players in front of
 * the teams (333 for 2024, 350 for 2026), its mega auctions about 575 (590 for 2022, 574 for 2025), for 250 squad
 * places. The pool here is that many per squad place, at least enough per open place for every side to fill its
 * squad, and always holds the players who must be there (released since the last auction, added by the user). It
 * holds enough keepers, spinners, pacers, overseas and domestic players for what the teams still need; the last
 * auction's unsold have the next claim on the places left, then the best free agents by market value. Everyone else
 * stays a free agent: signable during the season and eligible for the next auction.
 */

import type { Player } from "./player.js";
import type { Team } from "./team.js";
import type { AuctionType } from "./rules.js";
import { isPaceBowler, isSpinBowler } from "./matchups.js";

/** Shortlisted players per squad place (teams x max squad size): IPL mini auctions 333-350 / 250, mega 574-590 / 250 */
export const POOL_PER_SQUAD_PLACE: Record<AuctionType, number> = { mini: 1.4, mega: 2.3 };
/** The pool holds at least this many players per place the teams have open (retention can open more than a real mini auction) */
export const POOL_PER_OPEN_PLACE = 1.6;
/** For each player the teams need of a kind (a keeper, a spinner...) the pool holds this many of that kind */
export const POOL_COVERAGE = 2;
/** Keepers a squad wants: the auction's last pass also gives every team two (an injury backup) */
export const KEEPERS_PER_SQUAD = 2;
/** Frontline spinners and pacers a squad wants, as a share of the squad (IPL 25: 4 spinners, 8 pacers; Hundred 16: 3, 5) */
export const SPINNER_SHARE = 0.16;
export const PACER_SHARE = 0.3;

export type PoolCategory = "keeper" | "spinner" | "pacer" | "overseas" | "domestic";
const CATEGORIES: readonly PoolCategory[] = ["keeper", "spinner", "pacer", "overseas", "domestic"];

export interface AuctionPoolOptions {
  type: AuctionType;
  maxSquadSize: number;
  maxOverseasInSquad: number;
  /** Ids that are always in the auction (released since the last auction, added by the user, academy prospects) */
  mustInclude?: Iterable<string>;
  /** Ids with the first claim on the shortlist after the must-includes and the role cover, up to its size (the last
   *  auction's unsold, re-registering) */
  preferred?: Iterable<string>;
  /** Every free agent goes to the auction (the "Deep" pool option) */
  deep?: boolean;
}

export interface AuctionPoolPlan {
  /** The players to auction (unordered; the auction sorts them) */
  pool: Player[];
  /** The size the shortlist aims for (the pool is larger when the must-includes or the role cover need it) */
  target: number;
  /** Squad places the teams have open */
  openPlaces: number;
  /** Of the pool, how many were must-includes */
  mustIncluded: number;
  /** Players of each kind the teams still need, and how many of each the pool holds */
  needs: Record<PoolCategory, number>;
  counts: Record<PoolCategory, number>;
}

/** A bowler or all-rounder who spins (a batter's part-time spin doesn't fill a spinner's place) */
export function isFrontlineSpinner(p: Player): boolean {
  return p.role !== "batsman" && isSpinBowler(p.bowlingStyle);
}

/** A bowler or all-rounder who bowls pace */
export function isFrontlinePacer(p: Player): boolean {
  return p.role !== "batsman" && isPaceBowler(p.bowlingStyle);
}

function inCategory(p: Player, c: PoolCategory): boolean {
  switch (c) {
    case "keeper": return p.isWicketKeeper;
    case "spinner": return isFrontlineSpinner(p);
    case "pacer": return isFrontlinePacer(p);
    case "overseas": return p.isInternational;
    case "domestic": return !p.isInternational;
  }
}

/** What the teams still need, by kind, counting only the places each team has open */
export function auctionNeeds(teams: readonly Team[], maxSquadSize: number, maxOverseasInSquad: number): { openPlaces: number; needs: Record<PoolCategory, number> } {
  const needs: Record<PoolCategory, number> = { keeper: 0, spinner: 0, pacer: 0, overseas: 0, domestic: 0 };
  let openPlaces = 0;
  const spinnersWanted = Math.round(SPINNER_SHARE * maxSquadSize);
  const pacersWanted = Math.round(PACER_SHARE * maxSquadSize);
  for (const t of teams) {
    const open = Math.max(0, maxSquadSize - t.roster.length);
    if (open === 0) continue;
    openPlaces += open;
    let keepers = 0, spinners = 0, pacers = 0;
    for (const p of t.roster) {
      if (p.isWicketKeeper) keepers++;
      if (isFrontlineSpinner(p)) spinners++;
      if (isFrontlinePacer(p)) pacers++;
    }
    needs.keeper += Math.min(open, Math.max(0, KEEPERS_PER_SQUAD - keepers));
    needs.spinner += Math.min(open, Math.max(0, spinnersWanted - spinners));
    needs.pacer += Math.min(open, Math.max(0, pacersWanted - pacers));
    // overseas places the team can still fill; the rest of its open places have to go to domestic players
    const overseasOpen = Math.min(open, Math.max(0, maxOverseasInSquad - t.internationalCount));
    needs.overseas += overseasOpen;
    needs.domestic += open - overseasOpen;
  }
  return { openPlaces, needs };
}

/** The shortlist's target size for this league and auction */
export function auctionPoolTarget(type: AuctionType, teamCount: number, maxSquadSize: number, openPlaces: number): number {
  return Math.max(
    Math.round(POOL_PER_SQUAD_PLACE[type] * teamCount * maxSquadSize),
    Math.ceil(POOL_PER_OPEN_PLACE * openPlaces),
  );
}

/** Best first: market value, then overall, then id (so the same free agents always give the same pool) */
function byValue(a: Player, b: Player): number {
  return b.marketValue - a.marketValue || b.overall - a.overall || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Build the auction pool from the free agents: the must-includes, then the best of each kind the teams need until
 * the pool covers it, then the best by market value up to the target size.
 */
export function buildAuctionPool(freeAgents: readonly Player[], teams: readonly Team[], opts: AuctionPoolOptions): AuctionPoolPlan {
  const { openPlaces, needs } = auctionNeeds(teams, opts.maxSquadSize, opts.maxOverseasInSquad);
  const target = auctionPoolTarget(opts.type, teams.length, opts.maxSquadSize, openPlaces);
  const counts: Record<PoolCategory, number> = { keeper: 0, spinner: 0, pacer: 0, overseas: 0, domestic: 0 };
  const count = (pool: readonly Player[]) => {
    for (const c of CATEGORIES) counts[c] = pool.filter(p => inCategory(p, c)).length;
  };

  if (opts.deep || freeAgents.length <= target) {
    const pool = [...freeAgents];
    count(pool);
    const must = new Set(opts.mustInclude ?? []);
    return { pool, target, openPlaces, mustIncluded: pool.filter(p => must.has(p.id)).length, needs, counts };
  }

  const must = new Set(opts.mustInclude ?? []);
  const chosen = new Set<Player>();
  for (const p of freeAgents) if (must.has(p.id)) chosen.add(p);
  const mustIncluded = chosen.size;
  const candidates = freeAgents.filter(p => !chosen.has(p)).sort(byValue);

  const have: Record<PoolCategory, number> = { keeper: 0, spinner: 0, pacer: 0, overseas: 0, domestic: 0 };
  const add = (p: Player) => {
    chosen.add(p);
    for (const c of CATEGORIES) if (inCategory(p, c)) have[c]++;
  };
  for (const p of chosen) for (const c of CATEGORIES) if (inCategory(p, c)) have[c]++;

  // Cover each kind the teams need (the scarce kinds first, so a keeper who also bats doesn't crowd out a spinner)
  for (const c of CATEGORIES) {
    const wanted = Math.ceil(POOL_COVERAGE * needs[c]);
    for (const p of candidates) {
      if (have[c] >= wanted) break;
      if (!chosen.has(p) && inCategory(p, c)) add(p);
    }
  }
  // Then the preferred (re-registering unsold), best first, and the best of the rest, up to the target size
  const preferred = new Set(opts.preferred ?? []);
  for (const p of candidates) {
    if (chosen.size >= target) break;
    if (!chosen.has(p) && preferred.has(p.id)) add(p);
  }
  for (const p of candidates) {
    if (chosen.size >= target) break;
    if (!chosen.has(p)) add(p);
  }

  const pool = freeAgents.filter(p => chosen.has(p));
  count(pool);
  return { pool, target, openPlaces, mustIncluded, needs, counts };
}
