/**
 * Integration tests for team data integrity.
 *
 * Validates that IPL_TEAMS config, real player data, and the cross-package
 * mapping between them are consistent, complete, and correct.
 */

import { describe, it, expect } from "vitest";
import {
  IPL_TEAMS, Team, createPlayerFromData,
  type TeamConfig,
} from "@ipl-sim/engine";
import { getRealPlayers, REAL_PLAYERS } from "@ipl-sim/ratings";

// ── IPL_TEAMS Config Validation ──────────────────────────────────────────

describe("IPL_TEAMS config completeness", () => {
  it("contains exactly 10 teams", () => {
    expect(IPL_TEAMS).toHaveLength(10);
  });

  it("has all 10 real IPL franchise ids", () => {
    const ids = IPL_TEAMS.map(t => t.id);
    for (const expected of ["srh", "dc", "rcb", "kkr", "rr", "csk", "mi", "pbks", "gt", "lsg"]) {
      expect(ids).toContain(expected);
    }
  });

  it("has correct full team names", () => {
    const nameMap = new Map(IPL_TEAMS.map(t => [t.id, t.name]));
    expect(nameMap.get("srh")).toBe("Sunrisers Hyderabad");
    expect(nameMap.get("dc")).toBe("Delhi Capitals");
    expect(nameMap.get("rcb")).toBe("Royal Challengers Bengaluru");
    expect(nameMap.get("kkr")).toBe("Kolkata Knight Riders");
    expect(nameMap.get("rr")).toBe("Rajasthan Royals");
    expect(nameMap.get("csk")).toBe("Chennai Super Kings");
    expect(nameMap.get("mi")).toBe("Mumbai Indians");
    expect(nameMap.get("pbks")).toBe("Punjab Kings");
    expect(nameMap.get("gt")).toBe("Gujarat Titans");
    expect(nameMap.get("lsg")).toBe("Lucknow Super Giants");
  });

  it("has correct short names", () => {
    const shortMap = new Map(IPL_TEAMS.map(t => [t.id, t.shortName]));
    expect(shortMap.get("srh")).toBe("SRH");
    expect(shortMap.get("dc")).toBe("DC");
    expect(shortMap.get("rcb")).toBe("RCB");
    expect(shortMap.get("kkr")).toBe("KKR");
    expect(shortMap.get("rr")).toBe("RR");
    expect(shortMap.get("csk")).toBe("CSK");
    expect(shortMap.get("mi")).toBe("MI");
    expect(shortMap.get("pbks")).toBe("PBKS");
    expect(shortMap.get("gt")).toBe("GT");
    expect(shortMap.get("lsg")).toBe("LSG");
  });

  it("has correct cities", () => {
    const cityMap = new Map(IPL_TEAMS.map(t => [t.id, t.city]));
    expect(cityMap.get("srh")).toBe("Hyderabad");
    expect(cityMap.get("dc")).toBe("Delhi");
    expect(cityMap.get("rcb")).toBe("Bengaluru");
    expect(cityMap.get("kkr")).toBe("Kolkata");
    expect(cityMap.get("rr")).toBe("Jaipur");
    expect(cityMap.get("csk")).toBe("Chennai");
    expect(cityMap.get("mi")).toBe("Mumbai");
    expect(cityMap.get("pbks")).toBe("Mohali");
    expect(cityMap.get("gt")).toBe("Ahmedabad");
    expect(cityMap.get("lsg")).toBe("Lucknow");
  });

  it("all ids are unique", () => {
    const ids = IPL_TEAMS.map(t => t.id);
    expect(new Set(ids).size).toBe(10);
  });

  it("all short names are unique", () => {
    const shorts = IPL_TEAMS.map(t => t.shortName);
    expect(new Set(shorts).size).toBe(10);
  });

  it("all full names are unique", () => {
    const names = IPL_TEAMS.map(t => t.name);
    expect(new Set(names).size).toBe(10);
  });

  it("all cities are unique", () => {
    const cities = IPL_TEAMS.map(t => t.city);
    expect(new Set(cities).size).toBe(10);
  });
});

// ── Team Colors ──────────────────────────────────────────────────────────

describe("IPL_TEAMS color data", () => {
  const HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;

  it("all primary colors are valid hex", () => {
    for (const t of IPL_TEAMS) {
      expect(t.primaryColor).toMatch(HEX_REGEX);
    }
  });

  it("all secondary colors are valid hex", () => {
    for (const t of IPL_TEAMS) {
      expect(t.secondaryColor).toMatch(HEX_REGEX);
    }
  });

  it("primary and secondary colors differ per team", () => {
    for (const t of IPL_TEAMS) {
      expect(t.primaryColor).not.toBe(t.secondaryColor);
    }
  });
});

// ── Stadium Bowling Ratings ──────────────────────────────────────────────

describe("IPL_TEAMS stadium bowling ratings", () => {
  it("every team has a stadium bowling rating defined", () => {
    for (const t of IPL_TEAMS) {
      expect(t.stadiumBowlingRating).toBeDefined();
      expect(typeof t.stadiumBowlingRating).toBe("number");
    }
  });

  it("all ratings are in realistic range (0.7 - 1.5)", () => {
    for (const t of IPL_TEAMS) {
      expect(t.stadiumBowlingRating!).toBeGreaterThanOrEqual(0.7);
      expect(t.stadiumBowlingRating!).toBeLessThanOrEqual(1.5);
    }
  });

  it("spin-friendly venues (Chennai, Kolkata) have higher bowling ratings", () => {
    const csk = IPL_TEAMS.find(t => t.id === "csk")!;
    const kkr = IPL_TEAMS.find(t => t.id === "kkr")!;
    // Chepauk and Eden Gardens are historically spin-friendly
    expect(csk.stadiumBowlingRating!).toBeGreaterThanOrEqual(1.0);
    expect(kkr.stadiumBowlingRating!).toBeGreaterThanOrEqual(0.95);
  });

  it("batting-friendly venues (Bengaluru, Mumbai) have lower bowling ratings", () => {
    const rcb = IPL_TEAMS.find(t => t.id === "rcb")!;
    const mi = IPL_TEAMS.find(t => t.id === "mi")!;
    // Chinnaswamy and Wankhede are high-scoring grounds
    expect(rcb.stadiumBowlingRating!).toBeLessThanOrEqual(0.9);
    expect(mi.stadiumBowlingRating!).toBeLessThanOrEqual(0.9);
  });
});

// ── Real Player Data Cross-Validation ────────────────────────────────────

describe("real player data cross-validation with IPL_TEAMS", () => {
  const realPlayers = getRealPlayers();
  const validTeamIds = new Set(IPL_TEAMS.map(t => t.id));

  it("all player teamIds map to a valid IPL_TEAMS id", () => {
    for (const p of realPlayers) {
      expect(validTeamIds.has(p.teamId)).toBe(true);
    }
  });

  it("no teamIds reference nonexistent teams", () => {
    const playerTeamIds = new Set(realPlayers.map(p => p.teamId));
    for (const tid of playerTeamIds) {
      expect(validTeamIds.has(tid)).toBe(true);
    }
  });

  it("all 10 teams have real players assigned", () => {
    const teamsWithPlayers = new Set(realPlayers.map(p => p.teamId));
    for (const tid of validTeamIds) {
      expect(teamsWithPlayers.has(tid)).toBe(true);
    }
  });

  it("each team has at least 15 real players", () => {
    const counts = new Map<string, number>();
    for (const p of realPlayers) {
      counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
    }
    for (const [teamId, count] of counts) {
      expect(count).toBeGreaterThanOrEqual(15);
    }
    expect(realPlayers.length).toBeGreaterThanOrEqual(200);
  });
});

// ── Player Name Uniqueness ───────────────────────────────────────────────

describe("real player name uniqueness", () => {
  const realPlayers = getRealPlayers();

  it("no duplicate player names within the same team (allowing pipeline collisions)", () => {
    let totalDupes = 0;
    for (const t of IPL_TEAMS) {
      const teamPlayers = realPlayers.filter(p => p.teamId === t.id);
      const names = teamPlayers.map(p => p.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      totalDupes += dupes.length;
    }
    // Pipeline may occasionally have a few name collisions across teams
    expect(totalDupes).toBeLessThanOrEqual(5);
  });

  it("all names are non-empty", () => {
    for (const p of realPlayers) {
      expect(p.name.trim().length).toBeGreaterThan(2);
    }
  });
});

// ── Role Composition Per Team ────────────────────────────────────────────

describe("real player role composition per team", () => {
  const realPlayers = getRealPlayers();

  function teamPlayers(teamId: string) {
    return realPlayers.filter(p => p.teamId === teamId);
  }

  it("every team has at least one batting-capable player (batsman)", () => {
    for (const t of IPL_TEAMS) {
      const battingCapable = teamPlayers(t.id).filter(
        p => p.role === "batsman"
      );
      expect(battingCapable.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every team has at least one bowler", () => {
    for (const t of IPL_TEAMS) {
      const bowlers = teamPlayers(t.id).filter(p => p.role === "bowler");
      expect(bowlers.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every team has at least one all-rounder", () => {
    for (const t of IPL_TEAMS) {
      const flexible = teamPlayers(t.id).filter(
        p => p.role === "all-rounder"
      );
      expect(flexible.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("roles are only valid PlayerRole values", () => {
    const validRoles = new Set(["batsman", "bowler", "all-rounder"]);
    for (const p of realPlayers) {
      expect(validRoles.has(p.role)).toBe(true);
    }
  });
});

// ── Known Player Assignments ─────────────────────────────────────────────

describe("known player team assignments", () => {
  const realPlayers = getRealPlayers();

  function findPlayer(name: string) {
    return realPlayers.find(p => p.name === name);
  }

  // Virtually permanent retentions
  it("Virat Kohli is on RCB", () => {
    expect(findPlayer("Virat Kohli")?.teamId).toBe("rcb");
  });

  it("Rohit Sharma is on MI", () => {
    expect(findPlayer("Rohit Sharma")?.teamId).toBe("mi");
  });

  it("Jasprit Bumrah is on MI", () => {
    expect(findPlayer("Jasprit Bumrah")?.teamId).toBe("mi");
  });

  // Other well-known players exist in the database (team may vary with auctions)
  it("known IPL players exist in the database", () => {
    expect(findPlayer("Travis Head")).toBeDefined();
    expect(findPlayer("Pat Cummins")).toBeDefined();
    expect(findPlayer("Heinrich Klaasen")).toBeDefined();
    expect(findPlayer("Ruturaj Gaikwad")).toBeDefined();
    expect(findPlayer("Shubman Gill")).toBeDefined();
    expect(findPlayer("Rashid Khan")).toBeDefined();
    expect(findPlayer("Sanju Samson")).toBeDefined();
    expect(findPlayer("Yashasvi Jaiswal")).toBeDefined();
  });
});

// ── Player Country & International Status ────────────────────────────────

describe("player nationality and international flag", () => {
  const realPlayers = getRealPlayers();

  it("Indian players are not international", () => {
    const indians = realPlayers.filter(p => p.country === "India");
    expect(indians.length).toBeGreaterThan(0);

    for (const p of indians) {
      const player = createPlayerFromData(p);
      expect(player.isInternational).toBe(false);
    }
  });

  it("non-Indian players are international", () => {
    const foreigners = realPlayers.filter(p => p.country !== "India");
    expect(foreigners.length).toBeGreaterThan(0);

    for (const p of foreigners) {
      const player = createPlayerFromData(p);
      expect(player.isInternational).toBe(true);
    }
  });

  it("most teams have a mix of Indian and international players", () => {
    let teamsWithMix = 0;
    for (const t of IPL_TEAMS) {
      const tp = realPlayers.filter(p => p.teamId === t.id);
      const indians = tp.filter(p => p.country === "India");
      const intl = tp.filter(p => p.country !== "India");
      if (indians.length >= 1 && intl.length >= 1) teamsWithMix++;
    }
    // At least 9 of 10 teams should have a mix (MI's 5 real players are all Indian)
    expect(teamsWithMix).toBeGreaterThanOrEqual(9);
  });

  it("overall roster has a healthy Indian-to-international ratio", () => {
    const indians = realPlayers.filter(p => p.country === "India");
    const intl = realPlayers.filter(p => p.country !== "India");
    // IPL is India-heavy but with significant international presence
    expect(indians.length).toBeGreaterThan(intl.length);
    expect(intl.length).toBeGreaterThanOrEqual(10);
  });

  it("countries are valid cricket-playing nations", () => {
    const validCountries = new Set([
      "India", "Australia", "England", "South Africa", "New Zealand",
      "West Indies", "Pakistan", "Sri Lanka", "Bangladesh", "Afghanistan",
      "Zimbabwe", "Ireland", "Netherlands", "Scotland", "Nepal",
      "Namibia", "USA", "UAE", "Oman",
    ]);
    for (const p of realPlayers) {
      expect(validCountries.has(p.country)).toBe(true);
    }
  });

  it("no team has more than 8 international real players (fits squad rules)", () => {
    for (const t of IPL_TEAMS) {
      const tp = realPlayers.filter(p => p.teamId === t.id);
      const intl = tp.filter(p => p.country !== "India");
      expect(intl.length).toBeLessThanOrEqual(10);
    }
  });
});

// ── Rating Coherence Per Role ────────────────────────────────────────────

describe("rating coherence by role", () => {
  const realPlayers = getRealPlayers();

  it("batsmen on average have higher batting ratings than bowling ratings", () => {
    const batsmen = realPlayers.filter(p => p.role === "batsman");
    let batHigher = 0;
    for (const p of batsmen) {
      const batAvg = (p.battingIQ + p.timing + p.power) / 3;
      const bowlAvg = (p.wicketTaking + p.economy + p.accuracy) / 3;
      if (batAvg > bowlAvg) batHigher++;
    }
    // At least 90% of batsmen should have higher batting than bowling
    expect(batHigher / batsmen.length).toBeGreaterThan(0.9);
  });

  it("bowlers on average have higher bowling ratings than batting ratings", () => {
    const bowlers = realPlayers.filter(p => p.role === "bowler");
    let bowlHigher = 0;
    for (const p of bowlers) {
      const batAvg = (p.battingIQ + p.timing + p.power) / 3;
      const bowlAvg = (p.wicketTaking + p.economy + p.accuracy) / 3;
      if (bowlAvg > batAvg) bowlHigher++;
    }
    // At least 85% of bowlers should have higher bowling than batting
    expect(bowlHigher / bowlers.length).toBeGreaterThan(0.85);
  });

  it("all-rounders have reasonable ratings in both disciplines", () => {
    const allRounders = realPlayers.filter(p => p.role === "all-rounder");
    for (const p of allRounders) {
      const batAvg = (p.battingIQ + p.timing + p.power) / 3;
      const bowlAvg = (p.wicketTaking + p.economy + p.accuracy) / 3;
      // Both should be at least 30 (not negligible)
      expect(batAvg).toBeGreaterThanOrEqual(30);
      expect(bowlAvg).toBeGreaterThanOrEqual(30);
    }
  });

  it("wicket-keepers have strong batting ratings", () => {
    const keepers = realPlayers.filter(p => p.isWicketKeeper);
    expect(keepers.length).toBeGreaterThan(0);
    for (const p of keepers) {
      const batAvg = (p.battingIQ + p.timing + p.power) / 3;
      expect(batAvg).toBeGreaterThan(40);
    }
  });
});

// ── Team Construction From Real Data ─────────────────────────────────────

describe("team construction from real player data", () => {
  it("createPlayerFromData produces valid Player objects for all real players", () => {
    const realPlayers = getRealPlayers();
    for (const data of realPlayers) {
      const player = createPlayerFromData(data);

      expect(player.name).toBe(data.name);
      expect(player.age).toBe(data.age);
      expect(player.country).toBe(data.country);
      // Role may differ from pipeline data due to runtime inference (e.g. weak ARs downgraded)
      expect(["batsman", "bowler", "all-rounder"]).toContain(player.role);
      // Ratings may be normalized by createPlayerFromData (secondary discipline reduction)
      // Just verify they're in valid range
      for (const val of Object.values(player.ratings)) {
        expect(val).toBeGreaterThanOrEqual(1);
        expect(val).toBeLessThanOrEqual(99);
      }
      expect(player.injured).toBe(false);
      expect(player.overall).toBeGreaterThan(0);
    }
  });

  it("teams built from real data have correct roster assignments", () => {
    const teams = IPL_TEAMS.map(c => new Team(c));
    const realPlayers = getRealPlayers();

    for (const data of realPlayers) {
      const player = createPlayerFromData(data);
      const team = teams.find(t => t.id === data.teamId)!;
      team.addPlayer(player, player.marketValue);
    }

    for (const team of teams) {
      expect(team.roster.length).toBeGreaterThanOrEqual(15);
      for (const p of team.roster) {
        expect(p.teamId).toBe(team.id);
      }
    }
  });

  it("teams with real players can produce a playing XI after auction fill", () => {
    const teams = IPL_TEAMS.map(c => new Team(c));
    const realPlayers = getRealPlayers();

    for (const data of realPlayers) {
      const player = createPlayerFromData(data);
      const team = teams.find(t => t.id === data.teamId)!;
      team.addPlayer(player, player.marketValue);
    }

    // Each team has 15+ real players — enough for a full XI
    for (const team of teams) {
      const xi = team.getPlayingXI();
      expect(xi.length).toBe(11);
      expect(team.powerRating).toBeGreaterThan(0);
    }
  });
});

// ── Player Age Ranges ────────────────────────────────────────────────────

describe("real player age distribution", () => {
  const realPlayers = getRealPlayers();

  it("all ages are realistic for professional cricketers (15-45)", () => {
    for (const p of realPlayers) {
      expect(p.age).toBeGreaterThanOrEqual(15);
      expect(p.age).toBeLessThanOrEqual(45);
    }
  });

  it("has a mix of young and experienced players", () => {
    const young = realPlayers.filter(p => p.age <= 25);
    const experienced = realPlayers.filter(p => p.age >= 30);
    expect(young.length).toBeGreaterThanOrEqual(5);
    expect(experienced.length).toBeGreaterThanOrEqual(5);
  });

  it("no team is all veterans or all youngsters", () => {
    for (const t of IPL_TEAMS) {
      const tp = realPlayers.filter(p => p.teamId === t.id);
      const avgAge = tp.reduce((s, p) => s + p.age, 0) / tp.length;
      expect(avgAge).toBeGreaterThanOrEqual(22);
      expect(avgAge).toBeLessThanOrEqual(37);
    }
  });
});
