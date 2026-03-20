/**
 * Ball-by-ball T20 match simulation engine.
 * Ported and enhanced from IndianCricketLeague/GameClass.js
 *
 * Uses a multi-layer probability system:
 *   1. Base outcome matrix (batter rating x bowler rating)
 *   2. Phase multipliers (powerplay / middle / death)
 *   3. Chase context (required run rate in 2nd innings)
 *   4. Pressure/clutch factors
 *   5. Stadium bowling rating (home advantage)
 */

import { Player } from "./player.js";
import { Team } from "./team.js";
import { clamp, weightedRandom } from "./math.js";

export type BallOutcome = "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball" | "legbye";

export interface BallEvent {
  over: number;
  ball: number;
  bowler: string;
  batter: string;
  outcome: BallOutcome;
  runs: number;       // runs scored off this ball
  extras: number;     // extra runs (wides, noballs)
  isWicket: boolean;
  commentary: string;
}

export interface InningsScore {
  teamId: string;
  runs: number;
  wickets: number;
  overs: number;      // completed overs
  balls: number;      // balls in current over
  totalBalls: number; // total legal deliveries faced
  extras: number;
  fours: number;
  sixes: number;
  ballLog: BallEvent[];
  batterStats: Map<string, { runs: number; balls: number; fours: number; sixes: number; isOut: boolean }>;
  bowlerStats: Map<string, { overs: number; balls: number; runs: number; wickets: number; wides: number; noballs: number }>;
}

export interface MatchResult {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  tossWinner: string;
  tossDecision: "bat" | "bowl";
  innings: [InningsScore, InningsScore];
  superOver?: [InningsScore, InningsScore];
  winnerId: string | null; // null for tie/no result
  margin: string;    // "5 wickets", "23 runs", "Super Over"
  motm: string;      // man of the match player id
}

/** Phase of the innings based on over number */
function getPhase(over: number): "powerplay" | "middle" | "death" {
  if (over < 6) return "powerplay";
  if (over < 15) return "middle";
  return "death";
}

/** Phase multipliers for outcome probabilities */
const PHASE_MULTIPLIERS: Record<string, Record<string, number>> = {
  powerplay: { dot: 0.85, "1": 1.0, "2": 0.9, "3": 1.0, "4": 1.3, "6": 1.1, wicket: 0.9, wide: 1.1, noball: 1.0 },
  middle:    { dot: 1.1,  "1": 1.1, "2": 1.0, "3": 1.0, "4": 0.9, "6": 0.85, wicket: 1.0, wide: 0.9, noball: 1.0 },
  death:     { dot: 0.8,  "1": 0.9, "2": 1.1, "3": 1.1, "4": 1.2, "6": 1.4, wicket: 1.2, wide: 1.2, noball: 1.1 },
};

/** Generate base outcome probabilities from batter and bowler ratings */
function baseOutcomeProbabilities(
  batter: Player,
  bowler: Player,
): Record<BallOutcome, number> {
  const batRating = (batter.battingOvr + batter.ratings.timing) / 2 / 100;
  const bowlRating = (bowler.bowlingOvr + bowler.ratings.accuracy) / 2 / 100;

  // Balance between batter and bowler determines distribution
  const balance = batRating - bowlRating; // -1 to 1, positive favors batter

  return {
    dot:    clamp(0.35 - balance * 0.15, 0.15, 0.55),
    "1":    clamp(0.28 + balance * 0.03, 0.18, 0.38),
    "2":    clamp(0.08 + balance * 0.02, 0.03, 0.15),
    "3":    clamp(0.015, 0.005, 0.03),
    "4":    clamp(0.10 + balance * 0.06 + (batter.ratings.timing / 100) * 0.04, 0.04, 0.22),
    "6":    clamp(0.05 + balance * 0.05 + (batter.ratings.power / 100) * 0.05, 0.01, 0.18),
    wicket: clamp(0.05 - balance * 0.03 + (bowler.ratings.wicketTaking / 100) * 0.03, 0.01, 0.12),
    wide:   clamp(0.04 - (bowler.ratings.accuracy / 100) * 0.02, 0.01, 0.08),
    noball:  clamp(0.01 - (bowler.ratings.accuracy / 100) * 0.005, 0.002, 0.03),
    legbye: 0.02,
  };
}

/** Adjust probabilities for chase context in 2nd innings */
function chaseAdjustment(
  probs: Record<BallOutcome, number>,
  requiredRate: number,
  currentRate: number,
  wicketsDown: number,
): Record<BallOutcome, number> {
  const pressure = (requiredRate - currentRate) / 8; // normalized pressure (-1 to 1+)
  const wicketPressure = wicketsDown >= 7 ? 0.3 : wicketsDown >= 5 ? 0.15 : 0;

  const adjusted = { ...probs };
  if (pressure > 0) {
    // Need to accelerate
    adjusted["4"] *= 1 + pressure * 0.3;
    adjusted["6"] *= 1 + pressure * 0.5;
    adjusted.dot *= 1 - pressure * 0.2;
    adjusted.wicket *= 1 + pressure * 0.2 + wicketPressure;
  } else {
    // Comfortable position, play safe
    adjusted.dot *= 1 + Math.abs(pressure) * 0.1;
    adjusted["1"] *= 1 + Math.abs(pressure) * 0.1;
    adjusted.wicket *= 1 - Math.abs(pressure) * 0.1;
  }

  return adjusted;
}

/** Simulate a single ball */
function simulateBall(
  batter: Player,
  bowler: Player,
  over: number,
  isSecondInnings: boolean,
  target: number,
  currentScore: number,
  ballsRemaining: number,
  wicketsDown: number,
  stadiumBowlRating: number,
): BallEvent {
  let probs = baseOutcomeProbabilities(batter, bowler);

  // Phase adjustment
  const phase = getPhase(over);
  const phaseMult = PHASE_MULTIPLIERS[phase];
  for (const key of Object.keys(probs) as BallOutcome[]) {
    probs[key] *= phaseMult[key] ?? 1;
  }

  // Stadium bowling adjustment
  probs.wicket *= stadiumBowlRating;
  probs.dot *= stadiumBowlRating;

  // Chase context
  if (isSecondInnings && ballsRemaining > 0) {
    const requiredRate = ((target - currentScore) / ballsRemaining) * 6;
    const currentRate = ballsRemaining < 120
      ? (currentScore / (120 - ballsRemaining)) * 6
      : 0;
    probs = chaseAdjustment(probs, requiredRate, currentRate, wicketsDown);
  }

  // Clutch factor for last 3 overs in close games
  if (over >= 17 && isSecondInnings) {
    const runsNeeded = target - currentScore;
    if (runsNeeded > 0 && runsNeeded <= 30) {
      const clutchBalance = (batter.ratings.clutch - bowler.ratings.clutch) / 100;
      probs["6"] *= 1 + clutchBalance * 0.3;
      probs["4"] *= 1 + clutchBalance * 0.2;
      probs.wicket *= 1 - clutchBalance * 0.2;
    }
  }

  // Normalize and sample
  const entries = Object.entries(probs) as [BallOutcome, number][];
  const outcome = weightedRandom(entries);

  // Determine runs
  let runs = 0;
  let extras = 0;
  let isWicket = false;

  switch (outcome) {
    case "dot": runs = 0; break;
    case "1": runs = 1; break;
    case "2": runs = 2; break;
    case "3": runs = 3; break;
    case "4": runs = 4; break;
    case "6": runs = 6; break;
    case "wicket": isWicket = true; runs = 0; break;
    case "wide": extras = 1; break;
    case "noball": extras = 1; break;
    case "legbye": extras = 1; break;
  }

  const commentary = generateCommentary(outcome, batter.name, bowler.name, over, runs);

  return {
    over,
    ball: 0, // filled in by innings simulation
    bowler: bowler.id,
    batter: batter.id,
    outcome,
    runs,
    extras,
    isWicket,
    commentary,
  };
}

function generateCommentary(
  outcome: BallOutcome,
  batter: string,
  bowler: string,
  over: number,
  runs: number,
): string {
  const templates: Record<BallOutcome, string[]> = {
    dot: [
      `Dot ball! ${bowler} beats ${batter}`,
      `Good delivery, no run`,
      `Defended back to ${bowler}`,
    ],
    "1": [`Single taken by ${batter}`, `Quick single, good running`],
    "2": [`Two runs to ${batter}`, `Pushed into the gap, they come back for two`],
    "3": [`Three runs! Good placement by ${batter}`],
    "4": [
      `FOUR! ${batter} finds the boundary!`,
      `Cracking shot! Four runs!`,
      `Through the gap, races to the fence!`,
    ],
    "6": [
      `SIX! ${batter} launches it into the stands!`,
      `Massive hit! That's gone all the way!`,
      `Into the crowd! What a strike by ${batter}!`,
    ],
    wicket: [
      `OUT! ${bowler} strikes! ${batter} has to go!`,
      `WICKET! Big breakthrough for the bowling side!`,
      `Gone! ${batter} departs!`,
    ],
    wide: [`Wide ball from ${bowler}, extra run conceded`],
    noball: [`No ball! Free hit coming up`],
    legbye: [`Leg bye, single added to the total`],
  };

  const options = templates[outcome];
  return options[Math.floor(Math.random() * options.length)];
}

/** Create empty innings score */
function emptyInnings(teamId: string): InningsScore {
  return {
    teamId, runs: 0, wickets: 0, overs: 0, balls: 0,
    totalBalls: 0, extras: 0, fours: 0, sixes: 0,
    ballLog: [],
    batterStats: new Map(),
    bowlerStats: new Map(),
  };
}

/** Simulate one full innings (max 20 overs or 10 wickets) */
function simulateInnings(
  battingTeam: Team,
  bowlingTeam: Team,
  xi: Player[],
  bowlingXI: Player[],
  isSecondInnings: boolean,
  target: number,
  stadiumBowlRating: number,
  maxOvers = 20,
): InningsScore {
  const innings = emptyInnings(battingTeam.id);
  const battingOrder = battingTeam.getBattingOrder(xi);
  const bowlers = bowlingTeam.getBowlingOrder(bowlingXI);

  // Safety: need at least 2 batters and 1 bowler
  if (battingOrder.length < 2 || bowlers.length < 1) {
    return innings;
  }

  let strikerIdx = 0;
  let nonStrikerIdx = 1;
  let currentBatterIdx = 2; // next batter to come in

  // Initialize batter stats
  for (const p of battingOrder) {
    innings.batterStats.set(p.id, { runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false });
  }

  // Bowling allocation: each bowler can bowl max 4 overs (or 1 in super over)
  const maxOversPerBowler = maxOvers === 1 ? 1 : 4;
  const bowlerOvers = new Map<string, number>();
  for (const b of bowlers) bowlerOvers.set(b.id, 0);

  for (let over = 0; over < maxOvers; over++) {
    // Pick bowler (can't bowl consecutive overs, max 4 each)
    const lastBowlerId = innings.ballLog.length > 0
      ? innings.ballLog[innings.ballLog.length - 1].bowler
      : null;

    const eligibleBowlers = bowlers.filter(b =>
      (bowlerOvers.get(b.id) ?? 0) < maxOversPerBowler &&
      b.id !== lastBowlerId
    );

    // If no eligible (shouldn't happen with 5+ bowlers), allow any
    const bowler = eligibleBowlers.length > 0
      ? eligibleBowlers.sort((a, b) => b.bowlingOvr - a.bowlingOvr)[
          Math.floor(Math.random() * Math.min(3, eligibleBowlers.length))
        ]
      : bowlers[0];

    let ballsInOver = 0;
    let legalBalls = 0;

    while (legalBalls < 6) {
      const striker = battingOrder[strikerIdx];
      const ballsRemaining = (maxOvers - over) * 6 - legalBalls;

      const event = simulateBall(
        striker,
        bowler,
        over,
        isSecondInnings,
        target,
        innings.runs,
        ballsRemaining,
        innings.wickets,
        stadiumBowlRating,
      );

      event.ball = legalBalls + 1;
      innings.ballLog.push(event);

      // Update scores
      if (event.outcome === "wide" || event.outcome === "noball") {
        innings.runs += event.extras;
        innings.extras += event.extras;
        // Don't count as legal delivery
        const bs = innings.bowlerStats.get(bowler.id) ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
        bs.runs += event.extras;
        if (event.outcome === "wide") bs.wides++;
        else bs.noballs++;
        innings.bowlerStats.set(bowler.id, bs);
      } else {
        legalBalls++;
        innings.totalBalls++;
        innings.runs += event.runs + event.extras;
        innings.extras += event.extras;

        // Update batter stats
        const batStat = innings.batterStats.get(striker.id)!;
        batStat.balls++;
        batStat.runs += event.runs;
        if (event.outcome === "4") { batStat.fours++; innings.fours++; }
        if (event.outcome === "6") { batStat.sixes++; innings.sixes++; }

        // Update bowler stats
        const bs = innings.bowlerStats.get(bowler.id) ?? { overs: 0, balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
        bs.balls++;
        bs.runs += event.runs + event.extras;
        if (legalBalls === 6) {
          bs.overs++;
          bs.balls = 0;
        }
        innings.bowlerStats.set(bowler.id, bs);

        if (event.isWicket) {
          innings.wickets++;
          batStat.isOut = true;
          bs.wickets++;
          if (currentBatterIdx < battingOrder.length) {
            strikerIdx = currentBatterIdx;
            currentBatterIdx++;
          }
          if (innings.wickets >= 10) break;
        } else if (event.runs % 2 === 1) {
          // Odd runs = swap strike
          [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
        }
      }

      // Check if target reached
      if (isSecondInnings && innings.runs >= target) break;
    }

    // Update over count
    bowlerOvers.set(bowler.id, (bowlerOvers.get(bowler.id) ?? 0) + 1);
    innings.overs = over + 1;
    innings.balls = 0;

    // Swap strike at end of over
    [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];

    if (innings.wickets >= 10) break;
    if (isSecondInnings && innings.runs >= target) break;
  }

  return innings;
}

/** Update player season stats from innings */
function updatePlayerStats(
  team: Team,
  innings: InningsScore,
  matchId: string,
  bowlingInnings: InningsScore,
): void {
  for (const player of team.roster) {
    const batStat = innings.batterStats.get(player.id);
    const bowlStat = bowlingInnings.bowlerStats.get(player.id);

    if (batStat) {
      player.stats.matches++;
      if (batStat.balls > 0) {
        player.stats.innings++;
        player.stats.runs += batStat.runs;
        player.stats.ballsFaced += batStat.balls;
        player.stats.fours += batStat.fours;
        player.stats.sixes += batStat.sixes;
        if (!batStat.isOut) player.stats.notOuts++;
        if (batStat.runs > player.stats.highScore) player.stats.highScore = batStat.runs;
        if (batStat.runs >= 100) player.stats.hundreds++;
        else if (batStat.runs >= 50) player.stats.fifties++;
      }
    }

    if (bowlStat && (bowlStat.overs > 0 || bowlStat.balls > 0)) {
      const overs = bowlStat.overs + bowlStat.balls / 10; // display format
      player.stats.overs += overs;
      player.stats.runsConceded += bowlStat.runs;
      player.stats.wickets += bowlStat.wickets;
    }

    player.stats.matchLog.push({
      matchId,
      runsScored: batStat?.runs ?? 0,
      ballsFaced: batStat?.balls ?? 0,
      fours: batStat?.fours ?? 0,
      sixes: batStat?.sixes ?? 0,
      wicketsTaken: bowlStat?.wickets ?? 0,
      oversBowled: bowlStat ? bowlStat.overs + bowlStat.balls / 10 : 0,
      runsConceded: bowlStat?.runs ?? 0,
    });
  }
}

/** Calculate man of the match */
function calculateMOTM(
  homeTeam: Team,
  awayTeam: Team,
  innings1: InningsScore,
  innings2: InningsScore,
): string {
  let bestScore = -1;
  let bestPlayer = "";

  const allPlayers = [...homeTeam.roster, ...awayTeam.roster];

  for (const player of allPlayers) {
    const batStat1 = innings1.batterStats.get(player.id);
    const batStat2 = innings2.batterStats.get(player.id);
    const bowlStat1 = innings1.bowlerStats?.get(player.id);
    const bowlStat2 = innings2.bowlerStats?.get(player.id);

    let score = 0;

    // Batting contribution
    const runs = (batStat1?.runs ?? 0) + (batStat2?.runs ?? 0);
    const balls = (batStat1?.balls ?? 0) + (batStat2?.balls ?? 0);
    score += runs * 1.5;
    if (balls > 0) score += ((runs / balls) * 100 - 120) * 0.3; // SR bonus
    score += ((batStat1?.sixes ?? 0) + (batStat2?.sixes ?? 0)) * 3;

    // Bowling contribution
    const wickets = (bowlStat1?.wickets ?? 0) + (bowlStat2?.wickets ?? 0);
    score += wickets * 25;
    const bowlRuns = (bowlStat1?.runs ?? 0) + (bowlStat2?.runs ?? 0);
    const bowlOvers = (bowlStat1?.overs ?? 0) + (bowlStat2?.overs ?? 0);
    if (bowlOvers > 0) {
      const econ = bowlRuns / bowlOvers;
      score += (8 - econ) * 5; // bonus for economy under 8
    }

    if (score > bestScore) {
      bestScore = score;
      bestPlayer = player.id;
    }
  }

  return bestPlayer;
}

let matchCounter = 0;

/** Simulate a full T20 match between two teams */
export function simulateMatch(
  homeTeam: Team,
  awayTeam: Team,
): MatchResult {
  const matchId = `match_${++matchCounter}`;

  const homeXI = homeTeam.getPlayingXI();
  const awayXI = awayTeam.getPlayingXI();

  // Toss
  const tossWinner = Math.random() < 0.5 ? homeTeam : awayTeam;
  // Winner usually chooses to bowl (chase) in T20s (~60%)
  const tossDecision: "bat" | "bowl" = Math.random() < 0.6 ? "bowl" : "bat";

  const battingFirst = tossDecision === "bat" ? tossWinner : (tossWinner === homeTeam ? awayTeam : homeTeam);
  const bowlingFirst = battingFirst === homeTeam ? awayTeam : homeTeam;

  const stadiumRating = homeTeam.config.stadiumBowlingRating ?? 1.0;

  // First innings
  const firstXI = battingFirst === homeTeam ? homeXI : awayXI;
  const firstBowlXI = battingFirst === homeTeam ? awayXI : homeXI;
  const innings1 = simulateInnings(
    battingFirst, bowlingFirst,
    firstXI, firstBowlXI,
    false, 0, stadiumRating,
  );

  // Second innings
  const target = innings1.runs + 1;
  const secondXI = bowlingFirst === homeTeam ? homeXI : awayXI;
  const secondBowlXI = bowlingFirst === homeTeam ? awayXI : homeXI;
  const innings2 = simulateInnings(
    bowlingFirst, battingFirst,
    secondXI, secondBowlXI,
    true, target, stadiumRating,
  );

  // Determine winner
  let winnerId: string | null;
  let margin: string;

  if (innings2.runs >= target) {
    winnerId = bowlingFirst.id;
    margin = `${10 - innings2.wickets} wickets`;
  } else if (innings2.runs < innings1.runs) {
    winnerId = battingFirst.id;
    margin = `${innings1.runs - innings2.runs} runs`;
  } else {
    // Tie → Super Over
    const so1 = simulateInnings(battingFirst, bowlingFirst, firstXI, firstBowlXI, false, 0, stadiumRating, 1);
    const so2 = simulateInnings(bowlingFirst, battingFirst, secondXI, secondBowlXI, true, so1.runs + 1, stadiumRating, 1);

    if (so2.runs > so1.runs) {
      winnerId = bowlingFirst.id;
    } else if (so1.runs > so2.runs) {
      winnerId = battingFirst.id;
    } else {
      // Super over tie: boundary count
      const homeBoundaries = innings1.fours + innings1.sixes + innings2.fours + innings2.sixes;
      const awayBoundaries = innings1.fours + innings1.sixes + innings2.fours + innings2.sixes;
      winnerId = homeBoundaries >= awayBoundaries ? homeTeam.id : awayTeam.id;
    }
    margin = "Super Over";
  }

  // Update team records
  const winner = winnerId === homeTeam.id ? homeTeam : awayTeam;
  const loser = winner === homeTeam ? awayTeam : homeTeam;

  winner.wins++;
  loser.losses++;

  // Update NRR components
  const team1Batting = battingFirst === homeTeam ? innings1 : innings2;
  const team1Bowling = battingFirst === homeTeam ? innings2 : innings1;
  const team2Batting = battingFirst === awayTeam ? innings1 : innings2;
  const team2Bowling = battingFirst === awayTeam ? innings2 : innings1;

  homeTeam.runsFor += team1Batting.runs;
  homeTeam.ballsFacedFor += team1Batting.totalBalls;
  homeTeam.runsAgainst += team1Bowling.runs;
  homeTeam.ballsFacedAgainst += team1Bowling.totalBalls;
  homeTeam.updateNRR();

  awayTeam.runsFor += team2Batting.runs;
  awayTeam.ballsFacedFor += team2Batting.totalBalls;
  awayTeam.runsAgainst += team2Bowling.runs;
  awayTeam.ballsFacedAgainst += team2Bowling.totalBalls;
  awayTeam.updateNRR();

  // Update player stats
  updatePlayerStats(battingFirst, innings1, matchId, innings2);
  updatePlayerStats(bowlingFirst, innings2, matchId, innings1);

  // Injury chance (2% per player per match)
  for (const p of [...homeXI, ...awayXI]) {
    if (Math.random() < 0.02) {
      p.injured = true;
      p.injuryGamesLeft = Math.ceil(Math.random() * 3);
    }
  }

  const motm = calculateMOTM(homeTeam, awayTeam, innings1, innings2);

  return {
    id: matchId,
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    tossWinner: tossWinner.id,
    tossDecision,
    innings: [innings1, innings2],
    winnerId,
    margin,
    motm,
  };
}
