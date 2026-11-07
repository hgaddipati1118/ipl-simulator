/**
 * Generated players: fictional players sampled from the real joint distribution of the game's ratings.
 *
 * For a stratum (gender x role class: batter, keeper, all-rounder, pace, spin) the eight ratings are drawn as
 * correlated normal scores, shifted by the age and region effects fitted on the real rated players, and mapped back
 * through the stratum's own marginal quantiles (generation-model.ts, fitted by
 * packages/ratings/src/analysis/player-generation.py). Names come from real name pools (names.ts), mixed so no
 * generated player carries a real person's full name. Prospects get a `potential` and a progression path from the
 * fitted progression model (progression.ts).
 *
 * Everything is driven by the RNG passed in, so a seed gives the same players.
 */

import { GENERATION_MODEL, type StratumModel } from "./generation-model.js";
import { FIELDING_GENERATION } from "./fielding-generation-model.js";
import { generateName } from "./names.js";
import { createPlayerFromData, nextPlayerId } from "./create-player.js";
import { Player, type BattingHand, type BowlingStyle, type PlayerRatings, type PlayerRole } from "./player.js";
import { meanPathOvr, estimateExperience, type ProgressionGender } from "./progression.js";
import { clamp } from "./math.js";
import { createRNG, type RNG } from "./rng.js";

export type RoleClass = "batter" | "keeper" | "allround" | "pace" | "spin";
export type GenerationKind = "pool" | "youth" | "regen" | "fill";
export type Region = "india" | "subcontinent" | "anglo" | "westindies" | "tier2" | "other";

export const ROLE_CLASSES: readonly RoleClass[] = ["batter", "keeper", "allround", "pace", "spin"];
const ATTRS: (keyof PlayerRatings)[] = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"];

/** Country mix when none is asked for (approximate share of T20 cricket, as before) */
const COUNTRY_WEIGHTS: [string, number][] = [
  ["India", 40], ["Australia", 8], ["England", 8], ["South Africa", 6], ["New Zealand", 5], ["West Indies", 5],
  ["Pakistan", 4], ["Sri Lanka", 4], ["Bangladesh", 3], ["Afghanistan", 3], ["Zimbabwe", 2], ["Ireland", 1],
  ["Netherlands", 1], ["Scotland", 1], ["Nepal", 1], ["Namibia", 1], ["USA", 1], ["UAE", 1], ["Oman", 1],
];

export function regionOf(country: string): Region {
  return (GENERATION_MODEL.regionOf[country.replace(/\s+Women$/, "").trim()] ?? "other") as Region;
}

export interface GeneratePlayerOptions {
  /** Preset for age and potential: youth academy prospect, regen replacing a retiree, fill-in squad player, or the general pool */
  kind?: GenerationKind;
  gender?: ProgressionGender;
  country?: string;
  roleClass?: RoleClass;
  /** An exact age or an inclusive range */
  age?: number | [number, number];
  /** Accept only players whose overall falls in this inclusive window */
  overall?: [number, number];
  id?: string;
  teamId?: string;
}

const KIND_AGE: Record<GenerationKind, [number, number] | null> = {
  youth: [17, 20], regen: [18, 23], fill: [22, 34], pool: null,
};

// ---------------------------------------------------------------------------------------------------- sampling helpers

function gaussian(rng: RNG): number {
  const u1 = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
}

/** Normal CDF (Abramowitz-Stegun 7.1.26) */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function quantileMap(q: number[], probs: number[], u: number): number {
  if (u <= probs[0]) return q[0] - Math.min(6, (probs[0] - u) * 600);
  const last = probs.length - 1;
  if (u >= probs[last]) return q[last] + Math.min(6, (u - probs[last]) * 600);
  let i = 1;
  while (probs[i] < u) i++;
  return q[i - 1] + (q[i] - q[i - 1]) * ((u - probs[i - 1]) / (probs[i] - probs[i - 1]));
}

function weighted<T>(rng: RNG, items: readonly T[], weights: readonly number[]): T {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function sampleCountry(rng: RNG): string {
  return weighted(rng, COUNTRY_WEIGHTS.map(c => c[0]), COUNTRY_WEIGHTS.map(c => c[1]));
}

/**
 * A generated pool is tilted a little toward bowlers and all-rounders compared with the players on IPL / WPL rosters
 * (batter, keeper, all-rounder, pace, spin): a squad needs five bowling options and a keeper, and the pool stands in
 * for the players who get picked, so thin bowling would leave drafted squads unable to field a valid XI.
 */
const POOL_ROLE_TILT = [0.7, 1.1, 1.6, 1.25, 1.25];

/** Role mix of the players on IPL / WPL rosters (what a squad needs), tilted for pools */
function sampleRoleClass(rng: RNG, gender: ProgressionGender): RoleClass {
  const mix = GENERATION_MODEL.roles.mix[`${gender}/squad`];
  return weighted(rng, GENERATION_MODEL.roles.classes as RoleClass[], mix.map((w, i) => w * POOL_ROLE_TILT[i]));
}

function sampleAge(rng: RNG, gender: ProgressionGender, range: [number, number] | null): number {
  const hist = GENERATION_MODEL.ageHist[gender];
  const min = Math.max(GENERATION_MODEL.ageMin, range ? range[0] : GENERATION_MODEL.ageMin);
  const max = Math.min(GENERATION_MODEL.ageMax, range ? range[1] : GENERATION_MODEL.ageMax);
  const ages: number[] = [];
  const weights: number[] = [];
  for (let a = min; a <= max; a++) {
    ages.push(a);
    // inside a requested window the real age profile is flattened a little so thin ages (17-19) still occur
    weights.push(Math.max(1, hist[a - GENERATION_MODEL.ageMin]) + (range ? 25 : 0));
  }
  return weighted(rng, ages, weights);
}

export function roleOfClass(rc: RoleClass): { role: PlayerRole; isWicketKeeper: boolean } {
  switch (rc) {
    case "keeper": return { role: "wicket-keeper", isWicketKeeper: true };
    case "allround": return { role: "all-rounder", isWicketKeeper: false };
    case "pace": case "spin": return { role: "bowler", isWicketKeeper: false };
    default: return { role: "batsman", isWicketKeeper: false };
  }
}

export function roleClassOfPlayer(p: { role: PlayerRole; isWicketKeeper?: boolean; bowlingStyle?: BowlingStyle }): RoleClass {
  if (p.isWicketKeeper || p.role === "wicket-keeper") return "keeper";
  if (p.role === "all-rounder") return "allround";
  if (p.role === "bowler") return /spin|orthodox|wrist/.test(p.bowlingStyle ?? "") ? "spin" : "pace";
  return "batter";
}

/** The eight ratings for a stratum, region and age (correlated, within the real marginals) */
export function sampleRatings(stratum: StratumModel, region: Region, age: number, rng: RNG): PlayerRatings {
  const m = GENERATION_MODEL;
  const a = (age - 27) / 5;
  const feats = [1, a, a * a, ...m.regions.slice(0, -1).map(r => (r === region ? 1 : 0))];
  const eps = ATTRS.map(() => gaussian(rng));
  const out: Partial<PlayerRatings> = {};
  ATTRS.forEach((attr, j) => {
    let z = 0;
    for (let k = 0; k < feats.length; k++) z += stratum.coef[j][k] * feats[k];
    for (let k = 0; k <= j; k++) z += stratum.chol[j][k] * eps[k];
    const u = Math.min(0.99999, Math.max(0.00001, phi(z)));
    out[attr] = clamp(Math.round(quantileMap(stratum.quantiles[j], m.quantileProbs, u)), 1, 99);
  });
  return out as PlayerRatings;
}

/** Quantile of a stratum's rating at a probability, tails extended a little beyond the last node as for the other ratings */
function ratingAtProb(q: number[], u: number): number {
  return quantileMap(q, FIELDING_GENERATION.quantileProbs, u);
}

/**
 * Fielding for every generated player, keeping for keepers: drawn from the real distribution of the role class
 * (fielding-generation-model.ts). Fielding follows batting and bowling quality a little (good players field better, r = 0.3);
 * keeping is a separate draw. Non-keepers get no keeping rating (the engine treats them as 25), as in the real data.
 * Three RNG draws for a keeper, two otherwise.
 */
export function sampleFieldingRatings(
  rc: RoleClass, gender: ProgressionGender, battingOvr: number, bowlingOvr: number, rng: RNG,
): { fielding: number; keeping?: number } {
  const F = FIELDING_GENERATION;
  const stratum = F.strata[`${gender}/${rc}`] ?? F.strata[`male/${rc}`] ?? F.strata["male/batter"];
  const z = (F.coefBat * (battingOvr - stratum.meanBat) / 20 + F.coefBowl * (bowlingOvr - stratum.meanBowl) / 20 + F.residSd * gaussian(rng)) / F.totalSd;
  const fielding = clamp(Math.round(ratingAtProb(stratum.fielding, Math.min(0.99999, Math.max(0.00001, phi(z))))), 5, 99);
  if (rc !== "keeper") return { fielding };
  const keeperQ = stratum.keeping ?? F.strata["male/keeper"].keeping!;
  const keeping = clamp(Math.round(ratingAtProb(keeperQ, Math.min(0.99999, Math.max(0.00001, phi(gaussian(rng)))))), 5, 99);
  return { fielding, keeping };
}

function sampleStyle(rng: RNG, gender: ProgressionGender, rc: RoleClass): { style: BowlingStyle; hand: BattingHand } {
  const s = GENERATION_MODEL.styles[`${gender}/${rc}`];
  return {
    style: weighted(rng, s.styles as BowlingStyle[], s.weights),
    hand: rng() < s.left ? "left" : "right",
  };
}

/** Spread of the mature rating a prospect's talent adds on top of the usual luck (points) */
export const TALENT_SD = 3.5;

// ---------------------------------------------------------------------------------------------------- the generator

/** A 32-bit seed from what makes this generated player who he is */
function playerSeed(p: Player): number {
  let h = 2166136261;
  const text = `${p.name}|${p.age}|${Object.values(p.ratings).join(",")}`;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Generate one player. Deterministic for a given rng state. */
export function generatePlayer(rng: RNG, opts: GeneratePlayerOptions = {}): Player {
  const kind = opts.kind ?? "pool";
  const gender = opts.gender ?? "male";
  const country = opts.country ?? sampleCountry(rng);
  const region = regionOf(country);
  const rc = opts.roleClass ?? sampleRoleClass(rng, gender);
  const stratum = GENERATION_MODEL.strata[`${gender}/${rc}`] ?? GENERATION_MODEL.strata[`${gender}/batter`];
  const range: [number, number] | null = typeof opts.age === "number" ? [opts.age, opts.age]
    : Array.isArray(opts.age) ? opts.age : KIND_AGE[kind];
  const age = sampleAge(rng, gender, range);

  const { role, isWicketKeeper } = roleOfClass(rc);
  const name = generateName(rng, country, gender);
  const { style, hand } = sampleStyle(rng, gender, rc);
  // Draw until the player keeps the asked-for role once the game's role inference and secondary-rating balancing
  // have run (an all-rounder draw whose batting or bowling falls short would be re-labelled) and falls in the
  // asked-for overall window
  let player: Player | null = null;
  let bestMiss = Infinity;
  let best: Player | null = null;
  for (let tries = 0; tries < 80; tries++) {
    const ratings = sampleRatings(stratum, region, age, rng);
    player = createPlayerFromData({
      name, age, country, role, isWicketKeeper, bowlingStyle: style, battingHand: hand, ...ratings, teamId: opts.teamId,
    });
    const roleOk = roleClassOfPlayer(player) === rc;
    const miss = opts.overall ? Math.max(0, opts.overall[0] - player.overall, player.overall - opts.overall[1]) : 0;
    if (roleOk || tries >= 12) {
      if (miss === 0) { best = player; break; }
      // a window the role cannot reach (an elite pace bowler with overall 45): keep the closest draw
      if (miss < bestMiss) { bestMiss = miss; best = player; }
    }
  }
  player = best ?? player;
  if (!player) throw new Error("player generation failed");
  player.id = opts.id ?? nextPlayerId();
  if (gender === "female") player.isFemale = true;
  player.experience = kind === "fill" || kind === "pool" ? estimateExperience(age, 0) : 1;
  // Fielding / keeping come from a stream of their own, seeded from the player just drawn, so that adding them left every
  // other draw of a seeded generation exactly as it was (same players, same later draws)
  Object.assign(player.ratings, sampleFieldingRatings(rc, gender, player.battingOvr, player.bowlingOvr, createRNG(playerSeed(player))));

  if (kind === "youth" || kind === "regen" || (kind === "pool" && age <= 23)) assignPotential(player, gender, rng);
  return player;
}

/** Draw a talent and turn it into `potential` (the mature rating promised) and the points still to realise */
export function assignPotential(player: Player, gender: ProgressionGender, rng: RNG): void {
  const state = player.getProgressionState(gender);
  const main = player.battingOvr >= player.bowlingOvr ? "bat" : "bowl";
  const expected = meanPathOvr(main, state, 27);
  const talent = TALENT_SD * gaussian(rng);
  player.potential = clamp(Math.round(expected + talent), 30, 99);
  player.talentLeft = talent;
}

/** Generate `count` players; ids are `${idPrefix}_${n}` when a prefix is given, so a seed reproduces them exactly */
export function generatePlayers(count: number, rng: RNG, opts: GeneratePlayerOptions = {}, idPrefix?: string): Player[] {
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    out.push(generatePlayer(rng, { ...opts, id: idPrefix ? `${idPrefix}_${i + 1}` : undefined }));
  }
  return out;
}
