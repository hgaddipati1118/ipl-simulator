/**
 * Test cricket as a format of the International series (international.ts SERIES_FORMATS): squads picked for a Test's shape,
 * the engine's own Test XI and batting order, the lineup check, playing a Test instantly or starting a live one from a series
 * match, and the series record a finished Test leaves.
 *
 * A Test's full state (every ball, the match notes) is a few hundred KB, too big for the series' localStorage record, so it
 * goes to IndexedDB under "intl-<series id>-<match>" (test-db.ts): a live Test saves there as it is played, an instant one when
 * it is simulated. The record keeps the innings scorecards and a score line, so the series hub and its stats need only the
 * record; the Test scorecard reads the saved state.
 */

import {
  keepingRating, pickTestXI, testCountryCode, testInningsScorecard, testPlayerOf,
  type Player, type Team, type TestMatchState,
} from "@ipl-sim/engine";
import type {
  IntlSeries, SeriesFormatDef, SeriesLineup, SeriesMatchContext, SeriesMatchRecord, SeriesVenue,
} from "../international";
import { playTestInstantly, startTestLive, type TestFixtureSetup } from "./test-entry";
import { saveLiveTest } from "./test-db";
import { readableTeamColor, teamScoreLine } from "./test-view";

// ── Squads and XIs ─────────────────────────────────────────────────────

/** Host countries where a side picks a second spinner (the engine's pickTestXI region) */
const SUBCONTINENT = new Set(["IND", "PAK", "SL", "BDESH", "UAE"]);

/** The squad's shape: two keepers, five seamers, two spinners, one more bowler of either kind, six batters (16) */
const SHAPE = { keepers: 2, pace: 5, spin: 2, extraBowler: 1, batters: 6 };

/**
 * A Test squad of 16 from a nation's players (their `ratings` the Test set): on the engine's Test values (testPlayerOf: batting
 * survival and scoring, bowling wickets and economy in fitted log-rate units), so a red-ball specialist is not left out for a
 * white-ball name. Two keepers, five seamers, two spinners, a further bowler, then the six best batters (all-rounders
 * count with their bowling); a small pool is filled with the best of the rest. Within each of these, players of a lower
 * `tier` come first (international.ts: 0 = a recent Test player, 1 = active at senior level, 2 = active three seasons ago).
 */
export function pickTestSquad(players: readonly Player[], size = 16, tier: (p: Player) => number = () => 0): Player[] {
  const tp = new Map(players.map(p => [p.id, testPlayerOf(p)]));
  const v = (p: Player) => tp.get(p.id)!;
  const bat = (p: Player) => v(p).batValue + 0.3 * Math.max(0, v(p).bowlValue);
  // tier first, then the value
  const by = (value: (p: Player) => number) => (a: Player, b: Player) => tier(a) - tier(b) || value(b) - value(a);
  const squad: Player[] = [];
  const add = (list: Player[], n: number) => {
    for (const p of list) {
      if (n <= 0 || squad.length >= size) break;
      if (!squad.includes(p)) { squad.push(p); n--; }
    }
  };
  add(players.filter(p => p.isWicketKeeper).sort(by(p => v(p).batValue + 0.01 * keepingRating(p))), SHAPE.keepers);
  const bowlers = () => players.filter(p => v(p).bowler && !squad.includes(p)).sort(by(p => v(p).bowlValue));
  add(bowlers().filter(p => !v(p).spin), SHAPE.pace);
  add(bowlers().filter(p => v(p).spin), SHAPE.spin);
  add(bowlers(), SHAPE.extraBowler);
  add(players.filter(p => !p.isWicketKeeper && !squad.includes(p)).sort(by(bat)), SHAPE.batters);
  add([...players].sort(by(p => Math.max(bat(p), v(p).bowlValue))), size - squad.length);
  return squad;
}

/** "sub" when the series is played in the subcontinent (two spinners in the XI), else "other" */
export function seriesTestRegion(series: Pick<IntlSeries, "host" | "sides">): "sub" | "other" {
  if (series.host === "neutral") return "other";
  const code = testCountryCode(series.sides[series.host === "a" ? 0 : 1].country);
  return code && SUBCONTINENT.has(code) ? "sub" : "other";
}

/** The engine's own Test XI for a squad (keeper, four or five bowlers with the conditions' spinners, batters) in order */
export function testAutoLineup(squad: readonly Player[], series: Pick<IntlSeries, "host" | "sides">): SeriesLineup {
  const xi = pickTestXI(squad, seriesTestRegion(series)).map(p => p.id);
  return { xi, order: xi };
}

/** Problems with a Test XI the user picked: eleven players, a keeper, at least four bowlers (empty = fine) */
export function testLineupProblems(squad: readonly Player[], lineup: SeriesLineup): string[] {
  const byId = new Map(squad.map(p => [p.id, p]));
  const xi = lineup.xi.map(id => byId.get(id)).filter((p): p is Player => !!p);
  const out: string[] = [];
  if (xi.length !== 11) out.push(`${xi.length}/11 players`);
  if (!xi.some(p => p.isWicketKeeper)) out.push("No wicket-keeper");
  const bowl = xi.filter(p => testPlayerOf(p).bowler).length;
  if (bowl < 4) out.push(`${bowl}/4 bowlers`);
  return out;
}

// ── Playing ────────────────────────────────────────────────────────────

/** IndexedDB key (test-db.ts) of a series Test's state, from international.ts seriesMatchKey */
export function testStoreKey(matchKey: string): string {
  return `intl-${matchKey}`;
}

const nationName = (name: string) => name.replace(/ Women$/, "").trim();

/** The user's XI in batting order when he picked one (teamsForMatch puts it on his Team) */
function userXI(t: Team): string[] | undefined {
  if (t.userPlayingXI?.length !== 11) return undefined;
  return t.userBattingOrder?.length === 11 ? t.userBattingOrder : t.userPlayingXI;
}

/** A series match as a Test fixture: the host's conditions (or a neutral ground), the user's XI, England's batting style */
export function testFixture(ctx: SeriesMatchContext): TestFixtureSetup {
  const xi: Record<string, string[]> = {};
  for (const t of [ctx.home, ctx.away]) {
    const ids = userXI(t);
    if (ids) xi[t.id] = ids;
  }
  const england = ctx.gender === "men" ? [ctx.home, ctx.away].find(t => nationName(t.name) === "England") : undefined;
  return {
    home: ctx.home, away: ctx.away, seed: ctx.seed, venueName: ctx.venue.name,
    ...(ctx.venue.neutral ? { neutral: true } : { country: testCountryCode(nationName(ctx.home.name)) }),
    ...(Object.keys(xi).length ? { xi } : {}),
    ...(england ? { bazballTeamId: england.id } : {}),
  };
}

/** The series record of a finished Test */
export function testRecord(st: TestMatchState, venue: SeriesVenue, seed: number, mode: "live" | "sim"): SeriesMatchRecord {
  const r = st.result;
  const first = st.innings[0]?.battingTeamId ?? st.teamOrder[0];
  const order = [first, ...st.teamOrder.filter(id => id !== first)];
  return {
    n: 0, seed, mode, venue: venue.neutral ? "Neutral venue" : venue.name,
    homeTeamId: st.teamOrder[0], awayTeamId: st.teamOrder[1],
    winnerId: r?.kind === "win" ? r.winnerId : null,
    result: r?.text ?? "Match abandoned",
    tossWinnerName: st.toss ? st.teams[st.toss.winnerId].name : "",
    tossDecision: st.toss?.decision ?? "bat",
    innings: st.innings.map(i => testInningsScorecard(st, i)),
    worm: [],
    ...(r?.playerOfMatch.playerId ? { potm: r.playerOfMatch } : {}),
    summary: order.map(id => `${st.teams[id].shortName} ${teamScoreLine(st, id)}`).join(" · "),
  };
}

/** Team colours readable as text on the page (a national primary can be near black or pale yellow) */
export function seriesTestColors(series: Pick<IntlSeries, "sides">): Record<string, string> {
  return Object.fromEntries(series.sides.map(s => [s.id, readableTeamColor(s.primaryColor)]));
}

/** The Test entry of SERIES_FORMATS */
export function testSeriesFormat(): SeriesFormatDef {
  return {
    id: "test", label: "Test", desc: "Two innings a side over five days (women: four)", ratingFormat: "test",
    lengths: [1, 2, 3, 4, 5],
    simulate(ctx) {
      const { state } = playTestInstantly(testFixture(ctx));
      if (ctx.key) void saveLiveTest(testStoreKey(ctx.key), state);
      return testRecord(state, ctx.venue, ctx.seed, "sim");
    },
    live: {
      viewer: "test",
      create: (ctx, userTeamId): TestMatchState => startTestLive(testFixture(ctx), userTeamId),
      finish: (st: TestMatchState, ctx) => testRecord(st, ctx.venue, ctx.seed, "live"),
    },
    autoLineup: testAutoLineup,
    lineupProblems: testLineupProblems,
  };
}
