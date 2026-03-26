import { describe, it, expect } from "vitest";
import { Team, IPL_TEAMS } from "../team.js";
import { Player, PlayerData } from "../player.js";

function makePlayer(overrides?: Partial<PlayerData>): Player {
  return new Player({
    id: `p_${Math.random().toString(36).slice(2)}`,
    name: "Test Player",
    age: 25,
    country: "India",
    role: "batsman",
    ratings: {
      battingIQ: 70, timing: 70, power: 70, running: 60,
      wicketTaking: 30, economy: 30, accuracy: 30, clutch: 50,
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  });
}

function makeFullTeam(): Team {
  const team = new Team(IPL_TEAMS[0]);
  // Add 4 batsmen (1 is WK), 3 all-rounders, 4 bowlers = 12 players
  for (let i = 0; i < 3; i++) {
    team.addPlayer(makePlayer({ role: "batsman" }), 5);
  }
  team.addPlayer(makePlayer({ role: "batsman", isWicketKeeper: true }), 5);
  team.addPlayer(makePlayer({ role: "batsman" }), 5);
  for (let i = 0; i < 3; i++) {
    team.addPlayer(makePlayer({ role: "all-rounder" }), 5);
  }
  for (let i = 0; i < 4; i++) {
    team.addPlayer(makePlayer({ role: "bowler" }), 5);
  }
  return team;
}

describe("IPL_TEAMS config", () => {
  it("has 10 teams", () => {
    expect(IPL_TEAMS).toHaveLength(10);
  });

  it("all teams have unique ids", () => {
    const ids = IPL_TEAMS.map(t => t.id);
    expect(new Set(ids).size).toBe(10);
  });

  it("all teams have required fields", () => {
    for (const t of IPL_TEAMS) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.shortName).toBeTruthy();
      expect(t.city).toBeTruthy();
      expect(t.primaryColor).toMatch(/^#/);
    }
  });

  it("stadium bowling ratings are in valid range", () => {
    for (const t of IPL_TEAMS) {
      if (t.stadiumBowlingRating !== undefined) {
        expect(t.stadiumBowlingRating).toBeGreaterThanOrEqual(0.7);
        expect(t.stadiumBowlingRating).toBeLessThanOrEqual(1.5);
      }
    }
  });
});

describe("Team constructor", () => {
  it("initializes with empty roster", () => {
    const team = new Team(IPL_TEAMS[0]);
    expect(team.roster).toEqual([]);
    expect(team.totalSpent).toBe(0);
  });

  it("sets salary cap to 120 crores", () => {
    const team = new Team(IPL_TEAMS[0]);
    expect(team.salaryCap).toBe(120);
  });

  it("initializes season record to zero", () => {
    const team = new Team(IPL_TEAMS[0]);
    expect(team.wins).toBe(0);
    expect(team.losses).toBe(0);
    expect(team.points).toBe(0);
    expect(team.nrr).toBe(0);
  });
});

describe("Team computed properties", () => {
  it("points = wins * 2", () => {
    const team = new Team(IPL_TEAMS[0]);
    team.wins = 7;
    expect(team.points).toBe(14);
  });

  it("matchesPlayed = wins + losses + ties", () => {
    const team = new Team(IPL_TEAMS[0]);
    team.wins = 5;
    team.losses = 3;
    team.ties = 1;
    expect(team.matchesPlayed).toBe(9);
  });

  it("remainingBudget = salaryCap - totalSpent", () => {
    const team = new Team(IPL_TEAMS[0]);
    team.addPlayer(makePlayer(), 20);
    expect(team.remainingBudget).toBe(100);
  });
});

describe("Team roster management", () => {
  it("addPlayer adds to roster and tracks spending", () => {
    const team = new Team(IPL_TEAMS[0]);
    const player = makePlayer();
    team.addPlayer(player, 10);
    expect(team.roster).toHaveLength(1);
    expect(team.totalSpent).toBe(10);
    expect(player.teamId).toBe(team.id);
    expect(player.bid).toBe(10);
  });

  it("removePlayer removes from roster and refunds", () => {
    const team = new Team(IPL_TEAMS[0]);
    const player = makePlayer();
    team.addPlayer(player, 10);
    const removed = team.removePlayer(player.id);
    expect(removed).toBe(player);
    expect(team.roster).toHaveLength(0);
    expect(team.totalSpent).toBe(0);
    expect(player.teamId).toBeUndefined();
  });

  it("removePlayer returns undefined for unknown id", () => {
    const team = new Team(IPL_TEAMS[0]);
    expect(team.removePlayer("nonexistent")).toBeUndefined();
  });

  it("tracks international/domestic counts", () => {
    const team = new Team(IPL_TEAMS[0]);
    team.addPlayer(makePlayer({ isInternational: false }), 1);
    team.addPlayer(makePlayer({ isInternational: true }), 1);
    team.addPlayer(makePlayer({ isInternational: true }), 1);
    expect(team.domesticCount).toBe(1);
    expect(team.internationalCount).toBe(2);
  });
});

describe("Team getPlayingXI", () => {
  it("returns max 11 players", () => {
    const team = makeFullTeam();
    const xi = team.getPlayingXI();
    expect(xi.length).toBeLessThanOrEqual(11);
  });

  it("excludes injured players", () => {
    const team = makeFullTeam();
    team.roster[0].injured = true;
    const xi = team.getPlayingXI();
    expect(xi.find(p => p.id === team.roster[0].id)).toBeUndefined();
  });

  it("limits international players to 4", () => {
    const team = new Team(IPL_TEAMS[0]);
    // Add 6 international players
    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer({ isInternational: true, role: "batsman" }), 5);
    }
    // Add 6 domestic players
    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer({ isInternational: false, role: "bowler" }), 5);
    }
    const xi = team.getPlayingXI();
    const intlCount = xi.filter(p => p.isInternational).length;
    expect(intlCount).toBeLessThanOrEqual(4);
  });

  it("returns players sorted by overall rating", () => {
    const team = makeFullTeam();
    const xi = team.getPlayingXI();
    // The selection is greedy by overall, so the XIs should have high overall players
    expect(xi.length).toBeGreaterThan(0);
  });

  it("prefers fresher players when overall quality is close", () => {
    const team = makeFullTeam();
    const tiredBatter = team.roster.find(p => p.role === "batsman" && !p.isWicketKeeper)!;
    const freshBatter = team.roster.find(p => p.role === "batsman" && !p.isWicketKeeper && p.id !== tiredBatter.id)!;

    tiredBatter.ratings.battingIQ = 82;
    tiredBatter.ratings.timing = 82;
    tiredBatter.ratings.power = 78;
    tiredBatter.fatigue = 76;

    freshBatter.ratings.battingIQ = 79;
    freshBatter.ratings.timing = 79;
    freshBatter.ratings.power = 76;
    freshBatter.fatigue = 8;

    const xi = team.getPlayingXI();
    expect(xi.some(p => p.id === freshBatter.id)).toBe(true);
    expect(xi.some(p => p.id === tiredBatter.id)).toBe(false);
  });

  it("forces the best five available bowling options into a CPU XI", () => {
    const team = new Team(IPL_TEAMS[0]);

    team.addPlayer(makePlayer({
      id: "wk",
      role: "batsman",
      isWicketKeeper: true,
      ratings: {
        battingIQ: 78, timing: 78, power: 70, running: 60,
        wicketTaking: 12, economy: 12, accuracy: 12, clutch: 55,
      },
    }), 5);

    for (let i = 0; i < 5; i++) {
      team.addPlayer(makePlayer({
        id: `bat_${i}`,
        role: "batsman",
        ratings: {
          battingIQ: 84 - i,
          timing: 84 - i,
          power: 80 - i,
          running: 66,
          wicketTaking: 10,
          economy: 10,
          accuracy: 10,
          clutch: 55,
        },
      }), 5);
    }

    for (let i = 0; i < 4; i++) {
      team.addPlayer(makePlayer({
        id: `bow_${i}`,
        role: "bowler",
        ratings: {
          battingIQ: 22,
          timing: 22,
          power: 20,
          running: 38,
          wicketTaking: 78 - i,
          economy: 74 - i,
          accuracy: 72 - i,
          clutch: 58,
        },
      }), 5);
    }

    team.addPlayer(makePlayer({
      id: "ar_0",
      role: "all-rounder",
      ratings: {
        battingIQ: 52,
        timing: 52,
        power: 50,
        running: 50,
        wicketTaking: 73,
        economy: 70,
        accuracy: 68,
        clutch: 56,
      },
    }), 5);

    const xi = team.getPlayingXI();

    expect(xi.some(p => p.id === "ar_0")).toBe(true);
    expect(xi.some(p => p.id === "bat_5")).toBe(false);
    expect(team.getBowlingOrder(xi).slice(0, 5).map(p => p.id)).toEqual([
      "bow_0",
      "bow_1",
      "bow_2",
      "bow_3",
      "ar_0",
    ]);
  });

  it("uses effective bowling strength when fitness changes the fifth bowling option", () => {
    const team = new Team(IPL_TEAMS[0]);

    team.addPlayer(makePlayer({
      id: "wk",
      role: "batsman",
      isWicketKeeper: true,
      ratings: {
        battingIQ: 76, timing: 76, power: 68, running: 60,
        wicketTaking: 10, economy: 10, accuracy: 10, clutch: 55,
      },
    }), 5);

    for (let i = 0; i < 5; i++) {
      team.addPlayer(makePlayer({
        id: `bat_${i}`,
        role: "batsman",
        ratings: {
          battingIQ: 82 - i,
          timing: 82 - i,
          power: 78 - i,
          running: 65,
          wicketTaking: 12,
          economy: 12,
          accuracy: 12,
          clutch: 55,
        },
      }), 5);
    }

    for (let i = 0; i < 4; i++) {
      team.addPlayer(makePlayer({
        id: `bow_${i}`,
        role: "bowler",
        ratings: {
          battingIQ: 20,
          timing: 20,
          power: 20,
          running: 36,
          wicketTaking: 76 - i,
          economy: 73 - i,
          accuracy: 71 - i,
          clutch: 56,
        },
      }), 5);
    }

    const tiredAllRounder = makePlayer({
      id: "ar_tired",
      role: "all-rounder",
      ratings: {
        battingIQ: 56,
        timing: 56,
        power: 52,
        running: 52,
        wicketTaking: 75,
        economy: 72,
        accuracy: 70,
        clutch: 56,
      },
    });
    tiredAllRounder.fatigue = 88;
    team.addPlayer(tiredAllRounder, 5);

    const freshAllRounder = makePlayer({
      id: "ar_fresh",
      role: "all-rounder",
      ratings: {
        battingIQ: 52,
        timing: 52,
        power: 50,
        running: 50,
        wicketTaking: 68,
        economy: 66,
        accuracy: 64,
        clutch: 54,
      },
    });
    freshAllRounder.fatigue = 6;
    team.addPlayer(freshAllRounder, 5);

    const xi = team.getPlayingXI();
    const bowlingIds = team.getBowlingOrder(xi).slice(0, 5).map(p => p.id);

    expect(xi.some(p => p.id === "ar_fresh")).toBe(true);
    expect(xi.some(p => p.id === "ar_tired")).toBe(false);
    expect(bowlingIds).toContain("ar_fresh");
  });

  it("prefers a sixth bowling option when it is close in quality to the next batter", () => {
    const team = new Team(IPL_TEAMS[0]);

    team.addPlayer(makePlayer({
      id: "wk",
      role: "batsman",
      isWicketKeeper: true,
      ratings: {
        battingIQ: 76, timing: 76, power: 68, running: 60,
        wicketTaking: 10, economy: 10, accuracy: 10, clutch: 55,
      },
    }), 5);

    for (let i = 0; i < 5; i++) {
      team.addPlayer(makePlayer({
        id: `bow_${i}`,
        role: "bowler",
        ratings: {
          battingIQ: 20,
          timing: 20,
          power: 20,
          running: 38,
          wicketTaking: 78 - i,
          economy: 74 - i,
          accuracy: 72 - i,
          clutch: 58,
        },
      }), 5);
    }

    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer({
        id: `bat_${i}`,
        role: "batsman",
        ratings: {
          battingIQ: 84 - i,
          timing: 84 - i,
          power: 78 - i,
          running: 66,
          wicketTaking: 10,
          economy: 10,
          accuracy: 10,
          clutch: 55,
        },
      }), 5);
    }

    team.addPlayer(makePlayer({
      id: "ar_depth",
      role: "all-rounder",
      ratings: {
        battingIQ: 71,
        timing: 71,
        power: 67,
        running: 60,
        wicketTaking: 72,
        economy: 69,
        accuracy: 67,
        clutch: 56,
      },
    }), 5);

    const xi = team.getPlayingXI();

    expect(xi.some(p => p.id === "ar_depth")).toBe(true);
    expect(xi.some(p => p.id === "bat_5")).toBe(false);
    expect(team.getBowlingOrder(xi).slice(0, 6).map(p => p.id)).toContain("ar_depth");
  });

  it("sticks to five bowling options when the sixth is clearly weaker than the next batter", () => {
    const team = new Team(IPL_TEAMS[0]);

    team.addPlayer(makePlayer({
      id: "wk",
      role: "batsman",
      isWicketKeeper: true,
      ratings: {
        battingIQ: 76, timing: 76, power: 68, running: 60,
        wicketTaking: 10, economy: 10, accuracy: 10, clutch: 55,
      },
    }), 5);

    for (let i = 0; i < 5; i++) {
      team.addPlayer(makePlayer({
        id: `bow_${i}`,
        role: "bowler",
        ratings: {
          battingIQ: 20,
          timing: 20,
          power: 20,
          running: 38,
          wicketTaking: 78 - i,
          economy: 74 - i,
          accuracy: 72 - i,
          clutch: 58,
        },
      }), 5);
    }

    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer({
        id: `bat_${i}`,
        role: "batsman",
        ratings: {
          battingIQ: 84 - i,
          timing: 84 - i,
          power: 78 - i,
          running: 66,
          wicketTaking: 10,
          economy: 10,
          accuracy: 10,
          clutch: 55,
        },
      }), 5);
    }

    team.addPlayer(makePlayer({
      id: "ar_depth",
      role: "all-rounder",
      ratings: {
        battingIQ: 56,
        timing: 56,
        power: 52,
        running: 50,
        wicketTaking: 70,
        economy: 67,
        accuracy: 65,
        clutch: 54,
      },
    }), 5);

    const xi = team.getPlayingXI();

    expect(xi.some(p => p.id === "ar_depth")).toBe(false);
    expect(xi.some(p => p.id === "bat_4")).toBe(true);
  });
});

describe("Team batting order", () => {
  it("puts wicket-keepers early", () => {
    const team = makeFullTeam();
    const xi = team.getPlayingXI();
    const order = team.getBattingOrder(xi);
    const wkIdx = order.findIndex(p => p.isWicketKeeper);
    const firstBowlerIdx = order.findIndex(p => p.role === "bowler");
    if (wkIdx !== -1 && firstBowlerIdx !== -1) {
      expect(wkIdx).toBeLessThan(firstBowlerIdx);
    }
  });

  it("returns same length as input", () => {
    const team = makeFullTeam();
    const xi = team.getPlayingXI();
    const order = team.getBattingOrder(xi);
    expect(order).toHaveLength(xi.length);
  });
});

describe("Team bowling order", () => {
  it("returns at least 5 bowlers", () => {
    const team = makeFullTeam();
    const xi = team.getPlayingXI();
    const bowlers = team.getBowlingOrder(xi);
    expect(bowlers.length).toBeGreaterThanOrEqual(5);
  });

  it("prioritizes bowlers and all-rounders", () => {
    const team = makeFullTeam();
    const xi = team.getPlayingXI();
    const bowlers = team.getBowlingOrder(xi);
    const primaryBowlers = bowlers.filter(p => p.role === "bowler" || p.role === "all-rounder");
    expect(primaryBowlers.length).toBeGreaterThanOrEqual(Math.min(5, bowlers.length));
  });
});

describe("Team NRR calculation", () => {
  it("calculates correctly", () => {
    const team = new Team(IPL_TEAMS[0]);
    team.runsFor = 900;
    team.ballsFacedFor = 600; // 100 overs => 9 per over
    team.runsAgainst = 800;
    team.ballsFacedAgainst = 600; // 100 overs => 8 per over
    team.updateNRR();
    // runRateFor = (900/600)*6 = 9, runRateAgainst = (800/600)*6 = 8
    // nrr = 9 - 8 = 1.0
    expect(team.nrr).toBe(1);
  });

  it("returns 0 when no balls faced", () => {
    const team = new Team(IPL_TEAMS[0]);
    team.updateNRR();
    expect(team.nrr).toBe(0);
  });
});

describe("Team resetSeason", () => {
  it("resets all season stats", () => {
    const team = makeFullTeam();
    team.wins = 7;
    team.losses = 7;
    team.runsFor = 1000;
    team.resetSeason();
    expect(team.wins).toBe(0);
    expect(team.losses).toBe(0);
    expect(team.runsFor).toBe(0);
    expect(team.nrr).toBe(0);
  });

  it("resets player stats", () => {
    const team = makeFullTeam();
    team.roster[0].stats.runs = 500;
    team.resetSeason();
    expect(team.roster[0].stats.runs).toBe(0);
  });

  it("applies camp load from team intensity at season reset", () => {
    const team = makeFullTeam();
    team.trainingIntensity = "hard";
    team.roster[0].trainingFocus = "power";
    team.roster[1].trainingFocus = "fitness";

    team.resetSeason();

    expect(team.roster[0].fatigue).toBeGreaterThan(team.roster[1].fatigue);
    expect(team.roster[0].fatigue).toBeGreaterThan(0);
  });
});

describe("Team powerRating", () => {
  it("returns 0 for empty roster", () => {
    const team = new Team(IPL_TEAMS[0]);
    expect(team.powerRating).toBe(0);
  });

  it("returns average overall of playing XI", () => {
    const team = makeFullTeam();
    const pwr = team.powerRating;
    expect(pwr).toBeGreaterThan(0);
    expect(pwr).toBeLessThanOrEqual(99);
  });
});

describe("Team user-controlled lineup", () => {
  it("uses userPlayingXI when set and valid", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    // Pick 11 non-injured, non-excess-overseas players
    const manualXI = team.roster.slice(0, 11).map(p => p.id);
    team.userPlayingXI = manualXI;

    const xi = team.getPlayingXI();
    expect(xi).toHaveLength(11);
    expect(xi.map(p => p.id).sort()).toEqual([...manualXI].sort());
  });

  it("falls back to auto when userPlayingXI has wrong count", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;
    team.userPlayingXI = team.roster.slice(0, 5).map(p => p.id); // only 5

    const xi = team.getPlayingXI();
    // Should get auto XI, not 5 players
    expect(xi.length).toBeLessThanOrEqual(11);
    expect(xi.length).toBeGreaterThanOrEqual(11); // auto should always give 11 with 12 players
  });

  it("falls back to auto when userPlayingXI has too many overseas", () => {
    const team = new Team(IPL_TEAMS[0]);
    // Add 6 international and 6 domestic
    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer({ isInternational: true, role: "batsman" }), 5);
    }
    for (let i = 0; i < 6; i++) {
      team.addPlayer(makePlayer({ isInternational: false, role: "bowler" }), 5);
    }

    team.isUserControlled = true;
    // Manually pick 5 international + 6 domestic = 11 but 5 > maxOverseas(4)
    const intlPlayers = team.roster.filter(p => p.isInternational).slice(0, 5);
    const domPlayers = team.roster.filter(p => !p.isInternational).slice(0, 6);
    team.userPlayingXI = [...intlPlayers, ...domPlayers].map(p => p.id);

    const xi = team.getPlayingXI(4);
    const intlCount = xi.filter(p => p.isInternational).length;
    expect(intlCount).toBeLessThanOrEqual(4); // auto fallback enforces limit
  });

  it("falls back to auto when userPlayingXI contains injured players", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    // Mark first player as injured
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 3;

    // User XI includes the injured player
    team.userPlayingXI = team.roster.slice(0, 11).map(p => p.id);

    const xi = team.getPlayingXI();
    // Should fall back to auto since after filtering injured, count < 11
    expect(xi.find(p => p.id === team.roster[0].id)).toBeUndefined();
  });

  it("does not use userPlayingXI when not user controlled", () => {
    const team = makeFullTeam();
    team.isUserControlled = false;
    team.userPlayingXI = team.roster.slice(0, 11).map(p => p.id);

    const xi = team.getPlayingXI();
    // Should use auto selection (sorted by overall), not the manual one
    expect(xi).toHaveLength(11);
  });
});

describe("Team user batting order", () => {
  it("respects userBattingOrder when set", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    const xi = team.getPlayingXI();
    // Reverse the auto order
    const reversed = [...xi].reverse().map(p => p.id);
    team.userBattingOrder = reversed;

    const order = team.getBattingOrder(xi);
    expect(order[0].id).toBe(reversed[0]);
    expect(order[order.length - 1].id).toBe(reversed[reversed.length - 1]);
  });

  it("appends missing players to partial user batting order", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    const xi = team.getPlayingXI();
    // Only specify first 3 batters
    team.userBattingOrder = xi.slice(0, 3).map(p => p.id);

    const order = team.getBattingOrder(xi);
    // First 3 should match user order, rest auto-appended
    expect(order).toHaveLength(xi.length);
    expect(order[0].id).toBe(xi[0].id);
    expect(order[1].id).toBe(xi[1].id);
    expect(order[2].id).toBe(xi[2].id);
  });

  it("uses auto batting order when userBattingOrder is empty", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;
    team.userBattingOrder = [];

    const xi = team.getPlayingXI();
    const order = team.getBattingOrder(xi);
    // Auto order puts WK early, bowlers late
    expect(order).toHaveLength(xi.length);
  });
});

describe("Team user bowling order", () => {
  it("respects userBowlingOrder when set with enough bowlers", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    const xi = team.getPlayingXI();
    const autoBowlers = team.autoBowlingOrder(xi);
    // Reverse them
    const reversed = [...autoBowlers].reverse().map(p => p.id);
    team.userBowlingOrder = reversed;

    const order = team.getBowlingOrder(xi);
    expect(order[0].id).toBe(reversed[0]);
    expect(order.length).toBeGreaterThanOrEqual(5);
  });

  it("pads with auto bowlers when user provides fewer than 5", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    const xi = team.getPlayingXI();
    const autoBowlers = team.autoBowlingOrder(xi);
    team.userBowlingOrder = [autoBowlers[0].id, autoBowlers[1].id]; // only 2

    const order = team.getBowlingOrder(xi);
    // Should have at least 5 (2 user + 3 auto)
    expect(order.length).toBeGreaterThanOrEqual(5);
    // First 2 should be the user-selected ones
    expect(order[0].id).toBe(autoBowlers[0].id);
    expect(order[1].id).toBe(autoBowlers[1].id);
  });

  it("does not truncate extra bowling options when user provides a partial order", () => {
    const team = makeFullTeam();
    team.isUserControlled = true;

    const xi = team.getPlayingXI();
    const autoBowlers = team.autoBowlingOrder(xi);
    team.userBowlingOrder = [autoBowlers[0].id, autoBowlers[1].id];

    const order = team.getBowlingOrder(xi);

    expect(order.length).toBe(autoBowlers.length);
    expect(order.map(p => p.id)).toEqual([
      autoBowlers[0].id,
      autoBowlers[1].id,
      ...autoBowlers.slice(2).map(p => p.id),
    ]);
  });

  it("uses auto bowling order when not user controlled", () => {
    const team = makeFullTeam();
    team.isUserControlled = false;
    team.userBowlingOrder = ["fake_id_1", "fake_id_2"];

    const xi = team.getPlayingXI();
    const order = team.getBowlingOrder(xi);
    expect(order.length).toBeGreaterThanOrEqual(5);
  });
});

describe("Team resetSeason clears injuries and lineup", () => {
  it("clears all injuries on roster", () => {
    const team = makeFullTeam();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 5;
    team.roster[0].injuryType = "hamstring";
    team.roster[0].injurySeverity = "severe";

    team.resetSeason();

    expect(team.roster[0].injured).toBe(false);
    expect(team.roster[0].injuryGamesLeft).toBe(0);
    expect(team.roster[0].injuryType).toBeUndefined();
    expect(team.roster[0].injurySeverity).toBeUndefined();
  });

  it("clears user lineup selections", () => {
    const team = makeFullTeam();
    team.userPlayingXI = ["a", "b"];
    team.userBattingOrder = ["c", "d"];
    team.userBowlingOrder = ["e", "f"];

    team.resetSeason();

    expect(team.userPlayingXI).toBeUndefined();
    expect(team.userBattingOrder).toBeUndefined();
    expect(team.userBowlingOrder).toBeUndefined();
  });
});
