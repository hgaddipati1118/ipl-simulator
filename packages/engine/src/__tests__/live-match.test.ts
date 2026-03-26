import { describe, expect, it } from "vitest";
import { applyDecision, applyLiveBallContextModifiers, buildDetailedResultFromState, createMatchState, simulateRemaining, startSecondInnings } from "../live-match.js";
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

function buildPendingDrsState(options: {
  actuallyOut: boolean;
  marginal?: boolean;
  reviewsRemaining?: number;
}): {
  state: ReturnType<typeof createMatchState>;
  strikerId: string;
  bowlerId: string;
  bowlingTeamIsHome: boolean;
} {
  const home = buildTeam(0);
  const away = buildTeam(1);
  const state = createMatchState(home, away, RULE_PRESETS.modern, away.id, 7);
  const strikerId = state._internal.battingOrderIds[state.strikerIdx];
  const bowlerId = state._internal.bowlingOrderIds[state.currentBowlerIdx];
  const bowlingTeamIsHome = state.bowlingTeamId === state.homeTeam.id;

  const commentary = `${state.currentBowlerName} to ${state.strikerName}, appeal for lbw! Not out.`;
  const rawBall = {
    over: 0,
    ball: 1,
    bowler: bowlerId,
    batter: strikerId,
    outcome: "dot" as const,
    runs: 0,
    extras: 0,
    isWicket: false,
    commentary,
    _drsOverturns: options.actuallyOut,
    _drsMarginal: options.marginal ?? false,
  };

  state._internal.currentInningsRaw.ballLog = [rawBall];
  state._internal.currentInningsRaw.bowlerStats[bowlerId] = {
    overs: 0,
    balls: 1,
    runs: 0,
    wickets: 0,
    wides: 0,
    noballs: 0,
  };

  const liveBowler = state.bowlerStats.find(b => b.playerId === bowlerId)!;
  liveBowler.balls = 1;
  liveBowler.dots = 1;

  const detailedBall = {
    over: 0,
    ball: 1,
    innings: 1 as const,
    batterName: state.strikerName,
    bowlerName: state.currentBowlerName,
    runs: 0,
    extras: 0,
    eventType: "dot" as const,
    commentary,
    scoreSoFar: 0,
    wicketsSoFar: 0,
  };

  state.ballLog = [detailedBall];
  state.innings1BallLog = [detailedBall];
  state.status = "waiting_for_decision";
  state.pendingDecision = {
    type: "drs_review",
    options: ["review", "accept"],
    teamId: state.bowlingTeamId,
    drsContext: {
      batterName: state.strikerName,
      bowlerName: state.currentBowlerName,
      reviewKind: "lbw",
      reviewingSide: "bowling",
      onFieldCall: "not_out",
      isGivenOut: false,
    },
  };

  if (bowlingTeamIsHome) state.drsRemaining.home = options.reviewsRemaining ?? 2;
  else state.drsRemaining.away = options.reviewsRemaining ?? 2;

  return { state, strikerId, bowlerId, bowlingTeamIsHome };
}

function buildPendingExtraReviewState(options: {
  reviewKind: "wide" | "noball";
  reviewingSide: "batting" | "bowling";
  overturns: boolean;
  reviewsRemaining?: number;
}): {
  state: ReturnType<typeof createMatchState>;
  strikerId: string;
  bowlerId: string;
  reviewingTeamIsHome: boolean;
} {
  const home = buildTeam(0);
  const away = buildTeam(1);
  const userTeamId = options.reviewingSide === "batting" ? home.id : away.id;
  const state = createMatchState(home, away, RULE_PRESETS.modern, userTeamId, 9);

  const strikerId = state._internal.battingOrderIds[state.strikerIdx];
  const bowlerId = state._internal.bowlingOrderIds[state.currentBowlerIdx];
  const reviewingTeamId = options.reviewingSide === "batting" ? state.battingTeamId : state.bowlingTeamId;
  const reviewingTeamIsHome = reviewingTeamId === state.homeTeam.id;

  const commentary = options.reviewingSide === "batting"
    ? `${state.currentBowlerName} to ${state.strikerName}, ${options.reviewKind === "wide" ? "no wide says the umpire." : "not called a no ball."}`
    : `${state.currentBowlerName} to ${state.strikerName}, ${options.reviewKind === "wide" ? "wide called by the umpire." : "no ball called by the umpire."}`;
  const rawBall = {
    over: 0,
    ball: options.reviewingSide === "batting" ? 1 : 0,
    bowler: bowlerId,
    batter: strikerId,
    outcome: options.reviewingSide === "batting" ? ("dot" as const) : options.reviewKind,
    runs: 0,
    extras: options.reviewingSide === "batting" ? 0 : 1,
    isWicket: false,
    commentary,
    _drsOverturns: options.overturns,
  };

  state._internal.currentInningsRaw.ballLog = [rawBall];

  const liveBowler = state.bowlerStats.find(b => b.playerId === bowlerId)!;
  const liveBatter = state.batterStats.find(b => b.playerId === strikerId)!;

  if (options.reviewingSide === "batting") {
    state._internal.currentInningsRaw.totalBalls = 1;
    state._internal.currentOverLegalBalls = 1;
    state.balls = 1;

    state._internal.currentInningsRaw.batterStats[strikerId] = {
      runs: 0,
      balls: 1,
      fours: 0,
      sixes: 0,
      isOut: false,
    };
    liveBatter.balls = 1;

    state._internal.currentInningsRaw.bowlerStats[bowlerId] = {
      overs: 0,
      balls: 1,
      runs: 0,
      wickets: 0,
      wides: 0,
      noballs: 0,
    };
    liveBowler.balls = 1;
    liveBowler.dots = 1;
  } else {
    state.score = 1;
    state.extras = 1;
    state._internal.currentInningsRaw.runs = 1;
    state._internal.currentInningsRaw.extras = 1;
    state._internal.currentInningsRaw.totalBalls = 0;
    state._internal.currentOverLegalBalls = 0;
    state.balls = 0;

    state._internal.currentInningsRaw.bowlerStats[bowlerId] = {
      overs: 0,
      balls: 0,
      runs: 1,
      wickets: 0,
      wides: options.reviewKind === "wide" ? 1 : 0,
      noballs: options.reviewKind === "noball" ? 1 : 0,
    };
    liveBowler.runs = 1;
    if (options.reviewKind === "wide") liveBowler.wides = 1;
    else liveBowler.noBalls = 1;
  }

  const detailedBall = {
    over: 0,
    ball: rawBall.ball,
    innings: 1 as const,
    batterName: state.strikerName,
    bowlerName: state.currentBowlerName,
    runs: 0,
    extras: rawBall.extras,
    eventType: options.reviewingSide === "batting" ? ("dot" as const) : options.reviewKind,
    commentary,
    scoreSoFar: state.score,
    wicketsSoFar: 0,
  };

  state.ballLog = [detailedBall];
  state.innings1BallLog = [detailedBall];
  state.status = "waiting_for_decision";
  state.pendingDecision = {
    type: "drs_review",
    options: ["review", "accept"],
    teamId: reviewingTeamId,
    drsContext: {
      batterName: state.strikerName,
      bowlerName: state.currentBowlerName,
      reviewKind: options.reviewKind,
      reviewingSide: options.reviewingSide,
      onFieldCall: options.reviewingSide === "batting"
        ? (options.reviewKind === "wide" ? "not_wide" : "not_noball")
        : options.reviewKind,
      isGivenOut: false,
    },
  };

  if (reviewingTeamIsHome) state.drsRemaining.home = options.reviewsRemaining ?? 2;
  else state.drsRemaining.away = options.reviewsRemaining ?? 2;

  return { state, strikerId, bowlerId, reviewingTeamIsHome };
}

function buildCompletedDetailState(state: ReturnType<typeof createMatchState>) {
  const completed = JSON.parse(JSON.stringify(state)) as ReturnType<typeof createMatchState>;
  completed.status = "completed";
  completed.result = "Test result";
  completed.innings = 2;
  completed.innings2BallLog = [...completed.innings1BallLog];
  completed.innings1BallLog = [];
  completed.ballLog = [...completed.innings2BallLog];
  completed.innings1Score = 120;
  completed.innings1Wickets = 5;
  completed.innings1Overs = "20.0";
  completed.innings1Scorecard = {
    battingTeamId: completed.homeTeam.id,
    battingTeamName: completed.homeTeam.name,
    bowlingTeamId: completed.awayTeam.id,
    bowlingTeamName: completed.awayTeam.name,
    totalRuns: 120,
    totalWickets: 5,
    totalOvers: "20.0",
    batters: [],
    bowlers: [],
    extras: {
      wides: 0,
      noBalls: 0,
      legByes: 0,
      total: 0,
    },
    fallOfWickets: [],
  };
  return completed;
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

  it("simulates cleanly when venue metadata is missing", { timeout: 30000 }, () => {
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

  it("turning pitches suppress spin-heavy first innings scoring in aggregate", { timeout: 120000 }, () => {
    const matches = 16;
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

describe("applyLiveBallContextModifiers", () => {
  const baseProbs = {
    dot: 0.32,
    "1": 0.28,
    "2": 0.08,
    "3": 0.01,
    "4": 0.10,
    "6": 0.05,
    wicket: 0.06,
    wide: 0.03,
    noball: 0.01,
    legbye: 0.02,
  } satisfies Record<import("../match.js").BallOutcome, number>;

  it("makes new batters shakier and set batters more dangerous", () => {
    const newBatter = applyLiveBallContextModifiers(baseProbs, { batterBalls: 4, over: 8 });
    const setBatter = applyLiveBallContextModifiers(baseProbs, { batterBalls: 34, over: 8 });

    expect(newBatter.wicket).toBeGreaterThan(baseProbs.wicket);
    expect(newBatter["4"]).toBeLessThan(baseProbs["4"]);
    expect(setBatter.wicket).toBeLessThan(baseProbs.wicket);
    expect(setBatter["4"]).toBeGreaterThan(baseProbs["4"]);
    expect(setBatter["6"]).toBeGreaterThan(baseProbs["6"]);
  });

  it("pace fatigue is stronger than spin fatigue", () => {
    const tiredPacer = applyLiveBallContextModifiers(baseProbs, {
      batterBalls: 12,
      bowlerOversBowled: 3,
      bowlingStyle: "right-arm-fast",
      over: 17,
    });
    const tiredSpinner = applyLiveBallContextModifiers(baseProbs, {
      batterBalls: 12,
      bowlerOversBowled: 3,
      bowlingStyle: "off-spin",
      over: 17,
    });

    // Both pace and spin get fatigued, but pace is worse
    expect(tiredPacer.wide).toBeGreaterThan(baseProbs.wide);
    expect(tiredPacer.noball).toBeGreaterThan(baseProbs.noball);
    expect(tiredPacer["4"]).toBeGreaterThan(baseProbs["4"]);
    // Spinner fatigue is milder — affects boundaries but not wides/noballs
    expect(tiredSpinner["4"]).toBeGreaterThan(baseProbs["4"]);
    expect(tiredSpinner["6"]).toBeGreaterThan(baseProbs["6"]);
    // Pace fatigue on fours should exceed spin fatigue on fours
    expect(tiredPacer["4"]).toBeGreaterThan(tiredSpinner["4"]);
  });
});

describe("live match DRS", () => {
  it("resets reviews for both teams at the start of the second innings", () => {
    const state = createMatchState(buildTeam(0), buildTeam(1), RULE_PRESETS.modern, null, 11);
    state.status = "innings_break";
    state.drsRemaining = { home: 0, away: 1 };

    const next = startSecondInnings(state);

    expect(next.drsRemaining).toEqual({ home: 2, away: 2 });
  });

  it("successful user reviews update raw and live wicket stats while retaining the review", () => {
    const { state, strikerId, bowlerId, bowlingTeamIsHome } = buildPendingDrsState({
      actuallyOut: true,
      reviewsRemaining: 2,
    });

    const next = applyDecision(state, { type: "drs_review", selectedPlayerId: "review" });

    expect(next.wickets).toBe(1);
    expect(next._internal.currentInningsRaw.wickets).toBe(1);
    expect(next._internal.currentInningsRaw.batterStats[strikerId].isOut).toBe(true);
    expect(next._internal.currentInningsRaw.bowlerStats[bowlerId].wickets).toBe(1);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.wickets).toBe(1);
    expect(next.ballLog[next.ballLog.length - 1].eventType).toBe("wicket");
    expect(bowlingTeamIsHome ? next.drsRemaining.home : next.drsRemaining.away).toBe(2);
  });

  it("clear misses consume a review but umpire's call retains it", () => {
    const clearMiss = buildPendingDrsState({
      actuallyOut: false,
      marginal: false,
      reviewsRemaining: 2,
    });
    const clearMissNext = applyDecision(clearMiss.state, { type: "drs_review", selectedPlayerId: "review" });
    expect(clearMiss.bowlingTeamIsHome ? clearMissNext.drsRemaining.home : clearMissNext.drsRemaining.away).toBe(1);
    expect(clearMissNext.ballLog[clearMissNext.ballLog.length - 1].commentary).toContain("lose their review");

    const marginal = buildPendingDrsState({
      actuallyOut: false,
      marginal: true,
      reviewsRemaining: 2,
    });
    const marginalNext = applyDecision(marginal.state, { type: "drs_review", selectedPlayerId: "review" });
    expect(marginal.bowlingTeamIsHome ? marginalNext.drsRemaining.home : marginalNext.drsRemaining.away).toBe(2);
    expect(marginalNext.ballLog[marginalNext.ballLog.length - 1].commentary).toContain("UMPIRE'S CALL");
  });

  it("successful batting wide reviews turn a legal dot into an extra and rebowl", () => {
    const { state, strikerId, bowlerId, reviewingTeamIsHome } = buildPendingExtraReviewState({
      reviewKind: "wide",
      reviewingSide: "batting",
      overturns: true,
      reviewsRemaining: 2,
    });

    const next = applyDecision(state, { type: "drs_review", selectedPlayerId: "review" });

    expect(next.score).toBe(1);
    expect(next.extras).toBe(1);
    expect(next.balls).toBe(0);
    expect(next._internal.currentOverLegalBalls).toBe(0);
    expect(next._internal.currentInningsRaw.totalBalls).toBe(0);
    expect(next._internal.currentInningsRaw.batterStats[strikerId].balls).toBe(0);
    expect(next._internal.currentInningsRaw.bowlerStats[bowlerId].balls).toBe(0);
    expect(next._internal.currentInningsRaw.bowlerStats[bowlerId].wides).toBe(1);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.runs).toBe(1);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.wides).toBe(1);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.balls).toBe(0);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.dots).toBe(0);
    expect(next.batterStats.find(b => b.playerId === strikerId)?.balls).toBe(0);
    expect(next.ballLog[next.ballLog.length - 1].eventType).toBe("wide");
    expect(next.ballLog[next.ballLog.length - 1].commentary).toContain("OVERTURNED");
    expect(reviewingTeamIsHome ? next.drsRemaining.home : next.drsRemaining.away).toBe(2);
  });

  it("successful bowling no-ball reviews remove the extra and make the delivery legal", () => {
    const { state, strikerId, bowlerId, reviewingTeamIsHome } = buildPendingExtraReviewState({
      reviewKind: "noball",
      reviewingSide: "bowling",
      overturns: true,
      reviewsRemaining: 2,
    });

    const next = applyDecision(state, { type: "drs_review", selectedPlayerId: "review" });

    expect(next.score).toBe(0);
    expect(next.extras).toBe(0);
    expect(next.balls).toBe(1);
    expect(next._internal.currentOverLegalBalls).toBe(1);
    expect(next._internal.currentInningsRaw.totalBalls).toBe(1);
    expect(next._internal.currentInningsRaw.batterStats[strikerId].balls).toBe(1);
    expect(next._internal.currentInningsRaw.bowlerStats[bowlerId].balls).toBe(1);
    expect(next._internal.currentInningsRaw.bowlerStats[bowlerId].noballs).toBe(0);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.runs).toBe(0);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.noBalls).toBe(0);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.balls).toBe(1);
    expect(next.bowlerStats.find(b => b.playerId === bowlerId)?.dots).toBe(1);
    expect(next.batterStats.find(b => b.playerId === strikerId)?.balls).toBe(1);
    expect(next.ballLog[next.ballLog.length - 1].eventType).toBe("dot");
    expect(next.ballLog[next.ballLog.length - 1].commentary).toContain("OVERTURNED");
    expect(reviewingTeamIsHome ? next.drsRemaining.home : next.drsRemaining.away).toBe(2);
  });

  it("failed extra-call reviews consume a review", () => {
    const battingMiss = buildPendingExtraReviewState({
      reviewKind: "wide",
      reviewingSide: "batting",
      overturns: false,
      reviewsRemaining: 2,
    });
    const battingMissNext = applyDecision(battingMiss.state, { type: "drs_review", selectedPlayerId: "review" });
    expect(battingMiss.reviewingTeamIsHome ? battingMissNext.drsRemaining.home : battingMissNext.drsRemaining.away).toBe(1);
    expect(battingMissNext.ballLog[battingMissNext.ballLog.length - 1].commentary).toContain("lose their review");

    const bowlingMiss = buildPendingExtraReviewState({
      reviewKind: "noball",
      reviewingSide: "bowling",
      overturns: false,
      reviewsRemaining: 2,
    });
    const bowlingMissNext = applyDecision(bowlingMiss.state, { type: "drs_review", selectedPlayerId: "review" });
    expect(bowlingMiss.reviewingTeamIsHome ? bowlingMissNext.drsRemaining.home : bowlingMissNext.drsRemaining.away).toBe(1);
    expect(bowlingMissNext.ballLog[bowlingMissNext.ballLog.length - 1].commentary).toContain("lose their review");
  });

  it("keeps zero-legal-ball bowlers in exported scorecards after extra-call reviews", () => {
    const { state, bowlerId } = buildPendingExtraReviewState({
      reviewKind: "wide",
      reviewingSide: "batting",
      overturns: true,
      reviewsRemaining: 2,
    });

    const reviewed = applyDecision(state, { type: "drs_review", selectedPlayerId: "review" });
    const detailed = buildDetailedResultFromState(buildCompletedDetailState(reviewed));
    const exportedBowler = detailed.innings2.bowlers.find(b => b.playerId === bowlerId);

    expect(exportedBowler).toBeDefined();
    expect(exportedBowler?.overs).toBe("0.0");
    expect(exportedBowler?.runs).toBe(1);
    expect(exportedBowler?.wides).toBe(1);
    expect(exportedBowler?.noBalls).toBe(0);
    expect(detailed.innings2.extras.wides).toBe(1);
    expect(detailed.innings2.extras.total).toBe(1);
  });
});
