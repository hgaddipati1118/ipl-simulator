/**
 * The innings clock: how a T20 first innings bats by the over, beyond the three phases. The base model steps at the end of the
 * powerplay and at over 15 and is flat between, but a real side does not: it starts the first over slowly, hits its sixes in the
 * middle overs rather than inside the field restrictions, and in the last two overs swings at nearly everything (the real wicket rate
 * per ball rises from 6% in over 16 to 14% in over 20; the engine's stayed at 7-8%), so the engine's wickets came too early and too
 * many innings ended all out with overs left. A log multiplier per over and outcome class (dot, 1, 2, 3, 4, 6, wicket; the extras
 * are left alone), per competition, fitted from Cricsheet ball by ball against the engine as it was, with the situation (wickets
 * down, the striker's rating and balls faced) held fixed, and made neutral in shares over the engine's own innings so each class's
 * rate over an innings stays where the league levels put it (innings-clock-data.ts, from packages/ratings/src/analysis/t20-wicket-timing.py;
 * docs/TACTICS.md section 6). T20 first innings only (not The Hundred, a chase or a super over), both engines (ballProbabilities); the men.s leagues and the women.s T20I.
 * Shipped for the men's leagues only, the wicket row alone, fitted on the engine with the fitted league XIs (xi-selection.ts, TACTICS
 * section 7): with the deeper XIs it brings the ninth wicket's timing to real and the all-out shares toward real against the XIs alone.
 * The men's T20I has no table (its candidate did not improve the actual-XI benchmark); the other candidates are in
 * docs/data/t20_innings_clock.json, loaded with WT_FILE by the collectors and benchmarks.
 */
import type { BallOutcome } from "./match.js";
import { INNINGS_CLOCK } from "./innings-clock-data.js";
import { WOMENS_T20I_CLOCK } from "./womens-t20i-clock-data.js";

const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];

/** Test hook (collectors, benchmarks): switch the term off (all of it, or the women's T20I table alone) or replace its tables; never used by the game */
export const INNINGS_CLOCK_SWITCH: { off: boolean; womenT20I: boolean } = { off: false, womenT20I: true };

/**
 * The competition's table: a league of its own, the men's default, or the women's T20I (`t20i-female`: its own fit, the wicket row made
 * neutral, docs/COUNTRY-VALIDATION.md "Women's T20I tails"); none for the men's T20I, the women's leagues and The Hundred
 */
export function inningsClockTable(key: string): number[][] | undefined {
  if (INNINGS_CLOCK_SWITCH.off) return undefined;
  if (key === "t20i-female") return INNINGS_CLOCK[key] ?? (INNINGS_CLOCK_SWITCH.womenT20I ? WOMENS_T20I_CLOCK : undefined);
  return INNINGS_CLOCK[key];
}

/** Multiply the over's term into a first-innings ball (no-op where the competition has none) */
export function applyInningsClock(probs: Record<BallOutcome, number>, key: string, over: number): void {
  const t = inningsClockTable(key);
  if (!t) return;
  const row = t[Math.min(t.length - 1, Math.max(0, Math.floor(over)))];
  CLASSES.forEach((k, i) => { if (row[i]) probs[k] *= Math.exp(row[i]); });
}
