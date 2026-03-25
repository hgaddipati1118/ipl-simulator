/**
 * Duckworth-Lewis-Stern (DLS) method for rain-interrupted T20 matches.
 *
 * Simplified DLS implementation for T20:
 * - Uses a resource percentage table based on overs remaining and wickets lost
 * - Calculates revised target when overs are reduced
 * - Handles both innings interruptions
 *
 * In real IPL: minimum 5 overs per side for a valid result.
 */

import type { RNG } from "./rng.js";

/** DLS resource table: percentage of resources remaining at (overs left, wickets lost) */
const DLS_RESOURCES: number[][] = [
  // [overs_remaining][wickets_lost] = resource %
  // Rows: 0-20 overs remaining. Cols: 0-10 wickets lost.
  // Simplified from the full DLS table, calibrated for T20
  [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],   // 0 overs left
  [4.0, 3.8, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.7, 0.4, 0.0],   // 1 over left
  [8.0, 7.5, 7.0, 6.2, 5.3, 4.3, 3.2, 2.1, 1.3, 0.7, 0.0],   // 2
  [12.0, 11.3, 10.4, 9.2, 7.9, 6.5, 5.0, 3.3, 2.0, 1.0, 0.0], // 3
  [16.0, 15.0, 13.8, 12.3, 10.5, 8.7, 6.7, 4.5, 2.7, 1.3, 0.0], // 4
  [20.0, 18.8, 17.3, 15.4, 13.2, 11.0, 8.5, 5.7, 3.5, 1.7, 0.0], // 5 (minimum for valid match)
  [24.5, 23.0, 21.2, 18.9, 16.3, 13.5, 10.5, 7.1, 4.3, 2.1, 0.0], // 6
  [29.0, 27.2, 25.0, 22.4, 19.3, 16.0, 12.5, 8.5, 5.2, 2.5, 0.0], // 7
  [33.5, 31.4, 28.9, 25.9, 22.3, 18.6, 14.5, 9.9, 6.1, 3.0, 0.0], // 8
  [37.5, 35.2, 32.4, 29.1, 25.1, 20.9, 16.4, 11.2, 6.9, 3.4, 0.0], // 9
  [41.5, 38.9, 35.8, 32.1, 27.8, 23.2, 18.2, 12.5, 7.7, 3.8, 0.0], // 10 (halfway)
  [45.5, 42.7, 39.3, 35.3, 30.5, 25.5, 20.1, 13.8, 8.6, 4.2, 0.0], // 11
  [49.5, 46.4, 42.7, 38.4, 33.2, 27.8, 21.9, 15.1, 9.4, 4.6, 0.0], // 12
  [53.5, 50.1, 46.2, 41.5, 35.9, 30.1, 23.8, 16.4, 10.2, 5.1, 0.0], // 13
  [57.5, 53.9, 49.6, 44.6, 38.7, 32.4, 25.6, 17.7, 11.0, 5.5, 0.0], // 14
  [61.5, 57.6, 53.1, 47.7, 41.4, 34.7, 27.4, 19.0, 11.9, 5.9, 0.0], // 15
  [65.5, 61.4, 56.5, 50.9, 44.1, 37.0, 29.3, 20.3, 12.7, 6.3, 0.0], // 16
  [70.0, 65.6, 60.4, 54.4, 47.2, 39.6, 31.4, 21.8, 13.6, 6.8, 0.0], // 17
  [75.0, 70.3, 64.8, 58.3, 50.6, 42.5, 33.7, 23.4, 14.7, 7.3, 0.0], // 18
  [82.0, 76.9, 70.8, 63.8, 55.4, 46.5, 36.9, 25.7, 16.1, 8.0, 0.0], // 19
  [100.0, 93.4, 85.1, 74.9, 62.7, 49.0, 37.6, 24.9, 14.3, 6.5, 0.0], // 20 (full innings)
];

/** Get DLS resource percentage for given overs remaining and wickets lost */
export function getDLSResource(oversRemaining: number, wicketsLost: number): number {
  const oversIdx = Math.min(Math.max(Math.round(oversRemaining), 0), 20);
  const wicketsIdx = Math.min(Math.max(wicketsLost, 0), 10);
  return DLS_RESOURCES[oversIdx][wicketsIdx];
}

/** Calculate revised DLS target for a rain-interrupted match.
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
  // Resources available to Team 1 (what they used)
  const team1ResourcesUsed = getDLSResource(20, 0) - getDLSResource(20 - team1OversCompleted, 0);

  // Resources available to Team 2
  const team2ResourcesAvailable = getDLSResource(team2OversAvailable, team2WicketsLost);

  // If Team 2 has fewer resources, reduce the target
  // If Team 2 has MORE resources (Team 1's innings was cut short), increase it
  const resourceRatio = team2ResourcesAvailable / Math.max(team1ResourcesUsed, 1);

  // DLS formula: Team 2 target = Team 1 score × (Team 2 resources / Team 1 resources) + 1
  const revisedTarget = Math.round(firstInningsScore * resourceRatio) + 1;

  // Minimum target is always at least par (1 run per over available)
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
  isFirstInnings: boolean,
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
