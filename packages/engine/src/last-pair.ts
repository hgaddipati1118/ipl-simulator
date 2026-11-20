/**
 * The last pair: with nine down a real side's last two batters do not bat as the ball model's rating terms say a tail-ender and his
 * partner would. The senior partner farms the strike (singles refused early in the over, one taken on the last ball to keep the end;
 * the junior one refuses the last ball's single so the over's end hands the strike over) and attacks when he has it; the junior one
 * blocks or slogs and falls more often. A table of each outcome class's log multiplier: a common part by the ball of the over (0-2, 3-4,
 * 5 legal balls already bowled), a part that grows with how much better than his partner the striker is (the rating gap over 0.30,
 * clamped: the pair's scoring) and a part that follows who the senior one is, by a little or a lot (tanh of the gap over 0.05) for the
 * strike classes (a single refused, a single on the last ball) by the ball of the over, per format and gender,
 * fitted from Cricsheet ball by ball against the engine as it was (last-pair-data.ts, from packages/ratings/src/analysis/last-pair.py;
 * docs/TACTICS.md section 5).
 *
 * It is a STATE (nine wickets down), not a position: who is "the senior partner" is the partner's rating against the striker's, so a star
 * at number 11 bats and farms as himself, and a pair of equals shows only the part they share. Neither engine gets a place in the order. The T20 (not The Hundred, whose ends change every ten balls), the ODI and the
 * Test, in the instant and the live engine through the same ball model (match.ts ballProbabilities; test-match.ts testBallProbs).
 */
import type { BallOutcome } from "./match.js";
import type { Gender } from "./delivery-rules.js";
import { LAST_PAIR, LAST_PAIR_CLASSES, LAST_PAIR_H1, LAST_PAIR_H2, LAST_PAIR_STRENGTH } from "./last-pair-data.js";

/** The T20I has its own table (the league one plus a shrunk offset: the T20I context plays a different level at nine down) */
export type LastPairFormat = "t20" | "t20i" | "odi" | "test";
const switchKey = (fmt: LastPairFormat): "t20" | "odi" | "test" => (fmt === "t20i" ? "t20" : fmt);

/** Test hook (benchmarks): switch a format's last-pair term off, or scale it; never used by the game */
export const LAST_PAIR_SWITCH: { off: Partial<Record<"t20" | "odi" | "test", boolean>>; scale: Partial<Record<"t20" | "odi" | "test", number>> } = { off: {}, scale: {} };

/** Batting rating of a player as the ball models read the striker: (battingOvr + timing) / 200 */
export const batRating = (p: { battingOvr: number; ratings: { timing: number } }): number => (p.battingOvr + p.ratings.timing) / 200;

/** How much stronger than his partner the striker is, -1 (far weaker) to 1 (far stronger), 0 at a tie: the rating gap over LAST_PAIR_H1, clamped (the pair's scoring) */
export function lastPairGap(striker: number, partner: number): number {
  return Math.min(1, Math.max(-1, (striker - partner) / LAST_PAIR_H1));
}

/** Who is the senior partner, -1 (the striker is the junior one) to 1 (the senior one), 0 at a tie: a steep curve of the rating gap, so a small edge already decides (the strike) */
export function lastPairSenior(striker: number, partner: number): number {
  return Math.tanh((striker - partner) / LAST_PAIR_H2);
}

/** The ball-of-the-over bucket from the legal balls already bowled in the over */
export function lastPairBucket(ballInOver: number): number {
  return ballInOver <= 2 ? 0 : ballInOver <= 4 ? 1 : 2;
}

/** The log multipliers of the classes `LAST_PAIR_CLASSES` (dot, 1, 2, 3, 4, 6, wicket) for this striker, partner and ball; undefined = no term for the format */
export function lastPairLogs(fmt: LastPairFormat, gender: Gender, striker: number, partner: number, ballInOver: number): number[] | undefined {
  if (LAST_PAIR_SWITCH.off[switchKey(fmt)]) return undefined;
  const t = LAST_PAIR[fmt][gender] ?? (fmt === "t20i" ? LAST_PAIR.t20[gender] : undefined);
  if (!t) return undefined;
  const s1 = lastPairGap(striker, partner);
  const s2 = lastPairSenior(striker, partner);
  const k = lastPairBucket(ballInOver);
  const key = switchKey(fmt);
  const strength = LAST_PAIR_STRENGTH[key][gender] * (LAST_PAIR_SWITCH.scale[key] ?? 1);
  return t.a[k].map((a, i) => {
    // the strength acts on what separates the two batters (b, c) and, for the strike classes, the ball-of-the-over pattern about the buckets' mean; the pair's level stays as fitted
    const mean = i <= 1 ? (t.a[0][i] + t.a[1][i] + t.a[2][i]) / 3 : a;
    return mean + strength * (a - mean + s1 * t.b[i] + s2 * t.c[k][i]);
  });
}

/** T20 / ODI: multiply the last pair's term into a ball's outcome weights (wides, no-balls and byes are the bowler's and are left alone) */
export function applyLastPair(probs: Record<BallOutcome, number>, fmt: "t20" | "t20i" | "odi", gender: Gender, striker: number, partner: number, ballInOver: number): void {
  const logs = lastPairLogs(fmt, gender, striker, partner, ballInOver);
  if (!logs) return;
  LAST_PAIR_CLASSES.forEach((k, i) => { probs[k as BallOutcome] *= Math.exp(logs[i]); });
}

/**
 * Test: the same term on the Test model's class probabilities (order `classes`, a dot is what is left): the weights are the
 * probabilities (the dot's the remainder) times exp(log), renormalised.
 */
export function applyLastPairTest(p: number[], classes: readonly string[], gender: Gender, striker: number, partner: number, ballInOver: number): void {
  const logs = lastPairLogs("test", gender, striker, partner, ballInOver);
  if (!logs) return;
  let sum = 0;
  for (const v of p) sum += v;
  let z = Math.max(0, 1 - sum) * Math.exp(logs[0]);
  const m = p.map((v, k) => {
    const i = LAST_PAIR_CLASSES.indexOf((classes[k] === "W" ? "wicket" : classes[k]) as (typeof LAST_PAIR_CLASSES)[number]);
    const w = v * (i >= 0 && i > 0 ? Math.exp(logs[i]) : 1);
    z += w;
    return w;
  });
  for (let k = 0; k < p.length; k++) p[k] = m[k] / z;
}
