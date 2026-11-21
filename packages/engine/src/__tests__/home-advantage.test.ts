/**
 * The leagues' home edge (home-advantage.ts; docs/LEAGUES.md, "Home advantage"): a side at its own ground gets `edge` balance points
 * when it bats and the visitors lose them when they bat, in both engines; nothing at a neutral, shared or borrowed ground, in T20Is,
 * ODIs or a league without a term.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEAGUE_HOME, battingHomeEdge, leagueHomeEdge } from "../home-advantage.js";
import { ballProbabilities, simulateMatch, type VenueContext } from "../match.js";
import { createMatchState, finalizeMatchState, simulateRemaining } from "../live-match.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { T20_FORMAT } from "../format.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });
const SAVED = { ...LEAGUE_HOME };
afterEach(() => {
  for (const k of Object.keys(LEAGUE_HOME)) delete LEAGUE_HOME[k];
  Object.assign(LEAGUE_HOME, SAVED);
});
const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false, impactPlayer: false };

function teams(): [Team, Team] {
  const real = getRealPlayers();
  return [IPL_TEAMS[0], IPL_TEAMS[1]].map(cfg => {
    const t = new Team(cfg);
    // the same players for both sides, so the sides are equal and only the ground separates them
    t.roster = real.slice(0, 15).map(d => createPlayerFromData({ ...d, id: `${cfg.id}_${d.id}`, teamId: cfg.id }));
    return t;
  }) as [Team, Team];
}

const side = (id: string, extra: { venueTeamId?: string; stadiumName?: string } = {}) => ({ id, config: { id, ...extra } });

describe("home edge", () => {
  it("applies only to league play at a side's own ground", () => {
    // as shipped no league has one: the fitted edge did not predict 2025+ better (docs/LEAGUES.md, "Home advantage")
    expect(SAVED).toEqual({});
    LEAGUE_HOME.bbl = 3;
    const r = { league: "bbl" };
    expect(leagueHomeEdge(r, side("a", { stadiumName: "A" }), side("b", { stadiumName: "B" }), false)).toBe(3);
    expect(leagueHomeEdge(r, side("a"), side("b"), true)).toBe(0); // neutral ground (playoffs)
    expect(leagueHomeEdge({ league: "psl" }, side("a"), side("b"), false)).toBe(0); // a league without a term
    expect(leagueHomeEdge({ league: "bbl", scoringContext: "t20i" }, side("a"), side("b"), false)).toBe(0); // T20I: the series tuning's
    expect(leagueHomeEdge({ league: "bbl", matchFormat: "odi" }, side("a"), side("b"), false)).toBe(0);
    expect(leagueHomeEdge(r, side("a", { stadiumName: "Dubai" }), side("b", { stadiumName: "Dubai" }), false)).toBe(0); // shared ground
    expect(leagueHomeEdge(r, side("a", { venueTeamId: "x" }), side("b", { venueTeamId: "x" }), false)).toBe(0); // Draft Match: borrowed
    expect(leagueHomeEdge(r, side("a", { venueTeamId: "x" }), side("b"), false)).toBe(0);
    expect(battingHomeEdge(3, true)).toBe(3);
    expect(battingHomeEdge(3, false)).toBe(-3);
    expect(battingHomeEdge(undefined, true)).toBe(0);
  });

  it("moves the ball toward the batting side by the edge, as a rating shift of the balance", () => {
    const [h] = teams();
    const [bat, bowl] = [h.roster[0], h.roster[10]];
    const venue: VenueContext = { stadiumBowlRating: 1, pitchType: "balanced", boundarySize: "medium", dewFactor: "none", profile: null, chaseAdvantage: 0 };
    const s = { over: 8, isSecondInnings: false, target: 0, currentScore: 60, ballsRemaining: 70, wicketsDown: 2, venue, inningsBalls: 120 };
    const base = ballProbabilities(bat, bowl, { ...s, rules: { freeHit: false, fmt: T20_FORMAT, gender: "male" } });
    const up = ballProbabilities(bat, bowl, { ...s, rules: { freeHit: false, fmt: T20_FORMAT, gender: "male", homeEdge: 4 } });
    const down = ballProbabilities(bat, bowl, { ...s, rules: { freeHit: false, fmt: T20_FORMAT, gender: "male", homeEdge: -4 } });
    expect(up.wicket).toBeLessThan(base.wicket);
    expect(up["4"]).toBeGreaterThan(base["4"]);
    expect(down.wicket).toBeGreaterThan(base.wicket);
    expect(down.dot).toBeGreaterThan(base.dot);
  });

  it("instant engine: the home side wins more with an edge; a neutral ground plays ball for ball as without one", () => {
    const [h, a] = teams();
    const N = 300;
    const play = (opts?: { neutralVenue?: boolean }) => {
      let home = 0;
      const scores: number[] = [];
      for (let i = 0; i < N; i++) {
        const m = simulateMatch(h, a, RULES, 5000 + i, { countTowardStandings: false, ...opts });
        if (m.winnerId === h.id) home++;
        scores.push(m.innings[0].runs, m.innings[1].runs);
      }
      return { home: home / N, scores };
    };
    delete LEAGUE_HOME.ipl;
    const off = play(), offNeutral = play({ neutralVenue: true });
    LEAGUE_HOME.ipl = 8;
    const on = play(), onNeutral = play({ neutralVenue: true });
    expect(on.home - off.home).toBeGreaterThan(0.06);
    expect(onNeutral.scores).toEqual(offNeutral.scores);
  });

  it("live engine: carries the same edge, stored on the state; none at a neutral ground", () => {
    const [h, a] = teams();
    LEAGUE_HOME.ipl = 8;
    expect(createMatchState(h, a, RULES, null, 1)._internal.homeEdge).toBe(8);
    expect(createMatchState(h, a, RULES, null, 1, { neutralVenue: true })._internal.homeEdge).toBeUndefined();
    // runs of the home side's innings less the visitors', over the same seeds: a large edge to see it in few matches
    const N = 60;
    const margin = () => {
      let d = 0;
      for (let i = 0; i < N; i++) {
        const f = finalizeMatchState(simulateRemaining(createMatchState(h, a, RULES, null, 7000 + i)).state);
        d += (f.battingFirstId === h.id ? 1 : -1) * (f.innings1Score - f.innings2Score);
      }
      return d / N;
    };
    LEAGUE_HOME.ipl = 20;
    const on = margin();
    delete LEAGUE_HOME.ipl;
    const off = margin();
    expect(on - off).toBeGreaterThan(15);
  });
});
