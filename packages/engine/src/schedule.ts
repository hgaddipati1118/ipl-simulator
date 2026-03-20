/**
 * Season schedule generator and standings management.
 * Ported from IndianCricketLeague/ScheduleClass.js
 */

import { Team } from "./team.js";
import { MatchResult, simulateMatch } from "./match.js";
import { shuffle } from "./math.js";

export interface ScheduledMatch {
  matchNumber: number;
  homeTeamId: string;
  awayTeamId: string;
  result?: MatchResult;
  isPlayoff: boolean;
  playoffType?: "qualifier1" | "eliminator" | "qualifier2" | "final";
}

export interface StandingsEntry {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  points: number;
  nrr: number;
}

export interface SeasonResult {
  schedule: ScheduledMatch[];
  standings: StandingsEntry[];
  champion: string;
  orangeCap: { playerId: string; runs: number };
  purpleCap: { playerId: string; wickets: number };
}

/**
 * Generate IPL-style schedule (70 group matches for 10 teams).
 * Each team plays 14 matches: 7 home, 7 away.
 */
export function generateIPLSchedule(teams: Team[]): ScheduledMatch[] {
  const schedule: ScheduledMatch[] = [];
  const matchups: [string, string][] = [];

  // Each pair plays twice (home and away)
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      matchups.push([teams[i].id, teams[j].id]);
      matchups.push([teams[j].id, teams[i].id]);
    }
  }

  // For 10 teams that's 90 matchups, but IPL only has 70 games
  // Randomly select 70 (each team plays ~14)
  shuffle(matchups);

  // Count per team, ensure roughly balanced
  const teamMatchCount = new Map<string, number>();
  for (const t of teams) teamMatchCount.set(t.id, 0);

  const selected: [string, string][] = [];

  for (const [home, away] of matchups) {
    const homeCount = teamMatchCount.get(home) ?? 0;
    const awayCount = teamMatchCount.get(away) ?? 0;
    if (homeCount < 14 && awayCount < 14) {
      selected.push([home, away]);
      teamMatchCount.set(home, homeCount + 1);
      teamMatchCount.set(away, awayCount + 1);
    }
    if (selected.length >= 70) break;
  }

  // If we didn't reach 70 (unlikely), pad with remaining
  for (const [home, away] of matchups) {
    if (selected.length >= 70) break;
    if (!selected.some(([h, a]) => h === home && a === away)) {
      selected.push([home, away]);
    }
  }

  shuffle(selected);

  for (let i = 0; i < selected.length; i++) {
    schedule.push({
      matchNumber: i + 1,
      homeTeamId: selected[i][0],
      awayTeamId: selected[i][1],
      isPlayoff: false,
    });
  }

  return schedule;
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
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.nrr - a.nrr;
    });
}

/** Run a full IPL season: group stage + playoffs */
export function runSeason(teams: Team[]): SeasonResult {
  // Reset all teams
  for (const t of teams) t.resetSeason();

  const teamMap = new Map(teams.map(t => [t.id, t]));
  const schedule = generateIPLSchedule(teams);

  // Play group stage
  for (const match of schedule) {
    const home = teamMap.get(match.homeTeamId)!;
    const away = teamMap.get(match.awayTeamId)!;
    match.result = simulateMatch(home, away);

    // Heal injuries
    for (const t of teams) {
      for (const p of t.roster) {
        if (p.injured) {
          p.injuryGamesLeft--;
          if (p.injuryGamesLeft <= 0) {
            p.injured = false;
            p.injuryGamesLeft = 0;
          }
        }
      }
    }
  }

  // Standings
  const standings = getStandings(teams);

  // Playoffs: top 4 qualify
  const top4 = standings.slice(0, 4).map(s => teamMap.get(s.teamId)!);

  // Qualifier 1: 1st vs 2nd
  const q1: ScheduledMatch = {
    matchNumber: schedule.length + 1,
    homeTeamId: top4[0].id,
    awayTeamId: top4[1].id,
    isPlayoff: true,
    playoffType: "qualifier1",
  };
  q1.result = simulateMatch(top4[0], top4[1]);
  schedule.push(q1);

  // Eliminator: 3rd vs 4th
  const elim: ScheduledMatch = {
    matchNumber: schedule.length + 1,
    homeTeamId: top4[2].id,
    awayTeamId: top4[3].id,
    isPlayoff: true,
    playoffType: "eliminator",
  };
  elim.result = simulateMatch(top4[2], top4[3]);
  schedule.push(elim);

  // Qualifier 2: Loser of Q1 vs Winner of Eliminator
  const q1Loser = q1.result!.winnerId === top4[0].id ? top4[1] : top4[0];
  const elimWinner = elim.result!.winnerId === top4[2].id ? top4[2] : top4[3];

  const q2: ScheduledMatch = {
    matchNumber: schedule.length + 1,
    homeTeamId: q1Loser.id,
    awayTeamId: elimWinner.id,
    isPlayoff: true,
    playoffType: "qualifier2",
  };
  q2.result = simulateMatch(q1Loser, elimWinner);
  schedule.push(q2);

  // Final: Winner of Q1 vs Winner of Q2
  const q1Winner = q1.result!.winnerId === top4[0].id ? top4[0] : top4[1];
  const q2Winner = q2.result!.winnerId === q1Loser.id ? q1Loser : elimWinner;

  const final: ScheduledMatch = {
    matchNumber: schedule.length + 1,
    homeTeamId: q1Winner.id,
    awayTeamId: q2Winner.id,
    isPlayoff: true,
    playoffType: "final",
  };
  final.result = simulateMatch(q1Winner, q2Winner);
  schedule.push(final);

  const champion = final.result!.winnerId!;

  // Award caps
  const allPlayers = teams.flatMap(t => t.roster);

  const orangeCap = allPlayers.reduce(
    (best, p) => p.stats.runs > best.runs ? { playerId: p.id, runs: p.stats.runs } : best,
    { playerId: "", runs: 0 },
  );

  const purpleCap = allPlayers.reduce(
    (best, p) => p.stats.wickets > best.wickets ? { playerId: p.id, wickets: p.stats.wickets } : best,
    { playerId: "", wickets: 0 },
  );

  return {
    schedule,
    standings: getStandings(teams),
    champion,
    orangeCap,
    purpleCap,
  };
}
