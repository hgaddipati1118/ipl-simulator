import { afterEach, describe, expect, it } from "vitest";
import { createMatchState, simulateRemaining, type MatchState } from "../live-match.js";
import { applyLiveResult, type ScheduledMatch } from "../schedule.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { setRuleOverrides } from "../delivery-rules.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };

function iplTeams(): Team[] {
  const teams = IPL_TEAMS.map(c => new Team(c, RULES.salaryCap));
  for (const d of getRealPlayers()) {
    const team = teams.find(t => t.id === d.teamId);
    if (team) team.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
  }
  return teams;
}

afterEach(() => setRuleOverrides(null));

/**
 * A live season match that rain abandons in the first innings ends without a second innings (`innings1Raw` never set).
 * Applying it to the season read that missing innings and threw, inside the app's state update, which blanked the whole
 * page right after the match (the e2e "blank page after Continue").
 */
describe("applying a live match abandoned in the first innings", () => {
  it("records a no result like simulateMatch: the innings played, then an empty one", () => {
    setRuleOverrides({ rainReduced: 0, rainNoResult: 1 });
    let found: { state: MatchState; teams: Team[] } | null = null;
    for (let i = 0; i < 40 && !found; i++) {
      const teams = iplTeams();
      const { state } = simulateRemaining(createMatchState(teams[0], teams[1], RULES, null, 9100 + i, { rain: true }));
      if (state.result === "No result (rain)" && !state._internal.innings1Raw) found = { state, teams };
    }
    expect(found, "a seed with the rain coming in the first innings").not.toBeNull();
    const { state, teams } = found!;

    const schedule: ScheduledMatch[] = [{ matchNumber: 1, homeTeamId: teams[0].id, awayTeamId: teams[1].id, isPlayoff: false, type: "group" }];
    const result = applyLiveResult(schedule, 0, teams, state, RULES);

    expect(result.winnerId).toBeNull();
    expect(result.margin).toBe("No result");
    expect(result.innings[0].teamId).toBe(state._internal.battingFirstId);
    expect(result.innings[0].totalBalls).toBe(state.overs * 6 + state.balls);
    expect(result.innings[1]).toMatchObject({ teamId: state._internal.bowlingFirstId, runs: 0, totalBalls: 0 });
    expect(schedule[0].result).toBe(result);
    // a point each
    expect(teams[0].ties).toBe(1);
    expect(teams[1].ties).toBe(1);
  });
});
