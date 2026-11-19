/**
 * Who bowls which overs (engine bowling-choice.ts): the CPU captain's fitted default respects the caps and the no-two-in-a-row rule
 * and uses pace and spin where real captains do; a user's bowling plan (SeriesLineup.bowling) fixes overs and phases in the instant
 * engine and the live one, and never breaks the caps.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bowlerKind, createMatchState, simulateMatch, simulateRemaining, buildDetailedResultFromState, type BowlingPlan, type DetailedBallEvent, type Player } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { simulateTestMatch } from "@ipl-sim/engine";
import { testFixture } from "../test-match/test-series";
import { cleanBowlingPlan, createSeries, matchContext, seriesFormat, seriesSquads, teamsForMatch, type IntlSeries, type SeriesLineup } from "../international";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;

const make = (format: "t20i" | "odi") => createSeries({ format, gender: "men", nations: ["India", "Australia"], length: 1, host: "a", userSide: null, seed: 5 }, FILE);

/** The side's best XI as a lineup, with a bowling plan */
function lineupWith(s: IntlSeries, side: 0 | 1, bowling?: (xi: Player[]) => BowlingPlan): SeriesLineup {
  const squad = seriesSquads(s, FILE)[side];
  const { home, away } = teamsForMatch(s, 0, seriesSquads(s, FILE));
  const team = side === 0 ? home : away;
  const xi = team.getPlayingXI();
  void squad;
  return { xi: xi.map(p => p.id), order: team.getBattingOrder(xi).map(p => p.id), ...(bowling ? { bowling: bowling(xi) } : {}) };
}

/** Overs bowled by the plan's side in every innings it bowls: the bowler id of each over, for `n` seeded matches */
function oversOf(s: IntlSeries, format: "t20i" | "odi", n: number, side: 0 | 1 = 0): string[][] {
  const squads = seriesSquads(s, FILE);
  const out: string[][] = [];
  for (let i = 0; i < n; i++) {
    const ctx = { ...matchContext(s, 0, squads), seed: 900 + i, key: undefined };
    const res = simulateMatch(ctx.home, ctx.away, ctx.rules ?? seriesFormat(format).rules!("men"), ctx.seed, { countTowardStandings: false, rain: false, venueName: ctx.venue.name });
    const d = res.detailed!;
    const names = new Map(squads[side].map(p => [p.name, p.id]));
    for (const k of [1, 2] as const) {
      const inn = k === 1 ? d.innings1 : d.innings2;
      if (inn.bowlingTeamId !== s.sides[side].id) continue;
      const seq: string[] = [];
      for (const b of d.ballLog as DetailedBallEvent[]) if (b.innings === k) seq[b.over] = names.get(b.bowlerName) ?? b.bowlerName;
      out.push(seq.filter(Boolean));
    }
  }
  return out;
}

const countBy = (seq: string[]) => { const m = new Map<string, number>(); for (const id of seq) m.set(id, (m.get(id) ?? 0) + 1); return m; };

describe("the CPU captain's default", () => {
  for (const [format, cap] of [["t20i", 4], ["odi", 10]] as const) {
    it(`${format}: caps and the no-two-in-a-row rule hold over 40 matches`, () => {
      const s = make(format);
      for (const seq of oversOf(s, format, 40)) {
        for (const [, n] of countBy(seq)) expect(n).toBeLessThanOrEqual(cap);
        seq.forEach((id, o) => { if (o > 0) expect(id).not.toBe(seq[o - 1]); });
      }
    });
  }

  it("t20i: pace opens and spin takes the middle overs, as real captains do", () => {
    const s = make("t20i");
    const squad = seriesSquads(s, FILE)[0];
    const kind = new Map(squad.map(p => [p.id, bowlerKind(p.bowlingStyle)]));
    let pp = 0, ppSpin = 0, mid = 0, midSpin = 0, death = 0, deathSpin = 0;
    for (const seq of oversOf(s, "t20i", 80)) {
      seq.forEach((id, o) => {
        const spin = kind.get(id) === "spin";
        if (o < 6) { pp++; if (spin) ppSpin++; } else if (o < 15) { mid++; if (spin) midSpin++; } else { death++; if (spin) deathSpin++; }
      });
    }
    // real men's T20Is: spin bowls 23% of powerplay overs, 58% of the middle, 15% of the death (the former rule: 49% / 45% / 35%)
    // real men's T20Is: spin bowls 23% of powerplay overs, 58% of the middle, 15% of the death (the former rule, uniform among the best
    // three: the same share in all three). The squad here is spin-heavy, so the shapes are tested, not the levels
    expect(ppSpin / pp).toBeLessThan(midSpin / mid - 0.2);
    expect(deathSpin / death).toBeLessThan(midSpin / mid - 0.2);
  });
});

describe("a user's bowling plan", () => {
  it("overs fixed to a bowler are bowled by him (instant engine, T20I)", () => {
    const s0 = make("t20i");
    const l0 = lineupWith(s0, 0);
    const squad = seriesSquads(s0, FILE)[0];
    const bowlers = l0.xi.map(id => squad.find(p => p.id === id)!).filter(p => p.role !== "batsman" && !p.isWicketKeeper);
    const [a, b] = [bowlers[0].id, bowlers[1].id];
    const l = { ...l0, bowling: { powerplay: [], middle: [], death: [], overs: { 0: a, 1: b, 2: a } } as BowlingPlan };
    const s = { ...s0, lineups: [l, null] as [SeriesLineup, null] };
    for (const seq of oversOf(s, "t20i", 20)) {
      expect(seq[0]).toBe(a); expect(seq[1]).toBe(b); expect(seq[2]).toBe(a);
    }
  });

  it("a phase list restricts the phase to those bowlers (T20I powerplay, ODI death)", () => {
    for (const [format, last] of [["t20i", 6], ["odi", 10]] as const) {
      const s0 = make(format);
      const l0 = lineupWith(s0, 0);
      const squad = seriesSquads(s0, FILE)[0];
      const bowlers = l0.xi.map(id => squad.find(p => p.id === id)!).filter(p => p.role !== "batsman" && !p.isWicketKeeper).sort((x, y) => y.bowlingOvr - x.bowlingOvr);
      const pair = [bowlers[2].id, bowlers[3].id];
      const l = { ...l0, bowling: { powerplay: pair, middle: [], death: [] } as BowlingPlan };
      const s = { ...s0, lineups: [l, null] as [SeriesLineup, null] };
      let ok = 0;
      for (const seq of oversOf(s, format, 15)) {
        for (let o = 0; o < Math.min(last, seq.length); o++) expect(pair).toContain(seq[o]);
        ok++;
      }
      expect(ok).toBeGreaterThan(0);
    }
  });

  it("a plan that asks for more than the cap gets the cap (T20I 4, ODI 10) and no back-to-back overs", () => {
    for (const [format, cap, n] of [["t20i", 4, 20], ["odi", 10, 50]] as const) {
      const s0 = make(format);
      const l0 = lineupWith(s0, 0);
      const squad = seriesSquads(s0, FILE)[0];
      const star = l0.xi.map(id => squad.find(p => p.id === id)!).sort((x, y) => y.bowlingOvr - x.bowlingOvr)[0];
      const overs: Record<number, string> = {};
      for (let o = 0; o < n; o++) overs[o] = star.id;
      const s = { ...s0, lineups: [{ ...l0, bowling: { powerplay: [], middle: [], death: [], overs } }, null] as [SeriesLineup, null] };
      for (const seq of oversOf(s, format, 6)) {
        expect(countBy(seq).get(star.id) ?? 0).toBeLessThanOrEqual(cap);
        seq.forEach((id, o) => { if (o > 0) expect(id).not.toBe(seq[o - 1]); });
      }
    }
  });

  it("the live engine bowls the plan too (CPU side with a plan, T20I)", () => {
    const s0 = make("t20i");
    const l0 = lineupWith(s0, 0);
    const squad = seriesSquads(s0, FILE)[0];
    const bowlers = l0.xi.map(id => squad.find(p => p.id === id)!).filter(p => p.role !== "batsman" && !p.isWicketKeeper);
    const a = bowlers[0].id;
    const s = { ...s0, lineups: [{ ...l0, bowling: { powerplay: [], middle: [], death: [], overs: { 0: a, 2: a } } }, null] as [SeriesLineup, null] };
    let seen = 0;
    for (let i = 0; i < 6; i++) {
      const ctx = { ...matchContext(s, 0, seriesSquads(s, FILE)), seed: 40 + i };
      const state = createMatchState(ctx.home, ctx.away, ctx.rules!, null, ctx.seed, { rain: false, venueName: ctx.venue.name });
      const done = simulateRemaining(state).state;
      const d = buildDetailedResultFromState(done);
      const names = new Map(seriesSquads(s, FILE)[0].map(p => [p.name, p.id]));
      for (const k of [1, 2] as const) {
        const inn = k === 1 ? d.innings1 : d.innings2;
        if (inn.bowlingTeamId !== s.sides[0].id) continue;
        const o0 = d.ballLog.find(b => b.innings === k && b.over === 0)?.bowlerName;
        const o2 = d.ballLog.find(b => b.innings === k && b.over === 2)?.bowlerName;
        expect(names.get(o0 ?? "")).toBe(a);
        expect(names.get(o2 ?? "")).toBe(a);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("cleanBowlingPlan keeps only the XI's players and drops an empty plan", () => {
    const plan: BowlingPlan = { powerplay: ["a", "x"], middle: [], death: ["y"], overs: { 0: "a", 1: "z" } };
    expect(cleanBowlingPlan(plan, ["a", "b"])).toEqual({ powerplay: ["a"], middle: [], death: [], overs: { 0: "a" } });
    expect(cleanBowlingPlan({ powerplay: ["x"], middle: [], death: [] }, ["a"])).toBeUndefined();
    expect(cleanBowlingPlan(undefined, ["a"])).toBeUndefined();
  });

  it("a Test plan: the openers open, and no spin before the over set (instant engine)", () => {
    const s0 = createSeries({ format: "test", gender: "men", nations: ["India", "Australia"], length: 1, host: "neutral", userSide: null, seed: 5 }, FILE);
    const squads = seriesSquads(s0, FILE);
    const { home, away } = teamsForMatch(s0, 0, squads);
    const xi = home.getPlayingXI();
    const seamers = xi.filter(p => !p.isWicketKeeper && bowlerKind(p.bowlingStyle) !== "spin" && p.role !== "batsman").sort((a, b) => b.bowlingOvr - a.bowlingOvr);
    const spinners = xi.filter(p => bowlerKind(p.bowlingStyle) === "spin" && p.role !== "batsman");
    expect(seamers.length).toBeGreaterThanOrEqual(2);
    const openers: [string, string] = [seamers[1].id, seamers[0].id];
    const plan: BowlingPlan = { powerplay: [], middle: [], death: [], overs: { 0: openers[0], 1: openers[1] }, spinFrom: 30 };
    let early = 0, innings = 0;
    for (let i = 0; i < 12; i++) {
      const s = { ...s0, lineups: [{ xi: xi.map(p => p.id), order: xi.map(p => p.id), bowling: plan }, null] as [SeriesLineup, null] };
      const ctx = { ...matchContext(s, 0, seriesSquads(s, FILE)), seed: 700 + i };
      const f = testFixture(ctx);
      expect(f.bowling?.[home.id]).toBeTruthy();
      const res = simulateTestMatch(f.home, f.away, { seed: f.seed, country: f.country, neutral: f.neutral, xi: f.xi, bowling: f.bowling });
      for (const inn of res.state.innings) {
        if (inn.bowlingTeamId !== f.home.id) continue;
        innings++;
        const first = inn.ballLog.filter(b => b.over === 0).map(b => b.bowler), second = inn.ballLog.filter(b => b.over === 1).map(b => b.bowler);
        expect(first.every(id => id === openers[0])).toBe(true);
        expect(second.every(id => id === openers[1])).toBe(true);
        for (const b of inn.ballLog) if (b.over < 30 && spinners.some(sp => sp.id === b.bowler)) early++;
      }
    }
    expect(innings).toBeGreaterThan(0);
    // spin is held back while a seamer is free: a few overs slip through only when the day's seamers are spent or resting
    expect(early / innings).toBeLessThan(25);
    void away;
  }, 60_000);
});
