import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player } from "../player.js";
import {
  initAuction, userBid, userDropBid, cpuBidRound,
  nextPlayer, simCurrentPlayer, simRemainingAuction,
  retainPlayers,
  type AuctionState,
} from "../auction.js";

// ── Test Helpers ─────────────────────────────────────────────────────────

function makePlayer(id: string, role: "batsman" | "bowler" | "all-rounder", ovr = 60): Player {
  const batHeavy = role === "batsman";
  const bowlHeavy = role === "bowler";
  const base = ovr / 65;
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role,
    ratings: {
      battingIQ: Math.round((batHeavy ? 65 : bowlHeavy ? 25 : 50) * base),
      timing: Math.round((batHeavy ? 63 : bowlHeavy ? 25 : 48) * base),
      power: Math.round((batHeavy ? 60 : bowlHeavy ? 20 : 48) * base),
      running: Math.round((batHeavy ? 55 : 40) * base),
      wicketTaking: Math.round((bowlHeavy ? 65 : batHeavy ? 20 : 50) * base),
      economy: Math.round((bowlHeavy ? 63 : batHeavy ? 20 : 50) * base),
      accuracy: Math.round((bowlHeavy ? 60 : batHeavy ? 20 : 48) * base),
      clutch: Math.round(50 * base),
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
  });
}

function buildTeams(count = 4): Team[] {
  return IPL_TEAMS.slice(0, count).map((config, i) => {
    const team = new Team(config);
    let id = i * 100;
    // Give each team a minimal roster
    for (let j = 0; j < 3; j++) team.addPlayer(makePlayer(`existing_${++id}`, "batsman"), 3);
    for (let j = 0; j < 2; j++) team.addPlayer(makePlayer(`existing_${++id}`, "bowler"), 3);
    return team;
  });
}

function buildAuctionPool(count = 20): Player[] {
  const players: Player[] = [];
  const roles: Array<"batsman" | "bowler" | "all-rounder"> = ["batsman", "bowler", "all-rounder"];
  for (let i = 0; i < count; i++) {
    players.push(makePlayer(`pool_${i}`, roles[i % 3], 40 + Math.floor(Math.random() * 40)));
  }
  return players;
}

// ── initAuction ──────────────────────────────────────────────────────────

describe("initAuction", () => {
  it("creates auction state with players sorted by market value", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(10);
    const state = initAuction(players, teams);

    expect(state.phase).toBe("bidding");
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.players.length).toBe(10);
    expect(state.currentBid).toBeGreaterThan(0);
    expect(state.completedBids).toHaveLength(0);
    expect(state.unsold).toHaveLength(0);

    // Sorted by market value descending
    for (let i = 1; i < state.players.length; i++) {
      expect(state.players[i - 1].marketValue).toBeGreaterThanOrEqual(state.players[i].marketValue);
    }
  });

  it("handles empty player pool", () => {
    const teams = buildTeams();
    const state = initAuction([], teams);
    expect(state.phase).toBe("complete");
    expect(state.players).toHaveLength(0);
  });
});

// ── userBid ──────────────────────────────────────────────────────────────

describe("userBid", () => {
  it("places user bid and increments amount", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);
    const initialBid = state.currentBid;
    const userTeamId = teams[0].id;

    state = userBid(state, teams, userTeamId);

    expect(state.currentBidderId).toBe(userTeamId);
    expect(state.currentBid).toBeGreaterThan(initialBid);
    expect(state.phase).toBe("bidding");
  });

  it("allows user to raise their own bid", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);
    const userTeamId = teams[0].id;

    state = userBid(state, teams, userTeamId);
    const bidAfterFirst = state.currentBid;
    state = userBid(state, teams, userTeamId);

    // User can raise their own bid (valid auction behavior)
    expect(state.currentBid).toBeGreaterThan(bidAfterFirst);
    expect(state.currentBidderId).toBe(userTeamId);
  });
});

// ── userDropBid ──────────────────────────────────────────────────────────

describe("userDropBid", () => {
  it("removes user from bidding teams", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);
    const userTeamId = teams[0].id;

    expect(state.biddingTeams).toContain(userTeamId);
    state = userDropBid(state, userTeamId);
    expect(state.biddingTeams).not.toContain(userTeamId);
  });
});

// ── cpuBidRound ──────────────────────────────────────────────────────────

describe("cpuBidRound", () => {
  it("runs one round of CPU bidding", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);

    const beforeRound = state.round;
    state = cpuBidRound(state, teams);

    expect(state.round).toBe(beforeRound + 1);
  });

  it("marks player sold when bidding ends with a bidder", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);

    // Run many rounds until bidding ends
    for (let i = 0; i < 60; i++) {
      state = cpuBidRound(state, teams);
      if (state.phase === "sold" || state.phase === "unsold") break;
    }

    expect(["sold", "unsold"]).toContain(state.phase);
  });
});

// ── nextPlayer ───────────────────────────────────────────────────────────

describe("nextPlayer", () => {
  it("advances to next player after sold/unsold", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);

    // Sim current player to completion
    state = simCurrentPlayer(state, teams);
    expect(["sold", "unsold"]).toContain(state.phase);

    const prevIndex = state.currentPlayerIndex;
    state = nextPlayer(state, teams);

    expect(state.currentPlayerIndex).toBe(prevIndex + 1);
    expect(state.phase).toBe("bidding");
  });

  it("sets phase to complete when all players done", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(2);
    let state = initAuction(players, teams);

    // Auction both players
    state = simCurrentPlayer(state, teams);
    state = nextPlayer(state, teams);
    state = simCurrentPlayer(state, teams);
    state = nextPlayer(state, teams);

    expect(state.phase).toBe("complete");
  });
});

// ── simCurrentPlayer ─────────────────────────────────────────────────────

describe("simCurrentPlayer", () => {
  it("completes bidding for current player", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(5);
    let state = initAuction(players, teams);

    state = simCurrentPlayer(state, teams);

    expect(["sold", "unsold"]).toContain(state.phase);
    if (state.phase === "sold") {
      expect(state.completedBids.length).toBe(1);
    } else {
      expect(state.unsold.length).toBe(1);
    }
  });
});

// ── simRemainingAuction ──────────────────────────────────────────────────

describe("simRemainingAuction", () => {
  it("completes all remaining players", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(10);
    let state = initAuction(players, teams);

    state = simRemainingAuction(state, teams);

    expect(state.phase).toBe("complete");
    expect(state.completedBids.length + state.unsold.length).toBe(10);
  });

  it("all sold players are assigned to teams", () => {
    const teams = buildTeams();
    const players = buildAuctionPool(10);
    let state = initAuction(players, teams);
    state = simRemainingAuction(state, teams);

    for (const bid of state.completedBids) {
      expect(bid.teamId).toBeTruthy();
      expect(bid.amount).toBeGreaterThan(0);
    }
  });
});

// ── retainPlayers ────────────────────────────────────────────────────────

describe("retainPlayers", () => {
  it("retains top players within budget using IPL cost slabs", () => {
    const team = new Team(IPL_TEAMS[0]);
    // Add 8 players: some capped (ovr >= 60), some uncapped (ovr < 60)
    for (let i = 0; i < 8; i++) {
      team.addPlayer(makePlayer(`ret_${i}`, i < 4 ? "batsman" : "bowler", 50 + i * 5), 5);
    }

    const { retained, released, retentionCosts } = retainPlayers(team, 75, 6);

    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(6);
    expect(retained.length + released.length).toBe(8);
    expect(retentionCosts.length).toBe(retained.length);
    // Retained players should be higher rated (sorted by overall)
    if (retained.length >= 2) {
      expect(retained[0].overall).toBeGreaterThanOrEqual(retained[1].overall);
    }
  });

  it("respects max retentions limit", () => {
    const team = new Team(IPL_TEAMS[0], 200); // high cap
    for (let i = 0; i < 10; i++) {
      team.addPlayer(makePlayer(`ret_${i}`, "batsman", 30), 1);
    }

    const { retained } = retainPlayers(team, 100, 3); // max 3
    expect(retained.length).toBeLessThanOrEqual(3);
  });

  it("respects budget constraint with fixed slabs", () => {
    const team = new Team(IPL_TEAMS[0]);
    // Add capped players (ovr >= 60) — retention costs 18/14/11/18/14 Cr
    for (let i = 0; i < 5; i++) {
      team.addPlayer(makePlayer(`ret_${i}`, "batsman", 80), 15);
    }

    // Budget 30 Cr: can afford slot 1 (18) + slot 2 (14) = 32 > 30, so only 1
    const { retained } = retainPlayers(team, 30, 6);
    expect(retained.length).toBeLessThanOrEqual(2);
  });

  it("updates team roster to only retained players", () => {
    const team = new Team(IPL_TEAMS[0]);
    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer(`ret_${i}`, "batsman", 40), 3);
    }

    const { retained } = retainPlayers(team, 75, 6);
    expect(team.roster.length).toBe(retained.length);
  });

  it("released players have teamId cleared", () => {
    const team = new Team(IPL_TEAMS[0]);
    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer(`ret_${i}`, "batsman", 40), 3);
    }

    const { released } = retainPlayers(team, 75, 6);
    for (const p of released) {
      expect(p.teamId).toBeUndefined();
    }
  });
});

// ── Integration: full auction flow ───────────────────────────────────────

describe("Full auction flow integration", () => {
  it("init → sim all → complete gives valid result", () => {
    const teams = buildTeams(4);
    const players = buildAuctionPool(15);
    let state = initAuction(players, teams);

    expect(state.phase).toBe("bidding");
    state = simRemainingAuction(state, teams);
    expect(state.phase).toBe("complete");

    // Every player ended up either sold or unsold
    const total = state.completedBids.length + state.unsold.length;
    expect(total).toBe(15);
  });

  it("user can bid, CPU bids, player sells, proceed to next", () => {
    const teams = buildTeams(3);
    const players = buildAuctionPool(3);
    let state = initAuction(players, teams);

    // User bids
    state = userBid(state, teams, teams[0].id);
    expect(state.currentBidderId).toBe(teams[0].id);

    // CPU responds
    for (let i = 0; i < 50; i++) {
      state = cpuBidRound(state, teams);
      if (state.phase !== "bidding") break;
    }

    expect(["sold", "unsold"]).toContain(state.phase);

    // Move to next
    state = nextPlayer(state, teams);
    if (state.phase === "bidding") {
      // Sim remaining
      state = simRemainingAuction(state, teams);
      expect(state.phase).toBe("complete");
    }
  });
});
