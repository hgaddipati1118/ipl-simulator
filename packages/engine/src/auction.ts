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

// ── Types ───────────────────────────────────────────────────────────────

export interface AuctionConfig {
  maxRosterSize: number;      // default 25
  maxInternational: number;   // default 8
  minSquadSize: number;       // default 18
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

export function isCappedRetentionPlayer(player: Player): boolean {
  return player.isInternational || player.overall >= CAPPED_RETENTION_THRESHOLD;
}

export function evaluateRetentionSelection(
  players: Player[],
  retentionBudget: number = RETENTION_BUDGET,
  maxRetentions: number = MAX_RETENTIONS,
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
      const cost = CAPPED_RETENTION_COSTS[cappedCount];
      totalCost += cost;
      retentionCosts.push({ player, cost, slot: cappedCount + 1, isCapped: true });
      cappedCount++;
      continue;
    }

    if (uncappedCount >= MAX_UNCAPPED_RETENTIONS) {
      errors.push("Can only retain 2 uncapped players.");
      break;
    }
    totalCost += UNCAPPED_RETENTION_COST;
    retentionCosts.push({
      player,
      cost: UNCAPPED_RETENTION_COST,
      slot: uncappedCount + 1,
      isCapped: false,
    });
    uncappedCount++;
  }

  if (totalCost > retentionBudget) {
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

// ── Full automated auction ──────────────────────────────────────────────

/** Run a full automated auction */
export function runAuction(
  players: Player[],
  teams: Team[],
  config: Partial<AuctionConfig> = {},
): AuctionResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const bids: AuctionBid[] = [];
  const unsold: Player[] = [];

  // Sort players by market value (highest first)
  const sortedPlayers = [...players].sort((a, b) => b.marketValue - a.marketValue);

  for (const player of sortedPlayers) {
    const result = auctionPlayer(player, teams, cfg, bids.length);
    if (result) {
      bids.push(result);
    } else {
      unsold.push(player);
    }
  }

  // Ensure every team has at least 2 WKs (injury backup) before filling remaining spots
  for (const team of teams) {
    let wkCount = team.roster.filter(p => p.isWicketKeeper).length;
    while (wkCount < 2 && team.roster.length < cfg.maxRosterSize) {
      const wkIdx = unsold.findIndex(p =>
        p.isWicketKeeper &&
        (!p.isInternational || team.internationalCount < cfg.maxInternational)
      );
      if (wkIdx === -1) break;
      const [wk] = unsold.splice(wkIdx, 1);
      team.addPlayer(wk, getBasePrice(wk));
      bids.push({ playerId: wk.id, playerName: wk.name, teamId: team.id, amount: getBasePrice(wk), round: 0 });
      wkCount++;
    }
  }

  // Fill up teams that have fewer than minSquadSize players with unsold players at base price
  for (const team of teams) {
    while (team.roster.length < cfg.minSquadSize && unsold.length > 0) {
      const idx = unsold.findIndex(p =>
        !p.isInternational || team.internationalCount < cfg.maxInternational
      );
      if (idx === -1) break;
      const [freeAgent] = unsold.splice(idx, 1);
      const bid = getBasePrice(freeAgent);
      team.addPlayer(freeAgent, bid);
      bids.push({
        playerId: freeAgent.id,
        playerName: freeAgent.name,
        teamId: team.id,
        amount: bid,
        round: 0,
      });
    }
  }

  return { bids, unsold };
}

/** Auction a single player: CPU teams bid against each other */
function auctionPlayer(
  player: Player,
  teams: Team[],
  config: AuctionConfig,
  playerIndex: number,
): AuctionBid | null {
  const basePrice = getBasePrice(player);
  const value = Math.max(player.marketValue, basePrice);

  // Filter eligible teams
  const eligible = teams.filter(t => {
    if (t.roster.length >= config.maxRosterSize) return false;
    if (player.isInternational && t.internationalCount >= config.maxInternational) return false;
    if (t.remainingBudget < basePrice) return false;
    // If team is nearly full and still needs WKs, only allow bidding on WKs
    const slotsLeft = config.maxRosterSize - t.roster.length;
    const wkCount = t.roster.filter(p => p.isWicketKeeper).length;
    if (wkCount < 2 && slotsLeft <= (2 - wkCount) && !player.isWicketKeeper) return false;
    return true;
  });

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

      // CPU bidding probability
      const valueRatio = currentBid / (value + 0.1);
      const positionFactor = 1 - 0.1 * (playerIndex / 100);
      let bidProb = Math.max(0, 1 - valueRatio) * positionFactor;

      // Age adjustment: prefer younger players
      if (player.age < 25) bidProb *= 1.2;
      if (player.age > 34) bidProb *= 0.7;

      // Domestic player boost (Indian players more sought after)
      if (!player.isInternational) bidProb *= 1.15;

      // Team need: if team has few players, more aggressive
      if (team.roster.length < 12) bidProb *= 1.3;

      // Don't overbid dramatically
      if (currentBid > value * 1.25) bidProb *= 0.55;
      if (currentBid > value * 1.5) bidProb *= 0.25;

      // Budget discipline: save money for remaining squad slots
      const slotsNeeded = Math.max(0, config.minSquadSize - team.roster.length);
      const reserveBudget = slotsNeeded * 0.3; // 30L per remaining slot
      if (team.remainingBudget - currentBid < reserveBudget) bidProb *= 0.1;

      // Hard cap: never bid more than 30% of salary cap on one player
      if (currentBid > team.salaryCap * 0.3) bidProb *= 0.05;

      if (Math.random() < bidProb) {
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
  phase: "bidding" | "sold" | "unsold" | "complete";
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

  for (const teamId of activeBidders) {
    if (teamId === currentBidderId) continue; // skip current highest bidder
    const team = teams.find(t => t.id === teamId);
    if (!team) continue;
    const increment = getBidIncrement(currentBid);
    if (team.remainingBudget < currentBid + increment) continue;
    if (team.roster.length >= cfg.maxRosterSize) continue;
    if (player.isInternational && team.internationalCount >= cfg.maxInternational) continue;

    // CPU bidding probability (same logic as full auction)
    const valueRatio = currentBid / (value + 0.1);
    const positionFactor = 1 - 0.1 * (state.currentPlayerIndex / 100);
    let bidProb = Math.max(0, 1 - valueRatio) * positionFactor;

    if (player.age < 25) bidProb *= 1.2;
    if (player.age > 34) bidProb *= 0.7;
    if (!player.isInternational) bidProb *= 1.15;
    if (team.roster.length < 12) bidProb *= 1.3;
    if (currentBid > value * 1.25) bidProb *= 0.55;
    if (currentBid > value * 1.5) bidProb *= 0.25;

    // Budget discipline: save money for remaining squad slots
    const slotsNeeded = Math.max(0, (cfg.minSquadSize || 18) - team.roster.length);
    const reserveBudget = slotsNeeded * 0.3;
    if (team.remainingBudget - currentBid < reserveBudget) bidProb *= 0.1;
    if (currentBid > team.salaryCap * 0.3) bidProb *= 0.05;

    if (Math.random() < bidProb) {
      currentBid = Math.round((currentBid + increment) * 100) / 100;
      currentBidderId = teamId;
      anyBid = true;
    }
  }

  // If no one bid this round, resolve the player
  if (!anyBid) {
    if (currentBidderId) {
      // SOLD
      const winningTeam = teams.find(t => t.id === currentBidderId);
      if (winningTeam) {
        winningTeam.addPlayer(player, currentBid);
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
    return { ...state, phase: "complete" };
  }

  const nextP = state.players[nextIndex];
  const basePrice = nextP ? getBasePrice(nextP) : 0.3;

  const eligible = teams
    .filter(t => t.roster.length < cfg.maxRosterSize && t.remainingBudget >= basePrice)
    .map(t => t.id);

  return {
    ...state,
    currentPlayerIndex: nextIndex,
    currentBid: basePrice,
    currentBidderId: null,
    biddingTeams: eligible,
    round: 0,
    phase: "bidding",
  };
}

/** Simulate the current player's auction to completion */
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
): { retained: Player[]; released: Player[]; retentionCosts: { player: Player; cost: number }[] } {
  const sorted = [...team.roster].sort((a, b) => b.overall - a.overall);
  const retained: Player[] = [];
  const released: Player[] = [];

  for (const player of sorted) {
    const evaluation = evaluateRetentionSelection([...retained, player], retentionBudget, maxRetentions);
    if (!evaluation.valid) {
      released.push(player);
      continue;
    }
    retained.push(player);
  }

  const evaluation = evaluateRetentionSelection(retained, retentionBudget, maxRetentions);
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
