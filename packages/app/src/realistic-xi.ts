/**
 * Realistic line-ups for national sides in simulated (watched / benchmark) series: instead of always fielding the best-rated
 * eleven, each match's XI is sampled from the side's pool of recent players with the real selection rates of
 * intl-availability-data.ts (the share of the side's matches a player played since 2024, from Cricsheet). Availability changes
 * who plays, never a player's ratings. The user's own side keeps his picked (or the engine's best) XI.
 *
 * Sampling: the rates are scaled to sum to eleven (a player at 1 always plays; the others rescaled), then randomised systematic
 * sampling (every player's inclusion probability equals his scaled rate, always exactly eleven), then a repair: at least one
 * keeper and five bowling options (bowling overall 60+; four in a Test), swapping the most-used missing player in for the
 * least-used surplus one. Deterministic for a seed.
 */
import { calculateBattingOverall, calculateBowlingOverall, type Player } from "@ipl-sim/engine";

export type Rates = Readonly<Record<string, number>>;

/**
 * How closely a sampled XI follows the real selection rates, per set ("t20i-men", ...): a player's weight is rate ^ sharpen, so 1
 * reproduces the real rates (every fringe player plays as often as he did) and larger values favour the regulars (infinity: the most
 * frequent XI). Fitted on the real fixtures (docs/COUNTRY-VALIDATION.md, "Realistic line-ups"); a set without an entry is not realistic.
 */
export const XI_SHARPEN: Record<string, number> = {
  // men's T20I only: fitted on the fixtures up to 2024 (rates from 2024 matches), better than the best XI on the 2025+ holdout too
  // (log loss 0.623 -> 0.611; countries OFF 23 -> 19). Women's T20I, ODI and Test did not improve out of sample: not realistic.
  "t20i-men": 3,
};

/** Whether a format-gender set ("t20i-men") has realistic line-ups */
export const realisticAvailable = (format: string, gender: string): boolean => `${format}-${gender}` in XI_SHARPEN;

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

const idOf = (p: Player) => p.sourceId ?? p.id;
/** A real bowling option: bowling overall on the format's ratings at least this (part-timers and "all-rounders" who do not bowl are below it) */
const BOWLS_FROM = 60;
const isBowl = (p: Player) => calculateBowlingOverall(p.ratings) >= BOWLS_FROM;
/** Role stratum of a player: keeper, batter, all-rounder, bowler (a sampled XI keeps the side's usual mix of them) */
const stratum = (p: Player) => (isBowl(p) ? (calculateBattingOverall(p.ratings) >= 65 ? 2 : 3) : p.isWicketKeeper ? 0 : 1);

/** Inclusion probabilities summing to `k`, none above 1, in proportion to `w` */
function scale(w: number[], k: number): number[] {
  const pi = new Array<number>(w.length).fill(0);
  const fixed = new Array<boolean>(w.length).fill(false);
  for (let it = 0; it < w.length; it++) {
    const free = w.map((_, i) => i).filter(i => !fixed[i]);
    const need = k - fixed.filter(Boolean).length;
    const total = free.reduce((s, i) => s + w[i], 0);
    if (total <= 0 || need <= 0) break;
    let capped = false;
    for (const i of free) { pi[i] = (w[i] / total) * need; if (pi[i] > 1) { pi[i] = 1; fixed[i] = true; capped = true; } }
    if (!capped) break;
  }
  return pi.map((x, i) => (fixed[i] ? 1 : x));
}

/** One match's XI from `pool` (players with a rate); `seed` makes it repeatable. Pools of eleven or fewer play as they are. */
export function sampleXI(pool: readonly Player[], rates: Rates, seed: number, minBowlers = 5, sharpen = 1): Player[] {
  if (pool.length <= 11) return [...pool];
  const rng = mulberry(seed);
  // ordered by stratum, random within one: the systematic sample then takes each stratum's usual number of players (+-1)
  const order = [...pool].map(p => ({ p, r: rng() })).sort((a, b) => stratum(a.p) - stratum(b.p) || a.r - b.r).map(x => x.p);
  const w = order.map(p => Math.max(0.01, rates[idOf(p)] ?? 0.01) ** sharpen);
  const pi = scale(w, 11);
  const u = rng();
  const chosen: Player[] = [];
  let cum = 0, next = u;
  order.forEach((p, i) => {
    cum += pi[i];
    while (next < cum - 1e-12 && chosen.length < 11) { chosen.push(p); next += 1; }
  });
  // a rounding shortfall: the most-used unchosen players
  const rest = () => order.filter(p => !chosen.includes(p)).sort((a, b) => (rates[idOf(b)] ?? 0) - (rates[idOf(a)] ?? 0));
  while (chosen.length < 11) chosen.push(rest()[0]);
  const use = (p: Player) => rates[idOf(p)] ?? 0;
  const swapIn = (need: (p: Player) => boolean, keep: (p: Player) => boolean) => {
    const add = rest().find(need);
    if (!add) return;
    const out = [...chosen].filter(p => !keep(p) && !need(p)).sort((a, b) => use(a) - use(b))[0];
    if (out) chosen[chosen.indexOf(out)] = add;
  };
  if (!chosen.some(p => p.isWicketKeeper)) swapIn(p => !!p.isWicketKeeper, p => isBowl(p) && chosen.filter(isBowl).length <= minBowlers);
  for (let guard = 0; chosen.filter(isBowl).length < minBowlers && guard < 6; guard++) swapIn(isBowl, p => !!p.isWicketKeeper);
  return chosen;
}

/** A match-and-side seed that does not repeat across a series */
export const xiSeed = (matchSeed: number, side: number): number => (matchSeed * 2 + side + 1) >>> 0;
