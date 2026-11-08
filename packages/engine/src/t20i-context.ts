/**
 * Scoring contexts: a competition whose level is fitted on its own real matches rather than the league tables. One so far,
 * the T20I (rules.scoringContext "t20i"): T20Is between full members since 2019, men and women, fitted per phase
 * (powerplay, middle, death) as a multiplier on each outcome class of the T20 ball model (t20i-context-data.ts, written by
 * packages/app/src/__tests__/calibrate-t20i.test.ts from docs/data/t20i_validation.json; docs/FORMATS.md, "T20I level").
 * Both engines read it through the venue context (ballProbabilities), so leagues, which carry no context, are unchanged.
 */
import type { BallOutcome } from "./match.js";
import type { MatchPhase } from "./matchups.js";
import type { MatchFormatSpec } from "./format.js";
import type { RuleSet } from "./rules.js";
import { T20I_CONTEXT } from "./t20i-context-data.js";

/** Per phase, a multiplier on outcome classes (absent = 1) */
export type T20Context = Record<MatchPhase, Partial<Record<BallOutcome, number>>>;

export type ScoringContextId = "t20i";

/** The context a match plays in: a T20 with rules.scoringContext set; none otherwise (leagues, The Hundred, the ODI) */
export function scoringContextFor(rules: Pick<RuleSet, "scoringContext" | "gender">, fmt: Pick<MatchFormatSpec, "id">): T20Context | undefined {
  if (rules.scoringContext !== "t20i" || fmt.id !== "t20") return undefined;
  return T20I_CONTEXT[rules.gender === "women" ? "female" : "male"];
}

/** Multiply the phase's context into a ball's outcome weights */
export function applyScoringContext(probs: Record<BallOutcome, number>, context: T20Context, phase: MatchPhase): void {
  const m = context[phase];
  for (const k of Object.keys(m) as BallOutcome[]) probs[k] *= m[k] ?? 1;
}
