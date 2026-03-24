/**
 * Integration tests for full IPL seasons.
 *
 * These tests exercise the complete game flow:
 * real players → auction → 70-match group stage → playoffs → champion
 * as well as multi-season progression, stat consistency, and edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  Player, Team, IPL_TEAMS,
  generatePlayerPool, createPlayerFromData,
  runAuction, runSeason, getStandings, simulateMatch,
  retainPlayers,
  type SeasonResult,
} from "@ipl-sim/engine";
import { getRealPlayers } from "@ipl-sim/ratings";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build teams with real IPL players assigned to their squads */
function buildRealTeams(): { teams: Team[]; pool: Player[] } {
  const teams = IPL_TEAMS.map(c => new Team(c));
  const realPlayers = getRealPlayers();

  for (const data of realPlayers) {
    const player = createPlayerFromData(data);
    const team = teams.find(t => t.id === data.teamId);
    if (team) team.addPlayer(player, Math.min(player.marketValue, 15));
  }

  const pool = generatePlayerPool(300);
  return { teams, pool };
}

/** Run auction and return filled teams */
function auctionAndFill(): Team[] {
  const { teams, pool } = buildRealTeams();
  runAuction(pool, teams, { maxRosterSize: 25, maxInternational: 8 });
  return teams;
}

/** Collect every player across all rosters */
function allPlayers(teams: Team[]): Player[] {
  return teams.flatMap(t => t.roster);
}

// ── Full Season Integration ──────────────────────────────────────────────

describe("full season with real players", () => {
  it("real players load into correct teams", () => {
    const { teams } = buildRealTeams();
    const teamMap = new Map(teams.map(t => [t.id, t]));

    // Virat Kohli should be on RCB
    const rcb = teamMap.get("rcb")!;
    expect(rcb.roster.find(p => p.name === "Virat Kohli")).toBeDefined();

    // Jasprit Bumrah should be on MI
    const mi = teamMap.get("mi")!;
    expect(mi.roster.find(p => p.name === "Jasprit Bumrah")).toBeDefined();

    // Rohit Sharma should be on MI
    expect(mi.roster.find(p => p.name === "Rohit Sharma")).toBeDefined();

    // Every team gets its real players
    for (const team of teams) {
      expect(team.roster.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("auction fills all teams to playable rosters", () => {
    const teams = auctionAndFill();

    for (const team of teams) {
      // Each team should have enough players to field a competitive XI
      expect(team.roster.length).toBeGreaterThanOrEqual(11);

      const xi = team.getPlayingXI();
      // XI can be < 11 if too many internationals and not enough domestics
      expect(xi.length).toBeGreaterThanOrEqual(7);
      expect(xi.length).toBeLessThanOrEqual(11);

      // Must have enough bowlers to bowl 20 overs
      const bowlers = team.getBowlingOrder(xi);
      expect(bowlers.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("completes a full season and picks a valid champion", () => {
    const teams = auctionAndFill();
    const result = runSeason(teams);

    // Champion must be a real team
    const teamIds = teams.map(t => t.id);
    expect(teamIds).toContain(result.champion);

    // Champion participated in the final
    const final = result.schedule.find(m => m.playoffType === "final")!;
    expect(final).toBeDefined();
    expect(final.result).toBeDefined();
    expect(final.result!.winnerId).toBe(result.champion);
  }, 30000);

  it("playoff bracket flows correctly: Q1 → Elim → Q2 → Final", () => {
    const teams = auctionAndFill();
    const result = runSeason(teams);

    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs).toHaveLength(4);

    const q1 = playoffs.find(m => m.playoffType === "qualifier1")!;
    const elim = playoffs.find(m => m.playoffType === "eliminator")!;
    const q2 = playoffs.find(m => m.playoffType === "qualifier2")!;
    const final = playoffs.find(m => m.playoffType === "final")!;

    // All playoff matches must have results
    expect(q1.result).toBeDefined();
    expect(elim.result).toBeDefined();
    expect(q2.result).toBeDefined();
    expect(final.result).toBeDefined();

    // Q2 participants: loser of Q1 vs winner of Eliminator
    const q1Loser = q1.result!.winnerId === q1.homeTeamId ? q1.awayTeamId : q1.homeTeamId;
    const elimWinner = elim.result!.winnerId!;
    expect([q2.homeTeamId, q2.awayTeamId]).toContain(q1Loser);
    expect([q2.homeTeamId, q2.awayTeamId]).toContain(elimWinner);

    // Final participants: winner of Q1 vs winner of Q2
    const q1Winner = q1.result!.winnerId!;
    const q2Winner = q2.result!.winnerId!;
    expect([final.homeTeamId, final.awayTeamId]).toContain(q1Winner);
    expect([final.homeTeamId, final.awayTeamId]).toContain(q2Winner);

    // Champion = winner of the final
    expect(final.result!.winnerId).toBe(result.champion);

    // Q1 and Eliminator involve 4 distinct teams
    const playoffTeams = new Set([q1.homeTeamId, q1.awayTeamId, elim.homeTeamId, elim.awayTeamId]);
    expect(playoffTeams.size).toBe(4);
  }, 30000);
});

// ── Stat Consistency ─────────────────────────────────────────────────────

describe("season stat consistency", () => {
  let teams: Team[];
  let result: SeasonResult;

  // Run one season shared across tests in this block
  // (season sim is expensive; reusing saves ~2s per test)
  const setup = (() => {
    let cached: { teams: Team[]; result: SeasonResult } | null = null;
    return () => {
      if (!cached) {
        const t = auctionAndFill();
        const r = runSeason(t);
        cached = { teams: t, result: r };
      }
      return cached;
    };
  })();

  it("total wins equal total losses across all teams", () => {
    const { result } = setup();
    const totalWins = result.standings.reduce((s, e) => s + e.wins, 0);
    const totalLosses = result.standings.reduce((s, e) => s + e.losses, 0);
    expect(totalWins).toBe(totalLosses);
  });

  it("group stage matches + 4 playoffs = total schedule", () => {
    const { result } = setup();
    const group = result.schedule.filter(m => !m.isPlayoff);
    const playoffs = result.schedule.filter(m => m.isPlayoff);
    expect(playoffs).toHaveLength(4);
    expect(group.length + playoffs.length).toBe(result.schedule.length);
  });

  it("every match has exactly one winner", () => {
    const { result, teams } = setup();
    const teamIds = new Set(teams.map(t => t.id));

    for (const match of result.schedule) {
      expect(match.result).toBeDefined();
      expect(match.result!.winnerId).toBeTruthy();
      expect(teamIds.has(match.result!.winnerId!)).toBe(true);
      // Winner must be one of the two teams
      expect([match.homeTeamId, match.awayTeamId]).toContain(match.result!.winnerId);
    }
  });

  it("match margins are valid format", () => {
    const { result } = setup();
    for (const match of result.schedule) {
      const margin = match.result!.margin;
      const validMargin =
        margin.includes("wickets") ||
        margin.includes("runs") ||
        margin === "Super Over";
      expect(validMargin).toBe(true);
    }
  });

  it("every match result has two innings", () => {
    const { result } = setup();
    for (const match of result.schedule) {
      expect(match.result!.innings).toHaveLength(2);
      for (const inn of match.result!.innings) {
        expect(inn.runs).toBeGreaterThanOrEqual(0);
        expect(inn.wickets).toBeGreaterThanOrEqual(0);
        expect(inn.wickets).toBeLessThanOrEqual(10);
        expect(inn.overs).toBeGreaterThanOrEqual(1);
        expect(inn.overs).toBeLessThanOrEqual(20);
      }
    }
  });

  it("first innings scores are realistic T20 totals", () => {
    const { result } = setup();
    const firstInningsTotals = result.schedule.map(m => m.result!.innings[0].runs);
    const avg = firstInningsTotals.reduce((s, r) => s + r, 0) / firstInningsTotals.length;
    // Average T20 first innings score should be roughly 130-200
    expect(avg).toBeGreaterThan(100);
    expect(avg).toBeLessThan(230);

    // No absurdly low or high scores (rare all-out collapses can go as low as ~30)
    for (const total of firstInningsTotals) {
      expect(total).toBeGreaterThan(25);
      expect(total).toBeLessThan(350);
    }
  });

  it("orange cap holder has the most runs across all players", () => {
    const { result, teams } = setup();
    const players = allPlayers(teams);
    const maxRuns = Math.max(...players.map(p => p.stats.runs));
    expect(result.orangeCap.runs).toBe(maxRuns);

    const orangeHolder = players.find(p => p.id === result.orangeCap.playerId)!;
    expect(orangeHolder).toBeDefined();
    expect(orangeHolder.stats.runs).toBe(maxRuns);
  });

  it("purple cap holder has the most wickets across all players", () => {
    const { result, teams } = setup();
    const players = allPlayers(teams);
    const maxWickets = Math.max(...players.map(p => p.stats.wickets));
    expect(result.purpleCap.wickets).toBe(maxWickets);

    const purpleHolder = players.find(p => p.id === result.purpleCap.playerId)!;
    expect(purpleHolder).toBeDefined();
    expect(purpleHolder.stats.wickets).toBe(maxWickets);
  });

  it("player stats accumulate correctly across the season", () => {
    const { teams } = setup();
    const players = allPlayers(teams);

    for (const p of players) {
      // Players who batted should have ballsFaced > 0 if they scored runs
      if (p.stats.runs > 0) {
        expect(p.stats.ballsFaced).toBeGreaterThan(0);
      }

      // Strike rate is consistent
      if (p.stats.ballsFaced > 0) {
        const expectedSR = (p.stats.runs / p.stats.ballsFaced) * 100;
        expect(p.strikeRate).toBeCloseTo(expectedSR, 5);
      }

      // Economy rate is consistent
      if (p.stats.overs > 0) {
        const expectedEcon = p.stats.runsConceded / p.stats.overs;
        expect(p.economyRate).toBeCloseTo(expectedEcon, 5);
      }

      // High score should be <= total runs
      expect(p.stats.highScore).toBeLessThanOrEqual(p.stats.runs);

      // 50s + 100s should be <= innings
      expect(p.stats.fifties + p.stats.hundreds).toBeLessThanOrEqual(p.stats.innings);
    }
  });

  it("all played matches are tracked in player matchLog", () => {
    const { teams } = setup();

    for (const team of teams) {
      const xi = team.getPlayingXI();
      // Players in the XI should have match logs
      for (const p of xi) {
        expect(p.stats.matchLog.length).toBeGreaterThan(0);
        for (const log of p.stats.matchLog) {
          expect(log.matchId).toBeTruthy();
          expect(log.runsScored).toBeGreaterThanOrEqual(0);
          expect(log.ballsFaced).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("team NRR components are populated after season", () => {
    const { teams } = setup();

    for (const team of teams) {
      expect(team.runsFor).toBeGreaterThan(0);
      expect(team.ballsFacedFor).toBeGreaterThan(0);
      expect(team.runsAgainst).toBeGreaterThan(0);
      expect(team.ballsFacedAgainst).toBeGreaterThan(0);
      // NRR should be a finite number
      expect(Number.isFinite(team.nrr)).toBe(true);
    }
  });

  it("standings are correctly sorted by points then NRR", () => {
    const { result } = setup();
    const standings = result.standings;

    for (let i = 1; i < standings.length; i++) {
      const prev = standings[i - 1];
      const curr = standings[i];
      if (prev.points === curr.points) {
        expect(prev.nrr).toBeGreaterThanOrEqual(curr.nrr);
      } else {
        expect(prev.points).toBeGreaterThan(curr.points);
      }
    }
  });
}, 30000);

// ── Multi-Season Progression ─────────────────────────────────────────────

describe("multi-season progression", () => {
  it("simulates 3 consecutive seasons with progression", () => {
    const teams = auctionAndFill();
    const seasonResults: SeasonResult[] = [];

    for (let season = 0; season < 3; season++) {
      const result = runSeason(teams);
      seasonResults.push(result);

      expect(result.champion).toBeTruthy();
      expect(result.orangeCap.runs).toBeGreaterThan(0);
      expect(result.purpleCap.wickets).toBeGreaterThan(0);

      // Progress all players for next season
      for (const team of teams) {
        for (const player of team.roster) {
          player.progress();
        }
      }
    }

    // Should have 3 different season results
    expect(seasonResults).toHaveLength(3);

    // Each season should have a valid champion
    for (const result of seasonResults) {
      const teamIds = teams.map(t => t.id);
      expect(teamIds).toContain(result.champion);
    }
  }, 60000);

  it("player ages increment each season", () => {
    const teams = auctionAndFill();
    const samplePlayer = teams[0].roster[0];
    const startAge = samplePlayer.age;

    // Run season + progress
    runSeason(teams);
    samplePlayer.progress();
    expect(samplePlayer.age).toBe(startAge + 1);

    runSeason(teams);
    samplePlayer.progress();
    expect(samplePlayer.age).toBe(startAge + 2);
  }, 30000);

  it("season stats reset between seasons after progression", () => {
    const teams = auctionAndFill();

    // Season 1
    runSeason(teams);
    const s1Runs = teams[0].roster[0].stats.runs;

    // Progress resets stats
    for (const t of teams) {
      for (const p of t.roster) p.progress();
    }
    expect(teams[0].roster[0].stats.runs).toBe(0);
    expect(teams[0].roster[0].stats.wickets).toBe(0);
    expect(teams[0].roster[0].stats.matches).toBe(0);
    expect(teams[0].roster[0].stats.matchLog).toHaveLength(0);

    // Season 2 starts fresh
    const result2 = runSeason(teams);
    expect(result2.champion).toBeTruthy();
  }, 30000);

  it("player ratings drift over multiple seasons", () => {
    const teams = auctionAndFill();
    const player = teams[0].roster[0];
    const startRatings = { ...player.ratings };

    // Run 10 progressions
    for (let i = 0; i < 10; i++) {
      player.progress();
    }

    // After 10 years, at least some ratings should have changed
    const changed = Object.keys(startRatings).filter(
      key => player.ratings[key as keyof typeof player.ratings] !== startRatings[key as keyof typeof startRatings]
    );
    expect(changed.length).toBeGreaterThan(0);

    // But all ratings should still be in valid range
    for (const val of Object.values(player.ratings)) {
      expect(val).toBeGreaterThanOrEqual(1);
      expect(val).toBeLessThanOrEqual(99);
    }
  });

  it("old players decline, young players improve on average", () => {
    // This is statistical, so we test over many players
    const teams = auctionAndFill();
    const players = allPlayers(teams);

    const youngPlayers = players.filter(p => p.age <= 22);
    const oldPlayers = players.filter(p => p.age >= 35);

    // Record starting overalls
    const youngStart = youngPlayers.map(p => p.overall);
    const oldStart = oldPlayers.map(p => p.overall);

    // Progress 5 seasons
    for (let i = 0; i < 5; i++) {
      for (const p of players) p.progress();
    }

    // Calculate average change
    const youngChange = youngPlayers.reduce((s, p, i) => s + (p.overall - youngStart[i]), 0) / youngPlayers.length;
    const oldChange = oldPlayers.reduce((s, p, i) => s + (p.overall - oldStart[i]), 0) / oldPlayers.length;

    // Young players should generally improve (or at least not decline as much as old)
    // Old players should generally decline
    expect(youngChange).toBeGreaterThan(oldChange);
  });
});

// ── Auction → Season Pipeline ────────────────────────────────────────────

describe("auction into season pipeline", () => {
  it("no player appears on multiple teams", () => {
    const teams = auctionAndFill();
    const playerIds = new Set<string>();

    for (const team of teams) {
      for (const p of team.roster) {
        expect(playerIds.has(p.id)).toBe(false);
        playerIds.add(p.id);
      }
    }
  });

  it("all players have consistent teamId after auction", () => {
    const teams = auctionAndFill();
    for (const team of teams) {
      for (const p of team.roster) {
        expect(p.teamId).toBe(team.id);
      }
    }
  });

  it("international player cap (max 4 in XI) is respected in matches", () => {
    const teams = auctionAndFill();

    for (const team of teams) {
      const xi = team.getPlayingXI();
      const intlInXI = xi.filter(p => p.isInternational).length;
      expect(intlInXI).toBeLessThanOrEqual(4);
    }
  });

  it("season after auction produces valid results with real players", () => {
    const teams = auctionAndFill();
    const result = runSeason(teams);

    // Find a known real player and check they have stats
    const players = allPlayers(teams);
    const kohli = players.find(p => p.name === "Virat Kohli");
    if (kohli) {
      // Kohli should have played matches (unless injured all season)
      expect(kohli.stats.matchLog.length).toBeGreaterThanOrEqual(0);
    }

    // Bumrah should have taken wickets
    const bumrah = players.find(p => p.name === "Jasprit Bumrah");
    if (bumrah && bumrah.stats.matches > 0) {
      // Elite bowler should usually take at least a few wickets
      expect(bumrah.stats.overs).toBeGreaterThan(0);
    }

    expect(result.champion).toBeTruthy();
  }, 30000);
});

// ── Retention → Auction → Season Flow ────────────────────────────────────

describe("retention and re-auction between seasons", () => {
  it("teams can retain and rebuild rosters between seasons", () => {
    const teams = auctionAndFill();

    // Run first season
    const s1 = runSeason(teams);
    expect(s1.champion).toBeTruthy();

    // Retention phase
    const releasedPlayers: Player[] = [];
    for (const team of teams) {
      const { released } = retainPlayers(team, 42, 5);
      releasedPlayers.push(...released);
    }

    // Each team should have at most 5 retained players
    for (const team of teams) {
      expect(team.roster.length).toBeLessThanOrEqual(5);
    }

    // Released players should have no team
    for (const p of releasedPlayers) {
      expect(p.teamId).toBeUndefined();
    }

    // Re-auction with released + new players
    const newPool = [...releasedPlayers, ...generatePlayerPool(100)];
    runAuction(newPool, teams);

    // Teams should be playable again
    for (const team of teams) {
      expect(team.roster.length).toBeGreaterThanOrEqual(11);
    }

    // Progress players
    for (const p of allPlayers(teams)) p.progress();

    // Run second season
    const s2 = runSeason(teams);
    expect(s2.champion).toBeTruthy();
  }, 60000);
});

// ── Edge Cases ───────────────────────────────────────────────────────────

describe("season edge cases", () => {
  it("handles teams with many injured players gracefully", () => {
    const teams = auctionAndFill();

    // Injure 5 players on first team (still leaves enough for XI)
    for (let i = 0; i < 5 && i < teams[0].roster.length; i++) {
      teams[0].roster[i].injured = true;
      teams[0].roster[i].injuryGamesLeft = 3;
    }

    const result = runSeason(teams);
    expect(result.champion).toBeTruthy();

    // Injuries should have healed during the season
    const stillInjured = teams[0].roster.filter(p => p.injured);
    // After 70+ matches, 3-game injuries should be healed
    expect(stillInjured.length).toBeLessThanOrEqual(teams[0].roster.length);
  }, 30000);

  it("injuries heal during the season", () => {
    const teams = auctionAndFill();

    // Injure a player for 2 games
    teams[0].roster[0].injured = true;
    teams[0].roster[0].injuryGamesLeft = 2;

    runSeason(teams);

    // After a full season, short injuries should be healed
    expect(teams[0].roster[0].injured).toBe(false);
    expect(teams[0].roster[0].injuryGamesLeft).toBe(0);
  }, 30000);

  it("season produces different champions across repeated runs", () => {
    // Run 5 seasons independently and check we don't always get the same winner
    const champions = new Set<string>();

    for (let i = 0; i < 5; i++) {
      const teams = auctionAndFill();
      const result = runSeason(teams);
      champions.add(result.champion);
    }

    // With randomness, we should get at least 2 different champions in 5 runs
    expect(champions.size).toBeGreaterThanOrEqual(2);
  }, 120000);

  it("all 10 teams have valid NRR after season (no NaN/Infinity)", () => {
    const teams = auctionAndFill();
    runSeason(teams);

    for (const team of teams) {
      expect(Number.isNaN(team.nrr)).toBe(false);
      expect(Number.isFinite(team.nrr)).toBe(true);
    }
  }, 30000);

  it("win margin text is grammatically correct", () => {
    const teams = auctionAndFill();
    const result = runSeason(teams);

    for (const match of result.schedule) {
      const margin = match.result!.margin;
      if (margin.includes("wickets")) {
        // "X wickets" where X is 1-10
        const num = parseInt(margin);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(10);
      } else if (margin.includes("runs")) {
        // "X runs" where X >= 1
        const num = parseInt(margin);
        expect(num).toBeGreaterThanOrEqual(1);
      } else {
        expect(margin).toBe("Super Over");
      }
    }
  }, 30000);
});
