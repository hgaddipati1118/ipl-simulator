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
import { MATCH_RULES_DATA as D } from "./match-rules-data.js";
import { MATCH_RULES_EXTRA as X } from "./match-rules-extra-data.js";
import { canDismiss, ruleOverrides, type DismissalKind, type Gender } from "./dismissal-kinds.js";
import { pickRunOutBatter, pickRunOutFielders, pickRunOutRuns } from "./delivery-rules.js";

/** Rating used for a player with no `fielding` value */
export const NEUTRAL_FIELDING = 50;
/** Keeping rating for a designated keeper with no `keeping` value / for a non-keeper standing up */
export const DEFAULT_KEEPER_KEEPING = 50;
export const DEFAULT_NONKEEPER_KEEPING = 25;

/** The dismissal kinds a "wicket" draw can produce (timed out and retired out happen between balls) */
export type WicketKind = Exclude<DismissalKind, "timed_out" | "retired_out">;

/** What happened to a chance, for commentary and the ball log */
export type FieldingNote = "dropped_catch" | "great_catch" | "missed_stumping" | "run_out_missed" | "direct_hit" | "misfield" | "six_saved";

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

// ── Value of fielding and keeping ───────────────────────────────────────

/**
 * What a fielding / keeping rating is worth in the same currency as batting and bowling: points of overall.
 *
 * Measured with the match engine (src/__tests__/benchmark-fielding-value.ts, 30-40k simulated IPL matches per
 * condition, RULES-AUCTION.md section 9): moving the whole XI's fielding by 30 points changes the runs the opposition
 * scores by about 7.4 per innings, i.e. 0.0224 runs per match for one fielder and one rating point; moving the
 * keeper's keeping by 30 changes it by 0.86, 0.0287 runs per point. The same test on batting and bowling (all four
 * attributes of every player +-10) gives about 1.07 runs per innings per team-wide batting overall point and 0.77 per
 * bowling point; a regular top-six batter faces ~15% of the balls and a front-line bowler delivers 20% of the overs,
 * so one overall point of a regular is worth about 0.155 runs per match in either discipline. A fielding point is
 * therefore worth 0.0224 / 0.155 = 0.145 overall points and a keeping point 0.0287 / 0.155 = 0.185.
 */
export const FIELDING_OVR_PER_POINT = 0.145;
export const KEEPING_OVR_PER_POINT = 0.185;
/** The fielding rating worth zero: the mean of the rated pool, a little under 50 (bowlers rate lower), see TEAM_FIELDING_PIVOT */
export const FIELDING_VALUE_PIVOT = 48;
/** Keeping is measured against an average keeper, 50: the engine's neutral point, and the mean of the keepers in the player pool (most have no record and sit at 50; the rostered keepers average 55) */
export const KEEPING_VALUE_PIVOT = 50;
/** Cap on the bonus either way (overall points) so a few extreme ratings can't dominate a price */
export const VALUE_BONUS_MAX = 9;
export const VALUE_BONUS_MIN = -6;

/**
 * Points of overall that a player's fielding (and, for a designated keeper, keeping) is worth: added to his overall
 * before it is turned into a market value, a trade value or a draft score. Absent ratings count as the pivot (zero).
 * Only a designated keeper is paid for keeping: for anyone else it is a rating that no match ever uses.
 */
export function fieldingValueBonus(p: { fielding?: number; keeping?: number; isWicketKeeper?: boolean }): number {
  const f = typeof p.fielding === "number" && Number.isFinite(p.fielding) ? Math.max(0, Math.min(99, p.fielding)) : FIELDING_VALUE_PIVOT;
  let bonus = FIELDING_OVR_PER_POINT * (f - FIELDING_VALUE_PIVOT);
  if (p.isWicketKeeper) {
    const k = typeof p.keeping === "number" && Number.isFinite(p.keeping) ? Math.max(0, Math.min(99, p.keeping)) : KEEPING_VALUE_PIVOT;
    bonus += KEEPING_OVR_PER_POINT * (k - KEEPING_VALUE_PIVOT);
  }
  return clampN(bonus, VALUE_BONUS_MIN, VALUE_BONUS_MAX);
}

// ── Calibration ─────────────────────────────────────────────────────────

/**
 * Probability that a chance is converted by an average fielder (rated TEAM_FIELDING_PIVOT; an average keeper is 50), and how much each rating point moves
 * it. The averages are 1 - the share of chances put down in ESPNcricinfo ball-by-ball commentary (match-rules-extra-data.ts
 * `fielding`, RULES-MATCH.md section 13.8; CricViz quote a T20 catch efficiency of 75-80%). The slopes keep the old spread: a
 * catcher 30 points above the pivot holds ~12 points more of his chances, one 25 below ~10 fewer. Run-outs move most with the fielder.
 */
export const CONV = {
  catch: { base: 1 - X.fielding.catchDropShare, slope: 0.004, lo: 0.5, hi: 0.97 },
  stump: { base: 1 - X.fielding.stumpingMissShare, slope: 0.003, lo: 0.55, hi: 0.99 },
  runOut: { base: 1 - X.fielding.runOutMissShare, slope: 0.005, lo: 0.15, hi: 0.75 },
} as const;

/** `pivot`: the rating at which a fielder converts at the average rate (TEAM_FIELDING_PIVOT for fielders, 50 for keeping) */
function conv(kind: keyof typeof CONV, skill: number, pivot: number): number {
  const c = CONV[kind];
  return clampN(c.base + c.slope * (skill - pivot), c.lo, c.hi);
}

/**
 * Share of dismissals by kind comes from Cricsheet (match-rules-data.ts, per gender), and the stumping share by bowler
 * type. Spin takes most stumpings (real T20: ~6% of spin wickets vs ~1.4% of pace wickets against 2.8% overall for men):
 * those ratios scale the data's overall stumped share, the rest of the mix is rescaled to fill the remainder.
 */
const STUMPED_RATIO = { spin: 6 / 2.8, pace: 1.4 / 2.8, other: 1 } as const;
/**
 * Game XIs carry about half spin overs against roughly a third in the data (the benchmark's stumped share came out at
 * 3.4% of dismissals against 2.4% in men's T20 since 2019), so the by-type ratios are scaled to hold the overall share.
 */
const STUMPED_ENGINE_SCALE = 0.72;
/** Catches taken by the keeper are weighted more than an outfielder's (real: 1.7x each, ~17% of all catches) */
const KEEPER_CATCH_WEIGHT = 1.7;

function isSpinStyle(style: BowlingStyle | undefined): boolean {
  return !!style && (style.includes("spin") || style.includes("orthodox") || style.endsWith("-slow"));
}
function isPaceStyle(style: BowlingStyle | undefined): boolean {
  return !!style && style !== "unknown" && !isSpinStyle(style);
}

const NO_CONVERSION: readonly WicketKind[] = ["bowled", "lbw", "hit_wicket", "obstructing_the_field", "handled_the_ball", "hit_the_ball_twice"];

/** Shares of dismissals (sum 1) by kind for a bowler type, before any conversion */
function kindShares(style: BowlingStyle | undefined, gender: Gender): Record<WicketKind, number> {
  const mix = D.dismissalMix[gender] as Record<string, number>;
  const ratio = isSpinStyle(style) ? STUMPED_RATIO.spin : isPaceStyle(style) ? STUMPED_RATIO.pace : STUMPED_RATIO.other;
  const stumped = Math.min(0.5, mix.stumped * ratio * STUMPED_ENGINE_SCALE);
  const rest = (1 - stumped) / (1 - mix.stumped);
  const out = {} as Record<WicketKind, number>;
  for (const k of Object.keys(mix) as WicketKind[]) out[k] = k === "stumped" ? stumped : mix[k] * rest;
  return out;
}

/** Relative weight of each dismissal kind given the bowler, with chances inflated by 1/conversion */
function kindWeights(style: BowlingStyle | undefined, gender: Gender): Record<WicketKind, number> {
  const sh = kindShares(style, gender);
  const out = {} as Record<WicketKind, number>;
  for (const k of Object.keys(sh) as WicketKind[]) {
    const c = k === "caught" || k === "caught_and_bowled" ? CONV.catch.base : k === "stumped" ? CONV.stump.base : k === "run_out" ? CONV.runOut.base : 1;
    out[k] = sh[k] / c;
  }
  return out;
}

/** Factor on the base wicket probability so that chances, after average conversion, give the base rate */
export function chanceInflation(style: BowlingStyle | undefined, gender: Gender = "male"): number {
  let t = 0;
  for (const v of Object.values(kindWeights(style, gender))) t += v;
  return t;
}

// ── Per-ball probability adjustments ────────────────────────────────────

/** Mutates `probs` (before normalisation): runs saved, byes, and the dismissal-chance inflation */
export function applyFieldingToProbs(
  probs: Record<string, number>,
  unit: FieldingUnit | undefined,
  bowlerStyle: BowlingStyle | undefined,
  gender: Gender = "male",
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
  // A share of hits for six is saved on the rope (special-plays.ts): the six weight is raised so the sixes that clear the rope stay at the base rate
  if (probs["6"] !== undefined) probs["6"] /= 1 - X.fielding.sixSavedShare;
  if (probs.wicket !== undefined) {
    // Chances after average conversion must give back exactly the base wicket probability p, with bowled / lbw,
    // the extras and every scoring outcome at its base probability. Chance mass is p*W (W = chanceInflation); the
    // mass p*(W-1) of chances put down at average conversion comes back as scoring outcomes (resolveWicketChance
    // resamples them in proportion to the scoring weights), so the scoring weights give up exactly that much.
    // The total weight is unchanged, so nothing else needs rescaling.
    const W = chanceInflation(bowlerStyle, gender);
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
  /** Second fielder of a relay run out */
  fielder2?: FielderLike;
  /** The fielder is a substitute (a bench player) */
  substitute?: boolean;
  /** Run out: which batter and how many runs they had completed */
  batterOut?: "striker" | "nonStriker";
  runsCompleted?: number;
  note?: FieldingNote;
  /** A catch in the deep (on or near the boundary rope) */
  deep?: boolean;
}

export interface ResolveOptions {
  gender?: Gender;
  /** The ball is a free hit: only run out, obstructing the field, handled the ball and hit the ball twice */
  freeHit?: boolean;
  /** Players off the field who can field as substitutes */
  bench?: readonly FielderLike[];
}

/**
 * A "wicket" outcome was drawn: decide its kind, who was involved, and whether the chance was taken.
 * `probs` are the (adjusted, unnormalised) ball probabilities, used to resample the outcome of a miss.
 * Draws: kind (1), fielder(s) (1-3, caught / run-out), conversion (1, caught / stumped / run-out), outcome of a miss (1).
 */
export function resolveWicketChance(
  unit: FieldingUnit | undefined,
  bowlerId: string,
  bowlerStyle: BowlingStyle | undefined,
  probs: Record<string, number>,
  rng: RNG,
  opts: ResolveOptions = {},
): FieldingResolution {
  const gender = opts.gender ?? "male";
  const freeHit = !!opts.freeHit;
  const o = ruleOverrides();
  let w: Record<string, number> = kindWeights(bowlerStyle, gender);
  if (freeHit) w = { ...D.freeHit.kinds };
  const kinds = Object.keys(w).filter(k => canDismiss(k as WicketKind, "legal", freeHit)) as WicketKind[];
  let kind: WicketKind;
  if (o.forceKind && canDismiss(o.forceKind, "legal", freeHit) && o.forceKind !== "timed_out" && o.forceKind !== "retired_out") {
    kind = o.forceKind;
  } else {
    const total = kinds.reduce((a, k) => a + w[k], 0);
    let r = rng() * total;
    kind = kinds[kinds.length - 1];
    for (const k of kinds) { r -= w[k]; if (r <= 0) { kind = k; break; } }
  }
  if ((NO_CONVERSION as readonly string[]).includes(kind)) {
    // Obstructing, handled and hit twice are a batter's own act; hit wicket the batter's. No fielder involved.
    return { outcome: "wicket", kind };
  }

  let fielder: FielderLike | undefined;
  let fielder2: FielderLike | undefined;
  let substitute = false;
  let skill = TEAM_FIELDING_PIVOT;
  let pivot = TEAM_FIELDING_PIVOT;
  let convKind: keyof typeof CONV = "catch";
  let batterOut: "striker" | "nonStriker" | undefined;
  let runsCompleted: number | undefined;
  if (kind === "caught") {
    const pool = (unit?.fielders ?? []).filter(p => p.id !== bowlerId);
    const sub = opts.bench && opts.bench.length > 0 && rng() < (o.substituteShare ?? D.catchFielders.substituteShare)
      ? opts.bench[Math.min(opts.bench.length - 1, Math.floor(rng() * opts.bench.length))] : undefined;
    if (sub) {
      fielder = sub; substitute = true; skill = fieldingRating(sub);
    } else if (pool.length > 0) {
      const ws = pool.map(p => (unit!.keeper && p.id === unit!.keeper.id ? KEEPER_CATCH_WEIGHT : 1));
      let x = rng() * ws.reduce((a, b) => a + b, 0);
      fielder = pool[pool.length - 1];
      for (let i = 0; i < pool.length; i++) { x -= ws[i]; if (x <= 0) { fielder = pool[i]; break; } }
      if (unit!.keeper && fielder.id === unit!.keeper.id) { skill = keepingRating(fielder); pivot = NEUTRAL_FIELDING; }
      else skill = fieldingRating(fielder);
    }
  } else if (kind === "caught_and_bowled") {
    fielder = unit?.fielders.find(p => p.id === bowlerId);
    if (fielder) skill = fieldingRating(fielder);
  } else if (kind === "stumped") {
    convKind = "stump";
    fielder = unit?.keeper;
    pivot = NEUTRAL_FIELDING;
    if (fielder) skill = keepingRating(fielder);
  } else {
    convKind = "runOut";
    runsCompleted = pickRunOutRuns(rng);
    batterOut = pickRunOutBatter(runsCompleted, false, rng);
    const f = pickRunOutFielders({ rng, bowlerId, unit });
    fielder = f.first; fielder2 = f.second;
    if (fielder) skill = fieldingRating(fielder);
    if (fielder && unit?.keeper && fielder.id === unit.keeper.id) skill = Math.max(skill, fieldingRating(fielder));
    const sub = opts.bench && opts.bench.length > 0 && rng() < (o.substituteShare ?? D.catchFielders.substituteShare)
      ? opts.bench[Math.min(opts.bench.length - 1, Math.floor(rng() * opts.bench.length))] : undefined;
    if (sub) { fielder = sub; substitute = true; skill = fieldingRating(sub); }
  }

  const c = conv(convKind, skill, pivot);
  const u = rng();
  if (u < c) {
    let note: FieldingNote | undefined;
    if ((kind === "caught" || kind === "caught_and_bowled") && skill >= 72 && u < c * 0.3) note = "great_catch";
    else if (kind === "run_out" && skill >= 72 && u < c * 0.4) note = "direct_hit";
    return { outcome: "wicket", kind, fielder, fielder2, substitute: substitute || undefined, batterOut, runsCompleted, note };
  }

  // Missed: the batter survives. What the ball becomes depends on where the chance went (special plays, section 13):
  // a catch put down on the rope often carries for four or six, one in the ring or behind the stumps is mostly a dot or a single.
  const isKeeper = !!unit?.keeper && fielder?.id === unit.keeper.id;
  const deep = kind === "caught" && !isKeeper && rng() < X.fielding.boundaryCatchShare;
  const outcome = missedChanceOutcome(
    kind === "stumped" ? "stumping" : kind === "run_out" ? "run_out" : isKeeper ? "catch_keeper" : deep ? "catch_deep" : "catch_ring", rng,
  );
  void probs;
  const note: FieldingNote = kind === "stumped" ? "missed_stumping" : kind === "run_out" ? "run_out_missed" : "dropped_catch";
  return { outcome, kind, fielder, note, ...(deep ? { deep } : {}) };
}

/**
 * What a missed chance turns into. A catch put down in the deep often carries for four or six; one put down in the ring
 * or by the keeper is mostly a dot or a single. A missed stumping is a dot or a single; a missed run out still has the
 * run(s) completed. (Assumed splits: the commentary describes the drop, rarely the runs after it.)
 */
export function missedChanceOutcome(
  where: "catch_deep" | "catch_ring" | "catch_keeper" | "stumping" | "run_out",
  rng: RNG,
): "dot" | "1" | "2" | "3" | "4" | "6" {
  const t = MISSED[where];
  let x = rng();
  for (const [k, v] of t) { x -= v; if (x <= 0) return k; }
  return t[t.length - 1][0];
}
const MISSED: Record<string, readonly (readonly ["dot" | "1" | "2" | "3" | "4" | "6", number])[]> = {
  catch_deep: [["6", 0.2], ["4", 0.15], ["1", 0.4], ["2", 0.25]],
  catch_ring: [["dot", 0.55], ["1", 0.37], ["2", 0.08]],
  catch_keeper: [["dot", 0.6], ["1", 0.15], ["4", 0.2], ["2", 0.05]],
  stumping: [["dot", 0.75], ["1", 0.25]],
  run_out: [["1", 0.6], ["2", 0.3], ["3", 0.05], ["dot", 0.05]],
};

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
      if (res.deep) {
        return ctx.runs >= 6
          ? pick([
            `${ctx.bowler} to ${ctx.batter}, DROPPED on the rope! ${f} gets both hands to it but it bursts through and over the line. SIX, and a life for ${ctx.batter}.`,
            `${ctx.bowler} to ${ctx.batter}, ${f} misjudges it in the deep, the ball goes through the fingers and over the rope. Dropped, and six runs!`,
          ])
          : ctx.runs === 4
            ? `${ctx.bowler} to ${ctx.batter}, put down in the deep! ${f} spills it and it trickles over the rope for FOUR.`
            : pick([
              `${ctx.bowler} to ${ctx.batter}, skied towards the boundary, ${f} gets under it... and DROPS it! They run ${ctx.runs}.`,
              `${ctx.bowler} to ${ctx.batter}, a chance in the deep, ${f} comes in, dives, and it pops out. Dropped! ${ctx.runs} run${ctx.runs === 1 ? "" : "s"}.`,
            ]);
      }
      const tail = ctx.runs >= 4 ? ` and it races away for ${ctx.runs}` : ctx.runs > 0 ? `, ${ctx.runs} run${ctx.runs > 1 ? "s" : ""}` : "";
      return pick([
        `${ctx.bowler} to ${ctx.batter}, DROPPED! ${f} puts down a straightforward chance${tail}.`,
        `${ctx.bowler} to ${ctx.batter}, it goes to ${f}, who spills it${tail}! A life for ${ctx.batter}.`,
        `${ctx.bowler} to ${ctx.batter}, edged, ${f} gets a hand to it but can't hold on${tail}.`,
      ]);
    }
    case "missed_stumping": {
      return pick([
        `${ctx.bowler} to ${ctx.batter}, beaten and out of the crease, but ${f} fumbles the take and the stumping chance is gone!`,
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
        `${ctx.bowler} to ${ctx.batter}, caught! ${f} flings full length to the right and holds a blinder!`,
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
