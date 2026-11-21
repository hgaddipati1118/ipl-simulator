/**
 * The live engine plays at the instant engine's level (docs/RULES-MATCH.md 12.4): the same ball chain (ballProbabilities),
 * CPU sides picking bowlers and orders the same way, rain only when asked for, at the fitted rates. The user's batting
 * approach moves scoring relative to that level. Every match is seeded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatchState, setAggression, simulateRemaining, type MatchState } from "../live-match.js";
import { simulateMatch } from "../match.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { setRuleOverrides } from "../delivery-rules.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";
import { matchXiOptions } from "../xi-selection.js";

vi.setConfig({ testTimeout: 240000 });

const RULES: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };

function iplTeams(): Team[] {
  const teams = IPL_TEAMS.map(c => new Team(c, RULES.salaryCap));
  for (const d of getRealPlayers()) {
    const team = teams.find(t => t.id === d.teamId);
    if (team) team.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
  }
  return teams;
}

const pairing = (teams: Team[], i: number): [Team, Team] => {
  const a = teams[i % teams.length];
  const b = teams[(i * 3 + 1) % teams.length];
  return [a, b === a ? teams[(i + 1) % teams.length] : b];
};

interface Level { runs: number; wkts: number; sixes: number; pp: number; legal: number; inns: number }
const level = (): Level => ({ runs: 0, wkts: 0, sixes: 0, pp: 0, legal: 0, inns: 0 });
function addInnings(l: Level, inn: { runs: number; wickets: number; sixes: number; totalBalls: number; ballLog: Array<{ over: number; runs: number; extras: number }> }) {
  l.inns++; l.runs += inn.runs; l.wkts += inn.wickets; l.sixes += inn.sixes; l.legal += inn.totalBalls;
  l.pp += inn.ballLog.filter(b => b.over < 6).reduce((s, b) => s + b.runs + b.extras, 0);
}
const runRate = (l: Level) => (6 * l.runs) / l.legal;
const per = (l: Level, k: keyof Omit<Level, "inns">) => l[k] / l.inns;
const liveInnings = (s: MatchState) => [s._internal.innings1Raw, s._internal.currentInningsRaw].filter(Boolean) as NonNullable<MatchState["_internal"]["innings1Raw"]>[];

afterEach(() => setRuleOverrides(null));

describe("live T20 level", () => {
  const N = 60;

  it("CPU v CPU plays at the instant engine's level for the same squads (runs, wickets, sixes, powerplay)", () => {
    const instant = level(), live = level();
    for (let i = 0; i < N; i++) {
      const [h, a] = pairing(iplTeams(), i);
      for (const inn of simulateMatch(h, a, RULES, 900 + i, { countTowardStandings: false }).innings) addInnings(instant, inn);
      const [h2, a2] = pairing(iplTeams(), i);
      for (const inn of liveInnings(simulateRemaining(createMatchState(h2, a2, RULES, null, 900 + i)).state)) addInnings(live, inn);
    }
    // the old live calibration scored about 245 an innings with 15 sixes against the instant engine's 170 and 8
    expect(per(live, "runs") / per(instant, "runs")).toBeGreaterThan(0.94);
    expect(per(live, "runs") / per(instant, "runs")).toBeLessThan(1.06);
    expect(Math.abs(per(live, "wkts") / per(instant, "wkts") - 1)).toBeLessThan(0.08);
    expect(Math.abs(per(live, "sixes") / per(instant, "sixes") - 1)).toBeLessThan(0.15);
    expect(Math.abs(per(live, "pp") / per(instant, "pp") - 1)).toBeLessThan(0.08);
  });

  it("the batting approach stays relative to that level: DEF scores slower and loses fewer wickets, ATK the reverse", () => {
    const sides: Record<number, Level> = { 20: level(), 50: level(), 80: level() };
    for (const aggr of [20, 50, 80]) {
      for (let i = 0; i < N; i++) {
        const [h, a] = pairing(iplTeams(), i);
        let s = createMatchState(h, a, RULES, null, 1500 + i);
        s = setAggression(s, h.id, aggr);
        const done = simulateRemaining(s).state;
        for (const inn of liveInnings(done)) if (inn.teamId === h.id) addInnings(sides[aggr], inn);
      }
    }
    expect(runRate(sides[20])).toBeLessThan(runRate(sides[50]));
    expect(runRate(sides[80])).toBeGreaterThan(runRate(sides[50]));
    expect(per(sides[20], "wkts")).toBeLessThan(per(sides[50], "wkts"));
    expect(per(sides[80], "wkts")).toBeGreaterThan(per(sides[50], "wkts"));
    // a lever on the calibrated level, not a different game: totals within a tenth of the balanced side's either way
    for (const a of [20, 80]) expect(Math.abs(per(sides[a], "runs") / per(sides[50], "runs") - 1)).toBeLessThan(0.1);
  });

  it("a CPU side opens with a bowler of its attack (the captain's fitted choice, pace first) and never plans phases for itself", () => {
    let paceOpeners = 0;
    for (let i = 0; i < 40; i++) {
      const [h, a] = pairing(iplTeams(), i);
      const s = createMatchState(h, a, RULES, null, 2100 + i);
      const bowling = s.bowlingTeamId === h.id ? h : a;
      // the eleven the side takes the field with: the XI it drew for this match (xi-selection.ts: seeded by the match and the side), with its
      // impact sub for a batter when it fields first (impact-player.ts, docs/TACTICS.md section 9)
      const drawn = bowling.getPlayingXI(RULES.maxOverseasInXI, matchXiOptions(RULES, 2100 + i, bowling === h ? 0 : 1));
      const fieldIds = s.bowlingTeamId === s.homeTeam.id ? s._internal.homeXIIds : s._internal.awayXIIds;
      const field = bowling.roster.filter(p => fieldIds.includes(p.id));
      expect(field.filter(p => !drawn.includes(p)).length).toBeLessThanOrEqual(1);
      // the IPL plays the attack table (section 8): the opener is any of the eleven it may choose (keepers apart)
      const attack = field.filter(p => !p.isWicketKeeper || p.role === "all-rounder").map(p => p.id);
      const opener = s._internal.bowlingOrderIds[s.currentBowlerIdx];
      expect(attack).toContain(opener);
      if (["right-arm-fast", "right-arm-fast-medium", "right-arm-medium-fast", "right-arm-medium", "left-arm-fast", "left-arm-fast-medium", "left-arm-medium-fast", "left-arm-medium"].includes(s._internal.playerDataMap[opener].bowlingStyle)) paceOpeners++;
      expect(s._internal.homeBowlingPlan).toBeUndefined();
      expect(s._internal.awayBowlingPlan).toBeUndefined();
    }
    // real T20 captains open with pace about three times in four (a spinner opens a quarter of the time; the former rule: any of the best three)
    expect(paceOpeners).toBeGreaterThan(20);
  });
});

describe("live T20 rain", () => {
  it("no rain unless asked for (as in simulateMatch)", () => {
    for (let i = 0; i < 30; i++) {
      const [h, a] = pairing(iplTeams(), i);
      const { state } = simulateRemaining(createMatchState(h, a, RULES, null, 3000 + i));
      expect(state.maxOvers).toBe(20);
      expect(state.result).not.toMatch(/rain|abandoned/i);
    }
  });

  it("with the rain option: the fitted plan cuts the match and the chase gets a DLS target", () => {
    setRuleOverrides({ rainReduced: 1, rainNoResult: 0 });
    let cut = 0;
    for (let i = 0; i < 16; i++) {
      const [h, a] = pairing(iplTeams(), i);
      const { state } = simulateRemaining(createMatchState(h, a, RULES, null, 3500 + i, { rain: true }));
      expect(state.status).toBe("completed");
      const plan = state._internal.rainPlan!;
      expect(plan.kind).toBe("reduced");
      if (state.maxOvers < 20) {
        cut++;
        expect(state.maxOvers).toBeGreaterThanOrEqual(5);
        expect(state._internal.maxOversPerBowler).toBe(Math.ceil(state.maxOvers / 5));
      }
    }
    expect(cut).toBeGreaterThan(8);
    setRuleOverrides({ rainReduced: 0, rainNoResult: 1 });
    for (let i = 0; i < 6; i++) {
      const [h, a] = pairing(iplTeams(), i);
      const { state } = simulateRemaining(createMatchState(h, a, RULES, null, 3700 + i, { rain: true }));
      expect(state.result).toBe("No result (rain)");
      expect(state.winnerId).toBeFalsy();
    }
  });
});
