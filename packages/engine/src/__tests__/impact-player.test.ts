/**
 * The fitted Impact Player (impact-player.ts; docs/TACTICS.md section 9): the plan is legal and repeatable, the instant engine fields
 * the eleven the plan says in each innings (the side batting first with its bowler from the break, the side fielding first with its
 * bowler from the start and its batter in the chase), the live engine plays the same subs for its CPU sides, the user's own sub
 * still works in the live engine, and IMPACT_MODEL.off brings back the former subs.
 */
import { describe, expect, it } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player, type PlayerData } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { simulateMatch } from "../match.js";
import { IMPACT_MODEL, midImpactNow, planImpact } from "../impact-player.js";
import { applyImpactSub, createMatchState, getImpactSubOptions, simulateRemaining, startSecondInnings, stepBall, autoResolveDecision, type MatchState } from "../live-match.js";

let n = 0;
function mk(role: PlayerData["role"], bat: number, bowl: number, extra: Partial<PlayerData> = {}): Player {
  return new Player({
    id: `ip${++n}`, name: `IP${n}`, age: 26, country: "India", role,
    ratings: { battingIQ: bat, timing: bat, power: bat, running: 60, wicketTaking: bowl, economy: bowl, accuracy: bowl, clutch: 55, fielding: 50 },
    isInternational: false, injured: false, injuryGamesLeft: 0, ...extra,
  });
}

/** A squad of 18: two keepers, six batters, four all-rounders, six bowlers; six overseas */
function squad(k: number): Team {
  const t = new Team(IPL_TEAMS[k]);
  t.addPlayer(mk("batsman", 76, 20, { isWicketKeeper: true }), 1);
  t.addPlayer(mk("batsman", 64, 20, { isWicketKeeper: true, isInternational: true }), 1);
  [84, 81, 79, 74, 70, 66].forEach((b, i) => t.addPlayer(mk("batsman", b, 30, { isInternational: i < 2 }), 1));
  [72, 66, 60, 55].forEach((b, i) => t.addPlayer(mk("all-rounder", b, 70 - i * 3, { isInternational: i === 0 }), 1));
  [86, 82, 79, 75, 71, 68].forEach((w, i) => t.addPlayer(mk("bowler", 30 - i, w, { isInternational: i < 2 }), 1));
  return t;
}
const rules = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };

describe("impact player plan", () => {
  it("is legal and repeatable", () => {
    const t = squad(0);
    const xi = t.getPlayingXI(4);
    const order = t.getBattingOrder(xi);
    for (const batFirst of [true, false]) {
      for (let s = 0; s < 30; s++) {
        const p = planImpact(order, t.roster, batFirst, 4, s);
        expect(planImpact(order, t.roster, batFirst, 4, s).x?.id).toBe(p.x?.id);
        expect(p.bench.length).toBeLessThanOrEqual(5);
        if (!p.use) continue;
        expect(xi).toContain(p.x);
        expect(p.x!.isWicketKeeper).toBe(false);
        expect(xi).not.toContain(p.yBowl);
        expect(p.bench).toContain(p.yBowl);
        const field = xi.map(q => (q === p.x ? p.yBowl! : q));
        expect(field.filter(q => q.isInternational).length).toBeLessThanOrEqual(4);
        // the bowling sub is the best bowler on the bench
        const legal = t.roster.filter(q => !xi.includes(q) && (!q.isInternational || field.filter(f => f.isInternational).length <= 4));
        expect(p.yBowl!.bowlingOvr).toBe(Math.max(...legal.map(q => q.bowlingOvr)));
      }
    }
  });

  it("brings a batter in batting first only late in a collapse", () => {
    const t = squad(1);
    const xi = t.getBattingOrder(t.getPlayingXI(4));
    let early = 0, late = 0;
    for (let s = 0; s < 400; s++) {
      const p = planImpact(xi, t.roster, true, 4, s);
      if (!p.use) continue;
      if (midImpactNow(p, 2, 4, xi.slice(0, 2), xi, 4)) early++;
      const sub = midImpactNow(p, 6, 13, xi.slice(0, 6), xi, 4);
      if (sub) { late++; expect(xi.slice(0, 6)).toContain(sub.subOut); expect(sub.subIn).toBe(p.yMid); }
    }
    expect(early).toBeLessThan(20);
    expect(late).toBeGreaterThan(100);
  });
});

describe("impact player in the instant engine", () => {
  it("fields the planned elevens", { timeout: 120_000 }, () => {
    let checked = 0;
    for (let s = 1; s <= 30; s++) {
      const home = squad(2), away = squad(3);
      const r = simulateMatch(home, away, rules, s);
      const [i1, i2] = r.innings;
      const subs = [...(i1.impactSubs ?? []), ...(i2.impactSubs ?? [])];
      expect(subs.length).toBeLessThanOrEqual(2);
      const bowled = (inn: typeof i1) => [...inn.bowlerStats.keys()];
      for (const sub of i2.impactSubs ?? []) {
        if (sub.side === "bowling") {
          // the side batting first: its bowler on at the break, the batter he replaced does not bowl
          expect(bowled(i2)).not.toContain(sub.subOut);
          expect(i1.batterStats.has(sub.subOut)).toBe(true);
          checked++;
        } else {
          // the side fielding first: the batter bats in the chase, the bowler he replaced bowled in the first innings and does not bat
          expect(i2.batterStats.has(sub.subIn)).toBe(true);
          expect(i2.batterStats.has(sub.subOut)).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("IMPACT_MODEL.off plays the former subs", () => {
    IMPACT_MODEL.off = true;
    try {
      const r = simulateMatch(squad(4), squad(5), rules, 7);
      expect(r.innings.every(inn => inn.impactSubs === undefined)).toBe(true);
    } finally { IMPACT_MODEL.off = false; }
  });
});

function playTo(state: MatchState, until: (s: MatchState) => boolean): MatchState {
  let s = state;
  for (let k = 0; k < 2000 && !until(s); k++) {
    if (s.status === "waiting_for_decision") s = autoResolveDecision(s);
    else if (s.status === "in_progress") s = stepBall(s).state;
    else break;
  }
  return s;
}

describe("impact player in the live engine", () => {
  it("a CPU side plays the same subs as in the instant engine", { timeout: 300_000 }, () => {
    let swaps = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const home = squad(6), away = squad(7);
      const st = createMatchState(home, away, rules, null, seed);
      const ni = st._internal;
      const ch = ni.bowlingFirstId, bf = ni.battingFirstId;
      const chHome = ch === st.homeTeam.id;
      const plan = ni.impactPlans?.[ch]?.ch;
      const fieldIds = chHome ? ni.homeXIIds : ni.awayXIIds;
      if (plan?.use && plan.x && plan.yBowl) {
        expect(fieldIds).toContain(plan.yBowl);
        expect(fieldIds).not.toContain(plan.x);
        swaps++;
      }
      const brk = playTo(st, s => s.status === "innings_break" || s.status === "completed");
      if (brk.status !== "innings_break") continue;
      const s2 = startSecondInnings(brk);
      const n2 = s2._internal;
      if (plan?.use && plan.x && plan.yBowl) {
        const ids = chHome ? n2.homeXIIds : n2.awayXIIds;
        expect(ids).toContain(plan.x);
        expect(ids).not.toContain(plan.yBowl);
      }
      const bfPlan = n2.impactPlans?.[bf]?.bf;
      const bfIds = bf === s2.homeTeam.id ? n2.homeXIIds : n2.awayXIIds;
      if (bfPlan?.use && bfPlan.yBowl && !brk._internal.homeXIIds.concat(brk._internal.awayXIIds).includes(bfPlan.yMid ?? "")) {
        expect(bfIds).toContain(bfPlan.yBowl);
        expect(bfIds).not.toContain(bfPlan.x);
      }
      const done = simulateRemaining(s2).state;
      expect(done.status).toBe("completed");
    }
    expect(swaps).toBeGreaterThan(10);
  });

  it("the user's own impact sub still works, and the CPU does not touch the user's side", { timeout: 120_000 }, () => {
    const home = squad(8), away = squad(9);
    let st = createMatchState(home, away, rules, home.id, 5);
    st = playTo(st, s => s.status === "innings_break" || s.status === "completed");
    expect(st.status).toBe("innings_break");
    expect(st._internal.impactPlans?.[home.id]).toBeUndefined();
    const opts = getImpactSubOptions(st, home.id);
    expect(opts).not.toBeNull();
    const subIn = opts!.benchPlayers[0].playerId, subOut = opts!.suggestedSwapOutId ?? opts!.xiPlayers[1].playerId;
    st = applyImpactSub(st, home.id, subIn, subOut);
    expect(st.status).toBe("innings_break"); // the break goes on: the user starts the second innings
    expect(st._internal.homeXIIds).toContain(subIn);
    expect(st._internal.homeXIIds).not.toContain(subOut);
    expect(st.impactSubUsed.home).toBe(true);
    expect(getImpactSubOptions(st, home.id)).toBeNull();
    st = startSecondInnings(st);
    expect(st._internal.homeXIIds).toContain(subIn);
    expect(simulateRemaining(st).state.status).toBe("completed");
  });
});
