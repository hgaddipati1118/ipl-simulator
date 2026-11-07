/**
 * Decision Review System for lbw and caught behind, shared by both engines (RULES-MATCH.md section 13.4).
 *
 * The engines' wicket probability is the probability of a dismissal that stands, which already includes the ones that came
 * from reviews. DRS adds the decisions around them, with Cricsheet's `review` records (match-rules-extra-data.ts `drs`):
 *
 *  - batting side, given out:
 *      * the decision was wrong and the review overturns it: on a dot ball, the batter is given out and reprieved
 *        (with no review left the wrong decision stands: a wicket);
 *      * the decision was right: a review is struck down (review lost) or umpire's call (review kept);
 *  - fielding side, given not out:
 *      * the batter was out and the review overturns it: part of the drawn lbw / caught-behind wickets come this way
 *        (with no review left the batter survives);
 *      * the batter was not out: struck down (lost) or umpire's call (kept) on a dot ball.
 *
 * Counts per innings: reviewsPerInnings, the batting side's share and the kind shares; the outcome shares per side and kind.
 * Turned into per-ball rates with the engine's average wickets of each kind per innings (WICKETS_PER_INNINGS) and its share
 * of dot balls, so the reviews per innings and the overturn rates come out at the data's.
 */

import { MATCH_RULES_EXTRA as X } from "./match-rules-extra-data.js";
import { ruleOverrides, type DismissalKind } from "./dismissal-kinds.js";
import type { RNG } from "./rng.js";

export type DrsKind = "lbw" | "caught";
export type DrsSide = "batting" | "fielding";
export type DrsResult = "overturned" | "umpires_call" | "struck_down";

export interface DrsReview {
  by: DrsSide;
  kind: DrsKind;
  /** The on-field call that was reviewed */
  onField: "out" | "not_out";
  result: DrsResult;
}

/** Reviews per side per innings (IPL, ICC T20I since 2023: two unsuccessful reviews; umpire's call keeps the review) */
export const DRS_REVIEWS_PER_INNINGS = 2;

/** Engine averages per innings (benchmark-rules.ts): lbw wickets, catches by the keeper, legal balls, dot balls */
const WICKETS_PER_INNINGS: Record<DrsKind, number> = { lbw: 0.5, caught: 0.7 };
const LEGAL_BALLS = 110;
const DOT_SHARE = 0.37;

function rates() {
  const d = X.drs as typeof X.drs & { battingReviewShare?: number };
  const f = ruleOverrides().drsRateFactor ?? 1;
  const R = d.reviewsPerInnings * f;
  const bShare = d.battingReviewShare ?? 0.5;
  const B = R * bShare, F = R * (1 - bShare);
  const out = {} as Record<DrsKind, { wrongOutPerDot: number; batReviewOfWicket: number; batUc: number; fieldOverturnOfWicket: number; fieldFailPerDot: number; fieldUc: number }>;
  for (const k of ["lbw", "caught"] as DrsKind[]) {
    const b = d.batting[k], fl = d.fielding[k];
    const bk = d.battingKindShare[k], fk = d.fieldingKindShare[k];
    out[k] = {
      wrongOutPerDot: (B * bk * b.overturned) / LEGAL_BALLS / DOT_SHARE,
      batReviewOfWicket: Math.min(0.95, (B * bk * (1 - b.overturned)) / WICKETS_PER_INNINGS[k]),
      batUc: b.overturned < 1 ? b.umpiresCall / (1 - b.overturned) : 0,
      fieldOverturnOfWicket: Math.min(0.6, (F * fk * fl.overturned) / WICKETS_PER_INNINGS[k]),
      fieldFailPerDot: (F * fk * (1 - fl.overturned)) / LEGAL_BALLS / DOT_SHARE,
      fieldUc: fl.overturned < 1 ? fl.umpiresCall / (1 - fl.overturned) : 0,
    };
  }
  return out;
}

let cached: ReturnType<typeof rates> | null = null;
let cachedFactor: number | undefined;
function R() {
  const f = ruleOverrides().drsRateFactor;
  if (!cached || cachedFactor !== f) { cached = rates(); cachedFactor = f; }
  return cached;
}

/** Which DRS kind a dismissal is, or null (only lbw and catches by the keeper are reviewed in this model) */
export function drsKindOf(kind: DismissalKind | undefined, keeperCatch: boolean): DrsKind | null {
  if (kind === "lbw") return "lbw";
  if (kind === "caught" && keeperCatch) return "caught";
  return null;
}

export interface DrsAvailability { batting: number; fielding: number }

/**
 * A dismissal of a reviewable kind was drawn. Either the on-field call was not out and the fielding side reviewed it
 * (overturned, out; with no review left: `cancel`, the batter survives), or it was given out and the batting side may
 * review it (struck down / umpire's call).
 */
export function drsAtDismissal(kind: DrsKind, rng: RNG, avail: DrsAvailability): { review?: DrsReview; cancel?: boolean } {
  const r = R()[kind];
  if (rng() < r.fieldOverturnOfWicket) {
    if (avail.fielding <= 0) return { cancel: true };
    return { review: { by: "fielding", kind, onField: "not_out", result: "overturned" } };
  }
  if (avail.batting > 0 && rng() < r.batReviewOfWicket) {
    return { review: { by: "batting", kind, onField: "out", result: rng() < r.batUc ? "umpires_call" : "struck_down" } };
  }
  return {};
}

/**
 * A legal dot ball (not a free hit): was there an appeal that went to the third umpire? `wicket` is a wrong out decision
 * that stands because the batting side had no review left.
 */
export function drsAtDot(rng: RNG, avail: DrsAvailability, keeperUp = true): { review?: DrsReview; wicket?: DrsKind } {
  const all = R();
  for (const k of ["lbw", "caught"] as DrsKind[]) {
    if (k === "caught" && !keeperUp) continue;
    const r = all[k];
    if (rng() < r.wrongOutPerDot) {
      if (avail.batting <= 0) return { wicket: k };
      return { review: { by: "batting", kind: k, onField: "out", result: "overturned" } };
    }
    if (avail.fielding > 0 && rng() < r.fieldFailPerDot) {
      return { review: { by: "fielding", kind: k, onField: "not_out", result: rng() < r.fieldUc ? "umpires_call" : "struck_down" } };
    }
  }
  return {};
}

/** A review is lost only when it is struck down (umpire's call and overturned keep it) */
export function reviewLost(r: DrsReview): boolean {
  return r.result === "struck_down";
}

/** For a user's review: the hidden answer if the user reviews a given-out (true wicket) decision */
export function userBattingReviewOfWicket(kind: DrsKind, rng: RNG): DrsResult {
  return rng() < R()[kind].batUc ? "umpires_call" : "struck_down";
}

/** For a user's review of a not-out (true not out) decision */
export function userFieldingReviewOfNotOut(kind: DrsKind, rng: RNG): DrsResult {
  return rng() < R()[kind].fieldUc ? "umpires_call" : "struck_down";
}

/** The commentary sentence(s) for a review */
export function drsText(r: DrsReview, team: string, rng: RNG): string {
  const pick = (xs: string[]) => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
  const what = r.kind === "lbw" ? "lbw" : "caught behind";
  if (r.onField === "out") {
    const lead = `Given out ${what}, and ${team} review.`;
    if (r.result === "overturned") return `${lead} ${r.kind === "lbw" ? pick(["Ball tracking shows it missing the stumps.", "There is an inside edge onto the pad!", "Pitched outside leg."]) : pick(["UltraEdge shows a gap between bat and ball.", "No spike on UltraEdge, it brushed the pad."])} OVERTURNED, not out!`;
    if (r.result === "umpires_call") return `${lead} Umpire's call, clipping the stumps, so the decision stands. ${team} keep their review.`;
    return `${lead} ${r.kind === "lbw" ? "Hitting the stumps." : "A clear spike on UltraEdge."} The decision stands and ${team} lose a review.`;
  }
  const lead = `Big appeal for ${what}, not out says the umpire, and ${team} go upstairs.`;
  if (r.result === "overturned") return `${lead} ${r.kind === "lbw" ? "Three reds on ball tracking!" : "A spike on UltraEdge as it passes the bat!"} OVERTURNED, that's OUT!`;
  if (r.result === "umpires_call") return `${lead} Umpire's call on ${r.kind === "lbw" ? "impact" : "the deflection"}, so it stays not out. ${team} keep their review.`;
  return `${lead} ${r.kind === "lbw" ? "Missing the stumps." : "Nothing on UltraEdge."} Not out, and ${team} lose a review.`;
}
