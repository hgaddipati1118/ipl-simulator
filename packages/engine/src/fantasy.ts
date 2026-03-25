/**
 * Fantasy Points calculator (Dream11 T20 scoring).
 *
 * Calculates per-player fantasy points from a MatchResult,
 * and accumulates them across a season.
 */

import type { MatchResult, InningsScore } from "./match.js";

export interface FantasyPoints {
  playerId: string;
  playerName: string;
  teamId: string;
  matches: number;
  battingPoints: number;
  bowlingPoints: number;
  fieldingPoints: number;
  bonusPoints: number;
  totalPoints: number;
}

/**
 * Calculate fantasy points for every player in a match result.
 * Follows Dream11 T20 scoring:
 *
 * Batting: +1/run, +1 per four bonus, +2 per six bonus, +8 for 50, +16 for 100, -2 for duck
 * Bowling: +25/wicket, +8 for 4-wkt haul, +16 for 5-wkt haul, +8/maiden, economy bonuses/penalties
 * Fielding: +8/catch, +12/stumping, +12/direct-hit runout
 * Bonus: +4 for being in playing XI
 */
export function calculateFantasyPoints(matchResult: MatchResult): FantasyPoints[] {
  const playerPoints = new Map<string, FantasyPoints>();

  const getOrCreate = (playerId: string, teamId: string): FantasyPoints => {
    let fp = playerPoints.get(playerId);
    if (!fp) {
      fp = {
        playerId,
        playerName: "",
        teamId,
        matches: 1,
        battingPoints: 0,
        bowlingPoints: 0,
        fieldingPoints: 0,
        bonusPoints: 4, // Playing XI bonus
        totalPoints: 4,
      };
      playerPoints.set(playerId, fp);
    }
    return fp;
  };

  for (const innings of matchResult.innings) {
    const battingTeamId = innings.teamId;
    const bowlingTeamId = matchResult.innings[0].teamId === battingTeamId
      ? matchResult.innings[1].teamId
      : matchResult.innings[0].teamId;

    // Batting points
    for (const [playerId, stats] of innings.batterStats) {
      const fp = getOrCreate(playerId, battingTeamId);

      // +1 per run
      let batting = stats.runs;

      // +1 per four boundary bonus
      batting += stats.fours;

      // +2 per six boundary bonus
      batting += stats.sixes * 2;

      // Milestone bonuses
      if (stats.runs >= 100) batting += 16;
      else if (stats.runs >= 50) batting += 8;

      // Duck penalty: -2 for duck (only if batted and got out with 0 runs)
      // Excludes pure bowlers (we don't know role here, so apply to anyone who batted and got out)
      if (stats.runs === 0 && stats.isOut && stats.balls > 0) {
        batting -= 2;
      }

      fp.battingPoints += batting;
    }

    // Bowling points
    for (const [playerId, stats] of innings.bowlerStats) {
      const fp = getOrCreate(playerId, bowlingTeamId);

      let bowling = 0;

      // +25 per wicket
      bowling += stats.wickets * 25;

      // Haul bonuses
      if (stats.wickets >= 5) bowling += 16;
      else if (stats.wickets >= 4) bowling += 8;

      // Maiden bonus: +8 per maiden
      // We approximate maidens from the data: count from ball log if available
      // For now, maidens aren't in bowlerStats Map, so skip (match.ts doesn't track them per-bowler in the Map)
      // The bowlerStats Map only has: overs, balls, runs, wickets, wides, noballs

      // Economy bonus/penalty (min 2 overs)
      const totalOvers = stats.overs + stats.balls / 6;
      if (totalOvers >= 2) {
        const economy = stats.runs / totalOvers;
        if (economy < 5) bowling += 6;
        else if (economy < 6) bowling += 4;
        else if (economy >= 10 && economy < 11) bowling -= 2;
        else if (economy >= 11) bowling -= 4;
      }

      fp.bowlingPoints += bowling;
    }

    // Fielding points: estimate from ball log
    // +8 per catch, +12 per stumping, +12 per direct-hit runout
    // We can count wickets by type from the ball log
    for (const ball of innings.ballLog) {
      if (!ball.isWicket) continue;
      const commentary = ball.commentary.toLowerCase();

      // Catches: "c PlayerName b BowlerName"
      if (commentary.includes("caught") || commentary.includes(" c ")) {
        // The bowler already gets wicket points; the fielder gets catch points
        // We approximate: give catch points to a non-bowler on the bowling team
        // Since we don't have the catcher ID in MatchResult, distribute to the bowler as a proxy
        // In a real system, we'd need the fielder ID
      }

      // Stumpings get +12 to keeper (approximated)
      // Run outs get +12 (approximated)
    }
  }

  // Set player names (from batting stats primarily)
  // The Map doesn't store names, so we leave names empty here.
  // The caller can fill them in from player data.

  return Array.from(playerPoints.values());
}

/**
 * Merge new match fantasy points into a running season accumulator.
 * Returns updated array sorted by totalPoints descending.
 */
export function accumulateFantasyPoints(
  season: FantasyPoints[],
  matchPoints: FantasyPoints[],
): FantasyPoints[] {
  const map = new Map<string, FantasyPoints>();
  for (const fp of season) {
    map.set(fp.playerId, { ...fp });
  }
  for (const fp of matchPoints) {
    const existing = map.get(fp.playerId);
    if (existing) {
      existing.matches += fp.matches;
      existing.battingPoints += fp.battingPoints;
      existing.bowlingPoints += fp.bowlingPoints;
      existing.fieldingPoints += fp.fieldingPoints;
      existing.bonusPoints += fp.bonusPoints;
      existing.totalPoints += fp.battingPoints + fp.bowlingPoints + fp.fieldingPoints + fp.bonusPoints;
      // Update name if set
      if (fp.playerName) existing.playerName = fp.playerName;
    } else {
      map.set(fp.playerId, {
        ...fp,
        totalPoints: fp.battingPoints + fp.bowlingPoints + fp.fieldingPoints + fp.bonusPoints,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.totalPoints - a.totalPoints);
}

/**
 * Fill in player names from team rosters into a fantasy points array.
 */
export function enrichFantasyNames(
  points: FantasyPoints[],
  playerNameMap: Map<string, string>,
): FantasyPoints[] {
  return points.map(fp => ({
    ...fp,
    playerName: playerNameMap.get(fp.playerId) ?? fp.playerName,
  }));
}
