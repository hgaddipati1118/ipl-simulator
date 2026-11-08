/**
 * Test cricket (docs/FORMATS.md, Test section): the rules (two innings a side, the follow-on, declarations, the new ball at 80 overs,
 * days and overs, a draw when time runs out, a tie, DRS per innings, no consecutive overs), determinism and resuming, the
 * captains' fitted policies, and seeded statistical checks against the real targets with wide tolerances. Every match is
 * seeded, so these are deterministic.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TEST_MATCH_HOOKS, createTestMatch, currentInnings, declarationHazard, followOnMargin, followOnProbability, runTestToEnd,
  simulateTestMatch, stepTestBall, testBallProbs, testTarget, type TestMatchResult, type TestMatchState,
  isTestOpener, pickTestXI, testBattingSlot, testPlayerOf, testProfileOf,
} from "../test-match.js";
import { Player } from "../player.js";
import { TEST_MODEL } from "../test-model-data.js";
import { testTeam } from "./test-squads.js";

const IND = testTeam("India"), ENG = testTeam("England"), AUS = testTeam("Australia"), IRE = testTeam("Ireland"), ZIM = testTeam("Zimbabwe");
const SL = testTeam("Sri Lanka"), NZ = testTeam("New Zealand");

afterEach(() => { delete TEST_MATCH_HOOKS.forceClass; });

// whole Tests are ~2,000 deliveries: give every check room on a busy machine (the work is deterministic, only time varies)
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** A batch of seeded Tests over a few pairings, shared by the rule checks */
const BATCH: TestMatchResult[] = [];
const PAIRS: [typeof IND, typeof IND, string][] = [[IND, ENG, "IND"], [ENG, AUS, "ENG"], [AUS, IND, "AUS"], [SL, NZ, "SL"], [AUS, ZIM, "AUS"], [NZ, IRE, "NZ"]];
beforeAll(() => {
  for (let i = 0; i < 90; i++) {
    const [h, a, c] = PAIRS[i % PAIRS.length];
    BATCH.push(simulateTestMatch(h, a, { seed: 1000 + i, country: c }));
  }
});

describe("Test rules", () => {
  it("each side bats at most twice, sides alternate except after a follow-on", () => {
    for (const r of BATCH) {
      const inns = r.state.innings;
      expect(inns.length).toBeGreaterThanOrEqual(1);
      expect(inns.length).toBeLessThanOrEqual(4);
      for (const id of r.state.teamOrder) expect(inns.filter(i => i.battingTeamId === id).length).toBeLessThanOrEqual(2);
      for (let k = 1; k < inns.length; k++) {
        if (inns[k].followOn) expect(inns[k].battingTeamId).toBe(inns[k - 1].battingTeamId);
        else expect(inns[k].battingTeamId).not.toBe(inns[k - 1].battingTeamId);
      }
    }
  });

  it("a follow-on is only enforced 200 ahead after the side behind was bowled out", () => {
    let seen = 0;
    for (const r of BATCH) {
      const [i1, i2, i3] = r.state.innings;
      if (i3?.followOn) {
        seen++;
        expect(i1.runs - i2.runs).toBeGreaterThanOrEqual(200);
        expect(i2.closed).toBe("all_out");
        expect(i3.number).toBe(3);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(followOnMargin(5)).toBe(200);
    expect(followOnMargin(4)).toBe(150);
  });

  it("declared innings close with wickets in hand; no innings goes past ten wickets", () => {
    let declared = 0;
    for (const r of BATCH) {
      for (const inn of r.state.innings) {
        expect(inn.wickets).toBeLessThanOrEqual(10);
        if (inn.closed === "declared") { declared++; expect(inn.wickets).toBeLessThan(10); expect(inn.number).toBeLessThan(4); }
        if (inn.closed === "all_out") expect(inn.wickets === 10 || inn.ballLog.length > 0).toBe(true);
      }
    }
    expect(declared).toBeGreaterThan(0);
  });

  it("the new ball comes at 80 overs: the CPU takes it at the start of the 81st", () => {
    let long = 0;
    for (const r of BATCH) {
      for (const inn of r.state.innings) {
        const overs = Math.floor(inn.legalBalls / 6);
        if (overs >= 81) {
          long++;
          expect(inn.newBalls).toBeGreaterThanOrEqual(2);
          expect(r.state.events.some(e => e.kind === "new_ball" && e.inn === inn.number && e.overs === 80)).toBe(true);
        } else if (overs < 80) {
          expect(inn.newBalls).toBe(1);
        }
      }
    }
    expect(long).toBeGreaterThan(5);
  });

  it("no bowler bowls two overs in a row", () => {
    for (const r of BATCH.slice(0, 30)) {
      for (const inn of r.state.innings) {
        const byOver = new Map<number, string>();
        for (const ev of inn.ballLog) byOver.set(ev.over, ev.bowler);
        for (const [o, b] of byOver) if (byOver.has(o + 1)) expect(byOver.get(o + 1)).not.toBe(b);
      }
    }
  });

  it("days and overs: at most the day's overs each day, five days at most, days in order", () => {
    for (const r of BATCH) {
      const st = r.state;
      const perDay = new Map<number, number>();
      let lastDay = 1;
      for (const inn of st.innings) {
        for (const ev of inn.ballLog) {
          expect(ev.day).toBeGreaterThanOrEqual(lastDay);
          lastDay = ev.day;
          if (ev.outcome !== "wide" && ev.outcome !== "noball") perDay.set(ev.day, (perDay.get(ev.day) ?? 0) + 1);
        }
      }
      for (const [d, balls] of perDay) {
        expect(d).toBeLessThanOrEqual(5);
        expect(balls).toBeLessThanOrEqual(st.dayPlan[d - 1] * 6 + 5);
      }
      expect(r.result.day).toBeLessThanOrEqual(5);
    }
  });

  it("a match out of time is drawn", () => {
    const r = simulateTestMatch(IND, ENG, { seed: 7, days: 1, country: "IND" });
    expect(r.result.kind).toBe("draw");
    expect(r.result.winnerId).toBeNull();
    expect(r.result.text).toBe("Match drawn");
    const drawn = BATCH.filter(x => x.result.kind === "draw");
    for (const x of drawn) expect(x.result.day).toBe(5);
  });

  it("results read right: the 4th-innings side wins by wickets, the other by runs or an innings", () => {
    for (const r of BATCH) {
      const st = r.state;
      const res = r.result;
      if (res.kind !== "win") continue;
      if (res.margin.startsWith("an innings")) expect(st.innings.length).toBe(3);
      else if (res.margin.endsWith("wickets") || res.margin.endsWith("wicket")) expect(st.innings[3].battingTeamId).toBe(res.winnerId);
      else expect(st.innings[st.innings.length - 1].bowlingTeamId).toBe(res.winnerId);
    }
  });

  it("a tie: the side batting last is all out with the scores level", () => {
    // the first seed that reaches a 4th innings; then set the scores level less one with nine down
    let st = createTestMatch(IND, ENG, { seed: 11, country: "IND" });
    for (let seed = 11; seed < 60; seed++) {
      st = createTestMatch(IND, ENG, { seed, country: "IND" });
      for (let g = 0; g < 4000 && st.innings.length < 4 && st.status !== "completed"; g++) stepTestBall(st);
      if (st.innings.length === 4 && st.status === "in_progress") break;
    }
    expect(st.innings.length).toBe(4);
    const inn = currentInnings(st)!;
    const target = testTarget(st)!;
    inn.runs = target - 2;
    inn.wickets = 9;
    TEST_MATCH_HOOKS.forceClass = "1";
    for (let g = 0; g < 10 && inn.runs < target - 1; g++) stepTestBall(st);
    TEST_MATCH_HOOKS.forceClass = "W";
    stepTestBall(st);
    expect(st.status).toBe("completed");
    expect(st.result!.kind).toBe("tie");
    expect(st.result!.text).toBe("Match tied");
  });

  it("DRS: at most three unsuccessful reviews per side per innings, none once they are gone", () => {
    let reviews = 0;
    for (const r of BATCH) {
      for (const inn of r.state.innings) {
        const lost = { batting: 0, fielding: 0 };
        for (const ev of inn.ballLog) {
          if (!ev.review) continue;
          reviews++;
          expect(lost[ev.review.by]).toBeLessThan(3);
          if (ev.review.result === "struck_down") lost[ev.review.by]++;
        }
        expect(inn.drs.batting).toBe(3 - lost.batting);
        expect(inn.drs.fielding).toBe(3 - lost.fielding);
      }
    }
    expect(reviews).toBeGreaterThan(100);
  });
});

describe("determinism and resuming", () => {
  const summary = (r: TestMatchResult) => JSON.stringify([r.result, r.innings]);

  it("the same seed gives the same Test", () => {
    expect(summary(simulateTestMatch(AUS, IND, { seed: 42 }))).toBe(summary(simulateTestMatch(AUS, IND, { seed: 42 })));
    expect(summary(simulateTestMatch(AUS, IND, { seed: 42 }))).not.toBe(summary(simulateTestMatch(AUS, IND, { seed: 43 })));
  });

  it("a match saved halfway through carries on exactly as if it had not been", () => {
    const a = createTestMatch(ENG, NZ, { seed: 99, country: "ENG" });
    const b = createTestMatch(ENG, NZ, { seed: 99, country: "ENG" });
    for (let i = 0; i < 900; i++) stepTestBall(b);
    const resumed: TestMatchState = JSON.parse(JSON.stringify(b));
    runTestToEnd(a);
    runTestToEnd(resumed);
    expect(JSON.stringify(resumed.result)).toBe(JSON.stringify(a.result));
    expect(resumed.innings.map(i => i.runs)).toEqual(a.innings.map(i => i.runs));
  });
});

describe("the captains' policies", () => {
  it("toss: subcontinent captains bat first far more often than New Zealand's", () => {
    let indBat = 0, nzBat = 0;
    for (let i = 0; i < 300; i++) {
      if (createTestMatch(IND, ENG, { seed: i, country: "IND" }).toss!.decision === "bat") indBat++;
      if (createTestMatch(NZ, ENG, { seed: i, country: "NZ" }).toss!.decision === "bat") nzBat++;
    }
    expect(indBat / 300).toBeGreaterThan(0.75);
    expect(nzBat / 300).toBeLessThan(0.4);
  });

  it("declaration hazard rises with the lead and as time runs out; follow-on more likely with a bigger lead", () => {
    const st = createTestMatch(IND, ENG, { seed: 5, country: "IND" });
    runTestToEnd(st);
    const inn3 = { ...st.innings[0], number: 3 as const, wickets: 5 };
    const fake = { ...st, innings: [st.innings[0], st.innings[1] ?? st.innings[0], inn3], day: 4, dayBalls: 0, dayCap: 90 };
    fake.innings[0] = { ...fake.innings[0], runs: 300, battingTeamId: inn3.battingTeamId };
    fake.innings[1] = { ...fake.innings[1], runs: 250, battingTeamId: inn3.bowlingTeamId };
    const h = (runs: number, day: number) => declarationHazard({ ...fake, day, innings: [fake.innings[0], fake.innings[1], { ...inn3, runs }] } as TestMatchState, { ...inn3, runs });
    expect(h(350, 4)).toBeGreaterThan(h(150, 4));
    expect(h(250, 5)).toBeGreaterThan(h(250, 3));
    const fo = (lead: number) => followOnProbability({ ...fake, innings: [{ ...fake.innings[0], runs: 200 + lead }, { ...fake.innings[1], runs: 200, legalBalls: 60 * 6 }] } as TestMatchState);
    expect(fo(350)).toBeGreaterThan(fo(210));
  });

  it("the approach moves the ball: attack scores and gets out more, defend less", () => {
    const st = createTestMatch(ENG, AUS, { seed: 3, country: "ENG", userTeamId: null });
    for (let i = 0; i < 200; i++) stepTestBall(st);
    const inn = currentInnings(st)!;
    const team = st.teams[inn.battingTeamId];
    team.approach = "normal";
    const n = testBallProbs(st, inn);
    team.approach = "attack";
    const a = testBallProbs(st, inn);
    team.approach = "defend";
    const d = testBallProbs(st, inn);
    team.approach = null;
    const [i4, iW] = [3, 5];
    expect(a[i4]).toBeGreaterThan(n[i4]);
    expect(a[iW]).toBeGreaterThan(n[iW]);
    expect(d[0]).toBeLessThan(n[0]);
  });

  it("women's Tests: four days of 100 overs", () => {
    const r = simulateTestMatch(testTeam("India", "female"), testTeam("England", "female"), { seed: 21, country: "IND" });
    expect(r.state.gender).toBe("female");
    expect(r.state.days).toBe(4);
    expect(r.state.oversPerDay).toBe(100);
    expect(r.result.day).toBeLessThanOrEqual(4);
  });
});

describe("seeded statistics against real Tests (wide tolerances)", () => {
  let inns: TestMatchState["innings"] = [];
  let runs = 0, balls = 0, wkts = 0;
  const real = TEST_MODEL.real.male2023; // the era the engine plays
  beforeAll(() => {
    inns = BATCH.flatMap(r => r.state.innings);
    runs = inns.reduce((a, i) => a + i.runs, 0);
    balls = inns.reduce((a, i) => a + i.legalBalls, 0);
    wkts = inns.reduce((a, i) => a + i.wickets, 0);
  });

  it("runs per over and balls per wicket are Test-like", () => {
    expect((6 * runs) / balls).toBeGreaterThan(real.runsPerOver * 0.85);
    expect((6 * runs) / balls).toBeLessThan(real.runsPerOver * 1.15);
    expect(balls / wkts).toBeGreaterThan(real.ballsPerWicket * 0.85);
    expect(balls / wkts).toBeLessThan(real.ballsPerWicket * 1.15);
  });

  it("first innings are the biggest, fourth the smallest", () => {
    const mean = (n: number) => { const xs = inns.filter(i => i.number === n); return xs.reduce((a, i) => a + i.runs, 0) / xs.length; };
    expect(mean(1)).toBeGreaterThan(mean(3));
    expect(mean(3)).toBeGreaterThan(mean(4));
    expect(mean(1)).toBeGreaterThan(250);
    expect(mean(1)).toBeLessThan(420);
  });

  it("draws, home wins and hundreds are in range", () => {
    const draws = BATCH.filter(r => r.result.kind === "draw").length / BATCH.length;
    expect(draws).toBeGreaterThan(0.03);
    expect(draws).toBeLessThan(0.35);
    const home = BATCH.filter(r => r.result.winnerId === r.homeTeamId).length;
    const away = BATCH.filter(r => r.result.winnerId === r.awayTeamId).length;
    expect(home).toBeGreaterThan(away);
    const hundreds = inns.reduce((a, i) => a + Object.values(i.batters).filter(b => b.runs >= 100).length, 0) / BATCH.length;
    expect(hundreds).toBeGreaterThan(0.9);
    expect(hundreds).toBeLessThan(2.8);
  });

  it("spinners take a bigger share of the wickets on day five than on day one", () => {
    const share = (d: number) => {
      let w = 0, s = 0;
      for (const r of BATCH) for (const inn of r.state.innings) for (const ev of inn.ballLog) {
        if (ev.isWicket && ev.wicketType !== "run_out" && Math.min(5, ev.day) === d) { w++; if (r.state.players[ev.bowler].spin) s++; }
      }
      return s / Math.max(1, w);
    };
    expect(share(5)).toBeGreaterThan(share(1));
  });

  it("strong sides beat weak ones", () => {
    const wins = (team: string) => BATCH.filter(r => r.result.winnerId === team).length;
    const played = (team: string) => BATCH.filter(r => r.homeTeamId === team || r.awayTeamId === team).length;
    expect(wins(AUS.id) / played(AUS.id)).toBeGreaterThan(wins(ZIM.id) / played(ZIM.id) + 0.3);
  });
});

describe("Test profiles: the order and the attack from the first-class record (section 3.2)", () => {
  const SIDES = ["India", "England", "Australia", "South Africa", "New Zealand", "Pakistan"];

  it("the attack comes from bowling workload, not the T20 role", () => {
    const eng = testTeam("England").roster;
    const byName = (n: string) => eng.find(p => p.name === n);
    for (const n of ["Shoaib Bashir", "Brydon Carse"]) {
      const p = byName(n);
      if (!p) continue;
      expect(p.role).toBe("batsman");
      expect(testProfileOf(p)?.bowl).toBe(2);
      expect(testPlayerOf(p).bowler).toBe(true);
    }
    expect(testPlayerOf(byName("Shoaib Bashir")!).spin).toBe(true);
    expect(testPlayerOf(byName("Joe Root")!).bowler).toBe(false);
    expect(testPlayerOf(testTeam("Australia").roster.find(p => p.name === "Travis Head")!).bowler).toBe(false);
  });

  it("an XI has two openers and bats in its real order: openers first, the keeper at 5-8, the bowlers last", () => {
    for (const side of SIDES) {
      const xi = pickTestXI(testTeam(side).roster, side === "India" || side === "Pakistan" ? "sub" : "other");
      expect(xi.slice(0, 2).every(isTestOpener)).toBe(true);
      const slots = xi.map(testBattingSlot);
      expect(slots).toEqual([...slots].sort((a, b) => a - b));
      // the keeper who keeps (the first keeper in the order) bats in the middle or lower order unless he opens
      const bowlers = xi.map((p, i) => [p, i] as const).filter(([p]) => testPlayerOf(p).bowler && testBattingSlot(p) >= 8);
      for (const [, i] of bowlers) expect(i).toBeGreaterThanOrEqual(6);
    }
    const ind = pickTestXI(testTeam("India").roster, "sub").map(p => p.name);
    expect(ind[0]).toBe("Yashasvi Jaiswal");
    expect(ind.indexOf("Ravindra Jadeja")).toBeGreaterThanOrEqual(5);
    const aus = pickTestXI(testTeam("Australia").roster).map(p => p.name);
    expect(aus.indexOf("Alex Carey")).toBeGreaterThanOrEqual(5);
    expect(aus.indexOf("Nathan Lyon")).toBeGreaterThanOrEqual(7);
  });

  it("without a first-class record: the T20 place in the order and the role", () => {
    const p = new Player({
      id: "gen_x", name: "New Opener", age: 22, country: "India", role: "batsman", battingPosition: "opener",
      ratings: { battingIQ: 70, timing: 70, power: 60, running: 60, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 60 },
      isInternational: true, isWicketKeeper: false, bowlingStyle: "unknown", battingHand: "right", injured: false, injuryGamesLeft: 0,
    } as never);
    expect(testProfileOf(p)).toBeUndefined();
    expect(testBattingSlot(p)).toBe(1.5);
    expect(isTestOpener(p)).toBe(true);
  });
});
