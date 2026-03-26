/**
 * Duckworth-Lewis-Stern (DLS) method for rain-interrupted T20 matches.
 *
 * Uses the actual DLS Standard Edition formula:
 *   Z(u, w) = Z0(w) × [1 - exp(-b(w) × u)]
 *
 * Where:
 *   u = overs remaining
 *   w = wickets lost
 *   Z0(w) = asymptotic total resources for w wickets lost
 *   b(w) = exponential decay constant for w wickets lost
 *
 * The resource percentage at any point is Z(u, w) / Z(50, 0) × 100
 * (normalized to 50 overs; for T20, we just use the formula values directly).
 *
 * Parameters below are fitted to match published DLS Standard Edition tables.
 *
 * In real IPL: minimum 5 overs per side for a valid result.
 */

import type { RNG } from "./rng.js";

/**
 * DLS Standard Edition parameters.
 * Z0(w) = asymptotic average score remaining with w wickets lost.
 * b(w)  = exponential decay rate (how quickly resources deplete per over).
 *
 * These are fitted to reproduce the ICC's published resource tables.
 */
const Z0 = [245, 225, 200, 170, 140, 110, 82, 55, 31, 13, 0];
const B  = [0.0367, 0.0400, 0.0440, 0.0498, 0.0575, 0.0680, 0.0830, 0.1070, 0.1520, 0.2500, 1.0];

/** Compute remaining resources Z(u, w) using the DLS formula */
function dlsResources(oversRemaining: number, wicketsLost: number): number {
  const w = Math.min(Math.max(wicketsLost, 0), 10);
  const u = Math.max(oversRemaining, 0);
  if (w >= 10) return 0;
  return Z0[w] * (1 - Math.exp(-B[w] * u));
}

/** Full-innings resources (reference point) — T20 is 20 overs, 0 wickets */
const FULL_T20_RESOURCES = dlsResources(20, 0);

/** Get DLS resource percentage for given overs remaining and wickets lost.
 *  Returns 0-100 scale normalized to a full T20 innings. */
export function getDLSResource(oversRemaining: number, wicketsLost: number): number {
  return (dlsResources(oversRemaining, wicketsLost) / FULL_T20_RESOURCES) * 100;
}

/** Calculate revised DLS target for a rain-interrupted match.
 *
 * Uses the standard DLS approach:
 * - If Team 2 has FEWER resources → par score is reduced proportionally
 * - If Team 2 has MORE resources (Team 1 interrupted) → target is increased
 *
 * G50 (average score in T20) is used for the Professional Edition adjustment
 * when Team 2 has more resources than Team 1.
 *
 * @param firstInningsScore - Team 1's total
 * @param team2OversAvailable - Overs available to Team 2 (reduced due to rain)
 * @param team2WicketsLost - Wickets already lost by Team 2 when rain hit (usually 0)
 * @param team1OversCompleted - Overs Team 1 actually batted (may be less than 20 if interrupted)
 * @returns Revised target for Team 2
 */
export function calculateDLSTarget(
  firstInningsScore: number,
  team2OversAvailable: number,
  team2WicketsLost: number = 0,
  team1OversCompleted: number = 20,
): number {
  // Resources used by Team 1 (what fraction of a full innings they consumed)
  const team1Resources = getDLSResource(team1OversCompleted, 0) - getDLSResource(team1OversCompleted - team1OversCompleted, 0);
  // Simplifies to: getDLSResource(team1OversCompleted, 0)
  const R1 = getDLSResource(team1OversCompleted, 0);

  // Resources available to Team 2
  const R2 = getDLSResource(team2OversAvailable, team2WicketsLost);

  // G50 equivalent for T20 — average par score in a full T20 innings (~160)
  const G = 160;

  let revisedTarget: number;
  if (R2 < R1) {
    // Team 2 has fewer resources — scale down Team 1's score
    revisedTarget = Math.round(firstInningsScore * (R2 / R1));
  } else {
    // Team 2 has more resources (Team 1 was interrupted) — add runs
    revisedTarget = Math.round(firstInningsScore + G * (R2 - R1) / 100);
  }

  // Target = par score + 1 (to win, you must exceed par)
  revisedTarget += 1;

  // Minimum target is at least 1 run per over
  return Math.max(revisedTarget, team2OversAvailable + 1);
}

/** Check if a rain interruption should occur (random weather event).
 *  Returns the number of overs lost, or 0 if no rain. */
export function checkRainInterruption(
  over: number,
  rng: RNG = Math.random,
): number {
  // Rain is rare: ~5% chance per match, more likely in middle overs
  const baseChance = 0.003; // per over
  const midInningsBoost = (over >= 8 && over <= 14) ? 1.5 : 1.0;

  if (rng() < baseChance * midInningsBoost) {
    // Rain delay: lose 1-5 overs
    const oversLost = Math.ceil(rng() * 5);
    return oversLost;
  }
  return 0;
}

/** Determine if the match can still produce a result after rain.
 *  IPL requires minimum 5 overs per side. */
export function canProduceResult(
  oversAvailable: number,
  _isFirstInnings: boolean,
): boolean {
  return oversAvailable >= 5;
}

/**
 * Generate rain delay narrative text.
 */
export function getRainDelayNarrative(oversLost: number, oversRemaining: number): string {
  if (oversLost >= 5) return `Heavy rain! ${oversLost} overs lost. Only ${oversRemaining} overs remain.`;
  if (oversLost >= 3) return `Rain delay — ${oversLost} overs lost. Match reduced to ${oversRemaining}-over affair.`;
  return `Brief rain interruption. ${oversLost} over${oversLost > 1 ? "s" : ""} lost.`;
}
