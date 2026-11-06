/**
 * Measured venue conditions for the T20 engine.
 *
 * Source: packages/ratings venue analysis (docs/VENUE-CONDITIONS-REPORT.md), trimmed into
 * venue-data.ts by packages/ratings/src/analysis/export-engine-venues.py.
 *
 * How the measurements are used:
 * - runFactor and sixFactor are applied in full (ground effects predict match totals out of sample).
 * - wicketFactor is shrunk 75% toward neutral: ground effects did not predict wickets out of sample.
 * - per-bowler-type edges (already shrunk by sample size) adjust that type's wicket and scoring rates.
 * - chase advantage comes from the competition baseline (IPL 2024-26 +5.6%) plus half the ground's
 *   deviation from its league; it drives the CPU toss call and a small second-innings boost.
 * - Each league's grounds are normalised to that league's mean, so the overall scoring level stays
 *   where the engine is calibrated (rules.scoringMultiplier); grounds only move scoring relative to
 *   each other.
 */

import type { BowlingStyle, PitchType, BoundarySize, DewFactor } from "./matchups.js";
import { VENUE_DATA } from "./venue-data.js";

export interface VenueTypeEdge {
  /** Wickets per 100 balls vs the same bowlers elsewhere */
  wkts: number | null;
  /** Economy (runs per over) vs the same bowlers elsewhere */
  econ: number | null;
}

export interface VenueGroundRecord {
  name: string;
  country: string | null;
  matches: number;
  runFactor: number;
  sixFactor: number;
  wicketFactor: number;
  chaseAdvantage: number | null;
  edges: Partial<Record<VenueEdgeKey, VenueTypeEdge>>;
  source: string;
}

export interface VenueDataFile {
  teams: Record<string, VenueGroundRecord>;
  countries: Record<string, { runFactor: number; sixFactor: number; wicketFactor: number; matches: number }>;
  chase: { ipl: number; wpl: number; male: number; female: number };
  tossValueWin: number;
  fieldShare2024_26: number;
  generated?: string;
}

export type VenueEdgeKey =
  | "RA fast" | "RA fast-medium" | "RA medium" | "LA pace"
  | "off-spin" | "wrist-spin" | "LA orthodox";

/** Engine-ready conditions for one match at one ground. */
export interface VenueProfile {
  groundName: string;
  /** Runs multiplier relative to the league's average ground (1.0 = average) */
  runMult: number;
  /** Sixes multiplier relative to the league's average ground */
  sixMult: number;
  /** Wickets multiplier, shrunk toward 1.0 */
  wicketMult: number;
  edges: Partial<Record<VenueEdgeKey, VenueTypeEdge>>;
  /** P(chasing side wins) - 0.5 for equal teams at this ground */
  chaseAdvantage: number;
  source: string;
}

/**
 * The engine's scoring calibration (IPL 2025 targets) was tuned with the old hand-set grounds,
 * which on average were batting-friendly (mean stadiumBowlingRating 0.94, mostly "flat"/"small").
 * Measured grounds are normalised to their league's mean, so these constants keep the calibrated
 * league-wide scoring level: same first-innings average and wickets as before (benchmark-season.ts).
 */
export const LEAGUE_LEVEL_RUN = 1.04;
export const LEAGUE_LEVEL_WICKET = 1.0;

/** Ground effects on wickets did not hold up out of sample, so keep only a quarter of them. */
export const WICKET_FACTOR_WEIGHT = 0.25;
/** Weight on a ground's own chase record relative to its league's baseline. */
export const GROUND_CHASE_WEIGHT = 0.5;
/** Average T20 wickets per 100 legal balls (IPL ~12.5 per 240 balls), to turn edges into multipliers */
const BASE_WICKETS_PER_100 = 5.2;
/** Average T20 economy (runs per over), to turn economy edges into multipliers */
const BASE_ECONOMY = 8.6;

const IPL_IDS = ["srh", "dc", "rcb", "kkr", "rr", "csk", "mi", "pbks", "gt", "lsg"];
const WPL_IDS = ["mi-w", "dc-w", "rcb-w", "gg-w", "upw"];

function leagueOf(teamId: string): "ipl" | "wpl" | null {
  if (IPL_IDS.includes(teamId)) return "ipl";
  if (WPL_IDS.includes(teamId)) return "wpl";
  return null;
}

function geoMean(values: number[]): number {
  return Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length);
}

const leagueNorm: Record<"ipl" | "wpl", { run: number; six: number; wkt: number; chase: number }> = {
  ipl: computeNorm(IPL_IDS),
  wpl: computeNorm(WPL_IDS),
};

function computeNorm(ids: string[]) {
  const recs = ids.map(id => VENUE_DATA.teams[id]).filter(Boolean);
  const chases = recs.map(r => r.chaseAdvantage).filter((c): c is number => c !== null);
  return {
    run: geoMean(recs.map(r => r.runFactor / 100)),
    six: geoMean(recs.map(r => r.sixFactor / 100)),
    wkt: geoMean(recs.map(r => r.wicketFactor / 100)),
    chase: chases.length ? chases.reduce((s, c) => s + c, 0) / chases.length : 0,
  };
}

/** Measured conditions for a team's home ground, or null when the team has no mapped ground. */
export function getVenueProfileForTeam(teamId: string): VenueProfile | null {
  const rec = VENUE_DATA.teams[teamId];
  const league = leagueOf(teamId);
  if (!rec || !league) return null;
  const norm = leagueNorm[league];
  const base = league === "ipl" ? VENUE_DATA.chase.ipl : VENUE_DATA.chase.wpl;
  const ground = rec.chaseAdvantage ?? norm.chase;
  const wkt = rec.wicketFactor / 100 / norm.wkt;
  return {
    groundName: rec.name,
    runMult: LEAGUE_LEVEL_RUN * rec.runFactor / 100 / norm.run,
    sixMult: rec.sixFactor / 100 / norm.six,
    wicketMult: LEAGUE_LEVEL_WICKET * (1 + (wkt - 1) * WICKET_FACTOR_WEIGHT),
    edges: rec.edges ?? {},
    chaseAdvantage: base + GROUND_CHASE_WEIGHT * (ground - norm.chase),
    source: rec.source,
  };
}

/** Chase advantage for a neutral venue in a league (playoffs) or an unmapped team. */
export function getLeagueChaseAdvantage(league: string | undefined, gender: "men" | "women" | "combined" | undefined): number {
  if (league === "ipl") return VENUE_DATA.chase.ipl;
  if (league === "wpl") return VENUE_DATA.chase.wpl;
  return gender === "women" ? VENUE_DATA.chase.female : VENUE_DATA.chase.male;
}

/** Map an engine bowling style to the venue analysis's bowler-type groups. */
export function venueEdgeKey(style: BowlingStyle | undefined): VenueEdgeKey | null {
  switch (style) {
    case "right-arm-fast": return "RA fast";
    case "right-arm-fast-medium":
    case "right-arm-medium-fast": return "RA fast-medium";
    case "right-arm-medium": return "RA medium";
    case "left-arm-fast":
    case "left-arm-fast-medium":
    case "left-arm-medium-fast":
    case "left-arm-medium": return "LA pace";
    case "off-spin": return "off-spin";
    case "leg-spin":
    case "left-arm-wrist-spin": return "wrist-spin";
    case "left-arm-orthodox": return "LA orthodox";
    default: return null;
  }
}

/** Wicket / scoring multipliers for one bowler type at a ground. */
export function getVenueTypeModifier(profile: VenueProfile, style: BowlingStyle | undefined): { wicketMod: number; runMod: number } {
  const key = venueEdgeKey(style);
  const edge = key ? profile.edges[key] : undefined;
  if (!edge) return { wicketMod: 1, runMod: 1 };
  const wicketMod = 1 + (edge.wkts ?? 0) / BASE_WICKETS_PER_100;
  const runMod = 1 + (edge.econ ?? 0) / BASE_ECONOMY;
  return { wicketMod: clamp(wicketMod, 0.85, 1.15), runMod: clamp(runMod, 0.9, 1.1) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Categorical labels (UI, lineup advice, live-mode extras) derived from the measurements ──

/** Bowling-rating scale used by the stadium editor: >1 = bowler-friendly. 1 run-% ~ 0.02. */
export function deriveStadiumBowlingRating(profile: VenueProfile): number {
  // Label the ground relative to its league (exclude the engine's calibration level)
  const relative = profile.runMult / LEAGUE_LEVEL_RUN;
  return Math.round((1 + (1 - relative) * 2) * 100) / 100;
}

export function derivePitchType(profile: VenueProfile): PitchType {
  const value = (k: VenueEdgeKey) => {
    const e = profile.edges[k];
    if (!e) return 0;
    // bowler value per 100 balls: a wicket is worth ~8 runs in T20, economy is runs per over
    return (e.wkts ?? 0) * 8 - (e.econ ?? 0) * 100 / 6;
  };
  const spin = (value("off-spin") + value("wrist-spin") + value("LA orthodox")) / 3;
  const pace = (value("RA fast") + value("RA fast-medium") + value("RA medium") + value("LA pace")) / 4;
  if (spin - pace > 1.5) return "turning";
  if (pace - spin > 1.5) return "seaming";
  if (profile.runMult / LEAGUE_LEVEL_RUN >= 1.02) return "flat";
  return "balanced";
}

export function deriveBoundarySize(profile: VenueProfile): BoundarySize {
  if (profile.sixMult >= 1.03) return "small";
  if (profile.sixMult <= 0.95) return "large";
  return "medium";
}

export function deriveDewFactor(profile: VenueProfile): DewFactor {
  if (profile.chaseAdvantage >= 0.075) return "heavy";
  if (profile.chaseAdvantage >= 0.045) return "moderate";
  return "none";
}

// ── Ball-outcome adjustments shared by match.ts and live-match.ts ──

/**
 * Gain on the measured run factor. A ground's runFactor is "runs vs the average ground"; scaling
 * the scoring outcomes by exactly that undershoots, because the outcome mix is renormalised and the
 * chase logic reacts. Calibrated with benchmark-season.ts so simulated first-innings totals move
 * one-for-one with the measured factor (regression slope ~1).
 */
export const VENUE_RUN_GAIN = 1.6;
/** Share of T20 runs that come from sixes (IPL 2024-26 ~27%) */
const SIX_RUN_SHARE = 0.27;
/**
 * Second-innings boost per point of chase advantage, and the chase edge the engine already
 * produces by itself (target pressure, ball change). Calibrated so equal sides win chases at
 * 0.5 + chaseAdvantage.
 */
export const CHASE_GAIN = 0.78;
export const ENGINE_INTRINSIC_CHASE = -0.033;

type Probs = Record<string, number>;

/** Apply a measured ground's run, six, wicket and bowler-type effects to one ball's outcome weights. */
export function applyVenueProfile(probs: Probs, profile: VenueProfile, bowlingStyle: BowlingStyle | undefined): void {
  const run = Math.pow(profile.runMult, VENUE_RUN_GAIN);
  const six = Math.pow(profile.sixMult, VENUE_RUN_GAIN);
  // Non-six scoring absorbs the rest of the run factor so total runs track runMult
  const other = clamp((run - SIX_RUN_SHARE * six) / (1 - SIX_RUN_SHARE), 0.8, 1.25);
  const type = getVenueTypeModifier(profile, bowlingStyle);
  for (const k of ["1", "2", "3", "4"]) {
    if (probs[k] !== undefined) probs[k] *= other * type.runMod;
  }
  if (probs["6"] !== undefined) probs["6"] *= six * type.runMod;
  if (probs.wicket !== undefined) probs.wicket *= profile.wicketMult * type.wicketMod;
}

/** Small second-innings tilt so the chasing side's edge matches the measured chase advantage. */
export function applyChaseEdge(probs: Probs, chaseAdvantage: number): void {
  const e = clamp(CHASE_GAIN * (chaseAdvantage - ENGINE_INTRINSIC_CHASE), -0.15, 0.15);
  if (e === 0) return;
  for (const k of ["1", "2", "3", "4", "6"]) {
    if (probs[k] !== undefined) probs[k] *= 1 + e;
  }
  if (probs.wicket !== undefined) probs.wicket *= 1 - e;
}
