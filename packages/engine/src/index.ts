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
  LongFormat,
  FormatRatings,
} from "./player.js";

export { Team, IPL_TEAMS, WPL_TEAMS, LEGACY_STADIUM_BOWLING_RATINGS, xiSelectionValue, keeperSelectionValue } from "./team.js";
export {
  getVenueProfileForTeam, getLeagueChaseAdvantage, deriveStadiumBowlingRating,
  derivePitchType, deriveBoundarySize, deriveDewFactor, getOdiVenueProfile,
} from "./venues.js";
export type { VenueProfile } from "./venues.js";

export type { TeamConfig, BowlingPlan } from "./team.js";

export { getMatchupModifiers, getMatchPhase, isPaceBowler, isFastBowler, isSpinBowler, isSlowBowler, getBatterAffinityModifier } from "./matchups.js";
export type { PitchType, BoundarySize, DewFactor, MatchPhase } from "./matchups.js";

export { calculateWinProbability, odiWinProbability } from "./win-probability.js";
export { ODI_WIN_PROBABILITY } from "./odi-win-probability-data.js";
export { getDLSResource, calculateDLSTarget, checkRainInterruption, canProduceResult, getRainDelayNarrative, resources50, resourcesPct, inningsResources, dlsTarget, dlsPar, DLS_G_T20, DLS_G_ODI, dlsGFor, odiRevisedTarget } from "./dls.js";
export { DRS_REVIEWS_PER_INNINGS, drsAtDismissal, drsAtDot, drsKindOf, drsText, reviewLost } from "./drs.js";
export type { DrsReview, DrsKind, DrsResult, DrsSide } from "./drs.js";
export {
  applySpecialPlays, applyGenderExtras, extrasGenderFactor, drawOverRatePenalty, applyOverRatePenalty, OVER_RATE, OVER_RATE_EFFECT, specialPlayText, specialPlayTail,
} from "./special-plays.js";
export { MATCH_RULES_EXTRA } from "./match-rules-extra-data.js";

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
  chanceInflation, fieldingCommentary, fieldingTally, battingLives, missedChanceOutcome, NEUTRAL_FIELDING, DEFAULT_KEEPER_KEEPING, DEFAULT_NONKEEPER_KEEPING, CONV as FIELDING_CONVERSION,
} from "./fielding.js";
export type { FielderLike, FieldingUnit, FieldingNote, FieldingResolution, WicketKind, FieldingTally, FieldingLogEvent } from "./fielding.js";

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
  BowlerFigures, InningsScorecard, MVPPlayerPoints, MatchOptions,
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

export { generateRandomPlayer, generatePlayerPool, createPlayerFromData, nextPlayerId, inferRuntimeRole, normalizeRatingsForRole } from "./create-player.js";

export { randomNormal, clamp, weightedRandom, shuffle, normSInv, displayOversToReal } from "./math.js";

export { RULE_PRESETS, DEFAULT_RULES, odiRules, IPL_8_TEAM_IDS, IPL_10_TEAM_IDS, WPL_TEAM_IDS, ALL_TEAM_IDS, getAuctionType, getMaxRetentions, getSeasonSalaryCap, getScaledRetentions, getAuctionPoolSize } from "./rules.js";
export type { RuleSet, LeagueType, ExtraLeagueId, PlayoffFormat, MatchFormatId, GenderOption, PlayerSource, AuctionType } from "./rules.js";
export {
  ALL_LEAGUES, EXTRA_LEAGUES, LEAGUE_RULE_PRESETS, LEAGUE_SCORING_MULTIPLIER,
  getLeague, getExtraLeagueTeams, isExtraLeague, isWomenLeague, isOverseasIn, teamGender, playerGender,
} from "./leagues.js";
export type { LeagueDef, LeagueDefData } from "./leagues.js";
export { T20_FORMAT, HUNDRED_FORMAT, ODI_FORMAT, matchFormatFor, phaseOver, hasOwnBallModel, maxFieldersOutside, ballAgeOvers } from "./format.js";
export type { MatchFormatSpec } from "./format.js";
export {
  ODI_OUTCOMES, ODI_REF, ODI_RATING_SLOPES, ODI_CAL, ODI_TAIL_WEIGHT, ODI_RATING_SCALE, odiBallProbabilities, odiContextWeights, odiRatingMultipliers, odiTables, odiBowlerChoices,
} from "./odi-model.js";
export type { OdiModelTables, OdiBallContext, OdiPlayerLike, OdiRainRates } from "./odi-model.js";
export { ODI_MODEL_DATA, ODI_RAIN } from "./odi-model-data.js";
export { ODI_GROUNDS, ODI_CONDITIONS } from "./odi-venue-data.js";

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
  liveMatchFormat,
} from "./live-match.js";
export type {
  LiveMatchOptions,
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

// Model commentary for instantly simulated matches, generated when a match is viewed (docs/COMMENTARY.md section 9)
export { attachCommentaryCues, withModelCommentary } from "./instant-commentary.js";
export type { CommentaryCues, BallCommentaryCue, DetailedWithCues } from "./instant-commentary.js";

// Test cricket: instant simulation, the live driver and the fitted model (docs/FORMATS-TEST.md)
export {
  simulateTestMatch, createTestMatch, stepTestBall, runTestToEnd, applyToss, applyFollowOn, applyTestDecision, autoResolveTestDecision,
  declareInnings, setTestApproach, takeNewBall, changeTestBowler, describeTestBall, testInningsScorecard, testMatchResult,
  pickTestXI, testBattingOrder, testPlayerOf, testBallProbs, oversLeftInMatch, testLead, testTarget, currentInnings as currentTestInnings,
  followOnMargin, followOnProbability, declarationHazard, testCountryCode, TEST_OUTCOMES, TEST_COUNTRIES,
  setNextBatter, testBatterQueue, nightwatchmanCandidate, NIGHTWATCHMAN_OVERS, NIGHTWATCHMAN_P,
} from "./test-match.js";
export type {
  TestMatchOptions, TestMatchState, TestMatchResult, TestResult, TestInnings, TestInningsSummary, TestBallEvent, TestBatterLine,
  TestBowlerLine, TestTeamState, TestPlayer, TestPendingDecision, TestDecisionType, TestMatchEvent, TestApproach, TestGender, TestOutcomeClass,
} from "./test-match.js";
export {
  startLiveTest, advanceTest, decideTest, declareTest, setTestBattingApproach, setTestNextBatter, takeTestNewBall, changeTestBowlerTo, setTestAutoCaptain,
  testBowlingOptions, testSituation, finishLiveTest, serializeTestState, deserializeTestState,
} from "./test-live.js";
export type { TestAdvanceUntil, TestAdvanceResult, TestBowlingOption, TestSituation } from "./test-live.js";
export { TEST_MODEL } from "./test-model-data.js";
export { scoringContextFor, applyScoringContext } from "./t20i-context.js";
export type { T20Context, ScoringContextId } from "./t20i-context.js";
export { T20I_CONTEXT } from "./t20i-context-data.js";
