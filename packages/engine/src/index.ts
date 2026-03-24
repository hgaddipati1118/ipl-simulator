/**
 * @ipl-sim/engine - Core IPL simulation engine
 *
 * Provides ball-by-ball T20 match simulation, auction system,
 * season scheduling, player progression, and team management.
 */

export { Player } from "./player.js";
export {
  calculateBattingOverall,
  calculateBowlingOverall,
  calculateOverallRating,
  calculateMarketValue,
} from "./player.js";
export type { PlayerData, PlayerRatings, PlayerRole, PlayerStats, MatchPerformance, InjurySeverity, BowlingStyle, BattingHand } from "./player.js";

export { Team, IPL_TEAMS, WPL_TEAMS } from "./team.js";
export type { TeamConfig, BowlingPlan } from "./team.js";

export { getMatchupModifiers, getMatchPhase, isPaceBowler, isSpinBowler } from "./matchups.js";
export type { PitchType, BoundarySize, DewFactor, MatchPhase } from "./matchups.js";

export {
  determineDismissalType, isCatchDropped, determineWideType, runsOffWide,
  determineNoBallType, runsOffNoBall, isFreeHitBall, canBeDismissedOnFreeHit,
  determineLegByes, checkRunOut, checkOverthrow, checkMidMatchInjury,
  processDRSReview,
} from "./ball-outcomes.js";
export type { DismissalType, WideType, NoBallType, MatchInjuryType, DRSResult } from "./ball-outcomes.js";

export { simulateMatch } from "./match.js";
export type {
  BallOutcome, BallEvent, InningsScore, MatchResult, MatchInjuryEvent,
  DetailedMatchResult, DetailedBallEvent, BatterInnings,
  BowlerFigures, InningsScorecard,
} from "./match.js";

export {
  runAuction, retainPlayers,
  initAuction, userBid, userDropBid, cpuBidRound,
  nextPlayer, simCurrentPlayer, simRemainingAuction,
  getBasePrice, getBidIncrement,
  evaluateRetentionSelection,
  isCappedRetentionPlayer,
  RETENTION_BUDGET,
  MAX_RETENTIONS,
  MAX_CAPPED_RETENTIONS,
  MAX_UNCAPPED_RETENTIONS,
} from "./auction.js";
export type {
  AuctionConfig,
  AuctionBid,
  AuctionResult,
  AuctionState,
  RetentionCost,
  RetentionEvaluation,
} from "./auction.js";

export {
  generateIPLSchedule,
  generateSchedule,
  getStandings,
  runSeason,
  simulateNextMatch,
  applyLiveResult,
  addPlayoffMatches,
  addQualifier2,
  addFinal,
  getGroupStageCount,
  serializeMatchResult,
} from "./schedule.js";
export type {
  ScheduledMatch,
  StandingsEntry,
  SeasonResult,
  SerializableMatchResult,
  SerializableInningsScore,
} from "./schedule.js";

export { generateRandomPlayer, generatePlayerPool, createPlayerFromData, nextPlayerId } from "./create-player.js";

export { randomNormal, clamp, weightedRandom, shuffle, normSInv } from "./math.js";

export { RULE_PRESETS, DEFAULT_RULES, IPL_8_TEAM_IDS, IPL_10_TEAM_IDS, WPL_TEAM_IDS, ALL_TEAM_IDS } from "./rules.js";
export type { RuleSet, LeagueType, PlayoffFormat, GenderOption, PlayerSource } from "./rules.js";

export {
  evaluateTradeAI, executeTrade, createTradeOffer,
  processTradeOffer, generateAITradeOffers,
} from "./trade.js";
export type { TradeOffer, TradeResult } from "./trade.js";

export {
  checkForInjury,
  applyInjury,
  runPostMatchInjuryChecks,
  healInjuries,
  getAvailablePlayers,
  getInjuredPlayersInXI,
  getTeamInjuryReport,
} from "./injury.js";
export type { InjuryStatus } from "./injury.js";

export {
  createMatchState,
  stepBall,
  startSecondInnings,
  simulateRemaining,
  simulateOver,
  finalizeMatchState,
  buildDetailedResultFromState,
  serializeMatchState,
  deserializeMatchState,
  applyDecision,
  autoResolveDecision,
  getImpactSubOptions,
  applyImpactSub,
  setAggression,
  setFieldSetting,
} from "./live-match.js";
export type {
  MatchState,
  LiveBatterStats,
  LiveBowlerStats,
  PendingDecision,
  PendingDecisionOption,
  FieldSetting,
} from "./live-match.js";

export { generateBallCommentary } from "./commentary.js";
export type { BallCommentaryParams } from "./commentary.js";

export { generatePostMatchNarrative } from "./narrative.js";
export type { NarrativeEvent, PostMatchNarrativeParams } from "./narrative.js";
