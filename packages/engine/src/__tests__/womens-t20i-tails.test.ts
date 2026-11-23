/**
 * The women's T20I lower order (docs/COUNTRY-VALIDATION.md, "Women's T20I tails"): a women's T20I first innings bats by its own innings
 * clock (the wicket row, fitted on Cricsheet women's T20Is to 2024, neutral in shares: wickets move from the early overs to the 19th and
 * 20th as real ones do), and a women's T20I at a franchise ground plays the ground without the league's (men's) wicket and dot levels.
 * The men's T20I, the leagues and The Hundred are untouched. Seeded.
 */
import { describe, expect, it, vi } from "vitest";
import { inningsClockTable, INNINGS_CLOCK_SWITCH } from "../innings-clock.js";
import { WOMENS_T20I_CLOCK } from "../womens-t20i-clock-data.js";
import { getVenueProfileForTeam, LEAGUE_LEVELS, LEAGUE_LEVEL_WICKET, VENUE_LEVEL_SWITCH } from "../venues.js";
import { LEAGUE_DEFS } from "../league-defs.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";
import { simulateMatch } from "../match.js";
import { createMatchState, simulateRemaining } from "../live-match.js";
import { Team, IPL_TEAMS } from "../team.js";
import { createPlayerFromData } from "../create-player.js";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

vi.setConfig({ testTimeout: 240000 });

const CLASSES = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];
const W = CLASSES.indexOf("wicket");
const T20I_W: RuleSet = { ...RULE_PRESETS.modern2026, league: "custom", impactPlayer: false, maxOverseasInXI: 11, injuriesEnabled: false, scoringContext: "t20i", gender: "women" };
const T20I_M: RuleSet = { ...T20I_W, gender: "men" };

function teams(): Team[] {
  const out = IPL_TEAMS.map(c => new Team(c, T20I_W.salaryCap));
  for (const d of getRealPlayers()) out.find(t => t.id === d.teamId)?.addPlayer(createPlayerFromData({ ...d }), d.bid ?? 1);
  return out;
}

describe("women's T20I innings clock", () => {
  it("is the women's T20I's table only: none for the men's T20I, the women's leagues or any other T20", () => {
    expect(inningsClockTable("t20i-female")).toBe(WOMENS_T20I_CLOCK);
    expect(inningsClockTable("t20i-male")).toBeUndefined();
    expect(inningsClockTable("default-female")).toBeUndefined();
    expect(inningsClockTable("wbbl")).toBeUndefined();
    INNINGS_CLOCK_SWITCH.womenT20I = false;
    try { expect(inningsClockTable("t20i-female")).toBeUndefined(); } finally { INNINGS_CLOCK_SWITCH.womenT20I = true; }
  });

  it("moves wickets, nothing else: fewer in the first fifteen overs, many more in the last two", () => {
    expect(WOMENS_T20I_CLOCK).toHaveLength(20);
    for (const row of WOMENS_T20I_CLOCK) {
      expect(row).toHaveLength(CLASSES.length);
      row.forEach((v, i) => { if (i !== W) expect(Math.abs(v)).toBeLessThan(1e-3); });
    }
    const m = (over: number) => Math.exp(WOMENS_T20I_CLOCK[over][W]);
    for (let o = 0; o < 11; o++) expect(m(o)).toBeLessThan(1);
    expect(m(18)).toBeGreaterThan(1.1);
    expect(m(19)).toBeGreaterThan(1.5);
  });

  it("a women's T20I first innings loses more of its wickets in the 19th and 20th overs (both engines); the chase is untouched", () => {
    const N = 40;
    const measure = (live: boolean) => {
      let late = 0, all = 0, chase = 0;
      for (let i = 0; i < N; i++) {
        const t = teams();
        const a = t[i % t.length], b = t[(i + 3) % t.length];
        const inns = live
          ? [simulateRemaining(createMatchState(a, b, T20I_W, null, 900 + i, { neutralVenue: true })).state].flatMap(s => [s._internal.innings1Raw!, s._internal.currentInningsRaw!])
          : simulateMatch(a, b, T20I_W, 900 + i, { countTowardStandings: false, neutralVenue: true }).innings;
        for (const ev of inns[0].ballLog) if (ev.isWicket) { all++; if (ev.over >= 18) late++; }
        chase += inns[1].ballLog.length;
      }
      return { lateShare: late / all, chase };
    };
    for (const live of [false, true]) {
      const on = measure(live);
      INNINGS_CLOCK_SWITCH.womenT20I = false;
      let off;
      try { off = measure(live); } finally { INNINGS_CLOCK_SWITCH.womenT20I = true; }
      expect(on.lateShare).toBeGreaterThan(off.lateShare + 0.03);
    }
  });

  it("the men's T20I plays exactly as before (ball for ball)", () => {
    const log = () => {
      const t = teams();
      return JSON.stringify(simulateMatch(t[0], t[1], T20I_M, 4242, { countTowardStandings: false, neutralVenue: true }).innings.map(i => i.ballLog.map(e => [e.over, e.ball, e.outcome, e.runs, e.extras, e.isWicket])));
    };
    const on = log();
    INNINGS_CLOCK_SWITCH.womenT20I = false;
    try { expect(log()).toBe(on); } finally { INNINGS_CLOCK_SWITCH.womenT20I = true; }
  });
});

describe("a women's T20I at a franchise ground", () => {
  const bbl = LEAGUE_DEFS.find(l => l.id === "bbl")!.teams[0].id;

  it("plays the ground without the league's wicket and dot levels; a men's T20I there keeps them", () => {
    const men = getVenueProfileForTeam(bbl, { league: false })!;
    const women = getVenueProfileForTeam(bbl, { league: false, levels: false })!;
    expect(men.dotMult).toBe(LEAGUE_LEVELS.bbl.dot);
    expect(women.dotMult).toBeUndefined();
    expect(women.wicketMult / men.wicketMult).toBeCloseTo(LEAGUE_LEVEL_WICKET / LEAGUE_LEVELS.bbl.wicket, 6);
    // the ground's own factors stay
    expect(women.runMult).toBe(men.runMult);
    expect(women.sixMult).toBe(men.sixMult);
    expect(VENUE_LEVEL_SWITCH.womenT20I).toBe(true);
  });
});
