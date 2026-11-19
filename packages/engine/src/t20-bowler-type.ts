/**
 * T20 bowler type x phase of the innings (both engines, T20 / T20I / league play and The Hundred; the ODI has its own table in odi-model.ts).
 *
 * Each ball class (dot, 1, 2, 3, 4, 6, wicket, wide, no-ball, bye / leg bye) is weighted by a factor for the bowler's type (pace, spin, or
 * neither: part-timers and bowlers with no recorded style) and the over bucket (1-6, 7-10, 11-15, 16-18, 19-20), fitted on 1.2 million
 * Cricsheet T20 balls with the batter's and the bowler's own quality, the over, wickets down, the set batter, the chase, the era and the
 * competition taken out (packages/ratings/src/analysis/t20-bowler-type.py, docs/data/t20_bowler_type*.json). Out of sample (fit to 2023, scored on
 * 2024 on) it predicts the next ball better than no type factor and than the hand-set modifiers it replaces (matchups.ts getPhaseModifier, kept
 * for reference). Finer types (fast / medium / off-spin / orthodox / wrist-spin) did not predict better out of sample than pace / spin, so there
 * are two. A bowler's rating already carries his quality over the overs he bowls: the factors are the phase profile of a type, normalised to
 * mean 1 over the balls the type bowled.
 */
import type { BallOutcome } from "./match.js";
import { isSpinBowler, isPaceBowler, type BowlingStyle } from "./matchups.js";
import { T20_BOWLER_TYPE, T20_TYPE_BUCKETS } from "./t20-bowler-type-data.js";

const CLASSES: readonly BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];

/** Table index of a bowling style: 0 pace, 1 spin, 2 neither (part-timers, no style recorded) */
export function t20TypeIndex(style: BowlingStyle | undefined): 0 | 1 | 2 {
  if (!style || style === "unknown") return 2;
  if (isSpinBowler(style)) return 1;
  if (isPaceBowler(style)) return 0;
  return 2;
}

function bucketOf(over: number): number {
  const o = Math.max(0, Math.min(19, Math.floor(over)));
  for (let i = 0; i < T20_TYPE_BUCKETS.length; i++) if (o >= T20_TYPE_BUCKETS[i][0] && o <= T20_TYPE_BUCKETS[i][1]) return i;
  return T20_TYPE_BUCKETS.length - 1;
}

/** The ten class factors of a bowler type at an over (on the T20 timeline) */
export function t20TypeFactors(gender: "male" | "female", style: BowlingStyle | undefined, over: number): readonly number[] {
  return T20_BOWLER_TYPE[gender][t20TypeIndex(style)][bucketOf(over)];
}

/** Multiply the factors into a ball's outcome weights */
export function applyT20BowlerType(probs: Record<BallOutcome, number>, gender: "male" | "female", style: BowlingStyle | undefined, over: number): void {
  const f = t20TypeFactors(gender, style, over);
  CLASSES.forEach((k, i) => { probs[k] *= f[i]; });
}
