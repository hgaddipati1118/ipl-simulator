/**
 * Post-match narrative event generator.
 *
 * Produces 1-3 headline/body events after each match to create a sense
 * of an ongoing season story: media praise, board pressure, milestones, etc.
 */

export interface NarrativeEvent {
  type: "praise" | "criticism" | "media" | "board" | "milestone" | "rivalry";
  headline: string;
  body: string;
  teamId?: string;
  playerId?: string;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface PostMatchNarrativeParams {
  winnerName: string;
  loserName: string;
  margin: string;
  manOfMatch?: { name: string; runs?: number; wickets?: number };
  userTeamId: string | null;
  userTeamWon: boolean;
  /** 1-indexed position in standings */
  seasonPosition: number;
  matchesPlayed: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  /** Optional season stats for milestone checks */
  seasonRunsLeader?: { name: string; runs: number; playerId?: string };
  seasonWicketsLeader?: { name: string; wickets: number; playerId?: string };
}

export function generatePostMatchNarrative(params: PostMatchNarrativeParams): NarrativeEvent[] {
  const {
    winnerName, loserName, margin, manOfMatch,
    userTeamWon, seasonPosition, matchesPlayed,
    consecutiveLosses, consecutiveWins,
    seasonRunsLeader, seasonWicketsLeader,
  } = params;

  const events: NarrativeEvent[] = [];

  // 1. Man of the Match praise (always if available)
  if (manOfMatch) {
    const { name, runs, wickets } = manOfMatch;
    let reason = "";
    if (runs && runs > 0 && wickets && wickets > 0) {
      reason = `a stunning all-round display of ${runs} runs and ${wickets} wickets`;
    } else if (runs && runs >= 50) {
      reason = `a brilliant knock of ${runs} runs`;
    } else if (runs && runs > 0) {
      reason = `a crucial innings of ${runs} runs`;
    } else if (wickets && wickets >= 3) {
      reason = `a devastating spell of ${wickets} wickets`;
    } else if (wickets && wickets > 0) {
      reason = `a match-winning ${wickets}-wicket haul`;
    } else {
      reason = `an outstanding performance`;
    }

    events.push({
      type: "praise",
      headline: pick([
        `${name} steals the show!`,
        `${name} earns Player of the Match!`,
        `Superb performance from ${name}!`,
        `${name} shines as ${winnerName} triumph!`,
      ]),
      body: `${name} picks up the Player of the Match award for ${reason} as ${winnerName} beat ${loserName} by ${margin}.`,
      playerId: manOfMatch.name,
    });
  }

  // 2. Win streaks
  if (consecutiveWins >= 5) {
    events.push({
      type: "media",
      headline: `Unstoppable! ${winnerName} make it ${consecutiveWins} in a row!`,
      body: `${winnerName} continue their incredible winning run. The rest of the league will be watching nervously.`,
      teamId: winnerName,
    });
  } else if (consecutiveWins >= 3) {
    events.push({
      type: "media",
      headline: pick([
        `${winnerName} on fire with ${consecutiveWins} wins in a row!`,
        `${winnerName} building serious momentum!`,
        `Red-hot ${winnerName} extend winning streak to ${consecutiveWins}!`,
      ]),
      body: `${winnerName} are clicking at the right time with ${consecutiveWins} consecutive victories. Playoff hopes looking bright.`,
      teamId: winnerName,
    });
  }

  // 3. Loss streaks
  if (consecutiveLosses >= 5) {
    events.push({
      type: "board",
      headline: `Crisis at ${loserName}! ${consecutiveLosses} straight defeats!`,
      body: `The board is running out of patience. With ${consecutiveLosses} consecutive losses, serious questions are being asked about the team's strategy and selections.`,
      teamId: loserName,
    });
  } else if (consecutiveLosses >= 3) {
    events.push({
      type: "criticism",
      headline: pick([
        `Pressure mounting on ${loserName} after ${consecutiveLosses} consecutive defeats`,
        `${loserName} in trouble with ${consecutiveLosses} losses on the bounce`,
        `Fans frustrated as ${loserName} slump continues`,
      ]),
      body: `${loserName} need to find answers quickly. ${consecutiveLosses} losses in a row have left the camp under immense pressure.`,
      teamId: loserName,
    });
  }

  // 4. Board warning (playoff hopes fading)
  if (matchesPlayed >= 10 && seasonPosition > 6) {
    events.push({
      type: "board",
      headline: pick([
        `Board unhappy -- playoff hopes fading for ${userTeamWon ? loserName : winnerName}`,
        `Tough road ahead: position #${seasonPosition} after ${matchesPlayed} matches`,
        `Season slipping away? Work to do after ${matchesPlayed} games`,
      ]),
      body: `Sitting at #${seasonPosition} in the table after ${matchesPlayed} matches, the playoffs are looking like a distant dream. Something needs to change, and fast.`,
    });
  }

  // 5. Season milestones (run/wicket leaders)
  if (seasonRunsLeader && seasonRunsLeader.runs >= 500 && seasonRunsLeader.runs % 100 < 50) {
    events.push({
      type: "milestone",
      headline: `${seasonRunsLeader.name} crosses ${Math.floor(seasonRunsLeader.runs / 100) * 100} runs for the season!`,
      body: `${seasonRunsLeader.name} leads the run charts with ${seasonRunsLeader.runs} runs. A remarkable season so far.`,
      playerId: seasonRunsLeader.playerId,
    });
  }

  if (seasonWicketsLeader && seasonWicketsLeader.wickets >= 15 && seasonWicketsLeader.wickets % 5 === 0) {
    events.push({
      type: "milestone",
      headline: `${seasonWicketsLeader.name} reaches ${seasonWicketsLeader.wickets} wickets for the season!`,
      body: `${seasonWicketsLeader.name} is the leading wicket-taker with ${seasonWicketsLeader.wickets} scalps. Bowlers like that win tournaments.`,
      playerId: seasonWicketsLeader.playerId,
    });
  }

  // Limit to 3 events max
  return events.slice(0, 3);
}
