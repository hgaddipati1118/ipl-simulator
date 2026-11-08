/**
 * Win probability calculator for live T20 matches.
 *
 * Uses a simple model based on:
 * - Current score vs par score for this point in the innings
 * - Wickets in hand
 * - Run rate vs required rate (2nd innings)
 * - Team power ratings
 *
 * Returns probability 0-100 for the batting team. A 50-over innings (`totalOvers: 50`) uses the ODI model fitted on
 * Cricsheet ODIs instead (odiWinProbability: runs still to come from the DLS resources against runs needed, or the
 * projected total in the first innings; odi-win-probability-data.ts, docs/FORMATS.md).
 */

import { ODI_WIN_PROBABILITY } from "./odi-win-probability-data.js";
import { resources50 } from "./dls.js";

/** T20 par scores by over (cumulative, 1st innings, average ~165) */
const PAR_SCORES_1ST = [
  0,   // 0 overs
  10,  // 1
  20,  // 2
  30,  // 3
  39,  // 4
  48,  // 5
  56,  // 6 (end of powerplay)
  64,  // 7
  71,  // 8
  78,  // 9
  85,  // 10 (halfway)
  93,  // 11
  101, // 12
  110, // 13
  119, // 14
  128, // 15
  138, // 16
  148, // 17
  158, // 18
  168, // 19
  178, // 20 (full innings)
];

/** Calculate win probability for the batting team */
export function calculateWinProbability(params: {
  score: number;
  wickets: number;
  overs: number;         // completed overs
  balls: number;         // balls in current over (0-5)
  innings: 1 | 2;
  target?: number;       // 2nd innings target
  battingTeamPower: number;  // 0-100
  bowlingTeamPower: number;  // 0-100
  /** Overs in a full innings (default 20; 50 = an ODI, on the fitted ODI model) */
  totalOvers?: number;
  /** ODI: the overs this innings is scheduled for, when rain cut it (default totalOvers) */
  inningsOvers?: number;
  /** ODI: men's or women's model (default men's) */
  gender?: "male" | "female";
}): number {
  const { score, wickets, overs, balls, innings, target, battingTeamPower, bowlingTeamPower } = params;

  if ((params.totalOvers ?? 20) >= 50) {
    return odiWinProbability({
      score, wickets, ballsBowled: overs * 6 + balls, innings, target,
      inningsOvers: params.inningsOvers ?? params.totalOvers ?? 50, gender: params.gender ?? "male",
      qualityLogit: (battingTeamPower - bowlingTeamPower) / 50,
    });
  }

  const totalBalls = overs * 6 + balls;
  const oversDecimal = totalBalls / 6;

  if (innings === 1) {
    return firstInningsWinProb(score, wickets, oversDecimal, battingTeamPower, bowlingTeamPower);
  } else {
    return chaseWinProb(score, wickets, oversDecimal, target ?? score + 1, battingTeamPower, bowlingTeamPower);
  }
}

function firstInningsWinProb(
  score: number,
  wickets: number,
  overs: number,
  batPower: number,
  bowlPower: number,
): number {
  // In first innings, both teams start at ~50%.
  // Being ahead of par tilts probability, wickets lost tilt it back.
  const overIdx = Math.min(Math.floor(overs), 19);
  const parScore = PAR_SCORES_1ST[overIdx] + (PAR_SCORES_1ST[overIdx + 1] - PAR_SCORES_1ST[overIdx]) * (overs - overIdx);

  // Score differential from par
  const scoreDiff = score - parScore;
  const scoreFactor = scoreDiff / 30; // ±1 for 30 runs ahead/behind par

  // Wickets factor (losing wickets is bad)
  const wicketFactor = -wickets * 0.06; // each wicket ~6% swing

  // Team quality difference
  const qualityFactor = (batPower - bowlPower) / 200; // ±0.5 for 100-point gap

  // Combine (logistic-like)
  const rawProb = 0.5 + scoreFactor * 0.15 + wicketFactor + qualityFactor;
  return Math.round(clamp(rawProb * 100, 2, 98));
}

function chaseWinProb(
  score: number,
  wickets: number,
  overs: number,
  target: number,
  batPower: number,
  bowlPower: number,
): number {
  const runsNeeded = target - score;
  const ballsLeft = Math.max(1, 120 - Math.round(overs * 6));
  const requiredRate = (runsNeeded / ballsLeft) * 6;
  const wicketsInHand = 10 - wickets;

  // Already won
  if (runsNeeded <= 0) return 100;
  // All out or no balls left
  if (wicketsInHand <= 0 || ballsLeft <= 0) return 0;

  // Required rate factor
  // RRR < 6 = comfortable, 6-10 = tight, 10-15 = very hard, 15+ = nearly impossible
  let rrFactor: number;
  if (requiredRate < 4) rrFactor = 0.85;
  else if (requiredRate < 7) rrFactor = 0.70 - (requiredRate - 4) * 0.05;
  else if (requiredRate < 10) rrFactor = 0.55 - (requiredRate - 7) * 0.08;
  else if (requiredRate < 15) rrFactor = 0.31 - (requiredRate - 10) * 0.05;
  else rrFactor = 0.06 - (requiredRate - 15) * 0.01;

  // Wickets in hand boost
  const wicketBoost = wicketsInHand * 0.04; // each wicket = ~4% more chance

  // Balls remaining factor (more balls = higher chance)
  const ballsFactor = Math.min(ballsLeft / 120, 1) * 0.1;

  // Team quality
  const qualityFactor = (batPower - bowlPower) / 300;

  const rawProb = (rrFactor + wicketBoost + ballsFactor + qualityFactor) * 100;
  return Math.round(clamp(rawProb, 1, 99));
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * ODI win probability for the batting side (0-100), fitted on Cricsheet ODIs (odi-win-probability-data.ts): the runs
 * still to come at the average scoring level, E = g x R(overs left, wickets down) / 100 (the DLS resources), against the
 * runs needed in a chase, or the projected total (runs + E) against the average total in the first innings.
 */
export function odiWinProbability(p: {
  score: number;
  wickets: number;
  ballsBowled: number;
  innings: 1 | 2;
  target?: number;
  inningsOvers: number;
  gender: "male" | "female";
  /** A strength edge on the logit scale (0 = equal sides) */
  qualityLogit?: number;
}): number {
  const m = ODI_WIN_PROBABILITY[p.gender === "female" ? "women" : "men"];
  const oversLeft = Math.max(0, p.inningsOvers - p.ballsBowled / 6);
  const E = (m.g * resources50(oversLeft, p.wickets)) / 100;
  const q = p.qualityLogit ?? 0;
  if (p.innings === 2) {
    const need = (p.target ?? p.score + 1) - p.score;
    if (need <= 0) return 100;
    if (p.wickets >= 10 || oversLeft <= 0) return 0;
    const x = (E - need) / Math.sqrt(E + m.chase.c);
    // the stage: the end of a chase is sharper than its start
    let k = 0;
    m.chase.stages.forEach((lo, i) => { if (oversLeft >= lo) k = i; });
    return Math.round(clamp(100 * logistic(m.chase.a[k] + m.chase.b[k] * x + q), 1, 99));
  }
  const x = (p.score + E - m.g) / m.sd;
  return Math.round(clamp(100 * logistic(m.first.a + m.first.b * x + q), 2, 98));
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
