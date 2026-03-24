import { describe, expect, it } from "vitest";
import { createMatchState, simulateRemaining } from "../live-match.js";
import { Player, type PlayerData } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { Team, IPL_TEAMS, type TeamConfig } from "../team.js";

type TestPlayerOptions = {
  battingHand?: PlayerData["battingHand"];
  bowlingStyle?: PlayerData["bowlingStyle"];
  ratings?: Partial<PlayerData["ratings"]>;
};

function makePlayer(
  id: string,
  role: "batsman" | "bowler" | "all-rounder",
  options: TestPlayerOptions = {},
): Player {
  const batHeavy = role === "batsman";
  const bowlHeavy = role === "bowler";
  const ratings: PlayerData["ratings"] = {
    battingIQ: batHeavy ? 70 : bowlHeavy ? 25 : 55,
    timing: batHeavy ? 68 : bowlHeavy ? 25 : 50,
    power: batHeavy ? 65 : bowlHeavy ? 20 : 50,
    running: batHeavy ? 60 : 40,
    wicketTaking: bowlHeavy ? 70 : batHeavy ? 20 : 55,
    economy: bowlHeavy ? 68 : batHeavy ? 20 : 55,
    accuracy: bowlHeavy ? 65 : batHeavy ? 20 : 50,
    clutch: 55,
    ...options.ratings,
  };

  return new Player({
    id,
    name: `Player ${id}`,
    age: 25,
    country: "India",
    role,
    ratings,
    battingHand: options.battingHand,
    bowlingStyle: options.bowlingStyle,
    injured: false,
    injuryGamesLeft: 0,
    isInternational: false,
    isWicketKeeper: false,
  });
}

function buildTeam(configIdx: number, configOverride: Partial<TeamConfig> = {}): Team {
  const team = new Team({ ...IPL_TEAMS[configIdx], ...configOverride });
  let id = configIdx * 100;

  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bat_${++id}`, "batsman"), 5);

  team.addPlayer(new Player({
    id: `wk_${++id}`,
    name: `Player wk_${id}`,
    age: 25,
    country: "India",
    role: "batsman",
    ratings: {
      battingIQ: 72,
      timing: 70,
      power: 63,
      running: 62,
      wicketTaking: 20,
      economy: 20,
      accuracy: 20,
      clutch: 58,
    },
    injured: false,
    injuryGamesLeft: 0,
    isInternational: false,
    isWicketKeeper: true,
  }), 5);

  for (let i = 0; i < 3; i++) team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder"), 5);
  for (let i = 0; i < 4; i++) team.addPlayer(makePlayer(`bow_${++id}`, "bowler"), 5);

  return team;
}

function buildSpinHeavyTeam(configIdx: number, configOverride: Partial<TeamConfig> = {}): Team {
  const team = new Team({ ...IPL_TEAMS[configIdx], ...configOverride });
  let id = configIdx * 1000;
  const bowlingStyles = ["off-spin", "leg-spin", "left-arm-orthodox", "left-arm-wrist-spin"] as const;

  for (let i = 0; i < 4; i++) {
    team.addPlayer(makePlayer(`bat_${++id}`, "batsman", { battingHand: "right" }), 5);
  }

  team.addPlayer(new Player({
    id: `wk_${++id}`,
    name: `Player wk_${id}`,
    age: 25,
    country: "India",
    role: "batsman",
    ratings: {
      battingIQ: 72,
      timing: 70,
      power: 63,
      running: 62,
      wicketTaking: 20,
      economy: 20,
      accuracy: 20,
      clutch: 58,
    },
    injured: false,
    injuryGamesLeft: 0,
    isInternational: false,
    isWicketKeeper: true,
    battingHand: "right",
  }), 5);

  for (let i = 0; i < 3; i++) {
    team.addPlayer(makePlayer(`ar_${++id}`, "all-rounder", {
      battingHand: "right",
      bowlingStyle: bowlingStyles[i],
      ratings: { wicketTaking: 62, economy: 61, accuracy: 58 },
    }), 5);
  }

  for (let i = 0; i < 4; i++) {
    team.addPlayer(makePlayer(`bow_${++id}`, "bowler", {
      battingHand: "right",
      bowlingStyle: bowlingStyles[i],
      ratings: { wicketTaking: 74, economy: 72, accuracy: 69, clutch: 60 },
    }), 5);
  }

  return team;
}

function averageLiveFirstInnings(matches: number, homeFactory: () => Team, awayFactory: () => Team): {
  runs: number;
  wickets: number;
} {
  let runs = 0;
  let wickets = 0;

  for (let i = 0; i < matches; i++) {
    const initial = createMatchState(homeFactory(), awayFactory(), RULE_PRESETS.modern, null);
    const { state } = simulateRemaining(initial);
    runs += state.innings1Score ?? 0;
    wickets += state.innings1Wickets ?? 0;
  }

  return { runs: runs / matches, wickets: wickets / matches };
}

describe("live match venue logic", () => {
  it("uses venue-aware toss logic for heavy dew and seaming pitches", () => {
    for (let i = 0; i < 5; i++) {
      const dewState = createMatchState(
        buildTeam(0, { dewFactor: "heavy", pitchType: "balanced" }),
        buildTeam(1),
        RULE_PRESETS.modern,
        null,
      );
      expect(dewState.tossDecision).toBe("bowl");

      const seamState = createMatchState(
        buildTeam(2, { dewFactor: "none", pitchType: "seaming" }),
        buildTeam(3),
        RULE_PRESETS.modern,
        null,
      );
      expect(seamState.tossDecision).toBe("bat");
    }
  });

  it("simulates cleanly when venue metadata is missing", () => {
    const initial = createMatchState(
      buildTeam(0, { pitchType: undefined, boundarySize: undefined, dewFactor: undefined }),
      buildTeam(1, { pitchType: undefined, boundarySize: undefined, dewFactor: undefined }),
      RULE_PRESETS.modern,
      null,
    );
    const { state, balls } = simulateRemaining(initial);

    expect(state.status).toBe("completed");
    expect(state.ballLog.length).toBeGreaterThan(0);
    expect(balls.length).toBeGreaterThan(0);
  });

  it("turning pitches suppress spin-heavy first innings scoring in aggregate", { timeout: 30000 }, () => {
    const matches = 12;
    const flat = averageLiveFirstInnings(
      matches,
      () => buildSpinHeavyTeam(0, { pitchType: "flat", boundarySize: "medium", dewFactor: "none", stadiumBowlingRating: 1.0 }),
      () => buildSpinHeavyTeam(1),
    );
    const turning = averageLiveFirstInnings(
      matches,
      () => buildSpinHeavyTeam(0, { pitchType: "turning", boundarySize: "medium", dewFactor: "none", stadiumBowlingRating: 1.0 }),
      () => buildSpinHeavyTeam(1),
    );

    expect(turning.runs).toBeLessThan(flat.runs);
    expect(turning.wickets).toBeGreaterThan(flat.wickets);
  });
});
