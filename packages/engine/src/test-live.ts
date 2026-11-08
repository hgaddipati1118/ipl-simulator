/**
 * Live Test matches: the user plays ball by ball or skips ahead by over, session, day or innings, and makes the Test
 * decisions (docs/FORMATS-TEST.md section 4):
 *
 *  - pauses for: the toss call, enforcing the follow-on, the new ball when it falls due, DRS reviews (his batter given out
 *    lbw / caught behind; an appeal of his bowlers turned down), the next batter when a wicket falls late in the day (send a
 *    nightwatchman?) or at every wicket with `pickBatters`;
 *  - between any two balls: declare, the batting approach (defend / normal / attack, or back to the captain's own policy),
 *    the next batter in, a bowling change (from the next over at the end that bowls next), the new ball once due.
 *
 * Everything the user does not decide, the CPU captain does with the fitted policies (test-match.ts): bowling changes and
 * spells, declarations for CPU sides, the approach before a declaration, the follow-on and reviews when skipping with
 * autoDecide. The state is the one simulateTestMatch runs (TestMatchState); these functions mutate it and return it or what
 * happened. Serialise it with serializeTestState: the random stream is in the state, so a loaded match carries on exactly.
 */

import type { Team } from "./team.js";
import {
  applyTestDecision, autoResolveTestDecision, changeTestBowler, createTestMatch, currentInnings, declareInnings,
  oversLeftInMatch, setNextBatter, setTestApproach, stepTestBall, takeNewBall, testLead, testMatchResult, testTarget,
  type TestApproach, type TestBallEvent, type TestMatchEvent, type TestMatchOptions, type TestMatchResult, type TestMatchState,
  type TestPendingDecision,
} from "./test-match.js";

export type TestAdvanceUntil = "ball" | "over" | "session" | "day" | "innings" | "match";

/** Start a live Test for `userTeamId` (one of the two sides): commentary on; waits for the toss call if the user wins it */
export function startLiveTest(home: Team, away: Team, options: TestMatchOptions & { userTeamId: string }): TestMatchState {
  if (options.userTeamId !== home.id && options.userTeamId !== away.id) throw new Error("userTeamId must be one of the two sides");
  return createTestMatch(home, away, { commentary: true, ...options });
}

export interface TestAdvanceResult {
  balls: TestBallEvent[];
  /** Match events in the stretch played (day starts, sessions, declarations, the new ball, the result ...) */
  events: TestMatchEvent[];
  /** The decision the advance stopped for (absent when it reached its boundary or the end) */
  pending?: TestPendingDecision;
}

/**
 * Play until the boundary: the next ball, the end of the over, the session, the day, the innings or the match. Stops early
 * at a decision for the user, unless `autoDecide` (then the CPU captain answers it: toss, follow-on, new ball, reviews).
 */
export function advanceTest(st: TestMatchState, until: TestAdvanceUntil, opts: { autoDecide?: boolean } = {}): TestAdvanceResult {
  const balls: TestBallEvent[] = [];
  const ev0 = st.events.length;
  const start = { day: st.day, session: st.session, inn: st.innings.length, over: overIndex(st) };
  const done = () => {
    if (st.status === "completed") return true;
    if (until === "ball") return balls.length > 0;
    const inn = currentInnings(st);
    if (st.innings.length !== start.inn && until !== "match") return true;
    if (until === "over") return balls.length > 0 && (inn?.overBalls ?? 0) === 0 && overIndex(st) !== start.over;
    if (until === "session") return st.day !== start.day || st.session !== start.session;
    if (until === "day") return st.day !== start.day;
    return false;
  };
  for (let guard = 0; guard < 20000 && !done(); guard++) {
    if (st.status === "waiting_for_decision") {
      if (!opts.autoDecide) break;
      const b = autoResolveTestDecision(st);
      if (b) balls.push(b);
      continue;
    }
    const b = stepTestBall(st);
    if (b) balls.push(b);
  }
  return { balls, events: st.events.slice(ev0), ...(st.status === "waiting_for_decision" && st.pending ? { pending: st.pending } : {}) };
}

function overIndex(st: TestMatchState): number {
  const inn = currentInnings(st);
  return inn ? Math.floor(inn.legalBalls / 6) : 0;
}

/** The user's answer to the pending decision (one of its options); returns the delivery a DRS call completed, if any */
export function decideTest(st: TestMatchState, choice: string): TestBallEvent | null {
  return applyTestDecision(st, choice);
}

/** The user's side declares now (innings 1-3, his side batting) */
export function declareTest(st: TestMatchState): void {
  const inn = currentInnings(st);
  if (!inn || inn.battingTeamId !== st.userTeamId) throw new Error("Only the batting side can declare");
  declareInnings(st);
}

/** The batting approach of the user's side; null returns it to the captain's fitted policy */
export function setTestBattingApproach(st: TestMatchState, approach: TestApproach | null): void {
  if (!st.userTeamId) throw new Error("No user side");
  setTestApproach(st, st.userTeamId, approach);
}

/** The user's side takes the new ball (fielding, once 80 overs have been bowled with the old one) */
export function takeTestNewBall(st: TestMatchState): boolean {
  const inn = currentInnings(st);
  if (!inn || inn.bowlingTeamId !== st.userTeamId) return false;
  return takeNewBall(st);
}

/** The user's side brings `bowlerId` on from the next over at the end that bowls next */
export function changeTestBowlerTo(st: TestMatchState, bowlerId: string, opts: { keepOn?: boolean } = {}): void {
  const inn = currentInnings(st);
  if (!inn || inn.bowlingTeamId !== st.userTeamId) throw new Error("The user's side is not fielding");
  changeTestBowler(st, bowlerId, opts);
}

/** The user's next batter in at the next wicket (null: back to the order and the captain's nightwatchman call) */
export function setTestNextBatter(st: TestMatchState, batterId: string | null): void {
  const inn = currentInnings(st);
  if (!inn || inn.battingTeamId !== st.userTeamId) throw new Error("The user's side is not batting");
  setNextBatter(st, batterId);
}

/** The CPU captain also takes the user's own decisions (declarations, approach, reviews, the follow-on) while on */
export function setTestAutoCaptain(st: TestMatchState, on: boolean): void {
  st.autoUser = on;
}

export interface TestBowlingOption {
  playerId: string;
  name: string;
  bowlingStyle: string;
  spin: boolean;
  /** In the attack (bowlers, all-rounders); the rest are part-timers */
  frontLine: boolean;
  overs: string;
  maidens: number;
  runs: number;
  wickets: number;
  spellOvers: number;
  oversToday: number;
  /** Overs since his last over in this innings (99 = not bowled) */
  rested: number;
  /** He bowled the previous over and cannot bowl the next */
  blocked: boolean;
  /** Past the overs the data shows (long spell, heavy day): he is tiring */
  tiring: boolean;
}

/** The fielding side's bowlers for a bowling change, with their figures, spell and workload */
export function testBowlingOptions(st: TestMatchState): TestBowlingOption[] {
  const inn = currentInnings(st);
  if (!inn) return [];
  const team = st.teams[inn.bowlingTeamId];
  const overs = Math.floor(inn.legalBalls / 6);
  const nextEnd = inn.overBalls === 0 ? inn.end : (inn.end === 0 ? 1 : 0);
  const blockedId = inn.overBalls === 0 ? inn.ends[nextEnd === 0 ? 1 : 0] : inn.ends[inn.end];
  return team.xi.filter(id => id !== team.keeperId).map(id => {
    const p = st.players[id];
    const l = inn.bowlers[id];
    const today = l?.dayOvers?.[st.day - 1] ?? 0;
    return {
      playerId: id, name: p.name, bowlingStyle: p.bowlingStyle, spin: p.spin, frontLine: p.bowler,
      overs: l ? `${Math.floor(l.balls / 6)}.${l.balls % 6}` : "0.0", maidens: l?.maidens ?? 0, runs: l?.runs ?? 0, wickets: l?.wickets ?? 0,
      spellOvers: l?.spellOvers ?? 0, oversToday: today, rested: l && l.lastOver >= 0 ? overs - l.lastOver - 1 : 99,
      blocked: id === blockedId, tiring: (l?.spellOvers ?? 0) >= 8 || today >= (p.spin ? 22 : 16),
    };
  });
}

export interface TestSituation {
  day: number;
  days: number;
  session: 1 | 2 | 3;
  oversToday: string;
  oversLeftToday: number;
  oversLeftInMatch: number;
  innings: number;
  battingTeamId: string;
  bowlingTeamId: string;
  score: string;
  /** Runs ahead (negative = behind), and the 4th-innings target and runs needed */
  lead: number;
  target?: number;
  need?: number;
  /** Overs since the new ball was taken, and whether the next one is due */
  ballAge: number;
  newBallDue: boolean;
  reviewsLeft: { batting: number; fielding: number };
  striker?: { id: string; name: string; runs: number; balls: number };
  nonStriker?: { id: string; name: string; runs: number; balls: number };
  bowler?: { id: string; name: string; figures: string };
  approach: Record<string, TestApproach | "captain">;
  status: TestMatchState["status"];
  pending?: TestPendingDecision;
  result?: string;
}

/** Everything a live view shows about the state of play */
export function testSituation(st: TestMatchState): TestSituation {
  const inn = currentInnings(st)!;
  const bat = (id: string) => ({ id, name: st.players[id].name, runs: inn.batters[id]?.runs ?? 0, balls: inn.batters[id]?.balls ?? 0 });
  const bowlerId = inn?.ends[inn.end] ?? null;
  const bl = bowlerId ? inn.bowlers[bowlerId] : undefined;
  const target = testTarget(st);
  return {
    day: st.day, days: st.days, session: st.session, oversToday: `${Math.floor(st.dayBalls / 6)}.${st.dayBalls % 6}`,
    oversLeftToday: Math.max(0, Math.round((st.dayCap - st.dayBalls / 6) * 10) / 10), oversLeftInMatch: Math.round(oversLeftInMatch(st)),
    innings: inn?.number ?? 0, battingTeamId: inn?.battingTeamId ?? "", bowlingTeamId: inn?.bowlingTeamId ?? "",
    score: inn ? `${inn.runs}/${inn.wickets} (${Math.floor(inn.legalBalls / 6)}.${inn.legalBalls % 6} ov)` : "",
    lead: inn ? testLead(st) : 0, ...(target !== undefined ? { target, need: Math.max(0, target - inn.runs) } : {}),
    ballAge: inn ? Math.floor(inn.legalBalls / 6) - inn.ballTakenAt : 0, newBallDue: !!inn?.newBallDue,
    reviewsLeft: inn ? { ...inn.drs } : { batting: 0, fielding: 0 },
    ...(inn ? { striker: bat(inn.strikerId), nonStriker: bat(inn.nonStrikerId) } : {}),
    ...(bowlerId && bl ? { bowler: { id: bowlerId, name: st.players[bowlerId].name, figures: `${Math.floor(bl.balls / 6)}.${bl.balls % 6}-${bl.maidens}-${bl.runs}-${bl.wickets}` } } : {}),
    approach: Object.fromEntries(Object.values(st.teams).map(t => [t.id, t.approach ?? "captain"])),
    status: st.status, ...(st.pending ? { pending: st.pending } : {}), ...(st.result ? { result: st.result.text } : {}),
  };
}

/** The finished live match as a result (summaries, scorecards, events); throws while it is still on */
export function finishLiveTest(st: TestMatchState): TestMatchResult {
  return testMatchResult(st);
}

/** A JSON-safe copy of the state (it is plain data: the random stream is a number in it) */
export function serializeTestState(st: TestMatchState): string {
  return JSON.stringify(st);
}

export function deserializeTestState(json: string): TestMatchState {
  const st = JSON.parse(json) as TestMatchState;
  if (st.kind !== "test") throw new Error("Not a Test match state");
  return st;
}
