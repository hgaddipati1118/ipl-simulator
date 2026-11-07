/**
 * The Laws and T20 playing conditions as the match engines apply them to one delivery (RULES-MATCH.md section 12).
 *
 * Both engines (match.ts, live-match.ts) sample the same coarse outcome (dot, 1, 2, 3, 4, 6, wicket, wide, noball,
 * legbye) from their own probabilities. This module turns that outcome into a complete delivery: how many wides, what
 * the no-ball cost and what the batter hit off it, byes against leg byes, overthrows, penalty runs, which dismissal
 * kinds are legal on the ball and who is out, how far the batters ran and who faces next. Every rate is fitted from
 * Cricsheet T20 data (packages/ratings/src/analysis/match-rules.py -> match-rules-data.ts).
 */

import { MATCH_RULES_DATA as D } from "./match-rules-data.js";
import { canDismiss, isBowlerWicket, ruleOverrides, type DismissalKind, type Gender } from "./dismissal-kinds.js";
export * from "./dismissal-kinds.js";
import type { RNG } from "./rng.js";
import type { BowlingStyle } from "./player.js";
import type { MatchFormatSpec } from "./format.js";
import type { RuleSet } from "./rules.js";
import {
  fieldingRating,
  keepingRating,
  type FielderLike,
  type FieldingResolution,
  type FieldingUnit,
} from "./fielding.js";

// ── Parameters, with test overrides ─────────────────────────────────────

const overrides = new Proxy({} as ReturnType<typeof ruleOverrides>, { get: (_t, k) => (ruleOverrides() as any)[k] });

export function genderOf(rules: Pick<RuleSet, "league" | "gender"> | undefined): Gender {
  // same test as leagues.ts isWomenLeague (imported there would be a module cycle)
  return rules && (rules.league === "wpl" || rules.gender === "women") ? "female" : "male";
}

export const retireParams = () => ({
  hurtPerBatterBall: overrides.hurtPerBatterBall ?? D.retire.hurtPerBatterBall,
  returnProb: overrides.returnProb ?? D.retire.returnProb,
  retiredOutPerInning: overrides.retiredOutPerInning ?? D.retire.retiredOutPerInning,
  timedOutPerWicket: overrides.timedOutPerWicket ?? D.retire.timedOutPerWicket,
  mankadPerDelivery: overrides.mankadPerDelivery ?? D.retire.mankadPerDelivery,
  bowlerLeavesPerOver: overrides.bowlerLeavesPerOver ?? D.retire.bowlerLeavesPerOver,
  retiredOutAvgOver: D.retire.retiredOutAvgOver,
});

/**
 * The engines' base rates for wides, no-balls and byes/leg byes were tuned before the extras were fitted and sit below
 * Cricsheet (benchmark-rules.ts, 60,000 matches: wides 2.15% of deliveries against 3.36% in men's T20, no-balls 0.25%
 * against 0.43%, byes + leg byes 1.2% against 1.83%). These factors bring the three rates to the data; the bowler's
 * accuracy still moves each one.
 */
export const EXTRAS_RATE_CAL = { wide: 1.55, noball: 1.6, legbye: 1.45 } as const;

/** Scoring-outcome weights on a free hit (Cricsheet free hits against the other legal balls of the same competitions) */
export function freeHitFactors(): Record<string, number> {
  const s = D.freeHit.scoring;
  return { dot: s.dot, "1": s.one, "2": s.two, "3": s.three, "4": s.four, "6": s.six, wicket: D.freeHit.wicketRatio };
}

/** Mutates `probs` for a free hit: more boundaries, almost no dismissals */
export function applyFreeHitToProbs(probs: Record<string, number>): void {
  const f = freeHitFactors();
  for (const k of Object.keys(f)) if (probs[k] !== undefined) probs[k] *= f[k];
}

// ── Sampling helpers ────────────────────────────────────────────────────

function sampleKeyed(table: Readonly<Record<string, number>>, rng: RNG): string {
  let total = 0;
  for (const v of Object.values(table)) total += v;
  let r = rng() * total;
  let last = "";
  for (const [k, v] of Object.entries(table)) {
    last = k;
    r -= v;
    if (r <= 0) return k;
  }
  return last;
}

// ── The delivery ────────────────────────────────────────────────────────

export interface DismissalDetail {
  kind: DismissalKind;
  /** Which batter is out */
  out: "striker" | "nonStriker";
  fielderId?: string;
  /** Second fielder of a relay run out ("run out (A/B)") */
  fielder2Id?: string;
  /** The catch / run out was made by a substitute fielder */
  substitute?: boolean;
  /** Credited to the bowler (see isBowlerWicket) */
  bowlerCredit: boolean;
  /** The incoming batter takes strike (before any end-of-over swap) */
  newBatterFaces: boolean;
}

export interface DeliveryDetail {
  /** The ball's outcome class after the draws (a missed chance changes it) */
  outcome: "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball" | "legbye";
  legal: boolean;
  /** Runs off the bat credited to the striker (completed runs on a run-out ball; overthrow runs included) */
  batRuns: number;
  /** 4 or 6 when the bat hit a boundary (counts as a four / six) */
  batBoundary: 0 | 4 | 6;
  /** Wide extras including the one for the wide itself; 0 when the ball was not a wide */
  wides: number;
  /** No-ball extras (the penalty only); 0 when the ball was not a no-ball */
  noBalls: number;
  byes: number;
  legByes: number;
  penalty: number;
  /** Sum of every extra, including the penalty */
  extras: number;
  /** Runs the batters physically ran (boundaries are not run), for strike changes */
  runsRun: number;
  /** Overthrow boundary runs (inside batRuns / byes / legByes) */
  overthrow: number;
  /** Where a wide went: off side, leg side or over the batter's head */
  wideKind?: "off" | "leg" | "height";
  dismissal?: DismissalDetail;
  /** This ball makes the next one a free hit */
  freeHitNext: boolean;
}

function physical(total: number): number {
  return total >= 4 ? total - 4 : total;
}

function emptyDelivery(outcome: DeliveryDetail["outcome"]): DeliveryDetail {
  return {
    outcome, legal: outcome !== "wide" && outcome !== "noball", batRuns: 0, batBoundary: 0, wides: 0, noBalls: 0,
    byes: 0, legByes: 0, penalty: 0, extras: 0, runsRun: 0, overthrow: 0, freeHitNext: false,
  };
}

export interface DeliveryContext {
  rng: RNG;
  fmt: MatchFormatSpec;
  gender: Gender;
  freeHit: boolean;
  bowlerId: string;
  bowlerStyle?: BowlingStyle;
  unit?: FieldingUnit;
  /** Players off the field who can field as substitutes (the bench) */
  bench?: readonly FielderLike[];
}

/** Closed-form per-slot chance of the bowler / keeper in a relay run out so the share of run outs involving each matches the data */
function slotShare(involved: number, two: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const a = (lo + hi) / 2;
    const p = (1 - two) * a + two * (1 - (1 - a) * (1 - a));
    if (p < involved) lo = a; else hi = a;
  }
  return (lo + hi) / 2;
}
const SLOT_BOWLER = slotShare(D.runOut.fielders.bowlerInvolved, D.runOut.fielders.twoFielders);
const SLOT_KEEPER = slotShare(D.runOut.fielders.keeperInvolved, D.runOut.fielders.twoFielders);

/** Pick the fielders of a run out: one, or two for a relay (bowler, keeper or anyone) */
export function pickRunOutFielders(ctx: Pick<DeliveryContext, "rng" | "bowlerId" | "unit">): { first?: FielderLike; second?: FielderLike } {
  const { rng, unit, bowlerId } = ctx;
  const all = unit?.fielders ?? [];
  if (all.length === 0) return {};
  const keeper = unit?.keeper;
  const bowler = all.find(p => p.id === bowlerId);
  const others = all.filter(p => p.id !== bowlerId && p.id !== keeper?.id);
  const pickSlot = (exclude?: FielderLike): FielderLike => {
    const u = rng();
    if (bowler && bowler !== exclude && u < SLOT_BOWLER) return bowler;
    if (keeper && keeper !== exclude && u < SLOT_BOWLER + SLOT_KEEPER) return keeper;
    const pool = others.filter(p => p !== exclude);
    const from = pool.length > 0 ? pool : all.filter(p => p !== exclude);
    return from[Math.min(from.length - 1, Math.floor(rng() * from.length))] ?? all[0];
  };
  const first = pickSlot();
  const second = rng() < D.runOut.fielders.twoFielders ? pickSlot(first) : undefined;
  return { first, second };
}

function newBatterFaces(kind: DismissalKind, out: "striker" | "nonStriker", runsRun: number, rng: RNG): boolean {
  if (kind !== "run_out") return rng() < D.strike.otherKinds;
  const key = `run_out_${out === "nonStriker" ? "ns" : "s"}_${runsRun % 2}` as keyof typeof D.strike;
  return rng() < (D.strike[key] as number);
}

/** Which batter a run out takes, given the runs completed (data: 47% non-striker) */
export function pickRunOutBatter(runsCompleted: number, onWideOrNoBall: boolean, rng: RNG): "striker" | "nonStriker" {
  if (overrides.forceRunOutRole) return overrides.forceRunOutRole;
  const share = onWideOrNoBall ? D.runOut.nonStrikerShare.extra : D.runOut.nonStrikerShare[String(Math.min(3, runsCompleted)) as "0" | "1" | "2" | "3"];
  return rng() < share ? "nonStriker" : "striker";
}

/** Runs completed before a run out on a legal ball */
export function pickRunOutRuns(rng: RNG): number {
  if (overrides.forceRunOutRuns !== undefined) return overrides.forceRunOutRuns;
  return Number(sampleKeyed(D.runOut.runsCompleted, rng));
}

/** The fielder for a catch: a substitute at the fitted rate when a bench is available */
export function maybeSubstitute(ctx: Pick<DeliveryContext, "rng" | "bench">): FielderLike | undefined {
  const bench = ctx.bench;
  const p = overrides.substituteShare ?? D.catchFielders.substituteShare;
  if (!bench || bench.length === 0 || ctx.rng() >= p) return undefined;
  return bench[Math.min(bench.length - 1, Math.floor(ctx.rng() * bench.length))];
}

function buildDismissal(
  kind: DismissalKind,
  d: DeliveryDetail,
  ctx: DeliveryContext,
  res: Pick<FieldingResolution, "fielder" | "fielder2" | "substitute"> | undefined,
  out: "striker" | "nonStriker",
): DismissalDetail {
  return {
    kind,
    out,
    fielderId: res?.fielder?.id,
    fielder2Id: res?.fielder2?.id,
    substitute: res?.substitute || undefined,
    bowlerCredit: isBowlerWicket(kind),
    newBatterFaces: newBatterFaces(kind, out, d.runsRun, ctx.rng),
  };
}

/** Roll a dismissal on a wide or a no-ball (stumped / hit wicket / run out on a wide; run out and the like on a no-ball) */
function rollExtraDismissal(cls: "wide" | "noBall", d: DeliveryDetail, ctx: DeliveryContext): void {
  const g = ctx.gender;
  const rate = cls === "wide" ? D.wide.wicketRate[g] : D.noBall.wicketRate[g];
  const kinds: Record<string, number> = { ...(cls === "wide" ? D.wide.wicketKinds : D.noBall.wicketKinds) };
  if (overrides.forceKind) {
    if (!canDismiss(overrides.forceKind, cls, ctx.freeHit)) return;
  } else if (ctx.rng() >= rate) return;
  const kind = (overrides.forceKind ?? sampleKeyed(kinds, ctx.rng)) as DismissalKind;
  if (!canDismiss(kind, cls, ctx.freeHit)) return;
  let fielder: FielderLike | undefined;
  let fielder2: FielderLike | undefined;
  let out: "striker" | "nonStriker" = "striker";
  if (kind === "stumped") {
    fielder = ctx.unit?.keeper;
    // The keeper's skill moves the (already converted) rate around its average
    const skill = fielder ? keepingRating(fielder) : 50;
    if (!overrides.forceKind && ctx.rng() >= Math.max(0.2, Math.min(1.6, 1 + 0.003 * (skill - 50) / 0.9))) return;
  } else if (kind === "run_out") {
    const f = pickRunOutFielders(ctx);
    fielder = f.first; fielder2 = f.second;
    out = pickRunOutBatter(0, true, ctx.rng);
    const skill = fielder ? fieldingRating(fielder) : 50;
    if (!overrides.forceKind && ctx.rng() >= Math.max(0.3, Math.min(1.6, 1 + 0.005 * (skill - 50) / 0.75))) return;
  }
  d.dismissal = buildDismissal(kind, d, ctx, { fielder, fielder2 }, out);
}

/**
 * Turn the sampled outcome into a complete delivery.
 * `resolution` is the fielding resolution of a "wicket" draw (kind, fielders, run-out batter and runs); the caller has
 * already turned a missed chance into a scoring outcome.
 */
export function expandDelivery(
  outcome: DeliveryDetail["outcome"],
  resolution: FieldingResolution | undefined,
  ctx: DeliveryContext,
): DeliveryDetail {
  const { rng, fmt, gender } = ctx;
  const d = emptyDelivery(outcome);

  switch (outcome) {
    case "dot": case "1": case "2": case "3": {
      const r = Number(outcome === "dot" ? 0 : outcome);
      d.batRuns = r;
      d.runsRun = r;
      const p = overrides[r === 0 ? "overthrowBoundaryAfterDot" : "overthrowBoundaryAfterRun"] ?? (r === 0 ? D.overthrow.boundaryAfterDot : D.overthrow.boundaryAfterRun);
      if (rng() < p) { d.overthrow = 4; d.batRuns += 4; }
      break;
    }
    case "4": d.batRuns = 4; d.batBoundary = 4; break;
    case "6": d.batRuns = 6; d.batBoundary = 6; break;
    case "legbye": {
      const t = D.byes[gender];
      const isBye = rng() < t.byeShare;
      const n = Number(sampleKeyed(isBye ? t.byeRuns : t.legByeRuns, rng));
      if (isBye) d.byes = n; else d.legByes = n;
      d.runsRun = physical(n);
      d.extras = n;
      break;
    }
    case "wide": {
      const w = Number(sampleKeyed(D.wide.runs[gender], rng));
      d.wides = w;
      d.extras = w;
      d.runsRun = w === 5 ? 0 : w - 1;
      d.wideKind = sampleKeyed({ off: D.wide.kind.off, leg: D.wide.kind.leg, height: D.wide.kind.height }, rng) as "off" | "leg" | "height";
      rollExtraDismissal("wide", d, ctx);
      if (d.dismissal) { d.wides = 1; d.extras = 1; d.runsRun = 0; }
      break;
    }
    case "noball": {
      const table = D.noBall.bat[gender] as readonly (readonly number[])[];
      let r = rng();
      let pick = table[table.length - 1];
      for (const row of table) { r -= row[3]; if (r <= 0) { pick = row; break; } }
      d.noBalls = fmt.noBallPenalty ?? 1;
      d.batRuns = pick[0];
      d.byes = pick[1];
      d.legByes = pick[2];
      d.batBoundary = pick[0] === 4 ? 4 : pick[0] === 6 ? 6 : 0;
      d.extras = d.noBalls + d.byes + d.legByes;
      d.runsRun = d.batBoundary ? 0 : physical(d.batRuns + d.byes + d.legByes);
      d.freeHitNext = true;
      rollExtraDismissal("noBall", d, ctx);
      if (d.dismissal) { d.batRuns = 0; d.batBoundary = 0; d.byes = 0; d.legByes = 0; d.extras = d.noBalls; d.runsRun = 0; }
      return finish(d, ctx);
    }
    case "wicket": {
      const res = resolution;
      const kind = (res?.kind ?? "bowled") as DismissalKind;
      let out: "striker" | "nonStriker" = "striker";
      if (kind === "run_out") {
        d.batRuns = res?.runsCompleted ?? 0;
        d.runsRun = d.batRuns;
        out = res?.batterOut ?? pickRunOutBatter(d.batRuns, false, rng);
      }
      d.dismissal = buildDismissal(kind, d, ctx, res, out);
      break;
    }
  }
  return finish(d, ctx);
}

function finish(d: DeliveryDetail, ctx: DeliveryContext): DeliveryDetail {
  // A free hit that is itself a wide or a no-ball keeps the free hit for the next ball
  if (ctx.freeHit && (d.outcome === "wide" || d.outcome === "noball")) d.freeHitNext = true;
  const p = overrides.penaltyPerDelivery ?? D.penaltyPerDelivery;
  if (p > 0 && ctx.rng() < p) d.penalty = 5;
  d.extras = d.wides + d.noBalls + d.byes + d.legByes + d.penalty;
  return d;
}

// ── Stats attribution ───────────────────────────────────────────────────

/** Runs charged to the bowler: runs off the bat, wides and no-balls; not byes, leg byes or penalty runs */
export function bowlerRuns(d: Pick<DeliveryDetail, "batRuns" | "wides" | "noBalls">): number {
  return d.batRuns + d.wides + d.noBalls;
}

/** A ball the batter faced: every legal ball and every no-ball, not a wide */
export function batterFaced(d: Pick<DeliveryDetail, "legal" | "outcome">): boolean {
  return d.legal || d.outcome === "noball";
}

// ── Scorecard text ──────────────────────────────────────────────────────

