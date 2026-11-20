/**
 * The T20 ball model's response to the striker's batting rating, refitted: a correction on top of the base matrix's straight
 * line in (battingOvr + timing) / 200, piecewise linear in the rating, a log multiplier per outcome class at each knot
 * (batter-response-data.ts, from packages/ratings/src/analysis/t20-batter-response.py; docs/TACTICS.md section 5). The base
 * response was too shallow at the bottom of the order: numbers 9 to 11 scored and stayed in too long. It acts on the rating
 * wherever the batter bats (no positional term): a star at number 11 bats like a star, a tail-ender opening like a tail-ender.
 * Wides, no-balls and byes are the bowler's and the keeper's, not the batter's, and are left alone. The ODI and the Test have
 * their own models with their own rating terms.
 */
import type { BallOutcome } from "./match.js";
import type { Gender } from "./delivery-rules.js";
import { BATTER_RESPONSE, BATTER_RESPONSE_KNOTS } from "./batter-response-data.js";

/** A response table: per gender and outcome class, a log multiplier at each of the knots */
export type BatterResponseTable = Record<"male" | "female", Record<string, readonly number[]>>;

/** The log multiplier of a class at a batting rating: linear between the knots, constant beyond the ends */
export function batterResponseLog(table: readonly number[], rating: number, knots: readonly number[] = BATTER_RESPONSE_KNOTS): number {
  if (rating <= knots[0]) return table[0];
  const last = knots.length - 1;
  if (rating >= knots[last]) return table[last];
  let j = 0;
  while (rating > knots[j + 1]) j++;
  const t = (rating - knots[j]) / (knots[j + 1] - knots[j]);
  return table[j] * (1 - t) + table[j + 1] * t;
}

/** Multiply the response into a ball's outcome weights (the T20 table by default; the ODI's own is odi-batter-response-data.ts) */
export function applyBatterResponse(probs: Record<BallOutcome, number>, gender: Gender, rating: number, table: BatterResponseTable = BATTER_RESPONSE, knots: readonly number[] = BATTER_RESPONSE_KNOTS): void {
  const t = table[gender];
  for (const k of Object.keys(t) as BallOutcome[]) probs[k] *= Math.exp(batterResponseLog(t[k], rating, knots));
}
