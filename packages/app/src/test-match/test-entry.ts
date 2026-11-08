/**
 * Entry points for playing a Test from anywhere in the app (the International series page, the dev route): two sides, the
 * venue and options in; a whole Test instantly (result, scorecards, events, the final state), or a live match state that
 * LiveTestPage plays with the user captaining one side. The engine does the cricket (packages/engine/src/test-match.ts,
 * test-live.ts; docs/FORMATS-TEST.md).
 */

import {
  simulateTestMatch, startLiveTest, Team,
  type TestMatchOptions, type TestMatchResult, type TestMatchState,
} from "@ipl-sim/engine";

export interface TestFixtureSetup {
  home: Team;
  away: Team;
  /** Host country code (IND, ENG, AUS ...: conditions, weather, the toss) and the ground's name */
  country?: string;
  venueName?: string;
  /** XIs in batting order by team id (else each side's XI is picked from its squad on Test ratings) */
  xi?: Record<string, string[]>;
  seed?: number;
  /** Scheduled days (default 5 men, 4 women), weather (default on), a neutral ground, women's Test */
  days?: number;
  weather?: boolean;
  neutral?: boolean;
  gender?: "male" | "female";
  /** England's batting since June 2022: the fitted Bazball factor for this team id */
  bazballTeamId?: string;
  /** Post-match injury checks (instant only) */
  injuries?: boolean;
}

function engineOptions(s: TestFixtureSetup): TestMatchOptions {
  return {
    seed: s.seed, country: s.country, venueName: s.venueName, xi: s.xi, days: s.days, weather: s.weather, neutral: s.neutral,
    gender: s.gender, bazballTeamId: s.bazballTeamId, injuries: s.injuries,
  };
}

/** A whole Test with CPU captains on both sides */
export function playTestInstantly(setup: TestFixtureSetup): TestMatchResult {
  return simulateTestMatch(setup.home, setup.away, engineOptions(setup));
}

/**
 * A live Test for LiveTestPage: the user captains `userTeamId` (commentary on every ball; waits for his toss call if he wins
 * it). `pickBatters` asks him for the next batter at every wicket (the nightwatchman call is always his).
 */
export function startTestLive(setup: TestFixtureSetup, userTeamId: string, opts: { pickBatters?: boolean } = {}): TestMatchState {
  return startLiveTest(setup.home, setup.away, { ...engineOptions(setup), userTeamId, pickBatters: opts.pickBatters });
}
