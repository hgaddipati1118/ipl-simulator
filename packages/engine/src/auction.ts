/**
 * IPL Auction simulation.
 * Ported from IndianCricketLeague/AuctionClass.js
 */

import { Player } from "./player.js";
import { Team } from "./team.js";

export interface AuctionConfig {
  startingBid: number;    // in crores (default 0.2)
  maxRosterSize: number;  // default 25
  maxInternational: number; // default 8
  minDomestic: number;    // default 17
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

const DEFAULT_CONFIG: AuctionConfig = {
  startingBid: 0.2,
  maxRosterSize: 25,
  maxInternational: 8,
  minDomestic: 17,
};

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

  // Fill up teams that have fewer than 15 players with unsold players at base price
  const minRoster = 15;
  for (const team of teams) {
    while (team.roster.length < minRoster && unsold.length > 0) {
      // Pick best available player that fits (international cap)
      const idx = unsold.findIndex(p =>
        !p.isInternational || team.internationalCount < cfg.maxInternational
      );
      if (idx === -1) break;
      const [freeAgent] = unsold.splice(idx, 1);
      const bid = cfg.startingBid;
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
  // Filter eligible teams
  const eligible = teams.filter(t => {
    if (t.roster.length >= config.maxRosterSize) return false;
    if (player.isInternational && t.internationalCount >= config.maxInternational) return false;
    if (t.remainingBudget < config.startingBid) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  let currentBid = config.startingBid;
  let currentBidder: Team | null = null;
  let round = 0;
  const value = player.marketValue;

  // Bidding rounds
  while (round < 50) { // safety limit
    round++;
    let anyBid = false;

    for (const team of eligible) {
      if (team === currentBidder) continue;
      if (team.remainingBudget < currentBid + 0.2) continue;
      if (team.roster.length >= config.maxRosterSize) continue;

      // CPU bidding probability
      const valueRatio = currentBid / (value * 10 + 0.1);
      const positionFactor = 1 - 0.1 * (playerIndex / 100);
      let bidProb = (1 - valueRatio) * positionFactor;

      // Age adjustment: prefer younger players
      if (player.age < 25) bidProb *= 1.2;
      if (player.age > 34) bidProb *= 0.7;

      // Domestic player boost (Indian players more sought after)
      if (!player.isInternational) bidProb *= 1.15;

      // Team need: if team has few players, more aggressive
      if (team.roster.length < 12) bidProb *= 1.3;

      // Don't overbid dramatically
      if (currentBid > value * 15) bidProb *= 0.3;

      if (Math.random() < bidProb) {
        currentBid += 0.2 + Math.random() * 0.3; // increment 0.2-0.5 crores
        currentBid = Math.round(currentBid * 10) / 10;
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

/** Simulate player retention between seasons */
export function retainPlayers(
  team: Team,
  retentionBudget: number = 42, // crores for retained players
  maxRetentions: number = 5,
): { retained: Player[]; released: Player[] } {
  const sorted = [...team.roster].sort((a, b) => b.overall - a.overall);
  const retained: Player[] = [];
  const released: Player[] = [];
  let spent = 0;

  for (const player of sorted) {
    if (retained.length >= maxRetentions) {
      released.push(player);
      continue;
    }

    const cost = player.marketValue * 2; // retention costs more
    if (spent + cost <= retentionBudget) {
      // Player may refuse (probability based on how much below market value)
      const refusalProb = Math.max(0, 1 - (cost / (player.marketValue * 3)));
      if (Math.random() > refusalProb) {
        retained.push(player);
        spent += cost;
        continue;
      }
    }
    released.push(player);
  }

  // Update team roster
  team.roster = retained;
  team.totalSpent = spent;

  for (const p of released) {
    p.teamId = undefined;
    p.bid = 0;
  }

  return { retained, released };
}
