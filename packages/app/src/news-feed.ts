import {
  type MatchResult,
  type MatchState,
  type NarrativeEvent,
  Team,
  generatePostMatchNarrative,
} from "@ipl-sim/engine";

export interface FeedMatchResult {
  winnerId: string | null;
  innings: Array<{ teamId: string }>;
}

interface MatchNarrativeShape {
  winnerId: string | null;
  homeTeamId: string;
  awayTeamId: string;
  margin: string;
  manOfMatch?: { name: string; runs?: number; wickets?: number };
}

function teamOutcome(result: FeedMatchResult, teamId: string): "W" | "L" | "T" | null {
  const teamIds = result.innings.map(innings => innings.teamId);
  if (!teamIds.includes(teamId)) return null;
  if (!result.winnerId) return "T";
  return result.winnerId === teamId ? "W" : "L";
}

function getConsecutiveStreak(results: FeedMatchResult[], teamId: string, desired: "W" | "L"): number {
  let streak = 0;

  for (let index = results.length - 1; index >= 0; index--) {
    const outcome = teamOutcome(results[index], teamId);
    if (!outcome) continue;
    if (outcome !== desired) break;
    streak++;
  }

  return streak;
}

function getSeasonPosition(teams: Team[], userTeamId: string | null): number {
  if (!userTeamId) return 0;
  const sorted = [...teams].sort((a, b) => (b.points !== a.points ? b.points - a.points : b.nrr - a.nrr));
  return sorted.findIndex(team => team.id === userTeamId) + 1;
}

function buildSeasonLeaders(teams: Team[]) {
  const players = teams.flatMap(team => team.roster);
  const runsLeader = players.reduce(
    (best, player) => player.stats.runs > best.runs ? { name: player.name, runs: player.stats.runs, playerId: player.id } : best,
    { name: "", runs: 0, playerId: undefined as string | undefined },
  );
  const wicketsLeader = players.reduce(
    (best, player) => player.stats.wickets > best.wickets ? { name: player.name, wickets: player.stats.wickets, playerId: player.id } : best,
    { name: "", wickets: 0, playerId: undefined as string | undefined },
  );

  return {
    seasonRunsLeader: runsLeader.runs > 0 ? runsLeader : undefined,
    seasonWicketsLeader: wicketsLeader.wickets > 0 ? wicketsLeader : undefined,
  };
}

function buildNarrativeEvents(params: {
  match: MatchNarrativeShape;
  teams: Team[];
  userTeamId: string | null;
  recentResults: FeedMatchResult[];
}): NarrativeEvent[] {
  const { match, teams, userTeamId, recentResults } = params;
  const homeTeam = teams.find(team => team.id === match.homeTeamId);
  const awayTeam = teams.find(team => team.id === match.awayTeamId);
  const winnerTeam = match.winnerId ? teams.find(team => team.id === match.winnerId) : homeTeam;
  const loserTeam = winnerTeam?.id === homeTeam?.id ? awayTeam : homeTeam;
  const userTeam = teams.find(team => team.id === userTeamId);
  const userTeamWon = !!(userTeamId && match.winnerId === userTeamId);
  const seasonPosition = getSeasonPosition(teams, userTeamId);
  const matchesPlayed = userTeam?.matchesPlayed ?? 0;
  const { seasonRunsLeader, seasonWicketsLeader } = buildSeasonLeaders(teams);
  const consecutiveWins = userTeamId ? getConsecutiveStreak(recentResults, userTeamId, "W") : 0;
  const consecutiveLosses = userTeamId ? getConsecutiveStreak(recentResults, userTeamId, "L") : 0;

  return generatePostMatchNarrative({
    winnerName: winnerTeam?.name ?? homeTeam?.name ?? "Winning side",
    loserName: loserTeam?.name ?? awayTeam?.name ?? "Losing side",
    margin: match.margin,
    manOfMatch: match.manOfMatch,
    userTeamId,
    userTeamWon,
    seasonPosition,
    matchesPlayed,
    consecutiveLosses,
    consecutiveWins,
    seasonRunsLeader,
    seasonWicketsLeader,
  });
}

export function buildNarrativeEventsForEngineResult(params: {
  result: MatchResult;
  teams: Team[];
  userTeamId: string | null;
  recentResults: FeedMatchResult[];
}): NarrativeEvent[] {
  const { result, teams, userTeamId, recentResults } = params;
  const motmPlayer = teams.flatMap(team => team.roster).find(player => player.id === result.motm);

  let runs = 0;
  let wickets = 0;
  for (const innings of result.innings) {
    const bat = innings.batterStats.get(result.motm);
    const bowl = innings.bowlerStats.get(result.motm);
    runs += bat?.runs ?? 0;
    wickets += bowl?.wickets ?? 0;
  }

  return buildNarrativeEvents({
    match: {
      winnerId: result.winnerId,
      homeTeamId: result.homeTeamId,
      awayTeamId: result.awayTeamId,
      margin: result.margin,
      manOfMatch: motmPlayer ? {
        name: motmPlayer.name,
        runs: runs > 0 ? runs : undefined,
        wickets: wickets > 0 ? wickets : undefined,
      } : undefined,
    },
    teams,
    userTeamId,
    recentResults,
  });
}

export function buildNarrativeEventsForLiveState(params: {
  state: MatchState;
  teams: Team[];
  userTeamId: string | null;
  recentResults: FeedMatchResult[];
}): NarrativeEvent[] {
  const { state, teams, userTeamId, recentResults } = params;
  let runs: number | undefined;
  let wickets: number | undefined;

  if (state.manOfTheMatch?.reason) {
    const runsMatch = state.manOfTheMatch.reason.match(/(\d+)\s*(?:runs|\()/);
    const wicketsMatch = state.manOfTheMatch.reason.match(/(\d+)\s*\/|(\d+)\s*wickets/);
    runs = runsMatch ? parseInt(runsMatch[1], 10) : undefined;
    wickets = wicketsMatch ? parseInt(wicketsMatch[1] || wicketsMatch[2], 10) : undefined;
  }

  return buildNarrativeEvents({
    match: {
      winnerId: state.winnerId ?? null,
      homeTeamId: state.homeTeam.id,
      awayTeamId: state.awayTeam.id,
      margin: state.result?.replace(/^.*by /, "") ?? "",
      manOfMatch: state.manOfTheMatch ? {
        name: state.manOfTheMatch.playerName,
        runs,
        wickets,
      } : undefined,
    },
    teams,
    userTeamId,
    recentResults,
  });
}

export function prependNarrativeEvents(existing: NarrativeEvent[], next: NarrativeEvent[], max = 36): NarrativeEvent[] {
  return [...next, ...existing].slice(0, max);
}
