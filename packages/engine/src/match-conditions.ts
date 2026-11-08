/**
 * A T20 or Hundred match's own conditions, beyond what the sides and the ground explain: a run multiplier the match draws
 * (the pitch and the weather on the day, shared by both innings) on the scoring classes (1, 2, 3, 4, 6). Like the Test
 * engine's (test-match.ts drawConditions): lognormal, its spread fitted from the real decomposition of innings scoring
 * (match-conditions-data.ts; docs/RULES-MATCH.md 12.8), centred so a league's mean total is what it was without it (runs
 * fall a little faster than they rise with the multiplier). An innings' own multiplier is supported (`innings`) but fitted
 * at zero. The ODI has none: its fitted model already gives the real spread of totals.
 */
import type { BallOutcome } from "./match.js";
import type { Gender } from "./delivery-rules.js";
import type { RNG } from "./rng.js";
import { MATCH_CONDITIONS } from "./match-conditions-data.js";

export interface MatchConditions {
  /** The match's run multiplier, shared by both innings */
  run: number;
  /** Each innings' own run multiplier: [first innings, second innings] */
  innings: [number, number];
}

function normal(rng: RNG): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const lognormal = (sd: number, rng: RNG, center = 0) => (sd > 0 ? Math.exp(sd * normal(rng) - (sd * sd) / 2 + center) : 1);

/** Draw a match's conditions (none, and no draw, when the gender's spreads are zero) */
export function drawMatchConditions(gender: Gender, rng: RNG): MatchConditions | undefined {
  const s = MATCH_CONDITIONS[gender];
  if (!s || (s.match === 0 && s.innings === 0)) return undefined;
  const run = lognormal(s.match, rng, s.center);
  return { run, innings: [lognormal(s.innings, rng), lognormal(s.innings, rng)] };
}

const SCORING: BallOutcome[] = ["1", "2", "3", "4", "6"];

/** Multiply a match's conditions into a ball's outcome weights (the innings' own multiplier by innings) */
export function applyMatchConditions(probs: Record<BallOutcome, number>, c: MatchConditions, isSecondInnings: boolean): void {
  const m = c.run * c.innings[isSecondInnings ? 1 : 0];
  for (const k of SCORING) probs[k] *= m;
}
