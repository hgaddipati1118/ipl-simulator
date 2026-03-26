import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS, WPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import {
  generateIPLSchedule, generateSchedule, getStandings, runSeason,
  simulateNextMatch, addPlayoffMatches, serializeMatchResult,
} from "../schedule.js";
import { simulateMatch } from "../match.js";
import { RULE_PRESETS } from "../rules.js";

const OFFICIAL_GROUP_A = ["mi", "kkr", "rr", "dc", "lsg"];
const OFFICIAL_GROUP_B = ["csk", "srh", "rcb", "pbks", "gt"];

function makePlayer(id: string, role: "batsman" | "bowler" | "all-rounder", isWicketKeeper = false): Player {
  const batHeavy = role === "batsman";
  const bowlHeavy = role === "bowler";
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role,
    ratings: {
      battingIQ: batHeavy ? 65 : bowlHeavy ? 25 : 50,
      timing: batHeavy ? 63 : bowlHeavy ? 25 : 48,
      power: batHeavy ? 60 : bowlHeavy ? 20 : 48,
      running: batHeavy ? 55 : 40,
      wicketTaking: bowlHeavy ? 65 : batHeavy ? 20 : 50,
      economy: bowlHeavy ? 63 : batHeavy ? 20 : 50,
      accuracy: bowlHeavy ? 60 : batHeavy ? 20 : 48,
      clutch: 50,
    },
    isInternational: false,
    isWicketKeeper,
    injured: false,
    injuryGamesLeft: 0,
  });
}

function buildTeams(): Team[] {
  return IPL_TEAMS.map((config, teamIdx) => {
    const team = new Team(config);
    let id = teamIdx * 100;
    for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bat_${++id}`, "batsman"), 3);
    team.addPlayer(makePlayer(`wk_${++id}`, "batsman", true), 3);
    for (let i = 0; i < 3; i++) team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder"), 3);
    for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bow_${++id}`, "bowler"), 3);
    return team;
  });
}

describe("generateIPLSchedule", () => {
  it("generates exactly 70 modern IPL league matches", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams);
    expect(schedule.length).toBe(70);
  });

  it("all matches have valid team ids", () => {
    const teams = buildTeams();
    const teamIds = new Set(teams.map(t => t.id));
    const schedule = generateIPLSchedule(teams);

    for (const match of schedule) {
      expect(teamIds.has(match.homeTeamId)).toBe(true);
      expect(teamIds.has(match.awayTeamId)).toBe(true);
      expect(match.homeTeamId).not.toBe(match.awayTeamId);
    }
  });

  it("each team plays exactly 14 league matches", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams);

    const matchCounts = new Map<string, number>();
    for (const match of schedule) {
      matchCounts.set(match.homeTeamId, (matchCounts.get(match.homeTeamId) ?? 0) + 1);
      matchCounts.set(match.awayTeamId, (matchCounts.get(match.awayTeamId) ?? 0) + 1);
    }

    for (const [, count] of matchCounts) {
      expect(count).toBe(14);
    }
  });

  it("matches the official virtual-group matrix", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams);
    const matchupCounts = new Map<string, number>();

    for (const match of schedule) {
      const key = [match.homeTeamId, match.awayTeamId].sort().join(":");
      matchupCounts.set(key, (matchupCounts.get(key) ?? 0) + 1);
    }

    for (let i = 0; i < OFFICIAL_GROUP_A.length; i++) {
      for (let j = i + 1; j < OFFICIAL_GROUP_A.length; j++) {
        expect(matchupCounts.get([OFFICIAL_GROUP_A[i], OFFICIAL_GROUP_A[j]].sort().join(":"))).toBe(2);
      }
      for (let j = i + 1; j < OFFICIAL_GROUP_B.length; j++) {
        expect(matchupCounts.get([OFFICIAL_GROUP_B[i], OFFICIAL_GROUP_B[j]].sort().join(":"))).toBe(2);
      }
      expect(matchupCounts.get([OFFICIAL_GROUP_A[i], OFFICIAL_GROUP_B[i]].sort().join(":"))).toBe(2);
    }

    for (const a of OFFICIAL_GROUP_A) {
      for (const b of OFFICIAL_GROUP_B) {
        if (OFFICIAL_GROUP_A.indexOf(a) === OFFICIAL_GROUP_B.indexOf(b)) continue;
        expect(matchupCounts.get([a, b].sort().join(":"))).toBe(1);
      }
    }
  });

  it("marks all as non-playoff", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams);
    for (const m of schedule) {
      expect(m.isPlayoff).toBe(false);
    }
  });
});

describe("getStandings", () => {
  it("sorts by points then NRR", () => {
    const teams = buildTeams();
    teams[0].wins = 7;
    teams[1].wins = 7;
    teams[0].runsFor = 1000;
    teams[0].ballsFacedFor = 600;
    teams[0].runsAgainst = 800;
    teams[0].ballsFacedAgainst = 600;
    teams[0].updateNRR();
    teams[1].runsFor = 800;
    teams[1].ballsFacedFor = 600;
    teams[1].runsAgainst = 900;
    teams[1].ballsFacedAgainst = 600;
    teams[1].updateNRR();

    const standings = getStandings(teams);
    expect(standings[0].teamId).toBe(teams[0].id); // same points, better NRR
    expect(standings[0].points).toBe(14);
  });

  it("returns entries for all teams", () => {
    const teams = buildTeams();
    const standings = getStandings(teams);
    expect(standings).toHaveLength(10);
  });

  it("breaks remaining ties on wickets per fair ball bowled", () => {
    const teams = buildTeams();
    teams[0].wins = 7;
    teams[1].wins = 7;
    teams[0].runsFor = 980;
    teams[0].ballsFacedFor = 840;
    teams[0].runsAgainst = 910;
    teams[0].ballsFacedAgainst = 840;
    teams[0].wicketsTaken = 62;
    teams[0].updateNRR();
    teams[1].runsFor = 980;
    teams[1].ballsFacedFor = 840;
    teams[1].runsAgainst = 910;
    teams[1].ballsFacedAgainst = 840;
    teams[1].wicketsTaken = 55;
    teams[1].updateNRR();

    const standings = getStandings(teams);
    expect(standings[0].teamId).toBe(teams[0].id);
  });
});

describe("runSeason", () => {
  it("completes a full season with champion", () => {
    const teams = buildTeams();
    const result = runSeason(teams);

    expect(result.champion).toBeTruthy();
    expect(result.standings).toHaveLength(10);
    expect(result.orangeCap.playerId).toBeTruthy();
    expect(result.orangeCap.runs).toBeGreaterThan(0);
    expect(result.purpleCap.playerId).toBeTruthy();
    expect(result.purpleCap.wickets).toBeGreaterThan(0);
  });

  it("schedule includes playoff matches", () => {
    const teams = buildTeams();
    const result = runSeason(teams);

    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs).toHaveLength(4); // Q1, Eliminator, Q2, Final

    const types = playoffs.map(p => p.playoffType);
    expect(types).toContain("qualifier1");
    expect(types).toContain("eliminator");
    expect(types).toContain("qualifier2");
    expect(types).toContain("final");
  });

  it("all matches have results", () => {
    const teams = buildTeams();
    const result = runSeason(teams);
    for (const match of result.schedule) {
      expect(match.result).toBeDefined();
      expect(match.result!.winnerId).toBeTruthy();
    }
  });

  it("champion is one of the 10 teams", () => {
    const teams = buildTeams();
    const result = runSeason(teams);
    const teamIds = teams.map(t => t.id);
    expect(teamIds).toContain(result.champion);
  });

  it("standings have correct total wins+losses per team", () => {
    const teams = buildTeams();
    const result = runSeason(teams);

    // Each team plays group stage matches. All should have played >= 8
    for (const standing of result.standings) {
      expect(standing.played).toBeGreaterThanOrEqual(8);
    }
  });

  it("total wins equals total losses across all teams in group stage", () => {
    const teams = buildTeams();
    const result = runSeason(teams);

    // In group stage, every match produces exactly 1 win and 1 loss
    const totalWins = result.standings.reduce((s, e) => s + e.wins, 0);
    const totalLosses = result.standings.reduce((s, e) => s + e.losses, 0);
    // Playoffs add extra wins/losses, but total wins should still equal total losses
    expect(totalWins).toBe(totalLosses);
  });
}, 30000); // season sim can take a few seconds

describe("generateSchedule", () => {
  it("creates correct number of group matches for 10 teams (70)", () => {
    const teams = buildTeams();
    const schedule = generateSchedule(teams, 14);
    expect(schedule.length).toBe(70);
  });

  it("creates correct count for WPL (5 teams x 8 matches = 20 total)", () => {
    const teams = WPL_TEAMS.map((config, i) => {
      const team = new Team(config);
      let id = i * 100;
      for (let j = 0; j < 4; j++) team.addPlayer(makePlayer(`bat_${++id}`, "batsman"), 3);
      team.addPlayer(makePlayer(`wk_${++id}`, "batsman", true), 3);
      for (let j = 0; j < 3; j++) team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder"), 3);
      for (let j = 0; j < 4; j++) team.addPlayer(makePlayer(`bow_${++id}`, "bowler"), 3);
      return team;
    });
    const schedule = generateSchedule(teams, 8);
    expect(schedule.length).toBe(20);
  });

  it("each team gets the official seven home and seven away matches", () => {
    const teams = buildTeams();
    const schedule = generateSchedule(teams, 14);

    for (const team of teams) {
      const homeMatches = schedule.filter(m => m.homeTeamId === team.id).length;
      const awayMatches = schedule.filter(m => m.awayTeamId === team.id).length;
      expect(homeMatches).toBe(7);
      expect(awayMatches).toBe(7);
    }
  });
});

describe("simulateNextMatch", () => {
  it("simulates one match and returns a result", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams, 14);

    const result = simulateNextMatch(schedule, 0, teams);
    expect(result.id).toBeTruthy();
    expect(result.winnerId).toBeTruthy();
    expect(schedule[0].result).toBeDefined();
  });

  it("updates team records (wins, losses, points)", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams, 14);

    const match = schedule[0];
    const homeBefore = teams.find(t => t.id === match.homeTeamId)!;
    const awayBefore = teams.find(t => t.id === match.awayTeamId)!;

    const winsBeforeHome = homeBefore.wins;
    const winsBeforeAway = awayBefore.wins;

    simulateNextMatch(schedule, 0, teams, {
      ...RULE_PRESETS.modern,
      impactPlayer: false,
      injuriesEnabled: false,
    });

    // One team should have gained a win
    expect(homeBefore.wins + awayBefore.wins).toBe(winsBeforeHome + winsBeforeAway + 1);
    expect(homeBefore.losses + awayBefore.losses).toBe(1);
  });

  it("heals injuries after match", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams, 14);

    // Injure a player on one of the teams
    teams[0].roster[0].injured = true;
    teams[0].roster[0].injuryGamesLeft = 1;

    simulateNextMatch(schedule, 0, teams);

    // Injury should have been healed (games left decremented to 0)
    expect(teams[0].roster[0].injuryGamesLeft).toBe(0);
    expect(teams[0].roster[0].injured).toBe(false);
  });

  it("applies match fatigue to the XI while resting other squads", () => {
    const teams = buildTeams();
    const schedule = [{
      matchNumber: 1,
      homeTeamId: teams[0].id,
      awayTeamId: teams[1].id,
      isPlayoff: false,
      type: "group" as const,
    }];

    for (const team of teams) {
      for (const player of team.roster) {
        player.fatigue = 20;
      }
    }

    const homeXI = teams[0].getPlayingXI();
    const restingPlayer = teams[2].roster[0];

    simulateNextMatch(schedule, 0, teams, {
      ...RULE_PRESETS.modern,
      impactPlayer: false,
      injuriesEnabled: false,
    });

    expect(homeXI.some(player => player.fatigue > 20)).toBe(true);
    expect(restingPlayer.fatigue).toBeLessThan(20);
  });
});

describe("addPlayoffMatches", () => {
  it("adds qualifier1 and eliminator to schedule", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams, 14);

    // Simulate all group matches
    for (let i = 0; i < schedule.length; i++) {
      simulateNextMatch(schedule, i, teams, {
        ...RULE_PRESETS.modern,
        injuriesEnabled: false,
      });
    }

    const groupCount = schedule.length;
    addPlayoffMatches(schedule, teams);

    expect(schedule.length).toBe(groupCount + 2);
    expect(schedule[groupCount].playoffType).toBe("qualifier1");
    expect(schedule[groupCount + 1].playoffType).toBe("eliminator");
    expect(schedule[groupCount].isPlayoff).toBe(true);
    expect(schedule[groupCount + 1].isPlayoff).toBe(true);
  });

  it("uses correct teams from standings (1v2 and 3v4)", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams, 14);

    for (let i = 0; i < schedule.length; i++) {
      simulateNextMatch(schedule, i, teams, {
        ...RULE_PRESETS.modern,
        injuriesEnabled: false,
      });
    }

    const standings = getStandings(teams);
    addPlayoffMatches(schedule, teams);

    const q1 = schedule.find(m => m.playoffType === "qualifier1")!;
    const elim = schedule.find(m => m.playoffType === "eliminator")!;

    expect(q1.homeTeamId).toBe(standings[0].teamId);
    expect(q1.awayTeamId).toBe(standings[1].teamId);
    expect(elim.homeTeamId).toBe(standings[2].teamId);
    expect(elim.awayTeamId).toBe(standings[3].teamId);
  });

  it("playoff matches do not alter the league table", () => {
    const teams = buildTeams();
    const schedule = generateIPLSchedule(teams, 14);

    for (let i = 0; i < schedule.length; i++) {
      simulateNextMatch(schedule, i, teams, {
        ...RULE_PRESETS.modern,
        injuriesEnabled: false,
      });
    }

    const beforePlayoffs = getStandings(teams).map(entry => ({
      teamId: entry.teamId,
      points: entry.points,
      played: entry.played,
      nrr: entry.nrr,
    }));

    addPlayoffMatches(schedule, teams);
    simulateNextMatch(schedule, schedule.length - 2, teams, RULE_PRESETS.modern);
    simulateNextMatch(schedule, schedule.length - 1, teams, RULE_PRESETS.modern);

    const afterPlayoffs = getStandings(teams).map(entry => ({
      teamId: entry.teamId,
      points: entry.points,
      played: entry.played,
      nrr: entry.nrr,
    }));

    expect(afterPlayoffs).toEqual(beforePlayoffs);
  });
});

describe("serializeMatchResult", () => {
  it("produces JSON-safe output with no Maps", () => {
    const teams = buildTeams();
    const home = teams[0];
    const away = teams[1];
    const result = simulateMatch(home, away);

    const serialized = serializeMatchResult(result);

    // Should be a plain object, no Maps
    expect(typeof serialized.innings[0].batterStats).toBe("object");
    expect(serialized.innings[0].batterStats instanceof Map).toBe(false);
    expect(typeof serialized.innings[0].bowlerStats).toBe("object");
    expect(serialized.innings[0].bowlerStats instanceof Map).toBe(false);
  });

  it("preserves all key fields", () => {
    const teams = buildTeams();
    const home = teams[0];
    const away = teams[1];
    const result = simulateMatch(home, away);
    const serialized = serializeMatchResult(result);

    expect(serialized.id).toBe(result.id);
    expect(serialized.homeTeamId).toBe(result.homeTeamId);
    expect(serialized.awayTeamId).toBe(result.awayTeamId);
    expect(serialized.winnerId).toBe(result.winnerId);
    expect(serialized.margin).toBe(result.margin);
    expect(serialized.motm).toBe(result.motm);
    expect(serialized.tossWinner).toBe(result.tossWinner);
    expect(serialized.tossDecision).toBe(result.tossDecision);
  });

  it("innings scores are preserved", () => {
    const teams = buildTeams();
    const result = simulateMatch(teams[0], teams[1]);
    const serialized = serializeMatchResult(result);

    for (let i = 0; i < 2; i++) {
      expect(serialized.innings[i].runs).toBe(result.innings[i].runs);
      expect(serialized.innings[i].wickets).toBe(result.innings[i].wickets);
      expect(serialized.innings[i].overs).toBe(result.innings[i].overs);
      expect(serialized.innings[i].fours).toBe(result.innings[i].fours);
      expect(serialized.innings[i].sixes).toBe(result.innings[i].sixes);
      expect(serialized.innings[i].extras).toBe(result.innings[i].extras);
    }
  });

  it("can be JSON stringified and parsed", () => {
    const teams = buildTeams();
    const result = simulateMatch(teams[0], teams[1]);
    const serialized = serializeMatchResult(result);

    const jsonStr = JSON.stringify(serialized);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.id).toBe(serialized.id);
    expect(parsed.innings[0].runs).toBe(serialized.innings[0].runs);
    expect(parsed.winnerId).toBe(serialized.winnerId);
  });
});
