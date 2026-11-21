/**
 * The wicket hazard by the state of the innings (state-wickets.ts, docs/TACTICS.md section 11): a chase's wicket class by its pressure,
 * the over band and wickets down, fitted against the engine and neutral per league; men's league T20s only (not a T20I, The Hundred, the
 * women or a super over), so a T20I and every first innings play exactly as before. Seeded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATE_WICKETS, STATE_WICKETS_PRESSURE_EDGES } from "../state-wickets-data.js";
import { STATE_WICKETS_SWITCH, applyStateWickets, stateWicketsGroup, stateWicketsMultiplier, stateWicketsPressureBin } from "../state-wickets.js";
import { ballProbabilities, simulateMatch, type BallModelPlayer, type BallOutcome, type VenueContext } from "../match.js";
import { T20_FORMAT } from "../format.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });
afterEach(() => { STATE_WICKETS_SWITCH.off = false; STATE_WICKETS_SWITCH.first = true; STATE_WICKETS_SWITCH.chase = true; });

const ROW = (pressureBin: number, overBand: number) => STATE_WICKETS.chase[pressureBin * 5 + overBand];

describe("the fitted table", () => {
  it("bins: wickets down 0-2, 3-4, 5-6, 7-8, 9; pressure <= -0.25, -0.25-0, 0-0.25, 0.25-0.5, 0.5-1, 1+", () => {
    expect([0, 2, 3, 4, 5, 6, 7, 8, 9].map(stateWicketsGroup)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4]);
    expect(STATE_WICKETS_PRESSURE_EDGES).toEqual([-0.25, 0, 0.25, 0.5, 1]);
    expect([-1, -0.25, -0.1, 0, 0.1, 0.25, 0.4, 0.5, 0.9, 1, 1.5].map(stateWicketsPressureBin)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
  });
  it("covers the nine men's leagues, a row per pressure bin and over band; the first innings is not in play (zero)", () => {
    expect(Object.keys(STATE_WICKETS.scale).sort()).toEqual(["bbl", "bpl", "cpl", "ilt20", "ipl", "lpl", "mlc", "psl", "sa20"]);
    expect(STATE_WICKETS.chase).toHaveLength(30);
    expect(STATE_WICKETS.chase.every(r => r.length === 5)).toBe(true);
    expect(STATE_WICKETS.first.flat().every(v => v === 0)).toBe(true);
    for (const s of Object.values(STATE_WICKETS.scale)) expect(s[0]).toBe(1);
  });
  it("real chases collapse less than the engine's: seven or eight down under a high required rate at the death, fewer wickets than a comfortable chase's start", () => {
    const m = (pb: number, ob: number, g: number) => Math.exp(ROW(pb, ob)[g]);
    // seven or eight down, the required rate far above the current one, overs 16-20
    expect(m(5, 3, 3)).toBeLessThan(1);
    expect(m(5, 4, 3)).toBeLessThan(1);
    // a comfortable chase in the powerplay loses more wickets than the engine's (its chase adjustment protects them)
    expect(m(0, 0, 0)).toBeGreaterThan(m(5, 3, 3));
  });
});

describe("where it applies", () => {
  it("men's leagues only, the chase only (while the first-innings table is zero), and the switches turn it off", () => {
    const g = stateWicketsGroup(7);
    const expected = Math.exp(ROW(5, 4)[g]) * STATE_WICKETS.scale.ipl[1];
    expect(stateWicketsMultiplier("ipl", true, 18, 7, 1.2)).toBeCloseTo(expected, 12);
    expect(stateWicketsMultiplier("ipl", false, 18, 7)).toBe(1);
    for (const key of ["t20i-male", "default-male", "hundred-m", "wpl", "wbbl", undefined]) expect(stateWicketsMultiplier(key, true, 18, 7, 1.2)).toBe(1);
    expect(stateWicketsMultiplier("ipl", true, 18, 7, undefined)).toBe(1);
    STATE_WICKETS_SWITCH.chase = false;
    expect(stateWicketsMultiplier("ipl", true, 18, 7, 1.2)).toBe(1);
    STATE_WICKETS_SWITCH.chase = true; STATE_WICKETS_SWITCH.off = true;
    expect(stateWicketsMultiplier("ipl", true, 18, 7, 1.2)).toBe(1);
    STATE_WICKETS_SWITCH.off = false;
    const probs = { dot: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1, wicket: 0.05, wide: 1, noball: 1, legbye: 1 } as Record<BallOutcome, number>;
    applyStateWickets(probs, "bbl", true, 18, 7, 1.2);
    expect(probs.wicket).toBeCloseTo(0.05 * Math.exp(ROW(5, 4)[g]) * STATE_WICKETS.scale.bbl[1], 12);
    expect(probs.dot).toBe(1);
  });

  it("the ball model (both engines) reads the chase's pressure: the wicket weight moves by the cell's multiplier", () => {
    const p: BallModelPlayer = { battingOvr: 60, bowlingOvr: 60, bowlingStyle: "right-arm-fast", battingHand: "right", ratings: { timing: 60, power: 60, wicketTaking: 60, accuracy: 60, clutch: 50 }, morale: 70 };
    const venue: VenueContext = { stadiumBowlRating: 1, pitchType: "balanced", boundarySize: "medium", dewFactor: "none", profile: null, chaseAdvantage: 0, gender: "male", wicketsInHandKey: "ipl" };
    // 100 needed off 36 at 80 off 84: required 16.7 an over, current 5.7 -> pressure 1.37
    const at = () => ballProbabilities(p, p, { over: 14, isSecondInnings: true, target: 181, currentScore: 81, ballsRemaining: 36, wicketsDown: 7, venue, inningsBalls: 120, rules: { freeHit: false, fmt: T20_FORMAT, gender: "male" } });
    const on = at();
    STATE_WICKETS_SWITCH.off = true;
    const off = at();
    const mult = Math.exp(ROW(5, 2)[stateWicketsGroup(7)]) * STATE_WICKETS.scale.ipl[1];
    expect(on.wicket / off.wicket).toBeCloseTo(mult, 9);
    expect(on.dot).toBe(off.dot);
    expect(on["6"]).toBe(off["6"]);
  });
});

describe("in play", () => {
  const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };
  const teams = (): Team[] => {
    const out = IPL_TEAMS.map(c => new Team(c, RULES.salaryCap));
    for (const d of getRealPlayers()) out.find(t => t.id === d.teamId)?.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
    return out;
  };
  it("an IPL first innings is ball for ball as before; the chases end all out less often, with the chases' wickets about where they were", () => {
    const N = 600;
    const play = (off: boolean) => {
      STATE_WICKETS_SWITCH.off = off;
      const ts = teams();
      let ao = 0, wk = 0;
      const first: string[] = [];
      for (let i = 0; i < N; i++) {
        const r = simulateMatch(ts[i % 10], ts[(i * 3 + 1) % 10 === i % 10 ? (i + 1) % 10 : (i * 3 + 1) % 10], RULES, 4242 + i, { countTowardStandings: false });
        if (i < 40) first.push(`${r.innings[0].runs}/${r.innings[0].wickets}/${r.innings[0].totalBalls}`);
        ao += +(r.innings[1].wickets >= 10); wk += r.innings[1].wickets;
      }
      return { ao: ao / N, wk: wk / N, first };
    };
    // (the first set of teams built in a process plays differently from every later one, whatever the switch: build one and throw it away)
    teams();
    const before = play(true), after = play(false);
    expect(after.first).toEqual(before.first);
    expect(after.ao).toBeLessThan(before.ao);
    expect(Math.abs(after.wk - before.wk)).toBeLessThan(0.3);
  });
});
