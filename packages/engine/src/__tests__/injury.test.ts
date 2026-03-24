import { describe, it, expect, vi, afterEach } from "vitest";
import { Player, PlayerData } from "../player.js";
import { Team, IPL_TEAMS } from "../team.js";
import {
  checkForInjury,
  applyInjury,
  runPostMatchInjuryChecks,
  healInjuries,
  getAvailablePlayers,
  getInjuredPlayersInXI,
  getTeamInjuryReport,
  type InjuryStatus,
} from "../injury.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let idCounter = 0;

function makePlayerData(overrides?: Partial<PlayerData>): PlayerData {
  return {
    id: `inj_p_${++idCounter}`,
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
  };
}

function makePlayer(overrides?: Partial<PlayerData>): Player {
  return new Player(makePlayerData(overrides));
}

function makePlayingXI(): Player[] {
  const xi: Player[] = [];
  for (let i = 0; i < 4; i++) xi.push(makePlayer({ role: "batsman", id: `xi_bat_${++idCounter}` }));
  xi.push(makePlayer({ role: "batsman", isWicketKeeper: true, id: `xi_wk_${++idCounter}` }));
  for (let i = 0; i < 3; i++) xi.push(makePlayer({ role: "all-rounder", id: `xi_ar_${++idCounter}` }));
  for (let i = 0; i < 3; i++) xi.push(makePlayer({ role: "bowler", id: `xi_bow_${++idCounter}` }));
  return xi;
}

function makeTeamWithRoster(): Team {
  const team = new Team(IPL_TEAMS[0]);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer({ role: "batsman" }), 5);
  team.addPlayer(makePlayer({ role: "batsman", isWicketKeeper: true }), 5);
  for (let i = 0; i < 3; i++) team.addPlayer(makePlayer({ role: "all-rounder" }), 5);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer({ role: "bowler" }), 5);
  return team;
}

/**
 * Create a player WITHOUT calling Math.random, suitable for use inside mocked contexts.
 */
function makePureDeterministicPlayer(
  id: string,
  role: "batsman" | "bowler" | "all-rounder",
  overrides?: Partial<PlayerData>,
): Player {
  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role,
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

// ── checkForInjury ──────────────────────────────────────────────────────

describe("checkForInjury", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when player is already injured", () => {
    const player = makePureDeterministicPlayer("inj_1", "batsman", {
      injured: true,
      injuryGamesLeft: 3,
    });
    const result = checkForInjury(player);
    expect(result).toBeNull();
  });

  it("returns null when Math.random rolls above injury chance (no injury)", () => {
    // For a batsman age 25, base chance is 0.015
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const player = makePureDeterministicPlayer("inj_2", "batsman");
    const result = checkForInjury(player);
    expect(result).toBeNull();
  });

  it("returns InjuryStatus when Math.random rolls below injury chance", () => {
    // For a bowler, base chance is 0.04. Roll below that to trigger injury.
    let idx = 0;
    const values = [0.01, 0.30, 0.5, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });

    const player = makePureDeterministicPlayer("inj_3", "bowler");
    const result = checkForInjury(player);

    expect(result).not.toBeNull();
    expect(result!.isInjured).toBe(true);
    expect(result!.severity).toBe("minor");
    expect(result!.matchesRemaining).toBe(2);
    expect(result!.injuryType).toBe("hamstring");
  });

  it("bowlers have higher injury chance than batsmen", () => {
    // Use roll 0.02 which is between batsman (0.015) and bowler (0.04)

    // Batsman: 0.02 >= 0.015 => no injury
    vi.spyOn(Math, "random").mockReturnValue(0.02);
    const batsman = makePureDeterministicPlayer("inj_4a", "batsman");
    expect(checkForInjury(batsman)).toBeNull();

    vi.restoreAllMocks();

    // Bowler: 0.02 < 0.04 => injury
    let idx = 0;
    const values = [0.02, 0.1, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const bowler = makePureDeterministicPlayer("inj_4b", "bowler");
    expect(checkForInjury(bowler)).not.toBeNull();
  });

  it("older players (>34) have increased injury chance", () => {
    // Base chance for batsman: 0.015, plus age penalty: 0.02 => total 0.035

    // Young batsman: chance = 0.015, roll 0.02 >= 0.015 => no injury
    vi.spyOn(Math, "random").mockReturnValue(0.02);
    const young = makePureDeterministicPlayer("inj_5a", "batsman", { age: 25 });
    expect(checkForInjury(young)).toBeNull();

    vi.restoreAllMocks();

    // Old batsman: chance = 0.015 + 0.02 = 0.035, roll 0.02 < 0.035 => injury
    let idx = 0;
    const values = [0.02, 0.1, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const old = makePureDeterministicPlayer("inj_5b", "batsman", { age: 36 });
    expect(checkForInjury(old)).not.toBeNull();
  });

  it("all-rounders have moderate injury chance (0.03)", () => {
    // 0.025 is below 0.03 but above 0.015 (batsman)
    let idx = 0;
    const values = [0.025, 0.1, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });

    const ar = makePureDeterministicPlayer("inj_6", "all-rounder");
    expect(checkForInjury(ar)).not.toBeNull();
  });

  it("returns valid severity values (minor, moderate, severe)", () => {
    // Test minor severity: severity roll 0.5 <= 0.60
    let idx = 0;
    let values = [0.001, 0.5, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const minor = checkForInjury(makePureDeterministicPlayer("sev_1", "bowler"));
    expect(minor!.severity).toBe("minor");

    vi.restoreAllMocks();

    // Test moderate severity: severity roll 0.7 > 0.60 and <= 0.90
    idx = 0;
    values = [0.001, 0.7, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const moderate = checkForInjury(makePureDeterministicPlayer("sev_2", "bowler"));
    expect(moderate!.severity).toBe("moderate");

    vi.restoreAllMocks();

    // Test severe severity: severity roll 0.95 > 0.90
    idx = 0;
    values = [0.001, 0.95, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const severe = checkForInjury(makePureDeterministicPlayer("sev_3", "bowler"));
    expect(severe!.severity).toBe("severe");
  });

  it("matchesRemaining is within correct range per severity", () => {
    // Minor: 1-2 matches
    let idx = 0;
    let values: number[] = [0.001, 0.1, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const minor = checkForInjury(makePureDeterministicPlayer("mr_1", "bowler"));
    expect(minor!.matchesRemaining).toBeGreaterThanOrEqual(1);
    expect(minor!.matchesRemaining).toBeLessThanOrEqual(2);

    vi.restoreAllMocks();

    // Moderate: 3-5 matches
    idx = 0;
    values = [0.001, 0.7, 0.5, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const moderate = checkForInjury(makePureDeterministicPlayer("mr_2", "bowler"));
    expect(moderate!.matchesRemaining).toBeGreaterThanOrEqual(3);
    expect(moderate!.matchesRemaining).toBeLessThanOrEqual(5);

    vi.restoreAllMocks();

    // Severe: 6-10 matches
    idx = 0;
    values = [0.001, 0.95, 0.5, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const severe = checkForInjury(makePureDeterministicPlayer("mr_3", "bowler"));
    expect(severe!.matchesRemaining).toBeGreaterThanOrEqual(6);
    expect(severe!.matchesRemaining).toBeLessThanOrEqual(10);
  });

  it("injuryType is one of the known types", () => {
    const knownTypes = ["hamstring", "shoulder", "back", "finger", "ankle", "side strain"];

    for (let typeIdx = 0; typeIdx < knownTypes.length; typeIdx++) {
      vi.restoreAllMocks();
      let idx = 0;
      const values = [0.001, 0.1, 0.0, typeIdx / knownTypes.length];
      vi.spyOn(Math, "random").mockImplementation(() => {
        return idx < values.length ? values[idx++] : 0.99;
      });
      const result = checkForInjury(makePureDeterministicPlayer(`it_${typeIdx}`, "bowler"));
      expect(result).not.toBeNull();
      expect(knownTypes).toContain(result!.injuryType);
    }
  });

  it("wicket-keepers have same chance as batsmen (0.015)", () => {
    // WK is now role=batsman with isWicketKeeper=true, same injury rate
    // Roll 0.016 is above 0.015 => no injury for WK
    vi.spyOn(Math, "random").mockReturnValue(0.016);
    const wk = makePureDeterministicPlayer("wk_1", "batsman", { isWicketKeeper: true });
    expect(checkForInjury(wk)).toBeNull();

    vi.restoreAllMocks();

    // Roll 0.01 is below 0.015 => injury for WK
    let idx = 0;
    const values = [0.01, 0.1, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });
    const wk2 = makePureDeterministicPlayer("wk_2", "batsman", { isWicketKeeper: true });
    expect(checkForInjury(wk2)).not.toBeNull();
  });
});

// ── applyInjury ─────────────────────────────────────────────────────────

describe("applyInjury", () => {
  it("sets injury fields on player correctly", () => {
    const player = makePlayer();
    const injury: InjuryStatus = {
      isInjured: true,
      injuryType: "hamstring",
      matchesRemaining: 3,
      severity: "moderate",
    };

    applyInjury(player, injury);

    expect(player.injured).toBe(true);
    expect(player.injuryGamesLeft).toBe(3);
    expect(player.injuryType).toBe("hamstring");
    expect(player.injurySeverity).toBe("moderate");
  });

  it("applies different severity levels", () => {
    const player = makePlayer();
    const injury: InjuryStatus = {
      isInjured: true,
      injuryType: "shoulder",
      matchesRemaining: 8,
      severity: "severe",
    };

    applyInjury(player, injury);
    expect(player.injurySeverity).toBe("severe");
    expect(player.injuryGamesLeft).toBe(8);
  });

  it("handles minor severity with 1 match", () => {
    const player = makePlayer();
    applyInjury(player, {
      isInjured: true,
      injuryType: "finger",
      matchesRemaining: 1,
      severity: "minor",
    });
    expect(player.injured).toBe(true);
    expect(player.injuryGamesLeft).toBe(1);
    expect(player.injurySeverity).toBe("minor");
  });
});

// ── runPostMatchInjuryChecks ────────────────────────────────────────────

describe("runPostMatchInjuryChecks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when injuriesEnabled is false", () => {
    const xi = makePlayingXI();
    const result = runPostMatchInjuryChecks(xi, false);
    expect(result).toEqual([]);
  });

  it("returns empty array when no players get injured", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const xi = makePlayingXI();
    const result = runPostMatchInjuryChecks(xi, true);
    expect(result).toEqual([]);
  });

  it("returns array of injured players with details when injuries happen", () => {
    // Pre-create the XI without mocking active
    const xi: Player[] = [];
    for (let i = 0; i < 4; i++) xi.push(makePureDeterministicPlayer(`rpc_bat_${i}`, "batsman"));
    xi.push(makePureDeterministicPlayer("rpc_wk", "batsman", { isWicketKeeper: true }));
    for (let i = 0; i < 3; i++) xi.push(makePureDeterministicPlayer(`rpc_ar_${i}`, "all-rounder"));
    for (let i = 0; i < 3; i++) xi.push(makePureDeterministicPlayer(`rpc_bow_${i}`, "bowler"));

    // First player (batsman): chance 0.015, roll 0.001 => injury
    // Then severity(0.1 => minor), matches(0.0 => 1), type(0.0 => hamstring)
    // All remaining players roll 0.99 => no injury
    let idx = 0;
    const values = [0.001, 0.1, 0.0, 0.0, ...Array(40).fill(0.99)];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });

    const result = runPostMatchInjuryChecks(xi, true);
    expect(result.length).toBe(1);
    expect(result[0].player).toBe(xi[0]);
    expect(result[0].injury.isInjured).toBe(true);
    expect(result[0].injury.severity).toBeTruthy();
  });

  it("applies injuries to the player objects directly", () => {
    const xi: Player[] = [];
    for (let i = 0; i < 11; i++) {
      xi.push(makePureDeterministicPlayer(`apply_${i}`, i < 5 ? "batsman" : "bowler"));
    }

    let idx = 0;
    const values = [0.001, 0.1, 0.0, 0.0, ...Array(40).fill(0.99)];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });

    runPostMatchInjuryChecks(xi, true);
    expect(xi[0].injured).toBe(true);
    expect(xi[0].injuryGamesLeft).toBeGreaterThan(0);
  });

  it("does not double-injure already injured players", () => {
    const xi: Player[] = [];
    for (let i = 0; i < 11; i++) {
      xi.push(makePureDeterministicPlayer(`double_${i}`, i < 5 ? "batsman" : "bowler"));
    }
    xi[0].injured = true;
    xi[0].injuryGamesLeft = 3;

    // All rolls low enough to trigger
    vi.spyOn(Math, "random").mockReturnValue(0.001);

    const results = runPostMatchInjuryChecks(xi, true);
    const reInjured = results.find(r => r.player.id === xi[0].id);
    expect(reInjured).toBeUndefined();
    // Other players will get injured
    expect(results.length).toBeGreaterThan(0);
  });

  it("defaults to injuriesEnabled=true when not specified", () => {
    const xi: Player[] = [];
    for (let i = 0; i < 11; i++) {
      xi.push(makePureDeterministicPlayer(`def_${i}`, i < 5 ? "batsman" : "bowler"));
    }

    let idx = 0;
    const values = [0.001, 0.1, 0.0, 0.0, ...Array(40).fill(0.99)];
    vi.spyOn(Math, "random").mockImplementation(() => {
      return idx < values.length ? values[idx++] : 0.99;
    });

    const result = runPostMatchInjuryChecks(xi);
    expect(result.length).toBe(1);
  });

  it("can injure multiple players in the same match", () => {
    const xi: Player[] = [];
    for (let i = 0; i < 11; i++) {
      xi.push(makePureDeterministicPlayer(`multi_${i}`, i < 5 ? "batsman" : "bowler"));
    }

    // All rolls very low
    vi.spyOn(Math, "random").mockReturnValue(0.001);

    const result = runPostMatchInjuryChecks(xi, true);
    expect(result.length).toBeGreaterThan(1);
  });
});

// ── healInjuries ────────────────────────────────────────────────────────

describe("healInjuries", () => {
  it("decrements matchesRemaining for injured players", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 3;
    team.roster[0].injuryType = "hamstring";
    team.roster[0].injurySeverity = "moderate";

    healInjuries(team);

    expect(team.roster[0].injuryGamesLeft).toBe(2);
    expect(team.roster[0].injured).toBe(true);
  });

  it("clears injury when matchesRemaining reaches 0", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 1;
    team.roster[0].injuryType = "ankle";
    team.roster[0].injurySeverity = "minor";

    const healed = healInjuries(team);

    expect(healed).toHaveLength(1);
    expect(healed[0]).toBe(team.roster[0]);
    expect(team.roster[0].injured).toBe(false);
    expect(team.roster[0].injuryGamesLeft).toBe(0);
    expect(team.roster[0].injuryType).toBeUndefined();
    expect(team.roster[0].injurySeverity).toBeUndefined();
  });

  it("returns empty array when no players healed", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 5;

    const healed = healInjuries(team);
    expect(healed).toHaveLength(0);
  });

  it("handles multiple injured players independently", () => {
    const team = makeTeamWithRoster();

    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 1;
    team.roster[0].injuryType = "back";

    team.roster[1].injured = true;
    team.roster[1].injuryGamesLeft = 3;
    team.roster[1].injuryType = "shoulder";

    const healed = healInjuries(team);
    expect(healed).toHaveLength(1);
    expect(healed[0]).toBe(team.roster[0]);
    expect(team.roster[0].injured).toBe(false);
    expect(team.roster[1].injured).toBe(true);
    expect(team.roster[1].injuryGamesLeft).toBe(2);
  });

  it("does not affect non-injured players", () => {
    const team = makeTeamWithRoster();
    const uninjuredPlayer = team.roster[2];
    expect(uninjuredPlayer.injured).toBe(false);

    healInjuries(team);

    expect(uninjuredPlayer.injured).toBe(false);
    expect(uninjuredPlayer.injuryGamesLeft).toBe(0);
  });

  it("returns all healed players when multiple heal at once", () => {
    const team = makeTeamWithRoster();

    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 1;
    team.roster[2].injured = true;
    team.roster[2].injuryGamesLeft = 1;

    const healed = healInjuries(team);
    expect(healed).toHaveLength(2);
  });
});

// ── getAvailablePlayers ─────────────────────────────────────────────────

describe("getAvailablePlayers", () => {
  it("returns all players when none are injured", () => {
    const team = makeTeamWithRoster();
    const available = getAvailablePlayers(team);
    expect(available).toHaveLength(team.roster.length);
  });

  it("excludes injured players", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 3;
    team.roster[3].injured = true;
    team.roster[3].injuryGamesLeft = 2;

    const available = getAvailablePlayers(team);
    expect(available).toHaveLength(team.roster.length - 2);
    expect(available.find(p => p.id === team.roster[0].id)).toBeUndefined();
    expect(available.find(p => p.id === team.roster[3].id)).toBeUndefined();
  });

  it("returns empty array when all players are injured", () => {
    const team = makeTeamWithRoster();
    for (const p of team.roster) {
      p.injured = true;
      p.injuryGamesLeft = 1;
    }
    const available = getAvailablePlayers(team);
    expect(available).toHaveLength(0);
  });
});

// ── getInjuredPlayersInXI ───────────────────────────────────────────────

describe("getInjuredPlayersInXI", () => {
  it("returns empty array when no players are injured", () => {
    const xi = makePlayingXI();
    expect(getInjuredPlayersInXI(xi)).toEqual([]);
  });

  it("identifies injured players in the XI", () => {
    const xi = makePlayingXI();
    xi[2].injured = true;
    xi[2].injuryGamesLeft = 2;
    xi[7].injured = true;
    xi[7].injuryGamesLeft = 1;

    const injured = getInjuredPlayersInXI(xi);
    expect(injured).toHaveLength(2);
    expect(injured).toContain(xi[2]);
    expect(injured).toContain(xi[7]);
  });

  it("returns all players when everyone is injured", () => {
    const xi = makePlayingXI();
    for (const p of xi) {
      p.injured = true;
      p.injuryGamesLeft = 1;
    }
    expect(getInjuredPlayersInXI(xi)).toHaveLength(xi.length);
  });
});

// ── getTeamInjuryReport ─────────────────────────────────────────────────

describe("getTeamInjuryReport", () => {
  it("returns empty array for healthy team", () => {
    const team = makeTeamWithRoster();
    expect(getTeamInjuryReport(team)).toEqual([]);
  });

  it("returns correct report for injured players", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 4;
    team.roster[0].injuryType = "shoulder";
    team.roster[0].injurySeverity = "moderate";

    const report = getTeamInjuryReport(team);
    expect(report).toHaveLength(1);
    expect(report[0].player).toBe(team.roster[0]);
    expect(report[0].matchesLeft).toBe(4);
    expect(report[0].type).toBe("shoulder");
    expect(report[0].severity).toBe("moderate");
  });

  it("defaults missing injury fields gracefully", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 1;

    const report = getTeamInjuryReport(team);
    expect(report).toHaveLength(1);
    expect(report[0].type).toBe("unknown");
    expect(report[0].severity).toBe("minor");
  });

  it("reports multiple injuries", () => {
    const team = makeTeamWithRoster();
    team.roster[0].injured = true;
    team.roster[0].injuryGamesLeft = 2;
    team.roster[0].injuryType = "back";
    team.roster[0].injurySeverity = "minor";

    team.roster[3].injured = true;
    team.roster[3].injuryGamesLeft = 7;
    team.roster[3].injuryType = "ankle";
    team.roster[3].injurySeverity = "severe";

    const report = getTeamInjuryReport(team);
    expect(report).toHaveLength(2);
  });
});
