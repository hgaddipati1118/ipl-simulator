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
  serializeMatchResult, healInjuries, simulateMatch,
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
  type RuleSet, type SeasonResult, type AuctionResult, type TradeOffer,
  type ScheduledMatch, type MatchResult,
  type SerializableMatchResult, type MatchInjuryEvent,
  type AuctionState,
} from "@ipl-sim/engine";
// Import directly to avoid pulling in snapshot.ts (which uses Node fs/path/url)
import { getRealPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { getWPLPlayers } from "@ipl-sim/ratings/dist/wpl-players.js";

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

  // Retention state
  retentionState?: RetentionState;

  // Live auction state
  auctionLiveState?: AuctionState;
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

  return {
    ...state,
    phase: "season",
    auctionResult: result,
    playerPool: result.unsold,
  };
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

  const schedule = generateSchedule(state.teams, state.rules.matchesPerTeam);

  const firstMatch = schedule[0];
  const userPlays = firstMatch &&
    (firstMatch.homeTeamId === state.userTeamId || firstMatch.awayTeamId === state.userTeamId);

  return {
    ...state,
    schedule,
    currentMatchIndex: 0,
    matchResults: [],
    playoffsStarted: false,
    needsLineup: !!userPlays,
    recentInjuries: [],
  };
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
): GameState {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  if (userTeam) {
    userTeam.userPlayingXI = xiIds;
    userTeam.userBattingOrder = battingOrder;
    userTeam.userBowlingOrder = bowlingOrder;
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

  let newSchedule = [...schedule];
  let newPlayoffsStarted = state.playoffsStarted;
  const newInjuries = rawResult.injuries || [];

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

  return {
    state: {
      ...state,
      schedule: newSchedule,
      currentMatchIndex: newIndex,
      matchResults: newMatchResults,
      playoffsStarted: newPlayoffsStarted,
      needsLineup,
      recentInjuries: newInjuries,
    },
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

  let newSchedule = [...schedule];
  let newPlayoffsStarted = state.playoffsStarted;
  const newInjuries = rawResult.injuries || [];

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

  return {
    state: {
      ...state,
      schedule: newSchedule,
      currentMatchIndex: newIndex,
      matchResults: newMatchResults,
      playoffsStarted: newPlayoffsStarted,
      needsLineup,
      recentInjuries: newInjuries,
    },
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

  const orangeCap = allPlayers.reduce(
    (best, p) => p.stats.runs > best.runs ? { playerId: p.id, runs: p.stats.runs } : best,
    { playerId: "", runs: 0 },
  );
  const purpleCap = allPlayers.reduce(
    (best, p) => p.stats.wickets > best.wickets ? { playerId: p.id, wickets: p.stats.wickets } : best,
    { playerId: "", wickets: 0 },
  );

  const seasonResult: SeasonResult = {
    schedule: state.schedule,
    standings,
    champion,
    orangeCap,
    purpleCap,
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
  // Progress all players (age, ratings)
  for (const team of state.teams) {
    for (const player of team.roster) {
      player.progress();
    }
  }

  // Generate AI trade offers for the user
  const tradeOffers = state.userTeamId
    ? generateAITradeOffers(state.teams, state.userTeamId, 3)
    : [];

  // Add new young players to pool
  const newPlayers = generatePlayerPool(50);

  return {
    ...state,
    phase: "trade",
    seasonNumber: state.seasonNumber + 1,
    seasonResult: null,
    playerPool: [...state.playerPool, ...newPlayers],
    tradeOffers,
    completedTrades: [],
    schedule: [],
    currentMatchIndex: 0,
    matchResults: [],
    playoffsStarted: false,
    needsLineup: false,
    recentInjuries: [],
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
    },
    accepted: result.accepted,
    reason: result.reason ?? "",
    counterOffer: result.counterOffer,
  };
}

/** Finish the trade window and move to retention */
export function finishTrades(state: GameState): GameState {
  return startRetention(state);
}

// ── Retention phase ────────────────────────────────────────────────────

/** Start the retention phase after trade window */
export function startRetention(state: GameState): GameState {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  return {
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
  };
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

  return {
    ...state,
    playerPool: [...state.playerPool, ...releasedToPool],
    retentionState: {
      ...state.retentionState,
      cpuDone: true,
    },
  };
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

  return {
    ...state,
    phase: "auction",
    auctionResult: null,
    auctionLiveState: undefined,
    retentionState: undefined,
  };
}

// ── Live Auction ───────────────────────────────────────────────────────

/** Initialize a live step-by-step auction */
export function initLiveAuction(state: GameState): GameState {
  const auctionConfig = {
    maxRosterSize: state.rules.maxSquadSize,
    maxInternational: state.rules.maxOverseasInSquad,
  };
  const auctionLiveState = engineInitAuction(state.playerPool, state.teams, auctionConfig);
  return {
    ...state,
    auctionLiveState,
  };
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

  return {
    ...state,
    phase: "season",
    auctionResult,
    playerPool: unsold,
    auctionLiveState: undefined,
  };
}

/** Add imported players to the auction pool */
export function addPlayersToPool(state: GameState, players: Player[]): GameState {
  return {
    ...state,
    playerPool: [...state.playerPool, ...players],
  };
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
    return clone;
  });
  return { ...state, teams };
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
