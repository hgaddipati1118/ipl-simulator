/**
 * The wicket hazard by the state of a men's T20 league innings (docs/TACTICS.md section 11, "The innings shape"). Held to the same
 * striker (rating and balls faced) and competition, real chases lose fewer wickets than the engine's under a high required rate and with
 * seven or eight down, and more when the chase is comfortable: the engine's chase adjustment (match.ts chaseAdjustment) raises the wicket
 * rate by hand-set steps with the pressure and the wickets down, so its chases collapse, and end all out, more often than real ones. A log
 * multiplier on the wicket class per state cell, fitted from Cricsheet ball by ball against the engine (state-wickets-data.ts, from
 * packages/ratings/src/analysis/state-wickets.py; fit to the end of 2024, judged on 2025+), pooled over the nine men's leagues and made
 * neutral per league over the engine's own balls, so each league's wickets per innings stay where its levels put them and only how they
 * fall across the states moves. A chase by pressure ((required rate - current rate) / 8, the chase adjustment's own measure) x the over
 * band x wickets down; a first innings by over band x wickets down (fitted; zero, as the data file is written, where it did not predict
 * 2024 better).
 * Men's league T20 matches only (not a T20I, The Hundred, the women or a super over), both engines (ballProbabilities).
 */
import type { BallOutcome } from "./match.js";
import { STATE_WICKETS, STATE_WICKETS_PRESSURE_EDGES } from "./state-wickets-data.js";

/** Test hook (collectors, benchmarks): switch the term off, or one innings of it; never used by the game */
export const STATE_WICKETS_SWITCH: { off: boolean; first: boolean; chase: boolean } = { off: false, first: true, chase: true };

/** The first innings' over bands (0-based last over of each): 1-6, 7-11, 12-15, 16-18, 19-20 */
const FIRST_BANDS: readonly number[] = [5, 10, 14, 17];
const FIRST_BANDS_N = FIRST_BANDS.length + 1;

const bandOf = (x: number, edges: readonly number[]): number => {
  let i = 0;
  while (i < edges.length && x > edges[i]) i++;
  return i;
};

/** The wickets-down group: 0-2, 3-4, 5-6, 7-8, 9 */
export function stateWicketsGroup(wicketsDown: number): number {
  return wicketsDown <= 2 ? 0 : wicketsDown <= 4 ? 1 : wicketsDown <= 6 ? 2 : wicketsDown <= 8 ? 3 : 4;
}

/** The chase pressure bin of (required rate - current rate) / 8: <= -0.25, -0.25-0, 0-0.25, 0.25-0.5, 0.5-1, 1+ */
export function stateWicketsPressureBin(pressure: number): number {
  return bandOf(pressure, STATE_WICKETS_PRESSURE_EDGES);
}

/** The multiplier on a ball's wicket class (1 where the competition has no table) */
export function stateWicketsMultiplier(key: string | undefined, isSecondInnings: boolean, over: number, wicketsDown: number, pressure?: number): number {
  if (STATE_WICKETS_SWITCH.off || !key) return 1;
  const scale = STATE_WICKETS.scale[key];
  if (!scale) return 1;
  const g = stateWicketsGroup(wicketsDown);
  if (!isSecondInnings) {
    if (!STATE_WICKETS_SWITCH.first || STATE_WICKETS.first.length === 0) return 1;
    return Math.exp(STATE_WICKETS.first[bandOf(Math.floor(over), FIRST_BANDS)][g]) * scale[0];
  }
  if (!STATE_WICKETS_SWITCH.chase || STATE_WICKETS.chase.length === 0 || pressure === undefined || !Number.isFinite(pressure)) return 1;
  return Math.exp(STATE_WICKETS.chase[stateWicketsPressureBin(pressure) * FIRST_BANDS_N + bandOf(Math.floor(over), FIRST_BANDS)][g]) * scale[1];
}

/** Multiply the state term into a ball's wicket class (no-op where the competition has none) */
export function applyStateWickets(probs: Record<BallOutcome, number>, key: string | undefined, isSecondInnings: boolean, over: number, wicketsDown: number, pressure?: number): void {
  const m = stateWicketsMultiplier(key, isSecondInnings, over, wicketsDown, pressure);
  if (m !== 1) probs.wicket *= m;
}
