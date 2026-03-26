/**
 * Season schedule generator and standings management.
 * Ported from IndianCricketLeague/ScheduleClass.js
 *
 * Supports both full-season simulation (runSeason) and
 * match-by-match progression (generateSchedule + simulateNextMatch).
 */

import { Team } from "./team.js";
import { MatchResult, simulateMatch, calculateMVPPoints, type InningsScore, type MatchInjuryEvent } from "./match.js";
import { Player } from "./player.js";
import { shuffle } from "./math.js";
import { DEFAULT_RULES, IPL_10_TEAM_IDS, type RuleSet } from "./rules.js";
import { healInjuries, runPostMatchInjuryChecks } from "./injury.js";
import type { MatchState } from "./live-match.js";

export type PlayoffMatchType = "qualifier1" | "eliminator" | "qualifier2" | "semi1" | "semi2" | "final";
export type MatchType = "group" | PlayoffMatchType;

export interface ScheduledMatch {
  matchNumber: number;
  homeTeamId: string;
  awayTeamId: string;
  result?: MatchResult;
  isPlayoff: boolean;
  playoffType?: PlayoffMatchType;
  type: MatchType;
}

export interface StandingsEntry {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  points: number;
  nrr: number;
  wicketsTaken: number;
  wicketsPerBall: number;
}

export interface SeasonResult {
  schedule: ScheduledMatch[];
  standings: StandingsEntry[];
  champion: string;
  orangeCap: { playerId: string; name: string; runs: number; strikeRate: number };
  purpleCap: { playerId: string; name: string; wickets: number; economy: number };
  mvp: { name: string; points: number };
}

/** Serializable version of MatchResult for storage (Maps converted to plain objects) */
export interface SerializableMatchResult {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  tossWinner: string;
  tossDecision: "bat" | "bowl";
  innings: [SerializableInningsScore, SerializableInningsScore];
  superOver?: [SerializableInningsScore, SerializableInningsScore];
  winnerId: string | null;
  margin: string;
  motm: string;
}

interface PlayerWorkload {
  ballsFaced: number;
  oversBowled: number;
}

const OFFICIAL_IPL_GROUP_A = ["mi", "kkr", "rr", "dc", "lsg"] as const;
const OFFICIAL_IPL_GROUP_B = ["csk", "srh", "rcb", "pbks", "gt"] as const;

function usesOfficialModernIPLMatrix(teams: Team[], matchesPerTeam: number): boolean {
  if (teams.length !== 10 || matchesPerTeam !== 14) return false;
  const ids = new Set(teams.map(team => team.id));
  return IPL_10_TEAM_IDS.every(id => ids.has(id));
}

function getNRRBallDenominator(
  innings: Pick<InningsScore, "wickets" | "totalBalls">,
  maxBalls = 120,
): number {
  if (innings.wickets >= 10 && innings.totalBalls < maxBalls) {
    return maxBalls;
  }
  return innings.totalBalls;
}

function getBattingInnings(result: MatchResult, teamId: string): InningsScore | undefined {
  return result.innings.find(innings => innings.teamId === teamId);
}

function getBowlingInnings(result: MatchResult, teamId: string): InningsScore | undefined {
  return result.innings.find(innings => innings.teamId !== teamId);
}

function getPlayingXIIds(result: MatchResult, teamId: string): Set<string> {
  return new Set(getBattingInnings(result, teamId)?.batterStats.keys() ?? []);
}

function getPlayerWorkload(result: MatchResult, teamId: string): Map<string, PlayerWorkload> {
  const workloads = new Map<string, PlayerWorkload>();
  const battingInnings = getBattingInnings(result, teamId);
  const bowlingInnings = getBowlingInnings(result, teamId);

  if (battingInnings) {
    for (const [playerId, stats] of battingInnings.batterStats) {
      workloads.set(playerId, {
        ballsFaced: stats.balls,
        oversBowled: workloads.get(playerId)?.oversBowled ?? 0,
      });
    }
  }

  if (bowlingInnings) {
    for (const [playerId, stats] of bowlingInnings.bowlerStats) {
      workloads.set(playerId, {
        ballsFaced: workloads.get(playerId)?.ballsFaced ?? 0,
        oversBowled: stats.overs + stats.balls / 6,
      });
    }
  }

  return workloads;
}

function applyPostMatchCondition(result: MatchResult, teams: Team[]): void {
  const involvedTeamIds = new Set([result.homeTeamId, result.awayTeamId]);

  for (const team of teams) {
    if (!involvedTeamIds.has(team.id)) {
      // Full rest day — team not playing
      for (const player of team.roster) {
        player.recoverCondition(5);
      }
      continue;
    }

    const xiIds = getPlayingXIIds(result, team.id);
    const workloads = getPlayerWorkload(result, team.id);

    for (const player of team.roster) {
      if (!xiIds.has(player.id)) {
        // Benched — light recovery (traveled with team, trained lightly)
        player.recoverCondition(3);
        continue;
      }

      const workload = workloads.get(player.id) ?? { ballsFaced: 0, oversBowled: 0 };
      player.applyMatchWorkload({
        ballsFaced: workload.ballsFaced,
        oversBowled: workload.oversBowled,
        keptWicket: player.isWicketKeeper,
      });
    }
  }
}

function updateLiveMatchForm(result: MatchResult, teams: Team[]): void {
  for (const team of teams) {
    if (team.id !== result.homeTeamId && team.id !== result.awayTeamId) continue;

    const battingInnings = getBattingInnings(result, team.id);
    const bowlingInnings = getBowlingInnings(result, team.id);
    if (!battingInnings || !bowlingInnings) continue;

    for (const playerId of getPlayingXIIds(result, team.id)) {
      const player = team.roster.find(candidate => candidate.id === playerId);
      if (!player) continue;

      const batting = battingInnings.batterStats.get(playerId);
      const bowling = bowlingInnings.bowlerStats.get(playerId);
      const runs = batting?.runs ?? 0;
      const balls = batting?.balls ?? 0;
      const wickets = bowling?.wickets ?? 0;
      const overs = bowling ? bowling.overs + bowling.balls / 6 : 0;
      const economy = overs > 0 ? bowling!.runs / overs : 99;
      const strikeRate = balls > 0 ? (runs / balls) * 100 : 0;

      player.recordMatchPerformance(Player.calculateFormScore({
        runs,
        wickets,
        strikeRate,
        economy,
      }));
    }
  }
}

export interface SerializableInningsScore {
  teamId: string;
  runs: number;
  wickets: number;
  overs: number;
  balls: number;
  totalBalls: number;
  extras: number;
  fours: number;
  sixes: number;
  batterStats: Record<string, { runs: number; balls: number; fours: number; sixes: number; isOut: boolean }>;
  bowlerStats: Record<string, { overs: number; balls: number; runs: number; wickets: number; wides: number; noballs: number }>;
}

/** Convert a MatchResult (with Maps) to a serializable form (with plain objects) */
export function serializeMatchResult(result: MatchResult): SerializableMatchResult {
  const serializeInnings = (inn: MatchResult["innings"][0]): SerializableInningsScore => ({
    teamId: inn.teamId,
    runs: inn.runs,
    wickets: inn.wickets,
    overs: inn.overs,
    balls: inn.balls,
    totalBalls: inn.totalBalls,
    extras: inn.extras,
    fours: inn.fours,
    sixes: inn.sixes,
    batterStats: Object.fromEntries(inn.batterStats),
    bowlerStats: Object.fromEntries(inn.bowlerStats),
  });

  return {
    id: result.id,
    homeTeamId: result.homeTeamId,
    awayTeamId: result.awayTeamId,
    tossWinner: result.tossWinner,
    tossDecision: result.tossDecision,
    innings: [serializeInnings(result.innings[0]), serializeInnings(result.innings[1])],
    superOver: result.superOver
      ? [serializeInnings(result.superOver[0]), serializeInnings(result.superOver[1])]
      : undefined,
    winnerId: result.winnerId,
    margin: result.margin,
    motm: result.motm,
  };
}

/**
 * Generate IPL-style schedule (70 group matches for 10 teams).
 * Each team plays 14 matches: 7 home, 7 away.
 * Returns the schedule array without any results — ready for match-by-match simulation.
 */
/**
 * Spread fixtures so no team plays back-to-back and reverse fixtures
 * (A vs B / B vs A) are separated. Uses greedy slot-filling with
 * multiple retry shuffles for best result.
 */
function spreadFixtures(fixtures: Array<[string, string]>): Array<[string, string]> {
  const n = fixtures.length;
  if (n <= 1) return fixtures;

  const pairKey = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;

  let bestResult = fixtures;
  let bestScore = Infinity;

  for (let attempt = 0; attempt < 20; attempt++) {
    const pool = [...fixtures];
    shuffle(pool);
    const result: Array<[string, string]> = [];
    const remaining = new Set(pool.map((_, i) => i));

    for (let slot = 0; slot < n; slot++) {
      const prevTeams = new Set<string>();
      const recentPairs = new Set<string>();

      // Collect teams from previous 1-2 matches to avoid back-to-back
      for (let back = 1; back <= 2 && slot - back >= 0; back++) {
        const prev = result[slot - back];
        prevTeams.add(prev[0]);
        prevTeams.add(prev[1]);
        recentPairs.add(pairKey(prev[0], prev[1]));
      }

      let bestIdx = -1;
      let bestPenalty = Infinity;

      for (const idx of remaining) {
        const [h, a] = pool[idx];
        let penalty = 0;
        if (prevTeams.has(h)) penalty += 10;
        if (prevTeams.has(a)) penalty += 10;
        if (recentPairs.has(pairKey(h, a))) penalty += 5;
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          bestIdx = idx;
          if (penalty === 0) break;
        }
      }

      remaining.delete(bestIdx);
      result.push(pool[bestIdx]);
    }

    // Score: count back-to-back violations
    let score = 0;
    for (let i = 1; i < result.length; i++) {
      const prev = new Set([result[i - 1][0], result[i - 1][1]]);
      if (prev.has(result[i][0]) || prev.has(result[i][1])) score++;
    }

    if (score < bestScore) {
      bestScore = score;
      bestResult = result;
      if (score === 0) break;
    }
  }

  return bestResult;
}

export function generateSchedule(teams: Team[], matchesPerTeam = 14): ScheduledMatch[] {
  return generateIPLSchedule(teams, matchesPerTeam);
}

function generateOfficialModernIPLSchedule(teams: Team[]): ScheduledMatch[] {
  const teamMap = new Map(teams.map(team => [team.id, team]));
  const fixtures: Array<[string, string]> = [];
  const groups = [OFFICIAL_IPL_GROUP_A, OFFICIAL_IPL_GROUP_B];

  const pushFixture = (homeId: string, awayId: string) => {
    if (!teamMap.has(homeId) || !teamMap.has(awayId)) {
      throw new Error(`Missing IPL team config for fixture ${homeId} vs ${awayId}`);
    }
    fixtures.push([homeId, awayId]);
  };

  // Teams play everyone in their virtual group home and away.
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pushFixture(group[i], group[j]);
        pushFixture(group[j], group[i]);
      }
    }
  }

  // Same-row opponents across groups are also home and away.
  for (let i = 0; i < OFFICIAL_IPL_GROUP_A.length; i++) {
    pushFixture(OFFICIAL_IPL_GROUP_A[i], OFFICIAL_IPL_GROUP_B[i]);
    pushFixture(OFFICIAL_IPL_GROUP_B[i], OFFICIAL_IPL_GROUP_A[i]);
  }

  // Remaining cross-group opponents are played once, split 2 home / 2 away per team.
  for (let i = 0; i < OFFICIAL_IPL_GROUP_A.length; i++) {
    for (let j = 0; j < OFFICIAL_IPL_GROUP_B.length; j++) {
      if (i === j) continue;

      const homeIsGroupA = ((j - i + OFFICIAL_IPL_GROUP_A.length) % OFFICIAL_IPL_GROUP_A.length) <= 2;
      pushFixture(
        homeIsGroupA ? OFFICIAL_IPL_GROUP_A[i] : OFFICIAL_IPL_GROUP_B[j],
        homeIsGroupA ? OFFICIAL_IPL_GROUP_B[j] : OFFICIAL_IPL_GROUP_A[i],
      );
    }
  }

  return spreadFixtures(fixtures).map(([homeTeamId, awayTeamId], index) => ({
    matchNumber: index + 1,
    homeTeamId,
    awayTeamId,
    isPlayoff: false,
    type: "group" as const,
  }));
}

/**
 * Generate league schedule.
 * IPL: ~70 group matches for 10 teams (14 per team)
 * WPL: 20 group matches for 5 teams (8 per team, full double round-robin)
 */
export function generateIPLSchedule(teams: Team[], matchesPerTeam = 14): ScheduledMatch[] {
  if (usesOfficialModernIPLMatrix(teams, matchesPerTeam)) {
    return generateOfficialModernIPLSchedule(teams);
  }

  const schedule: ScheduledMatch[] = [];
  const matchups: [string, string][] = [];

  // Each pair plays twice (home and away)
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      matchups.push([teams[i].id, teams[j].id]);
      matchups.push([teams[j].id, teams[i].id]);
    }
  }

  // For small leagues (WPL: 5 teams, 8 matches each = 20 total)
  // all matchups fit naturally in a double round-robin
  const totalTarget = Math.floor((teams.length * matchesPerTeam) / 2);

  shuffle(matchups);

  const teamMatchCount = new Map<string, number>();
  for (const t of teams) teamMatchCount.set(t.id, 0);

  const selected: [string, string][] = [];

  for (const [home, away] of matchups) {
    const homeCount = teamMatchCount.get(home) ?? 0;
    const awayCount = teamMatchCount.get(away) ?? 0;
    if (homeCount < matchesPerTeam && awayCount < matchesPerTeam) {
      selected.push([home, away]);
      teamMatchCount.set(home, homeCount + 1);
      teamMatchCount.set(away, awayCount + 1);
    }
    if (selected.length >= totalTarget) break;
  }

  // Pad if needed
  for (const [home, away] of matchups) {
    if (selected.length >= totalTarget) break;
    if (!selected.some(([h, a]) => h === home && a === away)) {
      selected.push([home, away]);
    }
  }

  const spread = spreadFixtures(selected);

  for (let i = 0; i < spread.length; i++) {
    schedule.push({
      matchNumber: i + 1,
      homeTeamId: spread[i][0],
      awayTeamId: spread[i][1],
      isPlayoff: false,
      type: "group",
    });
  }

  return schedule;
}

/**
 * Simulate a single match from the schedule.
 * Mutates team records (wins, losses, NRR, player stats) and heals injuries.
 * Returns the MatchResult.
 */
export function simulateNextMatch(
  schedule: ScheduledMatch[],
  matchIndex: number,
  teams: Team[],
  rules: RuleSet = DEFAULT_RULES,
): MatchResult {
  const teamMap = new Map(teams.map(t => [t.id, t]));
  const match = schedule[matchIndex];

  const home = teamMap.get(match.homeTeamId)!;
  const away = teamMap.get(match.awayTeamId)!;
  const result = simulateMatch(home, away, rules, undefined, {
    neutralVenue: match.isPlayoff,
    countTowardStandings: !match.isPlayoff,
  });

  match.result = result;

  applyPostMatchCondition(result, teams);

  // Heal injuries for all teams
  for (const t of teams) {
    healInjuries(t);
  }

  // Mid-season training tick every 5 matches
  if ((matchIndex + 1) % 5 === 0) {
    for (const t of teams) {
      for (const p of t.roster) {
        p.applyMidSeasonTraining();
      }
    }
  }

  return result;
}

/**
 * Apply a completed live match result to the schedule and team records.
 * Used instead of simulateNextMatch when the match was played ball-by-ball
 * in the live match viewer. Avoids re-simulating and producing different results.
 */
export function applyLiveResult(
  schedule: ScheduledMatch[],
  matchIndex: number,
  teams: Team[],
  completedMatch: MatchState,
  rules: RuleSet = DEFAULT_RULES,
): MatchResult {
  const teamMap = new Map(teams.map(t => [t.id, t]));
  const match = schedule[matchIndex];
  const home = teamMap.get(match.homeTeamId)!;
  const away = teamMap.get(match.awayTeamId)!;

  const battingFirstId = completedMatch._internal.battingFirstId;
  const bowlingFirstId = completedMatch._internal.bowlingFirstId;
  const inn1Raw = completedMatch._internal.innings1Raw!;
  const inn2Raw = completedMatch._internal.currentInningsRaw;

  // Build InningsScore objects
  const toInningsScore = (raw: typeof inn1Raw): InningsScore => ({
    teamId: raw.teamId,
    runs: raw.runs,
    wickets: raw.wickets,
    overs: raw.overs,
    balls: raw.balls,
    totalBalls: raw.totalBalls,
    extras: raw.extras,
    fours: raw.fours,
    sixes: raw.sixes,
    ballLog: raw.ballLog ?? [],
    batterStats: new Map(Object.entries(raw.batterStats)),
    bowlerStats: new Map(Object.entries(raw.bowlerStats)),
  });

  const innings1 = toInningsScore(inn1Raw);
  const innings2 = toInningsScore(inn2Raw);

  const winnerId = completedMatch.winnerId ?? null;
  const margin = completedMatch.result?.replace(/^.*won by /, "").replace(/^Match tied.*$/, "Super Over") ?? "";

  // Build the MatchResult
  const result: MatchResult = {
    id: completedMatch._internal.matchId,
    homeTeamId: home.id,
    awayTeamId: away.id,
    tossWinner: completedMatch.tossWinner === home.name ? home.id : away.id,
    tossDecision: completedMatch.tossDecision,
    innings: [innings1, innings2],
    winnerId,
    margin,
    motm: completedMatch.manOfTheMatch?.playerId ?? "",
    injuries: completedMatch.injuries ?? [],
  };

  // Set result on schedule
  match.result = result;

  // Update team records
  if (!match.isPlayoff) {
    if (winnerId) {
      const winner = winnerId === home.id ? home : away;
      const loser = winner === home ? away : home;
      winner.wins++;
      loser.losses++;
    } else {
      home.ties++;
      away.ties++;
    }

    // Update NRR components
    const maxInningsBalls = completedMatch.maxOvers * 6;
    const homeBattingInnings = battingFirstId === home.id ? innings1 : innings2;
    const homeBowlingInnings = battingFirstId === home.id ? innings2 : innings1;
    const awayBattingInnings = battingFirstId === away.id ? innings1 : innings2;
    const awayBowlingInnings = battingFirstId === away.id ? innings2 : innings1;

    home.runsFor += homeBattingInnings.runs;
    home.ballsFacedFor += getNRRBallDenominator(homeBattingInnings, maxInningsBalls);
    home.runsAgainst += homeBowlingInnings.runs;
    home.ballsFacedAgainst += getNRRBallDenominator(homeBowlingInnings, maxInningsBalls);
    home.wicketsTaken += homeBowlingInnings.wickets;
    home.updateNRR();

    away.runsFor += awayBattingInnings.runs;
    away.ballsFacedFor += getNRRBallDenominator(awayBattingInnings, maxInningsBalls);
    away.runsAgainst += awayBowlingInnings.runs;
    away.ballsFacedAgainst += getNRRBallDenominator(awayBowlingInnings, maxInningsBalls);
    away.wicketsTaken += awayBowlingInnings.wickets;
    away.updateNRR();
  }

  // Update player stats — mirrors updatePlayerStats() in match.ts
  const updateBatterStats = (inn: typeof innings1) => {
    for (const [pid, bs] of inn.batterStats) {
      const player = home.roster.find(p => p.id === pid) ?? away.roster.find(p => p.id === pid);
      if (!player || bs.balls === 0) continue;
      player.stats.innings++;
      player.stats.runs += bs.runs;
      player.stats.ballsFaced += bs.balls;
      player.stats.fours += bs.fours;
      player.stats.sixes += bs.sixes;
      if (!bs.isOut) player.stats.notOuts++;
      if (bs.runs > player.stats.highScore) player.stats.highScore = bs.runs;
      if (bs.runs >= 100) player.stats.hundreds++;
      else if (bs.runs >= 50) player.stats.fifties++;
    }
  };
  const updateBowlerStats = (inn: typeof innings1) => {
    for (const [pid, bs] of inn.bowlerStats) {
      const player = home.roster.find(p => p.id === pid) ?? away.roster.find(p => p.id === pid);
      if (!player || (bs.overs === 0 && bs.balls === 0)) continue;
      player.stats.overs += bs.overs + bs.balls / 10; // display format (e.g. 3.4)
      player.stats.wickets += bs.wickets;
      player.stats.runsConceded += bs.runs;
    }
  };
  updateBatterStats(innings1);
  updateBatterStats(innings2);
  updateBowlerStats(innings1);
  updateBowlerStats(innings2);

  // Mark matches played for all XI players
  const homeXISet = new Set(completedMatch._internal.homeXIIds);
  const awayXISet = new Set(completedMatch._internal.awayXIIds);
  for (const p of home.roster) { if (homeXISet.has(p.id)) p.stats.matches++; }
  for (const p of away.roster) { if (awayXISet.has(p.id)) p.stats.matches++; }

  updateLiveMatchForm(result, teams);
  applyPostMatchCondition(result, teams);

  // Heal injuries for all teams
  for (const t of teams) {
    healInjuries(t);
  }

  // Mid-season training tick every 5 matches
  if ((matchIndex + 1) % 5 === 0) {
    for (const t of teams) {
      for (const p of t.roster) {
        p.applyMidSeasonTraining();
      }
    }
  }

  return result;
}

/**
 * After group stage, determine the top 4 teams and add playoff matches to the schedule.
 * Returns the updated schedule with playoff slots (without results).
 */
export function addPlayoffMatches(schedule: ScheduledMatch[], teams: Team[]): ScheduledMatch[] {
  const standings = getStandings(teams);
  const top4 = standings.slice(0, 4);

  const baseNumber = schedule.length + 1;

  // Qualifier 1: 1st vs 2nd
  schedule.push({
    matchNumber: baseNumber,
    homeTeamId: top4[0].teamId,
    awayTeamId: top4[1].teamId,
    isPlayoff: true,
    playoffType: "qualifier1",
    type: "qualifier1",
  });

  // Eliminator: 3rd vs 4th
  schedule.push({
    matchNumber: baseNumber + 1,
    homeTeamId: top4[2].teamId,
    awayTeamId: top4[3].teamId,
    isPlayoff: true,
    playoffType: "eliminator",
    type: "eliminator",
  });

  return schedule;
}

/**
 * After Qualifier 1 and Eliminator are played, add Qualifier 2 to the schedule.
 */
export function addQualifier2(schedule: ScheduledMatch[]): ScheduledMatch[] {
  const q1 = schedule.find(m => m.playoffType === "qualifier1")!;
  const elim = schedule.find(m => m.playoffType === "eliminator")!;

  if (!q1.result || !elim.result) {
    throw new Error("Qualifier 1 and Eliminator must be played before adding Qualifier 2");
  }

  const q1Loser = q1.result.winnerId === q1.homeTeamId ? q1.awayTeamId : q1.homeTeamId;
  const elimWinner = elim.result.winnerId!;

  schedule.push({
    matchNumber: schedule.length + 1,
    homeTeamId: q1Loser,
    awayTeamId: elimWinner,
    isPlayoff: true,
    playoffType: "qualifier2",
    type: "qualifier2",
  });

  return schedule;
}

/**
 * After Qualifier 2 is played, add the Final to the schedule.
 */
export function addFinal(schedule: ScheduledMatch[]): ScheduledMatch[] {
  const q1 = schedule.find(m => m.playoffType === "qualifier1")!;
  const q2 = schedule.find(m => m.playoffType === "qualifier2")!;

  if (!q1.result || !q2.result) {
    throw new Error("Qualifier 1 and Qualifier 2 must be played before adding Final");
  }

  const q1Winner = q1.result.winnerId!;
  const q2Winner = q2.result.winnerId!;

  schedule.push({
    matchNumber: schedule.length + 1,
    homeTeamId: q1Winner,
    awayTeamId: q2Winner,
    isPlayoff: true,
    playoffType: "final",
    type: "final",
  });

  return schedule;
}

/** Get the number of group stage matches in a schedule */
export function getGroupStageCount(schedule: ScheduledMatch[]): number {
  return schedule.filter(m => m.type === "group").length;
}

/** Get current standings sorted by points then NRR */
export function getStandings(teams: Team[]): StandingsEntry[] {
  return teams
    .map(t => ({
      teamId: t.id,
      played: t.matchesPlayed,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      points: t.points,
      nrr: t.nrr,
      wicketsTaken: t.wicketsTaken,
      wicketsPerBall: t.ballsFacedAgainst > 0 ? t.wicketsTaken / t.ballsFacedAgainst : 0,
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.nrr !== a.nrr) return b.nrr - a.nrr;
      return b.wicketsPerBall - a.wicketsPerBall;
    });
}

// ── Playoff Helpers ──────────────────────────────────────────────────────

function makePlayoff(
  schedule: ScheduledMatch[],
  homeId: string, awayId: string,
  type: PlayoffMatchType,
): ScheduledMatch {
  return {
    matchNumber: schedule.length + 1,
    homeTeamId: homeId,
    awayTeamId: awayId,
    isPlayoff: true,
    playoffType: type,
    type,
  };
}

function playAndPush(
  match: ScheduledMatch,
  schedule: ScheduledMatch[],
  teamMap: Map<string, Team>,
  teams: Team[],
  rules: RuleSet,
): MatchResult {
  const home = teamMap.get(match.homeTeamId)!;
  const away = teamMap.get(match.awayTeamId)!;
  match.result = simulateMatch(home, away, rules, undefined, {
    neutralVenue: true,
    countTowardStandings: false,
  });
  schedule.push(match);
  for (const t of teams) healInjuries(t);
  return match.result;
}

function getWinner(result: MatchResult, homeId: string, awayId: string): string {
  return result.winnerId === homeId ? homeId : awayId;
}

function getLoser(result: MatchResult, homeId: string, awayId: string): string {
  return result.winnerId === homeId ? awayId : homeId;
}

/**
 * Run playoffs and return the champion's team ID.
 * Supports three formats:
 * - "none": no playoffs, top of standings wins
 * - "simple": straight knockout bracket
 * - "eliminator": IPL-style with qualifiers (gives top seeds a second chance)
 */
function runPlayoffs(
  schedule: ScheduledMatch[],
  standings: StandingsEntry[],
  teamMap: Map<string, Team>,
  teams: Team[],
  rules: RuleSet,
  format: string,
  count: number,
): string {
  // No playoffs — table-topper wins
  if (format === "none" || count <= 0) {
    return standings[0].teamId;
  }

  const topIds = standings.slice(0, count).map(s => s.teamId);

  // Only 1 playoff team — just them (edge case, treat as no playoffs)
  if (topIds.length <= 1) {
    return topIds[0];
  }

  // ── Simple bracket format ──────────────────────────────────────────
  if (format === "simple") {
    return runSimpleBracket(schedule, topIds, teamMap, teams, rules);
  }

  // ── Eliminator format (IPL-style) ─────────────────────────────────
  return runEliminatorFormat(schedule, topIds, teamMap, teams, rules);
}

/**
 * Simple single-elimination bracket.
 * Seeds are matched: 1v(last), 2v(last-1), etc.
 * If odd number, top seed gets a bye to the next round.
 */
function runSimpleBracket(
  schedule: ScheduledMatch[],
  teamIds: string[],
  teamMap: Map<string, Team>,
  teams: Team[],
  rules: RuleSet,
): string {
  let remaining = [...teamIds];
  let roundNum = 1;

  while (remaining.length > 1) {
    const nextRound: string[] = [];

    // If odd, top seed gets a bye
    if (remaining.length % 2 !== 0) {
      nextRound.push(remaining[0]);
      remaining = remaining.slice(1);
    }

    // Pair from outside in: 1v(last), 2v(last-1), ...
    const half = remaining.length / 2;
    for (let i = 0; i < half; i++) {
      const homeId = remaining[i];
      const awayId = remaining[remaining.length - 1 - i];

      const isFinal = remaining.length === 2 && nextRound.length === 0;
      const matchType: PlayoffMatchType = isFinal ? "final"
        : roundNum === 1 && half <= 2 ? (i === 0 ? "semi1" : "semi2")
        : "eliminator";

      const match = makePlayoff(schedule, homeId, awayId, matchType);
      const result = playAndPush(match, schedule, teamMap, teams, rules);
      nextRound.push(getWinner(result, homeId, awayId));
    }

    remaining = nextRound;
    roundNum++;
  }

  return remaining[0];
}

/**
 * IPL-style eliminator format.
 * For 4 teams: Q1 (1v2), Eliminator (3v4), Q2 (Q1 loser vs Elim winner), Final
 * For 3 teams: Q1 (1v2), Eliminator (3 vs Q1 loser), Final
 * For 2 teams: just a Final
 * For 5+ teams: bottom seeds play eliminators first, top 2 get qualifier advantage
 */
function runEliminatorFormat(
  schedule: ScheduledMatch[],
  teamIds: string[],
  teamMap: Map<string, Team>,
  teams: Team[],
  rules: RuleSet,
): string {
  if (teamIds.length === 2) {
    const match = makePlayoff(schedule, teamIds[0], teamIds[1], "final");
    const result = playAndPush(match, schedule, teamMap, teams, rules);
    return getWinner(result, teamIds[0], teamIds[1]);
  }

  // Top 2 play Qualifier 1 (winner goes to final, loser gets another chance)
  const q1 = makePlayoff(schedule, teamIds[0], teamIds[1], "qualifier1");
  const q1Result = playAndPush(q1, schedule, teamMap, teams, rules);
  const q1Winner = getWinner(q1Result, teamIds[0], teamIds[1]);
  let q1Loser = getLoser(q1Result, teamIds[0], teamIds[1]);

  // Remaining teams (seeds 3+) play eliminators to produce one survivor
  let eliminatorPool = teamIds.slice(2);

  // Bottom seeds play single-elimination rounds
  while (eliminatorPool.length > 1) {
    const nextPool: string[] = [];
    if (eliminatorPool.length % 2 !== 0) {
      nextPool.push(eliminatorPool[0]);
      eliminatorPool = eliminatorPool.slice(1);
    }
    const half = eliminatorPool.length / 2;
    for (let i = 0; i < half; i++) {
      const homeId = eliminatorPool[i];
      const awayId = eliminatorPool[eliminatorPool.length - 1 - i];
      const match = makePlayoff(schedule, homeId, awayId, "eliminator");
      const result = playAndPush(match, schedule, teamMap, teams, rules);
      nextPool.push(getWinner(result, homeId, awayId));
    }
    eliminatorPool = nextPool;
  }

  const elimSurvivor = eliminatorPool[0];

  // Qualifier 2: Q1 loser vs eliminator survivor
  const q2 = makePlayoff(schedule, q1Loser, elimSurvivor, "qualifier2");
  const q2Result = playAndPush(q2, schedule, teamMap, teams, rules);
  const q2Winner = getWinner(q2Result, q1Loser, elimSurvivor);

  // Final: Q1 winner vs Q2 winner
  const final_match = makePlayoff(schedule, q1Winner, q2Winner, "final");
  const finalResult = playAndPush(final_match, schedule, teamMap, teams, rules);
  return getWinner(finalResult, q1Winner, q2Winner);
}

/** Run a full season: group stage + playoffs */
export function runSeason(teams: Team[], rules: RuleSet = DEFAULT_RULES): SeasonResult {
  // Reset all teams
  for (const t of teams) t.resetSeason();

  const teamMap = new Map(teams.map(t => [t.id, t]));
  const schedule = generateIPLSchedule(teams, rules.matchesPerTeam);

  // Play group stage
  for (const match of schedule) {
    const home = teamMap.get(match.homeTeamId)!;
    const away = teamMap.get(match.awayTeamId)!;
    match.result = simulateMatch(home, away, rules);

    // Heal injuries after each match
    for (const t of teams) {
      healInjuries(t);
    }
  }

  // Standings
  const standings = getStandings(teams);

  const playoffFormat = rules.playoffFormat ?? "eliminator";
  const playoffTeamCount = Math.min(rules.playoffTeams, teams.length);
  const champion = runPlayoffs(schedule, standings, teamMap, teams, rules, playoffFormat, playoffTeamCount);

  // Award caps
  const allPlayers = teams.flatMap(t => t.roster);

  // Orange Cap: most runs, tiebreaker = higher strike rate
  const orangeCap = allPlayers.reduce(
    (best, p) => {
      const sr = p.stats.ballsFaced > 0 ? (p.stats.runs / p.stats.ballsFaced) * 100 : 0;
      if (p.stats.runs > best.runs) {
        return { playerId: p.id, name: p.name, runs: p.stats.runs, strikeRate: sr };
      }
      if (p.stats.runs === best.runs && sr > best.strikeRate) {
        return { playerId: p.id, name: p.name, runs: p.stats.runs, strikeRate: sr };
      }
      return best;
    },
    { playerId: "", name: "", runs: 0, strikeRate: 0 },
  );

  // Purple Cap: most wickets, tiebreaker = lower economy rate
  const purpleCap = allPlayers.reduce(
    (best, p) => {
      const effectiveOvers = p.stats.overs; // display format (e.g. 16.4)
      const intOvers = Math.floor(effectiveOvers);
      const fracBalls = Math.round((effectiveOvers - intOvers) * 10);
      const totalOvers = intOvers + fracBalls / 6;
      const econ = totalOvers > 0 ? p.stats.runsConceded / totalOvers : 99;
      if (p.stats.wickets > best.wickets) {
        return { playerId: p.id, name: p.name, wickets: p.stats.wickets, economy: econ };
      }
      if (p.stats.wickets === best.wickets && econ < best.economy) {
        return { playerId: p.id, name: p.name, wickets: p.stats.wickets, economy: econ };
      }
      return best;
    },
    { playerId: "", name: "", wickets: 0, economy: 99 },
  );

  // MVP points: accumulate across all group + playoff matches
  const mvpAccumulator = new Map<string, { name: string; points: number }>();
  const playerIdNameMap = allPlayers.map(p => ({ id: p.id, name: p.name }));
  for (const match of schedule) {
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

  return {
    schedule,
    standings,
    champion,
    orangeCap,
    purpleCap,
    mvp,
  };
}
