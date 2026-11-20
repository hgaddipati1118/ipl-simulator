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
import { BOWLING_ATTACK } from "./bowling-attack-data.js";
import { isBowlerWicket, type DismissalKind } from "./dismissal-kinds.js";
import { isFastBowler, isPaceBowler, isSpinBowler, type BowlingStyle } from "./matchups.js";
import type { RNG } from "./rng.js";
import type { RuleSet } from "./rules.js";
import { genderOf } from "./delivery-rules.js";

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
  /** The match state, read by the attack table (section 8) only */
  attack?: AttackState;
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

/**
 * The model's probability of each candidate bowling the over (softmax of the fitted utilities). With `table` (attackTableFor), the attack
 * table's weights over the whole eleven, its attack features added (candidates carry `attack`)
 */
export function choiceProbabilities(fmt: ChoiceFormat, gender: Gender, over: number, cands: readonly ChoiceCandidate[], cap: number, table?: string | null): number[] {
  const w = table ? BOWLING_ATTACK[table] : BOWLING_CHOICE[`${fmt}-${gender}`];
  const u = cands.map(c => {
    let s = choiceFeatures(fmt, over, c, cap).reduce((t, [name, v]) => t + (w[name] ?? 0) * v, 0);
    if (table && c.attack) for (const name of attackFeatures(over, c, c.attack)) s += w[name] ?? 0;
    return s;
  });
  const mx = Math.max(...u);
  const e = u.map(x => Math.exp(x - mx));
  const t = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / t);
}

/** Draw one candidate by the model (index into `cands`) */
export function chooseByModel(fmt: ChoiceFormat, gender: Gender, over: number, cands: readonly ChoiceCandidate[], cap: number, rng: RNG, table?: string | null): number {
  if (cands.length <= 1) return 0;
  const p = choiceProbabilities(fmt, gender, over, cands, cap, table);
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
export function captainModelFor(odi: boolean, womenT20I = false): boolean {
  if (odi) return false;
  return !(womenT20I && !CAPTAIN_MODEL.womenT20I);
}

/** A women's T20I (the rules that choose its scoring context and level) */
export function isWomenT20I(rules: Pick<RuleSet, "league" | "gender" | "scoringContext"> | undefined): boolean {
  return !!rules && rules.scoringContext === "t20i" && genderOf(rules) === "female";
}

/** Where the captain's model plays (benchmarks switch it: docs/TACTICS.md section 2, women's T20I) */
export const CAPTAIN_MODEL = { womenT20I: true };

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

// ── The attack (docs/TACTICS.md section 8): the choice over the whole eleven, so the model also decides who joins the attack ──

/**
 * Where the attack table plays (a men's full-length T20 innings of a CPU side, or of a user side that has not set its own bowling order):
 * `league` the men's T20 leagues but those in `except`, `t20i` the men's T20I. Benchmarks switch it. Not the men's T20I (its actual-XI
 * benchmark was no better with it: docs/TACTICS.md section 8) and not the IPL, whose impact player joins the attack mid-innings at best where
 * real sides bring him on at the break: on the engine's thinner IPL elevens the table used seven bowlers in 39% of innings against a real 15%.
 */
export const ATTACK_MODEL = { league: true, t20i: false, except: ["ipl"] as string[] };

/** The attack table of a men's T20 innings (null: the section-1 model over the side's bowling order, as before) */
export function attackTableFor(gender: Gender, t20i: boolean, league?: string): string | null {
  if (gender !== "male") return null;
  if (t20i) return ATTACK_MODEL.t20i ? "t20-male-t20i" : null;
  if (league && ATTACK_MODEL.except.includes(league)) return null;
  return ATTACK_MODEL.league ? "t20-male-league" : null;
}

/** May this player of the eleven be chosen by the attack table (the players the rank covers: keepers apart, unless all-rounders)? */
export function inAttackPool(p: { isWicketKeeper?: boolean; role: string }): boolean {
  return !p.isWicketKeeper || p.role === "all-rounder";
}

/** The match state the attack table reads for a candidate (bowling-attack.py `attack_features`) */
export interface AttackState {
  /** His bowling rating (effective) */
  ovr: number;
  /** Wickets the bowling side's bowlers have taken this innings (credited to a bowler: not run outs or retirements) */
  wkts: number;
  /** 1 bowling first, 2 in the chase */
  inn: 1 | 2;
  /** The batting side's runs per over so far (all runs, extras included) */
  rr: number;
  /** Bowlers used so far this innings */
  nused: number;
  /** Runs off his last over (all runs of it) */
  lastRuns: number;
  /** Runs off his overs so far */
  runs: number;
  /** His wickets so far */
  wk: number;
}

function binOf(x: number, edges: readonly number[]): number {
  for (let k = 0; k < edges.length; k++) if (x < edges[k]) return k;
  return edges.length;
}

/** The attack table's extra features of a candidate (names as in bowling-attack.py `attack_features`; a T20 innings) */
export function attackFeatures(over: number, c: ChoiceCandidate, a: AttackState): string[] {
  const ph = modelPhase("t20", over);
  const extra = c.rank >= 5 || c.partTimer;
  const f: string[] = [];
  if (c.rank >= 6) f.push(`rank${Math.min(c.rank, 8)}`);
  if (extra) {
    f.push(`xlvl${binOf(a.ovr, [30, 40, 50, 60])}`);
    f.push(`xwd${binOf(a.wkts, [2, 4, 6])}`);
    if (a.inn === 2) f.push("x2nd");
    if (over >= 3) f.push(`xrr${binOf(a.rr, [7, 8.5, 10])}`);
  }
  if (c.lastOver === null) f.push(`newk${Math.min(Math.max(a.nused + 1, 5), 8)}@${ph}`);
  else {
    f.push(`last${binOf(a.lastRuns, [7, 11, 15])}`);
    f.push(`econ${binOf(a.runs / Math.max(1, c.used), [7, 9, 11])}`);
    if (a.wk > 0) f.push(`wk${Math.min(a.wk, 2)}`);
  }
  return f;
}

/** What the attack table needs of the innings so far, from its ball log (the over of each ball, its bowler, runs and extras, wicket) */
export interface AttackTally { overRuns: number[]; runs: number; wkts: number; bowlerRuns: Map<string, number>; bowlerWk: Map<string, number> }

export function attackTally(
  log: readonly { over: number; bowler: string; runs: number; extras: number; isWicket: boolean; wicketType?: DismissalKind }[],
  history: readonly string[],
): AttackTally {
  const overRuns: number[] = [];
  const bowlerWk = new Map<string, number>();
  let runs = 0, wkts = 0;
  for (const b of log) {
    const r = b.runs + b.extras;
    overRuns[b.over] = (overRuns[b.over] ?? 0) + r;
    runs += r;
    // a wicket counts for the over's bowler (the first ball's: the record's convention), credited kinds only
    if (b.isWicket && (b.wicketType === undefined || isBowlerWicket(b.wicketType))) {
      wkts++;
      const who = history[b.over] ?? b.bowler;
      bowlerWk.set(who, (bowlerWk.get(who) ?? 0) + 1);
    }
  }
  const bowlerRuns = new Map<string, number>();
  history.forEach((id, o) => { if (id) bowlerRuns.set(id, (bowlerRuns.get(id) ?? 0) + (overRuns[o] ?? 0)); });
  return { overRuns, runs, wkts, bowlerRuns, bowlerWk };
}

/** A candidate's attack state at the start of `over` (history: the bowler of each over so far) */
export function attackStateOf(t: AttackTally, history: readonly string[], id: string, ovr: number, inn: 1 | 2, over: number): AttackState {
  const last = lastOverOf(history, id);
  return {
    ovr, wkts: t.wkts, inn, rr: t.runs / Math.max(1, over), nused: new Set(history.filter(Boolean)).size,
    lastRuns: last === null ? 0 : t.overRuns[last] ?? 0, runs: t.bowlerRuns.get(id) ?? 0, wk: t.bowlerWk.get(id) ?? 0,
  };
}

/** The fitted attack tables (bowling-attack-data.ts), for tests and tools */
export const BOWLING_ATTACK_TABLE = BOWLING_ATTACK;
