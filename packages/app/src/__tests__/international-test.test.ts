/**
 * Test cricket in the International series (international.ts SERIES_FORMATS, test-match/test-series.ts): Test squads and the
 * auto XI, the lineup check, the host's conditions and the user's XI in the fixture, a series simulated with draws in its
 * score and Test numbers in its stats, a live Test from a series match to its record, and the record staying small. Seeded.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advanceTest, autoResolveTestDecision, setTestAutoCaptain, testPlayerOf, type TestMatchState } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import {
  SERIES_FORMATS, addResult, buildNationSquad, createSeries, matchContext, matchName, seriesFormat, seriesScore, seriesSquads,
  seriesStats, simulateRestOfSeries, simulateSeriesMatch, type IntlSeries, type SeriesMatchRecord,
} from "../international";
import { testAutoLineup, testFixture, testLineupProblems } from "../test-match/test-series";
import { readableTeamColor } from "../test-match/test-view";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;

const series = (over: Partial<Parameters<typeof createSeries>[0]> = {}): IntlSeries =>
  createSeries({ format: "test", gender: "men", nations: ["India", "England"], length: 3, host: "a", userSide: 0, seed: 7, ...over }, FILE);

describe("the Test format", () => {
  it("is offered: 1 to 5 Tests on Test ratings, with its own live screen", () => {
    const def = seriesFormat("test");
    expect(SERIES_FORMATS.map(f => f.id)).toContain("test");
    expect(def.label).toBe("Test");
    expect(def.ratingFormat).toBe("test");
    expect(def.lengths).toEqual([1, 2, 3, 4, 5]);
    expect(def.live?.viewer).toBe("test");
    expect(def.rules).toBeUndefined();
    expect(matchName(series(), 1)).toBe("2nd Test");
    expect(matchName(series({ length: 1 }), 0)).toBe("One-off Test");
  });
});

describe("Test squads and XIs", () => {
  it("a squad of 16 shaped for Tests: two keepers, five seamers, two spinners, batters; red-ball specialists in", () => {
    for (const c of ["Australia", "India", "England", "Pakistan"]) {
      const squad = buildNationSquad(c, "men", "test", FILE);
      expect(squad).toHaveLength(16);
      const tp = squad.map(p => testPlayerOf(p));
      expect(squad.filter(p => p.isWicketKeeper).length).toBeGreaterThanOrEqual(2);
      expect(tp.filter(t => t.bowler && !t.spin).length).toBeGreaterThanOrEqual(5);
      expect(tp.filter(t => t.bowler && t.spin).length).toBeGreaterThanOrEqual(2);
      expect(tp.filter(t => !t.bowler).length).toBeGreaterThanOrEqual(6);
      expect(squad.every(p => p.formatRatings?.test)).toBe(true);
    }
    // the T20-shaped ranking left the Test spinner out
    expect(buildNationSquad("Australia", "men", "test", FILE).map(p => p.name)).toContain("Nathan Lyon");
  });

  it("with the activity data, recent Test players come first in each slot", () => {
    const activity = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;
    const names = buildNationSquad("India", "men", "test", FILE, undefined, activity).map(p => p.name);
    expect(names).toHaveLength(16);
    // without it, domestic seamers with high first-class ratings took these places
    for (const n of ["Mohammed Siraj", "Jasprit Bumrah", "Shubman Gill"]) expect(names).toContain(n);
  });

  it("the auto XI: a keeper, four or five bowlers, a second spinner in the subcontinent; it passes the lineup check", () => {
    const home = series();
    const away = series({ host: "b" });
    const squad = seriesSquads(home, FILE)[0];
    const spinners = (s: IntlSeries) => testAutoLineup(squad, s).xi.filter(id => testPlayerOf(squad.find(p => p.id === id)!).spin && testPlayerOf(squad.find(p => p.id === id)!).bowler).length;
    for (const s of [home, away]) {
      const l = testAutoLineup(squad, s);
      expect(l.xi).toHaveLength(11);
      expect(testLineupProblems(squad, l)).toEqual([]);
    }
    expect(spinners(home)).toBeGreaterThanOrEqual(2);
    expect(spinners(away)).toBeLessThanOrEqual(spinners(home));
  });

  it("the lineup check wants eleven, a keeper and four bowlers", () => {
    const squad = seriesSquads(series(), FILE)[0];
    const bowlers = squad.filter(p => testPlayerOf(p).bowler);
    const others = squad.filter(p => !testPlayerOf(p).bowler);
    const keeper = others.find(p => p.isWicketKeeper)!;
    const rest = others.filter(p => p !== keeper);
    const xi = (nb: number) => [keeper, ...bowlers.slice(0, nb), ...rest].slice(0, 11).map(p => p.id);
    expect(testLineupProblems(squad, { xi: xi(4), order: xi(4) })).toEqual([]);
    if (rest.length >= 7) expect(testLineupProblems(squad, { xi: xi(3), order: xi(3) })).toContain("3/4 bowlers");
    expect(testLineupProblems(squad, { xi: xi(4).slice(0, 10), order: [] })).toContain("10/11 players");
  });
});

describe("a series Test", () => {
  it("is played in the host's conditions, or on a neutral ground; England bat in their recent style", () => {
    const s = series();
    const ctx = matchContext(s, 0, seriesSquads(s, FILE));
    const f = testFixture(ctx);
    expect(f.country).toBe("IND");
    expect(f.neutral).toBeUndefined();
    expect(f.bazballTeamId).toBe(s.sides[1].id);
    expect(f.venueName).toBe(ctx.venue.name);
    const n = series({ host: "neutral" });
    const nf = testFixture(matchContext(n, 0, seriesSquads(n, FILE)));
    expect(nf.neutral).toBe(true);
    expect(nf.country).toBeUndefined();
  });

  it("plays the user's XI in his batting order", () => {
    const s0 = series();
    const squads = seriesSquads(s0, FILE);
    const auto = testAutoLineup(squads[0], s0);
    const order = [...auto.order.slice(1), auto.order[0]];
    const s = { ...s0, lineup: { xi: auto.xi, order } };
    const ctx = matchContext(s, 0, squads);
    expect(testFixture(ctx).xi?.[s.sides[0].id]).toEqual(order);
    const rec = simulateSeriesMatch(s, squads, 0).results[0];
    const firstInnings = rec.innings.find(i => i.battingTeamId === s.sides[0].id)!;
    expect(order.slice(0, 2)).toContain(firstInnings.batters[0].playerId);
  });

  it("a simulated series: up to four innings a match, score lines, draws in the score, Test numbers in the stats", () => {
    let s = series({ length: 5, userSide: null, seed: 21 });
    s = simulateRestOfSeries(s, seriesSquads(s, FILE));
    const score = seriesScore(s);
    expect(score.done).toBe(true);
    expect(score.wins[0] + score.wins[1] + score.shared).toBe(s.results.length);
    for (const r of s.results) {
      expect(r.innings.length).toBeGreaterThanOrEqual(2);
      expect(r.innings.length).toBeLessThanOrEqual(4);
      expect(r.summary).toMatch(/^[A-Z]+ \d+/);
      expect(r.mode).toBe("sim");
      expect(r.winnerId === null).toBe(/drawn|tied/i.test(r.result));
      expect(r.worm).toEqual([]);
    }
    const stats = seriesStats(s);
    const fives = s.results.flatMap(r => r.innings.flatMap(i => i.bowlers)).filter(b => b.wickets >= 5).length;
    expect(stats.bowling.reduce((a, l) => a + l.fiveFors, 0)).toBe(fives);
    const hundreds = s.results.flatMap(r => r.innings.flatMap(i => i.batters)).filter(b => b.runs >= 100).length;
    expect(stats.batting.reduce((a, l) => a + l.hundreds, 0)).toBe(hundreds);
    expect(stats.playerOfSeries).not.toBeNull();
    // a Test record is small: the series stays a light localStorage entry
    expect(JSON.stringify(s).length / s.results.length).toBeLessThan(20_000);
  });

  it("draws count in the series score", () => {
    const s = series({ length: 3 });
    const rec = (n: number, winnerId: string | null, result: string): SeriesMatchRecord => ({
      n, seed: n, mode: "sim", venue: "x", homeTeamId: s.sides[0].id, awayTeamId: s.sides[1].id, winnerId, result,
      tossWinnerName: "India", tossDecision: "bat", innings: [], worm: [],
    });
    let t = addResult(s, rec(0, null, "Match drawn"));
    expect(seriesScore(t).text).toBe("Series level 0-0 (1 Test drawn)");
    t = addResult(t, rec(1, s.sides[0].id, "India won by 5 wickets"));
    expect(seriesScore(t).text).toBe("India lead 1-0 (1 Test drawn)");
    t = addResult(t, rec(2, null, "Match drawn"));
    expect(seriesScore(t)).toMatchObject({ done: true, winner: 0, shared: 2, text: "India win the series 1-0 (2 Tests drawn)" });
  });

  it("a live Test from a series match: the user's side, a watched match, the finished state to a record", () => {
    const s = series({ seed: 3 });
    const squads = seriesSquads(s, FILE);
    const def = seriesFormat("test");
    const ctx = matchContext(s, 0, squads);
    const st = def.live!.create(ctx, s.sides[0].id) as TestMatchState;
    expect(st.userTeamId).toBe(s.sides[0].id);
    expect(st.commentary).toBe(true);
    const watched = def.live!.create(ctx, null) as TestMatchState;
    expect(watched.userTeamId).toBeNull();
    expect(watched.status).toBe("in_progress");
    expect(watched.commentary).toBe(true);

    if (st.status === "waiting_for_decision") autoResolveTestDecision(st);
    setTestAutoCaptain(st, true);
    advanceTest(st, "match", { autoDecide: true });
    const rec = def.live!.finish(st, { venue: ctx.venue, seed: ctx.seed });
    expect(rec.mode).toBe("live");
    expect(rec.result).toBe(st.result!.text);
    expect(rec.innings.length).toBe(st.innings.length);
    const after = addResult({ ...s, liveMatch: 0 }, { ...rec, n: 0 });
    expect(after.results).toHaveLength(1);
    expect(after.liveMatch).toBeUndefined();
  });
});

describe("team colours on the Test screens", () => {
  it("near-black and pale primaries become readable; a mid colour is kept", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(s => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    for (const hex of ["#111827", "#1e3a8a", "#facc15", "#f8fafc", "#000000"]) {
      const out = readableTeamColor(hex);
      expect(lum(out)).toBeGreaterThanOrEqual(0.15);
      expect(lum(out)).toBeLessThanOrEqual(0.45);
    }
    expect(readableTeamColor("#dc2626")).toBe("#dc2626");
  });
});
