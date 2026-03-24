import { describe, it, expect } from "vitest";
import {
  getMatchupModifiers,
  getMatchPhase,
  isPaceBowler,
  isSpinBowler,
  calculateWinProbability,
  generateBallCommentary,
  getBasePrice,
  getBidIncrement,
  Player,
  calculateBattingOverall,
  calculateBowlingOverall,
  calculateOverallRating,
  calculateMarketValue,
  type PlayerData,
  type BallCommentaryParams,
} from "../index.js";
import {
  getHandMatchupModifier,
  getPhaseModifier,
  getPitchModifier,
  getBoundaryModifier,
} from "../matchups.js";

// ── Helpers ──

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

// ═══════════════════════════════════════════════════════════════════════════
// Matchup Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Matchups – hand vs bowling style", () => {
  it("left-arm fast vs right-hand batter increases wicket probability", () => {
    const mod = getHandMatchupModifier("left-arm-fast", "right");
    expect(mod.wicketMod).toBeGreaterThan(1.0);
  });

  it("leg spin vs left-hand batter reduces wicket probability", () => {
    const mod = getHandMatchupModifier("leg-spin", "left");
    expect(mod.wicketMod).toBeLessThan(1.0);
  });

  it("off-spin vs left-hand batter increases wicket probability", () => {
    const mod = getHandMatchupModifier("off-spin", "left");
    expect(mod.wicketMod).toBeGreaterThan(1.0);
  });

  it("left-arm-orthodox vs left-hand batter reduces wicket probability (turns into bat)", () => {
    const mod = getHandMatchupModifier("left-arm-orthodox", "left");
    expect(mod.wicketMod).toBeLessThan(1.0);
  });

  it("unknown bowling style returns neutral modifiers", () => {
    const mod = getHandMatchupModifier("unknown", "right");
    expect(mod.wicketMod).toBe(1.0);
    expect(mod.boundaryMod).toBe(1.0);
    expect(mod.dotMod).toBe(1.0);
  });
});

describe("Matchups – phase modifiers", () => {
  it("pace bowler in powerplay has higher wicket rate than middle overs", () => {
    const pp = getPhaseModifier("right-arm-fast", "powerplay");
    const mid = getPhaseModifier("right-arm-fast", "middle");
    expect(pp.wicketMod).toBeGreaterThan(mid.wicketMod);
  });

  it("spin bowler in middle overs has higher wicket rate than powerplay", () => {
    const mid = getPhaseModifier("off-spin", "middle");
    const pp = getPhaseModifier("off-spin", "powerplay");
    expect(mid.wicketMod).toBeGreaterThan(pp.wicketMod);
  });

  it("pace bowler has better economy in powerplay than middle overs", () => {
    const pp = getPhaseModifier("right-arm-fast", "powerplay");
    const mid = getPhaseModifier("right-arm-fast", "middle");
    // Lower economy mod = better economy (fewer runs conceded)
    expect(pp.economyMod).toBeLessThan(mid.economyMod);
  });

  it("spin bowler in death overs has reduced wicket rate", () => {
    const death = getPhaseModifier("leg-spin", "death");
    expect(death.wicketMod).toBeLessThan(1.0);
  });

  it("pace bowler at death has positive wicket mod", () => {
    const death = getPhaseModifier("left-arm-fast", "death");
    expect(death.wicketMod).toBeGreaterThan(1.0);
  });
});

describe("Matchups – pitch modifiers", () => {
  it("seaming pitch boosts pace wicket modifier", () => {
    const mod = getPitchModifier("right-arm-fast", "seaming", "none", false);
    expect(mod.wicketMod).toBeGreaterThan(1.0);
  });

  it("turning pitch boosts spin wicket modifier", () => {
    const mod = getPitchModifier("off-spin", "turning", "none", false);
    expect(mod.wicketMod).toBeGreaterThan(1.0);
  });

  it("seaming pitch does not boost spin wicket modifier", () => {
    const mod = getPitchModifier("leg-spin", "seaming", "none", false);
    expect(mod.wicketMod).toBeLessThanOrEqual(1.0);
  });

  it("flat pitch boosts boundary modifier", () => {
    const mod = getPitchModifier("right-arm-fast", "flat", "none", false);
    expect(mod.boundaryMod).toBeGreaterThan(1.0);
  });

  it("heavy dew in 2nd innings reduces spin effectiveness", () => {
    const noDew = getPitchModifier("off-spin", "balanced", "none", true);
    const heavyDew = getPitchModifier("off-spin", "balanced", "heavy", true);
    expect(heavyDew.wicketMod).toBeLessThan(noDew.wicketMod);
  });

  it("moderate dew in 2nd innings partially reduces spin effectiveness", () => {
    const noDew = getPitchModifier("leg-spin", "balanced", "none", true);
    const modDew = getPitchModifier("leg-spin", "balanced", "moderate", true);
    expect(modDew.wicketMod).toBeLessThan(noDew.wicketMod);
  });

  it("dew has no effect in 1st innings", () => {
    const firstInnings = getPitchModifier("off-spin", "balanced", "heavy", false);
    const noDew = getPitchModifier("off-spin", "balanced", "none", false);
    expect(firstInnings.wicketMod).toBe(noDew.wicketMod);
  });
});

describe("Matchups – boundary size modifiers", () => {
  it("small boundaries increase four modifier", () => {
    const mod = getBoundaryModifier("small");
    expect(mod.fourMod).toBeGreaterThan(1.0);
  });

  it("small boundaries increase six modifier", () => {
    const mod = getBoundaryModifier("small");
    expect(mod.sixMod).toBeGreaterThan(1.0);
  });

  it("large boundaries reduce six modifier", () => {
    const mod = getBoundaryModifier("large");
    expect(mod.sixMod).toBeLessThan(1.0);
  });

  it("medium boundaries are neutral", () => {
    const mod = getBoundaryModifier("medium");
    expect(mod.fourMod).toBe(1.0);
    expect(mod.sixMod).toBe(1.0);
  });
});

describe("Matchups – getMatchPhase", () => {
  it("returns powerplay for overs 0-5", () => {
    expect(getMatchPhase(0)).toBe("powerplay");
    expect(getMatchPhase(3)).toBe("powerplay");
    expect(getMatchPhase(5)).toBe("powerplay");
  });

  it("returns middle for overs 6-14", () => {
    expect(getMatchPhase(6)).toBe("middle");
    expect(getMatchPhase(10)).toBe("middle");
    expect(getMatchPhase(14)).toBe("middle");
  });

  it("returns death for overs 15-19", () => {
    expect(getMatchPhase(15)).toBe("death");
    expect(getMatchPhase(17)).toBe("death");
    expect(getMatchPhase(19)).toBe("death");
  });
});

describe("Matchups – isPaceBowler / isSpinBowler", () => {
  it("right-arm-fast is pace", () => {
    expect(isPaceBowler("right-arm-fast")).toBe(true);
    expect(isSpinBowler("right-arm-fast")).toBe(false);
  });

  it("off-spin is spin", () => {
    expect(isSpinBowler("off-spin")).toBe(true);
    expect(isPaceBowler("off-spin")).toBe(false);
  });

  it("unknown is neither pace nor spin", () => {
    expect(isPaceBowler("unknown")).toBe(false);
    expect(isSpinBowler("unknown")).toBe(false);
  });

  it("left-arm-medium is pace", () => {
    expect(isPaceBowler("left-arm-medium")).toBe(true);
  });

  it("left-arm-wrist-spin is spin", () => {
    expect(isSpinBowler("left-arm-wrist-spin")).toBe(true);
  });
});

describe("Matchups – combined getMatchupModifiers", () => {
  it("seaming pitch + pace in powerplay produces high wicket mod", () => {
    const mod = getMatchupModifiers({
      bowlingStyle: "right-arm-fast",
      battingHand: "right",
      over: 2,
      pitchType: "seaming",
    });
    // Should be > 1 because: pace phase bonus + seaming pitch bonus
    expect(mod.wicketMod).toBeGreaterThan(1.1);
  });

  it("small boundary + flat pitch produces high four/six mod", () => {
    const mod = getMatchupModifiers({
      bowlingStyle: "off-spin",
      battingHand: "right",
      over: 10,
      pitchType: "flat",
      boundarySize: "small",
    });
    expect(mod.fourMod).toBeGreaterThan(1.1);
    expect(mod.sixMod).toBeGreaterThan(1.1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Win Probability Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Win Probability – 1st innings", () => {
  it("batting at par = approximately 50%", () => {
    const prob = calculateWinProbability({
      score: 85, // par at 10 overs
      wickets: 0,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(prob).toBeGreaterThanOrEqual(40);
    expect(prob).toBeLessThanOrEqual(60);
  });

  it("30 runs ahead of par increases probability", () => {
    const atPar = calculateWinProbability({
      score: 85,
      wickets: 2,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    const ahead = calculateWinProbability({
      score: 115,
      wickets: 2,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(ahead).toBeGreaterThan(atPar);
  });

  it("higher batting team power increases probability", () => {
    const weak = calculateWinProbability({
      score: 85,
      wickets: 2,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 60,
      bowlingTeamPower: 80,
    });
    const strong = calculateWinProbability({
      score: 85,
      wickets: 2,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 95,
      bowlingTeamPower: 80,
    });
    expect(strong).toBeGreaterThan(weak);
  });

  it("losing wickets reduces probability", () => {
    const noWickets = calculateWinProbability({
      score: 85,
      wickets: 0,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    const manyWickets = calculateWinProbability({
      score: 85,
      wickets: 6,
      overs: 10,
      balls: 0,
      innings: 1,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(noWickets).toBeGreaterThan(manyWickets);
  });
});

describe("Win Probability – 2nd innings", () => {
  it("needing 1 run from 60 balls = very high probability", () => {
    const prob = calculateWinProbability({
      score: 179,
      wickets: 2,
      overs: 10,
      balls: 0,
      innings: 2,
      target: 180,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(prob).toBeGreaterThanOrEqual(90);
  });

  it("needing 60 runs from 6 balls = very low probability", () => {
    const prob = calculateWinProbability({
      score: 120,
      wickets: 5,
      overs: 19,
      balls: 0,
      innings: 2,
      target: 180,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(prob).toBeLessThanOrEqual(15);
  });

  it("all out (10 wickets) in chase = 0%", () => {
    const prob = calculateWinProbability({
      score: 120,
      wickets: 10,
      overs: 15,
      balls: 0,
      innings: 2,
      target: 180,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(prob).toBe(0);
  });

  it("target reached = 100%", () => {
    const prob = calculateWinProbability({
      score: 180,
      wickets: 4,
      overs: 18,
      balls: 3,
      innings: 2,
      target: 180,
      battingTeamPower: 80,
      bowlingTeamPower: 80,
    });
    expect(prob).toBe(100);
  });

  it("probability is clamped between 1 and 99 for in-progress chases", () => {
    // Very hard chase but not impossible
    const prob = calculateWinProbability({
      score: 10,
      wickets: 7,
      overs: 18,
      balls: 0,
      innings: 2,
      target: 200,
      battingTeamPower: 50,
      bowlingTeamPower: 95,
    });
    expect(prob).toBeGreaterThanOrEqual(1);
    expect(prob).toBeLessThanOrEqual(99);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Commentary Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Commentary – generateBallCommentary", () => {
  const baseParams: BallCommentaryParams = {
    bowlerName: "Bumrah",
    batterName: "Kohli",
    outcome: "dot",
    runs: 0,
    over: 5,
    ball: 3,
    score: 42,
    wickets: 1,
    isSecondInnings: false,
    bowlingStyle: "right-arm-fast",
  };

  it("returns non-empty string for dot ball", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "dot", runs: 0 });
    expect(text.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for single", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "1", runs: 1 });
    expect(text.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for four", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "4", runs: 4 });
    expect(text).toContain("FOUR");
  });

  it("returns non-empty string for six", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "6", runs: 6 });
    expect(text).toContain("SIX");
  });

  it("returns non-empty string for wide", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "wide", runs: 1 });
    expect(text.toLowerCase()).toContain("wide");
  });

  it("returns non-empty string for noball", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "noball", runs: 1 });
    expect(text.toLowerCase()).toContain("no ball");
  });

  it("returns non-empty string for legbye", () => {
    const text = generateBallCommentary({ ...baseParams, outcome: "legbye", runs: 1 });
    expect(text.toLowerCase()).toContain("leg bye");
  });

  it("returns non-empty string for two and three", () => {
    const text2 = generateBallCommentary({ ...baseParams, outcome: "2", runs: 2 });
    expect(text2).toContain("2 runs");
    const text3 = generateBallCommentary({ ...baseParams, outcome: "3", runs: 3 });
    expect(text3).toContain("3 runs");
  });

  it("wicket commentary includes bowler and batter names", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "wicket",
      runs: 0,
      wicketType: "bowled",
    });
    expect(text).toContain("Bumrah");
    expect(text).toContain("Kohli");
    expect(text).toContain("OUT");
  });

  it("milestone commentary fires at 50 runs", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "4",
      runs: 4,
      batterRuns: 48,
      batterBalls: 30,
    });
    expect(text).toContain("FIFTY");
  });

  it("milestone commentary fires at 100 runs", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "6",
      runs: 6,
      batterRuns: 96,
      batterBalls: 55,
    });
    expect(text).toContain("CENTURY");
  });

  it("milestone does not fire below 50", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "4",
      runs: 4,
      batterRuns: 30,
    });
    expect(text).not.toContain("FIFTY");
    expect(text).not.toContain("CENTURY");
  });

  it("spin bowling style produces spin-specific dot ball commentary", () => {
    // Run multiple times to increase probability of getting spin template
    let foundSpin = false;
    for (let i = 0; i < 50; i++) {
      const text = generateBallCommentary({
        ...baseParams,
        outcome: "dot",
        runs: 0,
        bowlingStyle: "off-spin",
        over: 10,
      });
      if (text.toLowerCase().includes("flight") || text.toLowerCase().includes("turn") ||
          text.toLowerCase().includes("spin") || text.toLowerCase().includes("arm ball") ||
          text.toLowerCase().includes("drift")) {
        foundSpin = true;
        break;
      }
    }
    expect(foundSpin).toBe(true);
  });

  it("pace bowling style produces pace-specific dot ball commentary", () => {
    let foundPace = false;
    for (let i = 0; i < 50; i++) {
      const text = generateBallCommentary({
        ...baseParams,
        outcome: "dot",
        runs: 0,
        bowlingStyle: "right-arm-fast",
        over: 2,
      });
      if (text.toLowerCase().includes("short") || text.toLowerCase().includes("full") ||
          text.toLowerCase().includes("beat") || text.toLowerCase().includes("length") ||
          text.toLowerCase().includes("fires")) {
        foundPace = true;
        break;
      }
    }
    expect(foundPace).toBe(true);
  });

  it("duck context is added for wicket with 0 batter runs", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "wicket",
      runs: 0,
      wicketType: "caught",
      batterRuns: 0,
      batterBalls: 5,
      fielderName: "Jadeja",
    });
    expect(text).toContain("duck");
  });

  it("caught wicket mentions the fielder name", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "wicket",
      runs: 0,
      wicketType: "caught",
      batterRuns: 25,
      fielderName: "Jadeja",
    });
    expect(text).toContain("Jadeja");
  });

  it("chase context suffix appears in 2nd innings", () => {
    const text = generateBallCommentary({
      ...baseParams,
      outcome: "4",
      runs: 4,
      isSecondInnings: true,
      target: 180,
      score: 155,
    });
    expect(text).toContain("more to win");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Auction Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Auction – getBasePrice", () => {
  it("returns 2.0 for OVR >= 88", () => {
    const p = new Player(makePlayerData({
      ratings: { battingIQ: 95, timing: 93, power: 92, running: 85, wicketTaking: 88, economy: 86, accuracy: 84, clutch: 90 },
    }));
    expect(p.overall).toBeGreaterThanOrEqual(88);
    expect(getBasePrice(p)).toBe(2.0);
  });

  it("returns 1.5 for OVR 82-87", () => {
    const p = new Player(makePlayerData({
      ratings: { battingIQ: 90, timing: 88, power: 86, running: 75, wicketTaking: 40, economy: 30, accuracy: 35, clutch: 60 },
    }));
    const ovr = p.overall;
    expect(ovr).toBeGreaterThanOrEqual(82);
    expect(ovr).toBeLessThan(88);
    expect(getBasePrice(p)).toBe(1.5);
  });

  it("returns 0.3 for very low OVR", () => {
    const p = new Player(makePlayerData({
      ratings: { battingIQ: 15, timing: 15, power: 15, running: 15, wicketTaking: 15, economy: 15, accuracy: 15, clutch: 15 },
    }));
    expect(getBasePrice(p)).toBe(0.3);
  });
});

describe("Auction – getBidIncrement", () => {
  it("returns 0.05 for bids below 1 Cr", () => {
    expect(getBidIncrement(0.3)).toBe(0.05);
    expect(getBidIncrement(0.75)).toBe(0.05);
    expect(getBidIncrement(0.99)).toBe(0.05);
  });

  it("returns 0.10 for bids between 1 and 2 Cr", () => {
    expect(getBidIncrement(1.0)).toBe(0.10);
    expect(getBidIncrement(1.5)).toBe(0.10);
    expect(getBidIncrement(1.99)).toBe(0.10);
  });

  it("returns 0.20 for bids between 2 and 5 Cr", () => {
    expect(getBidIncrement(2.0)).toBe(0.20);
    expect(getBidIncrement(3.5)).toBe(0.20);
    expect(getBidIncrement(4.99)).toBe(0.20);
  });

  it("returns 0.25 for bids >= 5 Cr", () => {
    expect(getBidIncrement(5.0)).toBe(0.25);
    expect(getBidIncrement(10.0)).toBe(0.25);
    expect(getBidIncrement(15.0)).toBe(0.25);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Player Model Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Player model – bowling overall strike floor", () => {
  it("high wicketTaking + clutch produces higher bowlingOvr", () => {
    const highWkt = new Player(makePlayerData({
      ratings: { battingIQ: 30, timing: 25, power: 20, running: 30, wicketTaking: 90, economy: 50, accuracy: 50, clutch: 85 },
    }));
    const lowWkt = new Player(makePlayerData({
      ratings: { battingIQ: 30, timing: 25, power: 20, running: 30, wicketTaking: 40, economy: 50, accuracy: 50, clutch: 85 },
    }));
    expect(highWkt.bowlingOvr).toBeGreaterThan(lowWkt.bowlingOvr);
  });
});

describe("Player model – overall rating properties", () => {
  it("overall rating always >= max(battingOvr, bowlingOvr)", () => {
    const scenarios: Partial<PlayerData>[] = [
      { ratings: { battingIQ: 95, timing: 93, power: 92, running: 85, wicketTaking: 20, economy: 15, accuracy: 20, clutch: 30 } },
      { ratings: { battingIQ: 20, timing: 15, power: 20, running: 30, wicketTaking: 90, economy: 85, accuracy: 80, clutch: 88 } },
      { ratings: { battingIQ: 70, timing: 65, power: 60, running: 55, wicketTaking: 65, economy: 60, accuracy: 55, clutch: 60 } },
      { ratings: { battingIQ: 15, timing: 15, power: 15, running: 15, wicketTaking: 15, economy: 15, accuracy: 15, clutch: 15 } },
      { ratings: { battingIQ: 99, timing: 99, power: 99, running: 99, wicketTaking: 99, economy: 99, accuracy: 99, clutch: 99 } },
    ];

    for (const overrides of scenarios) {
      const p = new Player(makePlayerData(overrides));
      expect(p.overall).toBeGreaterThanOrEqual(Math.max(p.battingOvr, p.bowlingOvr));
    }
  });

  it("player with all 99 ratings has overall > 95", () => {
    const p = new Player(makePlayerData({
      ratings: { battingIQ: 99, timing: 99, power: 99, running: 99, wicketTaking: 99, economy: 99, accuracy: 99, clutch: 99 },
    }));
    expect(p.overall).toBeGreaterThan(95);
  });

  it("pure specialist has overall close to their stronger discipline", () => {
    const pureBat = new Player(makePlayerData({
      ratings: { battingIQ: 90, timing: 88, power: 85, running: 70, wicketTaking: 10, economy: 10, accuracy: 10, clutch: 10 },
    }));
    expect(pureBat.overall).toBe(pureBat.battingOvr); // weaker is so low that bonus is negligible
  });
});

describe("Player model – market value", () => {
  it("international players have lower market value", () => {
    const domestic = new Player(makePlayerData({ isInternational: false }));
    const intl = new Player(makePlayerData({ isInternational: true }));
    expect(intl.marketValue).toBeLessThanOrEqual(domestic.marketValue);
  });

  it("young players have higher market value", () => {
    const young = new Player(makePlayerData({ age: 21 }));
    const old = new Player(makePlayerData({ age: 36 }));
    expect(young.marketValue).toBeGreaterThan(old.marketValue);
  });

  it("all-rounder role has higher market value than specialist batsman", () => {
    const bat = new Player(makePlayerData({ role: "batsman" }));
    const ar = new Player(makePlayerData({ role: "all-rounder" }));
    expect(ar.marketValue).toBeGreaterThanOrEqual(bat.marketValue);
  });

  it("market value is always at least 0.2", () => {
    const p = new Player(makePlayerData({
      ratings: { battingIQ: 1, timing: 1, power: 1, running: 1, wicketTaking: 1, economy: 1, accuracy: 1, clutch: 1 },
    }));
    expect(p.marketValue).toBeGreaterThanOrEqual(0.2);
  });

  it("market value is capped at 20", () => {
    const p = new Player(makePlayerData({
      age: 21,
      role: "all-rounder",
      isWicketKeeper: true,
      ratings: { battingIQ: 99, timing: 99, power: 99, running: 99, wicketTaking: 99, economy: 99, accuracy: 99, clutch: 99 },
    }));
    expect(p.marketValue).toBeLessThanOrEqual(20);
  });
});

describe("Player model – progression", () => {
  it("progress() ages player by 1 year", () => {
    const p = new Player(makePlayerData({ age: 25 }));
    p.progress();
    expect(p.age).toBe(26);
  });

  it("progress() resets season stats", () => {
    const p = new Player(makePlayerData());
    p.stats.runs = 500;
    p.stats.wickets = 20;
    p.stats.matches = 14;
    p.progress();
    expect(p.stats.runs).toBe(0);
    expect(p.stats.wickets).toBe(0);
    expect(p.stats.matches).toBe(0);
  });

  it("ratings stay within 1-99 after many progressions", () => {
    const p = new Player(makePlayerData());
    for (let i = 0; i < 30; i++) p.progress();
    for (const val of Object.values(p.ratings)) {
      expect(val).toBeGreaterThanOrEqual(1);
      expect(val).toBeLessThanOrEqual(99);
    }
  });
});

describe("Player model – form system", () => {
  it("form starts at 50 (neutral) with no history", () => {
    const p = new Player(makePlayerData());
    expect(p.form).toBe(50);
  });

  it("recording performances updates form", () => {
    const p = new Player(makePlayerData());
    p.recordMatchPerformance(80);
    p.recordMatchPerformance(90);
    expect(p.form).toBeGreaterThan(50);
  });

  it("form history keeps only last 5", () => {
    const p = new Player(makePlayerData());
    for (let i = 0; i < 10; i++) p.recordMatchPerformance(70);
    expect(p.formHistory.length).toBe(5);
  });

  it("calculateFormScore rewards runs and wickets", () => {
    const highScore = Player.calculateFormScore({ runs: 60, wickets: 3, strikeRate: 160, economy: 6 });
    const lowScore = Player.calculateFormScore({ runs: 5, wickets: 0, strikeRate: 100, economy: 12 });
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("calculateFormScore is clamped 0-100", () => {
    const high = Player.calculateFormScore({ runs: 200, wickets: 10, strikeRate: 300, economy: 3 });
    const low = Player.calculateFormScore({ runs: 0, wickets: 0, strikeRate: 0, economy: 15 });
    expect(high).toBeLessThanOrEqual(100);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Standalone function edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("calculateBattingOverall / calculateBowlingOverall – edge cases", () => {
  it("all zeros produce 0", () => {
    const bat = calculateBattingOverall({ battingIQ: 0, timing: 0, power: 0, running: 0, wicketTaking: 0, economy: 0, accuracy: 0, clutch: 0 });
    expect(bat).toBe(0);
    const bowl = calculateBowlingOverall({ battingIQ: 0, timing: 0, power: 0, running: 0, wicketTaking: 0, economy: 0, accuracy: 0, clutch: 0 });
    expect(bowl).toBe(0);
  });

  it("all 99s produce high values", () => {
    const bat = calculateBattingOverall({ battingIQ: 99, timing: 99, power: 99, running: 99, wicketTaking: 99, economy: 99, accuracy: 99, clutch: 99 });
    expect(bat).toBeGreaterThanOrEqual(95);
    const bowl = calculateBowlingOverall({ battingIQ: 99, timing: 99, power: 99, running: 99, wicketTaking: 99, economy: 99, accuracy: 99, clutch: 99 });
    expect(bowl).toBeGreaterThanOrEqual(95);
  });
});

describe("calculateOverallRating edge cases", () => {
  it("equal bat and bowl gives higher overall than either", () => {
    const ovr = calculateOverallRating(70, 70);
    expect(ovr).toBeGreaterThanOrEqual(70);
  });

  it("0 and 0 gives 0", () => {
    expect(calculateOverallRating(0, 0)).toBe(0);
  });

  it("100 and 100 gives 100", () => {
    expect(calculateOverallRating(100, 100)).toBe(100);
  });

  it("is symmetric: calculateOverallRating(a,b) === calculateOverallRating(b,a)", () => {
    expect(calculateOverallRating(85, 40)).toBe(calculateOverallRating(40, 85));
  });
});
