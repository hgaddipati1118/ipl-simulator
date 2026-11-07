import { describe, it, expect } from "vitest";
import { EXTRA_LEAGUES, type RuleSet } from "@ipl-sim/engine";
import {
  createGameState, initSeason, playNextMatch, isSeasonComplete, runSeasonPhase, currentMatchInvolvesUser,
  type GameState,
} from "../game-state";

/**
 * App-level checks for every extra league: the league loads into a game, squads are valid under its rules,
 * and a whole season plays out (match by match, the way the Season page does) to a champion.
 */

function validateSquads(state: GameState): void {
  const { rules } = state;
  for (const team of state.teams) {
    expect(team.roster.length, `${team.id} squad size`).toBeGreaterThanOrEqual(rules.minSquadSize!);
    expect(team.roster.length, `${team.id} squad size`).toBeLessThanOrEqual(rules.maxSquadSize);
    expect(team.internationalCount, `${team.id} overseas in squad`).toBeLessThanOrEqual(rules.maxOverseasInSquad);
    expect(team.roster.some(p => p.isWicketKeeper), `${team.id} keeper`).toBe(true);
    const xi = team.getPlayingXI(rules.maxOverseasInXI);
    expect(xi).toHaveLength(11);
    expect(xi.filter(p => p.isInternational).length, `${team.id} overseas in XI`).toBeLessThanOrEqual(rules.maxOverseasInXI);
    expect(xi.some(p => p.isWicketKeeper), `${team.id} XI keeper`).toBe(true);
    expect(xi.filter(p => p.bowlingOvr >= 40).length, `${team.id} bowling options`).toBeGreaterThanOrEqual(5);
  }
}

describe.each(EXTRA_LEAGUES.map(l => [l.id, l] as const))("league %s", (_id, league) => {
  it("loads into a game with real squads that are valid under the league's rules", () => {
    const state = createGameState(league.rules);
    expect(state.teams.map(t => t.id)).toEqual(league.teams.map(t => t.id));
    expect(state.playerPool.length).toBeGreaterThan(500);
    validateSquads(state);
  });

  it("plays a full season match by match to a champion (group stage + playoffs)", () => {
    let state: GameState = createGameState({ ...league.rules, injuriesEnabled: false } as RuleSet);
    state = { ...state, userTeamId: null, phase: "season" };
    state = initSeason(state);
    const groupCount = (league.teams.length * league.rules.matchesPerTeam) / 2;
    expect(state.schedule).toHaveLength(groupCount);
    let guard = 0;
    while (!isSeasonComplete(state) && guard++ < 200) {
      expect(currentMatchInvolvesUser(state)).toBe(false);
      state = playNextMatch(state).state;
    }
    expect(isSeasonComplete(state)).toBe(true);
    const final = state.schedule.find(m => m.playoffType === "final")!;
    expect(league.teams.map(t => t.id)).toContain(final.result!.winnerId);
    const playoffs = state.schedule.filter(m => m.isPlayoff);
    const expected = { eliminator: 4, top3: 2, wbbl: 3 }[league.rules.playoffFormat as "eliminator" | "top3" | "wbbl"];
    expect(playoffs).toHaveLength(expected);
    // every team played its quota
    for (const team of state.teams) expect(team.matchesPlayed).toBe(league.rules.matchesPerTeam);
  });

  it("runSeasonPhase also produces a champion", () => {
    const state = runSeasonPhase({ ...createGameState({ ...league.rules, injuriesEnabled: false } as RuleSet), phase: "season" });
    expect(state.phase).toBe("results");
    expect(state.history).toHaveLength(1);
    expect(state.history[0].champion).toBeTruthy();
  });
});

describe("The Hundred in the app", () => {
  it("simulated matches are 100-ball innings", () => {
    let state = createGameState({ ...EXTRA_LEAGUES.find(l => l.id === "hundred-m")!.rules, injuriesEnabled: false } as RuleSet);
    state = initSeason({ ...state, phase: "season" });
    for (let i = 0; i < 12; i++) {
      const played = playNextMatch(state);
      state = played.state;
      for (const inn of played.result.innings) {
        expect(inn.totalBalls).toBeLessThanOrEqual(100);
        expect(inn.ballsPerOver).toBe(5);
      }
    }
  });

  it("players from the pool keep their ratings across leagues", () => {
    const hundred = createGameState(EXTRA_LEAGUES.find(l => l.id === "hundred-m")!.rules);
    const bbl = createGameState(EXTRA_LEAGUES.find(l => l.id === "bbl")!.rules);
    const byName = new Map(bbl.teams.flatMap(t => t.roster).map(p => [p.name, p]));
    const shared = hundred.teams.flatMap(t => t.roster).filter(p => byName.has(p.name));
    expect(shared.length).toBeGreaterThan(0);
    for (const p of shared) {
      const q = byName.get(p.name)!;
      expect(q.ratings.battingIQ).toBe(p.ratings.battingIQ);
      expect(q.ratings.wicketTaking).toBe(p.ratings.wicketTaking);
    }
    // "overseas" is relative to the league: an Australian is overseas in The Hundred, not in the BBL
    const aus = shared.find(p => p.country === "Australia");
    if (aus) {
      expect(aus.isInternational).toBe(true);
      expect(byName.get(aus.name)!.isInternational).toBe(false);
    }
  });
});
