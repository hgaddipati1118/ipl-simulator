import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({ getRealPlayers: () => [] }));
vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({ getWPLPlayers: () => [] }));

import { DEFAULT_RULES, IPL_TEAMS, Player, Team, createRNG, generatePlayers, type PlayerData } from "@ipl-sim/engine";
import {
  buildChartModel, realSeasonsFor, isWomanInHistory, projectionFor, summariseProjection, seedOf, GAME_START_YEAR,
  type RatingHistoryData,
} from "../rating-history";
import { RatingsOverTime } from "../components/RatingsOverTime";
import { nextSeason, type GameState } from "../game-state";
import { createRecruitmentState } from "../recruitment";
import { createScoutingState } from "../scouting";

// A 29-year-old who has 2019-2025 on record (2020 missing)
const DATA: RatingHistoryData = {
  v: 1,
  ids: { espn_1: 101 },
  f: [202],
  p: { "101": [2019, 60, -1, 64, -1, -1, -1, 68, 30, 70, 32, 72, 33, 74, 35], "202": [2024, 50, 40] },
};

function makePlayer(over: Partial<PlayerData> = {}): Player {
  return new Player({
    id: "espn_1", name: "Test Bat", age: 29, country: "India", role: "batsman", isInternational: false,
    ratings: { battingIQ: 76, timing: 76, power: 76, running: 70, wicketTaking: 25, economy: 25, accuracy: 25, clutch: 70 },
    injured: false, injuryGamesLeft: 0, bowlingStyle: "off-spin", ...over,
  });
}

describe("rating history file", () => {
  it("decodes a player's seasons, with gaps as null, by game id or ca_ id", () => {
    const seasons = realSeasonsFor(DATA, "espn_1");
    expect(seasons.map(s => s.year)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025]);
    expect(seasons[0]).toEqual({ year: 2019, bat: 60, bowl: null });
    expect(seasons[2]).toEqual({ year: 2021, bat: null, bowl: null });
    expect(seasons[3]).toEqual({ year: 2022, bat: 68, bowl: 30 });
    expect(realSeasonsFor(DATA, "ca_101")).toEqual(seasons);
    expect(realSeasonsFor(DATA, "p_77")).toEqual([]);
    expect(realSeasonsFor(null, "espn_1")).toEqual([]);
  });

  it("knows who is a woman", () => {
    expect(isWomanInHistory(DATA, "ca_202")).toBe(true);
    expect(isWomanInHistory(DATA, "espn_1")).toBe(false);
    expect(isWomanInHistory(DATA, "p_77")).toBeNull();
  });
});

describe("chart model", () => {
  const seasonsAhead = (p: Player) => projectionFor(p, 1, "male", 6, 60);

  it("places real seasons by calendar year, ending before the game's first season, and meets the game's rating", () => {
    const p = makePlayer();
    const m = buildChartModel({
      series: "batting", age: p.age, seasonNumber: 1, ratingHistory: p.ratingHistory,
      current: { overall: p.overall, batting: p.battingOvr, bowling: p.bowlingOvr },
      real: realSeasonsFor(DATA, "espn_1"), projection: seasonsAhead(p),
    });
    // 2025 is one year before the game's 2026 start: age 28
    expect(m.real[m.real.length - 1].age).toBe(p.age - 1);
    expect(m.real.map(r => r.age)).toEqual([22, 23, 25, 26, 27, 28].map(a => a + 0).filter(a => a <= 28));
    // anchored: the last real season (74) is moved to the game's rating (76)
    expect(m.shift).toBe(p.battingOvr - 74);
    expect(m.real[m.real.length - 1].value).toBe(p.battingOvr);
    expect(m.career).toEqual([{ age: 29, value: p.battingOvr }]);
    expect(m.projection[0]).toMatchObject({ age: 29, p50: p.battingOvr, active: 1 });
    expect(m.projection.length).toBeGreaterThan(3);
    expect(m.projection[1].age).toBe(30);
    expect(m.yMin).toBeLessThan(Math.min(...m.projection.map(b => b.p10)));
    expect(m.xMin).toBe(22);
  });

  it("career mode: keeps the career so far, one point per season, on the age axis", () => {
    const p = makePlayer({ age: 24, role: "all-rounder" });
    const rng = createRNG(3);
    for (let s = 1; s <= 4; s++) p.progress({ seasonNumber: s, rng });
    expect(p.ratingHistory.map(h => h.season)).toEqual([1, 2, 3, 4]);
    const m = buildChartModel({
      series: "overall", age: p.age, seasonNumber: 5, ratingHistory: p.ratingHistory,
      current: { overall: p.overall, batting: p.battingOvr, bowling: p.bowlingOvr },
      real: realSeasonsFor(DATA, "espn_1"), projection: projectionFor(p, 5, "male", 6, 60),
    });
    expect(m.career.map(c => c.age)).toEqual([24, 25, 26, 27, 28]);
    expect(m.career[m.career.length - 1].value).toBe(p.overall);
    // real seasons end the year before the game's first season (age 24 in 2026)
    expect(Math.max(...m.real.map(r => r.age))).toBeLessThan(24);
  });

  it("a player with no record still gets a career and a projection", () => {
    const p = makePlayer({ id: "p_9", age: 20 });
    const m = buildChartModel({
      series: "overall", age: 20, seasonNumber: 1, ratingHistory: [],
      current: { overall: p.overall, batting: p.battingOvr, bowling: p.bowlingOvr }, real: [], projection: seasonsAhead(p),
    });
    expect(m.real).toEqual([]);
    expect(m.shift).toBe(0);
    expect(m.career).toHaveLength(1);
  });

  it("projection summary: young players are expected to grow, old ones to hold or decline", () => {
    const young = makePlayer({ age: 19 });
    const old = makePlayer({ age: 38, ratings: { battingIQ: 88, timing: 88, power: 88, running: 60, wicketTaking: 25, economy: 25, accuracy: 25, clutch: 80 } });
    const ys = summariseProjection(young, projectionFor(young, 1, "male"));
    const os = summariseProjection(old, projectionFor(old, 1, "male"));
    expect(ys.nextChange).toBeGreaterThan(os.nextChange);
    expect(ys.peakTo).toBeGreaterThan(young.age);
    expect(os.nextChange).toBeLessThan(0);
    expect(["Developing", "Steady growth", "Peak years", "Gradual decline", "Sharp decline"]).toContain(ys.trajectory);
  });

  it("the projection is stable for a player and state (no jitter between renders)", () => {
    const p = makePlayer();
    expect(projectionFor(p, 1, "male")).toEqual(projectionFor(p, 1, "male"));
    expect(seedOf("espn_1")).toBe(seedOf("espn_1"));
    expect(GAME_START_YEAR).toBe(2026);
  });
});

describe("RatingsOverTime view (server render)", () => {
  const render = (p: Player, historyData: RatingHistoryData | null, seasonNumber = 1) => renderToStaticMarkup(
    createElement(RatingsOverTime, { player: p, seasonNumber, leagueGender: "male", historyData, runs: 60 }),
  );

  it("draws real history, the career, the median and both bands, with a readable summary", () => {
    const html = render(makePlayer(), DATA);
    expect(html).toContain('data-testid="ratings-over-time-chart"');
    expect(html).toContain('data-testid="real-history"');
    expect(html).toContain('data-testid="projection-median"');
    expect(html).toContain('data-testid="band-80"');
    expect(html).toContain('data-testid="band-50"');
    expect(html).toContain("Ratings over time");
    expect(html).toMatch(/Batting rating projection: median \d+ at age \d+ \(80% of outcomes \d+ to \d+\)/);
    expect(html).toContain('aria-pressed="true"');
  });

  it("says so when there is no real history and still shows the projection", () => {
    const html = render(makePlayer({ id: "p_5" }), DATA);
    expect(html).not.toContain('data-testid="real-history"');
    expect(html).toContain("none on record");
    expect(html).toContain('data-testid="projection-median"');
  });

  it("shows the career line once seasons have been played", () => {
    const p = makePlayer({ age: 25 });
    p.progress({ seasonNumber: 1, rng: createRNG(1) });
    p.progress({ seasonNumber: 2, rng: createRNG(2) });
    const html = render(p, DATA, 3);
    expect(html).toContain('data-testid="career-history"');
  });
});

describe("season rollover: seeded generation and progression", () => {
  function buildState(worldSeed: number): GameState {
    const userTeam = new Team(IPL_TEAMS[0]);
    const cpuTeam = new Team(IPL_TEAMS[1]);
    const rng = createRNG(42);
    const squad = generatePlayers(30, rng, { kind: "fill", country: "India" }, "sq");
    squad.forEach((p, i) => (i % 2 === 0 ? userTeam : cpuTeam).addPlayer(p, 2));
    // some very old players so retirements happen
    const olds = generatePlayers(20, rng, { age: [38, 41] }, "old");
    olds.forEach(p => cpuTeam.addPlayer(p, 1));
    const teams = [userTeam, cpuTeam];
    return {
      phase: "results", rules: { ...DEFAULT_RULES, teamIds: teams.map(t => t.id) }, teams, userTeamId: userTeam.id,
      playerPool: generatePlayers(40, rng, { age: [30, 40] }, "pool"), auctionResult: null, seasonResult: null,
      seasonNumber: 2, history: [], tradeOffers: [], completedTrades: [], schedule: [], currentMatchIndex: 0,
      matchResults: [], playoffsStarted: false, needsLineup: false, recentInjuries: [], narrativeEvents: [], trainingReport: [],
      scouting: createScoutingState(teams, [], userTeam.id, 1), scoutingAssignments: [], scoutingInbox: [],
      recruitment: createRecruitmentState(), youthProspects: [], fantasyLeaderboard: [], contractsResolved: true, worldSeed,
    };
  }

  const fingerprint = (s: GameState) => JSON.stringify([
    s.teams.map(t => t.roster.map(p => [p.id, p.age, p.ratings])),
    s.playerPool.map(p => [p.id, p.name, p.age, p.ratings, p.potential]),
    s.youthProspects.map(y => [y.player.id, y.player.name, y.potential]),
  ]);

  it("the same world seed gives the same offseason: progression, retirements, regens, youth", () => {
    const a = nextSeason(buildState(12345));
    const b = nextSeason(buildState(12345));
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(nextSeason(buildState(999)))).not.toBe(fingerprint(a));
  });

  it("retirees are replaced by regens of the same role, history is kept, and the generated players are new people", () => {
    const before = buildState(7);
    const poolBefore = before.playerPool.length;
    const next = nextSeason(before);
    const regens = next.playerPool.filter(p => /^g[0-9a-z]+s2_r\d+$/.test(p.id));
    expect(regens.length).toBeGreaterThan(0);
    expect(regens.every(p => p.age <= 23 && p.potential !== undefined)).toBe(true);
    expect(next.youthProspects.length).toBeGreaterThanOrEqual(2);
    expect(next.youthProspects.every(y => y.player.age <= 20 && y.player.id.includes("_y"))).toBe(true);
    expect(next.playerPool.length).toBeGreaterThan(poolBefore - 40); // pool does not collapse
    // unsigned pool players develop and age too, with a record of it
    const stillInPool = next.playerPool.filter(p => p.id.startsWith("pool_"));
    expect(stillInPool.length).toBeGreaterThan(0);
    expect(stillInPool.every(p => p.ratingHistory.length === 1 && p.ratingHistory[0].age === p.age - 1)).toBe(true);
    const kept = next.teams[0].roster[0];
    expect(kept.ratingHistory.length).toBe(1);
    expect(kept.ratingHistory[0]).toMatchObject({ season: 2, age: kept.age - 1 });
  });
});
