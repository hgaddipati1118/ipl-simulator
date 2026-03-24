import { describe, it, expect } from "vitest";
import { generateRandomPlayer, generatePlayerPool, createPlayerFromData, nextPlayerId } from "../create-player.js";

describe("nextPlayerId", () => {
  it("generates unique ids", () => {
    const id1 = nextPlayerId();
    const id2 = nextPlayerId();
    expect(id1).not.toBe(id2);
  });

  it("follows p_ prefix pattern", () => {
    const id = nextPlayerId();
    expect(id).toMatch(/^p_\d+$/);
  });
});

describe("generateRandomPlayer", () => {
  it("creates a valid player", () => {
    const p = generateRandomPlayer();
    expect(p.id).toBeTruthy();
    expect(p.name).toBeTruthy();
    expect(p.age).toBeGreaterThanOrEqual(18);
    expect(p.age).toBeLessThanOrEqual(37);
    expect(p.country).toBeTruthy();
    expect(["batsman", "bowler", "all-rounder"]).toContain(p.role);
  });

  it("ratings are within valid ranges", () => {
    for (let i = 0; i < 20; i++) {
      const p = generateRandomPlayer();
      for (const val of Object.values(p.ratings)) {
        expect(val).toBeGreaterThanOrEqual(1);
        expect(val).toBeLessThanOrEqual(99);
      }
    }
  });

  it("respects overrides", () => {
    const p = generateRandomPlayer({ name: "Custom Name", age: 30 });
    expect(p.name).toBe("Custom Name");
    expect(p.age).toBe(30);
  });

  it("generates a mix of domestic and international players", () => {
    const players = Array.from({ length: 200 }, () => generateRandomPlayer());
    const intl = players.filter(p => p.isInternational);
    const domestic = players.filter(p => !p.isInternational);
    // India has weight 40 out of ~95, so domestic should be ~40%
    expect(domestic.length).toBeGreaterThan(30);
    expect(intl.length).toBeGreaterThan(30);
  });
});

describe("generatePlayerPool", () => {
  it("generates requested number of players", () => {
    const pool = generatePlayerPool(50);
    expect(pool).toHaveLength(50);
  });

  it("all players have unique ids", () => {
    const pool = generatePlayerPool(100);
    const ids = pool.map(p => p.id);
    expect(new Set(ids).size).toBe(100);
  });
});

describe("createPlayerFromData", () => {
  it("creates player with correct ratings", () => {
    const p = createPlayerFromData({
      name: "Virat Kohli",
      age: 36,
      country: "India",
      role: "batsman",
      bowlingStyle: "leg-spin",
      battingHand: "right",
      battingIQ: 95,
      timing: 92,
      power: 82,
      running: 80,
      wicketTaking: 10,
      economy: 10,
      accuracy: 15,
      clutch: 88,
    });

    expect(p.name).toBe("Virat Kohli");
    expect(p.age).toBe(36);
    expect(p.isInternational).toBe(false);
    expect(p.role).toBe("batsman");
    expect(p.ratings.battingIQ).toBe(95);
    expect(p.bowlingStyle).toBe("leg-spin");
    expect(p.battingHand).toBe("right");
  });

  it("marks non-Indian players as international", () => {
    const p = createPlayerFromData({
      name: "Steve Smith",
      age: 35,
      country: "Australia",
      battingIQ: 85, timing: 82, power: 70, running: 65,
      wicketTaking: 15, economy: 15, accuracy: 20, clutch: 75,
    });
    expect(p.isInternational).toBe(true);
  });

  it("infers role from ratings when not specified", () => {
    // Heavy batting = batsman
    const batsman = createPlayerFromData({
      name: "Batter",
      age: 25,
      country: "India",
      battingIQ: 80, timing: 75, power: 70, running: 65,
      wicketTaking: 15, economy: 15, accuracy: 15, clutch: 50,
    });
    expect(batsman.role).toBe("batsman");

    // Heavy bowling = bowler
    const bowler = createPlayerFromData({
      name: "Bowler",
      age: 25,
      country: "India",
      battingIQ: 15, timing: 15, power: 15, running: 20,
      wicketTaking: 80, economy: 75, accuracy: 70, clutch: 50,
    });
    expect(bowler.role).toBe("bowler");

    // Balanced = all-rounder
    const allrounder = createPlayerFromData({
      name: "Allrounder",
      age: 25,
      country: "India",
      battingIQ: 78, timing: 72, power: 70, running: 62,
      wicketTaking: 76, economy: 72, accuracy: 70, clutch: 74,
    });
    expect(allrounder.role).toBe("all-rounder");
  });

  it("downgrades fake all-rounders to specialists at runtime", () => {
    // Player labeled "all-rounder" but with very weak bowling — should be batsman
    const p = createPlayerFromData({
      name: "Fake AR",
      age: 30,
      country: "India",
      role: "all-rounder",
      battingIQ: 90,
      timing: 85,
      power: 80,
      running: 50,
      wicketTaking: 25,
      economy: 20,
      accuracy: 20,
      clutch: 30,
    });

    expect(p.role).toBe("batsman");
    expect(p.battingOvr).toBeGreaterThan(p.bowlingOvr);
  });

  it("raises clutch floor for elite batting specialists", () => {
    const p = createPlayerFromData({
      name: "Virat-ish",
      age: 37,
      country: "India",
      role: "batsman",
      battingIQ: 93,
      timing: 85,
      power: 67,
      running: 57,
      wicketTaking: 24,
      economy: 24,
      accuracy: 28,
      clutch: 33,
    });

    expect(p.role).toBe("batsman");
    expect(p.ratings.clutch).toBeGreaterThanOrEqual(70);
  });
});
