/**
 * Who bowls the next over (T20 and ODI, both engines): the captain's choice model, and the bowling plan a user can set.
 *
 * The default (a CPU captain, or a user who has set nothing) is a conditional logit fitted on the real over-by-over record of
 * 1,788 international T20Is and ODIs since 2019 (packages/ratings/src/analysis/bowling-choice.py, docs/data/bowling_choice.json,
 * generated bowling-choice-data.ts): among the bowlers who may bowl the over, the utility of each is a sum of fitted weights of his
 * rating rank in the eleven, his type (fast / medium pace / spin / slow part-timer) by phase, whether he is one of the two best
 * at the start and the death, overs used, the gap since his last over, overs he has bowled in this phase and whether he is new to
 * the attack. Real captains open with pace, bring spin on in the middle overs and keep their best pace bowlers for the death; the
 * rule this replaces (one of the top three on rating, uniformly) did none of it (spin bowled 49% of powerplay overs, 35% of death
 * overs; real 24% and 16%).
 *
 * A user's plan (`BowlingPlan`) narrows the choice: an over he fixed goes to that bowler when the rules allow him, else the
 * bowlers he listed for the over's phase are chosen from (by the same model), else anyone. A user who asks for a spinner in the
 * powerplay gets him, and the match model charges him what a spinner costs there (matchups.ts, phase x bowler type).
 */
import { BOWLING_CHOICE } from "./bowling-choice-data.js";
import { isFastBowler, isPaceBowler, isSpinBowler, type BowlingStyle } from "./matchups.js";
import type { RNG } from "./rng.js";

type Gender = "male" | "female";

export type ChoiceFormat = "t20" | "odi";
export type PlanPhase = "powerplay" | "middle" | "death";
export type BowlerKind = "fast" | "medium" | "spin" | "slow";

/** A bowling plan: preferred bowlers per phase (ids), and overs fixed to a bowler (over index, 0-based -> id) */
export interface BowlingPlan {
  /** Bowlers for the powerplay (T20 overs 1-6, ODI 1-10) */
  powerplay: string[];
  /** Bowlers for the middle overs (T20 7-15, ODI 11-40) */
  middle: string[];
  /** Bowlers for the death (T20 16-20, ODI 41-50) */
  death: string[];
  /** Overs fixed to a bowler: over index (0-based) -> player id */
  overs?: Record<number, string>;
  /** A Test: the over of an innings from which spin may be used (until then the captain keeps to pace while a seamer is free) */
  spinFrom?: number;
}

export const EMPTY_PLAN: BowlingPlan = { powerplay: [], middle: [], death: [] };

export function bowlerKind(style: BowlingStyle | undefined): BowlerKind {
  if (!style || style === "unknown") return "medium";
  if (isSpinBowler(style)) return "spin";
  if (isFastBowler(style)) return "fast";
  if (isPaceBowler(style)) return "medium";
  return "slow";
}

/** The phase of an over (0-based) a plan's lists are keyed by: T20 1-6 / 7-15 / 16-20, ODI 1-10 / 11-40 / 41-50 */
export function planPhase(fmt: ChoiceFormat, over: number): PlanPhase {
  if (fmt === "t20") return over < 6 ? "powerplay" : over < 15 ? "middle" : "death";
  return over < 10 ? "powerplay" : over < 40 ? "middle" : "death";
}

/** The fitted model's phases (the ODI's middle overs are split at 30) */
function modelPhase(fmt: ChoiceFormat, over: number): string {
  if (fmt === "t20") return over < 6 ? "pp" : over < 15 ? "mid" : "death";
  return over < 10 ? "pp" : over < 30 ? "mid" : over < 40 ? "late" : "death";
}

/** What the model knows about a bowler who may bowl the next over */
export interface ChoiceCandidate {
  id: string;
  /** Rank on bowling rating in the eleven (0 = best; keepers apart) */
  rank: number;
  style: BowlingStyle | undefined;
  /** A batter who bowls (role "batsman") */
  partTimer: boolean;
  /** Overs bowled so far */
  used: number;
  /** The over he last bowled (0-based), null if none yet */
  lastOver: number | null;
  /** Overs he has bowled in this phase so far */
  phaseUsed: number;
  /**
   * How tight the attack is (the same for every candidate of an over): overs the front-line bowlers (rank 0-4, not part-timers) have left
   * minus overs still to bowl, in bins 0 (cannot cover it) / 1 (up to 2 spare) / 2 (up to 5) / 3 (more)
   */
  slack: number;
  /** Overs the front-line pace bowlers (fast / medium, rank 0-4, not part-timers) have left; the same for every candidate of an over */
  paceLeft: number;
}

/** The features of a candidate (names as in bowling-choice.py `features`); `left` is the one continuous feature */
export function choiceFeatures(fmt: ChoiceFormat, over: number, c: ChoiceCandidate, cap: number): [string, number][] {
  const ph = modelPhase(fmt, over);
  const kind = bowlerKind(c.style);
  const out: [string, number][] = [];
  out.push([`rank${Math.min(c.rank, 5)}`, 1]);
  const ob = fmt === "t20" ? over : Math.floor(over / 2);
  out.push([`${kind}@${ph}`, 1]);
  out.push([`${kind}@o${ob}`, 1]);
  if (c.rank >= 5 || c.partTimer) out.push([`extra@o${ob}`, 1]);
  if (c.rank < 2) out.push([`top2@${ph}`, 1]);
  const k2 = kind === "spin" ? "spin" : kind === "slow" ? "slow" : "pace";
  out.push([`used${fmt === "t20" ? Math.min(c.used, 3) : Math.min(Math.floor(c.used / 2), 4)}:${k2}@${ph}`, 1]);
  if (c.rank >= 5 || c.partTimer) out.push([`xslack${c.slack}`, 1]);
  if ((kind === "fast" || kind === "medium") && ph !== "death" && c.paceLeft - 1 < (fmt === "t20" ? 3 : 6)) out.push(["dshort", 1]);
  const gap = c.lastOver === null ? null : over - c.lastOver;
  out.push([`gap${gap === null ? "never" : gap <= 3 ? gap : gap <= 5 ? "4-5" : "6+"}`, 1]);
  out.push([`phaseused${Math.min(c.phaseUsed, 2)}@${ph}`, 1]);
  if (gap === null) out.push([`new@${ph}`, 1]);
  if (c.partTimer) out.push(["parttimer", 1]);
  out.push(["left", Math.max(0, cap - c.used) / cap]);
  return out;
}

/** The model's probability of each candidate bowling the over (softmax of the fitted utilities) */
export function choiceProbabilities(fmt: ChoiceFormat, gender: Gender, over: number, cands: readonly ChoiceCandidate[], cap: number): number[] {
  const w = BOWLING_CHOICE[`${fmt}-${gender}`];
  const u = cands.map(c => choiceFeatures(fmt, over, c, cap).reduce((s, [name, v]) => s + (w[name] ?? 0) * v, 0));
  const mx = Math.max(...u);
  const e = u.map(x => Math.exp(x - mx));
  const t = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / t);
}

/** Draw one candidate by the model (index into `cands`) */
export function chooseByModel(fmt: ChoiceFormat, gender: Gender, over: number, cands: readonly ChoiceCandidate[], cap: number, rng: RNG): number {
  if (cands.length <= 1) return 0;
  const p = choiceProbabilities(fmt, gender, over, cands, cap);
  let x = rng();
  for (let i = 0; i < p.length; i++) { x -= p[i]; if (x <= 0) return i; }
  return p.length - 1;
}

/**
 * The candidates a user's plan leaves for this over (ids that may bowl it): the bowler fixed to the over if he is among them,
 * else those listed for the over's phase that are, else all. Never empties the list.
 */
export function narrowByPlan<T extends { id: string }>(cands: readonly T[], plan: BowlingPlan | undefined, fmt: ChoiceFormat, over: number): T[] {
  if (!plan) return [...cands];
  const fixed = plan.overs?.[over];
  if (fixed) {
    const hit = cands.filter(c => c.id === fixed);
    if (hit.length > 0) return hit;
  }
  const listed = new Set(plan[planPhase(fmt, over)] ?? []);
  if (listed.size > 0) {
    const hit = cands.filter(c => listed.has(c.id));
    if (hit.length > 0) return hit;
  }
  return [...cands];
}

/**
 * Does the captain's model choose the next bowler, or the former rule (one of the best three on rating, uniformly, inside the user's plan)?
 * Every T20 innings uses the model; the ODI keeps the former rule. The model spreads the overs over the attack as real captains do, which
 * narrows the gap between the sides (the stronger side's best bowlers bowl a smaller share), and the ODI's win log loss on the 2025+ fixtures
 * got worse with it (0.673 -> 0.724 men's, 0.435 -> 0.450 women's, where the former rule scored the same as before; docs/TACTICS.md,
 * "Regression on the real fixtures"). A plan still narrows the ODI's choice; the model's plan strip stays in the editor as a starting point.
 */
export function captainModelFor(odi: boolean): boolean {
  return !odi;
}

/** Does the plan name anyone (so that a plan-less CPU side can be told from a user's)? */
export function planIsSet(plan: BowlingPlan | undefined): boolean {
  return !!plan && (plan.powerplay.length + plan.middle.length + plan.death.length + Object.keys(plan.overs ?? {}).length > 0 || plan.spinFrom !== undefined);
}

/** The ids a plan names anywhere (they join the attack when the side's own list lacks them) */
export function planBowlerIds(plan: BowlingPlan | undefined): string[] {
  if (!plan) return [];
  return [...new Set([...plan.powerplay, ...plan.middle, ...plan.death, ...Object.values(plan.overs ?? {})])];
}

/** The CPU's plan for a side, from the model: in each over, the bowler the model rates highest (a readable default for the editor) */
export function modelPlanFor(
  fmt: ChoiceFormat, gender: Gender, cap: number, attack: readonly { id: string; rank: number; style: BowlingStyle | undefined; partTimer: boolean }[], overs: number,
): string[] {
  // greedy: the most likely bowler of each over given what went before, quotas and the no-consecutive rule respected
  const used = new Map<string, number>(), last = new Map<string, number>(), pused = new Map<string, number>();
  const seq: string[] = [];
  let prev: string | null = null;
  for (let o = 0; o < overs; o++) {
    const ph = modelPhase(fmt, o);
    const cands: ChoiceCandidate[] = attack.filter(b => (used.get(b.id) ?? 0) < cap && b.id !== prev).map(b => ({
      id: b.id, rank: b.rank, style: b.style, partTimer: b.partTimer, used: used.get(b.id) ?? 0,
      lastOver: last.has(b.id) ? last.get(b.id)! : null, phaseUsed: pused.get(`${b.id}|${ph}`) ?? 0,
      paceLeft: attack.filter(a => a.rank < 5 && !a.partTimer && ["fast", "medium"].includes(bowlerKind(a.style))).reduce((s, a) => s + Math.max(0, cap - (used.get(a.id) ?? 0)), 0),
      slack: slackBin(attack.filter(a => a.rank < 5 && !a.partTimer).reduce((s, a) => s + Math.max(0, cap - (used.get(a.id) ?? 0)), 0), overs - o),
    }));
    if (cands.length === 0) break;
    const p = choiceProbabilities(fmt, gender, o, cands, cap);
    const best = cands[p.indexOf(Math.max(...p))];
    seq.push(best.id);
    used.set(best.id, (used.get(best.id) ?? 0) + 1);
    last.set(best.id, o);
    pused.set(`${best.id}|${ph}`, (pused.get(`${best.id}|${ph}`) ?? 0) + 1);
    prev = best.id;
  }
  return seq;
}

/** The `slack` bin of an attack: front-line overs left minus overs to bowl (see ChoiceCandidate.slack) */
export function slackBin(frontLineLeft: number, oversToBowl: number): number {
  const s = frontLineLeft - oversToBowl;
  return s <= 0 ? 0 : s <= 2 ? 1 : s <= 5 ? 2 : 3;
}

/** Overs bowled by each bowler in a phase so far (history = bowler of each over so far, index = over) */
export function phaseUsedOf(history: readonly string[], id: string, fmt: ChoiceFormat, over: number): number {
  const ph = modelPhase(fmt, over);
  let n = 0;
  for (let o = 0; o < history.length; o++) if (history[o] === id && modelPhase(fmt, o) === ph) n++;
  return n;
}

/** The over a bowler last bowled in a history (null: none) */
export function lastOverOf(history: readonly string[], id: string): number | null {
  for (let o = history.length - 1; o >= 0; o--) if (history[o] === id) return o;
  return null;
}

/**
 * Rank on bowling rating in an eleven (0 = best): keepers are left out unless they are all-rounders, as the fit ranked them.
 * Ties break by id so the order is stable.
 */
export function rankByBowling(xi: readonly { id: string; rating: number; keeper: boolean; role: string }[]): Map<string, number> {
  const ranked = xi.filter(p => !p.keeper || p.role === "all-rounder").sort((a, b) => b.rating - a.rating || (a.id < b.id ? -1 : 1));
  return new Map(ranked.map((p, i) => [p.id, i]));
}

/** Can the fitted model run this innings (a full-length T20 or ODI innings of the format's own length)? */
export function choiceFormatFor(formatId: string, scheduledOvers: number, fullOvers: number): ChoiceFormat | null {
  if (scheduledOvers !== fullOvers) return null;
  return formatId === "t20" ? "t20" : formatId === "odi" ? "odi" : null;
}
