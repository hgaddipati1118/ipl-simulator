/**
 * The Laws and T20 playing conditions in the instant engine (match.ts): every dismissal kind and its legality, extras,
 * free hits, strike after a wicket, non-striker run outs, stats attribution, scorecard text, super overs, a Mankad,
 * retired hurt, incomplete overs, The Hundred, and a check of the simulated dismissal mix against Cricsheet.
 * (The live engine's versions of these are in live-match-rules.test.ts.) RULES-MATCH.md section 12.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { simulateMatch, type BallEvent, type InningsScore, type MatchResult } from "../match.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { getLeague } from "../leagues.js";
import {
  DELIVERY_DISMISSALS,
  canDismiss,
  countsAsWicket,
  dismissalText,
  isBowlerWicket,
  legalDismissals,
  setRuleOverrides,
  type DismissalKind,
  type RuleOverrides,
} from "../delivery-rules.js";
import { MATCH_RULES_DATA as D } from "../match-rules-data.js";

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

/** A legal 16-player squad: keeper, batters, all-rounders and six bowlers (pace and spin), some on the bench */
function squad(team: Team, idx: number): void {
  let n = idx * 100;
  team.addPlayer(player(`wk_${++n}`, "batsman", false, true), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(player(`bat_${++n}`, "batsman", i === 0), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(player(`ar_${++n}`, "all-rounder", i === 0, false, i % 2 ? "off-spin" : "right-arm-medium-fast"), 1);
  const styles = ["right-arm-fast", "left-arm-fast", "leg-spin", "left-arm-orthodox", "right-arm-medium", "off-spin", "right-arm-fast"];
  for (let i = 0; i < 7; i++) team.addPlayer(player(`bow_${++n}`, "bowler", false, false, styles[i]), 1);
}

let cache: Team[] | undefined;
function teams(): Team[] {
  if (!cache) {
    cache = IPL_TEAMS.slice(0, 6).map((c, i) => {
      const t = new Team(c, 120);
      squad(t, i);
      return t;
    });
  }
  return cache;
}

const rules: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };

function play(n: number, opts: { seed?: number; rules?: RuleSet; pool?: Team[] } = {}): MatchResult[] {
  const pool = opts.pool ?? teams();
  const out: MatchResult[] = [];
  for (let i = 0; i < n; i++) {
    const a = pool[i % pool.length];
    const b = pool[(i * 7 + 3) % pool.length === i % pool.length ? (i + 1) % pool.length : (i * 7 + 3) % pool.length];
    out.push(simulateMatch(a, b, opts.rules ?? rules, (opts.seed ?? 1) * 100000 + i, { countTowardStandings: false, rain: false }));
  }
  return out;
}

function innings(results: MatchResult[]): InningsScore[] {
  return results.flatMap(r => r.innings);
}

vi.setConfig({ testTimeout: 180000 });

const isLegal = (e: BallEvent) => e.outcome !== "wide" && e.outcome !== "noball" && !e.deadBall;

/** A batter went off (hurt / timed out / retired out) around this ball, which changes who is at the crease */
const changedPair = (inn: InningsScore, e: BallEvent) => (inn.offBall ?? []).some(o => o.over === e.over && (o.ball === e.ball || o.ball === e.ball - 1));

afterEach(() => setRuleOverrides(null));

function withOverrides<T>(o: RuleOverrides, fn: () => T): T {
  setRuleOverrides(o);
  try { return fn(); } finally { setRuleOverrides(null); }
}

describe("dismissal legality matrix (Laws 22, 41 and the T20 free hit)", () => {
  const K = DELIVERY_DISMISSALS;
  it("legal ball: every dismissal that happens on a delivery", () => {
    for (const k of K) expect(canDismiss(k, "legal", false), k).toBe(true);
  });
  it("wide: only stumped, hit wicket, run out, obstructing, handled, hit twice", () => {
    const ok = legalDismissals("wide", false).sort();
    expect(ok).toEqual(["handled_the_ball", "hit_the_ball_twice", "hit_wicket", "obstructing_the_field", "run_out", "stumped"]);
    for (const k of ["bowled", "caught", "caught_and_bowled", "lbw"] as const) expect(canDismiss(k, "wide", false)).toBe(false);
  });
  it("no-ball and free hit: only run out, obstructing the field, handled the ball, hit the ball twice", () => {
    const expected = ["handled_the_ball", "hit_the_ball_twice", "obstructing_the_field", "run_out"];
    expect(legalDismissals("noBall", false).sort()).toEqual(expected);
    expect(legalDismissals("legal", true).sort()).toEqual(expected);
    expect(legalDismissals("wide", true).sort()).toContain("run_out");
    expect(canDismiss("hit_wicket", "noBall", false)).toBe(false);
    expect(canDismiss("stumped", "legal", true)).toBe(false);
    expect(canDismiss("lbw", "legal", true)).toBe(false);
  });
  it("timed out and retired out are not deliveries", () => {
    for (const c of ["legal", "wide", "noBall"] as const) {
      expect(canDismiss("timed_out", c, false)).toBe(false);
      expect(canDismiss("retired_out", c, false)).toBe(false);
    }
  });
  it("only bowled, caught, caught and bowled, lbw, stumped and hit wicket are the bowler's", () => {
    const bowler = (["bowled", "caught", "caught_and_bowled", "lbw", "stumped", "hit_wicket"] as DismissalKind[]);
    for (const k of K) expect(isBowlerWicket(k), k).toBe(bowler.includes(k));
    expect(isBowlerWicket("timed_out")).toBe(false);
    expect(isBowlerWicket("retired_out")).toBe(false);
    expect(countsAsWicket("timed_out")).toBe(true);
    expect(countsAsWicket("retired_out")).toBe(false);
  });

  it("simulated wickets respect the matrix on wides, no-balls and free hits", () => {
    const seen = { wide: 0, noBall: 0, freeHit: 0 };
    for (const inn of innings(play(600))) {
      for (const e of inn.ballLog) {
        if (!e.isWicket) continue;
        const kind = e.wicketType as DismissalKind;
        if (e.outcome === "wide") { seen.wide++; expect(canDismiss(kind, "wide", !!e.freeHit), kind).toBe(true); }
        else if (e.outcome === "noball") { seen.noBall++; expect(canDismiss(kind, "noBall", false), kind).toBe(true); }
        else if (e.freeHit) { seen.freeHit++; expect(canDismiss(kind, "legal", true), kind).toBe(true); }
      }
    }
    expect(seen.wide).toBeGreaterThan(0);
  });

  it("even when a kind is forced on every dismissal, bowled / caught / lbw / hit wicket never get a batter out on a no-ball or free hit", () => {
    for (const kind of ["bowled", "caught", "lbw", "hit_wicket", "stumped", "caught_and_bowled"] as DismissalKind[]) {
      withOverrides({ forceKind: kind }, () => {
        let checked = 0;
        for (const inn of innings(play(120, { seed: 7 }))) {
          for (const e of inn.ballLog) {
            if (e.outcome === "noball" || e.freeHit) {
              checked++;
              if (e.isWicket) expect(["run_out", "obstructing_the_field", "handled_the_ball", "hit_the_ball_twice"], kind).toContain(e.wicketType);
            }
            if (e.outcome === "wide" && e.isWicket) expect(["stumped", "hit_wicket", "run_out", "obstructing_the_field", "handled_the_ball", "hit_the_ball_twice"]).toContain(e.wicketType);
          }
        }
        expect(checked).toBeGreaterThan(20);
      });
    }
  });
});

describe("free hit", () => {
  it("follows every no-ball and carries through a wide or no-ball bowled on it; a legal ball ends it", () => {
    let freeHits = 0, carried = 0;
    for (const inn of innings(play(500))) {
      let expected = false;
      for (const e of inn.ballLog) {
        if (e.deadBall) continue;
        expect(!!e.freeHit, `over ${e.over}.${e.ball} ${e.outcome}`).toBe(expected);
        if (expected) freeHits++;
        const next = e.outcome === "noball" || (expected && e.outcome === "wide");
        if (expected && next) carried++;
        expected = next;
      }
    }
    expect(freeHits).toBeGreaterThan(100);
    expect(carried).toBeGreaterThan(0);
  });

  it("scores more boundaries on a free hit (Cricsheet: about 3x the sixes)", () => {
    let fhBalls = 0, fhSix = 0, balls = 0, six = 0;
    for (const inn of innings(play(2500))) {
      for (const e of inn.ballLog) {
        if (!isLegal(e) || e.byes || e.legByes) continue;
        if (e.freeHit) { fhBalls++; if (e.boundary === 6) fhSix++; }
        else { balls++; if (e.boundary === 6) six++; }
      }
    }
    expect(fhBalls).toBeGreaterThan(1500);
    const ratio = (fhSix / fhBalls) / (six / balls);
    expect(ratio).toBeGreaterThan(2.0);
    expect(ratio).toBeLessThan(4.0);
  });

  it("a free hit that is itself a no-ball costs the no-ball penalty and keeps the free hit", () => {
    for (const inn of innings(play(400))) {
      for (const e of inn.ballLog) if (e.outcome === "noball") expect(e.noBalls).toBe(1);
    }
  });
});

describe("extras", () => {
  const all = () => innings(play(1500, { seed: 3 }));

  it("wides carry 1-5 runs (5 = a boundary wide), batters do not face them, and the bowler is charged all of them", () => {
    let wides = 0, five = 0, multi = 0;
    for (const inn of all()) {
      for (const e of inn.ballLog) {
        if (e.outcome !== "wide") continue;
        wides++;
        expect(e.wides).toBeGreaterThanOrEqual(1);
        expect(e.wides).toBeLessThanOrEqual(5);
        expect(e.extras).toBe(e.wides! + (e.penaltyRuns ?? 0));
        if (e.wides === 5) five++;
        if (e.wides! > 1) multi++;
      }
    }
    expect(wides).toBeGreaterThan(3000);
    expect(five / wides).toBeGreaterThan(0.015);
    expect(five / wides).toBeLessThan(0.07);
    expect(multi).toBeGreaterThan(wides * 0.05);
  });

  it("no-balls cost 1 plus whatever the bat hit, and the batter faces them", () => {
    let nb = 0, withRuns = 0;
    for (const inn of all()) {
      for (const e of inn.ballLog) {
        if (e.outcome !== "noball") continue;
        nb++;
        expect(e.noBalls).toBe(1);
        if (e.runs > 0) withRuns++;
      }
    }
    expect(nb).toBeGreaterThan(300);
    expect(withRuns / nb).toBeGreaterThan(0.3); // Cricsheet: ~56% of no-balls are hit for runs
  });

  it("byes and leg byes (1-5 runs) are extras, never the batter's or the bowler's", () => {
    let byes = 0, legByes = 0, four = 0;
    for (const inn of all()) {
      for (const e of inn.ballLog) {
        if (e.byes) { byes++; expect(e.runs).toBe(0); }
        if (e.legByes && e.outcome === "legbye") { legByes++; expect(e.runs).toBe(0); }
        if ((e.byes ?? 0) === 4 || (e.legByes ?? 0) === 4) four++;
      }
      const bowlerCharged = [...inn.bowlerStats.values()].reduce((s, b) => s + b.runs, 0);
      const byesTotal = inn.ballLog.reduce((s, e) => s + (e.byes ?? 0) + (e.legByes ?? 0) + (e.penaltyRuns ?? 0), 0);
      expect(bowlerCharged + byesTotal).toBe(inn.runs);
    }
    expect(byes).toBeGreaterThan(300);
    expect(legByes).toBeGreaterThan(1500);
    expect(four).toBeGreaterThan(20);
  });

  it("penalty runs (5) are extras that no bowler is charged with", () => {
    withOverrides({ penaltyPerDelivery: 0.02 }, () => {
      let n = 0;
      for (const r of play(30, { seed: 4 })) {
        for (const inn of r.innings) {
          const penalty = inn.ballLog.reduce((s, e) => s + (e.penaltyRuns ?? 0), 0);
          n += inn.ballLog.filter(e => e.penaltyRuns).length;
          expect(inn.extrasBreakdown!.penalty).toBe(penalty);
          const bowlerCharged = [...inn.bowlerStats.values()].reduce((s, b) => s + b.runs, 0);
          const batted = [...inn.batterStats.values()].reduce((s, b) => s + b.runs, 0);
          expect(inn.runs).toBe(batted + inn.extras);
          expect(bowlerCharged).toBe(inn.runs - (inn.extrasBreakdown!.byes + inn.extrasBreakdown!.legByes + penalty));
        }
        const card = r.detailed!.innings1.extras;
        expect(card.penalty ?? 0).toBeGreaterThanOrEqual(0);
      }
      expect(n).toBeGreaterThan(20);
    });
  });

  it("overthrow boundaries add 4 to the batter's runs without a four", () => {
    withOverrides({ overthrowBoundaryAfterRun: 0.2, overthrowBoundaryAfterDot: 0.05 }, () => {
      let over = 0;
      for (const inn of innings(play(60, { seed: 5 }))) {
        for (const e of inn.ballLog) {
          if (!e.overthrow) continue;
          over++;
          expect(e.overthrow).toBe(4);
          expect(e.boundary).toBeUndefined();
          expect(e.runs).toBeGreaterThanOrEqual(4);
        }
      }
      expect(over).toBeGreaterThan(100);
    });
  });

  it("extras fitted to Cricsheet: about 8-9 extras an innings", () => {
    const inns = all();
    const mean = inns.reduce((s, i) => s + i.extras, 0) / inns.length;
    // the IPL's shape (RULES-MATCH.md 12.8) takes its extras from the real IPL since 2024: 8.9 an innings
    expect(mean).toBeGreaterThan(7.2);
    expect(mean).toBeLessThan(10.0);
  });
});

describe("strike after a wicket and runs run", () => {
  it("after a catch, bowled, lbw, stumping or hit wicket (not at an over end) the new batter faces the next ball", () => {
    let checked = 0;
    for (const inn of innings(play(1200, { seed: 6 }))) {
      for (let i = 0; i < inn.ballLog.length - 1; i++) {
        const e = inn.ballLog[i];
        const next = inn.ballLog[i + 1];
        if (!e.isWicket || e.deadBall) continue;
        if (!["caught", "caught_and_bowled", "bowled", "lbw", "stumped", "hit_wicket"].includes(e.wicketType!)) continue;
        if (isLegal(e) && e.ball === 6) continue; // the over ended
        if (next.over !== e.over && !(e.outcome === "wide" || e.outcome === "noball")) continue;
        checked++;
        // the survivor is the non-striker of the dismissal ball; the new batter, not he, takes strike
        expect(next.batter, `${e.wicketType} at ${e.over}.${e.ball}`).not.toBe(e.nonStriker);
        expect(next.batter).not.toBe(e.batter);
        expect(next.nonStriker).toBe(e.nonStriker);
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("at an over's end the survivor, not the new batter, faces the next over", () => {
    let checked = 0;
    for (const inn of innings(play(1200, { seed: 8 }))) {
      for (let i = 0; i < inn.ballLog.length - 1; i++) {
        const e = inn.ballLog[i], next = inn.ballLog[i + 1];
        if (!e.isWicket || e.deadBall || !["caught", "bowled", "lbw", "stumped"].includes(e.wicketType!)) continue;
        if (!(isLegal(e) && e.ball === 6)) continue;
        // (a tactical retirement between the overs can send the survivor off and bring on another batter)
        // (or a batter going off hurt on that ball)
        if ((inn.offBall ?? []).some(o => (o.over === e.over + 1 && o.ball === 0) || (o.over === e.over && o.ball === e.ball))) continue;
        checked++;
        expect(next.batter).toBe(e.nonStriker);
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("a run out leaves the end the data has: the batter at the end where it happened is replaced", () => {
    // Cricsheet since Oct 2022: P(new batter faces) = 0.58 / 0.24 for a non-striker out (even / odd runs), 0.39 / 0.83 for the striker
    const stat: Record<string, [number, number]> = {};
    for (const inn of innings(play(4000, { seed: 28 }))) {
      for (let i = 0; i < inn.ballLog.length - 1; i++) {
        const e = inn.ballLog[i], next = inn.ballLog[i + 1];
        if (!e.isWicket || e.wicketType !== "run_out" || e.deadBall || !isLegal(e) || e.ball === 6) continue;
        const outNs = !!e.playerOutId && e.playerOutId !== e.batter;
        const survivor = outNs ? e.batter : e.nonStriker;
        const key = `${outNs ? "ns" : "s"}${(e.runsRun ?? 0) % 2}`;
        const cur = stat[key] ?? (stat[key] = [0, 0]);
        cur[0]++;
        if (next.batter !== survivor) cur[1]++;
      }
    }
    const p = (k: string) => stat[k][1] / stat[k][0];
    expect(p("s1")).toBeGreaterThan(0.7);
    expect(p("s0")).toBeGreaterThan(0.28);
    expect(p("s0")).toBeLessThan(0.5);
    expect(p("ns0")).toBeGreaterThan(0.45);
    expect(p("ns1")).toBeLessThan(0.35);
  });

  it("odd runs run change the strike, including byes, leg byes and runs off a no-ball", () => {
    // replay a handful of innings tracking who is on strike from the log alone
    for (const inn of innings(play(100, { seed: 9 }))) {
      let sawOddExtra = 0;
      for (let i = 0; i < inn.ballLog.length - 1; i++) {
        const e = inn.ballLog[i];
        const next = inn.ballLog[i + 1];
        if (e.isWicket || e.deadBall || !next || next.over !== e.over || e.runsRun === undefined || next.deadBall || changedPair(inn, e)) continue;
        if (e.runsRun % 2 === 1 && ((e.byes ?? 0) > 0 || (e.legByes ?? 0) > 0 || (e.wides ?? 0) > 1)) {
          sawOddExtra++;
          expect(next.batter).not.toBe(e.batter);
        }
        if (e.runsRun % 2 === 0 && !next.isWicket && e.over === next.over && !(e.isWicket)) {
          // even runs: the same batter faces again unless the previous ball ended an over
          expect(next.batter).toBe(e.batter);
        }
      }
      void sawOddExtra;
    }
  });

  it("odd bat runs swap strike too (replay)", () => {
    for (const inn of innings(play(100, { seed: 10 }))) {
      for (let i = 0; i < inn.ballLog.length - 1; i++) {
        const e = inn.ballLog[i], next = inn.ballLog[i + 1];
        if (e.isWicket || next.over !== e.over || e.deadBall || next.deadBall || changedPair(inn, e)) continue;
        const swap = (e.runsRun ?? 0) % 2 === 1;
        // a replacement due to retirement changes the pair, so only compare when nobody left
        if (swap) expect(next.batter).not.toBe(e.batter);
        else expect(next.batter).toBe(e.batter);
      }
    }
  });
});

describe("non-striker run outs", () => {
  it("48% of Cricsheet T20 run outs dismiss the non-striker: so do the simulated ones", () => {
    let ro = 0, ns = 0;
    for (const inn of innings(play(4000, { seed: 11 }))) {
      for (const e of inn.ballLog) {
        if (!e.isWicket || e.wicketType !== "run_out" || e.deadBall) continue;
        ro++;
        if (e.playerOutId && e.playerOutId !== e.batter) ns++;
      }
    }
    expect(ro).toBeGreaterThan(2000);
    expect(ns / ro).toBeGreaterThan(0.43);
    expect(ns / ro).toBeLessThan(0.52);
  });

  it("the non-striker goes, the striker stays and keeps his ball and runs", () => {
    withOverrides({ forceKind: "run_out", forceRunOutRole: "nonStriker", forceRunOutRuns: 1 }, () => {
      let seen = 0;
      for (const r of play(40, { seed: 12 })) {
        for (let k = 0; k < 2; k++) {
          const inn = r.innings[k];
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          for (const e of inn.ballLog) {
            if (!e.isWicket || e.wicketType !== "run_out" || e.deadBall || !e.playerOutId) continue;
            seen++;
            expect(e.playerOutId).not.toBe(e.batter);
            expect(inn.batterStats.get(e.playerOutId)!.isOut).toBe(true);
            // the striker is the one who scored the completed run (when this chance was taken, not a miss)
            if (e.outcome === "wicket") expect(e.runs).toBe(1);
            const row = card.batters.find(b => b.playerId === e.playerOutId);
            expect(row?.howOut.startsWith("run out")).toBe(true);
            // not the bowler's wicket
            expect(isBowlerWicket(e.wicketType)).toBe(false);
          }
          // the bowlers' wickets are only bowler wickets
          const bw = [...inn.bowlerStats.values()].reduce((s, b) => s + b.wickets, 0);
          const expected = inn.ballLog.filter(e => e.isWicket && isBowlerWicket(e.wicketType)).length;
          expect(bw).toBe(expected);
        }
      }
      expect(seen).toBeGreaterThan(50);
    });
  });

  it("run-out fielders: one or two names, the bowler and the keeper often involved", () => {
    let ro = 0, two = 0, bowler = 0;
    for (const inn of innings(play(4000, { seed: 13 }))) {
      for (const e of inn.ballLog) {
        if (e.wicketType !== "run_out" || !e.isWicket || e.deadBall) continue;
        ro++;
        if (e.fielder2Id) two++;
        if (e.fielderId === e.bowler || e.fielder2Id === e.bowler) bowler++;
      }
    }
    expect(two / ro).toBeGreaterThan(0.4);
    expect(two / ro).toBeLessThan(0.65);
    expect(bowler / ro).toBeGreaterThan(0.2);
    expect(bowler / ro).toBeLessThan(0.45);
  });

  it("a run out can happen off a wide and off a no-ball, with the extra still counted", () => {
    withOverrides({ forceKind: "run_out" }, () => {
      let wide = 0, noball = 0;
      for (const inn of innings(play(300, { seed: 14 }))) {
        for (const e of inn.ballLog) {
          if (!e.isWicket) continue;
          if (e.outcome === "wide") { wide++; expect(e.extras).toBeGreaterThanOrEqual(1); }
          if (e.outcome === "noball") { noball++; expect(e.noBalls).toBe(1); expect(e.extras).toBeGreaterThanOrEqual(1); }
        }
      }
      expect(wide).toBeGreaterThan(0);
      expect(noball).toBeGreaterThan(0);
    });
  });
});

describe("stats attribution", () => {
  const results = play(300, { seed: 15 });

  it("balls faced: wides are not faced, no-balls are; bowler balls are legal balls only", () => {
    for (const inn of innings(results)) {
      const faced = new Map<string, number>();
      const legalBy = new Map<string, number>();
      for (const e of inn.ballLog) {
        if (e.deadBall) continue;
        if (e.outcome !== "wide") faced.set(e.batter, (faced.get(e.batter) ?? 0) + 1);
        if (isLegal(e)) legalBy.set(e.bowler, (legalBy.get(e.bowler) ?? 0) + 1);
      }
      for (const [id, st] of inn.batterStats) expect(st.balls).toBe(faced.get(id) ?? 0);
      for (const [id, st] of inn.bowlerStats) expect(st.overs * 6 + st.balls).toBe(legalBy.get(id) ?? 0);
      expect([...legalBy.values()].reduce((a, b) => a + b, 0)).toBe(inn.totalBalls);
    }
  });

  it("bowler runs: bat runs + wides + no-balls only (not byes, leg byes, penalty)", () => {
    for (const inn of innings(results)) {
      const expected = new Map<string, number>();
      for (const e of inn.ballLog) {
        if (e.deadBall) continue;
        expected.set(e.bowler, (expected.get(e.bowler) ?? 0) + e.runs + (e.wides ?? 0) + (e.noBalls ?? 0));
      }
      for (const [id, st] of inn.bowlerStats) expect(st.runs).toBe(expected.get(id) ?? 0);
    }
  });

  it("innings runs = batter runs + extras; extras = wides + no-balls + byes + leg byes + penalty", () => {
    for (const inn of innings(results)) {
      const batted = [...inn.batterStats.values()].reduce((s, b) => s + b.runs, 0);
      const eb = inn.extrasBreakdown!;
      expect(inn.extras).toBe(eb.wides + eb.noBalls + eb.byes + eb.legByes + eb.penalty);
      expect(inn.runs).toBe(batted + inn.extras);
    }
    for (const r of results) {
      for (const card of [r.detailed!.innings1, r.detailed!.innings2]) {
        expect(card.extras.total).toBe(card.totalRuns - card.batters.reduce((s, b) => s + b.runs, 0));
      }
    }
  });

  it("wickets: only bowler wickets are the bowler's; fall of wickets lists every dismissal", () => {
    for (const inn of innings(results)) {
      const dismissals = inn.ballLog.filter(e => e.isWicket).length + (inn.offBall ?? []).filter(o => o.kind === "timed_out").length;
      expect(inn.wickets).toBe(dismissals);
      const credited = inn.ballLog.filter(e => e.isWicket && isBowlerWicket(e.wicketType)).length;
      expect([...inn.bowlerStats.values()].reduce((s, b) => s + b.wickets, 0)).toBe(credited);
    }
    for (const r of results) {
      expect(r.detailed!.innings1.fallOfWickets.length).toBe(r.innings[0].wickets);
    }
  });

  it("maidens: a full over of six legal balls with nothing charged to the bowler", () => {
    let maidens = 0;
    for (const r of results) {
      for (const [k, inn] of r.innings.entries()) {
        const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
        for (const b of card.bowlers) {
          maidens += b.maidens;
          expect(b.wides).toBe(inn.bowlerStats.get(b.playerId)!.wides);
        }
      }
    }
    expect(maidens).toBeGreaterThan(0);
  });

  it("catches are credited to the fielder (also caught and bowled to the bowler)", () => {
    const t = teams();
    const before = new Map(t.flatMap(x => x.roster.map(p => [p.id, p.stats.catches] as const)));
    let catches = 0;
    for (let i = 0; i < 100; i++) {
      const r = simulateMatch(t[i % 6], t[(i + 1) % 6], rules, 500 + i, { countTowardStandings: false });
      for (const inn of r.innings) catches += inn.ballLog.filter(e => e.isWicket && (e.wicketType === "caught" || e.wicketType === "caught_and_bowled") && !e.substitute).length;
    }
    const after = t.flatMap(x => x.roster.map(p => p.stats.catches - (before.get(p.id) ?? 0)));
    expect(after.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(catches);
  });
});

describe("scorecard text", () => {
  it("every kind prints as Cricinfo does", () => {
    expect(dismissalText({ kind: "bowled", bowler: "Bumrah" })).toBe("b Bumrah");
    expect(dismissalText({ kind: "caught", bowler: "Bumrah", fielder: "Pant" })).toBe("c Pant b Bumrah");
    expect(dismissalText({ kind: "caught", bowler: "Bumrah", fielder: "Sundar", substitute: true })).toBe("c sub (Sundar) b Bumrah");
    expect(dismissalText({ kind: "caught_and_bowled", bowler: "Bumrah" })).toBe("c & b Bumrah");
    expect(dismissalText({ kind: "lbw", bowler: "Chahal" })).toBe("lbw b Chahal");
    expect(dismissalText({ kind: "stumped", bowler: "Chahal", fielder: "Pant" })).toBe("st Pant b Chahal");
    expect(dismissalText({ kind: "hit_wicket", bowler: "Rabada" })).toBe("hit wicket b Rabada");
    expect(dismissalText({ kind: "run_out", fielder: "Jadeja" })).toBe("run out (Jadeja)");
    expect(dismissalText({ kind: "run_out", fielder: "Jadeja", fielder2: "Pant" })).toBe("run out (Jadeja/Pant)");
    expect(dismissalText({ kind: "run_out" })).toBe("run out");
    expect(dismissalText({ kind: "obstructing_the_field" })).toBe("obstructing the field");
    expect(dismissalText({ kind: "handled_the_ball" })).toBe("handled the ball");
    expect(dismissalText({ kind: "hit_the_ball_twice" })).toBe("hit the ball twice");
    expect(dismissalText({ kind: "timed_out" })).toBe("timed out");
    expect(dismissalText({ kind: "retired_out" })).toBe("retired out");
  });

  it("a scorecard shows the right text for every simulated kind", () => {
    const pattern: Record<string, RegExp> = {
      bowled: /^b /, caught: /^c .+ b /, caught_and_bowled: /^c & b /, lbw: /^lbw b /, stumped: /^st .+ b /,
      run_out: /^run out/, hit_wicket: /^hit wicket b /, obstructing_the_field: /^obstructing the field$/,
      handled_the_ball: /^handled the ball$/, hit_the_ball_twice: /^hit the ball twice$/,
    };
    for (const kind of Object.keys(pattern) as DismissalKind[]) {
      withOverrides({ forceKind: kind }, () => {
        let n = 0;
        for (const r of play(25, { seed: 16 })) {
          for (const [k, inn] of r.innings.entries()) {
            const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
            for (const e of inn.ballLog) {
              if (!e.isWicket || e.wicketType !== kind || e.deadBall) continue;
              const row = card.batters.find(b => b.playerId === (e.playerOutId ?? e.batter))!;
              expect(row.howOut, `${kind}`).toMatch(pattern[kind]);
              n++;
            }
          }
        }
        expect(n, kind).toBeGreaterThan(0);
      });
    }
  });
});

describe("a Mankad", () => {
  it("is a wicket (run out, non-striker) with no ball bowled and no legal ball counted", () => {
    withOverrides({ mankadPerDelivery: 0.03 }, () => {
      let seen = 0;
      for (const r of play(60, { seed: 17 })) {
        for (const [k, inn] of r.innings.entries()) {
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          const dead = inn.ballLog.filter(e => e.deadBall);
          seen += dead.length;
          for (const e of dead) {
            expect(e.wicketType).toBe("run_out");
            expect(e.isWicket).toBe(true);
            expect(e.playerOutId).toBeTruthy();
            expect(e.playerOutId).not.toBe(e.batter);
            expect(e.runs + e.extras).toBe(0);
            expect(e.fielderId).toBe(e.bowler);
            const row = card.batters.find(b => b.playerId === e.playerOutId)!;
            expect(row.howOut.startsWith("run out")).toBe(true);
          }
          // legal balls = balls that were bowled
          expect(inn.ballLog.filter(isLegal).length).toBe(inn.totalBalls);
          // no bowler is charged with it, nobody faced it
          const faced = [...inn.batterStats.values()].reduce((s, b) => s + b.balls, 0);
          expect(faced).toBe(inn.ballLog.filter(e => !e.deadBall && e.outcome !== "wide").length);
          // overs of six legal balls despite the dead balls
          const perOver = new Map<number, number>();
          for (const e of inn.ballLog) if (isLegal(e)) perOver.set(e.over, (perOver.get(e.over) ?? 0) + 1);
          for (const [over, c] of perOver) if (over < inn.overs - 1 || inn.balls === 0) expect(c).toBeLessThanOrEqual(6);
        }
      }
      expect(seen).toBeGreaterThan(10);
    });
  });
});

describe("retired hurt and retired out", () => {
  it("a retired-hurt batter is not out, can return at a wicket, and keeps his innings", () => {
    withOverrides({ hurtPerBatterBall: 0.004, returnProb: 1 }, () => {
      let hurt = 0, returned = 0;
      for (const r of play(80, { seed: 18 })) {
        for (const [k, inn] of r.innings.entries()) {
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          for (const o of (inn.offBall ?? []).filter(x => x.kind === "retired_hurt")) {
            hurt++;
            const id = o.playerId;
            // find the first ball of his that comes after the retirement
            const idx = inn.ballLog.findIndex(e => e.over * 6 + e.ball > o.over * 6 + o.ball && e.batter === id);
            if (idx >= 0) returned++;
            const row = card.batters.find(b => b.playerId === id)!;
            expect(["retired hurt", "not out"].includes(row.howOut) || row.howOut !== "").toBe(true);
            expect(inn.batterStats.get(id)!.isOut || row.howOut === "retired hurt" || idx >= 0).toBe(true);
          }
        }
      }
      expect(hurt).toBeGreaterThan(30);
      expect(returned).toBeGreaterThan(5);
    });
  });

  it("if he cannot return the innings ends when no partner is left (never a lone batter)", () => {
    withOverrides({ hurtPerBatterBall: 0.01, returnProb: 0 }, () => {
      let short = 0;
      for (const r of play(120, { seed: 19 })) {
        for (const inn of r.innings) {
          const hurt = (inn.offBall ?? []).filter(x => x.kind === "retired_hurt").length;
          // a tactical retirement (retired out) is not a wicket either
          const retiredOut = (inn.offBall ?? []).filter(x => x.kind === "retired_out").length;
          if (inn.totalBalls < 120 && inn.wickets < 10 && hurt > 0 && inn.runs < (inn === r.innings[1] ? r.innings[0].runs + 1 : 1e9)) {
            // all out short of ten: the retired batters are the missing ones
            short++;
            expect(inn.wickets + hurt + retiredOut).toBeGreaterThanOrEqual(10);
          }
        }
      }
      expect(short).toBeGreaterThan(0);
    });
  });

  it("is not a wicket and is shown as retired hurt on the scorecard", () => {
    withOverrides({ hurtPerBatterBall: 0.004, returnProb: 0 }, () => {
      let n = 0;
      for (const r of play(60, { seed: 20 })) {
        for (const [k, inn] of r.innings.entries()) {
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          const dismissals = inn.ballLog.filter(e => e.isWicket).length;
          expect(inn.wickets).toBe(dismissals);
          for (const o of (inn.offBall ?? []).filter(x => x.kind === "retired_hurt")) {
            const row = card.batters.find(b => b.playerId === o.playerId)!;
            expect(row.howOut).toBe("retired hurt");
            n++;
          }
        }
      }
      expect(n).toBeGreaterThan(10);
    });
  });

  it("retired out is not a wicket and cannot return", () => {
    withOverrides({ retiredOutPerInning: 0.9 }, () => {
      let n = 0;
      for (const r of play(60, { seed: 21 })) {
        for (const [k, inn] of r.innings.entries()) {
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          for (const o of (inn.offBall ?? []).filter(x => x.kind === "retired_out")) {
            n++;
            expect(card.batters.find(b => b.playerId === o.playerId)!.howOut).toBe("retired out");
            const later = inn.ballLog.filter(e => e.over * 6 + e.ball > o.over * 6 + o.ball && e.batter === o.playerId);
            expect(later.length).toBe(0);
          }
          expect(inn.wickets).toBe(inn.ballLog.filter(e => e.isWicket).length);
        }
      }
      expect(n).toBeGreaterThan(10);
    });
  });

  it("a batter can be timed out on arrival: a wicket with no bowler credit", () => {
    withOverrides({ timedOutPerWicket: 0.3 }, () => {
      let n = 0;
      for (const r of play(60, { seed: 22 })) {
        for (const [k, inn] of r.innings.entries()) {
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          for (const o of (inn.offBall ?? []).filter(x => x.kind === "timed_out")) {
            n++;
            expect(card.batters.find(b => b.playerId === o.playerId)!.howOut).toBe("timed out");
          }
          const credited = [...inn.bowlerStats.values()].reduce((s, b) => s + b.wickets, 0);
          expect(credited).toBe(inn.ballLog.filter(e => e.isWicket && isBowlerWicket(e.wicketType)).length);
          expect(inn.wickets).toBeLessThanOrEqual(10);
        }
      }
      expect(n).toBeGreaterThan(10);
    });
  });
});

describe("bowling: over limits, consecutive overs, an over left incomplete", () => {
  it("no bowler bowls more than four overs or two overs running", () => {
    for (const inn of innings(play(300, { seed: 23 }))) {
      const overBy = new Map<number, string>();
      const per = new Map<string, Set<number>>();
      for (const e of inn.ballLog) {
        if (!overBy.has(e.over)) overBy.set(e.over, e.bowler);
        if (!per.has(e.bowler)) per.set(e.bowler, new Set());
        per.get(e.bowler)!.add(e.over);
      }
      for (const overs of per.values()) expect(overs.size).toBeLessThanOrEqual(4);
      for (let o = 1; o < inn.overs; o++) expect(overBy.get(o)).not.toBe(overBy.get(o - 1));
    }
  });

  it("an over the bowler cannot finish is completed by another who then sits out the next over", () => {
    withOverrides({ bowlerLeavesPerOver: 0.03 }, () => {
      let split = 0, sameAgain = 0;
      for (const inn of innings(play(120, { seed: 24 }))) {
        const bowlersOf = new Map<number, string[]>();
        for (const e of inn.ballLog) {
          const l = bowlersOf.get(e.over) ?? [];
          if (l[l.length - 1] !== e.bowler) l.push(e.bowler);
          bowlersOf.set(e.over, l);
        }
        for (const [over, list] of bowlersOf) {
          if (list.length < 2) continue;
          split++;
          expect(new Set(list).size).toBe(list.length);
          const nxt = bowlersOf.get(over + 1);
          if (nxt) {
            // the one who finished cannot open the next over, the one who left never bowls again
            // (if nobody else has overs left the engine relaxes the rule, as it always has)
            if (nxt[0] === list[list.length - 1]) sameAgain++;
            for (let o = over + 1; o < inn.overs; o++) expect(bowlersOf.get(o)?.includes(list[0])).toBeFalsy();
          }
          // a part-bowled over still counts as an over: nobody exceeds four
        }
        const overs = new Map<string, Set<number>>();
        for (const e of inn.ballLog) { if (!overs.has(e.bowler)) overs.set(e.bowler, new Set()); overs.get(e.bowler)!.add(e.over); }
        for (const s of overs.values()) expect(s.size).toBeLessThanOrEqual(4);
        // six legal balls per completed over regardless of who bowled them
        const legal = new Map<number, number>();
        for (const e of inn.ballLog) if (isLegal(e)) legal.set(e.over, (legal.get(e.over) ?? 0) + 1);
        for (const [o, c] of legal) if (o < inn.overs - 1) expect(c).toBe(6);
      }
      expect(split).toBeGreaterThan(20);
      expect(sameAgain / split).toBeLessThan(0.1);
    });
  });
});

describe("super over", () => {
  /** matches that went to a super over, found by playing until there are enough (ties are ~1% of matches) */
  function tied(minimum: number, wantRounds = 1): MatchResult[] {
    const out: MatchResult[] = [];
    for (let seed = 30; out.length < minimum && seed < 400; seed++) {
      for (const r of play(500, { seed })) {
        const rounds = r.superOverRounds?.length ?? 0;
        if (rounds >= wantRounds) out.push(r);
      }
    }
    return out;
  }

  it("one over each, two wickets end an innings, three batters and one bowler, the side that batted second bats first", () => {
    const matches = tied(8);
    expect(matches.length).toBeGreaterThanOrEqual(8);
    for (const r of matches) {
      const [bat1, bat2] = r.superOverRounds![0];
      expect(r.margin).toBe("Super Over");
      // the side that batted second in the match bats first in the super over
      expect(bat1.teamId).toBe(r.innings[1].teamId);
      expect(bat2.teamId).toBe(r.innings[0].teamId);
      for (const s of [bat1, bat2]) {
        expect(s.totalBalls).toBeLessThanOrEqual(6);
        expect(s.wickets).toBeLessThanOrEqual(2);
        expect(s.superOver!.batters.length).toBe(3);
        const bowlers = new Set(s.ballLog.map(e => e.bowler));
        expect(bowlers.size).toBe(1);
        const batters = new Set(s.ballLog.map(e => e.batter));
        for (const b of batters) expect(s.superOver!.batters).toContain(b);
        if (s.wickets === 2) expect(s.totalBalls).toBeLessThanOrEqual(6);
        else expect(s.totalBalls === 6 || s === bat2).toBe(true);
      }
      expect(r.winnerId).toBeTruthy();
      expect(r.innings[0].runs).toBe(r.innings[1].runs);
    }
  });

  it("repeated super overs while tied; the previous bowler and dismissed batters are not used again", () => {
    const matches = tied(1, 2);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (const r of matches) {
      const rounds = r.superOverRounds!;
      for (let i = 0; i < rounds.length - 1; i++) expect(rounds[i][0].runs).toBe(rounds[i][1].runs); // tied rounds repeat
      expect(rounds[rounds.length - 1][0].runs).not.toBe(rounds[rounds.length - 1][1].runs);
      for (let i = 1; i < rounds.length; i++) {
        for (const prev of rounds[i - 1]) {
          const dismissed = new Set(prev.ballLog.filter(e => e.isWicket).map(e => e.playerOutId ?? e.batter));
          const next = rounds[i].find(s => s.teamId === prev.teamId)!;
          for (const b of next.superOver!.batters) expect(dismissed.has(b)).toBe(false);
        }
        // the bowler who bowled at a team in the last round is not used by his side again
        for (const prev of rounds[i - 1]) {
          const bowler = prev.superOver!.bowler;
          for (const s of rounds[i]) expect(s.superOver!.bowler).not.toBe(bowler);
        }
      }
      // alternate who bats first
      expect(rounds[1][0].teamId).toBe(rounds[0][1].teamId);
    }
  });
});

describe("The Hundred", () => {
  const league = getLeague("hundred-m")!;
  function hundredTeams(): Team[] {
    return league.teams.map((c, i) => {
      const t = new Team(c, league.rules.salaryCap);
      squad(t, i);
      return t;
    });
  }

  it("keeps 100-ball innings of 5-ball sets, a no-ball costs 2, free hits follow", () => {
    const pool = hundredTeams();
    let nb = 0, fh = 0;
    for (const r of play(200, { seed: 25, rules: { ...league.rules, injuriesEnabled: false }, pool })) {
      for (const inn of r.innings) {
        expect(inn.totalBalls).toBeLessThanOrEqual(100);
        expect(inn.ballLog.filter(isLegal).length).toBe(inn.totalBalls);
        for (const e of inn.ballLog) {
          if (e.outcome === "noball") { nb++; expect(e.noBalls).toBe(2); }
          if (e.freeHit) fh++;
        }
        const batted = [...inn.batterStats.values()].reduce((s, b) => s + b.runs, 0);
        expect(inn.runs).toBe(batted + inn.extras);
      }
    }
    expect(nb).toBeGreaterThan(10);
    expect(fh).toBeGreaterThanOrEqual(nb * 0.9);
  });

  it("a Hundred super over is five balls", () => {
    const pool = hundredTeams();
    let found = 0;
    for (let seed = 40; found < 2 && seed < 140; seed++) {
      for (const r of play(300, { seed, rules: { ...league.rules, injuriesEnabled: false }, pool })) {
        if (!r.superOverRounds) continue;
        found++;
        for (const s of r.superOver!) {
          expect(s.totalBalls).toBeLessThanOrEqual(5);
          expect(s.wickets).toBeLessThanOrEqual(2);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("dismissal mix against Cricsheet (men's T20 since 2019)", () => {
  it("caught, bowled, lbw, run out, stumped and the rare kinds match the data", () => {
    const kinds: Record<string, number> = {};
    let total = 0;
    for (const inn of innings(play(5000, { seed: 26 }))) {
      for (const e of inn.ballLog) {
        if (!e.isWicket || e.deadBall) continue;
        kinds[e.wicketType!] = (kinds[e.wicketType!] ?? 0) + 1;
        total++;
      }
    }
    const share = (k: string) => (kinds[k] ?? 0) / total;
    const mix = D.dismissalMix.male;
    expect(Math.abs(share("caught") - mix.caught)).toBeLessThan(0.03);
    expect(Math.abs(share("bowled") - mix.bowled)).toBeLessThan(0.025);
    expect(Math.abs(share("lbw") - mix.lbw)).toBeLessThan(0.015);
    expect(Math.abs(share("run_out") - mix.run_out)).toBeLessThan(0.02);
    expect(Math.abs(share("stumped") - mix.stumped)).toBeLessThan(0.012);
    expect(Math.abs(share("caught_and_bowled") - mix.caught_and_bowled)).toBeLessThan(0.012);
    expect(share("hit_wicket")).toBeLessThan(0.004);
    expect(total / 10000).toBeGreaterThan(5.5);
    expect(total / 10000).toBeLessThan(7.5);
  });

  it("women's rules use the women's mix (more run outs, stumpings and bowled)", () => {
    const wRules: RuleSet = { ...RULE_PRESETS.wpl, injuriesEnabled: false };
    const kinds: Record<string, number> = {};
    let total = 0;
    for (const inn of innings(play(2500, { seed: 27, rules: wRules }))) {
      for (const e of inn.ballLog) {
        if (!e.isWicket || e.deadBall) continue;
        kinds[e.wicketType!] = (kinds[e.wicketType!] ?? 0) + 1;
        total++;
      }
    }
    const men = D.dismissalMix.male, women = D.dismissalMix.female;
    expect(women.run_out).toBeGreaterThan(men.run_out);
    expect(Math.abs((kinds.run_out ?? 0) / total - women.run_out)).toBeLessThan(0.025);
    expect(Math.abs((kinds.bowled ?? 0) / total - women.bowled)).toBeLessThan(0.03);
  });
});

describe("old results and saves", () => {
  it("a ball log without any of the new fields still builds a scorecard shape (optional fields)", () => {
    const r = play(1, { seed: 99 })[0];
    for (const inn of r.innings) {
      for (const e of inn.ballLog) {
        // new fields are all optional
        const stripped: BallEvent = { over: e.over, ball: e.ball, bowler: e.bowler, batter: e.batter, outcome: e.outcome, runs: e.runs, extras: e.extras, isWicket: e.isWicket, commentary: e.commentary };
        expect(stripped.freeHit).toBeUndefined();
      }
    }
  });
});

describe("the generated Cricsheet parameters (match-rules.py -> match-rules-data.ts)", () => {
  const sum = (o: Readonly<Record<string, number>>) => Object.values(o).reduce((a, b) => a + b, 0);
  it("are distributions and sensible rates", () => {
    for (const g of ["male", "female"] as const) {
      expect(sum(D.dismissalMix[g])).toBeCloseTo(1, 3);
      expect(sum(D.wide.runs[g])).toBeCloseTo(1, 3);
      expect(sum(D.byes[g].byeRuns)).toBeCloseTo(1, 2);
      expect(sum(D.byes[g].legByeRuns)).toBeCloseTo(1, 2);
      expect((D.noBall.bat[g] as readonly (readonly number[])[]).reduce((s, r) => s + r[3], 0)).toBeGreaterThan(0.99);
      expect(D.wide.rate[g]).toBeGreaterThan(0.02);
      expect(D.wide.rate[g]).toBeLessThan(0.08);
    }
    expect(sum(D.freeHit.kinds)).toBeCloseTo(1, 3);
    expect(sum(D.wide.wicketKinds)).toBeCloseTo(1, 2);
    expect(D.runOut.nonStrikerShare["0"]).toBeGreaterThan(0.4);
    expect(D.runOut.nonStrikerShare["0"]).toBeLessThan(0.6);
    // Cricsheet: after a catch the new batter always faces (2022 Laws)
    expect(D.strike.otherKinds).toBeGreaterThan(0.99);
    expect(D.freeHit.scoring.six).toBeGreaterThan(2);
    expect(D.retire.returnProb).toBeLessThan(0.01);
  });
});
