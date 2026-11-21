/**
 * The Impact Player as real IPL sides use him (docs/TACTICS.md section 9; fitted by packages/ratings/src/analysis/impact-player.py on
 * Cricsheet IPL 2023-24, judged on 2025+; data impact-player-data.ts).
 *
 * The engine's XI is the eleven that bats (section 7). Real sides use the sub to field a different eleven from the one that bats:
 *  - batting first: a batter who has batted makes way at the innings break for a bowler (or, after a collapse late in the innings,
 *    a bench batter comes in at the fall of a wicket for a batter who is out, and plays the rest of the match);
 *  - fielding first: a bowler fields and bowls in the first innings and makes way for the batter who bats in the chase.
 * So a side fields its batting eleven less X (the batter who does not field, a fitted choice) plus Y (the best bowler on the bench).
 * The plan is drawn once per side and match from the match seed, so the instant and live engines play the same subs.
 */
import { IMPACT_FIT } from "./impact-player-data.js";
import { createRNG } from "./rng.js";

/** Benchmarks: `off` plays the former impact player (a mid-innings sub by a hand rule, each innings) */
export const IMPACT_MODEL = { off: false };

/** What the plan reads of a player (a Player, or the live engine's serialized player plus his fielding) */
export interface ImpactCandidate {
  id: string;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  isInternational: boolean;
  isWicketKeeper: boolean;
  injured?: boolean;
  ratings: { fielding?: number };
}

export interface ImpactPlan<P extends ImpactCandidate = ImpactCandidate> {
  batFirst: boolean;
  /** false: the side uses no sub this match (as about 1% of sides batting first and 9% fielding first do) */
  use: boolean;
  /** The batting eleven's player who does not field */
  x: P | null;
  /** The bench player who comes on to bowl (at the break batting first; from the start fielding first) */
  yBowl: P | null;
  /** Batting first: the bench batter who comes in at a wicket if the innings collapses late */
  yMid: P | null;
  /** The X choice's utility of each player of the batting eleven batting first (keepers apart), for the mid-innings sub */
  xUtil: Record<string, number>;
  /** The five named substitutes */
  bench: P[];
  seed: number;
}

/** The plan applies: a T20 with the Impact Player rule */
export function impactApplies(rules: { impactPlayer: boolean; matchFormat?: string }): boolean {
  return !IMPACT_MODEL.off && rules.impactPlayer && (rules.matchFormat ?? "t20") === "t20";
}

/** The plan's seed for side 0 (home) or 1 (away) of a match */
export function impactSeed(matchSeed: number, side: 0 | 1): number {
  return (Math.imul((matchSeed >>> 0) ^ 0x5bd1e995, 2246822519) + side * 131 + 7) >>> 0;
}

function xUtility(p: ImpactCandidate, pos: number, chase: number): number {
  const w = IMPACT_FIT.x;
  const bat = p.battingOvr / 100, bowl = p.bowlingOvr / 100, fld = (p.ratings.fielding ?? 50) / 100;
  const bin = pos <= 1 ? 0 : pos <= 3 ? 1 : pos <= 5 ? 2 : 3;
  return w.bat * bat + w.bowl * bowl + w.fld * fld + w.os * (p.isInternational ? 1 : 0)
    + (bin === 1 ? w.pos23 : 0) + (bin === 2 ? w.pos45 : 0) + (bin === 3 ? w.pos6 : 0)
    + chase * (w.chase_bat * bat + w.chase_bowl * bowl);
}

function midUtility(p: ImpactCandidate): number {
  const w = IMPACT_FIT.mid;
  const bat = p.battingOvr / 100;
  return w.bat * bat + w.bat2 * bat * bat + w.bowl * (p.bowlingOvr / 100) + w.os * (p.isInternational ? 1 : 0);
}

/** An index drawn from the softmax of `u` with the uniform `r` */
function draw(u: number[], r: number): number {
  const m = Math.max(...u);
  const e = u.map(x => Math.exp(x - m));
  let t = r * e.reduce((a, b) => a + b, 0);
  for (let i = 0; i < e.length; i++) { t -= e[i]; if (t <= 0) return i; }
  return e.length - 1;
}

const osCount = (ps: readonly ImpactCandidate[]) => ps.filter(p => p.isInternational).length;

/**
 * A side's plan for the match: `order` its batting eleven in batting order, `squad` its roster, `batFirst` whether it bats first,
 * `maxOverseas` the league's limit on the field.
 */
export function planImpact<P extends ImpactCandidate>(order: P[], squad: P[], batFirst: boolean, maxOverseas: number, seed: number): ImpactPlan<P> {
  const rng = createRNG(seed);
  const inXI = new Set(order.map(p => p.id));
  const pool = squad.filter(p => !p.injured && !inXI.has(p.id)).sort((a, b) => b.overall - a.overall);
  const plan: ImpactPlan<P> = { batFirst, use: false, x: null, yBowl: null, yMid: null, xUtil: {}, bench: pool.slice(0, 5), seed };
  const skip = rng() < (batFirst ? IMPACT_FIT.noSub.batFirst : IMPACT_FIT.noSub.chase);
  const cands = order.map((p, pos) => ({ p, pos })).filter(c => !c.p.isWicketKeeper);
  if (cands.length === 0 || pool.length === 0) return plan;
  const chase = batFirst ? 0 : 1;
  for (const c of cands) plan.xUtil[c.p.id] = xUtility(c.p, c.pos, 0);
  const x = cands[draw(cands.map(c => xUtility(c.p, c.pos, chase)), rng())].p;
  const osOn = osCount(order) - (x.isInternational ? 1 : 0);
  const legal = pool.filter(p => !p.isInternational || osOn < maxOverseas);
  const yBowl = legal.length > 0 ? legal.reduce((b, p) => (p.bowlingOvr > b.bowlingOvr || (p.bowlingOvr === b.bowlingOvr && p.battingOvr < b.battingOvr) ? p : b), legal[0]) : null;
  // the batter for a collapse: one who could come in for a local batter (the eleven is usually at its overseas limit)
  const midPool = pool.filter(p => !p.isInternational || osCount(order) < maxOverseas);
  const yMid = batFirst && midPool.length > 0 ? midPool[draw(midPool.map(midUtility), rng())] : null;
  plan.x = x; plan.yBowl = yBowl; plan.yMid = yMid;
  plan.use = !skip && yBowl !== null;
  const named = [yBowl, yMid].filter((p): p is P => !!p);
  plan.bench = [...new Set([...named, ...pool])].slice(0, 5);
  return plan;
}

/**
 * Batting first, at the fall of a wicket (`wickets` down after it, in over `over`, 0-based): does the side bring its bench batter in now,
 * and for which batter who is out (`dismissed`)? `onField` is the eleven as it stands. Null: not now.
 */
export function midImpactNow<P extends ImpactCandidate>(plan: ImpactPlan<P>, wickets: number, over: number, dismissed: P[], onField: P[], maxOverseas: number): { subIn: P; subOut: P } | null {
  if (!plan.batFirst || !plan.use || !plan.yMid || wickets >= 10) return null;
  const w = IMPACT_FIT.hazard;
  const h = w.const + (wickets >= 5 ? w.w5 : 0) + (wickets >= 6 ? w.w6 : 0) + (wickets >= 7 ? w.w7 : 0)
    + (over >= 12 ? w.o12 : 0) + (over >= 15 ? w.o15 : 0) + (over >= 17 ? w.o17 : 0);
  const r = createRNG((plan.seed + 7919 * wickets) >>> 0);
  if (r() >= 1 / (1 + Math.exp(-h))) return null;
  const cands = dismissed.filter(p => plan.xUtil[p.id] !== undefined);
  if (cands.length === 0) return null;
  const x = cands[draw(cands.map(p => plan.xUtil[p.id]), r())];
  const y = plan.yMid;
  if (onField.some(p => p.id === y.id)) return null;
  if (y.isInternational && osCount(onField) - (x.isInternational ? 1 : 0) >= maxOverseas) return null;
  return { subIn: y, subOut: x };
}

/** The eleven with `out` replaced by `inn` */
export function swapIn<P extends { id: string }>(xi: P[], out: P, inn: P): P[] {
  return xi.map(p => (p.id === out.id ? inn : p));
}
