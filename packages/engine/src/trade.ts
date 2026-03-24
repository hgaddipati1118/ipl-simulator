/**
 * Inter-team trade system.
 *
 * Allows player trades between teams during the offseason window
 * (after retentions, before auction). Includes AI trade evaluation
 * for CPU-managed teams.
 */

import { Player } from "./player.js";
import { Team } from "./team.js";

export interface TradeOffer {
  id: string;
  fromTeamId: string;
  toTeamId: string;
  playersOffered: string[];   // player IDs from offering team
  playersRequested: string[]; // player IDs from target team
  status: "pending" | "accepted" | "rejected" | "counter";
}

export interface TradeResult {
  offer: TradeOffer;
  accepted: boolean;
  reason?: string;
  counterOffer?: TradeOffer; // AI suggests a counter if they reject but are interested
}

let tradeIdCounter = 0;

/** Calculate a player's trade value (similar to market value but accounting for age/contract) */
function tradeValue(player: Player): number {
  const ovr = player.overall;
  const ageFactor = Math.max(0.5, 1 - (player.age - 25) * 0.03);
  return ovr * ageFactor;
}

/** Sum trade value for a group of players */
function totalTradeValue(players: Player[]): number {
  return players.reduce((s, p) => s + tradeValue(p), 0);
}

/**
 * AI evaluates whether to accept a trade offer.
 *
 * Considers:
 * - Overall value balance (does the team get better?)
 * - Role needs (does the team need the position?)
 * - International slots (would they exceed 8 overseas?)
 * - Age preference (younger players valued slightly more)
 */
export function evaluateTradeAI(
  team: Team,
  playersGiving: Player[],
  playersReceiving: Player[],
): { accept: boolean; reason: string } {
  // Value comparison
  const givingValue = totalTradeValue(playersGiving);
  const receivingValue = totalTradeValue(playersReceiving);

  // AI wants at least 85% of the value they're giving away
  if (receivingValue < givingValue * 0.85) {
    return { accept: false, reason: "Trade value too low" };
  }

  // Check international limit after trade
  const currentIntl = team.internationalCount;
  const intlGiving = playersGiving.filter(p => p.isInternational).length;
  const intlReceiving = playersReceiving.filter(p => p.isInternational).length;
  const afterIntl = currentIntl - intlGiving + intlReceiving;
  if (afterIntl > 8) {
    return { accept: false, reason: "Would exceed overseas limit" };
  }

  // Check role balance — does the team need what they're getting?
  const rosterAfter = team.roster
    .filter(p => !playersGiving.some(g => g.id === p.id))
    .concat(playersReceiving);

  const bowlerCount = rosterAfter.filter(p => p.role === "bowler" || p.role === "all-rounder").length;
  const batCount = rosterAfter.filter(p => p.role === "batsman").length;

  if (bowlerCount < 4) {
    return { accept: false, reason: "Would leave too few bowlers" };
  }
  if (batCount < 4) {
    return { accept: false, reason: "Would leave too few batters" };
  }

  // Age bonus: slightly prefer younger incoming players
  const avgAgeReceiving = playersReceiving.reduce((s, p) => s + p.age, 0) / playersReceiving.length;
  const avgAgeGiving = playersGiving.reduce((s, p) => s + p.age, 0) / playersGiving.length;
  const ageBonus = (avgAgeGiving - avgAgeReceiving) * 2; // bonus for getting younger players

  // Final decision: accept if value + age bonus is favorable
  const netValue = receivingValue - givingValue + ageBonus;
  if (netValue >= -5) {
    return { accept: true, reason: "Fair trade" };
  }

  return { accept: false, reason: "Not enough value in return" };
}

/** Execute a trade between two teams */
export function executeTrade(
  team1: Team,
  team2: Team,
  players1to2: Player[], // players moving from team1 to team2
  players2to1: Player[], // players moving from team2 to team1
): void {
  // Remove players from team1 and add to team2
  for (const p of players1to2) {
    team1.removePlayer(p.id);
    team2.addPlayer(p, p.bid);
  }

  // Remove players from team2 and add to team1
  for (const p of players2to1) {
    team2.removePlayer(p.id);
    team1.addPlayer(p, p.bid);
  }
}

/** Create a trade offer */
export function createTradeOffer(
  fromTeamId: string,
  toTeamId: string,
  playersOffered: string[],
  playersRequested: string[],
): TradeOffer {
  return {
    id: `trade_${++tradeIdCounter}`,
    fromTeamId,
    toTeamId,
    playersOffered,
    playersRequested,
    status: "pending",
  };
}

/**
 * Process a trade offer: look up players, evaluate with AI, execute if accepted.
 * Returns the result.
 */
export function processTradeOffer(
  offer: TradeOffer,
  teams: Team[],
): TradeResult {
  const fromTeam = teams.find(t => t.id === offer.fromTeamId);
  const toTeam = teams.find(t => t.id === offer.toTeamId);

  if (!fromTeam || !toTeam) {
    return { offer: { ...offer, status: "rejected" }, accepted: false, reason: "Invalid team" };
  }

  const playersOffered = offer.playersOffered
    .map(id => fromTeam.roster.find(p => p.id === id))
    .filter((p): p is Player => p !== undefined);

  const playersRequested = offer.playersRequested
    .map(id => toTeam.roster.find(p => p.id === id))
    .filter((p): p is Player => p !== undefined);

  if (playersOffered.length !== offer.playersOffered.length ||
      playersRequested.length !== offer.playersRequested.length) {
    return { offer: { ...offer, status: "rejected" }, accepted: false, reason: "Players not found" };
  }

  // AI evaluates from the receiving team's perspective
  const evaluation = evaluateTradeAI(toTeam, playersRequested, playersOffered);

  if (evaluation.accept) {
    executeTrade(fromTeam, toTeam, playersOffered, playersRequested);
    offer.status = "accepted";
    return { offer, accepted: true, reason: evaluation.reason };
  }

  // Try to generate a counter-offer if AI is interested but wants more value
  const counter = generateCounterOffer(offer, fromTeam, toTeam, playersOffered, playersRequested);
  if (counter) {
    offer.status = "counter";
    return { offer, accepted: false, reason: evaluation.reason, counterOffer: counter };
  }

  offer.status = "rejected";
  return { offer, accepted: false, reason: evaluation.reason };
}

/**
 * Generate a counter-offer when the AI rejects but sees potential.
 * The AI asks for a better player or offers a better one to make the deal work.
 */
function generateCounterOffer(
  original: TradeOffer,
  fromTeam: Team,
  toTeam: Team,
  playersOffered: Player[],
  playersRequested: Player[],
): TradeOffer | null {
  const offeredValue = totalTradeValue(playersOffered);
  const requestedValue = totalTradeValue(playersRequested);

  // Only counter if the gap isn't too large (within 40%)
  if (offeredValue < requestedValue * 0.6) return null;

  // Strategy 1: Ask for a lower-value player from the requesting team instead
  const requestedIds = new Set(original.playersRequested);
  const alternateTargets = toTeam.roster
    .filter(p => !requestedIds.has(p.id))
    .sort((a, b) => {
      // Find player closest in value to what's being offered
      const aDiff = Math.abs(tradeValue(a) - offeredValue);
      const bDiff = Math.abs(tradeValue(b) - offeredValue);
      return aDiff - bDiff;
    });

  if (alternateTargets.length > 0) {
    const counterTarget = alternateTargets[0];
    // Only counter if the alternative is meaningfully different
    if (counterTarget.id !== playersRequested[0]?.id) {
      const counterEval = evaluateTradeAI(toTeam, [counterTarget], playersOffered);
      if (counterEval.accept) {
        return createTradeOffer(
          original.toTeamId,   // AI team is now offering
          original.fromTeamId, // back to the original proposer
          [counterTarget.id],  // AI offers this player instead
          original.playersOffered, // AI wants the originally offered players
        );
      }
    }
  }

  // Strategy 2: AI offers a sweetener — add one of their lower-value players
  if (playersOffered.length === 1) {
    const offeredIds = new Set(original.playersOffered);
    const sweeteners = fromTeam.roster
      .filter(p => !offeredIds.has(p.id))
      .sort((a, b) => b.overall - a.overall);

    for (const sweetener of sweeteners.slice(0, 3)) {
      const newOffered = [...playersOffered, sweetener];
      const eval2 = evaluateTradeAI(toTeam, playersRequested, newOffered);
      if (eval2.accept) {
        return createTradeOffer(
          original.toTeamId,
          original.fromTeamId,
          original.playersRequested, // AI gives what was requested
          [...original.playersOffered, sweetener.id], // but wants more in return
        );
      }
    }
  }

  return null;
}

/**
 * Generate AI trade offers to the user's team.
 * CPU teams look at their weaknesses and try to trade for improvements.
 */
export function generateAITradeOffers(
  teams: Team[],
  userTeamId: string,
  maxOffers = 3,
): TradeOffer[] {
  const userTeam = teams.find(t => t.id === userTeamId);
  if (!userTeam) return [];

  const offers: TradeOffer[] = [];
  const cpuTeams = teams.filter(t => t.id !== userTeamId);

  for (const cpuTeam of cpuTeams) {
    if (offers.length >= maxOffers) break;
    if (cpuTeam.roster.length < 8) continue; // too small to trade

    // Find CPU team's weakness and user team's surplus
    const cpuBowlers = cpuTeam.roster.filter(p => p.role === "bowler" || p.role === "all-rounder");
    const cpuBatters = cpuTeam.roster.filter(p => p.role === "batsman");
    const userBowlers = userTeam.roster.filter(p => p.role === "bowler" || p.role === "all-rounder");
    const userBatters = userTeam.roster.filter(p => p.role === "batsman");

    let cpuOffers: Player | undefined;
    let cpuWants: Player | undefined;

    // CPU needs bowling, user has surplus
    if (cpuBowlers.length < 5 && userBowlers.length > 5) {
      // CPU offers their worst batter for user's mid-tier bowler
      cpuOffers = cpuBatters.sort((a, b) => a.overall - b.overall)[0];
      cpuWants = userBowlers.sort((a, b) => a.overall - b.overall)[Math.floor(userBowlers.length / 2)];
    }
    // CPU needs batting, user has surplus
    else if (cpuBatters.length < 5 && userBatters.length > 5) {
      cpuOffers = cpuBowlers.sort((a, b) => a.overall - b.overall)[0];
      cpuWants = userBatters.sort((a, b) => a.overall - b.overall)[Math.floor(userBatters.length / 2)];
    }
    // General: CPU offers a lower-rated player for a slightly better one
    else {
      const cpuSorted = [...cpuTeam.roster].sort((a, b) => a.overall - b.overall);
      const userSorted = [...userTeam.roster].sort((a, b) => a.overall - b.overall);
      // Offer their weakest non-essential player
      cpuOffers = cpuSorted[Math.floor(Math.random() * 3)];
      // Want a mid-tier player from user (not their best)
      const midIdx = Math.floor(userSorted.length / 2) + Math.floor(Math.random() * 3);
      cpuWants = userSorted[Math.min(midIdx, userSorted.length - 1)];
    }

    if (cpuOffers && cpuWants && cpuOffers.id !== cpuWants.id) {
      // Verify international limit won't be exceeded on either side
      const cpuIntlAfter = cpuTeam.internationalCount
        - (cpuOffers.isInternational ? 1 : 0)
        + (cpuWants.isInternational ? 1 : 0);
      const userIntlAfter = userTeam.internationalCount
        - (cpuWants.isInternational ? 1 : 0)
        + (cpuOffers.isInternational ? 1 : 0);

      if (cpuIntlAfter <= 8 && userIntlAfter <= 8) {
        offers.push(createTradeOffer(
          cpuTeam.id,
          userTeamId,
          [cpuOffers.id],
          [cpuWants.id],
        ));
      }
    }
  }

  return offers;
}
