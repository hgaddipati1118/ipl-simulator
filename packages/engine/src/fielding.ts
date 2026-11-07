/**
 * Fielding and wicketkeeping in the ball-by-ball engine.
 *
 * Ratings (PlayerRatings.fielding / .keeping, 0-99, 50 = average; ratings pipeline docs: RATINGS-PIPELINE.md):
 *   - fielding: catching, ground fielding, run-out threat
 *   - keeping: taking the ball cleanly (byes), stumpings, catches behind
 * Both are optional on PlayerRatings. Absent fielding means 50; absent keeping means 50 for a designated keeper
 * and 25 for anyone else, so old saves, mods and hand-built players behave like an average side.
 *
 * Mechanics (shared by match.ts and live-match.ts), all calibrated to be neutral for an all-50 side so that
 * innings scores, wickets and boundaries stay where the base model puts them (see RULES-MATCH.md section 11):
 *
 *  1. Dismissal chances.  The base model's wicket probability is the probability of a dismissal that *stands*.
 *     Catches, stumpings and run-outs are really chances that are sometimes put down, so those three kinds are
 *     modelled as chances: the wicket probability is scaled up by the chance/conversion ratio of an average side
 *     (`chanceInflation`), and each chance is converted with probability conv(skill of the fielder involved).
 *     A converted chance is the dismissal; a miss resolves as one of the non-wicket outcomes. At the average
 *     conversion this is exactly the base model; a better fielder converts more of them (and drops fewer), a
 *     worse one fewer, so wicket totals move with the side's fielding and keeping.
 *  2. Runs saved.  The side's mean fielding rating nudges fours, twos and threes down (and dots up), mean-neutral
 *     at 50.
 *  3. Byes.  The keeper's rating scales the leg-bye/bye probability.
 *
 * The dismissal kind is decided at the ball (it used to be assigned to the scorecard afterwards) and carried on
 * the BallEvent, so the scorecard's "c Smith b Jones" names the fielder who actually took (or put down) the chance.
 */

import type { BowlingStyle } from "./player.js";
import type { RNG } from "./rng.js";

/** Rating used for a player with no `fielding` value */
export const NEUTRAL_FIELDING = 50;
/** Keeping rating for a designated keeper with no `keeping` value / for a non-keeper standing up */
export const DEFAULT_KEEPER_KEEPING = 50;
export const DEFAULT_NONKEEPER_KEEPING = 25;

export type WicketKind = "bowled" | "caught" | "lbw" | "run_out" | "stumped";

/** What happened to a chance, for commentary and the ball log */
export type FieldingNote = "dropped_catch" | "great_catch" | "missed_stumping" | "run_out_missed" | "direct_hit";

export interface FielderLike {
  id: string;
  name: string;
  isWicketKeeper?: boolean;
  ratings: { fielding?: number; keeping?: number };
}

export function fieldingRating(p: Pick<FielderLike, "ratings">): number {
  const v = p.ratings.fielding;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(99, v)) : NEUTRAL_FIELDING;
}

export function keepingRating(p: Pick<FielderLike, "ratings" | "isWicketKeeper">): number {
  const v = p.ratings.keeping;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(99, v));
  return p.isWicketKeeper ? DEFAULT_KEEPER_KEEPING : DEFAULT_NONKEEPER_KEEPING;
}

/**
 * The player who keeps wicket: a designated keeper (best keeping rating if several), else whoever in the XI has
 * the best keeping rating (an emergency keeper), else the first player.
 */
export function pickKeeper<T extends FielderLike>(xi: readonly T[]): T | undefined {
  if (xi.length === 0) return undefined;
  const flagged = xi.filter(p => p.isWicketKeeper);
  const pool = flagged.length > 0 ? flagged : xi;
  let best = pool[0];
  for (const p of pool) if (keepingRating(p) > keepingRating(best)) best = p;
  return best;
}

export interface FieldingUnit {
  fielders: readonly FielderLike[];
  keeper?: FielderLike;
  /** (mean fielding of the XI - TEAM_FIELDING_PIVOT) / 50, about -0.4..+0.4 across real sides */
  quality: number;
  /** (keeper's keeping - 50) / 50 */
  keepingQuality: number;
}

/**
 * Mean fielding rating of a typical XI, the point where "runs saved" is zero. It sits a little under 50 because every
 * XI carries four or five bowlers, who rate lower: the IPL 2026 squads' auto-selected XIs average 46.3 and the WPL
 * XIs 50.1, so 48 keeps scoring on the base model's level for both (RULES-MATCH.md section 11).
 */
export const TEAM_FIELDING_PIVOT = 48;

export function buildFieldingUnit(xi: readonly FielderLike[]): FieldingUnit {
  const keeper = pickKeeper(xi);
  const mean = xi.length > 0 ? xi.reduce((s, p) => s + fieldingRating(p), 0) / xi.length : NEUTRAL_FIELDING;
  return {
    fielders: xi,
    keeper,
    quality: clampN((mean - TEAM_FIELDING_PIVOT) / 50, -0.6, 0.6),
    keepingQuality: keeper ? (keepingRating(keeper) - 50) / 50 : 0,
  };
}

// ── Calibration ─────────────────────────────────────────────────────────

/**
 * Probability that a chance is converted by an average fielder (rated TEAM_FIELDING_PIVOT; an average keeper is 50), and how much each rating point moves
 * it. Catching: ~82% of catchable chances are held at the average, 94% by an 80, 72% by a 25 (the spread of
 * catching ratios in the Cricsheet data is about +-35% between regulars, shrunk). Stumpings are cleaner;
 * run-outs are harder and move more with the fielder's rating.
 */
export const CONV = {
  catch: { base: 0.82, slope: 0.004, lo: 0.55, hi: 0.97 },
  stump: { base: 0.90, slope: 0.003, lo: 0.60, hi: 0.99 },
  runOut: { base: 0.75, slope: 0.005, lo: 0.45, hi: 0.95 },
} as const;

/** `pivot`: the rating at which a fielder converts at the average rate (TEAM_FIELDING_PIVOT for fielders, 50 for keeping) */
function conv(kind: keyof typeof CONV, skill: number, pivot: number): number {
  const c = CONV[kind];
  return clampN(c.base + c.slope * (skill - pivot), c.lo, c.hi);
}

/**
 * Share of dismissals by kind (the engine's long-standing mix) and the stumping share by bowler type.
 * Spin takes most stumpings (real T20: ~6% of spin wickets vs ~1.4% of pace wickets, 2.8% overall for men).
 */
const KIND_SHARE = { caught: 0.55, bowled: 0.20, lbw: 0.15, run_out: 0.07 } as const;
const KIND_SHARE_TOTAL = 0.97;
const STUMPED_SHARE = { spin: 0.06, pace: 0.014, other: 0.03 } as const;
/** Catches taken by the keeper are weighted more than an outfielder's (real: 1.7x each, 15% of all catches) */
const KEEPER_CATCH_WEIGHT = 1.7;

function isSpinStyle(style: BowlingStyle | undefined): boolean {
  return !!style && (style.includes("spin") || style.includes("orthodox") || style.endsWith("-slow"));
}
function isPaceStyle(style: BowlingStyle | undefined): boolean {
  return !!style && style !== "unknown" && !isSpinStyle(style);
}

/** Relative weight of each dismissal kind given the bowler, with chances inflated by 1/conversion */
function kindWeights(style: BowlingStyle | undefined): Record<WicketKind, number> {
  const s = isSpinStyle(style) ? STUMPED_SHARE.spin : isPaceStyle(style) ? STUMPED_SHARE.pace : STUMPED_SHARE.other;
  const rest = (1 - s) / KIND_SHARE_TOTAL;
  return {
    caught: KIND_SHARE.caught * rest / CONV.catch.base,
    bowled: KIND_SHARE.bowled * rest,
    lbw: KIND_SHARE.lbw * rest,
    run_out: KIND_SHARE.run_out * rest / CONV.runOut.base,
    stumped: s / CONV.stump.base,
  };
}

/** Factor on the base wicket probability so that chances, after average conversion, give the base rate */
export function chanceInflation(style: BowlingStyle | undefined): number {
  const w = kindWeights(style);
  return w.caught + w.bowled + w.lbw + w.run_out + w.stumped;
}

// ── Per-ball probability adjustments ────────────────────────────────────

/** Mutates `probs` (before normalisation): runs saved, byes, and the dismissal-chance inflation */
export function applyFieldingToProbs(
  probs: Record<string, number>,
  unit: FieldingUnit | undefined,
  bowlerStyle: BowlingStyle | undefined,
): void {
  if (unit) {
    const q = unit.quality;
    if (q !== 0) {
      if (probs["4"] !== undefined) probs["4"] *= 1 - 0.10 * q;
      if (probs["2"] !== undefined) probs["2"] *= 1 - 0.15 * q;
      if (probs["3"] !== undefined) probs["3"] *= 1 - 0.15 * q;
      if (probs.dot !== undefined) probs.dot *= 1 + 0.04 * q;
    }
    const kq = unit.keepingQuality;
    if (kq !== 0 && probs.legbye !== undefined) probs.legbye *= clampN(1 - 0.9 * kq, 0.4, 1.8);
  }
  if (probs.wicket !== undefined) {
    // Chances after average conversion must give back exactly the base wicket probability p, with bowled / lbw,
    // the extras and every scoring outcome at its base probability. Chance mass is p*W (W = chanceInflation); the
    // mass p*(W-1) of chances put down at average conversion comes back as scoring outcomes (resolveWicketChance
    // resamples them in proportion to the scoring weights), so the scoring weights give up exactly that much.
    // The total weight is unchanged, so nothing else needs rescaling.
    const W = chanceInflation(bowlerStyle);
    let total = 0;
    for (const v of Object.values(probs)) total += v;
    let scoring = 0;
    for (const k of SCORING) scoring += probs[k] ?? 0;
    const p = total > 0 ? probs.wicket / total : 0;
    const dropped = p * (W - 1);
    if (scoring > 0 && dropped < scoring / total) {
      const f = 1 - dropped / (scoring / total);
      for (const k of SCORING) if (probs[k] !== undefined) probs[k] *= f;
    }
    probs.wicket *= W;
  }
}

const SCORING = ["dot", "1", "2", "3", "4", "6"] as const;

// ── Resolving a dismissal chance ────────────────────────────────────────

export interface FieldingResolution {
  /** "wicket", or the non-wicket outcome a missed chance turned into */
  outcome: "wicket" | "dot" | "1" | "2" | "3" | "4" | "6";
  /** The dismissal kind of the chance (even when it was missed: the kind it would have been) */
  kind: WicketKind;
  fielder?: FielderLike;
  note?: FieldingNote;
}

const RESAMPLE: ("dot" | "1" | "2" | "3" | "4" | "6")[] = ["dot", "1", "2", "3", "4", "6"];

/**
 * A "wicket" outcome was drawn: decide its kind, who was involved, and whether the chance was taken.
 * `probs` are the (adjusted, unnormalised) ball probabilities, used to resample the outcome of a miss.
 * Draws: kind (1), fielder (1, caught / run-out), conversion (1, caught / stumped / run-out), outcome of a miss (1).
 */
export function resolveWicketChance(
  unit: FieldingUnit | undefined,
  bowlerId: string,
  bowlerStyle: BowlingStyle | undefined,
  probs: Record<string, number>,
  rng: RNG,
): FieldingResolution {
  const w = kindWeights(bowlerStyle);
  const total = w.caught + w.bowled + w.lbw + w.run_out + w.stumped;
  let r = rng() * total;
  let kind: WicketKind = "stumped";
  for (const k of ["caught", "bowled", "lbw", "run_out", "stumped"] as const) {
    r -= w[k];
    if (r <= 0) { kind = k; break; }
  }
  if (kind === "bowled" || kind === "lbw") return { outcome: "wicket", kind };

  let fielder: FielderLike | undefined;
  let skill = TEAM_FIELDING_PIVOT;
  let pivot = TEAM_FIELDING_PIVOT;
  let convKind: keyof typeof CONV = "catch";
  if (kind === "caught") {
    const pool = (unit?.fielders ?? []).filter(p => p.id !== bowlerId);
    if (pool.length > 0) {
      const ws = pool.map(p => (unit!.keeper && p.id === unit!.keeper.id ? KEEPER_CATCH_WEIGHT : 1));
      let x = rng() * ws.reduce((a, b) => a + b, 0);
      fielder = pool[pool.length - 1];
      for (let i = 0; i < pool.length; i++) { x -= ws[i]; if (x <= 0) { fielder = pool[i]; break; } }
      if (unit!.keeper && fielder.id === unit!.keeper.id) { skill = keepingRating(fielder); pivot = NEUTRAL_FIELDING; }
      else skill = fieldingRating(fielder);
    }
  } else if (kind === "stumped") {
    convKind = "stump";
    fielder = unit?.keeper;
    pivot = NEUTRAL_FIELDING;
    if (fielder) skill = keepingRating(fielder);
  } else {
    convKind = "runOut";
    const pool = unit?.fielders ?? [];
    if (pool.length > 0) {
      fielder = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
      skill = fieldingRating(fielder);
    }
  }

  const c = conv(convKind, skill, pivot);
  const u = rng();
  if (u < c) {
    let note: FieldingNote | undefined;
    if (kind === "caught" && skill >= 72 && u < c * 0.3) note = "great_catch";
    else if (kind === "run_out" && skill >= 72 && u < c * 0.4) note = "direct_hit";
    return { outcome: "wicket", kind, fielder, note };
  }

  // Missed: the batter survives; the ball becomes one of the non-wicket outcomes in proportion to the base mix
  const entries = RESAMPLE.map(o => [o, Math.max(0, probs[o] ?? 0)] as const);
  const sum = entries.reduce((a, [, p]) => a + p, 0) || 1;
  let y = rng() * sum;
  let outcome: (typeof RESAMPLE)[number] = "dot";
  for (const [o, p] of entries) { y -= p; if (y <= 0) { outcome = o; break; } }
  const note: FieldingNote = kind === "caught" ? "dropped_catch" : kind === "stumped" ? "missed_stumping" : "run_out_missed";
  return { outcome, kind, fielder, note };
}

// ── Commentary ──────────────────────────────────────────────────────────

/**
 * One-line commentary for a fielding event, or undefined when the ball needs none. `runs` is what the ball
 * scored after a miss.
 */
export function fieldingCommentary(
  res: FieldingResolution,
  ctx: { batter: string; bowler: string; runs: number },
  rng: RNG,
): string | undefined {
  const f = res.fielder?.name ?? "the fielder";
  const pick = (lines: string[]) => lines[Math.floor(rng() * lines.length)];
  switch (res.note) {
    case "dropped_catch": {
      const tail = ctx.runs >= 4 ? ` and it races away for ${ctx.runs}` : ctx.runs > 0 ? `, ${ctx.runs} run${ctx.runs > 1 ? "s" : ""}` : "";
      return pick([
        `${ctx.bowler} to ${ctx.batter}, DROPPED! ${f} puts down a straightforward chance${tail}.`,
        `${ctx.bowler} to ${ctx.batter}, it goes to ${f} and he spills it${tail}! A life for ${ctx.batter}.`,
        `${ctx.bowler} to ${ctx.batter}, edged, ${f} gets a hand to it but can't hold on${tail}.`,
      ]);
    }
    case "missed_stumping": {
      return pick([
        `${ctx.bowler} to ${ctx.batter}, beaten and out of his crease, but ${f} fumbles the take and the stumping chance is gone!`,
        `${ctx.bowler} to ${ctx.batter}, down the track, misses, and ${f} can't gather it cleanly. Reprieve!`,
      ]);
    }
    case "run_out_missed":
      return pick([
        `${ctx.bowler} to ${ctx.batter}, a mix-up in the middle, ${f}'s throw misses the stumps and ${ctx.batter} survives!`,
        `${ctx.bowler} to ${ctx.batter}, half a chance of a run out, but ${f} fumbles it and the batters scamper through.`,
      ]);
    case "great_catch":
      return pick([
        `${ctx.bowler} to ${ctx.batter}, OUT! What a catch by ${f}! A stunner.`,
        `${ctx.bowler} to ${ctx.batter}, caught! ${f} flings himself to his right and holds a blinder!`,
      ]);
    case "direct_hit":
      return pick([
        `${ctx.bowler} to ${ctx.batter}, RUN OUT! A direct hit from ${f}, brilliant fielding!`,
      ]);
    default:
      return undefined;
  }
}

function clampN(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
