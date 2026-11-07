/**
 * Duckworth-Lewis-Stern (DLS) for rain-interrupted T20 / Hundred matches (RULES-MATCH.md section 13.3).
 *
 * Resources come from the Duckworth-Lewis model that generates the published Standard Edition table:
 *
 *   Z(u, w) = Z0 F(w) [1 - exp(-b u / F(w))]        u = overs left, w = wickets lost
 *
 * as a percentage of a full 50-over innings, R50(u, w) = 100 Z(u, w) / Z(50, 0) (Z0 cancels). The decay b and the
 * wicket factors F(w) below are fitted to the published Standard Edition values (the 50, 40, 30, 25, 20, 10 and 5
 * overs-left rows at 0 / 2 / 5 / 7 / 9 wickets, and the 50-overs row at every wicket count: 100, 93.4, 85.1, 74.9,
 * 62.7, 49.0, 34.9, 22.0, 11.9, 4.7); the model reproduces all 40 published cells to 0.1 (rms 0.03 points), e.g.
 * 20 overs left: 56.6 / 52.4 / 38.6 / 21.2 / 4.7. A T20 innings is the bottom of that table, rescaled so a full 20 overs
 * is 100% (ICC uses the same table, truncated, for T20s): R(u, w) = R50(u, w) / R50(20, 0). The Hundred counts in balls
 * (u = balls left / 6, a full innings 100/6 overs).
 *
 * Revised target (Standard Edition): with team 1's score S and the resources R1 and R2 the two sides had,
 *   R2 < R1:  par = S R2 / R1
 *   R2 >= R1: par = S + G (R2 - R1) / 100, G = the average first-innings score (the "G50" of the 50-over game)
 * and the target is floor(par) + 1. A side needs at least 5 overs (T20; 25 balls in The Hundred) for a result.
 */

import type { RNG } from "./rng.js";

/** Decay constant, per over */
export const DLS_B = 0.0274093;
/** F(w) for 0..9 wickets lost (F(0) = 1) */
export const DLS_F = [1.0, 0.88475, 0.7599, 0.63049, 0.50001, 0.3753, 0.26175, 0.16402, 0.08878, 0.03506] as const;

/** Standard Edition resources for u overs left and w wickets lost, as a % of a full 50-over innings */
export function resources50(oversLeft: number, wicketsLost: number): number {
  const w = Math.max(0, Math.floor(wicketsLost));
  if (w >= 10 || oversLeft <= 0) return 0;
  const u = Math.min(50, oversLeft);
  const F = DLS_F[w];
  return (100 * F * (1 - Math.exp(-DLS_B * u / F))) / (1 - Math.exp(-DLS_B * 50));
}

/** Resources left with `oversLeft` overs to go and `wicketsLost` down, as a % of a full innings of `fullOvers` (20 for a T20) */
export function resourcesPct(oversLeft: number, wicketsLost: number, fullOvers = 20): number {
  const u = Math.min(Math.max(oversLeft, 0), fullOvers);
  return (100 * resources50(u, wicketsLost)) / resources50(fullOvers, 0);
}

/** DLS resource percentage for a T20 (0-100, a full 20 overs with no wicket down = 100) */
export function getDLSResource(oversRemaining: number, wicketsLost: number): number {
  if (oversRemaining <= 0 || wicketsLost >= 10) return 0;
  return resourcesPct(oversRemaining, Math.max(0, wicketsLost), 20);
}

/**
 * Resources a side had in an innings that started with `startOvers` and lost overs to interruptions: each stop is
 * (overs left when play stopped, wickets down then, overs lost). Percent of a full innings of `fullOvers`.
 */
export function inningsResources(startOvers: number, stops: readonly { oversLeft: number; wickets: number; oversLost: number }[], fullOvers = 20): number {
  let r = resourcesPct(startOvers, 0, fullOvers);
  for (const s of stops) {
    r -= resourcesPct(s.oversLeft, s.wickets, fullOvers) - resourcesPct(Math.max(0, s.oversLeft - s.oversLost), s.wickets, fullOvers);
  }
  return Math.max(0, r);
}

/** Standard Edition target from team 1's score and the two sides' resources (percent). `g` = average first-innings score */
export function dlsTarget(team1Score: number, r1: number, r2: number, g: number): number {
  if (r1 <= 0) return team1Score + 1;
  const par = r2 < r1 ? (team1Score * r2) / r1 : team1Score + (g * (r2 - r1)) / 100;
  return Math.floor(par + 1e-9) + 1;
}

/** Par score (what team 2 must have reached to be ahead) at a point of its innings: floor(S R2used / R1) */
export function dlsPar(team1Score: number, r1: number, r2Used: number, g: number): number {
  return dlsTarget(team1Score, r1, r2Used, g) - 1;
}

/** Average first-innings score used as G for a T20 (men's IPL-era; RULES-MATCH.md 13.3) */
export const DLS_G_T20 = 160;

/**
 * Legacy helper (live engine before section 13): target for team 2 with `team2OversAvailable` overs, `team2WicketsLost`
 * down at the point the overs were set, after team 1 batted `team1OversCompleted` overs.
 */
export function calculateDLSTarget(
  firstInningsScore: number,
  team2OversAvailable: number,
  team2WicketsLost: number = 0,
  team1OversCompleted: number = 20,
): number {
  const R1 = getDLSResource(team1OversCompleted, 0);
  const R2 = getDLSResource(team2OversAvailable, team2WicketsLost);
  const t = dlsTarget(firstInningsScore, R1, R2, DLS_G_T20);
  return Math.max(t, Math.floor(team2OversAvailable) + 1);
}

/** Check if a rain interruption should occur (random weather event). Returns the number of overs lost, or 0 if no rain. */
export function checkRainInterruption(
  over: number,
  rng: RNG = Math.random,
): number {
  const baseChance = 0.003; // per over
  const midInningsBoost = (over >= 8 && over <= 14) ? 1.5 : 1.0;
  if (rng() < baseChance * midInningsBoost) return Math.ceil(rng() * 5);
  return 0;
}

/** Determine if the match can still produce a result after rain: a minimum of 5 overs per side. */
export function canProduceResult(
  oversAvailable: number,
  _isFirstInnings: boolean,
): boolean {
  return oversAvailable >= 5;
}

/** Generate rain delay narrative text. */
export function getRainDelayNarrative(oversLost: number, oversRemaining: number): string {
  if (oversLost >= 5) return `Heavy rain! ${oversLost} overs lost. Only ${oversRemaining} overs remain.`;
  if (oversLost >= 3) return `Rain delay — ${oversLost} overs lost. Match reduced to ${oversRemaining}-over affair.`;
  return `Brief rain interruption. ${oversLost} over${oversLost > 1 ? "s" : ""} lost.`;
}
