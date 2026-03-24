import { describe, it, expect } from "vitest";
import { getRealPlayers, REAL_PLAYERS } from "../real-players.js";
import { createPlayerFromData } from "@ipl-sim/engine";

describe("REAL_PLAYERS data", () => {
  it("has at least 40 players", () => {
    expect(REAL_PLAYERS.length).toBeGreaterThanOrEqual(40);
  });

  it("all tuples have 13 elements", () => {
    for (const p of REAL_PLAYERS) {
      expect(p).toHaveLength(13);
    }
  });

  it("all teams are represented", () => {
    const teamIds = new Set(REAL_PLAYERS.map(p => p[12]));
    const expected = ["srh", "dc", "rcb", "kkr", "rr", "csk", "mi", "pbks", "gt", "lsg"];
    for (const id of expected) {
      expect(teamIds.has(id)).toBe(true);
    }
  });

  it("each team has at least 4 players", () => {
    const teamCounts = new Map<string, number>();
    for (const p of REAL_PLAYERS) {
      const tid = p[12];
      teamCounts.set(tid, (teamCounts.get(tid) ?? 0) + 1);
    }
    for (const [, count] of teamCounts) {
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("getRealPlayers", () => {
  it("returns structured objects", () => {
    const players = getRealPlayers();
    expect(players.length).toBe(REAL_PLAYERS.length);

    for (const p of players) {
      expect(p.name).toBeTruthy();
      expect(p.age).toBeGreaterThanOrEqual(15);
      expect(p.age).toBeLessThanOrEqual(45);
      expect(p.country).toBeTruthy();
      expect(["batsman", "bowler", "all-rounder"]).toContain(p.role);
      expect(p.teamId).toBeTruthy();
    }
  });

  it("all ratings are in valid range (1-99)", () => {
    const players = getRealPlayers();
    for (const p of players) {
      const attrs = [p.battingIQ, p.timing, p.power, p.running, p.wicketTaking, p.economy, p.accuracy, p.clutch];
      for (const val of attrs) {
        expect(val).toBeGreaterThanOrEqual(1);
        expect(val).toBeLessThanOrEqual(99);
      }
    }
  });

  it("contains known players", () => {
    const players = getRealPlayers();
    const names = players.map(p => p.name);
    expect(names).toContain("Virat Kohli");
    expect(names).toContain("Jasprit Bumrah");
    expect(names).toContain("Rohit Sharma");
  });

  it("Virat Kohli has high batting ratings", () => {
    const players = getRealPlayers();
    const kohli = players.find(p => p.name === "Virat Kohli")!;
    expect(kohli).toBeDefined();
    expect(kohli.battingIQ).toBeGreaterThan(85);
    expect(kohli.timing).toBeGreaterThanOrEqual(85);
    expect(kohli.role).toBe("batsman");
    expect(kohli.teamId).toBe("rcb");
  });

  it("Jasprit Bumrah has high bowling ratings", () => {
    const players = getRealPlayers();
    const bumrah = players.find(p => p.name === "Jasprit Bumrah")!;
    expect(bumrah).toBeDefined();
    expect(bumrah.wicketTaking).toBeGreaterThan(80);
    expect(bumrah.economy).toBeGreaterThan(70);
    expect(bumrah.accuracy).toBeGreaterThan(85);
    expect(bumrah.role).toBe("bowler");
    expect(bumrah.teamId).toBe("mi");
  });

  it("preserves bowling style metadata for known bowlers and all-rounders", () => {
    const players = getRealPlayers();
    const bumrah = players.find(p => p.name === "Jasprit Bumrah")!;
    const narine = players.find(p => p.name === "Sunil Narine")!;

    expect(bumrah.bowlingStyle).toBe("right-arm-fast");
    expect(narine.bowlingStyle).toBe("off-spin");
  });

  it("does not overtrust batting-allrounder labels for pure batting exports", () => {
    const players = getRealPlayers();
    const tilak = players.find(p => p.name === "Tilak Varma")!;
    expect(tilak.role).toBe("batsman");
  });

  it("keeps bowling-primary profiles like Pat Cummins exported as bowlers", () => {
    const players = getRealPlayers();
    const cummins = players.find(p => p.name === "Pat Cummins")!;
    expect(cummins.role).toBe("bowler");
  });
});

describe("runtime realism integration", () => {
  const runtimePlayers = getRealPlayers().map(createPlayerFromData);

  it("keeps Rohit Sharma as a batting specialist at runtime", () => {
    const rohit = runtimePlayers.find((p) => p.name === "Rohit Sharma")!;
    expect(rohit.role).toBe("batsman");
    expect(rohit.battingOvr).toBeGreaterThan(rohit.bowlingOvr);
  });

  it("keeps Hardik Pandya as an all-rounder at runtime", () => {
    const hardik = runtimePlayers.find((p) => p.name === "Hardik Pandya")!;
    expect(hardik.role).toBe("all-rounder");
    expect(hardik.battingOvr).toBeGreaterThanOrEqual(80);
    expect(hardik.bowlingOvr).toBeGreaterThanOrEqual(60);
  });

  it("keeps Pat Cummins from collapsing into a batting specialist at runtime", () => {
    const cummins = runtimePlayers.find((p) => p.name === "Pat Cummins")!;
    expect(cummins.role).toBe("bowler");
    expect(cummins.bowlingOvr).toBeGreaterThan(cummins.battingOvr);
  });

  it("does not leave Nicholas Pooran in a manually underrated tier", () => {
    const pooran = runtimePlayers.find((p) => p.name === "Nicholas Pooran")!;
    expect(pooran.role).toBe("batsman");
    expect(pooran.battingOvr).toBeGreaterThanOrEqual(84);
  });

  it("does not leave obvious low-sample breakouts above established star keepers", () => {
    const urvil = runtimePlayers.find((p) => p.name === "Urvil Patel")!;
    const buttler = runtimePlayers.find((p) => p.name === "Jos Buttler")!;
    expect(urvil.overall).toBeLessThan(buttler.overall);
  });

  it("keeps finisher profiles from outranking complete elite batters by default", () => {
    const tim = runtimePlayers.find((p) => p.name === "Tim David")!;
    const buttler = runtimePlayers.find((p) => p.name === "Jos Buttler")!;
    expect(tim.overall).toBeLessThanOrEqual(buttler.overall);
  });

  it("keeps high-level batting specialists above the clutch floor", () => {
    const lowClutchBatters = runtimePlayers.filter(
      (p) => p.role === "batsman" && p.battingOvr >= 75 && p.ratings.clutch < 55,
    );
    expect(lowClutchBatters).toHaveLength(0);
  });
});
