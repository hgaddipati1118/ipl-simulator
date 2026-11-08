/**
 * A T20 or Hundred match's own conditions, beyond what the sides and the ground explain: a run multiplier the match draws
 * (the pitch and the weather on the day, shared by both innings) on the scoring classes (1, 2, 3, 4, 6), like the Test
 * engine's match conditions (test-match.ts drawConditions). Its log is two-piece normal (a different spread below and
 * above its centre, so it can be skewed), with a shape pooled over the men's leagues and a scale and centre per league,
 * fitted to the real leagues' season-centred distribution of first-innings totals with the mean kept where it was
 * (match-conditions-data.ts; docs/RULES-MATCH.md 12.8). The ODI has none (its fitted model already gives the real spread);
 * neither do the women's leagues (their real match term is no larger than the engine's own).
 */
import type { BallOutcome } from "./match.js";
import type { Gender } from "./delivery-rules.js";
import type { RNG } from "./rng.js";
import { MATCH_CONDITIONS, type ConditionsShape } from "./match-conditions-data.js";

export interface MatchConditions {
  /** The match's run multiplier, shared by both innings */
  run: number;
}

function normal(rng: RNG): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** The conditions shape a match plays under: its league's (null: none), else its gender's default; none if neither */
export function conditionsShapeFor(gender: Gender, league: string | undefined): ConditionsShape | undefined {
  const g = MATCH_CONDITIONS[gender];
  if (league !== undefined && league in g) return g[league] ?? undefined;
  return g.default ?? undefined;
}

/**
 * Draw a match's conditions (none, and no draw, without a shape). The log multiplier is two-piece normal: below the centre
 * with probability lo / (lo + hi) and sd lo, above it otherwise with sd hi (one density, continuous at the centre).
 */
export function drawMatchConditions(gender: Gender, league: string | undefined, rng: RNG): MatchConditions | undefined {
  const s = conditionsShapeFor(gender, league);
  if (!s) return undefined;
  const below = s.lo + s.hi > 0 && rng() < s.lo / (s.lo + s.hi);
  const z = Math.abs(normal(rng));
  return { run: Math.exp(s.center + (below ? -s.lo : s.hi) * z) };
}

const SCORING: BallOutcome[] = ["1", "2", "3", "4", "6"];

/** Multiply a match's conditions into a ball's outcome weights */
export function applyMatchConditions(probs: Record<BallOutcome, number>, c: MatchConditions): void {
  for (const k of SCORING) probs[k] *= c.run;
}
