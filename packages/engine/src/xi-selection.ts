/**
 * How real men's T20 franchises compose an XI (docs/TACTICS.md section 7, "League XIs"), fitted on the XIs they fielded since 2021
 * (packages/ratings/src/analysis/league-xi.py on docs/data/league_xi.json).
 *
 * The value of an XI is rank-weighted: U = sum_k bat[k] * (k-th best batting overall) + sum_j bowl[j] * (j-th best bowling overall)
 * + fielding * (sum of the eleven's fieldingValueBonus) + keeping * (the best designated keeper's keeping bonus), every rating / 100 and
 * fatigue-adjusted (effectiveBattingOvr / effectiveBowlingOvr). Fitted by conditional logit: each real XI against every legal XI one swap
 * away from the players available that day, matches to the end of 2024 (judged on 2025+). A franchise's XI is a draw from
 * P(XI) proportional to exp(U) over the legal XIs (overseas limit, a designated keeper when the squad has one): the real XIs' spread
 * (rotation, the occasional extra bowler or batter) is part of the fit, and the most likely XI alone bats deeper than real sides do.
 *
 * CPU sides in a men's T20 league draw their XI per match (seeded by the match: the same XI instant and live); the user's auto-pick is
 * the most likely XI. Internationals, ODIs, The Hundred and women's leagues keep Team's best-XI selection (not fitted here).
 */
import type { Player } from "./player.js";
import type { RuleSet } from "./rules.js";
import { fieldingValueBonus } from "./fielding.js";

/** Fitted XI value (league-xi.py, fit to 2024-12-31): batting ranks 1-11, bowling ranks 1-7, fielding and keeping (per 100 points) */
export const LEAGUE_XI_VALUE = {
  bat: [4.795, 4.435, 4.274, 4.39, 4.289, 4.123, 2.645, 0.894, 0.124, 0.107, 0.798],
  bowl: [6.392, 5.683, 4.503, 3.031, 1.736, 0.5, -0.107],
  fielding: 4.194,
  keeping: 1.559,
};

/** Metropolis steps of a drawn XI, from the most likely one (each a proposed swap) */
const DRAW_STEPS = 400;

/** Benchmarks: `off` plays every side with Team's former best-XI selection (the engine as it was) */
export const LEAGUE_XI_SWITCH = { off: false };

/** The fitted league selection applies: a men's T20 franchise league (not an international, The Hundred, an ODI or a women's league) */
export function leagueXiApplies(rules: Pick<RuleSet, "matchFormat" | "gender" | "league" | "maxOverseasInXI" | "scoringContext">): boolean {
  return !LEAGUE_XI_SWITCH.off && (rules.matchFormat ?? "t20") === "t20" && rules.league !== "wpl" && (rules.gender ?? "men") === "men" && !rules.scoringContext && rules.maxOverseasInXI < 11;
}

interface Row { p: Player; bat: number; bowl: number; fb: number; kb: number; os: boolean; wk: boolean }

function rowOf(p: Player): Row {
  const fb = fieldingValueBonus({ fielding: p.ratings.fielding });
  const kb = p.isWicketKeeper ? fieldingValueBonus({ fielding: p.ratings.fielding, keeping: p.ratings.keeping, isWicketKeeper: true }) - fb : 0;
  return { p, bat: p.effectiveBattingOvr / 100, bowl: p.effectiveBowlingOvr / 100, fb: fb / 100, kb: kb / 100, os: p.isInternational, wk: !!p.isWicketKeeper };
}

function value(xi: readonly Row[]): number {
  const w = LEAGUE_XI_VALUE;
  const bat = xi.map(r => r.bat).sort((a, b) => b - a);
  const bowl = xi.map(r => r.bowl).sort((a, b) => b - a);
  let u = 0, fb = 0, kb = 0;
  for (let k = 0; k < bat.length && k < w.bat.length; k++) u += w.bat[k] * bat[k];
  for (let j = 0; j < bowl.length && j < w.bowl.length; j++) u += w.bowl[j] * bowl[j];
  for (const r of xi) { fb += r.fb; if (r.wk && r.kb > kb) kb = r.kb; }
  return u + w.fielding * fb + w.keeping * kb;
}

const legal = (xi: readonly Row[], cap: number, needWk: boolean) =>
  xi.filter(r => r.os).length <= cap && (!needWk || xi.some(r => r.wk));

/** The most likely XI: the best eleven by overall within the overseas limit (a keeper swapped in), then the best single swap until none helps */
function bestRows(rows: Row[], cap: number): { xi: Row[]; needWk: boolean } {
  const ps = [...rows].sort((a, b) => b.p.overall - a.p.overall);
  let cur: Row[] = [];
  for (const r of ps) if (cur.length < 11 && cur.filter(x => x.os).length + (r.os ? 1 : 0) <= cap) cur.push(r);
  if (!cur.some(r => r.wk)) {
    const wk = ps.find(r => r.wk && !cur.includes(r));
    if (wk) {
      for (let k = cur.length - 1; k >= 0; k--) {
        const alt = [...cur]; alt[k] = wk;
        if (legal(alt, cap, false)) { cur = alt; break; }
      }
    }
  }
  const needWk = cur.some(r => r.wk);
  if (cur.length < 11) return { xi: cur, needWk };
  let val = value(cur);
  for (let guard = 0; guard < 60; guard++) {
    let best: { v: number; xi: Row[] } | null = null;
    for (let k = 0; k < 11; k++) {
      for (const b of ps) {
        if (cur.includes(b)) continue;
        const alt = [...cur]; alt[k] = b;
        if (!legal(alt, cap, needWk)) continue;
        const v = value(alt);
        if (v > val + 1e-12 && (!best || v > best.v)) best = { v, xi: alt };
      }
    }
    if (!best) break;
    val = best.v; cur = best.xi;
  }
  return { xi: cur, needWk };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A league XI from `available` (the squad's fit players) within `maxOverseas`: the most likely XI, or, with a `seed`, a draw from the
 * fitted distribution (Metropolis over single swaps from the most likely XI; deterministic for a seed). Fewer than eleven available:
 * all of them (Team then fills nothing; the engine plays the side short as before).
 */
export function selectLeagueXI(available: readonly Player[], maxOverseas: number, seed?: number): Player[] {
  const rows = available.map(rowOf);
  const { xi, needWk } = bestRows(rows, maxOverseas);
  if (seed === undefined || xi.length < 11 || rows.length <= 11) return xi.map(r => r.p);
  const rng = mulberry(seed);
  let cur = xi, val = value(cur);
  for (let s = 0; s < DRAW_STEPS; s++) {
    const k = Math.floor(rng() * 11);
    const b = rows[Math.floor(rng() * rows.length)];
    if (cur.includes(b)) continue;
    const alt = [...cur]; alt[k] = b;
    if (!legal(alt, maxOverseas, needWk)) continue;
    const v = value(alt);
    if (v >= val || rng() < Math.exp(v - val)) { cur = alt; val = v; }
  }
  return cur.map(r => r.p);
}

/** Options of Team.getPlayingXI / autoSelectPlayingXI: the fitted league selection (`league`), drawn per match with `seed` */
export interface XiOptions { league?: boolean; seed?: number }

/** The XI options of a side in a match: the league selection where it applies, the draw seeded by the match and the side (0 home, 1 away) */
export function matchXiOptions(rules: Parameters<typeof leagueXiApplies>[0], matchSeed: number, side: 0 | 1): XiOptions {
  return leagueXiApplies(rules) ? { league: true, seed: (Math.imul(matchSeed >>> 0, 2654435761) + side * 97 + 1) >>> 0 } : {};
}
