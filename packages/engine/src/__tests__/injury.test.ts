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
  getInjuryChance,
  getInjuryArchetype,
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

  it("pace bowlers have a higher injury chance than batsmen (measured ~1.8x)", () => {
    const batsman = makePureDeterministicPlayer("inj_4a", "batsman", { age: 28 });
    const quick = makePureDeterministicPlayer("inj_4b", "bowler", { age: 28, bowlingStyle: "right-arm-fast" });
    const spinner = makePureDeterministicPlayer("inj_4c", "bowler", { age: 28, bowlingStyle: "off-spin" });
    expect(getInjuryChance(quick)).toBeGreaterThan(getInjuryChance(batsman) * 1.5);
    expect(getInjuryChance(quick)).toBeGreaterThan(getInjuryChance(spinner));

    // A roll between the two chances injures the quick but not the batsman
    const roll = (getInjuryChance(batsman) + getInjuryChance(quick)) / 2;
    vi.spyOn(Math, "random").mockReturnValue(roll);
    expect(checkForInjury(batsman)).toBeNull();
    vi.restoreAllMocks();
    let idx = 0;
    const values = [roll, 0.1, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => (idx < values.length ? values[idx++] : 0.99));
    expect(checkForInjury(quick)).not.toBeNull();
  });

  it("uses the measured age bands (regular young players miss the most time)", () => {
    const young = makePureDeterministicPlayer("inj_5a", "batsman", { age: 21 });
    const prime = makePureDeterministicPlayer("inj_5b", "batsman", { age: 28 });
    const veteran = makePureDeterministicPlayer("inj_5c", "batsman", { age: 35 });
    expect(getInjuryChance(young)).toBeGreaterThan(getInjuryChance(prime));
    // Survivors: older regulars are no more injury-prone in the data than prime-age ones
    expect(getInjuryChance(veteran)).toBeLessThanOrEqual(getInjuryChance(prime));
  });

  it("previous injuries raise the chance (1: +11%, 2+: +22%)", () => {
    const clean = makePureDeterministicPlayer("inj_5d", "batsman", { age: 28 });
    const once = makePureDeterministicPlayer("inj_5e", "batsman", { age: 28, injuryHistory: [1, 0] });
    const twice = makePureDeterministicPlayer("inj_5f", "batsman", { age: 28, injuryHistory: [1, 1] });
    expect(getInjuryChance(once) / getInjuryChance(clean)).toBeCloseTo(1.113, 3);
    expect(getInjuryChance(twice) / getInjuryChance(clean)).toBeCloseTo(1.22, 3);
  });

  it("women's cricket uses the measured 0.58x rate and fatigue only adds risk", () => {
    const p = makePureDeterministicPlayer("inj_5g", "batsman", { age: 28 });
    expect(getInjuryChance(p, { gender: "women" }) / getInjuryChance(p)).toBeCloseTo(0.576, 3);
    const tired = makePureDeterministicPlayer("inj_5h", "batsman", { age: 28, fatigue: 100 });
    const fresh = makePureDeterministicPlayer("inj_5i", "batsman", { age: 28, fatigue: 10 });
    expect(getInjuryChance(tired)).toBeGreaterThan(getInjuryChance(fresh));
  });

  it("maps players to the analysis's types", () => {
    expect(getInjuryArchetype(makePureDeterministicPlayer("inj_6a", "bowler", { bowlingStyle: "left-arm-fast-medium" }))).toBe("pace");
    expect(getInjuryArchetype(makePureDeterministicPlayer("inj_6b", "bowler", { bowlingStyle: "right-arm-medium" }))).toBe("medium");
    expect(getInjuryArchetype(makePureDeterministicPlayer("inj_6c", "bowler", { bowlingStyle: "left-arm-orthodox" }))).toBe("finger spin");
    expect(getInjuryArchetype(makePureDeterministicPlayer("inj_6d", "bowler", { bowlingStyle: "leg-spin" }))).toBe("wrist spin");
    expect(getInjuryArchetype(makePureDeterministicPlayer("inj_6e", "batsman", { isWicketKeeper: true }))).toBe("wicketkeeper");
    const ar = getInjuryArchetype(makePureDeterministicPlayer("inj_6f", "all-rounder"));
    expect(["batting all-rounder", "bowling all-rounder"]).toContain(ar);
  });

  it("returns valid severity values (minor, moderate, severe) from the measured duration split", () => {
    // Batsman ("other" group): 51% 1-2 matches, 39% 3-5, 10% 6+
    let idx = 0;
    let values = [0.001, 0.3, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => (idx < values.length ? values[idx++] : 0.99));
    const minor = checkForInjury(makePureDeterministicPlayer("inj_sev1", "batsman"));
    expect(minor!.severity).toBe("minor");
    vi.restoreAllMocks();

    idx = 0;
    values = [0.001, 0.7, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => (idx < values.length ? values[idx++] : 0.99));
    const moderate = checkForInjury(makePureDeterministicPlayer("inj_sev2", "batsman"));
    expect(moderate!.severity).toBe("moderate");
    vi.restoreAllMocks();

    idx = 0;
    values = [0.001, 0.95, 0.0, 0.0];
    vi.spyOn(Math, "random").mockImplementation(() => (idx < values.length ? values[idx++] : 0.99));
    const severe = checkForInjury(makePureDeterministicPlayer("inj_sev3", "batsman"));
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

  it("wicket-keepers have a lower chance than batsmen (measured 0.79x)", () => {
    const wk = makePureDeterministicPlayer("inj_wk1", "batsman", { isWicketKeeper: true, age: 28 });
    const bat = makePureDeterministicPlayer("inj_wk2", "batsman", { age: 28 });
    expect(getInjuryChance(wk)).toBeLessThan(getInjuryChance(bat));
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

describe("injury history and match-based healing", () => {
  it("applyInjury counts the injury in this season's history", () => {
    const p = makePlayer();
    applyInjury(p, { isInjured: true, injuryType: "back", matchesRemaining: 2, severity: "minor" });
    expect(p.injuryHistory[0]).toBe(1);
  });

  it("healInjuries skips players injured in the match just played", () => {
    const team = makeTeamWithRoster();
    const [a, b] = team.roster;
    applyInjury(a, { isInjured: true, injuryType: "back", matchesRemaining: 1, severity: "minor" });
    applyInjury(b, { isInjured: true, injuryType: "back", matchesRemaining: 1, severity: "minor" });
    healInjuries(team, new Set([b.id]));
    expect(a.injured).toBe(false);
    expect(b.injured).toBe(true);
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
