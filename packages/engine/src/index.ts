/**
 * @ipl-sim/engine - Core IPL simulation engine
 *
 * Provides ball-by-ball T20 match simulation, auction system,
 * season scheduling, player progression, and team management.
 */

export { Player } from "./player.js";
export type { PlayerData, PlayerRatings, PlayerRole, PlayerStats, MatchPerformance } from "./player.js";

export { Team, IPL_TEAMS } from "./team.js";
export type { TeamConfig } from "./team.js";

export { simulateMatch } from "./match.js";
export type { BallOutcome, BallEvent, InningsScore, MatchResult } from "./match.js";

export { runAuction, retainPlayers } from "./auction.js";
export type { AuctionConfig, AuctionBid, AuctionResult } from "./auction.js";

export { generateIPLSchedule, getStandings, runSeason } from "./schedule.js";
export type { ScheduledMatch, StandingsEntry, SeasonResult } from "./schedule.js";

export { generateRandomPlayer, generatePlayerPool, createPlayerFromData, nextPlayerId } from "./create-player.js";

export { randomNormal, clamp, weightedRandom, shuffle, normSInv } from "./math.js";
