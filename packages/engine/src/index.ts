/**
 * @ipl-sim/engine - Core IPL simulation engine
 *
 * Provides ball-by-ball T20 match simulation, auction system,
 * season scheduling, player progression, and team management.
 */

export { Player } from "./player.js";
export { createRNG, randomSeed, deriveSeed, randInt, randPick, randWeighted } from "./rng.js";
export { shuffle as rngShuffle } from "./rng.js";
export type { RNG } from "./rng.js";
export {
  calculateBattingOverall,
  calculateBowlingOverall,
  calculateOverallRating,
  calculateMarketValue,
  getTrainingCampFatigue,
} from "./player.js";
export type {
  PlayerData,
  PlayerRatings,
  CoreRatingKey,
  PlayerRole,
  PlayerStats,
  MatchPerformance,
  InjurySeverity,
  BowlingStyle,
  BattingHand,
  BattingPosition,
  TrainingFocus,
  TrainingIntensity,
  PlayerProgressReport,
} from "./player.js";

export { Team, IPL_TEAMS, WPL_TEAMS, LEGACY_STADIUM_BOWLING_RATINGS } from "./team.js";
export {
  getVenueProfileForTeam, getLeagueChaseAdvantage, deriveStadiumBowlingRating,
  derivePitchType, deriveBoundarySize, deriveDewFactor,
} from "./venues.js";
export type { VenueProfile } from "./venues.js";

export type { TeamConfig, BowlingPlan } from "./team.js";

export { getMatchupModifiers, getMatchPhase, isPaceBowler, isFastBowler, isSpinBowler, isSlowBowler, getBatterAffinityModifier } from "./matchups.js";
export type { PitchType, BoundarySize, DewFactor, MatchPhase } from "./matchups.js";

export { calculateWinProbability } from "./win-probability.js";
export { getDLSResource, calculateDLSTarget, checkRainInterruption, canProduceResult, getRainDelayNarrative } from "./dls.js";

export {
  determineDismissalType, isCatchDropped, determineWideType, runsOffWide,
  determineNoBallType, runsOffNoBall, isFreeHitBall, canBeDismissedOnFreeHit,
  determineLegByes, checkRunOut, checkOverthrow, checkMidMatchInjury,
  determineInjuryResponse, isLikeForLikeReplacement, getReplacementConstraints,
  processDRSReview,
} from "./ball-outcomes.js";
export type { DismissalType, WideType, NoBallType, MatchInjuryType, InjuryResponse, DRSResult } from "./ball-outcomes.js";

export {
  fieldingRating, keepingRating, pickKeeper, fieldingValueBonus, buildFieldingUnit, resolveWicketChance, applyFieldingToProbs,
  chanceInflation, fieldingCommentary, NEUTRAL_FIELDING, DEFAULT_KEEPER_KEEPING, DEFAULT_NONKEEPER_KEEPING, CONV as FIELDING_CONVERSION,
} from "./fielding.js";
export type { FielderLike, FieldingUnit, FieldingNote, FieldingResolution, WicketKind } from "./fielding.js";

export { simulateMatch, calculateMVPPoints } from "./match.js";
export {
  DISMISSAL_KINDS, DELIVERY_DISMISSALS, canDismiss, legalDismissals, isBowlerWicket, countsAsWicket, dismissalText,
  setRuleOverrides, expandDelivery, genderOf, EXTRAS_RATE_CAL, RETIRED_HURT_TEXT,
} from "./delivery-rules.js";
export type { DismissalKind, DeliveryClass, DeliveryDetail, DismissalDetail, RuleOverrides, Gender } from "./delivery-rules.js";
export { MATCH_RULES_DATA } from "./match-rules-data.js";
export type {
  OffBallDismissal,
} from "./match.js";
export type {
  BallOutcome, BallEvent, InningsScore, MatchResult, MatchInjuryEvent,
  DetailedMatchResult, DetailedBallEvent, BatterInnings,
  BowlerFigures, InningsScorecard, MVPPlayerPoints,
} from "./match.js";

export {
  runAuction, retainPlayers,
  initAuction, userBid, userDropBid, cpuBidRound,
  nextPlayer, simCurrentPlayer, simRemainingAuction,
  rtmAccept, rtmDecline,
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
  progressPlayoffs,
  generateBalancedSchedule,
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

export { randomNormal, clamp, weightedRandom, shuffle, normSInv, displayOversToReal } from "./math.js";

export { RULE_PRESETS, DEFAULT_RULES, IPL_8_TEAM_IDS, IPL_10_TEAM_IDS, WPL_TEAM_IDS, ALL_TEAM_IDS, getAuctionType, getMaxRetentions, getSeasonSalaryCap, getScaledRetentions, getAuctionPoolSize } from "./rules.js";
export type { RuleSet, LeagueType, ExtraLeagueId, PlayoffFormat, MatchFormatId, GenderOption, PlayerSource, AuctionType } from "./rules.js";
export {
  ALL_LEAGUES, EXTRA_LEAGUES, LEAGUE_RULE_PRESETS, LEAGUE_SCORING_MULTIPLIER,
  getLeague, getExtraLeagueTeams, isExtraLeague, isWomenLeague, isOverseasIn,
} from "./leagues.js";
export type { LeagueDef, LeagueDefData } from "./leagues.js";
export { T20_FORMAT, HUNDRED_FORMAT, matchFormatFor, phaseOver } from "./format.js";
export type { MatchFormatSpec } from "./format.js";

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
  playLiveSuperOvers,
} from "./live-match.js";
export type {
  MatchState,
  LiveBatterStats,
  LiveBowlerStats,
  PendingDrsContext,
  PendingDecision,
  PendingDecisionOption,
  FieldSetting,
  LiveSuperOver,
} from "./live-match.js";

export { generateBallCommentary, generateBallCommentaryDetailed } from "./commentary.js";
export type { BallCommentaryParams, BallCommentaryResult } from "./commentary.js";
export {
  setCommentaryModel, hasCommentaryModel, getCommentaryModel, loadCommentaryModel, pickModelCommentary,
  commentaryShortName, bowlerKindIndex, commentarySeed,
} from "./commentary-model.js";
export type { CommentaryModelData, ModelBall, ModelPick } from "./commentary-model.js";

export { generatePostMatchNarrative } from "./narrative.js";
export type { NarrativeEvent, PostMatchNarrativeParams } from "./narrative.js";

export {
  generateBoardObjectives,
  evaluateBoardObjectives,
  createBoardState,
  updateBoardState,
  isFired,
} from "./board.js";
export type { BoardObjective, BoardObjectiveType, BoardState } from "./board.js";

export {
  updateTeamMorale,
  getMoraleModifier,
  getClutchMoraleModifier,
  initSeasonMorale,
  getMoraleLabel,
  getDisgruntledPlayers,
  getConsecutiveResults,
} from "./morale.js";

export {
  getContractLength,
  assignTeamContracts,
  tickContracts,
  getExpiringContracts,
  releaseFreeAgents,
  extendContract,
  getContractBadge,
} from "./contracts.js";
export type { ContractSource, ContractInfo, ExpiringContractReport } from "./contracts.js";

export { generateYouthProspects } from "./youth-academy.js";
export type { YouthProspect } from "./youth-academy.js";

export { calculateFantasyPoints, accumulateFantasyPoints, enrichFantasyNames } from "./fantasy.js";
export type { FantasyPoints } from "./fantasy.js";
export { AGE_CURVES, ageCurveDelta } from "./age-curves.js";
export type { AgeCurveGender, AgeCurveKind } from "./age-curves.js";

export {
  createDraft, applyDraftAction, runAiPicks, simulateRemainingDraft, chooseAiPick,
  buildPickOrder, shuffleSeats, toDraftPlayer, isDraftBowlingOption,
  getCurrentSeatId, getCurrentRound, isDraftComplete, getDraftPlayer, getSquad,
  getAvailablePlayers as getDraftAvailablePlayers, getSquadNeeds, getPickError, getLegalPlayers,
  canFieldValidXI, squadStrength,
} from "./draft.js";
export type {
  DraftType, DraftAiPersonality, DraftPlayer, DraftSeat, DraftConfig, DraftPick,
  DraftStatus, DraftState, DraftAction, DraftActionResult, SquadNeeds,
} from "./draft.js";

export {
  sampleChange, expectedChange, changeSd, sampleResidual, meanPathOvr, retirementProbability, retirementRole,
  estimateExperience, interp, PERIPHERAL_MEAN,
} from "./progression.js";
export type {
  ProgressionState, ProgressionGender, DisciplineState, Discipline, BatKind, BowlKind, RetirementRole,
} from "./progression.js";
export { projectPlayer, simulateCareer, playerRetirementProbability, bandOf, quantileOf } from "./progression-sim.js";
export type { ProjectionPoint, ProjectionOptions, CareerSeason, Band } from "./progression-sim.js";
export { validateCohort, formatValidation, cohortPlayerData, simulatedPaths, realPath } from "./progression-validation.js";
export type { Cohort, CohortPlayer, ValidationReport, HorizonMetrics } from "./progression-validation.js";
export { RATING_HISTORY_MAX } from "./player.js";
export type { RatingHistoryEntry } from "./player.js";
export { sampleFieldingRatings } from "./player-generator.js";
export { validateFieldingProgression, simulateFieldingChange, formatFieldingValidation } from "./fielding-progression-validation.js";
export type { FieldingTarget, FieldingCohortFixture, FieldingValidationRow } from "./fielding-progression-validation.js";
export { expectedFieldingChange, sampleFieldingChange, fieldingFit } from "./fielding-progression.js";
export { FIELDING_PROGRESSION } from "./fielding-progression-model.js";
export { generatePlayer, generatePlayers, assignPotential, roleClassOfPlayer, roleOfClass, regionOf, sampleRatings, ROLE_CLASSES, TALENT_SD } from "./player-generator.js";
export type { GeneratePlayerOptions, GenerationKind, RoleClass, Region } from "./player-generator.js";
export { generateName, isRealName, nameGroupOf, normaliseName } from "./names.js";
