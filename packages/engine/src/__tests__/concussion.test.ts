/**
 * Concussion substitutes and the in-match injuries' link to the post-match injury model (in-match-injury.ts), in the instant
 * engine (match.ts), the live engine (live-match.ts, with the user's choice of replacement) and the Test engine (test-match.ts).
 * docs/RULES-MATCH.md section 13.9.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { simulateMatch, type InningsScore } from "../match.js";
import {
  applyDecision, autoResolveDecision, buildDetailedResultFromState, createMatchState, deserializeMatchState, serializeMatchState,
  simulateRemaining, startSecondInnings, stepBall, type MatchState,
} from "../live-match.js";
import { simulateTestMatch } from "../test-match.js";
import { applyLiveResult, type ScheduledMatch } from "../schedule.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { setRuleOverrides } from "../delivery-rules.js";
import { isLikeForLikeReplacement } from "../ball-outcomes.js";
import { concussionSubOptions, inMatchInjuryStatus, type InMatchInjury } from "../in-match-injury.js";
import { IN_MATCH_INJURY_DATA as D } from "../in-match-injury-data.js";
import { createRNG } from "../rng.js";

vi.setConfig({ testTimeout: 240000 });
afterEach(() => setRuleOverrides(null));

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

/** 18 players: two keepers, five batters, five all-rounders, six bowlers (an XI and a bench of seven) */
function squad(team: Team, idx: number): void {
  let n = idx * 100;
  team.addPlayer(player(`wk_${++n}`, "batsman", false, true), 1);
  team.addPlayer(player(`wk_${++n}`, "batsman", false, true), 1);
  for (let i = 0; i < 5; i++) team.addPlayer(player(`bat_${++n}`, "batsman", i === 0), 1);
  for (let i = 0; i < 5; i++) team.addPlayer(player(`ar_${++n}`, "all-rounder", i === 0, false, i % 2 ? "off-spin" : "right-arm-medium-fast"), 1);
  const styles = ["right-arm-fast", "left-arm-fast", "leg-spin", "left-arm-orthodox", "right-arm-medium", "off-spin"];
  for (let i = 0; i < 6; i++) team.addPlayer(player(`bow_${++n}`, "bowler", false, false, styles[i]), 1);
}

function pair(i: number): [Team, Team] {
  const a = new Team(IPL_TEAMS[i % 5], 120);
  const b = new Team(IPL_TEAMS[(i % 5) + 1], 120);
  squad(a, i % 5);
  squad(b, (i % 5) + 1);
  return [a, b];
}

const rules: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };
const roleOf = (teams: Team[], id: string) => teams.flatMap(t => t.roster).find(p => p.id === id)!.role;
const concussions = (inns: readonly InningsScore[]) => inns.flatMap(i => i.inMatchInjuries ?? []).filter(e => e.kind === "concussion");
const oversBy = (inn: InningsScore, id: string) => new Set(inn.ballLog.filter(b => b.bowler === id && !b.deadBall).map(b => b.over)).size;

describe("concussion substitutes: the instant engine", () => {
  it("draws off the match's own random stream: a seed without a concussion plays exactly as with none", () => {
    let compared = 0;
    for (let s = 1; s <= 30; s++) {
      setRuleOverrides({ concussionPerBall: 0 });
      const a = simulateMatch(...pair(s), rules, 400 + s, { countTowardStandings: false });
      setRuleOverrides({ concussionPerBall: 0.0004 });
      const b = simulateMatch(...pair(s), rules, 400 + s, { countTowardStandings: false });
      if (concussions(b.innings).length > 0) continue;
      compared++;
      expect(b.innings.map(i => [i.runs, i.wickets, i.ballLog.length])).toEqual(a.innings.map(i => [i.runs, i.wickets, i.ballLog.length]));
      expect(b.innings[1].ballLog.map(x => x.commentary)).toEqual(a.innings[1].ballLog.map(x => x.commentary));
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("a batter concussed at the crease is replaced like for like: not out, not a wicket, the sub bats in his place", () => {
    setRuleOverrides({ concussionPerBall: 0.01, concussionBattingShare: 1, retiredOutPerInning: 0 });
    let seen = 0;
    for (let s = 1; s <= 20; s++) {
      const teams = pair(s);
      const r = simulateMatch(teams[0], teams[1], rules, 700 + s, { countTowardStandings: false });
      for (const [k, inn] of r.innings.entries()) {
        const evs = (inn.inMatchInjuries ?? []).filter(e => e.kind === "concussion");
        for (const e of evs) {
          seen++;
          expect(e.side).toBe("batting");
          const st = inn.batterStats.get(e.playerId)!;
          expect(st.concussed).toBe(true);
          expect(st.isOut).toBe(false);
          if (!e.subId) continue;
          expect(isLikeForLikeReplacement(roleOf(teams, e.playerId), roleOf(teams, e.subId))).toBe(true);
          expect(inn.batterStats.has(e.subId)).toBe(true);
          const card = k === 0 ? r.detailed!.innings1 : r.detailed!.innings2;
          expect(card.notes).toContain(`${e.playerName} replaced by ${e.subName} (concussion sub)`);
          const row = card.batters.findIndex(b => b.playerId === e.playerId);
          expect(card.batters[row].howOut).toBe("retired hurt");
          expect(inn.ballLog.some(b => b.commentary.includes("concussion substitute"))).toBe(true);
        }
        // a concussion is never a wicket: every wicket is a batter out
        expect([...inn.batterStats.values()].filter(b => b.isOut).length).toBe(inn.wickets);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("a fielder's sub bowls the rest of the quota only when he replaced a bowling option, and plays on in the next innings", () => {
    setRuleOverrides({ concussionPerBall: 0.004, concussionBattingShare: 0 });
    let bowlerSubs = 0, batterSubs = 0;
    for (let s = 1; s <= 30; s++) {
      const teams = pair(s);
      const r = simulateMatch(teams[0], teams[1], rules, 900 + s, { countTowardStandings: false });
      for (const e of concussions(r.innings)) {
        if (!e.subId) continue;
        const inn = r.innings[e.innings - 1];
        const roleX = roleOf(teams, e.playerId);
        expect(e.side).toBe("fielding");
        if (roleX === "bowler" || roleX === "all-rounder") {
          bowlerSubs++;
          expect(oversBy(inn, e.playerId) + oversBy(inn, e.subId)).toBeLessThanOrEqual(4);
        } else if (oversBy(inn, e.playerId) === 0) {
          batterSubs++;
          expect(oversBy(inn, e.subId)).toBe(0);
          if (e.innings === 1) expect(oversBy(r.innings[1], e.subId)).toBe(0);
        }
        // the side batting second: its fielder's substitute bats in the chase in his place (unless the concussed fielder was the
        // impact bowler its batter X replaces in the chase anyway)
        if (e.innings === 1 && !(r.innings[1].impactSubs ?? []).some(x => x.subOut === e.playerId)) {
          expect(r.innings[1].batterStats.has(e.subId)).toBe(true);
          expect(r.innings[1].batterStats.has(e.playerId)).toBe(false);
        }
      }
    }
    expect(bowlerSubs).toBeGreaterThan(3);
    expect(batterSubs).toBeGreaterThan(0);
  });

  it("the concussed player misses the measured matches; the in-match injuries are in the result's injuries", () => {
    setRuleOverrides({ concussionPerBall: 0.004, hurtPerBatterBall: 0.002 });
    const on = { ...rules, injuriesEnabled: true };
    let n = 0, out = 0;
    for (let s = 1; s <= 15; s++) {
      const teams = pair(s);
      const r = simulateMatch(teams[0], teams[1], on, 1200 + s, { countTowardStandings: false });
      const hurt = r.innings.flatMap(i => i.inMatchInjuries ?? []);
      for (const e of hurt) {
        const inj = r.injuries.find(i => i.playerId === e.playerId);
        expect(inj, `${e.kind} of ${e.playerName} in the injuries`).toBeDefined();
        expect(inj!.inMatch).toBeDefined();
        const p = teams.flatMap(t => t.roster).find(x => x.id === e.playerId)!;
        if (inj!.injury.matchesRemaining > 0) { out++; expect(p.injured).toBe(true); }
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
    expect(out).toBeGreaterThan(5);
  });
});

describe("what an in-match injury costs after the match", () => {
  it("follows the measured return intervals", () => {
    const rng = createRNG(5);
    const N = 40000;
    const conc = Array.from({ length: N }, () => inMatchInjuryStatus("concussion", "T20", rng).matchesRemaining);
    const tot = D.concussion.missed.reduce((a, b) => a + b, 0);
    expect(conc.filter(m => m === 0).length / N).toBeCloseTo(D.concussion.missed[0] / tot, 1);
    expect(conc.filter(m => m === 1).length / N).toBeCloseTo(D.concussion.missed[1] / tot, 1);
    const hurt = Array.from({ length: N }, () => inMatchInjuryStatus("retired_hurt", "T20", rng));
    expect(hurt.filter(h => h.matchesRemaining > 0).length / N).toBeCloseTo(D.retiredHurt.missProb.T20, 1);
    expect(hurt.every(h => h.isInjured === h.matchesRemaining > 0)).toBe(true);
    const bd = Array.from({ length: N }, () => inMatchInjuryStatus("bowler_breakdown", "ODI", rng));
    expect(bd.filter(h => h.matchesRemaining > 0).length / N).toBeCloseTo(D.bowlerBreakdown.missProb, 1);
  });
});

describe("the referee's like-for-like choice", () => {
  const c = (id: string, role: string, o: Partial<{ wk: boolean; intl: boolean; bat: number; bowl: number; style: string }> = {}) => ({
    id, role, isWicketKeeper: !!o.wk, isInternational: !!o.intl, battingOvr: o.bat ?? 50, bowlingOvr: o.bowl ?? 50, overall: 50, bowlingStyle: o.style,
  });
  it("keeper for the keeper, spinner for a spinner, no specialist bowler for a batter, the overseas limit", () => {
    const bench = [c("b1", "batsman", { bat: 70 }), c("k1", "batsman", { wk: true, bat: 55 }), c("s1", "bowler", { bowl: 60, style: "off-spin" }),
      c("p1", "bowler", { bowl: 70, style: "right-arm-fast" }), c("o1", "batsman", { intl: true, bat: 90 })];
    expect(concussionSubOptions(c("x", "batsman", { wk: true }), bench, { keeping: true })[0].id).toBe("k1");
    expect(concussionSubOptions(c("x", "bowler", { style: "leg-spin" }), bench)[0].id).toBe("s1");
    expect(concussionSubOptions(c("x", "batsman"), bench).map(p => p.id)).not.toContain("p1");
    expect(concussionSubOptions(c("x", "batsman"), bench, { overseasOnField: 4, maxOverseas: 4 }).map(p => p.id)).not.toContain("o1");
    expect(concussionSubOptions(c("x", "batsman", { intl: true }), bench, { overseasOnField: 4, maxOverseas: 4 })[0].id).toBe("o1");
  });
});

describe("concussion substitutes: the live engine", () => {
  /** Play a live match with the user on `teams[0]`; `pick` answers the user's concussion decisions */
  function playLive(seed: number, pick: (s: MatchState) => string, prepare?: (s: MatchState) => MatchState) {
    const teams = pair(seed);
    let st = createMatchState(teams[0], teams[1], rules, teams[0].id, seed);
    if (prepare) st = prepare(st);
    const asked: MatchState[] = [];
    for (let g = 0; g < 4000 && st.status !== "completed"; g++) {
      if (st.status === "waiting_for_decision") {
        if (st.pendingDecision?.type === "concussion_sub") { asked.push(st); st = applyDecision(st, { type: "concussion_sub", selectedPlayerId: pick(st) }); }
        else st = autoResolveDecision(st);
      } else if (st.status === "innings_break") st = startSecondInnings(st);
      else st = stepBall(st).state;
    }
    return { st, asked, teams };
  }

  it("asks the user for the replacement on his side; his pick takes the concussed player's place", () => {
    setRuleOverrides({ concussionPerBall: 0.006 });
    let checked = 0;
    for (let s = 1; s <= 6 && checked < 3; s++) {
      const { st, asked, teams } = playLive(300 + s, x => x.pendingDecision!.options.at(-1)!);
      expect(st.status).toBe("completed");
      for (const q of asked) {
        const p = q.pendingDecision!;
        expect(p.teamId).toBe(teams[0].id);
        expect(p.options.length).toBeGreaterThan(1);
        const xRole = roleOf(teams, p.concussion!.playerId);
        for (const id of p.options) expect(isLikeForLikeReplacement(xRole, roleOf(teams, id))).toBe(true);
        const ev = st.inMatchInjuries!.find(e => e.kind === "concussion" && e.playerId === p.concussion!.playerId)!;
        expect(ev.subId).toBe(p.options.at(-1));
        const xi = st.homeTeam.id === teams[0].id ? st._internal.homeXIIds : st._internal.awayXIIds;
        expect(xi).toContain(ev.subId);
        expect(xi).not.toContain(ev.playerId);
        checked++;
      }
      const d = buildDetailedResultFromState(st);
      const notes = [...(d.innings1.notes ?? []), ...(d.innings2.notes ?? [])];
      expect(notes.length).toBe(st.inMatchInjuries!.filter(e => e.kind === "concussion").length);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a batting sub comes straight to the crease; the season result links the injuries", () => {
    setRuleOverrides({ concussionPerBall: 0.008, concussionBattingShare: 1 });
    const { st, asked, teams } = playLive(41, x => x.pendingDecision!.options[0]);
    expect(asked.length).toBeGreaterThan(0);
    const q = asked[0];
    const after = applyDecision(q, { type: "concussion_sub", selectedPlayerId: q.pendingDecision!.options[0] });
    const subName = after.inMatchInjuries!.at(-1)!.subName!;
    expect([after.strikerName, after.nonStrikerName]).toContain(subName);
    expect(after.batterStats.find(b => b.playerId === q.pendingDecision!.concussion!.playerId)!.concussed).toBe(true);
    const schedule: ScheduledMatch[] = [{ matchNumber: 1, homeTeamId: st.homeTeam.id, awayTeamId: st.awayTeam.id, isPlayoff: false, type: "group" }];
    const result = applyLiveResult(schedule, 0, teams, st, { ...rules, injuriesEnabled: true });
    for (const e of st.inMatchInjuries!) expect(result.injuries.some(i => i.playerId === e.playerId && i.inMatch === e.kind)).toBe(true);
  });

  it("a live match saved before concussion substitutes still loads and plays out (none happen in it)", () => {
    setRuleOverrides({ concussionPerBall: 0.02 });
    const [a, b] = pair(3);
    let st = createMatchState(a, b, rules, null, 77);
    for (let i = 0; i < 30; i++) st = stepBall(st).state;
    const old = serializeMatchState(st) as any;
    delete old._internal.squadIds; delete old._internal.inMatchIds; delete old.inMatchInjuries;
    const loaded = deserializeMatchState(JSON.parse(JSON.stringify(old)));
    const done = simulateRemaining(loaded).state;
    expect(done.status).toBe("completed");
    expect((done.inMatchInjuries ?? []).filter((e: InMatchInjury) => e.kind === "concussion")).toEqual([]);
  });
});

describe("concussion substitutes: the Test engine", () => {
  it("replaces the concussed player for the rest of the match, notes it, and links the injury", () => {
    setRuleOverrides({ concussionPerBall: 0.0015 });
    let seen = 0;
    for (let s = 1; s <= 3; s++) {
      const [a, b] = pair(s);
      const r = simulateTestMatch(a, b, { seed: 50 + s, injuries: true });
      const evs = (r.state.inMatchInjuries ?? []).filter(e => e.kind === "concussion");
      for (const e of evs) {
        seen++;
        if (!e.subId) continue;
        const team = r.state.teams[e.teamId];
        expect(team.xi).toContain(e.subId);
        expect(team.xi).not.toContain(e.playerId);
        expect(r.scorecards[e.innings - 1].notes).toContain(`${e.playerName} replaced by ${e.subName} (concussion sub)`);
        expect(r.injuries.some(i => i.playerId === e.playerId && i.inMatch === "concussion")).toBe(true);
        expect(r.events.some(x => x.kind === "concussion" && x.text.includes(e.subName!))).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(2);
  });
});
