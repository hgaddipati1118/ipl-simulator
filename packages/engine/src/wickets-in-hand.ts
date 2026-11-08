/**
 * How a T20 side bats by wickets down and overs left, beyond who is at the crease: real sides consolidate after early
 * wickets (fewer boundaries and wickets, more singles) and accelerate late with wickets in hand. A table of each outcome
 * class's multiplier by over band and wickets down, fitted on the first innings of the T20 leagues since 2021 with the
 * batter and bowler held fixed (wickets-in-hand-data.ts, from packages/ratings/src/analysis/t20-wickets-in-hand.py), one
 * per gender. Applied in the first innings of a T20 or Hundred (a chase has its own context: chaseAdjustment), raised to a
 * per-competition power (the league's scale: how much of the pooled behaviour its sides show in the engine) and times a
 * per-competition factor per band and class that keeps its phase rates and mean total where they were
 * (wickets-in-hand-norm-data.ts; docs/RULES-MATCH.md 12.9). The ODI has its own wickets-down terms (odi-model.ts).
 */
import type { BallOutcome } from "./match.js";
import type { Gender } from "./delivery-rules.js";
import type { RuleSet } from "./rules.js";
import { WICKETS_IN_HAND, WICKETS_IN_HAND_BANDS } from "./wickets-in-hand-data.js";
import { WICKETS_IN_HAND_NORM } from "./wickets-in-hand-norm-data.js";

const CLASSES: BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];

/** The over band of an over on the T20 timeline (The Hundred's sets as phaseOver maps them) */
export function wicketsInHandBand(over: number): number {
  const o = Math.floor(over);
  const i = WICKETS_IN_HAND_BANDS.findIndex(([a, b]) => o >= a && o <= b);
  return i < 0 ? WICKETS_IN_HAND_BANDS.length - 1 : i;
}

/** The competition key of a match's normalising factors: its league (fitted for that gender), a T20I, or the gender's default */
export function wicketsInHandKey(rules: Pick<RuleSet, "league" | "scoringContext">, gender: Gender): string {
  if (rules.scoringContext === "t20i") return `t20i-${gender}`;
  return WICKETS_IN_HAND_NORM[rules.league]?.gender === gender ? rules.league : `default-${gender}`;
}

/** Multiply the wickets-in-hand table into a first-innings ball (no-op where the competition has no factors) */
export function applyWicketsInHand(probs: Record<BallOutcome, number>, gender: Gender, key: string, over: number, wicketsDown: number): void {
  const c = WICKETS_IN_HAND_NORM[key];
  if (!c || c.scale === 0) return; // none for this competition (scale 0: fitted with none)
  const band = wicketsInHandBand(over);
  const cell = WICKETS_IN_HAND[gender][band][Math.min(8, Math.max(0, wicketsDown))];
  CLASSES.forEach((k, i) => { probs[k] *= cell[i] ** c.scale * c.norm[band][i]; });
}
