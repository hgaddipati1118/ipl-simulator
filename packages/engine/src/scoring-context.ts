/**
 * Scoring contexts: a competition whose level is fitted on its own real matches, on top of the league tables. Two kinds:
 * - the T20I (rules.scoringContext "t20i"): T20Is between full members since 2019, men and women (t20i-context-data.ts;
 *   docs/FORMATS.md, "T20I level");
 * - the women's leagues: the WPL, WBBL and women's Hundred fitted on their matches since 2024, and a pooled table for any
 *   other women's T20 or Hundred (womens-league-context-data.ts; docs/RULES-MATCH.md 12.7).
 * Each is, per phase (powerplay, middle, death on the T20 timeline), a multiplier on each outcome class of the T20 ball
 * model, written by packages/app/src/__tests__/calibrate-contexts.test.ts from docs/data/t20i_validation.json. Both engines
 * read it through the venue context (ballProbabilities). Men's leagues carry none, so they are unchanged.
 */
import type { BallOutcome } from "./match.js";
import type { MatchPhase } from "./matchups.js";
import type { MatchFormatSpec } from "./format.js";
import type { RuleSet } from "./rules.js";
import { T20I_CONTEXT } from "./t20i-context-data.js";
import { WOMENS_LEAGUE_CONTEXT } from "./womens-league-context-data.js";

/** Per phase, a multiplier on outcome classes (absent = 1) */
export type T20Context = Record<MatchPhase, Partial<Record<BallOutcome, number>>>;

export type ScoringContextId = "t20i";

/**
 * The context a match plays in: a T20I's (rules.scoringContext "t20i", T20 only); a women's T20 or Hundred league's own
 * (the pooled women's table for a league without one); none for men's leagues, mixed leagues and the ODI.
 */
export function scoringContextFor(rules: Pick<RuleSet, "scoringContext" | "gender" | "league">, fmt: Pick<MatchFormatSpec, "id">): T20Context | undefined {
  if (rules.scoringContext === "t20i") return fmt.id === "t20" ? T20I_CONTEXT[rules.gender === "women" ? "female" : "male"] : undefined;
  // women's cricket as genderOf (delivery-rules.ts) reads it: the WPL, or a women's league
  const women = rules.league === "wpl" || rules.gender === "women";
  if (!women || (fmt.id !== "t20" && fmt.id !== "hundred")) return undefined;
  return WOMENS_LEAGUE_CONTEXT[rules.league as keyof typeof WOMENS_LEAGUE_CONTEXT] ?? WOMENS_LEAGUE_CONTEXT.default;
}

/** Multiply the phase's context into a ball's outcome weights */
export function applyScoringContext(probs: Record<BallOutcome, number>, context: T20Context, phase: MatchPhase): void {
  const m = context[phase];
  for (const k of Object.keys(m) as BallOutcome[]) probs[k] *= m[k] ?? 1;
}
