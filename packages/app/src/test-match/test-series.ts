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
  TEST_RECENCY_WEIGHT, isTestOpener, pickTestXI, testBattingSlot, testCountryCode, testDropped, testInningsScorecard, testKeeps,
  testPlayerOf, testProfileOf, testRecency,
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

/** The squad's shape once the regulars are in: two keepers, five seamers, two spinners, an all-rounder, two openers (16 in all) */
const SHAPE = { keepers: 2, pace: 5, spin: 2, allRounder: 1, openers: 2 };
/** Regulars (this share of the country's recent Tests or more) come in first, up to REGULARS_MAX players */
const REGULAR = 0.3;
const REGULARS_MAX = 13;

/**
 * A Test squad of 16 from a nation's players (their `ratings` the Test set), picked the way selectors do:
 * - the players who have retired or been dropped (none of the country's last six Tests, testDropped) are left out;
 * - two keepers on the keeping record (testKeeps), the regular one first;
 * - the regulars of the country's recent Tests, the most regular first (testRecency: the Cricsheet line-ups);
 * - then the shape is covered: five seamers, two spinners, an all-rounder (a front-line bowler who bats in the top seven),
 *   two openers;
 * - then the best of the rest.
 * Every choice ranks by the engine's Test value (testPlayerOf: batting survival and scoring, bowling wickets and economy)
 * plus TEST_RECENCY_WEIGHT times the recent-Tests share, less a little for a stale activity `tier` (international.ts: 0 = a
 * recent Test player, 1 = active at senior level, 2 = active three seasons ago). Seamer, spinner, opener or keeper comes from
 * the first-class record, not the T20 role, which the data leaves alone. The squad's keepers are flagged on the keeping
 * record only (markTestKeepers).
 */
export function pickTestSquad(players: readonly Player[], size = 16, tier: (p: Player) => number = () => 0): Player[] {
  const active = players.filter(p => !testDropped(p));
  const pool = active.length >= size ? active : [...players];
  const tp = new Map(pool.map(p => [p.id, testPlayerOf(p)]));
  const v = (p: Player) => tp.get(p.id)!;
  const recent = (p: Player) => TEST_RECENCY_WEIGHT * testRecency(p) - 0.2 * tier(p);
  const bat = (p: Player) => v(p).batValue + 0.3 * Math.max(0, v(p).bowlValue);
  const by = (value: (p: Player) => number) => (a: Player, b: Player) => (value(b) + recent(b)) - (value(a) + recent(a));
  const squad: Player[] = [];
  const add = (list: Player[], n: number) => {
    for (const p of list) {
      if (n <= 0 || squad.length >= size) break;
      if (!squad.includes(p)) { squad.push(p); n--; }
    }
  };
  const count = (f: (p: Player) => boolean) => squad.filter(f).length;
  const seamer = (p: Player) => v(p).bowler && !v(p).spin;
  const spinner = (p: Player) => v(p).bowler && v(p).spin;
  const allRounder = (p: Player) => v(p).bowler && testBattingSlot(p) <= 7.5;
  const opener = (p: Player) => !v(p).bowler && isTestOpener(p);
  add(pool.filter(testKeeps).sort(by(p => v(p).batValue + (testProfileOf(p)?.keep ?? 0.5))), SHAPE.keepers);
  add(pool.filter(p => testRecency(p) >= REGULAR).sort((a, b) => testRecency(b) - testRecency(a)), REGULARS_MAX - squad.length);
  add(pool.filter(seamer).sort(by(p => v(p).bowlValue)), SHAPE.pace - count(seamer));
  add(pool.filter(spinner).sort(by(p => v(p).bowlValue)), SHAPE.spin - count(spinner));
  add(pool.filter(allRounder).sort(by(p => v(p).batValue)), SHAPE.allRounder - count(allRounder));
  add(pool.filter(opener).sort(by(bat)), SHAPE.openers - count(opener));
  add([...pool].sort(by(p => Math.max(bat(p), v(p).bowlValue))), size - squad.length);
  markTestKeepers(squad);
  return squad;
}

/** A Test squad's keepers are the players who keep on the first-class record (testKeeps), not the T20 flag */
export function markTestKeepers(squad: readonly Player[]): void {
  for (const p of squad) p.isWicketKeeper = testKeeps(p);
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
