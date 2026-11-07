/**
 * The rarer plays and playing conditions both engines add on top of a delivery (RULES-MATCH.md section 13):
 * short runs, a ball lodged in the batter's helmet or clothing (dead ball), misfields, a six saved on the rope, catches
 * taken on the boundary (and relay catches), the reason for a no-ball (front foot / height / fielding restriction) and
 * beamers (a second one removes the bowler from the attack), the reason for penalty runs, the slow over-rate fielding
 * restriction, and the women's extras rates. Rates: match-rules-extra-data.ts (Cricsheet / ESPNcricinfo commentary, built
 * by packages/ratings/src/analysis/match-rules-extra.py) unless stated.
 *
 * Every helper here is a pure function of the delivery and an RNG, so both engines share it.
 */

import { MATCH_RULES_EXTRA as X } from "./match-rules-extra-data.js";
import { ruleOverrides, type Gender } from "./dismissal-kinds.js";
import type { DeliveryDetail } from "./delivery-rules.js";
import { fieldingRating, TEAM_FIELDING_PIVOT, type FielderLike, type FieldingResolution, type FieldingUnit } from "./fielding.js";
import type { RNG } from "./rng.js";

// ── Women's extras ──────────────────────────────────────────────────────

/**
 * The engines' wide / no-ball / bye base rates are calibrated to men's T20 (delivery-rules.ts EXTRAS_RATE_CAL). In
 * women's matches they are scaled by the women's / men's ratio of the fitted per-delivery rates.
 */
export function extrasGenderFactor(gender: Gender): { wide: number; noball: number; legbye: number } {
  if (gender !== "female") return { wide: 1, noball: 1, legbye: 1 };
  const m = X.extrasRate.male, f = X.extrasRate.female;
  return { wide: f.wide / m.wide, noball: f.noBall / m.noBall, legbye: f.byeLegBye / m.byeLegBye };
}

/** Mutates ball probabilities for the women's extras rates (no-op for men) */
export function applyGenderExtras(probs: Record<string, number>, gender: Gender): void {
  if (gender !== "female") return;
  const g = extrasGenderFactor(gender);
  if (probs.wide !== undefined) probs.wide *= g.wide;
  if (probs.noball !== undefined) probs.noball *= g.noball;
  if (probs.legbye !== undefined) probs.legbye *= g.legbye;
}

// ── Slow over-rate fielding restriction ─────────────────────────────────

/**
 * ICC / IPL playing conditions since 2022: a bowling side behind the over rate at the scheduled end of its innings must
 * keep one more fielder inside the circle (four outside instead of five) for every over it bowls after that. The engines
 * have no clock, so whether a side is behind is drawn per innings. ESPNcricinfo commentary of IPL 2025-26 (151 innings)
 * reports the penalty in 12 (7.9%): 9 in the last over only, 2 from the 19th, 1 from the 11th. The text does not always
 * say so, so 7.9% is a floor; the engine uses it as is.
 */
export const OVER_RATE = {
  perInnings: 0.079,
  /** of penalised innings: from which over (counted back from the end) it applies */
  oversFromEnd: { 1: 0.75, 2: 0.17, 4: 0.08 } as Record<number, number>,
  source: "ESPNcricinfo commentary, IPL 2025-26: 12 of 151 innings",
} as const;

/**
 * Effect of one fewer boundary rider (assumption: no public split; CricViz quote a five-out field cuts the boundary rate of
 * the death overs by roughly a tenth against four out): fours +10%, sixes +4% (a six goes over whoever is there), dots -3%.
 */
export const OVER_RATE_EFFECT = { four: 1.10, six: 1.04, dot: 0.97 } as const;

/** The over (0-based) from which a side bowls under the over-rate restriction, or -1. Not in super overs or shortened innings. */
export function drawOverRatePenalty(rng: RNG, overs: number): number {
  const p = ruleOverrides().overRatePenaltyPerInnings ?? OVER_RATE.perInnings;
  if (overs < 5 || rng() >= p) return -1;
  let r = rng();
  for (const [k, v] of Object.entries(OVER_RATE.oversFromEnd)) {
    r -= v;
    if (r <= 0) return Math.max(0, overs - Number(k));
  }
  return overs - 1;
}

export function applyOverRatePenalty(probs: Record<string, number>): void {
  if (probs["4"] !== undefined) probs["4"] *= OVER_RATE_EFFECT.four;
  if (probs["6"] !== undefined) probs["6"] *= OVER_RATE_EFFECT.six;
  if (probs.dot !== undefined) probs.dot *= OVER_RATE_EFFECT.dot;
}

export function overRateLine(teamName: string): string {
  return `${teamName} are behind the over rate, so only four fielders are allowed outside the circle for the rest of the innings.`;
}

// ── No-ball reasons, beamers, penalty reasons ───────────────────────────

export type NoBallKind = "front_foot" | "height" | "fielding";
export type PenaltyReason = "helmet" | "fielding" | "other";

/** Share of no-balls that are beamers (a full toss above the waist) among height no-balls */
function beamerShareOfNoBalls(): number {
  const nb = X.extrasRate.male.noBall;
  return Math.min(1, X.beamerPerDelivery / nb);
}

/**
 * Penalty runs in T20 are mostly the ball hitting the keeper's helmet left on the ground behind him (Law 28.3); the rest
 * illegal fielding (Law 28.2 / 41.5 deliberate distraction). No public split: assumed 60 / 30 / 10.
 */
const PENALTY_REASONS: Record<PenaltyReason, number> = { helmet: 0.6, fielding: 0.3, other: 0.1 };

function sample<K extends string>(t: Record<K, number>, rng: RNG): K {
  let tot = 0;
  for (const v of Object.values(t) as number[]) tot += v;
  let r = rng() * tot;
  let last = Object.keys(t)[0] as K;
  for (const [k, v] of Object.entries(t) as [K, number][]) { last = k; r -= v; if (r <= 0) return k; }
  return last;
}

// ── Fielding plays on a delivery ────────────────────────────────────────

/** Fielder picked for a ground-fielding play: everyone but the keeper and bowler, weighted towards the weaker ones for errors */
function pickFielder(unit: FieldingUnit | undefined, bowlerId: string, rng: RNG, weakerMoreLikely: boolean): FielderLike | undefined {
  const pool = (unit?.fielders ?? []).filter(p => p.id !== bowlerId && p.id !== unit?.keeper?.id);
  if (pool.length === 0) return undefined;
  const w = pool.map(p => weakerMoreLikely ? Math.max(0.2, 1 + 0.02 * (TEAM_FIELDING_PIVOT - fieldingRating(p))) : Math.max(0.2, 1 + 0.02 * (fieldingRating(p) - TEAM_FIELDING_PIVOT)));
  let x = rng() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { x -= w[i]; if (x <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

/** Share of deliveries whose outcome is a run of 1-3 / a four (engine averages, for turning per-delivery rates into conditionals) */
const RUN_BALL_SHARE = 0.38;
const FOUR_BALL_SHARE = 0.13;

export interface SpecialPlayContext {
  rng: RNG;
  unit?: FieldingUnit;
  bowlerId: string;
  /** The dismissal chance behind a wicket (or a miss) on this ball */
  resolution?: FieldingResolution;
  /** Only the labels (no-ball / penalty reasons): the ball already has its play (a chance put down) */
  labelsOnly?: boolean;
}

/**
 * Add the rare plays to a finished delivery (mutates and returns `d`). The labels (misfield, boundary catch, no-ball and
 * penalty reasons) do not change the runs; a short run takes one off, a six saved turns six into one or two, a lodged ball
 * is a dead ball with nothing scored.
 */
export function applySpecialPlays(d: DeliveryDetail, ctx: SpecialPlayContext): DeliveryDetail {
  const { rng } = ctx;
  const o = ruleOverrides();

  // Why a no-ball was called; a beamer is a height no-ball
  if (d.outcome === "noball") {
    const k = X.noBallKind;
    d.noBallKind = sample({ front_foot: k.frontFoot, height: k.height, fielding: k.fielding }, rng);
    if (d.noBallKind === "height" && (o.forceBeamer || rng() < Math.min(1, beamerShareOfNoBalls() / Math.max(1e-6, k.height)))) d.beamer = true;
  }
  if (d.penalty) d.penaltyReason = sample(PENALTY_REASONS, rng);
  if (ctx.labelsOnly) return d;

  if (d.dismissal) {
    // A catch in the deep: on the rope, and now and then a relay (one fielder parries, another completes it)
    if (d.dismissal.kind === "caught" && d.dismissal.fielderId && d.dismissal.fielderId !== ctx.unit?.keeper?.id
        && rng() < (o.boundaryCatchShare ?? X.fielding.boundaryCatchShare)) {
      d.boundaryCatch = true;
      if (rng() < (o.relayCatchShare ?? X.fielding.relayCatchShare)) {
        const other = (ctx.unit?.fielders ?? []).filter(p => p.id !== d.dismissal!.fielderId && p.id !== ctx.bowlerId && p.id !== ctx.unit?.keeper?.id);
        if (other.length > 0) d.relayFielderId = other[Math.floor(rng() * other.length)].id;
      }
    }
    return d;
  }
  if (!d.legal && d.outcome !== "noball") return d;

  // A hit for six saved by a fielder on the rope: palmed back in, one or two run
  if (d.batBoundary === 6 && d.outcome === "6") {
    const f = pickFielder(ctx.unit, ctx.bowlerId, rng, false);
    const p = (o.sixSavedShare ?? X.fielding.sixSavedShare) * (f ? Math.max(0.3, 1 + 0.02 * (fieldingRating(f) - TEAM_FIELDING_PIVOT)) : 1);
    if (rng() < p) {
      const r = rng() < 0.6 ? 1 : 2;
      d.sixSaved = { fielderId: f?.id, runs: r };
      d.outcome = r === 1 ? "1" : "2";
      d.batBoundary = 0;
      d.batRuns = r;
      d.runsRun = r;
      return finishExtras(d);
    }
  }

  // Misfields: one of the runs, or the four, came from a fumble (worse fielders fumble more)
  if (d.outcome === "1" || d.outcome === "2" || d.outcome === "3" || (d.outcome === "4" && d.batBoundary === 4)) {
    const m = o.misfieldPerDelivery ?? X.fielding.misfieldPerDelivery;
    const bShare = X.fielding.misfieldBoundaryShare;
    const q = d.outcome === "4" ? (m * bShare) / FOUR_BALL_SHARE : (m * (1 - bShare)) / RUN_BALL_SHARE;
    const unitQ = ctx.unit?.quality ?? 0;
    if (rng() < Math.min(0.5, q * Math.max(0.3, 1 - 1.5 * unitQ))) {
      const f = pickFielder(ctx.unit, ctx.bowlerId, rng, true);
      d.misfield = { fielderId: f?.id, boundary: d.outcome === "4" };
    }
  }

  // A short run: one run off the bat is not counted (Law 18.3). The batters still end where they ran to.
  if (!d.batBoundary && d.batRuns >= 1 && d.runsRun >= 1 && d.overthrow === 0 && d.legal) {
    const p = (o.shortRunPerDelivery ?? X.shortRunPerDelivery) / RUN_BALL_SHARE;
    if (rng() < p) {
      d.shortRun = true;
      d.batRuns--;
      d.outcome = d.batRuns === 0 ? "dot" : (String(d.batRuns) as "1" | "2");
      d.misfield = undefined;
      return finishExtras(d);
    }
  }

  // The ball lodges in the batter's helmet grille / pads: dead ball, nothing scored, the ball counts
  if (d.outcome === "dot" && d.legal && d.runsRun === 0) {
    const p = (o.lodgedPerDelivery ?? X.lodgedDeadBallPerDelivery) / 0.35;
    if (rng() < p) d.lodged = true;
  }
  return d;
}

function finishExtras(d: DeliveryDetail): DeliveryDetail {
  d.extras = d.wides + d.noBalls + d.byes + d.legByes + d.penalty;
  return d;
}

// ── Commentary for the new plays (hand-written: the corpus has a handful of lines at most) ──

function pick<T>(xs: readonly T[], rng: RNG): T {
  return xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
}

export interface PlayNames { bowler: string; batter: string; fielder?: string; fielder2?: string }

/** Sentence(s) about the extra play on this ball, appended to (or replacing) the ordinary line; undefined when none */
export function specialPlayText(d: DeliveryDetail, n: PlayNames, rng: RNG): string | undefined {
  const pre = `${n.bowler} to ${n.batter}`;
  const F = n.fielder ?? "the fielder";
  if (d.sixSaved) {
    return pick([
      `${pre}, that's going for six... no! ${F} leaps on the rope, palms it back into play and ${d.sixSaved.runs === 1 ? "they get just one" : "they come back for two"}. Brilliant boundary fielding!`,
      `${pre}, launched towards the rope, ${F} jumps, flicks it back before landing over the line. ${d.sixSaved.runs} run${d.sixSaved.runs > 1 ? "s" : ""} instead of six!`,
    ], rng);
  }
  if (d.shortRun) {
    const r = d.batRuns + d.byes + d.legByes;
    return pick([
      `${pre}, ${r + 1} run${r + 1 > 1 ? "s" : ""} run, but the umpire signals ONE SHORT. The bat was not grounded at the end of a run, so only ${r} count${r === 1 ? "s" : ""}.`,
      `${pre}, they scamper back for more, but one short is called! ${r} run${r === 1 ? "" : "s"} counted.`,
    ], rng);
  }
  if (d.lodged) {
    return pick([
      `${pre}, the ball gets stuck in the grille of the helmet! Dead ball, nothing to it.`,
      `${pre}, it lodges in the batter's pad and the umpire calls dead ball. No run.`,
    ], rng);
  }
  if (d.misfield) {
    return d.misfield.boundary
      ? pick([
        `${pre}, should be a single, but it goes straight through ${F}'s legs and away to the boundary! FOUR, a costly misfield.`,
        `${pre}, ${F} dives over it near the rope and it runs away for FOUR. That is a misfield.`,
      ], rng)
      : pick([
        `${pre}, ${F} fumbles in the field and they take an extra run. ${d.batRuns} in all.`,
        `${pre}, misfield by ${F}, the ball squirts away and the batters push for ${d.batRuns}.`,
      ], rng);
  }
  return undefined;
}

/** Extra sentence for a no-ball's reason / beamer / boundary catch / penalty reason, added to the ball's line */
export function specialPlayTail(d: DeliveryDetail, n: PlayNames, rng: RNG): string {
  const bits: string[] = [];
  if (d.outcome === "noball" && d.beamer) bits.push(pick(["The umpire has a word with the bowler about the beamer.", "The bowler raises a hand in apology for the beamer."], rng));
  if (d.dismissal && d.boundaryCatch) {
    bits.push(d.relayFielderId && n.fielder2
      ? pick([`A relay catch on the rope! ${n.fielder2} parries it back over the line before ${n.fielder ?? "a team-mate"} completes it.`, `${n.fielder2} catches it, loses balance, tosses it up, and ${n.fielder ?? "the fielder"} takes the relay inside the rope!`], rng)
      : pick([`Taken right on the boundary rope!`, `${n.fielder ?? "The fielder"} keeps the feet inside the rope and holds it.`], rng));
  }
  return bits.length > 0 ? " " + bits.join(" ") : "";
}

export function beamerSuspensionLine(bowler: string, replacement: string): string {
  return `That is the second beamer from ${bowler}, who is removed from the attack and cannot bowl again in the innings. ${replacement} will finish the over.`;
}

export function bowlerInjuryLine(bowler: string, replacement: string): string {
  return `${bowler} pulls up mid-over and has to leave the field. ${replacement} will finish the over.`;
}
