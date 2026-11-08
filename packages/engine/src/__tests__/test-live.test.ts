/**
 * The live Test driver (test-live.ts): the user's decisions (toss, follow-on, new ball, DRS on both sides, declaring, the
 * batting approach, bowling changes), skipping by over / session / day, the CPU captain taking over, and saving a live match.
 * Seeded and searched deterministically for the situations, so these are reproducible.
 */
import { describe, expect, it, vi } from "vitest";
import {
  advanceTest, changeTestBowlerTo, decideTest, declareTest, deserializeTestState, finishLiveTest, serializeTestState,
  setTestAutoCaptain, setTestBattingApproach, setTestNextBatter, startLiveTest, takeTestNewBall, testBowlingOptions, testSituation,
} from "../test-live.js";
import {
  autoResolveTestDecision, currentInnings, simulateTestMatch, stepTestBall, testBatterQueue, type TestMatchState, type TestDecisionType,
} from "../test-match.js";
import { testTeam } from "./test-squads.js";

// seed searches play whole Tests: room for a busy machine (deterministic; only the time varies)
vi.setConfig({ testTimeout: 60_000 });

const AUS = testTeam("Australia"), IRE = testTeam("Ireland"), ENG = testTeam("England"), IND = testTeam("India");

/** Play on, answering every decision but `type` with the CPU's answer, until `type` is pending (or the match ends) */
function playUntil(st: TestMatchState, type: TestDecisionType, maxBalls = 4000): boolean {
  for (let g = 0; g < maxBalls; g++) {
    if (st.status === "completed") return false;
    if (st.status === "waiting_for_decision") {
      if (st.pending?.type === type) return true;
      autoResolveTestDecision(st);
      continue;
    }
    stepTestBall(st);
  }
  return false;
}

/** The first seed whose live match reaches a pending `type` for the user */
function findSeed(make: (seed: number) => TestMatchState, type: TestDecisionType, from = 1, to = 80): TestMatchState {
  for (let seed = from; seed < to; seed++) {
    const st = make(seed);
    if (playUntil(st, type)) return st;
  }
  throw new Error(`no seed reached ${type}`);
}

describe("live Test: the user's decisions", () => {
  it("the toss: the user who wins it chooses, and that side bats", () => {
    const st = findSeed(seed => startLiveTest(ENG, IND, { seed, userTeamId: ENG.id, country: "ENG" }), "toss");
    expect(st.pending!.options).toEqual(["bat", "bowl"]);
    decideTest(st, "bowl");
    expect(st.toss).toEqual({ winnerId: ENG.id, decision: "bowl" });
    expect(currentInnings(st)!.battingTeamId).toBe(IND.id);
  });

  it("the follow-on: the user enforces it or bats again", () => {
    const make = (seed: number) => startLiveTest(AUS, IRE, { seed, userTeamId: AUS.id, country: "AUS" });
    const st = findSeed(make, "follow_on");
    const lead = st.innings[0].runs - st.innings[1].runs;
    expect(lead).toBeGreaterThanOrEqual(200);
    expect(st.pending!.context!.lead).toBe(lead);
    const other = deserializeTestState(serializeTestState(st));
    decideTest(st, "enforce");
    expect(st.innings[2].battingTeamId).toBe(IRE.id);
    expect(st.innings[2].followOn).toBe(true);
    decideTest(other, "bat");
    expect(other.innings[2].battingTeamId).toBe(AUS.id);
    expect(other.innings[2].followOn).toBeUndefined();
  });

  it("the new ball: offered at 80 overs; waiting keeps the old one, taking it later resets the ball's age", () => {
    const st = findSeed(seed => startLiveTest(IRE, AUS, { seed, userTeamId: IRE.id, country: "AUS" }), "new_ball");
    const inn = currentInnings(st)!;
    expect(inn.bowlingTeamId).toBe(IRE.id);
    expect(Math.floor(inn.legalBalls / 6) - inn.ballTakenAt).toBe(80);
    decideTest(st, "wait");
    advanceTest(st, "over");
    expect(currentInnings(st)!.newBalls).toBe(1);
    expect(testSituation(st).newBallDue).toBe(true);
    if (currentInnings(st) === inn && inn.overBalls === 0) {
      expect(takeTestNewBall(st)).toBe(true);
      expect(inn.newBalls).toBe(2);
      expect(testSituation(st).ballAge).toBe(0);
    }
  });

  it("DRS, batting: accepting a given-out decision is a wicket, a review of a right one costs a review unless umpire's call", () => {
    const st = findSeed(seed => startLiveTest(IND, ENG, { seed, userTeamId: IND.id, country: "IND" }), "drs_batting");
    const inn = currentInnings(st)!;
    const copy = deserializeTestState(serializeTestState(st));
    const w0 = inn.wickets;
    const ev = decideTest(st, "accept")!;
    expect(ev.isWicket).toBe(true);
    expect(currentInnings(st)!.wickets === w0 + 1 || st.innings.length > copy.innings.length).toBe(true);
    const before = currentInnings(copy)!.drs.batting;
    const rev = decideTest(copy, "review")!;
    expect(rev.review?.by).toBe("batting");
    if (rev.review!.result === "overturned") expect(rev.isWicket).toBe(false);
    else expect(rev.isWicket).toBe(true);
    const lost = rev.review!.result === "struck_down" ? 1 : 0;
    expect(copy.innings.find(i => i.number === inn.number)!.drs.batting).toBe(before - lost);
  });

  it("DRS, fielding: declining leaves it not out; reviewing gets the wicket when it was out", () => {
    const st = findSeed(seed => startLiveTest(ENG, IND, { seed, userTeamId: ENG.id, country: "ENG" }), "drs_fielding");
    const copy = deserializeTestState(serializeTestState(st));
    const ev = decideTest(st, "decline")!;
    expect(ev.isWicket).toBe(false);
    expect(ev.review).toBeUndefined();
    const rev = decideTest(copy, "review")!;
    expect(rev.review?.by).toBe("fielding");
    expect(rev.isWicket).toBe(rev.review!.result === "overturned");
  });

  it("declaring ends the user's innings and the other side bats", () => {
    const st = findSeed(seed => startLiveTest(ENG, IND, { seed, userTeamId: ENG.id, country: "ENG" }), "toss");
    decideTest(st, "bat");
    expect(() => declareTest(st)).not.toThrow();
    const fresh = findSeed(seed => startLiveTest(ENG, IND, { seed, userTeamId: ENG.id, country: "ENG" }), "toss");
    decideTest(fresh, "bat");
    for (let g = 0; g < 20 && fresh.status !== "completed" && Math.floor(currentInnings(fresh)!.legalBalls / 6) < 30; g++) advanceTest(fresh, "over", { autoDecide: true });
    const inn = currentInnings(fresh)!;
    expect(inn.number).toBe(1);
    declareTest(fresh);
    expect(inn.closed).toBe("declared");
    expect(fresh.innings.length).toBe(2);
    expect(currentInnings(fresh)!.battingTeamId).toBe(IND.id);
    expect(fresh.events.some(e => e.kind === "declaration")).toBe(true);
    // only the batting side can declare
    expect(() => declareTest(fresh)).toThrow();
  });

  it("a bowling change: the chosen bowler bowls the next over", () => {
    const st = startLiveTest(AUS, ENG, { seed: 8, userTeamId: AUS.id, country: "AUS" });
    for (let g = 0; g < 3000 && !(currentInnings(st)?.bowlingTeamId === AUS.id && currentInnings(st)!.legalBalls >= 30); g++) {
      if (st.status === "waiting_for_decision") { autoResolveTestDecision(st); continue; }
      stepTestBall(st);
    }
    advanceTest(st, "over", { autoDecide: true });
    const opts = testBowlingOptions(st);
    const pick = opts.find(o => !o.blocked && o.frontLine && o.playerId !== currentInnings(st)!.ends[currentInnings(st)!.end])!;
    changeTestBowlerTo(st, pick.playerId);
    const r = advanceTest(st, "over", { autoDecide: true });
    expect(r.balls[0].bowler).toBe(pick.playerId);
    expect(() => changeTestBowlerTo(st, r.balls[0].bowler)).toThrow();
  });

  it("the next batter: asked at every wicket when the user wants, and he can send anyone still to come", () => {
    const st = findSeed(seed => startLiveTest(IND, ENG, { seed, userTeamId: IND.id, country: "IND", pickBatters: true }), "next_batter");
    const inn = currentInnings(st)!;
    expect(inn.battingTeamId).toBe(IND.id);
    const opts = st.pending!.options;
    expect(opts).toEqual(testBatterQueue(inn));
    const pick = opts[opts.length - 1];
    decideTest(st, pick);
    expect(inn.batters[pick]).toBeDefined();
    expect([inn.strikerId, inn.nonStrikerId]).toContain(pick);
    expect(inn.strikerId).not.toBe("");
    expect(inn.nonStrikerId).not.toBe("");
  });

  it("a nightwatchman: offered late in the day with the top order out, and the tail-ender goes in", () => {
    const st = findSeed(seed => startLiveTest(ENG, IND, { seed, userTeamId: ENG.id, country: "ENG" }), "next_batter", 1, 200);
    const nw = st.pending!.context!.nightwatchman!;
    expect(nw).toBeDefined();
    expect(st.players[nw].role).toBe("bowler");
    expect(st.dayCap - st.dayBalls / 6).toBeLessThanOrEqual(4);
    expect(currentInnings(st)!.wickets).toBeLessThanOrEqual(5);
    decideTest(st, nw);
    expect(st.events.some(e => e.kind === "nightwatchman")).toBe(true);
  });

  it("a preset next batter comes in at the next wicket", () => {
    const st = startLiveTest(AUS, ENG, { seed: 12, userTeamId: AUS.id, country: "AUS" });
    for (let g = 0; g < 3000 && currentInnings(st)?.battingTeamId !== AUS.id; g++) {
      if (st.status === "waiting_for_decision") { autoResolveTestDecision(st); continue; }
      stepTestBall(st);
    }
    const inn = currentInnings(st)!;
    const pick = testBatterQueue(inn).slice(-1)[0];
    setTestNextBatter(st, pick);
    const w0 = inn.wickets;
    for (let g = 0; g < 2000 && inn.wickets === w0 && !inn.closed; g++) {
      if (st.status === "waiting_for_decision") { if (st.pending!.type === "next_batter") break; autoResolveTestDecision(st); continue; }
      stepTestBall(st);
    }
    if (st.pending?.type === "next_batter") decideTest(st, pick); // a nightwatchman situation asks anyway
    expect(inn.batters[pick]).toBeDefined();
  });

  it("CPU captains send nightwatchmen now and then", () => {
    let n = 0;
    for (let i = 0; i < 40; i++) n += simulateTestMatch(IND, ENG, { seed: 300 + i, country: "IND" }).events.filter(e => e.kind === "nightwatchman").length;
    expect(n).toBeGreaterThan(0);
    expect(n / 40).toBeLessThan(1);
  });

  it("the approach is the user's to set and to hand back", () => {
    const st = startLiveTest(AUS, ENG, { seed: 8, userTeamId: AUS.id, country: "AUS" });
    setTestBattingApproach(st, "attack");
    expect(testSituation(st).approach[AUS.id]).toBe("attack");
    setTestBattingApproach(st, null);
    expect(testSituation(st).approach[AUS.id]).toBe("captain");
  });
});

describe("live Test: skipping ahead and saving", () => {
  it("an over is six legal balls; a session, a day move the clock", () => {
    const st = startLiveTest(IND, ENG, { seed: 15, userTeamId: IND.id, country: "IND" });
    const o = advanceTest(st, "over", { autoDecide: true });
    expect(o.balls.filter(b => b.outcome !== "wide" && b.outcome !== "noball").length).toBeLessThanOrEqual(6);
    expect(currentInnings(st)!.overBalls).toBe(0);
    const s0 = testSituation(st);
    advanceTest(st, "session", { autoDecide: true });
    const s1 = testSituation(st);
    expect(s1.session !== s0.session || s1.day !== s0.day || s1.innings !== s0.innings || st.status === "completed").toBe(true);
    const d0 = st.day;
    advanceTest(st, "day", { autoDecide: true });
    expect(st.day > d0 || st.status === "completed" || st.innings.length > s1.innings).toBe(true);
    expect(o.balls.every(b => typeof b.commentary === "string" && b.commentary.length > 0)).toBe(true);
  });

  it("skipping stops at the user's decisions unless the CPU answers them", () => {
    const st = findSeed(seed => startLiveTest(IND, ENG, { seed, userTeamId: IND.id, country: "IND" }), "drs_batting");
    const r = advanceTest(st, "day");
    expect(r.pending?.type).toBe("drs_batting");
    expect(r.balls.length).toBe(0);
    const r2 = advanceTest(st, "day", { autoDecide: true });
    expect(r2.balls.length).toBeGreaterThan(0);
  });

  it("with the CPU captain on, a live match plays to a result, and a saved one resumes exactly", () => {
    const st = startLiveTest(ENG, AUS, { seed: 31, userTeamId: ENG.id, country: "ENG" });
    if (st.status === "waiting_for_decision") decideTest(st, "bat");
    advanceTest(st, "day", { autoDecide: true });
    const saved = serializeTestState(st);
    setTestAutoCaptain(st, true);
    const a = advanceTest(st, "match", { autoDecide: true });
    const resumed = deserializeTestState(saved);
    setTestAutoCaptain(resumed, true);
    const b = advanceTest(resumed, "match", { autoDecide: true });
    expect(st.status).toBe("completed");
    expect(b.balls.length).toBe(a.balls.length);
    expect(resumed.result!.text).toBe(st.result!.text);
    const res = finishLiveTest(st);
    expect(res.scorecards.length).toBe(st.innings.length);
    expect(res.scorecards[0].batters.length).toBeGreaterThanOrEqual(2);
  });
});

describe("live Test commentary", () => {
  it("never announces a free hit, a powerplay or the death overs (there are none in Tests)", () => {
    const st = startLiveTest(IND, ENG, { seed: 44, userTeamId: IND.id, country: "IND" });
    setTestAutoCaptain(st, true);
    advanceTest(st, "match", { autoDecide: true });
    const lines = st.innings.flatMap(i => i.ballLog.map(e => e.commentary ?? ""));
    expect(lines.length).toBeGreaterThan(500);
    expect(lines.filter(l => /free hit|power ?play|fielding restrictions|death overs/i.test(l))).toEqual([]);
    expect(lines.every(l => l.length > 0)).toBe(true);
  });
});
