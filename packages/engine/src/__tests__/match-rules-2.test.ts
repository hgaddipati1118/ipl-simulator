/**
 * RULES-MATCH.md section 13: rain / DLS / no result, DRS (lbw and caught behind), short runs, lodged balls, misfields,
 * sixes saved, boundary and relay catches, no-ball reasons and beamers (two remove the bowler), the slow over-rate
 * restriction, women's extras, The Hundred's ends, dropped catches in stats and scorecards, and the live viewer's
 * user decisions (mid-over bowler change, retired-hurt return, given-out reviews) and super overs. Both engines.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { simulateMatch, type BallEvent, type InningsScore, type MatchResult } from "../match.js";
import {
  applyDecision, autoResolveDecision, createMatchState, simulateRemaining, startSecondInnings, stepBall, type MatchState,
} from "../live-match.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { getLeague } from "../leagues.js";
import { setRuleOverrides, type RuleOverrides } from "../delivery-rules.js";
import { DLS_F, dlsTarget, getDLSResource, inningsResources, resources50, resourcesPct } from "../dls.js";
import { CONV, battingLives, fieldingTally } from "../fielding.js";
import { MATCH_RULES_EXTRA as X } from "../match-rules-extra-data.js";
import { applySpecialPlays, extrasGenderFactor, OVER_RATE_EFFECT } from "../special-plays.js";
import { drsAtDismissal, drsAtDot, reviewLost } from "../drs.js";
import { createRNG } from "../rng.js";

vi.setConfig({ testTimeout: 240000 });

function player(id: string, role: "batsman" | "bowler" | "all-rounder", intl = false, wk = false, style?: string, fielding?: number): Player {
  const bat = role === "batsman";
  const bowl = role === "bowler";
  return new Player({
    id, name: `Player ${id}`, age: 26, country: intl ? "Australia" : "India", role,
    ratings: {
      battingIQ: bat ? 68 : bowl ? 25 : 54, timing: bat ? 66 : bowl ? 25 : 50, power: bat ? 64 : bowl ? 20 : 50,
      running: bat ? 58 : 40, wicketTaking: bowl ? 68 : bat ? 20 : 54, economy: bowl ? 66 : bat ? 20 : 54,
      accuracy: bowl ? 64 : bat ? 20 : 50, clutch: 50, ...(fielding !== undefined ? { fielding } : {}),
    },
    isInternational: intl, isWicketKeeper: wk, injured: false, injuryGamesLeft: 0,
    bowlingStyle: (style ?? (bowl || role === "all-rounder" ? "right-arm-medium-fast" : undefined)) as Player["bowlingStyle"],
    battingHand: "right",
  });
}

function squad(team: Team, idx: number, fielding?: number): void {
  let n = idx * 100;
  team.addPlayer(player(`wk_${++n}`, "batsman", false, true, undefined, fielding), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(player(`bat_${++n}`, "batsman", i === 0, false, undefined, fielding), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(player(`ar_${++n}`, "all-rounder", i === 0, false, i % 2 ? "off-spin" : "right-arm-medium-fast", fielding), 1);
  const styles = ["right-arm-fast", "left-arm-fast", "leg-spin", "left-arm-orthodox", "right-arm-medium", "off-spin", "right-arm-fast"];
  for (let i = 0; i < 7; i++) team.addPlayer(player(`bow_${++n}`, "bowler", false, false, styles[i], fielding), 1);
}

function makeTeams(n = 6, fielding?: number): Team[] {
  return IPL_TEAMS.slice(0, n).map((c, i) => { const t = new Team(c, 120); squad(t, i, fielding); return t; });
}

const rules: RuleSet = { ...RULE_PRESETS.modern2026, injuriesEnabled: false };

function play(n: number, opts: { seed?: number; rules?: RuleSet; pool?: Team[]; rain?: boolean; standings?: boolean } = {}): MatchResult[] {
  const pool = opts.pool ?? makeTeams();
  const out: MatchResult[] = [];
  for (let i = 0; i < n; i++) {
    const a = pool[i % pool.length];
    const b = pool[(i + 1 + (i % 3)) % pool.length === i % pool.length ? (i + 1) % pool.length : (i + 1 + (i % 3)) % pool.length];
    out.push(simulateMatch(a, b, opts.rules ?? rules, (opts.seed ?? 1) * 100000 + i, { countTowardStandings: opts.standings ?? false, rain: opts.rain ?? false }));
  }
  return out;
}

const innings = (rs: MatchResult[]): InningsScore[] => rs.flatMap(r => r.innings);
const balls = (rs: MatchResult[]): BallEvent[] => innings(rs).flatMap(i => i.ballLog);

afterEach(() => setRuleOverrides(null));
function withOverrides<T>(o: RuleOverrides, fn: () => T): T {
  setRuleOverrides(o);
  try { return fn(); } finally { setRuleOverrides(null); }
}

// ── DLS ─────────────────────────────────────────────────────────────────

describe("DLS Standard Edition resources", () => {
  it("reproduces the published 50-over table values", () => {
    const published: [number, number, number][] = [
      [50, 0, 100], [50, 1, 93.4], [50, 2, 85.1], [50, 3, 74.9], [50, 4, 62.7], [50, 5, 49.0], [50, 6, 34.9], [50, 7, 22.0], [50, 8, 11.9], [50, 9, 4.7],
      [40, 0, 89.3], [30, 2, 67.3], [25, 5, 42.2], [20, 0, 56.6], [20, 2, 52.4], [20, 5, 38.6], [20, 7, 21.2], [10, 0, 32.1], [10, 5, 26.1], [5, 0, 17.2], [5, 9, 4.6],
    ];
    for (const [u, w, v] of published) expect(Math.abs(resources50(u, w) - v), `${u} overs, ${w} wkts`).toBeLessThan(0.15);
    expect(DLS_F[0]).toBe(1);
  });

  it("a T20 innings is the bottom of the table rescaled: full 20 overs = 100%, monotone in overs and wickets", () => {
    expect(getDLSResource(20, 0)).toBeCloseTo(100, 6);
    for (let w = 0; w < 9; w++) for (let u = 1; u <= 20; u++) {
      expect(resourcesPct(u, w)).toBeGreaterThan(resourcesPct(u - 1, w));
      expect(resourcesPct(u, w)).toBeGreaterThanOrEqual(resourcesPct(u, w + 1));
    }
    // 10 overs with no wicket down: 56.8% of a T20 innings (32.1 / 56.6 on the 50-over table)
    expect(resourcesPct(10, 0)).toBeCloseTo(56.7, 0);
  });

  it("revised targets: fewer resources scale the score down, more add G", () => {
    // 180 in 20 overs, chase cut to 10 overs before it starts
    expect(dlsTarget(180, 100, resourcesPct(10, 0), 160)).toBe(Math.floor(180 * resourcesPct(10, 0) / 100) + 1);
    // first innings cut at 12 overs (2 down) to 15; team 2 gets 15 overs: R2 > R1 so G is added
    const r1 = inningsResources(20, [{ oversLeft: 8, wickets: 2, oversLost: 5 }]);
    const r2 = resourcesPct(15, 0);
    expect(r2).toBeGreaterThan(r1);
    expect(dlsTarget(120, r1, r2, 160)).toBe(Math.floor(120 + 160 * (r2 - r1) / 100) + 1);
    // a chase interrupted at 8 overs (3 down) and cut to 14 overs
    const rc = inningsResources(20, [{ oversLeft: 12, wickets: 3, oversLost: 6 }]);
    expect(rc).toBeLessThan(100);
    expect(dlsTarget(170, 100, rc, 160)).toBeLessThan(171);
  });
});

// ── Rain in the instant sim ─────────────────────────────────────────────

describe("rain, DLS and no result in the instant sim", () => {
  it("the fitted rain rates are per league and plausible", () => {
    const ipl = X.rain.byLeague.ipl;
    expect(ipl.pNoResult).toBeGreaterThan(0.002);
    expect(ipl.pNoResult).toBeLessThan(0.03);
    expect(X.rain.byLeague.bbl.pReduced).toBeGreaterThan(ipl.pReduced); // Australian summer storms vs Indian dry season
  });

  it("a washed-out league match is a point each, has no winner and leaves the NRR alone", () => {
    withOverrides({ rainNoResult: 1, rainReduced: 0 }, () => {
      const [a, b] = makeTeams(2);
      const before = { aT: a.ties, bT: b.ties, aRF: a.runsFor, bRF: b.runsFor, aB: a.ballsFacedFor };
      const r = simulateMatch(a, b, rules, 7, { countTowardStandings: true });
      expect(r.rain?.kind).toBe("no_result");
      expect(r.winnerId).toBeNull();
      expect(r.margin).toBe("No result");
      expect(a.ties).toBe(before.aT + 1);
      expect(b.ties).toBe(before.bT + 1);
      expect(a.runsFor).toBe(before.aRF);
      expect(a.ballsFacedFor).toBe(before.aB);
      expect(r.detailed?.result).toMatch(/No result/);
    });
  });

  it("a washed-out knockout goes to the higher-placed (home) side", () => {
    withOverrides({ rainNoResult: 1, rainReduced: 0 }, () => {
      const [a, b] = makeTeams(2);
      const r = simulateMatch(a, b, rules, 9, { countTowardStandings: false });
      expect(r.winnerId).toBe(a.id);
    });
  });

  it("a shortened match is played over the reduced overs with a DLS target", () => {
    withOverrides({ rainNoResult: 0, rainReduced: 1 }, () => {
      const rs = play(60, { rain: true, seed: 3 });
      const kinds = new Set<string>();
      for (const r of rs) {
        expect(r.rain?.kind).toBe("reduced");
        kinds.add(r.rain!.when);
        const [i1, i2] = r.innings;
        if (r.rain!.when === "preMatch") {
          expect(i1.totalBalls).toBeLessThanOrEqual(r.rain!.overs * 6);
          expect(i2.totalBalls).toBeLessThanOrEqual(r.rain!.overs * 6);
        }
        if (r.rain!.when === "secondInnings" && r.rain!.target !== undefined) {
          expect(i2.totalBalls).toBeLessThanOrEqual(r.rain!.overs * 6);
          expect(i2.dlsTarget).toBe(r.rain!.target);
        }
        if (r.rain!.target !== undefined && r.winnerId === r.innings[1].teamId && !r.superOver) expect(i2.runs).toBeGreaterThanOrEqual(r.rain!.target);
        if (r.rain!.target !== undefined && r.winnerId === r.innings[0].teamId && !r.superOver) expect(i2.runs).toBeLessThan(r.rain!.target - 1);
      }
      expect(kinds.size).toBeGreaterThanOrEqual(2);
    });
  });

  it("rain is rare by default (IPL: a few percent of matches)", () => {
    const rs = play(400, { rain: true, seed: 5 });
    const n = rs.filter(r => r.rain).length;
    expect(n).toBeLessThan(400 * 0.12);
  });
});

// ── DRS ─────────────────────────────────────────────────────────────────

describe("DRS (lbw and caught behind)", () => {
  it("reviews per innings, results and reviews kept / lost follow the rules", () => {
    const rs = play(300, { seed: 11 });
    let reviews = 0;
    for (const inn of innings(rs)) {
      const left = inn.drsLeft!;
      expect(left.batting).toBeGreaterThanOrEqual(0);
      expect(left.fielding).toBeGreaterThanOrEqual(0);
      let lostB = 0, lostF = 0;
      for (const e of inn.ballLog) {
        if (!e.review) continue;
        reviews++;
        const r = e.review;
        if (r.by === "fielding" && r.result === "overturned") { expect(e.isWicket).toBe(true); expect(r.onField).toBe("not_out"); }
        if (r.by === "batting" && r.result === "overturned") expect(e.isWicket).toBe(false);
        if (r.by === "batting" && r.result !== "overturned") expect(e.isWicket).toBe(true);
        if (r.by === "fielding" && r.result !== "overturned") expect(e.isWicket).toBe(false);
        if (r.kind === "lbw" && e.isWicket) expect(e.wicketType).toBe("lbw");
        if (r.kind === "caught" && e.isWicket) expect(e.wicketType).toBe("caught");
        if (reviewLost(r)) { if (r.by === "batting") lostB++; else lostF++; }
        expect(e.freeHit).toBeFalsy();
        expect(e.commentary).toMatch(/DRS review/);
      }
      expect(lostB).toBeLessThanOrEqual(2);
      expect(lostF).toBeLessThanOrEqual(2);
      expect(left.batting).toBe(2 - lostB);
      expect(left.fielding).toBe(2 - lostF);
    }
    const perInnings = reviews / (rs.length * 2);
    // Cricsheet: 1.10 reviews an innings in matches with DRS (fewer here when a side has run out of reviews)
    expect(perInnings).toBeGreaterThan(0.7);
    expect(perInnings).toBeLessThan(1.4);
  });

  it("umpire's call keeps the review; with no review left a not-out stands and a wrong out stands", () => {
    let cancels = 0, wrong = 0;
    for (let i = 0; i < 4000; i++) {
      const rng = createRNG(i);
      const a = drsAtDismissal("lbw", rng, { batting: 2, fielding: 0 });
      if (a.cancel) cancels++;
      const d = drsAtDot(rng, { batting: 0, fielding: 2 });
      if (d.wicket) wrong++;
      if (a.review?.result === "umpires_call") expect(reviewLost(a.review)).toBe(false);
    }
    expect(cancels).toBeGreaterThan(0);
    expect(wrong).toBeGreaterThan(0);
  });
});

// ── The rare plays ──────────────────────────────────────────────────────

describe("short runs, lodged balls, misfields, sixes saved, boundary catches", () => {
  it("one short: a run is not counted, the batters still change ends by the runs they ran", () => {
    withOverrides({ shortRunPerDelivery: 0.05 }, () => {
      const rs = play(10, { seed: 21 });
      const sr = balls(rs).filter(e => e.shortRun);
      expect(sr.length).toBeGreaterThan(10);
      for (const e of sr) {
        expect(e.runs).toBe((e.runsRun ?? 0) - 1);
        expect(e.commentary).toMatch(/one short/i);
      }
      for (const inn of innings(rs)) {
        const bat = [...inn.batterStats.values()].reduce((s, b) => s + b.runs, 0);
        expect(inn.runs).toBe(bat + inn.extras);
      }
    });
  });

  it("a ball lodged in the helmet is a dead ball that counts, with nothing scored", () => {
    withOverrides({ lodgedPerDelivery: 0.02 }, () => {
      const rs = play(10, { seed: 22 });
      const lodged = balls(rs).filter(e => e.lodged);
      expect(lodged.length).toBeGreaterThan(5);
      for (const e of lodged) { expect(e.runs).toBe(0); expect(e.extras).toBe(0); expect(e.outcome).toBe("dot"); expect(e.commentary).toMatch(/dead ball|lodges|grille/i); }
    });
  });

  it("misfields name the fielder, sixes saved on the rope score one or two, and are in the fielding stats", () => {
    withOverrides({ misfieldPerDelivery: 0.05, sixSavedShare: 0.3 }, () => {
      const rs = play(10, { seed: 23 });
      const all = balls(rs);
      const mis = all.filter(e => e.fieldingNote === "misfield");
      const saved = all.filter(e => e.fieldingNote === "six_saved");
      expect(mis.length).toBeGreaterThan(20);
      expect(saved.length).toBeGreaterThan(10);
      for (const e of mis) { expect(e.fielderId).toBeTruthy(); expect(e.commentary).toMatch(/misfield|fumble|through .*legs|dives over/i); }
      for (const e of saved) { expect([1, 2]).toContain(e.runs); expect(e.boundary).toBeUndefined(); expect(e.commentary).toMatch(/six|rope/i); }
      const fid = mis[0].fielderId!;
      const t = fieldingTally(innings(rs).flatMap(i => i.ballLog), fid);
      expect(t.misfields).toBeGreaterThan(0);
    });
  });

  it("about half the outfield catches are taken on the rope, and relay catches credit the catcher", () => {
    withOverrides({ relayCatchShare: 0.5 }, () => {
      const rs = play(40, { seed: 24 });
      const caught = balls(rs).filter(e => e.isWicket && e.wicketType === "caught");
      const rope = caught.filter(e => e.boundaryCatch);
      const share = rope.length / caught.length;
      expect(share).toBeGreaterThan(0.25);
      expect(share).toBeLessThan(0.6);
      const relay = rope.filter(e => e.fielder2Id);
      expect(relay.length).toBeGreaterThan(5);
      for (const e of relay) expect(e.fielder2Id).not.toBe(e.fielderId);
    });
  });
});

describe("no-balls, beamers and the slow over rate", () => {
  it("no-balls carry a reason; a second beamer removes the bowler from the attack for the innings", () => {
    withOverrides({ forceBeamer: true, noBallRateFactor: 25 }, () => {
      const rs = play(8, { seed: 31 });
      let suspended = 0;
      for (const inn of innings(rs)) {
        for (const e of inn.ballLog) if (e.outcome === "noball") expect(["front_foot", "height", "fielding"]).toContain(e.noBallKind);
        for (const id of inn.suspendedBowlers ?? []) {
          suspended++;
          // he bowls no legal ball after his second beamer
          const idx = inn.ballLog.findIndex((e, k) => e.bowler === id && e.beamer && inn.ballLog.slice(0, k).some(x => x.bowler === id && x.beamer));
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(inn.ballLog.slice(idx + 1).some(e => e.bowler === id)).toBe(false);
          expect(inn.ballLog[idx].commentary).toMatch(/removed from the attack/);
        }
      }
      expect(suspended).toBeGreaterThan(3);
    });
  });

  it("the over-rate restriction is drawn per innings and raises the boundary rate", () => {
    const control = withOverrides({ overRatePenaltyPerInnings: 0 }, () => play(150, { seed: 41 }));
    const pen = withOverrides({ overRatePenaltyPerInnings: 1 }, () => play(150, { seed: 41 }));
    for (const inn of innings(pen)) expect(inn.overRatePenaltyFrom).toBeDefined();
    const lastOver = (rs: MatchResult[], pick: (inn: InningsScore) => boolean) => {
      let b = 0, n = 0;
      for (const inn of innings(rs)) {
        if (!pick(inn)) continue;
        for (const e of inn.ballLog) if (e.over === 19 && e.outcome !== "wide" && e.outcome !== "noball") { n++; if (e.boundary === 4) b++; }
      }
      return b / Math.max(1, n);
    };
    const withPen = lastOver(pen, inn => (inn.overRatePenaltyFrom ?? 99) <= 19);
    const without = lastOver(control, () => true);
    expect(withPen).toBeGreaterThan(without * (1 + (OVER_RATE_EFFECT.four - 1) / 3));
    expect(balls(pen).some(e => e.overRatePenalty && /behind the over rate/.test(e.commentary))).toBe(true);
  });
});

describe("women's extras and The Hundred's ends", () => {
  it("women's matches use the women's wide / no-ball / bye rates (fitted from women's T20 leagues)", () => {
    const f = extrasGenderFactor("female");
    expect(f.wide).toBeCloseTo(X.extrasRate.female.wide / X.extrasRate.male.wide, 6);
    const women: RuleSet = { ...rules, gender: "women" };
    const count = (rs: MatchResult[]) => { let w = 0, d = 0; for (const e of balls(rs)) { d++; if (e.outcome === "wide") w++; } return w / d; };
    const m = count(play(200, { seed: 51 }));
    const w = count(play(200, { seed: 51, rules: women }));
    expect(w / m).toBeGreaterThan(f.wide - 0.12);
    expect(w / m).toBeLessThan(f.wide + 0.12);
  });

  it("The Hundred: the ends change every ten balls, not after every set of five", () => {
    const league = getLeague("hundred-m")!;
    const pool = makeTeams(4);
    let checked = 0;
    for (const r of play(30, { seed: 61, rules: { ...league.rules, injuriesEnabled: false }, pool })) {
      for (const inn of r.innings) {
        const log = inn.ballLog.filter(e => !e.deadBall);
        for (let k = 0; k + 1 < log.length; k++) {
          const a = log[k], b = log[k + 1];
          if (b.over !== a.over + 1 || a.isWicket || (inn.offBall ?? []).some(o => o.over === b.over || o.over === a.over)) continue;
          const crossed = (a.runsRun ?? a.runs) % 2 === 1;
          const endChange = (a.over + 1) % 2 === 0;
          // who faces the first ball of the next set
          const expected = crossed !== endChange ? a.nonStriker : a.batter;
          if (b.batter === a.batter || b.batter === a.nonStriker) { expect(b.batter).toBe(expected); checked++; }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("dropped catches and missed chances", () => {
  it("drop rates follow the commentary-fitted conversion, the batter survives, and the scorecard says 'dropped on N (fielder)'", () => {
    expect(CONV.catch.base).toBeCloseTo(1 - X.fielding.catchDropShare, 6);
    const rs = play(200, { seed: 71 });
    const all = balls(rs);
    const drops = all.filter(e => e.fieldingNote === "dropped_catch");
    const caught = all.filter(e => e.isWicket && (e.wicketType === "caught" || e.wicketType === "caught_and_bowled"));
    const share = drops.length / (drops.length + caught.length);
    expect(share).toBeGreaterThan(X.fielding.catchDropShare - 0.05);
    expect(share).toBeLessThan(X.fielding.catchDropShare + 0.05);
    for (const e of drops) { expect(e.isWicket).toBe(false); expect(e.fielderId).toBeTruthy(); expect(e.commentary).toMatch(/drop|spill|put down|can't hold|pops out/i); }
    // a deep drop can go for six; one by the keeper never does
    expect(drops.some(e => e.deepChance && e.boundary === 6)).toBe(true);
    // the scorecard
    const r = rs.find(x => x.innings.some(i => i.ballLog.some(e => e.fieldingNote === "dropped_catch")))!;
    const inn = r.detailed!.innings1.batters.some(b => b.lives) ? r.detailed!.innings1 : r.detailed!.innings2;
    const row = inn.batters.find(b => b.lives)!;
    expect(row.lives![0]).toMatch(/^(dropped|missed stumping|run out chance missed) on \d+( \(.+\))?$/);
  });

  it("drops are credited to the fielder in the season stats", () => {
    const pool = makeTeams(4);
    for (let i = 0; i < 30; i++) simulateMatch(pool[i % 4], pool[(i + 1) % 4], rules, 900 + i, { rain: false });
    const drops = pool.flatMap(t => t.roster).reduce((s, p) => s + (p.stats.drops ?? 0), 0);
    const catches = pool.flatMap(t => t.roster).reduce((s, p) => s + p.stats.catches, 0);
    expect(drops).toBeGreaterThan(0);
    expect(drops / (drops + catches)).toBeLessThan(0.35);
  });

  it("battingLives counts the score before the chance", () => {
    const log = [
      { batter: "a", runs: 4, isWicket: false },
      { batter: "a", runs: 1, isWicket: false, fieldingNote: "dropped_catch" as const, fielderId: "f" },
      { batter: "a", runs: 0, isWicket: false, fieldingNote: "missed_stumping" as const, fielderId: "k" },
    ];
    expect(battingLives(log, id => ({ f: "Jadeja", k: "Pant" } as Record<string, string>)[id]).get("a")).toEqual(["dropped on 4 (Jadeja)", "missed stumping on 5 (Pant)"]);
  });

  it("special plays leave a wicket's runs alone and only label a chance put down", () => {
    const d = { outcome: "1" as const, legal: true, batRuns: 1, batBoundary: 0 as const, wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0, extras: 0, runsRun: 1, overthrow: 0, freeHitNext: false };
    withOverrides({ shortRunPerDelivery: 1, misfieldPerDelivery: 1 }, () => {
      const out = applySpecialPlays({ ...d }, { rng: createRNG(1), bowlerId: "b", labelsOnly: true });
      expect(out.batRuns).toBe(1);
      expect(out.shortRun).toBeUndefined();
    });
  });
});

// ── Live engine ─────────────────────────────────────────────────────────

function livePair(seed: number): [Team, Team] {
  const t = makeTeams(6);
  return [t[seed % 3], t[3 + (seed % 3)]];
}

/** Step a live match; `onDecision` handles (or declines) each pending decision, the rest are auto-resolved */
function stepLive(s: MatchState, onDecision: (s: MatchState) => MatchState | null, maxBalls = 600): MatchState {
  let st = s;
  for (let k = 0; k < maxBalls * 2 && st.status !== "completed"; k++) {
    if (st.status === "waiting_for_decision") { st = onDecision(st) ?? autoResolveDecision(st); continue; }
    if (st.status === "innings_break") { st = startSecondInnings(st); continue; }
    st = stepBall(st).state;
  }
  return st;
}

describe("live engine: the section 13 plays and the user's decisions", () => {
  it("live balls carry drops, reviews, misfields and no-ball reasons; scorecards list the lives", () => {
    let drops = 0, reviews = 0, nbKinds = 0, lives = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const [a, b] = livePair(seed);
      const st = simulateRemaining(createMatchState(a, b, rules, null, seed)).state;
      for (const log of [st._internal.innings1Raw!.ballLog, st._internal.currentInningsRaw.ballLog]) {
        for (const e of log) {
          if (e.fieldingNote === "dropped_catch") { drops++; expect(e.isWicket).toBe(false); expect(e.fielderId).toBeTruthy(); }
          if (e.review) reviews++;
          if (e.outcome === "noball" && e.noBallKind) nbKinds++;
        }
      }
      lives += (st.innings1Scorecard?.batters ?? []).filter(x => x.lives).length;
    }
    expect(drops).toBeGreaterThan(3);
    expect(reviews).toBeGreaterThan(3);
    expect(nbKinds).toBeGreaterThan(0);
    expect(lives).toBeGreaterThan(0);
  });

  it("the user picks who finishes the over when the bowler leaves hurt mid-over", () => {
    withOverrides({ bowlerLeavesPerOver: 0.6 }, () => {
      const [a, b] = livePair(2);
      let asked = 0;
      let st = createMatchState(a, b, rules, a.id, 5);
      st = stepLive(st, s => {
        const p = s.pendingDecision!;
        if (p.type !== "choose_bowler" || !p.reason) return null;
        asked++;
        expect(p.reason).toBe("injury");
        expect(p.outgoingBowlerName).toBeTruthy();
        expect(s._internal.currentOverLegalBalls).toBeGreaterThan(0);
        const pick = p.options[p.options.length - 1];
        const next = applyDecision(s, { type: "choose_bowler", selectedPlayerId: pick });
        expect(next._internal.bowlingOrderIds[next.currentBowlerIdx]).toBe(pick);
        return next;
      });
      expect(asked).toBeGreaterThan(0);
      expect(st.status).toBe("completed");
    });
  });

  it("the user decides whether a retired-hurt batter resumes", () => {
    withOverrides({ hurtPerBatterBall: 0.02, returnProb: 0 }, () => {
      let asked = 0, resumed = 0;
      for (let seed = 1; seed <= 4 && resumed === 0; seed++) {
        const [a, b] = livePair(seed);
        stepLive(createMatchState(a, b, rules, a.id, 40 + seed), s => {
          const p = s.pendingDecision!;
          if (p.type !== "choose_batter" || !p.retiredHurtIds?.length) return null;
          asked++;
          const id = p.retiredHurtIds[0];
          const next = applyDecision(s, { type: "choose_batter", selectedPlayerId: id });
          const order = next._internal.battingOrderIds;
          expect([order[next.strikerIdx], order[next.nonStrikerIdx]]).toContain(id);
          expect(next.batterStats.find(x => x.playerId === id)?.retiredHurt).toBeFalsy();
          resumed++;
          return next;
        });
      }
      expect(asked).toBeGreaterThan(0);
      expect(resumed).toBeGreaterThan(0);
    });
  });

  it("given-out lbw / caught-behind decisions can be reviewed by the user's batting side", () => {
    withOverrides({ drsRateFactor: 6 }, () => {
      let asked = 0, overturned = 0;
      for (let seed = 1; seed <= 4; seed++) {
        const [a, b] = livePair(seed);
        stepLive(createMatchState(a, b, rules, a.id, 60 + seed), s => {
          const p = s.pendingDecision!;
          if (p.type !== "drs_review" || !p.drsContext || p.drsContext.reviewingSide !== "batting" || !(p.drsContext.reviewKind === "lbw" || p.drsContext.reviewKind === "caught")) return null;
          asked++;
          const w = s.wickets;
          const next = applyDecision(s, { type: "drs_review", selectedPlayerId: "review" });
          const last = next._internal.currentInningsRaw.ballLog[next._internal.currentInningsRaw.ballLog.length - 1];
          expect(last.review?.by).toBe("batting");
          if (last.review?.result === "overturned") { overturned++; expect(next.wickets).toBe(w); expect(last.isWicket).toBe(false); }
          else expect(last.isWicket).toBe(true);
          return next;
        });
      }
      expect(asked).toBeGreaterThan(0);
      expect(overturned).toBeGreaterThan(0);
    });
  });

  it("a tied live match goes to super overs, and the result names the winner", () => {
    // every delivery a dot: both innings end 0/0 and the super overs too, until the 25-round stand-in decides it
    withOverrides({ forceCoarseOutcome: "dot", hurtPerBatterBall: 0, mankadPerDelivery: 0, penaltyPerDelivery: 0, overthrowBoundaryAfterDot: 0, lodgedPerDelivery: 0 }, () => {
      const [a, b] = livePair(1);
      const st = simulateRemaining(createMatchState(a, b, rules, null, 3)).state;
      expect(st.status).toBe("completed");
      expect(st.superOvers!.length).toBeGreaterThanOrEqual(2);
      expect(st.winnerId).toBeTruthy();
      expect(st.result).toMatch(/Super Over/);
    });
  });
});
