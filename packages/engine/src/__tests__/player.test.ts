import { describe, it, expect } from "vitest";
import { Player, PlayerData } from "../player.js";

function makePlayerData(overrides?: Partial<PlayerData>): PlayerData {
  return {
    id: "test_1",
    name: "Test Player",
    age: 28,
    country: "India",
    role: "batsman",
    ratings: {
      battingIQ: 80, timing: 75, power: 70, running: 60,
      wicketTaking: 30, economy: 25, accuracy: 35, clutch: 65,
    },
    isInternational: false,
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  };
}

describe("Player constructor", () => {
  it("sets all fields from data", () => {
    const p = new Player(makePlayerData());
    expect(p.id).toBe("test_1");
    expect(p.name).toBe("Test Player");
    expect(p.age).toBe(28);
    expect(p.country).toBe("India");
    expect(p.role).toBe("batsman");
    expect(p.isInternational).toBe(false);
    expect(p.bid).toBe(0);
    expect(p.injured).toBe(false);
  });

  it("copies ratings (not reference)", () => {
    const data = makePlayerData();
    const p = new Player(data);
    p.ratings.battingIQ = 99;
    expect(data.ratings.battingIQ).toBe(80);
  });

  it("initializes empty stats", () => {
    const p = new Player(makePlayerData());
    expect(p.stats.matches).toBe(0);
    expect(p.stats.runs).toBe(0);
    expect(p.stats.wickets).toBe(0);
    expect(p.stats.matchLog).toEqual([]);
  });
});

describe("Player computed ratings", () => {
  it("calculates battingOvr correctly", () => {
    const p = new Player(makePlayerData());
    // battingIQ*0.35 + timing*0.30 + power*0.30 + running*0.05
    // 80*0.35 + 75*0.30 + 70*0.30 + 60*0.05 = 28 + 22.5 + 21 + 3 = 74.5 → 75
    expect(p.battingOvr).toBe(75);
  });

  it("calculates bowlingOvr correctly", () => {
    const p = new Player(makePlayerData());
    // wicketTaking*0.40 + economy*0.40 + accuracy*0.10 + clutch*0.10
    // 30*0.40 + 25*0.40 + 35*0.10 + 65*0.10 = 12 + 10 + 3.5 + 6.5 = 32
    expect(p.bowlingOvr).toBe(32);
  });

  it("calculates overall rating using specialist formula", () => {
    const p = new Player(makePlayerData());
    const bat = p.battingOvr; // 75
    const bowl = p.bowlingOvr; // 32
    const stronger = Math.max(bat, bowl);
    const weaker = Math.min(bat, bowl);
    const expected = Math.round(stronger + (100 - stronger) * Math.pow(weaker / 100, 4));
    expect(p.overall).toBe(expected);
  });

  it("overall is always >= stronger discipline", () => {
    const p = new Player(makePlayerData());
    expect(p.overall).toBeGreaterThanOrEqual(Math.max(p.battingOvr, p.bowlingOvr));
  });
});

describe("Player market value", () => {
  it("is 0.2 for low rated players", () => {
    const p = new Player(makePlayerData({
      ratings: {
        battingIQ: 15, timing: 15, power: 15, running: 15,
        wicketTaking: 15, economy: 15, accuracy: 15, clutch: 15,
      },
    }));
    expect(p.marketValue).toBe(0.2);
  });

  it("international players have lower market value", () => {
    const domestic = new Player(makePlayerData({ isInternational: false }));
    const intl = new Player(makePlayerData({ isInternational: true }));
    expect(intl.marketValue).toBeLessThanOrEqual(domestic.marketValue);
  });

  it("is always at least 0.2", () => {
    const p = new Player(makePlayerData());
    expect(p.marketValue).toBeGreaterThanOrEqual(0.2);
  });
});

describe("Player batting stats", () => {
  it("calculates average correctly", () => {
    const p = new Player(makePlayerData());
    p.stats.innings = 10;
    p.stats.notOuts = 2;
    p.stats.runs = 400;
    // avg = 400 / (10 - 2) = 50
    expect(p.average).toBe(50);
  });

  it("returns runs when no dismissals", () => {
    const p = new Player(makePlayerData());
    p.stats.innings = 5;
    p.stats.notOuts = 5;
    p.stats.runs = 200;
    expect(p.average).toBe(200);
  });

  it("calculates strike rate correctly", () => {
    const p = new Player(makePlayerData());
    p.stats.runs = 150;
    p.stats.ballsFaced = 100;
    expect(p.strikeRate).toBe(150);
  });

  it("returns 0 strike rate with no balls faced", () => {
    const p = new Player(makePlayerData());
    expect(p.strikeRate).toBe(0);
  });
});

describe("Player bowling stats", () => {
  it("calculates economy rate correctly", () => {
    const p = new Player(makePlayerData());
    p.stats.overs = 20;
    p.stats.runsConceded = 160;
    expect(p.economyRate).toBe(8);
  });

  it("calculates bowling strike rate correctly", () => {
    const p = new Player(makePlayerData());
    p.stats.overs = 20;
    p.stats.wickets = 10;
    // (20 * 6) / 10 = 12
    expect(p.bowlingStrikeRate).toBe(12);
  });

  it("returns 999 bowling SR with no wickets", () => {
    const p = new Player(makePlayerData());
    expect(p.bowlingStrikeRate).toBe(999);
  });
});

describe("Player progression", () => {
  it("increments age by 1", () => {
    const p = new Player(makePlayerData({ age: 25 }));
    p.progress();
    expect(p.age).toBe(26);
  });

  it("keeps ratings within 1-99", () => {
    const p = new Player(makePlayerData());
    for (let i = 0; i < 50; i++) p.progress();
    const attrs = Object.values(p.ratings);
    for (const val of attrs) {
      expect(val).toBeGreaterThanOrEqual(1);
      expect(val).toBeLessThanOrEqual(99);
    }
  });

  it("resets season stats after progression", () => {
    const p = new Player(makePlayerData());
    p.stats.runs = 500;
    p.stats.wickets = 20;
    p.progress();
    expect(p.stats.runs).toBe(0);
    expect(p.stats.wickets).toBe(0);
  });
});

describe("Player serialization", () => {
  it("toJSON returns plain object", () => {
    const p = new Player(makePlayerData());
    const json = p.toJSON();
    expect(json.id).toBe("test_1");
    expect(json.name).toBe("Test Player");
    expect(json.ratings.battingIQ).toBe(80);
  });

  it("fromJSON reconstructs player", () => {
    const p = new Player(makePlayerData());
    p.stats.runs = 100;
    const json = p.toJSON();
    const restored = Player.fromJSON(json);
    expect(restored.id).toBe(p.id);
    expect(restored.name).toBe(p.name);
    expect(restored.stats.runs).toBe(100);
    expect(restored.battingOvr).toBe(p.battingOvr);
  });

  it("roundtrip preserves computed properties", () => {
    const p = new Player(makePlayerData());
    const restored = Player.fromJSON(p.toJSON());
    expect(restored.overall).toBe(p.overall);
    expect(restored.marketValue).toBe(p.marketValue);
  });

  it("serializes injury fields correctly", () => {
    const p = new Player(makePlayerData({
      injured: true,
      injuryGamesLeft: 4,
      injuryType: "shoulder",
      injurySeverity: "moderate",
    }));

    const json = p.toJSON();
    expect(json.injured).toBe(true);
    expect(json.injuryGamesLeft).toBe(4);
    expect(json.injuryType).toBe("shoulder");
    expect(json.injurySeverity).toBe("moderate");
  });

  it("deserializes injury fields correctly", () => {
    const p = new Player(makePlayerData({
      injured: true,
      injuryGamesLeft: 4,
      injuryType: "shoulder",
      injurySeverity: "moderate",
    }));

    const restored = Player.fromJSON(p.toJSON());
    expect(restored.injured).toBe(true);
    expect(restored.injuryGamesLeft).toBe(4);
    expect(restored.injuryType).toBe("shoulder");
    expect(restored.injurySeverity).toBe("moderate");
  });

  it("roundtrip with no injury fields leaves them falsy", () => {
    const p = new Player(makePlayerData());
    const restored = Player.fromJSON(p.toJSON());
    expect(restored.injured).toBe(false);
    expect(restored.injuryGamesLeft).toBe(0);
    expect(restored.injuryType).toBeUndefined();
    expect(restored.injurySeverity).toBeUndefined();
  });
});
