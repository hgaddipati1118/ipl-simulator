/**
 * Central game state management.
 * Persists to localStorage so the game survives page reloads.
 */

import {
  Player, Team, IPL_TEAMS, WPL_TEAMS, TeamConfig,
  generatePlayerPool, createPlayerFromData,
  runAuction, runSeason, retainPlayers,
  DEFAULT_RULES,
  generateAITradeOffers, processTradeOffer, executeTrade,
  generateSchedule, simulateNextMatch, getStandings,
  addPlayoffMatches, addQualifier2, addFinal, applyLiveResult,
  serializeMatchResult, healInjuries, simulateMatch, calculateMVPPoints,
  initAuction as engineInitAuction,
  userBid as engineUserBid,
  userDropBid as engineUserDropBid,
  cpuBidRound as engineCpuBidRound,
  nextPlayer as engineNextPlayer,
  simCurrentPlayer as engineSimCurrentPlayer,
  simRemainingAuction as engineSimRemainingAuction,
  evaluateRetentionSelection,
  RETENTION_BUDGET,
  MAX_RETENTIONS,
  getTrainingCampFatigue,
  type RuleSet, type SeasonResult, type AuctionResult, type TradeOffer,
  type ScheduledMatch, type MatchResult,
  type SerializableMatchResult, type MatchInjuryEvent,
  type AuctionState,
  type NarrativeEvent,
  type TrainingFocus,
  type TrainingIntensity,
  generateYouthProspects,
  type YouthProspect,
  calculateFantasyPoints,
  accumulateFantasyPoints,
  enrichFantasyNames,
  type FantasyPoints,
  generateBoardObjectives,
  evaluateBoardObjectives,
  createBoardState,
  updateBoardState,
  isFired,
  type BoardState,
  updateTeamMorale,
  initSeasonMorale,
  getConsecutiveResults,
  tickContracts,
  assignTeamContracts,
  getExpiringContracts,
  releaseFreeAgents,
  extendContract,
  getContractBadge,
  type ExpiringContractReport,
} from "@ipl-sim/engine";
// Import directly to avoid pulling in snapshot.ts (which uses Node fs/path/url)
import { getRealPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { getWPLPlayers } from "@ipl-sim/ratings/dist/wpl-players.js";
import { buildNarrativeEventsForEngineResult, prependNarrativeEvents, type FeedMatchResult } from "./news-feed";
import {
  boostPlayerScouting,
  boostTeamScouting,
  createScoutingState,
  type ScoutingState,
  syncScoutingState,
} from "./scouting";
import {
  createRecruitmentState,
  type RecruitmentState,
  setRecruitmentTier as setRecruitmentTierState,
  syncRecruitmentState,
  toggleRecruitmentTarget,
  type RecruitmentTier,
} from "./recruitment";

/** Aggregated player season stats for leaderboards */
export interface PlayerSeasonStat {
  playerId: string;
  playerName: string;
  teamId: string;
  matches: number;
  innings: number;
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  notOuts: number;
  highScore: number;
  wickets: number;
  oversBowled: number;
  runsConceded: number;
  catches: number;
}

export interface RetentionState {
  retained: string[];    // player IDs the user chose to keep
  released: string[];    // player IDs the user chose to release
  budget: number;        // remaining retention budget
  totalCost: number;     // total cost of retained players
  costs: Record<string, number>; // retention cost by player ID
  cpuDone: boolean;      // whether CPU teams have done retention
}

export interface GameState {
  phase: "setup" | "auction" | "trade" | "retention" | "season" | "results";
  rules: RuleSet;
  teams: Team[];
  userTeamId: string | null;
  playerPool: Player[];
  auctionResult: AuctionResult | null;
  seasonResult: SeasonResult | null;
  seasonNumber: number;
  history: SeasonSummary[];
  tradeOffers: TradeOffer[];
  completedTrades: CompletedTrade[];

  // Match-by-match season state
  schedule: ScheduledMatch[];
  currentMatchIndex: number;
  matchResults: SerializableMatchResult[];
  playoffsStarted: boolean;

  // Lineup / injuries
  needsLineup: boolean;
  recentInjuries: MatchInjuryEvent[];

  // Post-match narrative events (news feed)
  narrativeEvents: NarrativeEvent[];
  trainingReport: TrainingReportEntry[];
  scouting: ScoutingState;
  recruitment: RecruitmentState;

  // Retention state
  retentionState?: RetentionState;

  // Live auction state
  auctionLiveState?: AuctionState;

  // Youth academy prospects (generated between seasons)
  youthProspects: YouthProspect[];

  // Fantasy points accumulated across the season
  fantasyLeaderboard: FantasyPoints[];

  // Board expectations & management pressure
  boardState?: BoardState;

  // Contract expiry report (populated at season end)
  contractReport?: ExpiringContractReport;
  contractsResolved?: boolean;
}

export interface SeasonSummary {
  seasonNumber: number;
  champion: string;
  orangeCap: { name: string; runs: number };
  purpleCap: { name: string; wickets: number };
  stadiumRating?: number; // user's stadium bowling rating that season
}

export interface CompletedTrade {
  fromTeam: string;
  toTeam: string;
  playersOut: string[];   // names of players sent
  playersIn: string[];    // names of players received
  accepted: boolean;
}

export interface TrainingReportEntry {
  playerId: string;
  playerName: string;
  teamId: string;
  focus: TrainingFocus;
  intensity: TrainingIntensity;
  battingChange: number;
  bowlingChange: number;
  overallChange: number;
  projectedReadiness: number;
}

export type BoardObjectiveId = "win-title" | "make-final" | "make-playoffs" | "stay-competitive";

export interface BoardExpectation {
  teamId: string;
  objective: BoardObjectiveId;
  label: string;
  summary: string;
  targetFinish: number;
}

export interface BoardExpectationStatus {
  label: "Ahead" | "On Track" | "Under Pressure";
  tone: "good" | "info" | "warn";
  detail: string;
  currentPosition: number;
}

function syncStateScouting(state: GameState, seasonNumber = state.seasonNumber): ScoutingState {
  return syncScoutingState(state.scouting, state.teams, state.playerPool, state.userTeamId, seasonNumber);
}

function syncStateRecruitment(state: GameState): RecruitmentState {
  return syncRecruitmentState(state.recruitment, state.teams, state.playerPool);
}

function withSyncedScouting(state: GameState, seasonNumber = state.seasonNumber): GameState {
  return {
    ...state,
    scouting: syncStateScouting(state, seasonNumber),
    recruitment: syncStateRecruitment(state),
  };
}

function generateOffseasonTradeOffers(state: GameState): TradeOffer[] {
  return state.userTeamId
    ? generateAITradeOffers(state.teams, state.userTeamId, 3)
    : [];
}

function refreshUserContractState(state: GameState): GameState {
  const userTeam = state.teams.find(team => team.id === state.userTeamId);
  if (!userTeam) {
    return {
      ...state,
      contractReport: undefined,
      contractsResolved: true,
    };
  }

  const contractReport = getExpiringContracts(userTeam);
  const hasExpiredContracts = contractReport.freeAgents.length > 0;

  if (hasExpiredContracts) {
    return {
      ...state,
      contractReport,
      contractsResolved: false,
      tradeOffers: [],
    };
  }

  if (state.contractsResolved === false) {
    return {
      ...state,
      contractReport,
      contractsResolved: true,
      tradeOffers: generateOffseasonTradeOffers(state),
    };
  }

  return {
    ...state,
    contractReport,
    contractsResolved: true,
  };
}

/** Initialize fresh game state */
export function createGameState(rules: RuleSet = DEFAULT_RULES): GameState {
  const isWPL = rules.league === "wpl";
  const isCustom = rules.league === "custom";
  const allTeamConfigs = [...IPL_TEAMS, ...WPL_TEAMS];
  const activeIds = new Set(rules.teamIds);

  // For preset leagues, filter by league; for custom, use teamIds directly
  const teamConfigs = isCustom
    ? allTeamConfigs.filter(c => activeIds.has(c.id))
    : (isWPL ? WPL_TEAMS : IPL_TEAMS).filter(c => activeIds.has(c.id));
  const teams = teamConfigs.map(config => new Team(config, rules.salaryCap));

  // Load real players based on gender/playerSource settings
  const playerSource = rules.playerSource ?? "real";
  const gender = rules.gender ?? (isWPL ? "women" : "men");

  if (playerSource === "real") {
    const loadMen = gender === "men" || gender === "combined";
    const loadWomen = gender === "women" || gender === "combined";
    const maxBid = isWPL ? 3 : (isCustom ? 15 : 15);

    if (loadMen) {
      const iplPlayers = getRealPlayers();
      for (const data of iplPlayers) {
        if (!activeIds.has(data.teamId)) continue;
        const player = createPlayerFromData(data);
        const team = teams.find(t => t.id === data.teamId);
        // Use real auction/retention price if available, otherwise fall back to marketValue
        const bidPrice = data.bid ?? Math.min(player.marketValue, maxBid);
        if (team) team.addPlayer(player, bidPrice);
      }
    }
    if (loadWomen) {
      const wplPlayers = getWPLPlayers();
      for (const data of wplPlayers) {
        if (!data.teamId || !activeIds.has(data.teamId)) continue;
        const player = createPlayerFromData(data);
        const team = teams.find(t => t.id === data.teamId);
        if (team) team.addPlayer(player, Math.min(player.marketValue, maxBid));
      }
    }
  }
  // If playerSource === "generated", skip real players — auction will fill rosters

  // Generate additional random players to fill rosters
  const poolSize = teams.length <= 5 ? 80 : (teams.length >= 10 ? 200 : 150);
  const additionalPlayers = generatePlayerPool(poolSize);

  return {
    phase: "setup",
    rules,
    teams,
    userTeamId: null,
    playerPool: additionalPlayers,
    auctionResult: null,
    seasonResult: null,
    seasonNumber: 1,
    history: [],
    tradeOffers: [],
    completedTrades: [],
    schedule: [],
    currentMatchIndex: 0,
    matchResults: [],
    playoffsStarted: false,
    needsLineup: false,
    recentInjuries: [],
    narrativeEvents: [],
    trainingReport: [],
    scouting: createScoutingState(teams, additionalPlayers, null, 1),
    recruitment: createRecruitmentState(),
    youthProspects: [],
    fantasyLeaderboard: [],
    contractsResolved: true,
  };
}

/** Run the auction phase */
export function runAuctionPhase(state: GameState): GameState {
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const result = runAuction(state.playerPool, state.teams, auctionConfig);

  // Mark user team as user-controlled
  if (state.userTeamId) {
    const userTeam = state.teams.find(t => t.id === state.userTeamId);
    if (userTeam) {
      userTeam.isUserControlled = true;
    }
  }

  return withSyncedScouting({
    ...state,
    phase: "season",
    auctionResult: result,
    playerPool: result.unsold,
  });
}

/** Run a full season */
export function runSeasonPhase(state: GameState): GameState {
  const result = runSeason(state.teams, state.rules);

  const allPlayers = state.teams.flatMap(t => t.roster);
  const orangePlayer = allPlayers.find(p => p.id === result.orangeCap.playerId);
  const purplePlayer = allPlayers.find(p => p.id === result.purpleCap.playerId);
  const championTeam = state.teams.find(t => t.id === result.champion);

  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const summary: SeasonSummary = {
    seasonNumber: state.seasonNumber,
    champion: championTeam?.name ?? result.champion,
    orangeCap: { name: orangePlayer?.name ?? "Unknown", runs: result.orangeCap.runs },
    purpleCap: { name: purplePlayer?.name ?? "Unknown", wickets: result.purpleCap.wickets },
    stadiumRating: userTeam?.config.stadiumBowlingRating,
  };

  return {
    ...state,
    phase: "results",
    seasonResult: result,
    history: [...state.history, summary],
  };
}

// ── Match-by-match season progression ──────────────────────────────

/** Initialize the season: generate schedule, reset teams, set index to 0 */
export function initSeason(state: GameState): GameState {
  for (const t of state.teams) {
    t.resetSeason();
    if (t.id === state.userTeamId) {
      t.isUserControlled = true;
    }
  }

  // Initialize morale for all teams at season start
  for (const t of state.teams) {
    const retainedIds = new Set(
      state.retentionState?.retained
        ? state.retentionState.retained
        : t.roster.map(p => p.id), // first season: everyone is "retained"
    );
    initSeasonMorale(t, retainedIds);
  }

  // Assign initial contracts for first season
  if (state.seasonNumber === 1) {
    for (const t of state.teams) {
      assignTeamContracts(t, "retained");
    }
  }

  // Generate board objectives for the user's team
  let boardState = state.boardState;
  if (state.userTeamId) {
    const userTeam = state.teams.find(t => t.id === state.userTeamId);
    if (userTeam) {
      const previousPos = state.history.length > 0
        ? state.history[state.history.length - 1].seasonNumber // approximate
        : undefined;
      const objectives = generateBoardObjectives({
        seasonNumber: state.seasonNumber,
        previousPosition: previousPos,
        teamPower: userTeam.powerRating,
      });
      boardState = createBoardState(objectives);
      if (state.boardState) {
        // Carry over satisfaction and warnings from previous season
        boardState.satisfaction = state.boardState.satisfaction;
        boardState.warnings = state.boardState.warnings;
      }
    }
  }

  const schedule = generateSchedule(state.teams, state.rules.matchesPerTeam);

  const firstMatch = schedule[0];
  const userPlays = firstMatch &&
    (firstMatch.homeTeamId === state.userTeamId || firstMatch.awayTeamId === state.userTeamId);

  return withSyncedScouting({
    ...state,
    schedule,
    currentMatchIndex: 0,
    matchResults: [],
    playoffsStarted: false,
    needsLineup: !!userPlays,
    recentInjuries: [],
    narrativeEvents: [],
    boardState,
    contractReport: undefined,
    contractsResolved: true,
    fantasyLeaderboard: [],
  });
}

/** Check if the current match involves the user's team */
export function currentMatchInvolvesUser(state: GameState): boolean {
  if (!state.userTeamId || state.currentMatchIndex >= state.schedule.length) return false;
  const match = state.schedule[state.currentMatchIndex];
  return match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId;
}

/** Set user lineup for their team */
export function setUserLineup(
  state: GameState,
  xiIds: string[],
  battingOrder: string[],
  bowlingOrder: string[],
  bowlingPlan?: import("@ipl-sim/engine").BowlingPlan,
): GameState {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  if (userTeam) {
    userTeam.userPlayingXI = xiIds;
    userTeam.userBattingOrder = battingOrder;
    userTeam.userBowlingOrder = bowlingOrder;
    if (bowlingPlan) {
      userTeam.setBowlingPlan(bowlingPlan);
    }
  }
  return { ...state, needsLineup: false };
}

/** Play the next match in the schedule.
 *  Returns the new state, the serialized summary, and the DetailedMatchResult
 *  (if available) so the caller can persist it to IndexedDB.
 */
export function playNextMatch(state: GameState): {
  state: GameState;
  result: SerializableMatchResult;
  detailed: import("@ipl-sim/engine").DetailedMatchResult | undefined;
  matchIndex: number;
} {
  const { schedule, currentMatchIndex, teams, matchResults } = state;

  const rawResult = simulateNextMatch(schedule, currentMatchIndex, teams, state.rules);
  const serialized = serializeMatchResult(rawResult);

  // Capture detailed result before it's lost
  const detailed = rawResult.detailed;

  // Strip the heavy `detailed` field from the schedule entry's result
  // to keep in-memory / localStorage footprint small.
  // The ScheduledMatch.result is set by simulateNextMatch (mutates schedule),
  // so we remove .detailed from it now.
  const matchEntry = schedule[currentMatchIndex];
  if (matchEntry?.result) {
    delete matchEntry.result.detailed;
  }

  const newMatchResults = [...matchResults, serialized];
  const newIndex = currentMatchIndex + 1;
  const newNarrativeEvents = prependNarrativeEvents(
    state.narrativeEvents,
    buildNarrativeEventsForEngineResult({
      result: rawResult,
      teams,
      userTeamId: state.userTeamId,
      recentResults: newMatchResults as FeedMatchResult[],
    }),
  );

  let newSchedule = [...schedule];
  let newPlayoffsStarted = state.playoffsStarted;
  const newInjuries = rawResult.injuries || [];
  const matchInvolvesUser = !!state.userTeamId &&
    (matchEntry?.homeTeamId === state.userTeamId || matchEntry?.awayTeamId === state.userTeamId);

  const groupCount = schedule.filter(m => m.type === "group").length;
  if (!state.playoffsStarted && newIndex === groupCount) {
    addPlayoffMatches(newSchedule, teams);
    newPlayoffsStarted = true;
  }

  const q1 = newSchedule.find(m => m.playoffType === "qualifier1");
  const elim = newSchedule.find(m => m.playoffType === "eliminator");
  const q2Exists = newSchedule.some(m => m.playoffType === "qualifier2");
  if (q1?.result && elim?.result && !q2Exists) {
    addQualifier2(newSchedule);
  }

  const q2 = newSchedule.find(m => m.playoffType === "qualifier2");
  const finalExists = newSchedule.some(m => m.playoffType === "final");
  if (q1?.result && q2?.result && !finalExists) {
    addFinal(newSchedule);
  }

  let needsLineup = false;
  if (newIndex < newSchedule.length) {
    const nextMatch = newSchedule[newIndex];
    needsLineup = !!(state.userTeamId &&
      (nextMatch.homeTeamId === state.userTeamId || nextMatch.awayTeamId === state.userTeamId));
  }

  // Update morale for both teams involved in this match
  if (rawResult.winnerId && matchEntry) {
    const homeTeam = teams.find(t => t.id === matchEntry.homeTeamId);
    const awayTeam = teams.find(t => t.id === matchEntry.awayTeamId);
    const homeXIIds = new Set(rawResult.innings[0]?.batterStats ? [...rawResult.innings[0].batterStats.keys()] : []);
    const awayXIIds = new Set(rawResult.innings[1]?.batterStats ? [...rawResult.innings[1].batterStats.keys()] : []);

    for (const [team, xiIds] of [[homeTeam, homeXIIds], [awayTeam, awayXIIds]] as [Team | undefined, Set<string>][]) {
      if (!team) continue;
      const streak = getConsecutiveResults(
        newMatchResults.map(r => ({ winnerId: r.winnerId, homeTeamId: r.innings[0]?.teamId ?? "", awayTeamId: r.innings[1]?.teamId ?? "" })),
        team.id,
      );
      updateTeamMorale(team, {
        won: rawResult.winnerId === team.id,
        marginText: rawResult.margin,
        motmPlayerId: rawResult.motm,
        playingXIIds: xiIds,
        consecutiveWins: streak.consecutiveWins,
        consecutiveLosses: streak.consecutiveLosses,
      });
    }
  }

  let nextState: GameState = {
    ...state,
    schedule: newSchedule,
    currentMatchIndex: newIndex,
    matchResults: newMatchResults,
    playoffsStarted: newPlayoffsStarted,
    needsLineup,
    recentInjuries: newInjuries,
    narrativeEvents: newNarrativeEvents,
    scouting: state.scouting,
  };

  if (matchInvolvesUser && matchEntry) {
    const homeIds = nextState.teams.find(team => team.id === matchEntry.homeTeamId)?.roster.map(player => player.id) ?? [];
    const awayIds = nextState.teams.find(team => team.id === matchEntry.awayTeamId)?.roster.map(player => player.id) ?? [];
    nextState = {
      ...nextState,
      scouting: boostPlayerScouting(
        nextState.scouting,
        nextState.teams,
        nextState.playerPool,
        nextState.userTeamId,
        nextState.seasonNumber,
        [...homeIds, ...awayIds],
        10,
      ),
    };
  }

  // Accumulate fantasy points from this match
  const matchFantasyPoints = calculateFantasyPoints(rawResult);
  const playerNameMap = new Map<string, string>();
  for (const team of teams) {
    for (const p of team.roster) playerNameMap.set(p.id, p.name);
  }
  const enrichedMatchPoints = enrichFantasyNames(matchFantasyPoints, playerNameMap);
  nextState = {
    ...nextState,
    fantasyLeaderboard: accumulateFantasyPoints(nextState.fantasyLeaderboard, enrichedMatchPoints),
  };

  return {
    state: withSyncedScouting(nextState),
    result: serialized,
    detailed,
    matchIndex: currentMatchIndex,
  };
}

/** Apply a completed live match to the game state without re-simulating.
 *  Uses the actual ball-by-ball result from the live match viewer.
 */
export function applyLiveMatchToState(
  state: GameState,
  completedMatchState: import("@ipl-sim/engine").MatchState,
  narrativeEvents?: NarrativeEvent[],
): {
  state: GameState;
  result: SerializableMatchResult;
  matchIndex: number;
} {
  const { schedule, currentMatchIndex, teams, matchResults } = state;

  const rawResult = applyLiveResult(schedule, currentMatchIndex, teams, completedMatchState, state.rules);
  const serialized = serializeMatchResult(rawResult);

  // Strip heavy detailed field from schedule entry
  const matchEntry = schedule[currentMatchIndex];
  if (matchEntry?.result) {
    delete matchEntry.result.detailed;
  }

  const newMatchResults = [...matchResults, serialized];
  const newIndex = currentMatchIndex + 1;
  const persistedNarratives = prependNarrativeEvents(
    state.narrativeEvents,
    narrativeEvents ?? buildNarrativeEventsForEngineResult({
      result: rawResult,
      teams,
      userTeamId: state.userTeamId,
      recentResults: newMatchResults as FeedMatchResult[],
    }),
  );

  let newSchedule = [...schedule];
  let newPlayoffsStarted = state.playoffsStarted;
  const newInjuries = rawResult.injuries || [];
  const matchInvolvesUser = !!state.userTeamId &&
    (matchEntry?.homeTeamId === state.userTeamId || matchEntry?.awayTeamId === state.userTeamId);

  const groupCount = schedule.filter(m => m.type === "group").length;
  if (!state.playoffsStarted && newIndex === groupCount) {
    addPlayoffMatches(newSchedule, teams);
    newPlayoffsStarted = true;
  }

  const q1 = newSchedule.find(m => m.playoffType === "qualifier1");
  const elim = newSchedule.find(m => m.playoffType === "eliminator");
  const q2Exists = newSchedule.some(m => m.playoffType === "qualifier2");
  if (q1?.result && elim?.result && !q2Exists) {
    addQualifier2(newSchedule);
  }

  const q2 = newSchedule.find(m => m.playoffType === "qualifier2");
  const finalExists = newSchedule.some(m => m.playoffType === "final");
  if (q1?.result && q2?.result && !finalExists) {
    addFinal(newSchedule);
  }

  let needsLineup = false;
  if (newIndex < newSchedule.length) {
    const nextMatch = newSchedule[newIndex];
    needsLineup = !!(state.userTeamId &&
      (nextMatch.homeTeamId === state.userTeamId || nextMatch.awayTeamId === state.userTeamId));
  }

  let nextState: GameState = {
    ...state,
    schedule: newSchedule,
    currentMatchIndex: newIndex,
    matchResults: newMatchResults,
    playoffsStarted: newPlayoffsStarted,
    needsLineup,
    recentInjuries: newInjuries,
    narrativeEvents: persistedNarratives,
    scouting: state.scouting,
  };

  if (matchInvolvesUser && matchEntry) {
    const homeIds = nextState.teams.find(team => team.id === matchEntry.homeTeamId)?.roster.map(player => player.id) ?? [];
    const awayIds = nextState.teams.find(team => team.id === matchEntry.awayTeamId)?.roster.map(player => player.id) ?? [];
    nextState = {
      ...nextState,
      scouting: boostPlayerScouting(
        nextState.scouting,
        nextState.teams,
        nextState.playerPool,
        nextState.userTeamId,
        nextState.seasonNumber,
        [...homeIds, ...awayIds],
        10,
      ),
    };
  }

  return {
    state: withSyncedScouting(nextState),
    result: serialized,
    matchIndex: currentMatchIndex,
  };
}

/** Simulate multiple matches up to (but not including) targetIndex.
 *  Returns the final state plus an array of detailed results for IndexedDB persistence.
 */
export function simToMatch(
  state: GameState,
  targetIndex: number,
): {
  state: GameState;
  detailedResults: { matchIndex: number; detail: import("@ipl-sim/engine").DetailedMatchResult }[];
} {
  let current = state;
  const detailedResults: { matchIndex: number; detail: import("@ipl-sim/engine").DetailedMatchResult }[] = [];

  while (current.currentMatchIndex < targetIndex && current.currentMatchIndex < current.schedule.length) {
    if (current.needsLineup && currentMatchInvolvesUser(current)) {
      break;
    }
    const { state: newState, detailed, matchIndex } = playNextMatch(current);
    if (detailed) {
      detailedResults.push({ matchIndex, detail: detailed });
    }
    current = newState;
  }
  return { state: current, detailedResults };
}

/** Check if the season is complete (Final has been played) */
export function isSeasonComplete(state: GameState): boolean {
  const final_match = state.schedule.find(m => m.playoffType === "final");
  return !!final_match?.result;
}

/** Check if group stage is complete */
export function isGroupStageComplete(state: GameState): boolean {
  const groupCount = state.schedule.filter(m => m.type === "group").length;
  return state.currentMatchIndex >= groupCount;
}

/** Get the next match to be played, or null if season complete */
export function getNextMatch(state: GameState): ScheduledMatch | null {
  if (state.currentMatchIndex >= state.schedule.length) return null;
  return state.schedule[state.currentMatchIndex];
}

/** Build aggregated player stats from team roster stats */
export function getPlayerSeasonStats(teams: Team[]): PlayerSeasonStat[] {
  const stats: PlayerSeasonStat[] = [];
  for (const team of teams) {
    for (const p of team.roster) {
      if (p.stats.matches > 0) {
        stats.push({
          playerId: p.id,
          playerName: p.name,
          teamId: team.id,
          matches: p.stats.matches,
          innings: p.stats.innings,
          runs: p.stats.runs,
          ballsFaced: p.stats.ballsFaced,
          fours: p.stats.fours,
          sixes: p.stats.sixes,
          notOuts: p.stats.notOuts,
          highScore: p.stats.highScore,
          wickets: p.stats.wickets,
          oversBowled: p.stats.overs,
          runsConceded: p.stats.runsConceded,
          catches: p.stats.catches,
        });
      }
    }
  }
  return stats;
}

/** Complete the season and generate SeasonResult for the results page */
export function finalizeSeason(state: GameState): GameState {
  const allPlayers = state.teams.flatMap(t => t.roster);
  const finalMatch = state.schedule.find(m => m.playoffType === "final");
  const standings = getStandings(state.teams);
  const champion = finalMatch?.result?.winnerId || standings[0]?.teamId || "";

  // Orange Cap: most runs, tiebreaker = higher strike rate
  const orangeCap = allPlayers.reduce(
    (best, p) => {
      const sr = p.stats.ballsFaced > 0 ? (p.stats.runs / p.stats.ballsFaced) * 100 : 0;
      if (p.stats.runs > best.runs) return { playerId: p.id, name: p.name, runs: p.stats.runs, strikeRate: sr };
      if (p.stats.runs === best.runs && sr > best.strikeRate) return { playerId: p.id, name: p.name, runs: p.stats.runs, strikeRate: sr };
      return best;
    },
    { playerId: "", name: "", runs: 0, strikeRate: 0 },
  );

  // Purple Cap: most wickets, tiebreaker = lower economy rate
  const purpleCap = allPlayers.reduce(
    (best, p) => {
      const intOvers = Math.floor(p.stats.overs);
      const fracBalls = Math.round((p.stats.overs - intOvers) * 10);
      const totalOvers = intOvers + fracBalls / 6;
      const econ = totalOvers > 0 ? p.stats.runsConceded / totalOvers : 99;
      if (p.stats.wickets > best.wickets) return { playerId: p.id, name: p.name, wickets: p.stats.wickets, economy: econ };
      if (p.stats.wickets === best.wickets && econ < best.economy) return { playerId: p.id, name: p.name, wickets: p.stats.wickets, economy: econ };
      return best;
    },
    { playerId: "", name: "", wickets: 0, economy: 99 },
  );

  // MVP points accumulation across all matches
  const playerIdNameMap = allPlayers.map(p => ({ id: p.id, name: p.name }));
  const mvpAccumulator = new Map<string, { name: string; points: number }>();
  for (const match of state.schedule) {
    if (!match.result) continue;
    const matchMVP = calculateMVPPoints(match.result, playerIdNameMap);
    for (const entry of matchMVP) {
      const prev = mvpAccumulator.get(entry.playerId);
      if (prev) {
        prev.points += entry.points;
      } else {
        mvpAccumulator.set(entry.playerId, { name: entry.playerName, points: entry.points });
      }
    }
  }
  let mvp = { name: "", points: 0 };
  for (const [, entry] of mvpAccumulator) {
    if (entry.points > mvp.points) {
      mvp = { name: entry.name, points: Math.round(entry.points * 10) / 10 };
    }
  }

  const seasonResult: SeasonResult = {
    schedule: state.schedule,
    standings,
    champion,
    orangeCap,
    purpleCap,
    mvp,
  };

  const orangePlayer = allPlayers.find(p => p.id === orangeCap.playerId);
  const purplePlayer = allPlayers.find(p => p.id === purpleCap.playerId);
  const championTeam = state.teams.find(t => t.id === champion);

  const userTeamForSummary = state.teams.find(t => t.id === state.userTeamId);
  const summary: SeasonSummary = {
    seasonNumber: state.seasonNumber,
    champion: championTeam?.name ?? champion,
    orangeCap: { name: orangePlayer?.name ?? "Unknown", runs: orangeCap.runs },
    purpleCap: { name: purplePlayer?.name ?? "Unknown", wickets: purpleCap.wickets },
    stadiumRating: userTeamForSummary?.config.stadiumBowlingRating,
  };

  return {
    ...state,
    phase: "results",
    seasonResult,
    history: [...state.history, summary],
  };
}

// ── End match-by-match progression ─────────────────────────────────

/** Progress players, run retention, enter trade window */
export function nextSeason(state: GameState): GameState {
  const trainingReport: TrainingReportEntry[] = [];

  // Progress all players (age, ratings)
  for (const team of state.teams) {
    for (const player of team.roster) {
      const progress = player.progress({
        focus: player.trainingFocus,
        intensity: team.trainingIntensity,
      });
      trainingReport.push({
        playerId: player.id,
        playerName: player.name,
        teamId: team.id,
        focus: progress.focus,
        intensity: progress.intensity,
        battingChange: progress.battingChange,
        bowlingChange: progress.bowlingChange,
        overallChange: progress.overallChange,
        projectedReadiness: Math.max(0, 100 - getTrainingCampFatigue(progress.focus, team.trainingIntensity)),
      });
    }
  }

  // Add new young players to pool
  const newPlayers = generatePlayerPool(50);

  // Generate youth academy prospects for the user's team (1-3 players)
  const youthProspects: YouthProspect[] = state.userTeamId
    ? generateYouthProspects(state.userTeamId, 1 + Math.floor(Math.random() * 3))
    : [];

  // Tick contracts for all teams, collect expiry report for user
  let contractReport: ExpiringContractReport | undefined;
  const releasedFreeAgents: Player[] = [];
  for (const team of state.teams) {
    const report = tickContracts(team);
    if (team.id === state.userTeamId) {
      contractReport = report;
    } else {
      releasedFreeAgents.push(...releaseFreeAgents(team));
    }
  }

  const userHasExpiredContracts = (contractReport?.freeAgents.length ?? 0) > 0;
  const tradeOffers = userHasExpiredContracts ? [] : generateOffseasonTradeOffers(state);

  // Evaluate board objectives at season end
  let boardState = state.boardState;
  if (boardState && state.seasonResult && state.userTeamId) {
    const userTeam = state.teams.find(t => t.id === state.userTeamId);
    if (userTeam) {
      const standings = getStandings(state.teams);
      const finalPosition = standings.findIndex(s => s.teamId === state.userTeamId) + 1;
      const youthCount = userTeam.roster.filter(
        p => p.age <= 23 && p.stats.matches >= 5,
      ).length;
      const evaluation = evaluateBoardObjectives({
        objectives: boardState.objectives,
        finalPosition,
        isChampion: state.seasonResult.champion === state.userTeamId,
        youthMatchesGiven: youthCount,
        currentNRR: userTeam.nrr,
        previousNRR: undefined,
        totalTeams: state.teams.length,
      });
      boardState = updateBoardState(boardState, evaluation);
    }
  }

  return withSyncedScouting({
    ...state,
    phase: "trade",
    seasonNumber: state.seasonNumber + 1,
    seasonResult: null,
    playerPool: [...state.playerPool, ...newPlayers, ...releasedFreeAgents],
    tradeOffers,
    completedTrades: [],
    schedule: [],
    currentMatchIndex: 0,
    matchResults: [],
    playoffsStarted: false,
    needsLineup: false,
    recentInjuries: [],
    narrativeEvents: [],
    trainingReport,
    youthProspects,
    fantasyLeaderboard: [],
    boardState,
    contractReport,
    contractsResolved: !userHasExpiredContracts,
  }, state.seasonNumber + 1);
}

/** Promote a youth prospect to the user's main squad (costs 0 Cr, takes a roster slot) */
export function promoteYouthProspect(state: GameState, prospectIndex: number): GameState {
  if (!state.userTeamId) return state;
  const prospect = state.youthProspects[prospectIndex];
  if (!prospect) return state;

  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  if (!userTeam) return state;

  // Add the prospect player to the team roster
  const player = prospect.player;
  player.teamId = state.userTeamId;
  player.potential = prospect.potential;
  userTeam.addPlayer(player, 0); // Free signing

  // Remove from prospects list
  const newProspects = [...state.youthProspects];
  newProspects.splice(prospectIndex, 1);

  return { ...state, youthProspects: newProspects };
}

export function setPlayerTrainingFocus(
  state: GameState,
  playerId: string,
  focus: TrainingFocus,
): GameState {
  let changed = false;
  const teams = state.teams.map(team => {
    const player = team.roster.find(rosterPlayer => rosterPlayer.id === playerId);
    if (!player) return team;
    player.trainingFocus = focus;
    changed = true;
    return team;
  });

  return changed ? { ...state, teams } : state;
}

export function setTeamTrainingIntensity(
  state: GameState,
  teamId: string,
  intensity: TrainingIntensity,
): GameState {
  let changed = false;
  const teams = state.teams.map(team => {
    if (team.id !== teamId) return team;
    team.trainingIntensity = intensity;
    changed = true;
    return team;
  });

  return changed ? { ...state, teams } : state;
}

export function recordPlayerScoutingExposure(
  state: GameState,
  playerIds: string[],
  amount = 8,
): GameState {
  return {
    ...state,
    scouting: boostPlayerScouting(
      state.scouting,
      state.teams,
      state.playerPool,
      state.userTeamId,
      state.seasonNumber,
      playerIds,
      amount,
    ),
  };
}

export function recordTeamScoutingExposure(
  state: GameState,
  teamId: string,
  amount = 8,
): GameState {
  return {
    ...state,
    scouting: boostTeamScouting(
      state.scouting,
      state.teams,
      state.playerPool,
      state.userTeamId,
      state.seasonNumber,
      teamId,
      amount,
    ),
  };
}

export function setRecruitmentTier(
  state: GameState,
  playerId: string,
  tier: RecruitmentTier | null,
): GameState {
  return {
    ...state,
    recruitment: setRecruitmentTierState(state.recruitment, playerId, tier, state.seasonNumber),
  };
}

export function toggleShortlistPlayer(
  state: GameState,
  playerId: string,
): GameState {
  return {
    ...state,
    recruitment: toggleRecruitmentTarget(state.recruitment, playerId, "shortlist", state.seasonNumber),
  };
}

export function toggleWatchlistPlayer(
  state: GameState,
  playerId: string,
): GameState {
  return {
    ...state,
    recruitment: toggleRecruitmentTarget(state.recruitment, playerId, "watchlist", state.seasonNumber),
  };
}

export function getBoardExpectation(state: GameState): BoardExpectation | null {
  const userTeam = state.teams.find(team => team.id === state.userTeamId);
  if (!userTeam) return null;

  const playoffCutoff = Math.max(2, Math.min(state.teams.length, state.rules.playoffTeams || 4));
  const defendingChampions = state.history.some(summary => summary.champion === userTeam.name);
  const power = userTeam.powerRating;

  if (defendingChampions || power >= 86) {
    return {
      teamId: userTeam.id,
      objective: "win-title",
      label: "Win the title",
      summary: "The board expects a trophy push from this squad.",
      targetFinish: 1,
    };
  }

  if (power >= 80) {
    return {
      teamId: userTeam.id,
      objective: "make-final",
      label: "Reach the final",
      summary: "This squad is strong enough that a deep playoff run is the baseline.",
      targetFinish: 2,
    };
  }

  if (power >= 73) {
    return {
      teamId: userTeam.id,
      objective: "make-playoffs",
      label: "Make the playoffs",
      summary: "The board wants a credible top-table season, not another rebuild year.",
      targetFinish: playoffCutoff,
    };
  }

  return {
    teamId: userTeam.id,
    objective: "stay-competitive",
    label: "Stay competitive",
    summary: "The board wants progress and a live playoff chase into the back half of the season.",
    targetFinish: Math.min(state.teams.length, playoffCutoff + 2),
  };
}

export function getBoardExpectationStatus(
  state: GameState,
  expectation: BoardExpectation | null = getBoardExpectation(state),
): BoardExpectationStatus | null {
  if (!expectation) return null;

  const standings = getStandings(state.teams);
  const currentPosition = standings.findIndex(entry => entry.teamId === expectation.teamId) + 1;
  const userTeam = state.teams.find(team => team.id === expectation.teamId);
  const matchesPlayed = userTeam?.matchesPlayed ?? 0;
  const slack = matchesPlayed < 6 ? 2 : matchesPlayed < 10 ? 1 : 0;

  if (currentPosition < expectation.targetFinish) {
    return {
      label: "Ahead",
      tone: "good",
      detail: `The board objective is ${expectation.label.toLowerCase()}, and the club is currently ahead of that pace.`,
      currentPosition,
    };
  }

  if (currentPosition <= expectation.targetFinish + slack) {
    return {
      label: "On Track",
      tone: "info",
      detail: `The club is sitting at #${currentPosition}. The objective is still reachable if the current level holds.`,
      currentPosition,
    };
  }

  return {
    label: "Under Pressure",
    tone: "warn",
    detail: `The board objective is ${expectation.label.toLowerCase()}, but #${currentPosition} is now behind schedule.`,
    currentPosition,
  };
}

/** User responds to an incoming AI trade offer */
export function respondToTradeOffer(
  state: GameState,
  offerId: string,
  accept: boolean,
): GameState {
  const offer = state.tradeOffers.find(o => o.id === offerId);
  if (!offer || offer.status !== "pending") return state;

  const fromTeam = state.teams.find(t => t.id === offer.fromTeamId);
  const toTeam = state.teams.find(t => t.id === offer.toTeamId);
  if (!fromTeam || !toTeam) return state;

  const playersOffered = offer.playersOffered
    .map(id => fromTeam.roster.find(p => p.id === id))
    .filter((p): p is Player => !!p);
  const playersRequested = offer.playersRequested
    .map(id => toTeam.roster.find(p => p.id === id))
    .filter((p): p is Player => !!p);

  const completedTrade: CompletedTrade = {
    fromTeam: fromTeam.name,
    toTeam: toTeam.name,
    playersOut: playersRequested.map(p => p.name),
    playersIn: playersOffered.map(p => p.name),
    accepted: accept,
  };

  if (accept) {
    executeTrade(fromTeam, toTeam, playersOffered, playersRequested);
    offer.status = "accepted";
  } else {
    offer.status = "rejected";
  }

  return {
    ...state,
    tradeOffers: [...state.tradeOffers],
    completedTrades: [...state.completedTrades, completedTrade],
    scouting: boostPlayerScouting(
      state.scouting,
      state.teams,
      state.playerPool,
      state.userTeamId,
      state.seasonNumber,
      [...offer.playersOffered, ...offer.playersRequested],
      8,
    ),
  };
}

/** User proposes a trade to an AI team */
export function proposeUserTrade(
  state: GameState,
  toTeamId: string,
  userPlayerIds: string[],
  targetPlayerIds: string[],
): { state: GameState; accepted: boolean; reason: string; counterOffer?: TradeOffer } {
  if (!state.userTeamId) return { state, accepted: false, reason: "No user team" };

  const offer: TradeOffer = {
    id: `user_trade_${Date.now()}`,
    fromTeamId: state.userTeamId,
    toTeamId,
    playersOffered: userPlayerIds,
    playersRequested: targetPlayerIds,
    status: "pending",
  };

  const result = processTradeOffer(offer, state.teams);

  const fromTeam = state.teams.find(t => t.id === state.userTeamId);
  const toTeam = state.teams.find(t => t.id === toTeamId);

  const completedTrade: CompletedTrade = {
    fromTeam: fromTeam?.name ?? "",
    toTeam: toTeam?.name ?? "",
    playersOut: userPlayerIds.map(id => fromTeam?.roster.find(p => p.id === id)?.name ?? id),
    playersIn: targetPlayerIds.map(id => toTeam?.roster.find(p => p.id === id)?.name ?? id),
    accepted: result.accepted,
  };

  return {
    state: {
      ...state,
      completedTrades: [...state.completedTrades, completedTrade],
      scouting: boostPlayerScouting(
        state.scouting,
        state.teams,
        state.playerPool,
        state.userTeamId,
        state.seasonNumber,
        [...userPlayerIds, ...targetPlayerIds],
        10,
      ),
    },
    accepted: result.accepted,
    reason: result.reason ?? "",
    counterOffer: result.counterOffer,
  };
}

/** Finish the trade window and move to retention */
export function finishTrades(state: GameState): GameState {
  return startRetention(releaseExpiredUserContracts(state));
}

export function extendUserPlayerContract(
  state: GameState,
  playerId: string,
  years: number,
): GameState {
  if (!state.userTeamId || years <= 0) return state;
  const userTeam = state.teams.find(team => team.id === state.userTeamId);
  const player = userTeam?.roster.find(rosterPlayer => rosterPlayer.id === playerId);
  if (!player) return state;

  extendContract(player, years);
  return withSyncedScouting(refreshUserContractState(state));
}

export function releaseExpiredUserContracts(state: GameState): GameState {
  if (!state.userTeamId) return state;
  const userTeam = state.teams.find(team => team.id === state.userTeamId);
  if (!userTeam) return state;

  const releasedPlayers = releaseFreeAgents(userTeam);
  if (releasedPlayers.length === 0) {
    return withSyncedScouting(refreshUserContractState(state));
  }

  for (const player of releasedPlayers) {
    player.contractYears = 0;
  }

  return withSyncedScouting(
    refreshUserContractState({
      ...state,
      playerPool: [...state.playerPool, ...releasedPlayers],
    }),
  );
}

// ── Retention phase ────────────────────────────────────────────────────

/** Start the retention phase after trade window */
export function startRetention(state: GameState): GameState {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  return withSyncedScouting({
    ...state,
    phase: "retention",
    retentionState: {
      retained: [],
      released: userTeam?.roster.map(player => player.id) ?? [],
      budget: RETENTION_BUDGET,
      totalCost: 0,
      costs: {},
      cpuDone: false,
    },
  });
}

/** Toggle a player between retained/released */
export function togglePlayerRetention(state: GameState, playerId: string): GameState {
  if (!state.retentionState) return state;

  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  if (!userTeam) return state;

  const player = userTeam.roster.find(p => p.id === playerId);
  if (!player) return state;

  const nextRetained = state.retentionState.retained.includes(playerId)
    ? state.retentionState.retained.filter(id => id !== playerId)
    : [...state.retentionState.retained, playerId];

  const retainedPlayers = nextRetained
    .map(id => userTeam.roster.find(p => p.id === id))
    .filter((p): p is Player => p !== undefined);
  const evaluation = evaluateRetentionSelection(retainedPlayers, RETENTION_BUDGET, MAX_RETENTIONS);
  if (!evaluation.valid) return state;

  const costs = Object.fromEntries(
    evaluation.retentionCosts.map(entry => [entry.player.id, entry.cost]),
  );
  const released = userTeam.roster
    .filter(teamPlayer => !nextRetained.includes(teamPlayer.id))
    .map(teamPlayer => teamPlayer.id);

  return {
    ...state,
    retentionState: {
      ...state.retentionState,
      retained: nextRetained,
      released,
      budget: evaluation.remainingBudget,
      totalCost: evaluation.totalCost,
      costs,
    },
  };
}

/** Run CPU team retentions */
export function runCPURetentions(state: GameState): GameState {
  if (!state.retentionState || state.retentionState.cpuDone) return state;

  const releasedToPool: Player[] = [];

  for (const team of state.teams) {
    if (team.id === state.userTeamId) continue;
    const { released } = retainPlayers(team, RETENTION_BUDGET, MAX_RETENTIONS);
    releasedToPool.push(...released);
  }

  return withSyncedScouting({
    ...state,
    playerPool: [...state.playerPool, ...releasedToPool],
    retentionState: {
      ...state.retentionState,
      cpuDone: true,
    },
  });
}

/** Finish retention and start auction */
export function finishRetention(state: GameState): GameState {
  if (!state.retentionState) return state;

  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  if (userTeam) {
    const { retained } = state.retentionState;
    const retainedPlayers = retained
      .map(id => userTeam.roster.find(player => player.id === id))
      .filter((player): player is Player => player !== undefined);
    const evaluation = evaluateRetentionSelection(retainedPlayers, RETENTION_BUDGET, MAX_RETENTIONS);
    if (!evaluation.valid) return state;

    const retainedSet = new Set(retained);
    const costByPlayerId = new Map(evaluation.retentionCosts.map(entry => [entry.player.id, entry.cost]));
    const released: Player[] = [];
    const kept: Player[] = [];

    for (const p of userTeam.roster) {
      if (retainedSet.has(p.id)) {
        p.teamId = userTeam.id;
        p.bid = costByPlayerId.get(p.id) ?? 0;
        kept.push(p);
      } else {
        p.teamId = undefined;
        p.bid = 0;
        released.push(p);
      }
    }

    userTeam.roster = kept;
    userTeam.totalSpent = evaluation.totalCost;

    state = {
      ...state,
      playerPool: [...state.playerPool, ...released],
    };
  }

  return withSyncedScouting({
    ...state,
    phase: "auction",
    auctionResult: null,
    auctionLiveState: undefined,
    retentionState: undefined,
  });
}

// ── Live Auction ───────────────────────────────────────────────────────

/** Initialize a live step-by-step auction */
export function initLiveAuction(state: GameState): GameState {
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const auctionLiveState = engineInitAuction(state.playerPool, state.teams, auctionConfig);
  return withSyncedScouting({
    ...state,
    auctionLiveState,
  });
}

/** User bids on the current player in live auction */
export function liveAuctionUserBid(state: GameState): GameState {
  if (!state.auctionLiveState || !state.userTeamId) return state;
  const next = engineUserBid(state.auctionLiveState, state.teams, state.userTeamId);
  return { ...state, auctionLiveState: next };
}

/** User passes on the current player in live auction */
export function liveAuctionUserPass(state: GameState): GameState {
  if (!state.auctionLiveState || !state.userTeamId) return state;
  const next = engineUserDropBid(state.auctionLiveState, state.userTeamId);
  return { ...state, auctionLiveState: next };
}

/** Run one CPU bid round in live auction */
export function liveAuctionCpuRound(state: GameState): GameState {
  if (!state.auctionLiveState) return state;
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const next = engineCpuBidRound(state.auctionLiveState, state.teams, auctionConfig);
  return { ...state, auctionLiveState: next };
}

/** Move to the next player in live auction */
export function liveAuctionNextPlayer(state: GameState): GameState {
  if (!state.auctionLiveState) return state;
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const next = engineNextPlayer(state.auctionLiveState, state.teams, auctionConfig);
  return { ...state, auctionLiveState: next };
}

/** Simulate current player to completion in live auction */
export function liveAuctionSimPlayer(state: GameState): GameState {
  if (!state.auctionLiveState) return state;
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const next = engineSimCurrentPlayer(state.auctionLiveState, state.teams, auctionConfig);
  return { ...state, auctionLiveState: next };
}

/** Simulate all remaining players in live auction */
export function liveAuctionSimRemaining(state: GameState): GameState {
  if (!state.auctionLiveState) return state;
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const next = engineSimRemainingAuction(state.auctionLiveState, state.teams, auctionConfig);
  return { ...state, auctionLiveState: next };
}

/** Finalize the live auction: update game state with results */
export function finalizeLiveAuction(state: GameState): GameState {
  if (!state.auctionLiveState) return state;
  const { completedBids, unsold } = state.auctionLiveState;

  // Mark user team as user-controlled
  if (state.userTeamId) {
    const userTeam = state.teams.find(t => t.id === state.userTeamId);
    if (userTeam) userTeam.isUserControlled = true;
  }

  const auctionResult: AuctionResult = {
    bids: completedBids,
    unsold: unsold,
  };

  return withSyncedScouting({
    ...state,
    phase: "season",
    auctionResult,
    playerPool: unsold,
    auctionLiveState: undefined,
  });
}

/** Add imported players to the auction pool */
export function addPlayersToPool(state: GameState, players: Player[]): GameState {
  return withSyncedScouting({
    ...state,
    playerPool: [...state.playerPool, ...players],
  });
}

/** Replace a team's roster with imported players */
export function replaceTeamRoster(
  state: GameState,
  teamId: string,
  players: Player[],
  totalSpent: number,
): GameState {
  const teams = state.teams.map(t => {
    if (t.id !== teamId) return t;
    // Reassign all players to this team
    for (const p of players) {
      p.teamId = teamId;
    }
    const clone = new Team(t.config, t.salaryCap);
    clone.roster = players;
    clone.totalSpent = totalSpent;
    clone.wins = t.wins; clone.losses = t.losses; clone.ties = t.ties;
    clone.nrr = t.nrr; clone.runsFor = t.runsFor; clone.ballsFacedFor = t.ballsFacedFor;
    clone.runsAgainst = t.runsAgainst; clone.ballsFacedAgainst = t.ballsFacedAgainst;
    clone.trainingIntensity = t.trainingIntensity;
    return clone;
  });
  return withSyncedScouting({ ...state, teams });
}

/** Update a team's stadium bowling rating */
export function updateStadiumRating(state: GameState, teamId: string, rating: number): GameState {
  const teams = state.teams.map(t => {
    if (t.id !== teamId) return t;
    t.config = { ...t.config, stadiumBowlingRating: rating };
    return t;
  });
  return { ...state, teams };
}

// Persistence is handled by storage.ts (IndexedDB + localStorage hybrid)
export {
  saveState, loadState, clearState, exportSave, importSave,
  listSaveSlots, getActiveSlotId, setActiveSlotId,
  loadStateFromSlot, deleteSaveSlot, createSaveSlot,
  importCustomPlayers, importTeamRoster, detectImportType,
} from "./storage.js";
export type { SaveSlotInfo } from "./storage.js";
