import { describe, expect, it } from "vitest";
import { RULE_PRESETS, createMatchState, simulateRemaining, getStandings, type MatchState } from "@ipl-sim/engine";
import { createGameState, initSeason, stateAfterLiveMatch, type GameState } from "../game-state";

/**
 * React calls a state updater twice in StrictMode (dev) and keeps the second result. The App's update for a finished
 * live match used to apply the result to the teams in place, so the second call counted the match again: two wins,
 * twice the net run rate, players' matches counted twice. stateAfterLiveMatch is pure.
 */

function seasonState(): GameState {
  const base = createGameState(RULE_PRESETS.modern2026);
  return initSeason({ ...base, userTeamId: base.teams[0].id, phase: "season" });
}

function playCurrentMatch(s: GameState, seed: number): MatchState {
  const m = s.schedule[s.currentMatchIndex];
  const home = s.teams.find(t => t.id === m.homeTeamId)!;
  const away = s.teams.find(t => t.id === m.awayTeamId)!;
  return simulateRemaining(createMatchState(home, away, s.rules, null, seed)).state;
}

const totalWins = (s: GameState) => s.teams.reduce((n, t) => n + t.wins, 0);
const totalTies = (s: GameState) => s.teams.reduce((n, t) => n + t.ties, 0);
const matchesPlayed = (s: GameState) => s.teams.reduce((n, t) => n + t.roster.reduce((k, p) => k + p.stats.matches, 0), 0);

describe("the App's state update for a finished live match", () => {
  it("applied twice to the same state (StrictMode) counts the match once and leaves that state as it was", () => {
    const prev = seasonState();
    const idx = prev.currentMatchIndex;
    const done = playCurrentMatch(prev, 4242);
    const before = { wins: totalWins(prev), ties: totalTies(prev), matches: matchesPlayed(prev), standings: JSON.stringify(getStandings(prev.teams)) };

    const first = stateAfterLiveMatch(prev, done, idx)!;
    const second = stateAfterLiveMatch(prev, done, idx)!; // what React keeps

    // the previous state is untouched
    expect(totalWins(prev)).toBe(before.wins);
    expect(totalTies(prev)).toBe(before.ties);
    expect(matchesPlayed(prev)).toBe(before.matches);
    expect(JSON.stringify(getStandings(prev.teams))).toBe(before.standings);
    expect(prev.schedule[idx].result).toBeUndefined();
    expect(prev.currentMatchIndex).toBe(idx);

    // one result: a win (or a point each for a no result), 22 players with a match each
    for (const s of [first, second]) {
      expect(s.currentMatchIndex).toBe(idx + 1);
      expect(totalWins(s) + totalTies(s) / 2).toBe(1);
      expect(matchesPlayed(s)).toBe(22);
      expect(s.matchResults).toHaveLength(1);
      expect(s.schedule[idx].result).toBeDefined();
    }
    expect(JSON.stringify(getStandings(second.teams))).toBe(JSON.stringify(getStandings(first.teams)));
  });

  it("ignores a completion for a match that is no longer the current one (late or repeated)", () => {
    const prev = seasonState();
    const idx = prev.currentMatchIndex;
    const done = playCurrentMatch(prev, 99);
    const after = stateAfterLiveMatch(prev, done, idx)!;
    expect(stateAfterLiveMatch(after, done, idx)).toBe(after);
    expect(stateAfterLiveMatch(null, done, idx)).toBeNull();
  });
});
