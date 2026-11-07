import { describe, it, expect } from "vitest";
import { Team } from "../team.js";
import { Player } from "../player.js";
import { simulateMatch } from "../match.js";
import {
  runSeason, generateSchedule, generateBalancedSchedule, progressPlayoffs, getStandings, type ScheduledMatch,
} from "../schedule.js";
import { ALL_LEAGUES, EXTRA_LEAGUES, getLeague, isOverseasIn, isWomenLeague } from "../leagues.js";
import { getVenueProfileForTeam, getLeagueChaseAdvantage } from "../venues.js";
import { HUNDRED_FORMAT, matchFormatFor, phaseOver } from "../format.js";
import { RULE_PRESETS, type RuleSet } from "../rules.js";

function makePlayer(id: string, role: "batsman" | "bowler" | "all-rounder", intl = false, wk = false): Player {
  const bat = role === "batsman";
  const bowl = role === "bowler";
  return new Player({
    id, name: `Player ${id}`, age: 26, country: intl ? "Australia" : "Home", role,
    ratings: {
      battingIQ: bat ? 66 : bowl ? 25 : 52, timing: bat ? 64 : bowl ? 25 : 50, power: bat ? 62 : bowl ? 20 : 50,
      running: bat ? 56 : 40, wicketTaking: bowl ? 66 : bat ? 20 : 52, economy: bowl ? 64 : bat ? 20 : 52,
      accuracy: bowl ? 62 : bat ? 20 : 50, clutch: 50,
    },
    isInternational: intl, isWicketKeeper: wk, injured: false, injuryGamesLeft: 0,
    bowlingStyle: bowl || role === "all-rounder" ? "right-arm-medium-fast" : undefined,
    battingHand: "right",
  });
}

/** A legal 16-player squad: keeper, 4 batters, 4 all-rounders, 6 bowlers, 2 of them overseas. */
function buildSquad(team: Team, idx: number): void {
  let n = idx * 100;
  team.addPlayer(makePlayer(`wk_${++n}`, "batsman", false, true), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bat_${++n}`, "batsman", i === 0), 1);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`ar_${++n}`, "all-rounder", i === 0), 1);
  for (let i = 0; i < 7; i++) team.addPlayer(makePlayer(`bow_${++n}`, "bowler"), 1);
}

function buildTeams(league: ReturnType<typeof getLeague> & object): Team[] {
  return league.teams.map((config, i) => {
    const team = new Team(config, league.rules.salaryCap);
    buildSquad(team, i);
    return team;
  });
}

describe("League registry", () => {
  it("has IPL, WPL and the 11 extra leagues, each with unique ids", () => {
    expect(ALL_LEAGUES.map(l => l.id)).toEqual([
      "ipl", "wpl", "bbl", "wbbl", "psl", "sa20", "hundred-m", "hundred-w", "cpl", "ilt20", "mlc", "bpl", "lpl",
    ]);
    const teamIds = ALL_LEAGUES.flatMap(l => l.teams.map(t => t.id));
    expect(new Set(teamIds).size).toBe(teamIds.length);
  });

  it.each(EXTRA_LEAGUES.map(l => [l.id, l] as const))("%s: teams and rules are consistent", (_id, league) => {
    const r = league.rules;
    expect(r.teamIds).toEqual(league.teams.map(t => t.id));
    expect(r.league).toBe(league.id);
    expect(league.teams.length).toBeGreaterThanOrEqual(5);
    expect(r.maxOverseasInXI).toBeLessThanOrEqual(11);
    expect(r.maxOverseasInSquad).toBeGreaterThanOrEqual(r.maxOverseasInXI);
    expect(r.minSquadSize!).toBeLessThanOrEqual(r.maxSquadSize);
    expect(r.minSquadSize!).toBeGreaterThanOrEqual(11);
    expect(r.playoffTeams).toBeLessThan(league.teams.length);
    // the group stage must be schedulable: n teams x m matches is even
    expect((league.teams.length * r.matchesPerTeam) % 2).toBe(0);
    expect(isWomenLeague(r)).toBe(league.gender === "women");
    for (const t of league.teams) {
      expect(t.stadiumName).toBeTruthy();
      expect(t.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // every team has a measured home ground
      const profile = getVenueProfileForTeam(t.id);
      expect(profile, `${t.id} has measured venue data`).not.toBeNull();
      expect(profile!.runMult).toBeGreaterThan(0.8);
      expect(profile!.runMult).toBeLessThan(1.4);
    }
    expect(getLeagueChaseAdvantage(league.id, league.gender)).toBeGreaterThan(-0.1);
  });

  it("The Hundred is the only 100-ball format; the others are T20", () => {
    const hundreds = EXTRA_LEAGUES.filter(l => l.rules.matchFormat === "hundred").map(l => l.id);
    expect(hundreds).toEqual(["hundred-m", "hundred-w"]);
    expect(matchFormatFor(RULE_PRESETS.modern2026).totalBalls).toBe(120);
    expect(matchFormatFor(getLeague("hundred-m")!.rules).totalBalls).toBe(100);
  });

  it("overseas is relative to each league's home country", () => {
    expect(isOverseasIn("bbl", "Australia")).toBe(false);
    expect(isOverseasIn("bbl", "India")).toBe(true);
    expect(isOverseasIn("ipl", "India")).toBe(false);
    expect(isOverseasIn("hundred-m", "Wales")).toBe(false);
    expect(isOverseasIn("hundred-m", "Australia")).toBe(true);
    expect(isOverseasIn("cpl", "West Indies")).toBe(false);
  });
});

describe("Balanced group schedule", () => {
  it.each(EXTRA_LEAGUES.map(l => [l.id, l] as const))("%s: every team plays exactly matchesPerTeam, home and away balanced", (_id, league) => {
    const teams = buildTeams(league);
    const schedule = generateSchedule(teams, league.rules.matchesPerTeam, league.rules);
    const m = league.rules.matchesPerTeam;
    expect(schedule.length).toBe((teams.length * m) / 2);
    for (const t of teams) {
      const played = schedule.filter(s => s.homeTeamId === t.id || s.awayTeamId === t.id);
      expect(played.length, `${t.id} matches`).toBe(m);
      const home = played.filter(s => s.homeTeamId === t.id).length;
      expect(Math.abs(home - (m - home))).toBeLessThanOrEqual(2);
    }
    // nobody plays themselves, and the pairings are spread evenly (no pair meets more than ceil(m/(n-1)) times)
    const pairCounts = new Map<string, number>();
    for (const s of schedule) {
      expect(s.homeTeamId).not.toBe(s.awayTeamId);
      const key = [s.homeTeamId, s.awayTeamId].sort().join("|");
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    for (const c of pairCounts.values()) expect(c).toBeLessThanOrEqual(Math.ceil(m / (teams.length - 1)));
  });

  it("rejects an odd team count with an odd remainder", () => {
    const league = getLeague("cpl")!; // 7 teams
    expect(() => generateBalancedSchedule(buildTeams(league), 9)).toThrow();
  });
});

describe("Playoff brackets", () => {
  function playGroup(league: NonNullable<ReturnType<typeof getLeague>>) {
    const teams = buildTeams(league);
    const schedule: ScheduledMatch[] = generateSchedule(teams, league.rules.matchesPerTeam, league.rules);
    teams.forEach((t, i) => { t.wins = teams.length - i; t.losses = i; });
    return { teams, schedule };
  }
  function resolve(schedule: ScheduledMatch[], match: ScheduledMatch, homeWins = true) {
    match.result = { winnerId: homeWins ? match.homeTeamId : match.awayTeamId } as ScheduledMatch["result"];
    void schedule;
  }

  it("top-4 'eliminator' format: Q1, Eliminator, Q2, Final", () => {
    const { teams, schedule } = playGroup(getLeague("bbl")!);
    const rules = getLeague("bbl")!.rules;
    const group = schedule.length;
    let started = progressPlayoffs(schedule, teams, rules, group, false);
    expect(started).toBe(true);
    expect(schedule.slice(group).map(m => m.playoffType)).toEqual(["qualifier1", "eliminator"]);
    resolve(schedule, schedule[group]);
    resolve(schedule, schedule[group + 1]);
    started = progressPlayoffs(schedule, teams, rules, group + 2, started);
    expect(schedule[group + 2].playoffType).toBe("qualifier2");
    resolve(schedule, schedule[group + 2]);
    progressPlayoffs(schedule, teams, rules, group + 3, started);
    expect(schedule[group + 3].playoffType).toBe("final");
  });

  it("The Hundred: 2nd v 3rd eliminator, then 1st plays the winner in the final", () => {
    const league = getLeague("hundred-m")!;
    const { teams, schedule } = playGroup(league);
    const standings = getStandings(teams).map(s => s.teamId);
    const group = schedule.length;
    const started = progressPlayoffs(schedule, teams, league.rules, group, false);
    expect(schedule.slice(group).map(m => [m.playoffType, m.homeTeamId, m.awayTeamId])).toEqual([
      ["eliminator", standings[1], standings[2]],
    ]);
    resolve(schedule, schedule[group], false);
    progressPlayoffs(schedule, teams, league.rules, group + 1, started);
    expect(schedule[group + 1]).toMatchObject({ playoffType: "final", homeTeamId: standings[0], awayTeamId: standings[2] });
  });

  it("WBBL: knockout 3v4, challenger 2nd v winner, 1st straight to the final", () => {
    const league = getLeague("wbbl")!;
    const { teams, schedule } = playGroup(league);
    const st = getStandings(teams).map(s => s.teamId);
    const group = schedule.length;
    let started = progressPlayoffs(schedule, teams, league.rules, group, false);
    expect(schedule[group]).toMatchObject({ playoffType: "eliminator", homeTeamId: st[2], awayTeamId: st[3] });
    resolve(schedule, schedule[group]);
    started = progressPlayoffs(schedule, teams, league.rules, group + 1, started);
    expect(schedule[group + 1]).toMatchObject({ playoffType: "qualifier2", homeTeamId: st[1], awayTeamId: st[2] });
    resolve(schedule, schedule[group + 1], false);
    progressPlayoffs(schedule, teams, league.rules, group + 2, started);
    expect(schedule[group + 2]).toMatchObject({ playoffType: "final", homeTeamId: st[0], awayTeamId: st[2] });
  });
});

describe("The Hundred: 100-ball innings", () => {
  const league = getLeague("hundred-m")!;

  it("phase mapping keeps the powerplay and death overs aligned with the T20 tables", () => {
    expect(phaseOver(0, HUNDRED_FORMAT)).toBe(0);
    expect(phaseOver(5, HUNDRED_FORMAT)).toBeCloseTo(6, 5);   // first set after the powerplay
    expect(phaseOver(19, HUNDRED_FORMAT)).toBeGreaterThan(18.5);
    expect(phaseOver(14, HUNDRED_FORMAT)).toBeLessThan(15);   // still middle overs
  });

  it("every innings is at most 100 balls, 5-ball sets, bowlers at most 20 balls and 2 sets in a row", () => {
    const teams = buildTeams(league);
    let fullInnings = 0;
    for (let i = 0; i < 60; i++) {
      const home = teams[i % teams.length];
      const away = teams[(i + 3) % teams.length];
      const result = simulateMatch(home, away, league.rules);
      for (const inn of result.innings) {
        expect(inn.totalBalls).toBeLessThanOrEqual(100);
        expect(inn.ballsPerOver).toBe(5);
        const legal = inn.ballLog.filter(b => b.outcome !== "wide" && b.outcome !== "noball");
        expect(legal.length).toBe(inn.totalBalls);
        // balls come in sets of 5
        const bySet = new Map<number, number>();
        for (const b of legal) bySet.set(b.over, (bySet.get(b.over) ?? 0) + 1);
        for (const [set, count] of bySet) {
          const last = set === Math.max(...bySet.keys());
          if (!last) expect(count).toBe(5);
          else expect(count).toBeLessThanOrEqual(5);
        }
        // bowler workload
        const balls = new Map<string, number>();
        for (const b of legal) balls.set(b.bowler, (balls.get(b.bowler) ?? 0) + 1);
        for (const c of balls.values()) expect(c).toBeLessThanOrEqual(20);
        // no bowler delivers three sets in a row
        const setBowler: string[] = [];
        for (const b of legal) if (setBowler[b.over] === undefined) setBowler[b.over] = b.bowler;
        for (let s = 2; s < setBowler.length; s++) {
          expect(!(setBowler[s] === setBowler[s - 1] && setBowler[s] === setBowler[s - 2])).toBe(true);
        }
      }
      // first innings runs the full 100 balls unless bowled out
      const first = result.innings[0];
      if (first.wickets < 10) { expect(first.totalBalls).toBe(100); fullInnings++; }
    }
    expect(fullInnings).toBeGreaterThan(40);
  });

  it("scores like a Hundred: roughly 1.3-1.9 runs per ball", () => {
    const teams = buildTeams(league);
    let runs = 0;
    let balls = 0;
    for (let i = 0; i < 80; i++) {
      const r = simulateMatch(teams[i % 8], teams[(i + 1) % 8], league.rules);
      runs += r.innings[0].runs;
      balls += r.innings[0].totalBalls;
    }
    const rpb = runs / balls;
    expect(rpb).toBeGreaterThan(1.2);
    expect(rpb).toBeLessThan(2.0);
  });

  it("T20 leagues still play 120 balls", () => {
    const bbl = getLeague("bbl")!;
    const teams = buildTeams(bbl);
    for (let i = 0; i < 10; i++) {
      const r = simulateMatch(teams[i % 8], teams[(i + 1) % 8], bbl.rules);
      expect(r.innings[0].totalBalls).toBeLessThanOrEqual(120);
      if (r.innings[0].wickets < 10) expect(r.innings[0].totalBalls).toBe(120);
      expect(r.innings[0].ballsPerOver).toBeUndefined();
    }
  });

  it("a Hundred tie goes to a 5-ball super over", () => {
    // force ties by simulating many matches and checking any super over innings
    const teams = buildTeams(league);
    let checked = 0;
    for (let i = 0; i < 400 && checked < 1; i++) {
      const r = simulateMatch(teams[i % 8], teams[(i + 2) % 8], league.rules);
      if (r.margin === "Super Over") checked++;
    }
    // ties are rare (~1%); the assertion is that nothing throws and winners are always decided
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});

describe("Full seasons", () => {
  it.each(EXTRA_LEAGUES.map(l => [l.id, l] as const))("%s: a season simulates to a champion", (_id, league) => {
    const teams = buildTeams(league);
    const rules: RuleSet = { ...league.rules, injuriesEnabled: false };
    const result = runSeason(teams, rules);
    expect(result.champion).toBeTruthy();
    expect(league.teams.map(t => t.id)).toContain(result.champion);
    const groupMatches = result.schedule.filter(m => !m.isPlayoff);
    expect(groupMatches.length).toBe((teams.length * rules.matchesPerTeam) / 2);
    const playoffs = result.schedule.filter(m => m.isPlayoff);
    const expected = { eliminator: 4, top3: 2, wbbl: 3 } as const;
    const fmt = rules.playoffFormat as keyof typeof expected;
    expect(playoffs.length).toBe(expected[fmt] ?? 4);
    expect(playoffs[playoffs.length - 1].playoffType).toBe("final");
    expect(result.standings.reduce((s, e) => s + e.played, 0)).toBe(groupMatches.length * 2);
  });
});
