/**
 * CLI Season Simulator
 *
 * Loads real IPL 2026 players, fills rosters via auction,
 * simulates a full 70-match IPL season + playoffs,
 * and prints standings, stats, and a sample scorecard.
 *
 * Usage: npx tsx packages/ratings/src/pipeline/sim-season.ts
 */

import {
  Player,
  Team,
  IPL_TEAMS,
  runAuction,
  runSeason,
  createPlayerFromData,
  RULE_PRESETS,
  type MatchResult,
  type InningsScore,
} from "@ipl-sim/engine";
import { getRealPlayers } from "../real-players.js";
import { ALL_PLAYERS } from "../all-players.js";

// ── Helpers ──────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + " ".repeat(len - s.length);
}

function padNum(n: number, len: number, decimals = 0): string {
  const s = decimals > 0 ? n.toFixed(decimals) : String(n);
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function divider(char = "-", len = 80): string {
  return char.repeat(len);
}

// ── Build teams with real players ────────────────────────────────────

function buildTeams(): Team[] {
  const rules = RULE_PRESETS.modern;
  const teams = IPL_TEAMS.map(cfg => new Team(cfg, rules.salaryCap));

  // Load real IPL 2026 rostered players
  const realPlayers = getRealPlayers();
  const teamMap = new Map(teams.map(t => [t.id, t]));

  let assignedCount = 0;
  for (const rp of realPlayers) {
    const team = teamMap.get(rp.teamId);
    if (!team) continue;

    const player = createPlayerFromData({
      name: rp.name,
      age: rp.age,
      country: rp.country,
      role: rp.role,
      battingIQ: rp.battingIQ,
      timing: rp.timing,
      power: rp.power,
      running: rp.running,
      wicketTaking: rp.wicketTaking,
      economy: rp.economy,
      accuracy: rp.accuracy,
      clutch: rp.clutch,
      teamId: rp.teamId,
    });
    team.addPlayer(player, player.bid || 1);
    assignedCount++;
  }

  console.log(`Assigned ${assignedCount} real players to ${teams.length} teams`);

  // Show per-team counts before auction
  for (const t of teams) {
    console.log(`  ${pad(t.shortName, 5)}: ${t.roster.length} players (${t.internationalCount} intl)`);
  }

  // Check if teams need more players via auction
  const teamsNeedingPlayers = teams.filter(t => t.roster.length < 15);
  if (teamsNeedingPlayers.length > 0) {
    console.log(`\n${teamsNeedingPlayers.length} teams need more players. Running auction...`);

    // Build auction pool from ALL_PLAYERS who are NOT already rostered
    const rosteredIds = new Set(
      ALL_PLAYERS.filter(p => p.teamId).map(p => p.id),
    );

    const auctionPool: Player[] = ALL_PLAYERS
      .filter(p => !p.teamId && !rosteredIds.has(p.id))
      .slice(0, 500) // top 500 unrostered players by rating (already sorted)
      .map(p =>
        createPlayerFromData({
          name: p.name,
          age: p.age,
          country: p.country,
          role: p.role,
          battingIQ: p.ratings.battingIQ,
          timing: p.ratings.timing,
          power: p.ratings.power,
          running: p.ratings.running,
          wicketTaking: p.ratings.wicketTaking,
          economy: p.ratings.economy,
          accuracy: p.ratings.accuracy,
          clutch: p.ratings.clutch,
        }),
      );

    console.log(`Auction pool: ${auctionPool.length} players`);

    const auctionResult = runAuction(auctionPool, teams, {
      maxRosterSize: 25,
      maxInternational: 8,
    });

    console.log(`Auction complete: ${auctionResult.bids.length} players sold, ${auctionResult.unsold.length} unsold`);
  }

  // Final roster counts
  console.log("\nFinal roster sizes:");
  for (const t of teams) {
    const xi = t.getPlayingXI();
    const avgOvr = xi.length > 0
      ? Math.round(xi.reduce((s, p) => s + p.overall, 0) / xi.length)
      : 0;
    console.log(
      `  ${pad(t.shortName, 5)}: ${padNum(t.roster.length, 2)} players | XI avg OVR: ${avgOvr} | ${t.internationalCount} intl`,
    );
  }

  return teams;
}

// ── Print standings ──────────────────────────────────────────────────

function printStandings(
  standings: { teamId: string; played: number; wins: number; losses: number; ties: number; points: number; nrr: number }[],
  teams: Team[],
): void {
  const teamMap = new Map(teams.map(t => [t.id, t]));

  console.log("\n" + divider("="));
  console.log("                        FINAL STANDINGS");
  console.log(divider("="));
  console.log(
    `${pad("#", 3)} ${pad("Team", 30)} ${pad("P", 4)} ${pad("W", 4)} ${pad("L", 4)} ${pad("T", 4)} ${pad("Pts", 5)} ${pad("NRR", 8)}`,
  );
  console.log(divider("-"));

  standings.forEach((s, i) => {
    const team = teamMap.get(s.teamId);
    const name = team?.name ?? s.teamId;
    const nrrStr = s.nrr >= 0 ? `+${s.nrr.toFixed(3)}` : s.nrr.toFixed(3);
    console.log(
      `${padNum(i + 1, 3)} ${pad(name, 30)} ${padNum(s.played, 4)} ${padNum(s.wins, 4)} ${padNum(s.losses, 4)} ${padNum(s.ties, 4)} ${padNum(s.points, 5)} ${pad(nrrStr, 8)}`,
    );
  });
  console.log(divider("-"));
}

// ── Print top run scorers ────────────────────────────────────────────

function printTopRunScorers(teams: Team[]): void {
  const allPlayers = teams.flatMap(t =>
    t.roster.map(p => ({
      name: p.name,
      team: t.shortName,
      runs: p.stats.runs,
      innings: p.stats.innings,
      notOuts: p.stats.notOuts,
      ballsFaced: p.stats.ballsFaced,
      fours: p.stats.fours,
      sixes: p.stats.sixes,
    })),
  );

  const sorted = allPlayers
    .filter(p => p.runs > 0)
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 10);

  console.log("\n" + divider("="));
  console.log("                    TOP 10 RUN SCORERS");
  console.log(divider("="));
  console.log(
    `${pad("#", 3)} ${pad("Player", 25)} ${pad("Team", 6)} ${pad("Inn", 5)} ${pad("Runs", 6)} ${pad("Avg", 8)} ${pad("SR", 8)} ${pad("4s", 5)} ${pad("6s", 5)}`,
  );
  console.log(divider("-"));

  sorted.forEach((p, i) => {
    const dismissals = p.innings - p.notOuts;
    const avg = dismissals > 0 ? p.runs / dismissals : p.runs;
    const sr = p.ballsFaced > 0 ? (p.runs / p.ballsFaced) * 100 : 0;
    console.log(
      `${padNum(i + 1, 3)} ${pad(p.name, 25)} ${pad(p.team, 6)} ${padNum(p.innings, 5)} ${padNum(p.runs, 6)} ${padNum(avg, 8, 2)} ${padNum(sr, 8, 2)} ${padNum(p.fours, 5)} ${padNum(p.sixes, 5)}`,
    );
  });
  console.log(divider("-"));
}

// ── Print top wicket takers ──────────────────────────────────────────

function printTopWicketTakers(teams: Team[]): void {
  const allPlayers = teams.flatMap(t =>
    t.roster.map(p => ({
      name: p.name,
      team: t.shortName,
      wickets: p.stats.wickets,
      overs: p.stats.overs,
      runsConceded: p.stats.runsConceded,
      matches: p.stats.matchLog.length, // matchLog is more reliable than stats.matches for bowlers
    })),
  );

  const sorted = allPlayers
    .filter(p => p.wickets > 0)
    .sort((a, b) => b.wickets - a.wickets)
    .slice(0, 10);

  console.log("\n" + divider("="));
  console.log("                    TOP 10 WICKET TAKERS");
  console.log(divider("="));
  console.log(
    `${pad("#", 3)} ${pad("Player", 25)} ${pad("Team", 6)} ${pad("Mat", 5)} ${pad("Wkts", 6)} ${pad("Avg", 8)} ${pad("Econ", 8)}`,
  );
  console.log(divider("-"));

  sorted.forEach((p, i) => {
    const avg = p.wickets > 0 ? p.runsConceded / p.wickets : 0;
    const econ = p.overs > 0 ? p.runsConceded / p.overs : 0;
    console.log(
      `${padNum(i + 1, 3)} ${pad(p.name, 25)} ${pad(p.team, 6)} ${padNum(p.matches, 5)} ${padNum(p.wickets, 6)} ${padNum(avg, 8, 2)} ${padNum(econ, 8, 2)}`,
    );
  });
  console.log(divider("-"));
}

// ── Print playoff results ────────────────────────────────────────────

function printPlayoffResults(
  schedule: { homeTeamId: string; awayTeamId: string; result?: MatchResult; playoffType?: string; isPlayoff: boolean }[],
  teams: Team[],
): void {
  const teamMap = new Map(teams.map(t => [t.id, t]));
  const playoffs = schedule.filter(m => m.isPlayoff && m.result);

  console.log("\n" + divider("="));
  console.log("                        PLAYOFF RESULTS");
  console.log(divider("="));

  for (const m of playoffs) {
    const r = m.result!;
    const winner = teamMap.get(r.winnerId ?? "");
    const label = (m.playoffType ?? "playoff").toUpperCase().replace(/([a-z])(\d)/, "$1 $2");

    // innings[0] is the team that batted first, innings[1] chased
    const battingFirst = teamMap.get(r.innings[0].teamId);
    const battingSecond = teamMap.get(r.innings[1].teamId);

    const firstScore = `${r.innings[0].runs}/${r.innings[0].wickets} (${formatOvers(r.innings[0])})`;
    const secondScore = `${r.innings[1].runs}/${r.innings[1].wickets} (${formatOvers(r.innings[1])})`;

    console.log(`\n  ${label}`);
    console.log(`  ${pad(battingFirst?.name ?? r.innings[0].teamId, 30)} ${firstScore}`);
    console.log(`  ${pad(battingSecond?.name ?? r.innings[1].teamId, 30)} ${secondScore}`);
    console.log(`  Winner: ${winner?.name ?? r.winnerId} (${r.margin})`);
  }
  console.log("");
}

function formatOvers(inn: InningsScore): string {
  const completedOvers = Math.floor(inn.totalBalls / 6);
  const remainingBalls = inn.totalBalls % 6;
  return remainingBalls > 0 ? `${completedOvers}.${remainingBalls} ov` : `${completedOvers}.0 ov`;
}

// ── Print sample scorecard ───────────────────────────────────────────

function printSampleScorecard(
  schedule: { homeTeamId: string; awayTeamId: string; result?: MatchResult; isPlayoff: boolean; matchNumber: number }[],
  teams: Team[],
): void {
  const teamMap = new Map(teams.map(t => [t.id, t]));

  // Pick a group stage match with a decent total
  const groupMatches = schedule.filter(m => !m.isPlayoff && m.result);
  if (groupMatches.length === 0) return;

  // Find a match with total runs between 280-380 for an interesting scorecard
  let sampleMatch = groupMatches.find(m => {
    const total = (m.result!.innings[0].runs + m.result!.innings[1].runs);
    return total >= 280 && total <= 380;
  });
  if (!sampleMatch) sampleMatch = groupMatches[Math.floor(groupMatches.length / 2)];

  const r = sampleMatch.result!;
  const home = teamMap.get(r.homeTeamId);
  const away = teamMap.get(r.awayTeamId);
  const winner = teamMap.get(r.winnerId ?? "");

  console.log("\n" + divider("="));
  console.log(`              SAMPLE SCORECARD - Match #${sampleMatch.matchNumber}`);
  console.log(divider("="));
  console.log(`${home?.name ?? r.homeTeamId} vs ${away?.name ?? r.awayTeamId}`);
  console.log(`Result: ${winner?.name ?? r.winnerId} won by ${r.margin}`);

  // Print each innings
  for (let i = 0; i < 2; i++) {
    const inn = r.innings[i];
    const battingTeam = teamMap.get(inn.teamId);
    const oversStr = formatOvers(inn);

    console.log(`\n${divider("-")}`);
    console.log(`${battingTeam?.name ?? inn.teamId} Innings: ${inn.runs}/${inn.wickets} (${oversStr})`);
    console.log(divider("-"));

    // Batting card
    console.log(
      `${pad("Batter", 25)} ${pad("R", 5)} ${pad("B", 5)} ${pad("4s", 4)} ${pad("6s", 4)} ${pad("SR", 8)}`,
    );
    console.log(divider("-", 55));

    for (const [playerId, bs] of inn.batterStats) {
      // Try to find the player name from teams
      const player = teams.flatMap(t => t.roster).find(p => p.id === playerId);
      const name = player?.name ?? playerId;
      const sr = bs.balls > 0 ? ((bs.runs / bs.balls) * 100).toFixed(1) : "0.0";
      const outStr = bs.isOut ? "" : "*";
      console.log(
        `${pad(name + outStr, 25)} ${padNum(bs.runs, 5)} ${padNum(bs.balls, 5)} ${padNum(bs.fours, 4)} ${padNum(bs.sixes, 4)} ${pad(sr, 8)}`,
      );
    }

    console.log(`\nExtras: ${inn.extras}`);
    console.log(`Total: ${inn.runs}/${inn.wickets} (${oversStr})`);
    console.log(`Fours: ${inn.fours} | Sixes: ${inn.sixes}`);

    // Bowling card
    console.log(
      `\n${pad("Bowler", 25)} ${pad("O", 6)} ${pad("R", 5)} ${pad("W", 4)} ${pad("Wd", 4)} ${pad("Nb", 4)} ${pad("Econ", 7)}`,
    );
    console.log(divider("-", 59));

    for (const [playerId, bw] of inn.bowlerStats) {
      const player = teams.flatMap(t => t.roster).find(p => p.id === playerId);
      const name = player?.name ?? playerId;
      // bw.overs = completed overs, bw.balls = remaining balls in current over
      const oversStr2 = bw.balls > 0 ? `${bw.overs}.${bw.balls}` : `${bw.overs}.0`;
      const totalBallsBowled = bw.overs * 6 + bw.balls;
      const actualOvers = totalBallsBowled / 6;
      const econ = actualOvers > 0 ? (bw.runs / actualOvers).toFixed(1) : "0.0";
      console.log(
        `${pad(name, 25)} ${pad(oversStr2, 6)} ${padNum(bw.runs, 5)} ${padNum(bw.wickets, 4)} ${padNum(bw.wides, 4)} ${padNum(bw.noballs, 4)} ${pad(econ, 7)}`,
      );
    }
  }

  console.log("\n" + divider("-"));
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  console.log(divider("="));
  console.log("            IPL 2026 SEASON SIMULATOR");
  console.log(divider("="));

  // Build teams with real players + auction
  const teams = buildTeams();

  // Run a full season
  console.log("\n" + divider("="));
  console.log("            SIMULATING SEASON...");
  console.log(divider("="));

  const rules = RULE_PRESETS.modern;
  const result = runSeason(teams, rules);

  // Print standings
  printStandings(result.standings, teams);

  // Print top run scorers
  printTopRunScorers(teams);

  // Print top wicket takers
  printTopWicketTakers(teams);

  // Print playoff results
  printPlayoffResults(result.schedule, teams);

  // Print champion
  const champion = teams.find(t => t.id === result.champion);
  console.log(divider("="));
  console.log(`\n    CHAMPION: ${champion?.name ?? result.champion}`);
  console.log("");

  // Orange and Purple cap
  const orangePlayer = teams.flatMap(t => t.roster).find(p => p.id === result.orangeCap.playerId);
  const purplePlayer = teams.flatMap(t => t.roster).find(p => p.id === result.purpleCap.playerId);
  console.log(`    Orange Cap: ${orangePlayer?.name ?? result.orangeCap.playerId} (${result.orangeCap.runs} runs)`);
  console.log(`    Purple Cap: ${purplePlayer?.name ?? result.purpleCap.playerId} (${result.purpleCap.wickets} wickets)`);
  console.log("");

  // Print sample scorecard
  printSampleScorecard(result.schedule, teams);

  // Quick sanity checks
  console.log("\n" + divider("="));
  console.log("            SANITY CHECKS");
  console.log(divider("="));

  const maxWins = Math.max(...result.standings.map(s => s.wins));
  const minWins = Math.min(...result.standings.map(s => s.wins));
  const topRuns = teams.flatMap(t => t.roster).sort((a, b) => b.stats.runs - a.stats.runs)[0];
  const topWickets = teams.flatMap(t => t.roster).sort((a, b) => b.stats.wickets - a.stats.wickets)[0];

  console.log(`Max wins by any team: ${maxWins}`);
  console.log(`Min wins by any team: ${minWins}`);
  console.log(`Top run scorer: ${topRuns.name} with ${topRuns.stats.runs} runs`);
  console.log(`Top wicket taker: ${topWickets.name} with ${topWickets.stats.wickets} wickets`);

  // Check match scores
  const groupMatches = result.schedule.filter(m => !m.isPlayoff && m.result);
  const scores = groupMatches.map(m => m.result!.innings[0].runs + m.result!.innings[1].runs);
  const avgTotal = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const minScore = Math.min(...groupMatches.map(m => Math.min(m.result!.innings[0].runs, m.result!.innings[1].runs)));
  const maxScore = Math.max(...groupMatches.map(m => Math.max(m.result!.innings[0].runs, m.result!.innings[1].runs)));
  console.log(`Average combined match total: ${avgTotal}`);
  console.log(`Lowest individual innings score: ${minScore}`);
  console.log(`Highest individual innings score: ${maxScore}`);
  console.log(divider("="));
}

main();
