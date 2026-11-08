/**
 * IPL Auction simulation with realistic rules.
 *
 * Base price slabs: 2Cr, 1.5Cr, 1.25Cr, 1Cr, 75L, 50L, 40L, 30L
 * Bid increments:   5L (<1Cr), 10L (1-2Cr), 20L (2-5Cr), 25L (>5Cr)
 * Min squad: 18, Max squad: 25, Max overseas: 8
 * Retention: 6 max (5 capped + 2 uncapped), fixed cost slabs
 */

import { Player } from "./player.js";
import { Team } from "./team.js";
import { getContractLength } from "./contracts.js";
import type { RNG } from "./rng.js";

// ── Base price & bid increment utilities ────────────────────────────────

/** Real IPL base price slabs in crores */
const BASE_PRICE_SLABS = [2.0, 1.5, 1.25, 1.0, 0.75, 0.5, 0.4, 0.3];

/** Derive a player's base price slab from their overall rating */
export function getBasePrice(player: Player): number {
  const ovr = player.overall;
  if (ovr >= 88) return 2.0;
  if (ovr >= 82) return 1.5;
  if (ovr >= 76) return 1.25;
  if (ovr >= 70) return 1.0;
  if (ovr >= 62) return 0.75;
  if (ovr >= 52) return 0.5;
  if (ovr >= 42) return 0.4;
  return 0.3; // minimum base price (30 lakh)
}

/** Get the next bid increment based on current bid (in crores).
 *  Real IPL: 5L (<1Cr), 10L (1-2Cr), 20L (2-5Cr), 25L (>5Cr) */
export function getBidIncrement(currentBid: number): number {
  if (currentBid < 1.0) return 0.05;  // 5 lakh
  if (currentBid < 2.0) return 0.10;  // 10 lakh
  if (currentBid < 5.0) return 0.20;  // 20 lakh
  return 0.25;                         // 25 lakh
}

// ── Keeper need ─────────────────────────────────────────────────────────

/** Bid-probability multiplier for a team with no wicketkeeper bidding on one (a keeper is not optional) */
const KEEPER_NEED_BID_BOOST = 1.7;
/** Such a team also values a keeper this much above his market value */
const KEEPER_NEED_VALUE_BOOST = 1.2;

export function keeperCount(team: Team): number {
  let n = 0;
  for (const p of team.roster) if (p.isWicketKeeper) n++;
  return n;
}

export function countKeepers(players: readonly Player[], from = 0): number {
  let n = 0;
  for (let i = from; i < players.length; i++) if (players[i].isWicketKeeper) n++;
  return n;
}

/**
 * Teams that still have no wicketkeeper and room for one. When the keepers left in the pool are about to run out
 * (`keepersLeft` at most the number of such teams) the others sit out the bidding for a keeper, so every team can
 * still get one.
 */
export function keeperNeed(teams: readonly Team[], keepersLeft: number, maxRosterSize: number): { needy: Set<string>; reserved: boolean } {
  const needy = new Set<string>();
  for (const t of teams) if (t.roster.length < maxRosterSize && keeperCount(t) === 0) needy.add(t.id);
  return { needy, reserved: needy.size > 0 && keepersLeft <= needy.size };
}

// ── Types ───────────────────────────────────────────────────────────────

export interface AuctionConfig {
  maxRosterSize: number;      // default 25
  maxInternational: number;   // default 8
  minSquadSize: number;       // default 18
  /** The squad teams complete at the end of the auction when their purse allows (default: halfway between min and max) */
  targetSquadSize?: number;
}

export interface AuctionBid {
  playerId: string;
  playerName: string;
  teamId: string;
  amount: number;
  round: number;
}

export interface AuctionResult {
  bids: AuctionBid[];
  unsold: Player[];
}

export interface RetentionCost {
  player: Player;
  cost: number;
  slot: number;
  isCapped: boolean;
}

export interface RetentionPlan {
  valid: boolean;
  reason?: string;
  retentionCosts: RetentionCost[];
  totalCost: number;
  remainingBudget: number;
  cappedCount: number;
  uncappedCount: number;
}

const DEFAULT_CONFIG: AuctionConfig = {
  maxRosterSize: 25,
  maxInternational: 8,
  minSquadSize: 18,
};

/** The cheapest base price: what a fill signing at the end of an auction costs at least */
const MIN_FILL_PRICE = 0.3;

function assignAuctionContract(player: Player): void {
  if (player.contractYears <= 0) {
    player.contractYears = getContractLength("auction");
  }
}

export const RETENTION_BUDGET = 75;
export const MAX_RETENTIONS = 6;
export const MAX_CAPPED_RETENTIONS = 5;
export const MAX_UNCAPPED_RETENTIONS = 2;

/** IPL 2025 retention cost slabs (in crores).
 *  Slots 1-5 are for capped players, slot 6 must be uncapped. */
const CAPPED_RETENTION_COSTS = [18, 14, 11, 18, 14];
const UNCAPPED_RETENTION_COST = 4;
const CAPPED_RETENTION_THRESHOLD = 60;

export interface RetentionEvaluation {
  valid: boolean;
  errors: string[];
  retentionCosts: RetentionCost[];
  totalCost: number;
  remainingBudget: number;
  cappedCount: number;
  uncappedCount: number;
}

/** The purse the IPL's retention slabs and budget belong to (2025: 120 Cr) */
export const IPL_RETENTION_PURSE = 120;

/**
 * Retention prices for a league: the IPL's slabs and budget scale with a smaller purse (the WPL's 12 Cr retains on
 * a tenth of the IPL's prices; its real 2026 slabs, 3.5 / 2.5 / 1.75 / 1 Cr of 15, are the same share of the purse).
 * The IPL itself (and any purse of 120 Cr or more) keeps the slabs as they are.
 */
export function retentionCostScale(salaryCap: number, league?: string): number {
  if (league === "ipl") return 1;
  return Math.min(1, Math.max(0.05, salaryCap / IPL_RETENTION_PURSE));
}

const roundCost = (c: number) => Math.round(c * 100) / 100;

export function isCappedRetentionPlayer(player: Player): boolean {
  return player.isInternational || player.overall >= CAPPED_RETENTION_THRESHOLD;
}

export function evaluateRetentionSelection(
  players: Player[],
  retentionBudget: number = RETENTION_BUDGET,
  maxRetentions: number = MAX_RETENTIONS,
  /** Multiplies the slab costs (retentionCostScale; the budget is passed already scaled) */
  costScale = 1,
): RetentionEvaluation {
  const errors: string[] = [];
  const retentionCosts: RetentionCost[] = [];
  const sorted = [...players].sort((a, b) => b.overall - a.overall);
  let totalCost = 0;
  let cappedCount = 0;
  let uncappedCount = 0;

  if (sorted.length > maxRetentions) {
    errors.push(`Can only retain ${maxRetentions} players.`);
  }

  for (const player of sorted) {
    const isCapped = isCappedRetentionPlayer(player);

    if (isCapped) {
      if (cappedCount >= MAX_CAPPED_RETENTIONS) {
        errors.push("Can only retain 5 capped players.");
        break;
      }
      const cost = roundCost(CAPPED_RETENTION_COSTS[cappedCount] * costScale);
      totalCost += cost;
      retentionCosts.push({ player, cost, slot: cappedCount + 1, isCapped: true });
      cappedCount++;
      continue;
    }

    if (uncappedCount >= MAX_UNCAPPED_RETENTIONS) {
      errors.push("Can only retain 2 uncapped players.");
      break;
    }
    const uncappedCost = roundCost(UNCAPPED_RETENTION_COST * costScale);
    totalCost += uncappedCost;
    retentionCosts.push({
      player,
      cost: uncappedCost,
      slot: uncappedCount + 1,
      isCapped: false,
    });
    uncappedCount++;
  }

  if (totalCost > retentionBudget + 1e-9) {
    errors.push(`Retention plan exceeds the ${retentionBudget} Cr budget.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    retentionCosts,
    totalCost: Math.round(totalCost * 100) / 100,
    remainingBudget: Math.round((retentionBudget - totalCost) * 100) / 100,
    cappedCount,
    uncappedCount,
  };
}

// ── Completing the squads ───────────────────────────────────────────────

/**
 * The squad a team completes at the end of an auction when its purse allows: `targetSquadSize`, else halfway between
 * the minimum and the maximum (IPL 18-25: 22; BBL 16-20: 18; The Hundred 14-16: 15). Real IPL squads end at 22-25.
 */
export function squadTarget(config: AuctionConfig): number {
  const min = Math.min(config.minSquadSize, config.maxRosterSize);
  const target = config.targetSquadSize ?? Math.round((min + config.maxRosterSize) / 2);
  return Math.max(min, Math.min(config.maxRosterSize, target));
}

/**
 * A CPU bid of `amount` leaves the team 30 lakh (the last accelerated round's price) for each place it still has to
 * fill to its target squad, so the purse can always complete the squad (and the minimum, which the target includes).
 */
export function keepsSquadReserve(team: Team, amount: number, config: AuctionConfig): boolean {
  const placesAfter = Math.max(0, squadTarget(config) - team.roster.length - 1);
  return team.remainingBudget - amount >= MIN_FILL_PRICE * placesAfter - 1e-9;
}

/**
 * After the last player: every team gets two wicketkeepers if the unsold have them (an injury backup), a team still
 * without one takes one from a team with a spare (releasing its cheapest non-keeper if it must), and every squad is
 * filled from the unsold to the minimum and then, while the purse allows, to its target (`squadTarget`), round-robin
 * so no team is starved of domestic depth. These are the accelerated rounds: a fill signing costs the player's base
 * price, reduced (to 30 lakh at the lowest, the last round's price) when the team must keep 30 lakh for each other
 * place still to fill, so a purse the bidding left able to complete the squad stays positive. `unsold` and `bids`
 * are updated in place. Both the automated and the live auction end here.
 */
export function completeSquads(teams: Team[], unsold: Player[], bids: AuctionBid[], config: Partial<AuctionConfig> = {}): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const minSquad = Math.min(cfg.minSquadSize, cfg.maxRosterSize);
  const target = squadTarget(cfg);
  const sign = (team: Team, player: Player, price: number) => {
    unsold.splice(unsold.indexOf(player), 1);
    team.addPlayer(player, price);
    assignAuctionContract(player);
    bids.push({ playerId: player.id, playerName: player.name, teamId: team.id, amount: price, round: 0 });
  };
  /** What a team can pay for one more player and still fill its other places to the target at 30 lakh */
  const spendable = (team: Team) => team.remainingBudget - MIN_FILL_PRICE * Math.max(0, target - team.roster.length - 1);
  /** An accelerated-round price: the base price, or what the team can spare, but not below the last round's 30 lakh */
  const fillPrice = (team: Team, p: Player) =>
    Math.max(MIN_FILL_PRICE, Math.min(getBasePrice(p), Math.floor(spendable(team) * 20) / 20));

  // Every team gets two keepers when the unsold have them (injury backup). Teams with none go first.
  for (const team of [...teams].sort((a, b) => keeperCount(a) - keeperCount(b))) {
    let wkCount = keeperCount(team);
    while (wkCount < 2 && team.roster.length < cfg.maxRosterSize) {
      const wk = unsold.find(p =>
        p.isWicketKeeper &&
        (!p.isInternational || team.internationalCount < cfg.maxInternational) &&
        (wkCount === 0 || getBasePrice(p) <= spendable(team))
      );
      if (!wk) break;
      sign(team, wk, wkCount === 0 ? fillPrice(team, wk) : getBasePrice(wk));
      wkCount++;
    }
  }

  // A team that still has no keeper (the pool ran dry, or the keepers left are overseas and its overseas places are full)
  // takes one from a team with a spare, or from the unsold, making room by releasing its cheapest non-keeper if it must
  for (const team of teams) {
    if (keeperCount(team) > 0) continue;
    type Source = { player: Player; from?: Team; price: number };
    const sources: Source[] = [
      ...unsold.filter(p => p.isWicketKeeper).map(p => ({ player: p, price: getBasePrice(p) })),
      ...teams.filter(t => t !== team && keeperCount(t) >= 2)
        .flatMap(t => t.roster.filter(p => p.isWicketKeeper).map(p => ({ player: p, from: t, price: p.bid }))),
    ].sort((a, b) => (a.player.isInternational ? 1 : 0) - (b.player.isInternational ? 1 : 0) || a.price - b.price);
    for (const src of sources) {
      let budget = team.remainingBudget;
      let intl = team.internationalCount;
      let size = team.roster.length;
      // players to release so that the keeper fits: the lowest-valued non-keepers, overseas ones first when the overseas places are full
      const release: Player[] = [];
      const candidates = [...team.roster].filter(p => !p.isWicketKeeper).sort((a, b) => a.marketValue - b.marketValue);
      const fits = () => size < cfg.maxRosterSize && budget >= src.price && (!src.player.isInternational || intl < cfg.maxInternational);
      while (!fits() && candidates.length > 0) {
        const needIntl = src.player.isInternational && intl >= cfg.maxInternational;
        const idx = candidates.findIndex(p => !needIntl || p.isInternational);
        if (idx === -1) break;
        const [out] = candidates.splice(idx, 1);
        release.push(out); budget += out.bid; size--; if (out.isInternational) intl--;
      }
      if (!fits()) continue;
      for (const out of release) {
        team.removePlayer(out.id);
        out.teamId = undefined; out.bid = 0;
        const bi = bids.findIndex(b => b.playerId === out.id);
        if (bi !== -1) bids.splice(bi, 1);
        unsold.push(out);
      }
      if (src.from) {
        const moved = src.from.removePlayer(src.player.id);
        if (!moved) continue;
        team.addPlayer(moved, moved.bid);
        const bi = bids.findIndex(b => b.playerId === moved.id);
        if (bi !== -1) bids[bi] = { ...bids[bi], teamId: team.id };
      } else {
        sign(team, src.player, Math.min(src.price, fillPrice(team, src.player)));
      }
      break;
    }
  }

  // Fill from the unsold, round-robin (fewest players first): to the minimum, then to the target while the purse has
  // 30 lakh to spare; the best player left (a domestic one when the team has as many overseas as domestic players), at
  // an accelerated-round price
  while (unsold.length > 0) {
    const teamsNeedingPlayers = teams
      .filter(team => team.roster.length < minSquad || (team.roster.length < target && spendable(team) >= MIN_FILL_PRICE - 1e-9))
      .sort((a, b) => {
        const rosterDiff = a.roster.length - b.roster.length;
        if (rosterDiff !== 0) return rosterDiff;
        return a.domesticCount - b.domesticCount;
      });

    if (teamsNeedingPlayers.length === 0) break;

    let addedAny = false;
    for (const team of teamsNeedingPlayers) {
      const allowed = (p: Player) => !p.isInternational || team.internationalCount < cfg.maxInternational;
      const preferDomestic = team.domesticCount <= team.internationalCount;
      const pick = (preferDomestic ? unsold.find(p => !p.isInternational) : undefined) ?? unsold.find(allowed);
      if (!pick) continue;
      sign(team, pick, fillPrice(team, pick));
      addedAny = true;
    }

    if (!addedAny) break;
  }
}

// ── Full automated auction ──────────────────────────────────────────────

/** Run a full automated auction */
export function runAuction(
  players: Player[],
  teams: Team[],
  config: Partial<AuctionConfig> = {},
  rng: RNG = Math.random,
): AuctionResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const bids: AuctionBid[] = [];
  const unsold: Player[] = [];

  // Sort players by market value (highest first)
  const sortedPlayers = [...players].sort((a, b) => b.marketValue - a.marketValue);
  let keepersLeft = countKeepers(sortedPlayers);

  for (const player of sortedPlayers) {
    const need = keeperNeed(teams, keepersLeft, cfg.maxRosterSize);
    if (player.isWicketKeeper) keepersLeft--;
    const result = auctionPlayer(player, teams, cfg, bids.length, rng, need);
    if (result) {
      bids.push(result);
    } else {
      unsold.push(player);
    }
  }

  completeSquads(teams, unsold, bids, cfg);

  return { bids, unsold };
}

/** Auction a single player: CPU teams bid against each other */
function auctionPlayer(
  player: Player,
  teams: Team[],
  config: AuctionConfig,
  playerIndex: number,
  rng: RNG = Math.random,
  need?: { needy: Set<string>; reserved: boolean },
): AuctionBid | null {
  const basePrice = getBasePrice(player);
  const value = Math.max(player.marketValue, basePrice);

  // Filter eligible teams
  let eligible = teams.filter(t => {
    if (t.roster.length >= config.maxRosterSize) return false;
    if (player.isInternational && t.internationalCount >= config.maxInternational) return false;
    if (t.remainingBudget < basePrice) return false;
    // If team is nearly full and still needs WKs, only allow bidding on WKs
    const slotsLeft = config.maxRosterSize - t.roster.length;
    const wkCount = t.roster.filter(p => p.isWicketKeeper).length;
    if (wkCount < 2 && slotsLeft <= (2 - wkCount) && !player.isWicketKeeper) return false;
    return true;
  });
  // The last keepers in the pool are kept for the teams that have none
  if (need?.reserved && player.isWicketKeeper) {
    const needyOnly = eligible.filter(t => need.needy.has(t.id));
    if (needyOnly.length > 0) eligible = needyOnly;
  }

  if (eligible.length === 0) return null;

  let currentBid = basePrice;
  let currentBidder: Team | null = null;
  let round = 0;

  // Bidding rounds
  while (round < 50) { // safety limit
    round++;
    let anyBid = false;

    for (const team of eligible) {
      if (team === currentBidder) continue;
      const increment = getBidIncrement(currentBid);
      if (team.remainingBudget < currentBid + increment) continue;
      if (team.roster.length >= config.maxRosterSize) continue;
      if (!keepsSquadReserve(team, currentBid + increment, config)) continue;

      // Squad need: a team with no wicketkeeper wants one and will pay over the odds
      const wantsKeeper = player.isWicketKeeper && need?.needy.has(team.id) === true;
      const teamValue = wantsKeeper ? value * KEEPER_NEED_VALUE_BOOST : value;

      // CPU bidding probability
      const valueRatio = currentBid / (teamValue + 0.1);
      const positionFactor = 1 - 0.1 * (playerIndex / 100);
      let bidProb = Math.max(0, 1 - valueRatio) * positionFactor;

      // Age adjustment: prefer younger players
      if (player.age < 25) bidProb *= 1.2;
      if (player.age > 34) bidProb *= 0.7;

      // Domestic player boost (Indian players more sought after)
      if (!player.isInternational) bidProb *= 1.15;

      // Team need: if team has few players, more aggressive
      if (team.roster.length < 12) bidProb *= 1.3;

      if (wantsKeeper) bidProb *= KEEPER_NEED_BID_BOOST;

      // Don't overbid dramatically
      if (currentBid > teamValue * 1.25) bidProb *= 0.55;
      if (currentBid > teamValue * 1.5) bidProb *= 0.25;

      // Budget discipline: save money for remaining squad slots
      const slotsNeeded = Math.max(0, config.minSquadSize - team.roster.length);
      const reserveBudget = slotsNeeded * 0.3; // 30L per remaining slot
      if (team.remainingBudget - currentBid < reserveBudget) bidProb *= 0.1;

      // Hard cap: never bid more than 30% of salary cap on one player
      if (currentBid > team.salaryCap * 0.3) bidProb *= 0.05;

      if (rng() < bidProb) {
        currentBid += increment;
        currentBid = Math.round(currentBid * 100) / 100; // round to lakh precision
        currentBidder = team;
        anyBid = true;
      }
    }

    if (!anyBid) break;
  }

  if (currentBidder) {
    currentBidder.addPlayer(player, currentBid);
    assignAuctionContract(player);
    return {
      playerId: player.id,
      playerName: player.name,
      teamId: currentBidder.id,
      amount: currentBid,
      round,
    };
  }

  return null;
}

// ── Step-by-step auction system ─────────────────────────────────────────

export interface AuctionState {
  players: Player[];          // remaining players to auction (sorted by value)
  currentPlayerIndex: number;
  currentBid: number;
  currentBidderId: string | null;  // team ID of current highest bidder
  biddingTeams: string[];     // team IDs still in the bidding
  round: number;
  completedBids: AuctionBid[];
  unsold: Player[];
  phase: "bidding" | "sold" | "unsold" | "complete" | "rtm";
  // RTM (Right to Match): former team can match the winning bid
  rtmTeamId?: string;         // team that holds RTM for current player
  rtmEligible?: boolean;      // whether RTM is available for this player
  /** Map of playerId → former teamId for RTM tracking */
  rtmMap?: Record<string, string>;
  /** Wicketkeepers among the remaining players, the current one included (drives the keeper-need logic) */
  keepersLeft?: number;
}

/** Initialize a step-by-step auction */
export function initAuction(
  players: Player[],
  teams: Team[],
  config: Partial<AuctionConfig> = {},
): AuctionState {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sorted = [...players].sort((a, b) => b.marketValue - a.marketValue);
  const firstPlayer = sorted[0];
  const firstBasePrice = firstPlayer ? getBasePrice(firstPlayer) : 0.3;

  const eligible = teams
    .filter(t => t.roster.length < cfg.maxRosterSize && t.remainingBudget >= firstBasePrice)
    .map(t => t.id);

  return {
    players: sorted,
    currentPlayerIndex: 0,
    currentBid: firstBasePrice,
    currentBidderId: null,
    biddingTeams: eligible,
    round: 0,
    completedBids: [],
    unsold: [],
    phase: sorted.length > 0 ? "bidding" : "complete",
    keepersLeft: countKeepers(sorted),
  };
}

/** User places a bid on the current player */
export function userBid(
  state: AuctionState,
  teams: Team[],
  userTeamId: string,
): AuctionState {
  if (state.phase !== "bidding") return state;
  const team = teams.find(t => t.id === userTeamId);
  if (!team) return state;

  const increment = getBidIncrement(state.currentBid);
  const newBid = Math.round((state.currentBid + increment) * 100) / 100;
  if (team.remainingBudget < newBid) return state;

  return {
    ...state,
    currentBid: newBid,
    currentBidderId: userTeamId,
    round: state.round + 1,
  };
}

/** User drops out of bidding for the current player */
export function userDropBid(
  state: AuctionState,
  userTeamId: string,
): AuctionState {
  if (state.phase !== "bidding") return state;
  return {
    ...state,
    biddingTeams: state.biddingTeams.filter(id => id !== userTeamId),
  };
}

/** Run ONE round of CPU bidding for the current player */
export function cpuBidRound(
  state: AuctionState,
  teams: Team[],
  config: Partial<AuctionConfig> = {},
  rng: RNG = Math.random,
): AuctionState {
  if (state.phase !== "bidding") return state;

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const player = state.players[state.currentPlayerIndex];
  if (!player) return { ...state, phase: "complete" };

  const value = Math.max(player.marketValue, getBasePrice(player));
  let currentBid = state.currentBid;
  let currentBidderId = state.currentBidderId;
  let anyBid = false;
  const round = state.round + 1;

  const activeBidders = [...state.biddingTeams];
  const need = player.isWicketKeeper
    ? keeperNeed(teams, state.keepersLeft ?? countKeepers(state.players, state.currentPlayerIndex), cfg.maxRosterSize)
    : undefined;
  // The last keepers in the pool are kept for the teams that have none
  const reservedTo = need?.reserved && activeBidders.some(id => need.needy.has(id)) ? need.needy : undefined;

  for (const teamId of activeBidders) {
    if (teamId === currentBidderId) continue; // skip current highest bidder
    const team = teams.find(t => t.id === teamId);
    if (!team) continue;
    const increment = getBidIncrement(currentBid);
    if (team.remainingBudget < currentBid + increment) continue;
    if (team.roster.length >= cfg.maxRosterSize) continue;
    if (player.isInternational && team.internationalCount >= cfg.maxInternational) continue;
    if (reservedTo && !reservedTo.has(teamId)) continue;
    if (!keepsSquadReserve(team, currentBid + increment, cfg)) continue;

    // Squad need: a team with no wicketkeeper wants one and will pay over the odds
    const wantsKeeper = need?.needy.has(teamId) === true;
    const teamValue = wantsKeeper ? value * KEEPER_NEED_VALUE_BOOST : value;

    // CPU bidding probability (same logic as full auction)
    const valueRatio = currentBid / (teamValue + 0.1);
    const positionFactor = 1 - 0.1 * (state.currentPlayerIndex / 100);
    let bidProb = Math.max(0, 1 - valueRatio) * positionFactor;

    if (player.age < 25) bidProb *= 1.2;
    if (player.age > 34) bidProb *= 0.7;
    if (!player.isInternational) bidProb *= 1.15;
    if (team.roster.length < 12) bidProb *= 1.3;
    if (wantsKeeper) bidProb *= KEEPER_NEED_BID_BOOST;
    if (currentBid > teamValue * 1.25) bidProb *= 0.55;
    if (currentBid > teamValue * 1.5) bidProb *= 0.25;

    // Budget discipline: save money for remaining squad slots
    const slotsNeeded = Math.max(0, (cfg.minSquadSize || 18) - team.roster.length);
    const reserveBudget = slotsNeeded * 0.3;
    if (team.remainingBudget - currentBid < reserveBudget) bidProb *= 0.1;
    if (currentBid > team.salaryCap * 0.3) bidProb *= 0.05;

    if (rng() < bidProb) {
      currentBid = Math.round((currentBid + increment) * 100) / 100;
      currentBidderId = teamId;
      anyBid = true;
    }
  }

  // If no one bid this round, resolve the player
  if (!anyBid) {
    if (currentBidderId) {
      // Check RTM: if former team is not the winner and has RTM rights
      const rtmMap = state.rtmMap ?? {};
      const formerTeamId = rtmMap[player.id];
      const formerTeam = formerTeamId ? teams.find(t => t.id === formerTeamId) : undefined;
      const rtmAvailable = formerTeam
        && formerTeamId !== currentBidderId
        && formerTeam.roster.length < cfg.maxRosterSize
        && formerTeam.remainingBudget >= currentBid
        && (!player.isInternational || formerTeam.internationalCount < cfg.maxInternational);

      if (rtmAvailable) {
        // Enter RTM phase — former team gets chance to match
        return {
          ...state,
          currentBid,
          currentBidderId,
          round,
          phase: "rtm",
          rtmTeamId: formerTeamId,
          rtmEligible: true,
        };
      }

      // No RTM — SOLD directly
      const winningTeam = teams.find(t => t.id === currentBidderId);
      if (winningTeam) {
        winningTeam.addPlayer(player, currentBid);
        assignAuctionContract(player);
      }
      const bid: AuctionBid = {
        playerId: player.id,
        playerName: player.name,
        teamId: currentBidderId,
        amount: currentBid,
        round,
      };
      return {
        ...state,
        currentBid,
        currentBidderId,
        round,
        completedBids: [...state.completedBids, bid],
        phase: "sold",
      };
    } else {
      // UNSOLD
      return {
        ...state,
        round,
        unsold: [...state.unsold, player],
        phase: "unsold",
      };
    }
  }

  return {
    ...state,
    currentBid,
    currentBidderId,
    round,
  };
}

/** Move to the next player after sold/unsold */
export function nextPlayer(
  state: AuctionState,
  teams: Team[],
  config: Partial<AuctionConfig> = {},
): AuctionState {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const nextIndex = state.currentPlayerIndex + 1;
  if (nextIndex >= state.players.length) {
    // The last player has gone: complete the squads (keepers, the minimum squad) from the unsold, as runAuction does
    const unsold = [...state.unsold];
    const completedBids = [...state.completedBids];
    completeSquads(teams, unsold, completedBids, cfg);
    return { ...state, unsold, completedBids, phase: "complete" };
  }

  const nextP = state.players[nextIndex];
  const basePrice = nextP ? getBasePrice(nextP) : 0.3;

  const eligible = teams
    .filter(t => t.roster.length < cfg.maxRosterSize && t.remainingBudget >= basePrice)
    .map(t => t.id);

  const wasKeeper = state.players[state.currentPlayerIndex]?.isWicketKeeper ? 1 : 0;
  return {
    ...state,
    currentPlayerIndex: nextIndex,
    currentBid: basePrice,
    currentBidderId: null,
    biddingTeams: eligible,
    round: 0,
    phase: "bidding",
    keepersLeft: Math.max(0, (state.keepersLeft ?? countKeepers(state.players, state.currentPlayerIndex)) - wasKeeper),
  };
}

/** RTM: former team matches the winning bid — player goes to former team */
export function rtmAccept(state: AuctionState, teams: Team[]): AuctionState {
  if (state.phase !== "rtm" || !state.rtmTeamId) return state;
  const player = state.players[state.currentPlayerIndex];
  const rtmTeam = teams.find(t => t.id === state.rtmTeamId);
  if (rtmTeam && player) {
    rtmTeam.addPlayer(player, state.currentBid);
    assignAuctionContract(player);
  }
  const bid: AuctionBid = {
    playerId: player.id,
    playerName: player.name,
    teamId: state.rtmTeamId,
    amount: state.currentBid,
    round: state.round,
  };
  return {
    ...state,
    completedBids: [...state.completedBids, bid],
    phase: "sold",
    rtmTeamId: undefined,
    rtmEligible: false,
  };
}

/** RTM: former team declines — player goes to the original highest bidder */
export function rtmDecline(state: AuctionState, teams: Team[]): AuctionState {
  if (state.phase !== "rtm" || !state.currentBidderId) return state;
  const player = state.players[state.currentPlayerIndex];
  const winningTeam = teams.find(t => t.id === state.currentBidderId);
  if (winningTeam && player) {
    winningTeam.addPlayer(player, state.currentBid);
    assignAuctionContract(player);
  }
  const bid: AuctionBid = {
    playerId: player.id,
    playerName: player.name,
    teamId: state.currentBidderId,
    amount: state.currentBid,
    round: state.round,
  };
  return {
    ...state,
    completedBids: [...state.completedBids, bid],
    phase: "sold",
    rtmTeamId: undefined,
    rtmEligible: false,
  };
}

/** Simulate the current player's auction to completion (including RTM) */
export function simCurrentPlayer(
  state: AuctionState,
  teams: Team[],
  config: Partial<AuctionConfig> = {},
): AuctionState {
  let current = state;
  let safety = 0;
  while (current.phase === "bidding" && safety < 100) {
    current = cpuBidRound(current, teams, config);
    safety++;
  }
  // Auto-resolve RTM for CPU teams (~60% chance CPU matches if affordable)
  if (current.phase === "rtm" && current.rtmTeamId) {
    const rtmTeam = teams.find(t => t.id === current.rtmTeamId);
    const player = current.players[current.currentPlayerIndex];
    // CPU decides based on player value vs cost
    const shouldMatch = rtmTeam && player
      && player.overall >= 70
      && current.currentBid <= player.marketValue * 1.3
      && Math.random() < 0.6;
    current = shouldMatch ? rtmAccept(current, teams) : rtmDecline(current, teams);
  }
  return current;
}

/** Simulate all remaining players to completion */
export function simRemainingAuction(
  state: AuctionState,
  teams: Team[],
  config: Partial<AuctionConfig> = {},
): AuctionState {
  let current = state;
  let safety = 0;
  while (current.phase !== "complete" && safety < 10000) {
    if (current.phase === "bidding") {
      current = simCurrentPlayer(current, teams, config);
    } else if (current.phase === "rtm") {
      // Auto-resolve RTM (handled inside simCurrentPlayer, but catch standalone)
      current = rtmDecline(current, teams);
    } else {
      // sold or unsold — move to next
      current = nextPlayer(current, teams, config);
    }
    safety++;
  }
  return current;
}

// ── Retention ───────────────────────────────────────────────────────────

/** Simulate player retention between seasons using real IPL cost slabs.
 *  Max 6 retentions: up to 5 capped + up to 2 uncapped. */
export function retainPlayers(
  team: Team,
  retentionBudget: number = RETENTION_BUDGET,
  maxRetentions: number = MAX_RETENTIONS,
  costScale = 1,
): { retained: Player[]; released: Player[]; retentionCosts: { player: Player; cost: number }[] } {
  const sorted = [...team.roster].sort((a, b) => b.valueOverall - a.valueOverall);
  const retained: Player[] = [];
  const released: Player[] = [];

  for (const player of sorted) {
    const evaluation = evaluateRetentionSelection([...retained, player], retentionBudget, maxRetentions, costScale);
    if (!evaluation.valid) {
      released.push(player);
      continue;
    }
    retained.push(player);
  }

  const evaluation = evaluateRetentionSelection(retained, retentionBudget, maxRetentions, costScale);
  const costByPlayerId = new Map(evaluation.retentionCosts.map(entry => [entry.player.id, entry.cost]));

  // Update team roster
  team.roster = retained;
  team.totalSpent = evaluation.totalCost;

  for (const player of retained) {
    player.teamId = team.id;
    player.bid = costByPlayerId.get(player.id) ?? 0;
  }

  for (const p of released) {
    p.teamId = undefined;
    p.bid = 0;
  }

  return {
    retained,
    released,
    retentionCosts: evaluation.retentionCosts.map(({ player, cost }) => ({ player, cost })),
  };
}
