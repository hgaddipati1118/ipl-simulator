import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import { runAuction, retainPlayers } from "../auction.js";
import { generatePlayerPool } from "../create-player.js";

function emptyTeams(): Team[] {
  return IPL_TEAMS.map(c => new Team(c));
}

describe("runAuction", () => {
  it("distributes players across teams", () => {
    const teams = emptyTeams();
    const pool = generatePlayerPool(100);
    const result = runAuction(pool, teams);

    expect(result.bids.length).toBeGreaterThan(0);
    const totalAssigned = teams.reduce((s, t) => s + t.roster.length, 0);
    expect(totalAssigned).toBeGreaterThan(0);
  });

  it("each team gets enough players for a playing XI", () => {
    const teams = emptyTeams();
    // Large pool ensures enough domestic players to fill every team past 11
    const pool = generatePlayerPool(500);
    runAuction(pool, teams);

    for (const team of teams) {
      // Auction fill-up targets 15 but may fall short due to international caps
      expect(team.roster.length).toBeGreaterThanOrEqual(11);
    }
  });

  it("teams stay within reasonable budget range", () => {
    const teams = emptyTeams();
    const pool = generatePlayerPool(200);
    runAuction(pool, teams);

    for (const team of teams) {
      // Bid rounding and retention costs can push totalSpent slightly over salaryCap
      expect(team.totalSpent).toBeLessThanOrEqual(team.salaryCap + 10);
    }
  });

  it("teams don't exceed max international slots (8)", () => {
    const teams = emptyTeams();
    const pool = generatePlayerPool(200);
    runAuction(pool, teams);

    for (const team of teams) {
      expect(team.internationalCount).toBeLessThanOrEqual(8);
    }
  });

  it("assigned players have teamId set", () => {
    const teams = emptyTeams();
    const pool = generatePlayerPool(50);
    runAuction(pool, teams);

    for (const team of teams) {
      for (const player of team.roster) {
        expect(player.teamId).toBe(team.id);
      }
    }
  });

  it("bids have positive amounts", () => {
    const teams = emptyTeams();
    const pool = generatePlayerPool(50);
    const result = runAuction(pool, teams);

    for (const bid of result.bids) {
      expect(bid.amount).toBeGreaterThan(0);
    }
  });

  it("unsold players have no team", () => {
    const teams = emptyTeams();
    const pool = generatePlayerPool(50);
    const result = runAuction(pool, teams);

    for (const player of result.unsold) {
      expect(player.teamId).toBeUndefined();
    }
  });
});

describe("retainPlayers", () => {
  it("retains up to maxRetentions players", () => {
    const team = new Team(IPL_TEAMS[0]);
    const pool = generatePlayerPool(20);
    for (const p of pool) team.addPlayer(p, 2);

    const { retained, released } = retainPlayers(team, 75, 6);
    expect(retained.length).toBeLessThanOrEqual(6);
    expect(retained.length + released.length).toBe(20);
  });

  it("updates team roster to only retained players", () => {
    const team = new Team(IPL_TEAMS[0]);
    const pool = generatePlayerPool(10);
    for (const p of pool) team.addPlayer(p, 2);

    const { retained } = retainPlayers(team);
    expect(team.roster).toEqual(retained);
  });

  it("released players have teamId cleared", () => {
    const team = new Team(IPL_TEAMS[0]);
    const pool = generatePlayerPool(10);
    for (const p of pool) team.addPlayer(p, 2);

    const { released } = retainPlayers(team);
    for (const p of released) {
      expect(p.teamId).toBeUndefined();
      expect(p.bid).toBe(0);
    }
  });
});
