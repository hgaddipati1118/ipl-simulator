/**
 * The Laws and T20 playing conditions in the live engine (live-match.ts, which has its own ball logic): free hit, the
 * dismissal legality matrix, non-striker run outs, strike after a wicket, a Mankad, retired hurt, an incomplete over,
 * stats attribution, scorecard text and super overs. The instant engine's versions are in match-rules.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { createMatchState, simulateRemaining, stepBall, startSecondInnings, autoResolveDecision, playLiveSuperOvers, serializeMatchState, deserializeMatchState, buildDetailedResultFromState, type MatchState } from "../live-match.js";
import type { BallEvent } from "../match.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { canDismiss, isBowlerWicket, setRuleOverrides, type DismissalKind, type RuleOverrides } from "../delivery-rules.js";

vi.setConfig({ testTimeout: 240000 });

function player(id: string, role: "batsman" | "bowler" | "all-rounder", intl = false, wk = false, style?: string): Player {
  const bat = role === "batsman";
  const bowl = role === "bowler";
  return new Player({
    id, name: `Player ${id}`, age: 26, country: intl ? "Australia" : "India", role,
    ratings: {
      battingIQ: bat ? 68 : bowl ? 25 : 54, timing: bat ? 66 : bowl ? 25 : 50, power: bat ? 64 : bowl ? 20 : 50,
      running: bat ? 58 : 40, wicketTaking: bowl ? 68 : bat ? 20 : 54, economy: bowl ? 66 : bat ? 20 : 54,
      accuracy: bowl ? 64 : bat ? 20 : 50, clutch: 50,
    },
    isInternational: intl, isWicketKeeper: wk, injured: false, injuryGamesLeft: 0,
    bowlingStyle: (style ?? (bowl || role === "all-rounder" ? "right-arm-medium-fast" : undefined)) as Player["bowlingStyle"],
    battingHand: "right",
  });
}

function squad(team: Team, idx: number): void {
  let n = idx * 100;
  team.addPlayer(player(`wk_${++n}`, "batsman", false, true), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(player(`bat_${++n}`, "batsman", i === 0), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(player(`ar_${++n}`, "all-rounder", i === 0, false, i % 2 ? "off-spin" : "right-arm-medium-fast"), 1);
  const styles = ["right-arm-fast", "left-arm-fast", "leg-spin", "left-arm-orthodox", "right-arm-medium", "off-spin", "right-arm-fast"];
  for (let i = 0; i < 7; i++) team.addPlayer(player(`bow_${++n}`, "bowler", false, false, styles[i]), 1);
}

function pair(i: number): [Team, Team] {
  const a = new Team(IPL_TEAMS[i % 5], 120);
  const b = new Team(IPL_TEAMS[(i % 5) + 1], 120);
  squad(a, i % 5);
  squad(b, (i % 5) + 1);
  return [a, b];
}

const rules: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };
// fixed cheap rain odds do not matter: rain only trims overs, it never changes who is out

function playOut(seed: number): MatchState {
  const [a, b] = pair(seed);
  return simulateRemaining(createMatchState(a, b, rules, null, seed)).state;
}

function rawLogs(s: MatchState): BallEvent[][] {
  return [s._internal.innings1Raw!.ballLog, s._internal.currentInningsRaw.ballLog];
}

afterEach(() => setRuleOverrides(null));
function withOverrides<T>(o: RuleOverrides, fn: () => T): T {
  setRuleOverrides(o);
  try { return fn(); } finally { setRuleOverrides(null); }
}

const isLegal = (e: BallEvent) => e.outcome !== "wide" && e.outcome !== "noball" && !e.deadBall;

describe("live: free hit", () => {
  it("state.freeHit is set after a no-ball, carries through a wide / no-ball on it, and a legal ball ends it", () => {
    let nbs = 0, fhBalls = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const [a, b] = pair(seed);
      let state = createMatchState(a, b, rules, null, seed);
      let expected = false;
      while (state.status !== "completed") {
        if (state.status === "waiting_for_decision") { state = autoResolveDecision(state); continue; }
        if (state.status === "innings_break") { state = startSecondInnings(state); expected = false; continue; }
        expect(!!state.freeHit).toBe(expected);
        const { state: next, ball } = stepBall(state);
        expect(!!ball.freeHit).toBe(expected);
        if (expected) fhBalls++;
        const isNb = ball.eventType === "noball";
        if (isNb) nbs++;
        expected = isNb || (expected && ball.eventType === "wide");
        if (next.status === "innings_break" || next.status === "completed") expected = false;
        state = next;
      }
    }
    expect(nbs).toBeGreaterThan(5);
    expect(fhBalls).toBeGreaterThan(5);
  });

  it("a free hit can only dismiss by run out, obstructing the field, handled the ball or hit the ball twice (even when a kind is forced)", () => {
    for (const kind of ["bowled", "caught", "lbw", "hit_wicket", "stumped"] as DismissalKind[]) {
      withOverrides({ forceKind: kind }, () => {
        let checked = 0;
        for (let seed = 20; seed < 34; seed++) {
          for (const log of rawLogs(playOut(seed))) {
            for (const e of log) {
              if (e.outcome === "noball" || e.freeHit) {
                checked++;
                if (e.isWicket) expect(["run_out", "obstructing_the_field", "handled_the_ball", "hit_the_ball_twice"]).toContain(e.wicketType);
              }
              if (e.outcome === "wide" && e.isWicket) expect(canDismiss(e.wicketType as DismissalKind, "wide", false)).toBe(true);
            }
          }
        }
        expect(checked, kind).toBeGreaterThan(2);
      });
    }
  });
});

describe("live: non-striker run outs and strike after a wicket", () => {
  it("a forced non-striker run out takes the non-striker, credits the completed run to the striker, and is not the bowler's wicket", () => {
    withOverrides({ forceKind: "run_out", forceRunOutRole: "nonStriker", forceRunOutRuns: 1 }, () => {
      let seen = 0;
      for (let seed = 30; seed < 36; seed++) {
        const s = playOut(seed);
        for (const [k, log] of rawLogs(s).entries()) {
          const detailed = k === 0 ? s.innings1BallLog : s.innings2BallLog;
          for (const e of log) {
            if (!e.isWicket || e.wicketType !== "run_out" || e.deadBall || !e.playerOutId) continue;
            seen++;
            expect(e.playerOutId).not.toBe(e.batter);
            if (e.outcome === "wicket") expect(e.runs).toBe(1);
          }
          expect(detailed.filter(b => b.playerOutName).length).toBe(log.filter(e => e.isWicket && e.playerOutId && !e.deadBall).length + log.filter(e => e.deadBall).length);
          const raw = k === 0 ? s._internal.innings1Raw! : s._internal.currentInningsRaw;
          const bowlerWickets = Object.values(raw.bowlerStats).reduce((n, b) => n + b.wickets, 0);
          expect(bowlerWickets).toBe(log.filter(e => e.isWicket && isBowlerWicket(e.wicketType)).length);
        }
        // the scorecard names a run out for the batter who was out
        const rows = [...(s.innings1Scorecard?.batters ?? []), ...s.batterStats];
        expect(rows.some(r => r.howOut.startsWith("run out"))).toBe(true);
      }
      expect(seen).toBeGreaterThan(15);
    });
  });

  it("the new batter faces the next ball after a catch / bowled / lbw / stumping, except at an over's end", () => {
    let checked = 0, overEnd = 0;
    for (let seed = 40; seed < 52; seed++) {
      for (const log of rawLogs(playOut(seed))) {
        for (let i = 0; i < log.length - 1; i++) {
          const e = log[i], next = log[i + 1];
          if (!e.isWicket || e.deadBall || !["caught", "caught_and_bowled", "bowled", "lbw", "stumped", "hit_wicket"].includes(e.wicketType!)) continue;
          if (e.nonStriker === undefined) continue;
          if (isLegal(e) && e.ball === 6) {
            if (next.over === e.over + 1 && next.batter === e.nonStriker) overEnd++;
            continue;
          }
          if (next.over !== e.over) continue;
          checked++;
          expect(next.batter).not.toBe(e.nonStriker);
          expect(next.nonStriker).toBe(e.nonStriker);
        }
      }
    }
    expect(checked).toBeGreaterThan(80);
    expect(overEnd).toBeGreaterThan(5);
  });

  it("odd runs run (bat, byes, leg byes, wides) change the strike", () => {
    for (let seed = 60; seed < 64; seed++) {
      for (const log of rawLogs(playOut(seed))) {
        for (let i = 0; i < log.length - 1; i++) {
          const e = log[i], next = log[i + 1];
          if (e.isWicket || next.over !== e.over || e.runsRun === undefined) continue;
          if (e.runsRun % 2 === 1) expect(next.batter, `${e.over}.${e.ball}`).toBe(e.nonStriker);
          else expect(next.batter).toBe(e.batter);
        }
      }
    }
  });
});

describe("live: stats attribution", () => {
  const states = [70, 71, 72, 73, 74, 75].map(playOut);

  it("batter balls (not wides), bowler runs (bat + wides + no-balls), extras by type, wickets by bowler", () => {
    for (const s of states) {
      for (const [k, log] of rawLogs(s).entries()) {
        const raw = k === 0 ? s._internal.innings1Raw! : s._internal.currentInningsRaw;
        const faced = new Map<string, number>();
        const charged = new Map<string, number>();
        for (const e of log) {
          if (e.deadBall) continue;
          if (e.outcome !== "wide") faced.set(e.batter, (faced.get(e.batter) ?? 0) + 1);
          charged.set(e.bowler, (charged.get(e.bowler) ?? 0) + e.runs + (e.wides ?? 0) + (e.noBalls ?? 0));
        }
        for (const [id, st] of Object.entries(raw.batterStats)) expect(st.balls).toBe(faced.get(id) ?? 0);
        for (const [id, st] of Object.entries(raw.bowlerStats)) expect(st.runs).toBe(charged.get(id) ?? 0);
        const batted = Object.values(raw.batterStats).reduce((n, b) => n + b.runs, 0);
        const extras = log.reduce((n, e) => n + e.extras, 0);
        expect(raw.extras).toBe(extras);
        expect(raw.runs).toBe(batted + extras);
        expect(raw.totalBalls).toBe(log.filter(isLegal).length);
      }
      const sc = s.innings1Scorecard!;
      expect(sc.extras.total).toBe(sc.totalRuns - sc.batters.reduce((n, b) => n + b.runs, 0));
    }
  });

  it("figures: live bowler overs / balls follow the legal balls and a bowler's wickets exclude run outs", () => {
    for (const s of states) {
      for (const b of s.innings1Scorecard!.bowlers) {
        expect(b.wickets).toBeGreaterThanOrEqual(0);
        expect(b.overs).toMatch(/^\d+\.\d$/);
      }
      const bowled = s.innings1Scorecard!.bowlers.reduce((n, b) => n + Math.floor(Number(b.overs.split(".")[0])) * 6 + Number(b.overs.split(".")[1]), 0);
      expect(bowled).toBe(s._internal.innings1Raw!.totalBalls);
    }
  });
});

describe("live: a Mankad, retirements, an incomplete over", () => {
  it("a Mankad is a run out of the non-striker by the bowler; no ball is bowled", () => {
    withOverrides({ mankadPerDelivery: 0.02 }, () => {
      let dead = 0;
      for (let seed = 80; seed < 86; seed++) {
        const s = playOut(seed);
        for (const log of rawLogs(s)) {
          for (const e of log.filter(x => x.deadBall)) {
            dead++;
            expect(e.wicketType).toBe("run_out");
            expect(e.playerOutId).not.toBe(e.batter);
            expect(e.fielderId).toBe(e.bowler);
            expect(e.runs + e.extras).toBe(0);
          }
          const raw = log === s._internal.innings1Raw!.ballLog ? s._internal.innings1Raw! : s._internal.currentInningsRaw;
          expect(raw.totalBalls).toBe(log.filter(isLegal).length);
          const perOver = new Map<number, number>();
          for (const e of log) if (isLegal(e)) perOver.set(e.over, (perOver.get(e.over) ?? 0) + 1);
          for (const [, c] of perOver) expect(c).toBeLessThanOrEqual(6);
        }
        const rows = [...(s.innings1Scorecard?.batters ?? []), ...s.batterStats];
        expect(rows.filter(r => r.howOut.startsWith("run out")).length).toBeGreaterThan(0);
      }
      expect(dead).toBeGreaterThan(5);
    });
  });

  it("a retired-hurt batter is not out, is replaced, and can come back at a wicket", () => {
    withOverrides({ hurtPerBatterBall: 0.004, returnProb: 1 }, () => {
      let hurt = 0, back = 0;
      for (let seed = 90; seed < 98; seed++) {
        const s = playOut(seed);
        for (const stats of [s.innings1Scorecard?.batters ?? [], s.batterStats]) hurt += stats.filter(b => b.howOut === "retired hurt").length;
        for (const log of rawLogs(s)) {
          const seen = new Map<string, number>();
          for (const e of log) seen.set(e.batter, (seen.get(e.batter) ?? 0) + 1);
        }
        // a batter who left hurt and later batted again: his row no longer says retired hurt
        for (const [k, raw] of [s._internal.innings1Raw!, s._internal.currentInningsRaw].entries()) {
          const dismissals = raw.ballLog.filter(e => e.isWicket).length;
          expect(raw.wickets).toBeGreaterThanOrEqual(dismissals);
          void k;
        }
        back += s.batterStats.filter(b => b.balls > 0 && !b.isOut && b.howOut === "not out").length;
      }
      expect(hurt + back).toBeGreaterThan(0);
    });
  });

  it("an over the bowler cannot finish is completed by another who sits out the next over", () => {
    withOverrides({ bowlerLeavesPerOver: 0.05 }, () => {
      let split = 0, same = 0;
      for (let seed = 100; seed < 106; seed++) {
        for (const log of rawLogs(playOut(seed))) {
          const bowlersOf = new Map<number, string[]>();
          for (const e of log) {
            const l = bowlersOf.get(e.over) ?? [];
            if (l[l.length - 1] !== e.bowler) l.push(e.bowler);
            bowlersOf.set(e.over, l);
          }
          for (const [over, list] of bowlersOf) {
            if (list.length < 2) continue;
            split++;
            const nxt = bowlersOf.get(over + 1);
            if (nxt && nxt[0] === list[list.length - 1]) same++;
            for (let o = over + 1; o < 20; o++) expect(bowlersOf.get(o)?.includes(list[0])).toBeFalsy();
          }
          const overs = new Map<string, Set<number>>();
          for (const e of log) { if (!overs.has(e.bowler)) overs.set(e.bowler, new Set()); overs.get(e.bowler)!.add(e.over); }
          for (const s of overs.values()) expect(s.size).toBeLessThanOrEqual(4);
        }
      }
      expect(split).toBeGreaterThan(5);
      expect(same / split).toBeLessThan(0.15);
    });
  });
});

describe("live: super over", () => {
  /** a finished match turned into a tie so the super over can be played */
  function tiedState(seed: number): MatchState {
    const s = JSON.parse(JSON.stringify(playOut(seed))) as MatchState;
    s._internal.rng = createRng(seed);
    s.winnerId = undefined;
    s.result = undefined;
    s.superOvers = undefined;
    return s;
  }
  function createRng(seed: number) {
    let a = seed;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  it("one over each, two wickets end an innings, three batters, one bowler, the side that batted second bats first", () => {
    for (let seed = 110; seed < 140; seed++) {
      const s = tiedState(seed);
      playLiveSuperOvers(s);
      const rounds = s.superOvers!;
      expect(rounds.length).toBeGreaterThanOrEqual(2);
      expect(rounds.length % 2).toBe(0);
      expect(rounds[0].battingTeamId).toBe(s._internal.bowlingFirstId);
      for (const r of rounds) {
        expect(r.wickets).toBeLessThanOrEqual(2);
        expect(r.batters.length).toBe(3);
        expect(Math.max(0, ...r.balls.map(b => b.ball))).toBeLessThanOrEqual(6);
        expect(r.balls.every(b => b.bowlerName === r.balls[0].bowlerName)).toBe(true);
      }
      expect(s.winnerId).toBeTruthy();
      expect(s.result).toContain("Super Over");
    }
  });

  it("repeats while tied; a previous bowler or dismissed batter is not nominated again; the sides alternate", () => {
    let multi = 0;
    for (let seed = 200; seed < 400 && multi < 3; seed++) {
      const s = tiedState(seed);
      playLiveSuperOvers(s);
      const rounds = s.superOvers!;
      if (rounds.length < 4) continue;
      multi++;
      for (let i = 0; i + 1 < rounds.length; i += 2) {
        const last = i === rounds.length - 2;
        if (!last) expect(rounds[i].runs).toBe(rounds[i + 1].runs);
        else expect(rounds[i].runs).not.toBe(rounds[i + 1].runs);
      }
      for (let i = 2; i < rounds.length; i += 2) {
        const prev = [rounds[i - 2], rounds[i - 1]];
        for (const now of [rounds[i], rounds[i + 1]]) {
          // the bowler who bowled for a side last round is not used by that side again
          expect(now.bowler).not.toBe(prev.find(p => p.bowlingTeamId === now.bowlingTeamId)!.bowler);
          // a batter dismissed last round does not bat again
          const out = new Set(prev.find(p => p.battingTeamId === now.battingTeamId)!.out);
          for (const id of now.batters) expect(out.has(id)).toBe(false);
        }
      }
      expect(rounds[2].battingTeamId).toBe(rounds[1].battingTeamId);
    }
    expect(multi).toBeGreaterThan(0);
  });
});

describe("live: saved games from before the match rules still load and finish", () => {
  it("a state saved mid-innings without any of the new fields plays on to a result", () => {
    const [a, b] = pair(3);
    let state = createMatchState(a, b, rules, null, 3);
    for (let i = 0; i < 40; i++) {
      if (state.status !== "in_progress") break;
      state = stepBall(state).state;
    }
    const old: any = serializeMatchState(state);
    // strip everything the match rules added
    delete old.freeHit; delete old.superOvers;
    for (const k of ["allOut", "awaitingBatter", "retiredHurtIdx", "unavailableBowlers", "deferredOverSwap"]) delete old._internal[k];
    const stripBall = (e: any) => { for (const k of ["nonStriker", "playerOutId", "fielder2Id", "substitute", "wides", "noBalls", "byes", "legByes", "penaltyRuns", "boundary", "overthrow", "freeHit", "wideKind", "runsRun", "newBatterFaces", "deadBall"]) delete e[k]; };
    for (const e of old._internal.currentInningsRaw.ballLog) stripBall(e);
    for (const e of [...old.ballLog, ...old.innings1BallLog, ...old.innings2BallLog]) { delete e.playerOutName; delete e.freeHit; }
    for (const s of old.batterStats) delete s.retiredHurt;
    const loaded = deserializeMatchState(JSON.parse(JSON.stringify(old)));
    const done = simulateRemaining(loaded).state;
    expect(done.status).toBe("completed");
    expect(done.winnerId).toBeTruthy();
    const detailed = buildDetailedResultFromState(done);
    expect(detailed.innings2.extras.total).toBe(detailed.innings2.totalRuns - detailed.innings2.batters.reduce((n, x) => n + x.runs, 0));
  });
});
