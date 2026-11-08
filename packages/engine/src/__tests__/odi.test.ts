/**
 * The ODI format (docs/FORMATS.md): the format spec, the fitted ball model, the rules in both engines (50 overs, ten overs
 * a bowler and never two in a row, no Impact Player or timeouts, DLS over 50-over resources, a tie that stands unless the
 * competition plays a super over), user decisions in a live ODI, and seeded statistical checks. All seeded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { simulateMatch, type InningsScore, type MatchResult } from "../match.js";
import { applyDecision, createMatchState, simulateRemaining, startSecondInnings, stepBall, autoResolveDecision } from "../live-match.js";
import { RULE_PRESETS, odiRules, type RuleSet } from "../rules.js";
import { setRuleOverrides } from "../delivery-rules.js";
import { ODI_FORMAT, T20_FORMAT, ballAgeOvers, matchFormatFor, maxFieldersOutside, phaseOver } from "../format.js";
import { dlsGFor, dlsTarget, inningsResources, resourcesPct, odiRevisedTarget, DLS_G_ODI } from "../dls.js";
import { ODI_OUTCOMES, odiBallProbabilities, odiBowlerChoices, odiContextWeights, odiTableOver } from "../odi-model.js";
import { ODI_MODEL_DATA, ODI_RAIN } from "../odi-model-data.js";
import { getOdiVenueProfile } from "../venues.js";
import { createPlayerFromData } from "../create-player.js";
import { ALL_PLAYERS } from "../../../ratings/src/all-players.js";
import { attachFormatRatings, type FormatRatingsFile } from "../../../ratings/src/format-ratings.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 240000 });

function player(id: string, role: "batsman" | "bowler" | "all-rounder", wk = false, style?: string, odi?: Partial<Player["ratings"]>): Player {
  const bat = role === "batsman";
  const bowl = role === "bowler";
  const ratings = {
    battingIQ: bat ? 68 : bowl ? 25 : 54, timing: bat ? 66 : bowl ? 25 : 50, power: bat ? 64 : bowl ? 20 : 50,
    running: bat ? 58 : 40, wicketTaking: bowl ? 68 : bat ? 20 : 54, economy: bowl ? 66 : bat ? 20 : 54,
    accuracy: bowl ? 64 : bat ? 20 : 50, clutch: 50,
  };
  return new Player({
    id, name: `Player ${id}`, age: 26, country: "India", role, ratings,
    ...(odi ? { formatRatings: { odi: { ratings: { ...ratings, ...odi } } } } : {}),
    isInternational: false, isWicketKeeper: wk, injured: false, injuryGamesLeft: 0,
    bowlingStyle: (style ?? (bowl || role === "all-rounder" ? "right-arm-medium-fast" : undefined)) as Player["bowlingStyle"],
    battingHand: "right",
  });
}

/** Six batters (one keeper), two all-rounders, three bowlers in the XI: exactly five bowling options for 50 overs */
function squad(team: Team, idx: number, strength = 0): void {
  let n = idx * 100;
  const up = (r: number) => Math.max(15, Math.min(99, r + strength));
  const lift = strength ? { battingIQ: up(68), timing: up(66), power: up(64), wicketTaking: up(66), economy: up(64), accuracy: up(62) } : undefined;
  team.addPlayer(player(`wk_${++n}`, "batsman", true, undefined, lift), 1);
  for (let i = 0; i < 5; i++) team.addPlayer(player(`bat_${++n}`, "batsman", false, undefined, lift), 1);
  for (let i = 0; i < 2; i++) team.addPlayer(player(`ar_${++n}`, "all-rounder", false, i ? "off-spin" : "right-arm-medium-fast", lift), 1);
  for (const st of ["right-arm-fast", "left-arm-fast", "leg-spin"]) team.addPlayer(player(`bow_${++n}`, "bowler", false, st, lift), 1);
}

function makeTeams(n = 4): Team[] {
  return IPL_TEAMS.slice(0, n).map((c, i) => {
    // national sides have no franchise ground
    const t = new Team({ ...c, stadiumName: undefined, pitchType: undefined, boundarySize: undefined, dewFactor: undefined }, 120);
    squad(t, i);
    return t;
  });
}

const men: RuleSet = odiRules("men", { ...RULE_PRESETS.modern2026, injuriesEnabled: false });
const women: RuleSet = odiRules("women", { ...RULE_PRESETS.modern2026, injuriesEnabled: false });

function play(n: number, opts: { rules?: RuleSet; pool?: Team[]; seed?: number; rain?: boolean; superOver?: boolean } = {}): MatchResult[] {
  const pool = opts.pool ?? makeTeams();
  const out: MatchResult[] = [];
  for (let i = 0; i < n; i++) {
    const a = pool[i % pool.length], b = pool[(i + 1) % pool.length];
    out.push(simulateMatch(a, b, opts.rules ?? men, (opts.seed ?? 4000) + i, { countTowardStandings: false, rain: opts.rain, superOver: opts.superOver }));
  }
  return out;
}

/** Overs (0-based) -> bowler id, for overs bowled by one bowler throughout */
function oversByBowler(inn: InningsScore): Map<number, string> {
  const byOver = new Map<number, Set<string>>();
  for (const b of inn.ballLog) {
    if (b.deadBall) continue;
    (byOver.get(b.over) ?? byOver.set(b.over, new Set()).get(b.over)!).add(b.bowler);
  }
  const out = new Map<number, string>();
  for (const [o, s] of byOver) if (s.size === 1) out.set(o, [...s][0]);
  return out;
}

afterEach(() => setRuleOverrides(null));

/** Every delivery a dot and none of the rare plays that put runs on the board: both innings end level on 0 */
const ZERO_RUNS = {
  forceCoarseOutcome: "dot", drsRateFactor: 0, hurtPerBatterBall: 0, mankadPerDelivery: 0, penaltyPerDelivery: 0, overthrowBoundaryAfterDot: 0, lodgedPerDelivery: 0,
} as const;

describe("ODI format spec", () => {
  it("50 overs of six balls, ten an over per bowler, no two in a row, fielding restrictions 2 / 4 / 5", () => {
    expect(matchFormatFor({ matchFormat: "odi" })).toBe(ODI_FORMAT);
    expect(ODI_FORMAT).toMatchObject({ overs: 50, ballsPerOver: 6, maxOversPerBowler: 10, maxConsecutiveOvers: 1, totalBalls: 300, noBallPenalty: 1, minOversForResult: 20 });
    expect([0, 9, 10, 39, 40, 49].map(o => maxFieldersOutside(o, ODI_FORMAT))).toEqual([2, 2, 4, 4, 5, 5]);
    expect([0, 5, 6, 19].map(o => maxFieldersOutside(o, T20_FORMAT))).toEqual([2, 2, 5, 5]);
    // a new ball from each end in men's ODIs: each ball has bowled about half the overs
    expect(ballAgeOvers(30, ODI_FORMAT, "male")).toBe(15);
    expect(ballAgeOvers(30, ODI_FORMAT, "female")).toBe(30);
    // the ODI's phases on the T20 timeline (live bowling plans): powerplay 1-10, middle 11-40, death 41-50
    expect(phaseOver(9, ODI_FORMAT)).toBeLessThan(6);
    expect(phaseOver(10, ODI_FORMAT)).toBe(6);
    expect(phaseOver(39, ODI_FORMAT)).toBeLessThan(15);
    expect(phaseOver(40, ODI_FORMAT)).toBe(15);
    expect(phaseOver(49, ODI_FORMAT)).toBeLessThan(20);
    expect(phaseOver(12, T20_FORMAT)).toBe(12);
  });

  it("odiRules: the ODI, no Impact Player, the fitted scoring level, no overseas limit", () => {
    expect(men).toMatchObject({ matchFormat: "odi", impactPlayer: false, scoringMultiplier: 1, gender: "men", maxOverseasInXI: 11 });
    expect(women.gender).toBe("women");
  });
});

describe("ODI ball model", () => {
  it("the fitted tables have every factor for every situation, per gender", () => {
    for (const g of ["men", "women"] as const) {
      const t = ODI_MODEL_DATA[g];
      expect(t.base).toHaveLength(ODI_OUTCOMES.length);
      expect(t.over).toHaveLength(50);
      expect(t.wickets).toHaveLength(9);
      expect(t.wickets.every(r => r.length === 6)).toBe(true);
      expect(t.set).toHaveLength(8);
      expect(t.chase).toHaveLength(4);
      expect(t.chase.every(r => r.length === 10)).toBe(true);
      expect(t.bowlerType).toHaveLength(2);
      for (const v of [t.base, ...t.over, ...t.set, ...t.era, ...t.wickets.flat(), ...t.chase.flat(), ...t.bowlerType.flat()]) {
        expect(v.every(x => Number.isFinite(x) && x > 0)).toBe(true);
      }
      // base: the average 2019+ ODI delivery, about five runs an over, a wicket every 30-40 balls
      const runs = t.base[1] + 2 * t.base[2] + 3 * t.base[3] + 4 * t.base[4] + 6 * t.base[5];
      expect(runs * 6).toBeGreaterThan(g === "men" ? 4.3 : 3.8);
      expect(runs * 6).toBeLessThan(g === "men" ? 5.6 : 5.0);
      expect(t.base[6]).toBeGreaterThan(0.022);
      expect(t.base[6]).toBeLessThan(0.04);
    }
  });

  it("what drives ODI scoring: the last ten overs, wickets in hand, a set batter, a steep chase", () => {
    const avg = { battingOvr: 60, bowlingOvr: 60, bowlingStyle: "right-arm-fast-medium" as const, ratings: { timing: 60, power: 55, wicketTaking: 62, accuracy: 62 } };
    const runsOf = (p: Record<string, number>) => p["1"] + 2 * p["2"] + 3 * p["3"] + 4 * p["4"] + 6 * p["6"];
    const ctx = { over: 25, wicketsDown: 2, batterBalls: 30, gender: "male" as const };
    const mid = odiBallProbabilities(avg, avg, ctx);
    const death = odiBallProbabilities(avg, avg, { ...ctx, over: 47 });
    expect(runsOf(death)).toBeGreaterThan(1.3 * runsOf(mid));
    expect(death.wicket).toBeGreaterThan(mid.wicket);
    // the late charge needs wickets in hand: at over 43, batters of the same quality seven down hit far fewer sixes than two down
    const twoDownLate = odiBallProbabilities(avg, avg, { ...ctx, over: 43 });
    const sevenDownLate = odiBallProbabilities(avg, avg, { ...ctx, over: 43, wicketsDown: 7 });
    expect(sevenDownLate["6"]).toBeLessThan(0.7 * twoDownLate["6"]);
    // a new batter: more dots and more wickets than a set one
    const fresh = odiBallProbabilities(avg, avg, { ...ctx, batterBalls: 0 });
    expect(fresh.dot).toBeGreaterThan(mid.dot);
    // a chase needing 9 an over at over 40 against one needing 4
    const steep = odiBallProbabilities(avg, avg, { ...ctx, over: 40, chase: { runsNeeded: 90, ballsLeft: 60 } });
    const easy = odiBallProbabilities(avg, avg, { ...ctx, over: 40, chase: { runsNeeded: 40, ballsLeft: 60 } });
    expect(runsOf(steep)).toBeGreaterThan(runsOf(easy));
    expect(steep.wicket).toBeGreaterThan(easy.wicket);
  });

  it("ratings matter: a better batter scores faster and gets out less, a better bowler the reverse", () => {
    const mk = (bat: number, bowl: number) => ({ battingOvr: bat, bowlingOvr: bowl, ratings: { timing: bat, power: bat, wicketTaking: bowl, accuracy: bowl } });
    const ctx = { over: 30, wicketsDown: 3, batterBalls: 25, gender: "male" as const };
    const good = odiBallProbabilities(mk(80, 30), mk(30, 60), ctx);
    const poor = odiBallProbabilities(mk(35, 30), mk(30, 60), ctx);
    expect(good["4"] + good["6"]).toBeGreaterThan(poor["4"] + poor["6"]);
    expect(good.wicket).toBeLessThan(poor.wicket);
    const strongBowler = odiBallProbabilities(mk(60, 30), mk(30, 85), ctx);
    const weakBowler = odiBallProbabilities(mk(60, 30), mk(30, 40), ctx);
    expect(strongBowler.wicket).toBeGreaterThan(weakBowler.wicket);
  });

  it("a rain-shortened innings plays its phases over the overs it has", () => {
    expect(odiTableOver(19, 20)).toBe(47);
    expect(odiTableOver(30, 50)).toBe(30);
    const w20 = odiContextWeights({ over: 19, wicketsDown: 2, batterBalls: 20, gender: "male", scheduledOvers: 20 }, "right-arm-fast");
    const w50 = odiContextWeights({ over: 47, wicketsDown: 2, batterBalls: 20, gender: "male" }, "right-arm-fast");
    expect(w20).toEqual(w50);
  });

  it("captaincy: five bowlers, all fifty overs needed, nobody left with a forced pair of overs", () => {
    // after 45 overs: A has 3 left, B (who bowled the last over) and E one each -> A must bowl now and every other over
    const attack = [{ id: "A", overs: 7, rating: 80 }, { id: "B", overs: 9, rating: 79 }, { id: "C", overs: 10, rating: 70 }, { id: "D", overs: 10, rating: 60 }, { id: "E", overs: 9, rating: 50 }];
    const choices = odiBowlerChoices(attack.filter(b => b.overs < 10 && b.id !== "B"), attack, 45, 50, 10);
    expect(choices.map(c => c.id)).toEqual(["A"]);
  });

  it("ODI grounds: measured ODI factors by name, none for an unknown ground", () => {
    expect(getOdiVenueProfile("Melbourne Cricket Ground", "male")?.source).toMatch(/ODI ground/);
    expect(getOdiVenueProfile("Nowhere Park", "male")).toBeNull();
    expect(getOdiVenueProfile(undefined, "male")).toBeNull();
  });
});

describe("ODI rules, instant engine", () => {
  const results = play(24);

  it("50 overs a side at most, ten overs a bowler, never two overs in a row", () => {
    for (const r of results) {
      for (const inn of r.innings) {
        expect(inn.overs).toBeLessThanOrEqual(50);
        expect(inn.totalBalls).toBeLessThanOrEqual(300);
        for (const b of inn.bowlerStats.values()) expect(b.overs * 6 + b.balls).toBeLessThanOrEqual(60);
        const by = oversByBowler(inn);
        for (const [o, id] of by) if (by.get(o + 1) !== undefined) expect(by.get(o + 1)).not.toBe(id);
      }
      // the first innings lasts 50 overs unless the side is bowled out (or left without a partner by a retirement)
      const i1 = r.innings[0];
      if (i1.wickets < 10 && !(i1.offBall ?? []).some(o => o.kind === "retired_hurt")) expect(i1.totalBalls).toBe(300);
    }
  });

  it("no Impact Player, no strategic timeouts, no tactical retirements in an ODI", () => {
    const withImpact = play(6, { rules: { ...men, impactPlayer: true } });
    for (const r of [...results, ...withImpact]) {
      for (const inn of r.innings) {
        expect(inn.impactSub).toBeUndefined();
        expect(inn.timeouts).toBeUndefined();
        expect((inn.offBall ?? []).some(o => o.kind === "retired_out")).toBe(false);
      }
    }
  });

  it("a part-bowled over still counts, and five bowlers bowl the fifty overs between them", () => {
    let fiveBowlerInnings = 0;
    for (const r of results) {
      for (const inn of r.innings) {
        if (inn.totalBalls < 300) continue;
        const used = [...inn.bowlerStats.values()].filter(b => b.overs > 0 || b.balls > 0);
        if (used.length === 5) fiveBowlerInnings++;
      }
    }
    expect(fiveBowlerInnings).toBeGreaterThan(0);
  });

  it("a tie stands in an ODI (a point each), unless the competition settles it with a super over", () => {
    setRuleOverrides({ ...ZERO_RUNS, forceOutcomeSparesSuperOver: true });
    const [a, b] = makeTeams(2);
    const tied = simulateMatch(a, b, men, 77, { countTowardStandings: true });
    expect(tied.innings[0].runs).toBe(tied.innings[1].runs);
    expect(tied.winnerId).toBeNull();
    expect(tied.margin).toBe("Tie");
    expect(tied.superOver).toBeUndefined();
    expect(tied.detailed?.result).toBe("Match tied");
    expect(a.ties).toBe(1);
    expect(b.ties).toBe(1);
    expect(a.wins + a.losses + b.wins + b.losses).toBe(0);
    const knockout = simulateMatch(a, b, men, 78, { countTowardStandings: false, superOver: true });
    expect(knockout.margin).toBe("Super Over");
    expect(knockout.winnerId).not.toBeNull();
    expect(knockout.superOver?.[0].ballLog.length).toBeGreaterThan(0);
  });

  it("DLS: 50-over resources and the ODI G", () => {
    expect(resourcesPct(50, 0, 50)).toBeCloseTo(100, 5);
    expect(resourcesPct(25, 0, 50)).toBeCloseTo(66.5, 0); // Standard Edition: 25 overs left, none down
    expect(resourcesPct(20, 5, 50)).toBeCloseTo(38.6, 0);
    expect(dlsGFor(ODI_FORMAT, "male")).toBe(DLS_G_ODI.male);
    expect(dlsGFor(ODI_FORMAT, "female")).toBe(DLS_G_ODI.female);
    // a 50-over first innings of 280; the chase loses 10 overs at 30 overs with 3 down
    const t = odiRevisedTarget(280, 100, 20, 3, 10, 245);
    const r2 = inningsResources(50, [{ oversLeft: 20, wickets: 3, oversLost: 10 }], 50);
    expect(t).toBe(dlsTarget(280, 100, r2, 245));
    expect(t).toBeLessThan(281);
    expect(t).toBeGreaterThan(200);
  });

  it("rain: a shortened ODI gets its DLS target from 50-over resources; a result needs 20 overs a side", () => {
    setRuleOverrides({ rainReduced: 1, rainNoResult: 0 });
    // every match draws a cut; it is recorded unless the innings it falls in was over before the stoppage
    const rs = play(16, { rain: true, seed: 6100 }).filter(r => r.rain);
    expect(rs.length).toBeGreaterThanOrEqual(12);
    for (const r of rs) {
      expect(r.rain?.kind).toBe("reduced");
      expect(r.rain!.overs).toBeGreaterThanOrEqual(20);
      expect(r.rain!.overs).toBeLessThan(50);
      const i1 = r.innings[0];
      // the chase lost overs: fewer resources than the side batting first had, so a target below its score + 1
      if (r.rain!.when === "secondInnings") expect(r.rain!.target!).toBeLessThanOrEqual(i1.runs + 1);
      if (r.rain!.when === "firstInnings" && r.rain!.target !== undefined) {
        // the chase knew its overs from the start: R2 = the resources of N overs, R1 = 100 less what rain took from innings 1
        expect(r.rain!.r2).toBeCloseTo(resourcesPct(r.rain!.overs, 0, 50), 0);
        expect(r.rain!.r1!).toBeLessThan(100);
      }
      // bowlers are capped at a fifth of the overs of a shortened innings
      if (r.rain!.when === "preMatch") {
        for (const inn of r.innings) for (const b of inn.bowlerStats.values()) expect(b.overs).toBeLessThanOrEqual(Math.ceil(r.rain!.overs / 5));
      }
    }
    expect(rs.some(r => r.margin.includes("DLS"))).toBe(true);
    setRuleOverrides({ rainReduced: 0, rainNoResult: 1 });
    const nr = play(8, { rain: true, seed: 6200 });
    for (const r of nr) {
      expect(r.margin).toBe("No result");
      if (r.rain!.when === "secondInnings") expect(r.innings[1].overs).toBeLessThan(20);
    }
  });

  it("players play on their ODI ratings where they have them; injuries and stats stay on the players", () => {
    const [a, b] = makeTeams(2);
    const strong = new Team({ ...IPL_TEAMS[5], stadiumName: undefined }, 120);
    squad(strong, 9, 25); // the same T20 ratings, much better ODI ratings
    let strongWins = 0;
    for (let i = 0; i < 20; i++) {
      const r = simulateMatch(strong, i % 2 ? a : b, men, 8800 + i, { countTowardStandings: false });
      if (r.winnerId === strong.id) strongWins++;
    }
    expect(strongWins).toBeGreaterThanOrEqual(15);
    expect(strong.roster.some(p => p.stats.matches > 0)).toBe(true);
    expect(strong.roster[0].ratings.battingIQ).toBe(68); // the T20 ratings are untouched
  });
});

describe("ODI scoring, seeded (synthetic squads)", () => {
  const rs = play(60, { seed: 12000 });
  const first = rs.map(r => r.innings[0]);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rr = (inns: InningsScore[], lo: number, hi: number) => {
    let runs = 0, balls = 0;
    for (const inn of inns) for (const b of inn.ballLog) {
      if (b.over < lo || b.over > hi) continue;
      runs += b.runs + b.extras;
      if (b.outcome !== "wide" && b.outcome !== "noball" && !b.deadBall) balls++;
    }
    return (6 * runs) / balls;
  };

  it("first innings in the ODI range, scoring rises at the death, wickets fall", () => {
    const avg = mean(first.map(i => i.runs));
    expect(avg).toBeGreaterThan(200);
    expect(avg).toBeLessThan(320);
    expect(rr(first, 40, 49)).toBeGreaterThan(rr(first, 10, 39) + 1.2);
    expect(rr(first, 0, 9)).toBeGreaterThan(3.5);
    expect(rr(first, 0, 9)).toBeLessThan(6.5);
    const wk = mean(first.map(i => i.wickets));
    expect(wk).toBeGreaterThan(6);
    expect(wk).toBeLessThan(9.8);
    expect(mean(first.map(i => i.extras))).toBeGreaterThan(6);
  });

  it("women's ODIs score less than men's on the same squads", () => {
    const w = play(40, { rules: women, seed: 12000 });
    expect(mean(w.map(r => r.innings[0].runs))).toBeLessThan(mean(rs.slice(0, 40).map(r => r.innings[0].runs)));
  });
});

describe("ODI rules, live engine", () => {
  function liveOdi(seed: number, user: string | null = null, options = {}) {
    const [a, b] = makeTeams(2);
    return { a, b, state: createMatchState(a, b, men, user, seed, options) };
  }

  it("a CPU v CPU live ODI: 50 overs, ten overs a bowler, never two in a row, no timeouts", () => {
    for (let s = 0; s < 6; s++) {
      const { state } = simulateRemaining(liveOdi(300 + s).state);
      expect(state.status).toBe("completed");
      expect(state._internal.maxOversPerBowler).toBe(10);
      const raws = [state._internal.innings1Raw!, state._internal.currentInningsRaw];
      for (const raw of raws) {
        expect(raw.totalBalls).toBeLessThanOrEqual(300);
        for (const b of Object.values(raw.bowlerStats)) expect(b.overs * 6 + b.balls).toBeLessThanOrEqual(60);
        const by = oversByBowler(raw as unknown as InningsScore);
        for (const [o, id] of by) if (by.get(o + 1) !== undefined) expect(by.get(o + 1)).not.toBe(id);
      }
      if (state.innings1Wickets! < 10) expect(raws[0].totalBalls).toBe(300);
      expect(state.strategicTimeouts.home.used || state.strategicTimeouts.away.used).toBe(false);
    }
  });

  it("the user's ODI decisions: the bowler choice offers only bowlers under ten overs who did not bowl the last over", () => {
    let { state } = liveOdi(410, IPL_TEAMS[0].id);
    const a = { id: IPL_TEAMS[0].id };
    let picks = 0;
    let guard = 0;
    while (state.status !== "completed" && guard++ < 5000) {
      if (state.status === "innings_break") { state = startSecondInnings(state); continue; }
      if (state.status === "waiting_for_decision") {
        const d = state.pendingDecision!;
        if (d.type === "choose_bowler" && d.teamId === a.id && !d.reason) {
          const ni = state._internal;
          for (const id of d.options) {
            expect(ni.bowlerOvers[id] ?? 0).toBeLessThan(10);
            expect(id).not.toBe(ni.lastBowlerId);
          }
          // the user keeps bowling whoever has bowled most (pushes against the cap)
          const pick = [...d.options].sort((x, y) => (ni.bowlerOvers[y] ?? 0) - (ni.bowlerOvers[x] ?? 0))[0];
          state = applyDecision(state, { type: "choose_bowler", selectedPlayerId: pick });
          expect(state._internal.bowlingOrderIds[state.currentBowlerIdx]).toBe(pick);
          picks++;
        } else if (d.type === "toss_decision") {
          state = applyDecision(state, { type: "toss_decision", selectedPlayerId: "bowl" });
        } else {
          state = autoResolveDecision(state);
        }
        continue;
      }
      state = stepBall(state).state;
    }
    expect(picks).toBeGreaterThan(5);
    const raws = [state._internal.innings1Raw!, state._internal.currentInningsRaw];
    for (const raw of raws) for (const b of Object.values(raw.bowlerStats)) expect(b.overs * 6 + b.balls).toBeLessThanOrEqual(60);
  });

  it("DRS in a live ODI: reviews are offered to the user's side and counted per innings", () => {
    setRuleOverrides({ drsRateFactor: 6 });
    let reviews = 0;
    for (let s = 0; s < 3; s++) {
      let { state } = liveOdi(500 + s, IPL_TEAMS[0].id);
      let guard = 0;
      while (state.status !== "completed" && guard++ < 6000) {
        if (state.status === "innings_break") { state = simulateRemaining(state).state; break; }
        if (state.status === "waiting_for_decision") {
          if (state.pendingDecision!.type === "drs_review") {
            reviews++;
            expect(Math.max(state.drsRemaining.home, state.drsRemaining.away)).toBeLessThanOrEqual(2);
          }
          state = autoResolveDecision(state);
          continue;
        }
        state = stepBall(state).state;
      }
    }
    expect(reviews).toBeGreaterThan(0);
  });

  it("a live ODI tie stands; with the competition's super over it is settled", () => {
    setRuleOverrides({ ...ZERO_RUNS, forceOutcomeSparesSuperOver: true });
    const tied = simulateRemaining(liveOdi(600).state).state;
    expect(tied.score).toBe(tied.innings1Score);
    expect(tied.result).toBe("Match tied");
    expect(tied.winnerId).toBeUndefined();
    expect(tied.superOvers).toBeUndefined();
    const ko = simulateRemaining(liveOdi(601, null, { superOver: true }).state).state;
    expect(ko.superOvers?.length).toBeGreaterThan(0);
    expect(ko.winnerId).toBeDefined();
  });

  it("live ODI rain: a shortened chase gets a DLS target over 50-over resources", () => {
    setRuleOverrides({ rainReduced: 1, rainNoResult: 0 });
    let revised = 0;
    for (let s = 0; s < 10; s++) {
      const { state } = simulateRemaining(liveOdi(700 + s, null, { rain: true }).state);
      expect(state.status).toBe("completed");
      expect(state.maxOvers).toBeGreaterThanOrEqual(20);
      expect(state.maxOvers).toBeLessThanOrEqual(50);
      if (state.target !== (state.innings1Score ?? 0) + 1) revised++;
    }
    expect(revised).toBeGreaterThan(0);
  });

  it("ODI rain rates come from real ODIs", () => {
    for (const g of ["men", "women"] as const) {
      expect(ODI_RAIN[g].pNoResult).toBeGreaterThan(0);
      expect(ODI_RAIN[g].pReduced).toBeGreaterThan(0);
      expect(Object.keys(ODI_RAIN[g].oversPerSide).every(k => Number(k) >= 20)).toBe(true);
    }
  });
});

describe("ODI scoring on the real national pools, seeded (benchmark-odi.ts in small)", () => {
  // the 2019+ fixture list and pools (docs/data/odi_validation.json), players built as the game builds them, on ODI ratings
  const V = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../docs/data/odi_validation.json", import.meta.url)), "utf8"));
  const frPath = fileURLToPath(new URL("../../../app/public/data/format-ratings.json", import.meta.url));
  const FR: FormatRatingsFile | null = existsSync(frPath) ? JSON.parse(readFileSync(frPath, "utf8")) : null;
  const byEspn = new Map((ALL_PLAYERS as unknown as { id: string }[]).map(p => [Number(p.id.replace("espn_", "")), p as never as Player & { ratings: Player["ratings"] }]));
  const teams = new Map<string, Team>();
  for (const [name, pool] of Object.entries(V.male.pools as Record<string, [number, number, number][]>)) {
    const found = pool.map(([e]) => byEspn.get(e)).filter(Boolean).slice(0, 20) as (Player & { ratings: Player["ratings"] })[];
    if (found.length < 13) continue;
    const t = new Team({ id: name, name, shortName: name.slice(0, 3), city: name, primaryColor: "#333333", secondaryColor: "#999999" }, 100);
    for (const d of found) {
      const r = d.ratings;
      t.addPlayer(createPlayerFromData({
        id: d.id, name: d.name, age: d.age, country: d.country, role: d.role, isWicketKeeper: d.isWicketKeeper,
        bowlingStyle: d.bowlingStyle, battingHand: d.battingHand, battingIQ: r.battingIQ, timing: r.timing, power: r.power,
        running: r.running, wicketTaking: r.wicketTaking, economy: r.economy, accuracy: r.accuracy, clutch: r.clutch,
      }), 1);
    }
    attachFormatRatings(t.roster, FR);
    if (t.getPlayingXI(11).length === 11) teams.set(name, t);
  }
  const fixtures = (V.male.fixtures as [string, string, string | null][]).filter(([a, b, w]) => w !== null && teams.has(a) && teams.has(b)).slice(0, 240);
  const results = fixtures.map(([a, b], i) => ({ a, b, r: simulateMatch(teams.get(a)!, teams.get(b)!, men, 31000 + i, { countTowardStandings: false, neutralVenue: true }) }));
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  it("first innings, 300+ share and all-outs near the real 2019+ ODIs (253, 25%, 41%)", () => {
    const first = results.map(x => x.r.innings[0]);
    expect(mean(first.map(i => i.runs))).toBeGreaterThan(228);
    expect(mean(first.map(i => i.runs))).toBeLessThan(278);
    const p300 = mean(first.map(i => (i.runs >= 300 ? 1 : 0)));
    expect(p300).toBeGreaterThan(0.12);
    expect(p300).toBeLessThan(0.4);
    const allOut = mean(first.map(i => (i.wickets >= 10 ? 1 : 0)));
    expect(allOut).toBeGreaterThan(0.28);
    expect(allOut).toBeLessThan(0.6);
  });

  it("full members beat associates far more often than not", () => {
    const fm = new Set(["India", "Australia", "England", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "West Indies", "Bangladesh", "Afghanistan", "Zimbabwe", "Ireland"]);
    const mixed = results.filter(x => fm.has(x.a) !== fm.has(x.b));
    expect(mixed.length).toBeGreaterThan(10);
    const fmWins = mixed.filter(x => x.r.winnerId !== null && fm.has(x.r.winnerId)).length;
    expect(fmWins / mixed.length).toBeGreaterThan(0.55);
  });
});

describe("ODI win probability (fitted on Cricsheet ODIs)", () => {
  it("a chase of 306 in 48 overs at 11/1 is an uphill one; T20 numbers are unchanged", async () => {
    const { calculateWinProbability, odiWinProbability } = await import("../win-probability.js");
    const steep = calculateWinProbability({ score: 11, wickets: 1, overs: 1, balls: 2, innings: 2, target: 306, battingTeamPower: 80, bowlingTeamPower: 80, totalOvers: 50, inningsOvers: 48 });
    expect(steep).toBeGreaterThan(5);
    expect(steep).toBeLessThan(35);
    const easy = odiWinProbability({ score: 200, wickets: 2, ballsBowled: 240, innings: 2, target: 230, inningsOvers: 50, gender: "male" });
    expect(easy).toBeGreaterThan(90);
    const late = odiWinProbability({ score: 250, wickets: 9, ballsBowled: 294, innings: 2, target: 270, inningsOvers: 50, gender: "male" });
    expect(late).toBeLessThan(10);
    // first innings: on par is about even, 60 above par well ahead
    const par = odiWinProbability({ score: 130, wickets: 3, ballsBowled: 180, innings: 1, inningsOvers: 50, gender: "male" });
    const ahead = odiWinProbability({ score: 190, wickets: 2, ballsBowled: 180, innings: 1, inningsOvers: 50, gender: "male" });
    expect(Math.abs(par - 50)).toBeLessThan(20);
    expect(ahead).toBeGreaterThan(par + 15);
    // the T20 path does not change: the same call without totalOvers
    expect(calculateWinProbability({ score: 80, wickets: 2, overs: 10, balls: 0, innings: 2, target: 170, battingTeamPower: 80, bowlingTeamPower: 80 }))
      .toBe(calculateWinProbability({ score: 80, wickets: 2, overs: 10, balls: 0, innings: 2, target: 170, battingTeamPower: 80, bowlingTeamPower: 80, totalOvers: 20 }));
  });
});
