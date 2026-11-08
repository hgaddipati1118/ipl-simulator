/**
 * International series (international.ts): nations and squads on format ratings, venues, lineups, playing a series
 * instantly and from a finished live match, the series score and stats, persistence under its own key, and the format
 * registry a Test entry plugs into. Every match is seeded.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { simulateRemaining } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { playerActivity, squadTier, type PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";
import {
  SERIES_FORMATS, SERIES_STORAGE_KEY, addResult, autoLineup, buildNationSquad, createSeries, homeGrounds, isSeriesDecidedEarly,
  lineupProblems, loadSeries, matchContext, matchName, nextMatchNumber, registerSeriesFormat, saveSeries, seriesFormat,
  seriesNations, seriesScore, seriesSquads, seriesStats, simulateRestOfSeries, simulateSeriesMatch, teamsForMatch, venueFor,
  type IntlSeries, type SeriesMatchRecord,
} from "../international";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const FILE = JSON.parse(readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;
const ACTIVITY = JSON.parse(readFileSync(join(PUBLIC, "data", "player-activity.json"), "utf-8")) as PlayerActivityFile;

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe("nations and squads", () => {
  it("lists the main men's and women's nations", () => {
    const men = seriesNations("men").map(n => n.country);
    for (const c of ["India", "Australia", "England", "South Africa", "New Zealand", "Pakistan"]) expect(men).toContain(c);
    const women = seriesNations("women").map(n => n.country);
    for (const c of ["India", "Australia", "England"]) expect(women).toContain(c);
  });

  it("an ODI squad plays on ODI ratings: 16 players, a keeper, six bowling options, stable ids", () => {
    const odi = buildNationSquad("India", "men", "odi", FILE);
    const t20 = buildNationSquad("India", "men", "t20", FILE);
    expect(odi).toHaveLength(16);
    expect(odi.some(p => p.isWicketKeeper)).toBe(true);
    expect(odi.filter(p => p.role === "bowler" || p.role === "all-rounder").length).toBeGreaterThanOrEqual(6);
    expect(odi.every(p => p.id.startsWith("espn_"))).toBe(true);
    const gill = odi.find(p => p.name === "Shubman Gill");
    if (gill) expect(gill.ratings).toEqual(gill.formatRatings!.odi!.ratings);
    // the same squad rebuilt from its ids
    const again = buildNationSquad("India", "men", "odi", FILE, odi.map(p => p.id));
    expect(again.map(p => p.id)).toEqual(odi.map(p => p.id));
    expect(t20.length).toBe(16);
  });

  it("squads are picked from active players: recent internationals in the format first, never anyone inactive for 3+ seasons", () => {
    const aus = buildNationSquad("Australia", "men", "odi", FILE, undefined, ACTIVITY);
    const names = aus.map(p => p.name);
    expect(names).not.toContain("James Faulkner"); // last ODI 2017, last senior game 2022
    expect(names).not.toContain("David Warner");   // retired from ODIs (last 2023), still in the BBL
    const tiers = aus.map(p => squadTier(playerActivity(ACTIVITY, p.sourceId ?? p.id), "odi", ACTIVITY.asOf));
    expect(tiers.every(t => t === 0 || t === 1)).toBe(true);
    expect(tiers.filter(t => t === 0).length).toBeGreaterThanOrEqual(12);
    // every format and gender keeps to the rule
    for (const [c, g, f] of [["India", "men", "t20"], ["England", "women", "odi"], ["South Africa", "men", "test"]] as const) {
      const sq = buildNationSquad(c, g, f, FILE, undefined, ACTIVITY);
      expect(sq).toHaveLength(16);
      for (const p of sq) expect(squadTier(playerActivity(ACTIVITY, p.sourceId ?? p.id), f, ACTIVITY.asOf)).not.toBe(3);
    }
    // without the activity file the age rule stands in (40 or under)
    expect(buildNationSquad("Australia", "men", "odi", FILE).every(p => p.age <= 40)).toBe(true);
  });

  it("squadTier: recent in the format, recent at senior level, fill-in, inactive", () => {
    const file: PlayerActivityFile = { v: 1, generated: "", asOf: 2026, players: { a: [0, 2025, 0, 2026], b: [2024, 2023, 0, 2026], c: [0, 2024, 0, 2024], d: [0, 2017, 0, 2022] } };
    const tier = (id: string) => squadTier(playerActivity(file, id), "odi", 2026);
    expect([tier("a"), tier("b"), tier("c"), tier("d"), tier("nobody")]).toEqual([0, 1, 2, 3, null]);
  });

  it("women's squads get a keeper even where the data flags none", () => {
    for (const c of seriesNations("women").slice(0, 8).map(n => n.country)) {
      expect(buildNationSquad(c, "women", "odi", FILE).some(p => p.isWicketKeeper)).toBe(true);
    }
  });

  it("home grounds: a nation's ODI grounds, most used first; none for an unknown nation", () => {
    const ind = homeGrounds("India");
    expect(ind.length).toBeGreaterThan(5);
    expect(ind.map(g => g.name)).toContain("Eden Gardens");
    expect(ind.find(g => g.name === "Eden Gardens")?.venueTeamId).toBe("kkr"); // the T20 engine's measured ground
    expect(homeGrounds("Atlantis")).toEqual([]);
  });
});

describe("a series", () => {
  const make = (over: Partial<Parameters<typeof createSeries>[0]> = {}) =>
    createSeries({ format: "odi", gender: "men", nations: ["India", "Australia"], length: 3, host: "a", userSide: 0, seed: 1234, ...over }, FILE);

  it("is created with both squads, host grounds in turn, match names", () => {
    const s = make();
    expect(s.sides[0].name).toBe("India");
    expect(s.sides[1].squad).toHaveLength(16);
    expect(venueFor(s, 0).name).toBe(homeGrounds("India")[0].name);
    expect(venueFor(s, 1).name).toBe(homeGrounds("India")[1].name);
    expect(venueFor({ ...s, host: "neutral" }, 0).neutral).toBe(true);
    expect(matchName(s, 0)).toBe("1st ODI");
    expect(matchName(s, 2)).toBe("3rd ODI");
    expect(matchName({ ...s, length: 1 }, 0)).toBe("One-off ODI");
  });

  it("the user's XI and batting order go to his side; the home side hosts at its ground", () => {
    const s = make();
    const squads = seriesSquads(s, FILE);
    const auto = autoLineup(squads[0], seriesFormat("odi").rules!("men"));
    expect(lineupProblems(squads[0], auto)).toEqual([]);
    const order = [...auto.order].reverse();
    const withLineup: IntlSeries = { ...s, lineup: { xi: auto.xi, order } };
    const { home, away, venue } = teamsForMatch(withLineup, 0, squads);
    expect(home.id).toBe(s.sides[0].id);
    expect(home.config.stadiumName).toBe(venue.name);
    expect(away.config.stadiumName).toBeUndefined();
    expect(home.isUserControlled).toBe(true);
    expect(home.getBattingOrder(home.getPlayingXI(11)).map(p => p.id)).toEqual(order);
    expect(lineupProblems(squads[0], { xi: auto.xi.slice(0, 10), order })).toContain("10/11 players");
  });

  it("plays an ODI instantly: 50-over innings, a result, scorecards, seeded", () => {
    const s = make();
    const squads = seriesSquads(s, FILE);
    const a = simulateSeriesMatch(s, squads);
    const b = simulateSeriesMatch(s, seriesSquads(s, FILE));
    expect(a.results).toHaveLength(1);
    const r = a.results[0];
    expect(r.innings).toHaveLength(2);
    expect(r.innings[0].bowlers.every(bw => Number(bw.overs.split(".")[0]) <= 10)).toBe(true);
    expect(r.worm[0].length).toBeGreaterThan(20);
    expect(r.result).toMatch(/won by|tied|No result/);
    expect(JSON.stringify(b.results[0].innings)).toBe(JSON.stringify(r.innings));
    expect(nextMatchNumber(a)).toBe(1);
  });

  it("the series score, dead rubbers skipped, series stats and player of the series", () => {
    const s = simulateRestOfSeries(make({ length: 5 }), seriesSquads(make({ length: 5 }), FILE));
    const score = seriesScore(s);
    expect(score.done).toBe(true);
    expect(score.wins[0] + score.wins[1] + score.shared).toBe(s.results.length);
    if (s.results.length < 5) expect(isSeriesDecidedEarly(s)).toBe(true);
    expect(score.text).toMatch(/win the series|Series drawn/);
    const stats = seriesStats(s);
    expect(stats.batting[0].runs).toBeGreaterThanOrEqual(stats.batting[1].runs);
    expect(stats.bowling[0].wickets).toBeGreaterThanOrEqual(stats.bowling[1].wickets);
    const top = stats.batting[0];
    expect(top.strikeRate).toBeCloseTo((100 * top.runs) / top.balls, 6);
    expect(stats.playerOfSeries?.name).toBeTruthy();
  });

  it("a live match's result joins the series the same way", { timeout: 60000 }, () => {
    const s = { ...make(), liveMatch: 0 };
    const squads = seriesSquads(s, FILE);
    const def = seriesFormat("odi");
    const ctx = matchContext(s, 0, squads);
    const { state } = simulateRemaining(def.live!.create(ctx, null));
    const rec = def.live!.finish(state, ctx);
    const next = addResult(s, { ...rec, n: 0 });
    expect(next.results).toHaveLength(1);
    expect(next.liveMatch).toBeUndefined();
    expect(next.results[0].mode).toBe("live");
    expect(next.results[0].innings[0].totalRuns).toBe(state.innings1Score);
  });

  it("T20Is play on T20 ratings and 20 overs", () => {
    const s = createSeries({ format: "t20i", gender: "women", nations: ["England", "India"], length: 1, host: "neutral", userSide: null, seed: 7 }, FILE);
    const done = simulateSeriesMatch(s, seriesSquads(s, FILE));
    const r = done.results[0];
    expect(r.venue).toBe("Neutral venue");
    expect(r.worm[0].length).toBeLessThanOrEqual(20);
    expect(seriesScore(done).done).toBe(true);
  });

  it("persists under its own key and nothing else", () => {
    const store = memory();
    const s = make();
    saveSeries(s, store);
    expect([...store.m.keys()]).toEqual([SERIES_STORAGE_KEY]);
    expect(loadSeries(store)?.id).toBe(s.id);
    saveSeries(null, store);
    expect(loadSeries(store)).toBeNull();
    store.setItem(SERIES_STORAGE_KEY, "{not json");
    expect(loadSeries(store)).toBeNull();
  });
});

describe("format registry", () => {
  it("lists ODI and T20I; a new format (a Test, say) registers with its own engine and screen", () => {
    expect(SERIES_FORMATS.map(f => f.id)).toEqual(expect.arrayContaining(["odi", "t20i"]));
    const fake: SeriesMatchRecord = {
      n: 0, seed: 1, mode: "sim", venue: "Lord's", homeTeamId: "a", awayTeamId: "b", winnerId: null, result: "Match drawn",
      tossWinnerName: "A", tossDecision: "bat", innings: [], worm: [],
    };
    registerSeriesFormat({ id: "test-stub", label: "Test", desc: "five days", ratingFormat: "test", lengths: [1, 2, 3, 5], simulate: () => fake });
    expect(seriesFormat("test-stub").label).toBe("Test");
    const s = createSeries({ format: "test-stub", gender: "men", nations: ["England", "India"], length: 2, host: "a", userSide: null, seed: 3 }, FILE);
    const played = simulateRestOfSeries(s, seriesSquads(s, FILE));
    expect(seriesScore(played)).toMatchObject({ shared: 2, done: true, text: "Series drawn 0-0" });
    SERIES_FORMATS.splice(SERIES_FORMATS.findIndex(f => f.id === "test-stub"), 1);
  });
});

describe("Draft Match ODI", () => {
  it("an ODI draft plays the ODI rules (women's for a women's pool) and its pool on ODI ratings", async () => {
    const { draftMatchRules, buildDraftMatchPool, toOdiPool, draftPoolIsWomen } = await import("../draft-pools");
    expect(draftMatchRules(4).matchFormat).toBeUndefined();
    const odi = draftMatchRules(4, "odi");
    expect(odi).toMatchObject({ matchFormat: "odi", impactPlayer: false, maxOverseasInXI: 4, gender: "men" });
    expect(draftMatchRules(5, "odi", draftPoolIsWomen("wpl-current")).gender).toBe("women");
    const pool = toOdiPool(buildDraftMatchPool("ipl-current").players, FILE);
    const withSet = pool.filter(p => p.formatRatings?.odi);
    expect(withSet.length).toBeGreaterThan(0.8 * pool.length);
    for (const p of withSet.slice(0, 20)) expect(p.ratings).toEqual(p.formatRatings!.odi!.ratings);
  });
});
