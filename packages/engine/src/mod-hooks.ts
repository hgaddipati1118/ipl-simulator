/**
 * Engine extension points used by the mod system (packages/mods).
 *
 * The engine only knows this small structural interface: a registry holding
 * (optionally) three callbacks. With nothing registered every call site is a
 * single null check, so seeded results stay byte-for-byte identical to the
 * unmodded engine. Validation, ordering and fault isolation of mods live in
 * packages/mods; whatever it hands back here is trusted.
 */

import type { BallOutcome } from "./match.js";
import { createRNG, type RNG } from "./rng.js";
import {
  getMatchPhase,
  isPaceBowler,
  isSpinBowler,
  type BoundarySize,
  type BowlingStyle,
  type DewFactor,
  type MatchPhase,
  type PitchType,
} from "./matchups.js";

export type BallProbabilities = Record<BallOutcome, number>;

/** Read-only view of a player handed to hooks (identical for match.ts and live-match.ts). */
export interface HookPlayer {
  id: string;
  name: string;
  role: string;
  isInternational: boolean;
  isWicketKeeper: boolean;
  bowlingStyle: BowlingStyle;
  battingHand: "right" | "left";
  isSpin: boolean;
  isPace: boolean;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  form: number;
  ratings: {
    battingIQ: number;
    timing: number;
    power: number;
    running: number;
    wicketTaking: number;
    economy: number;
    accuracy: number;
    clutch: number;
  };
}

export interface HookVenue {
  /** Stable slug, e.g. "chepauk"; "neutral" for neutral-venue matches. */
  id: string;
  name: string;
  pitch: PitchType;
  boundary: BoundarySize;
  dew: DewFactor;
  /** Effective stadium bowling rating (1.0 = balanced, higher favours bowlers). */
  bowlingRating: number;
}

export interface BallHookContext {
  batter: HookPlayer;
  bowler: HookPlayer;
  /** 0-based over number. */
  over: number;
  /** 1-based legal delivery within the over. */
  ball: number;
  innings: 1 | 2;
  score: number;
  wickets: number;
  /** Runs to win in the second innings, 0 in the first. */
  target: number;
  ballsRemaining: number;
  /** Overs in this innings. */
  maxOvers: number;
  phase: MatchPhase;
  venue: HookVenue;
  /** Seeded per-ball stream (derived from the match rng) so peers stay in sync. */
  rng: RNG;
}

export type BallHookEvent = {
  outcome: BallOutcome;
  runs: number;
  extras: number;
  isWicket: boolean;
};

export interface MatchFormat {
  /** Overs per innings. */
  overs: number;
  /** Length of the powerplay in overs. */
  powerplayOvers: number;
  /** Cap on overs for any one bowler. */
  maxOversPerBowler: number;
  /** Overs in a super over (tie-break). */
  superOverOvers: number;
}

export interface EngineHooks {
  ballProbabilities?(ctx: BallHookContext, probs: BallProbabilities): BallProbabilities;
  /** Read-only observer. The context rng is a throwaway stream. */
  onBall?(ctx: BallHookContext, event: BallHookEvent): void;
  matchFormat?(format: MatchFormat): MatchFormat;
}

export const DEFAULT_MATCH_FORMAT: Readonly<MatchFormat> = Object.freeze({
  overs: 20,
  powerplayOvers: 6,
  maxOversPerBowler: 4,
  superOverOvers: 1,
});

let activeHooks: EngineHooks | null = null;

/** Install (or clear with null) the process-wide engine hooks. */
export function setEngineHooks(hooks: EngineHooks | null): void {
  activeHooks = hooks;
}

export function getEngineHooks(): EngineHooks | null {
  return activeHooks;
}

/**
 * The format for a new match: the default, passed through `matchFormat` if a
 * mod provides one. Returns null when the result equals the default so call
 * sites can skip all format handling.
 */
export function resolveMatchFormat(hooks: EngineHooks | null = activeHooks): MatchFormat | null {
  if (!hooks?.matchFormat) return null;
  const f = hooks.matchFormat({ ...DEFAULT_MATCH_FORMAT });
  const d = DEFAULT_MATCH_FORMAT;
  if (
    f.overs === d.overs && f.powerplayOvers === d.powerplayOvers &&
    f.maxOversPerBowler === d.maxOversPerBowler && f.superOverOvers === d.superOverOvers
  ) return null;
  return f;
}

/**
 * Map an over of a non-standard format onto the 20-over timeline the phase and
 * matchup tables were tuned for (powerplay -> 0-6, middle -> 6-15, death -> 15-20).
 * Identity for the default format.
 */
export function normalizeOver(over: number, format: MatchFormat | null | undefined): number {
  if (!format) return over;
  const pp = format.powerplayOvers;
  const deathLen = Math.max(1, Math.round(format.overs * 0.25));
  const deathStart = Math.max(pp, format.overs - deathLen);
  if (pp > 0 && over < pp) return (over * 6) / pp;
  if (over >= deathStart) return 15 + ((over - deathStart) * 5) / Math.max(1, format.overs - deathStart);
  return 6 + ((over - pp) * 9) / Math.max(1, deathStart - pp);
}

const VENUE_IDS: Record<string, string> = {
  csk: "chepauk", mi: "wankhede", rcb: "chinnaswamy", kkr: "eden-gardens", dc: "arun-jaitley",
  srh: "uppal", rr: "sawai-mansingh", pbks: "mohali", gt: "narendra-modi", lsg: "ekana",
};

export function venueIdForTeam(teamId: string): string {
  return VENUE_IDS[teamId] ?? teamId;
}

/** Normalise a Player or a serialized live-match player into the hook view. */
export function toHookPlayer(p: {
  id: string; name: string; role: string; isInternational: boolean; isWicketKeeper?: boolean;
  bowlingStyle: BowlingStyle; battingHand: "right" | "left";
  battingOvr: number; bowlingOvr: number; overall: number; form: number;
  ratings: HookPlayer["ratings"];
}): HookPlayer {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    isInternational: p.isInternational,
    isWicketKeeper: !!p.isWicketKeeper,
    bowlingStyle: p.bowlingStyle,
    battingHand: p.battingHand,
    isSpin: isSpinBowler(p.bowlingStyle),
    isPace: isPaceBowler(p.bowlingStyle),
    battingOvr: p.battingOvr,
    bowlingOvr: p.bowlingOvr,
    overall: p.overall,
    form: p.form,
    ratings: { ...p.ratings },
  };
}

/**
 * A per-ball stream for hooks, seeded lazily from the match rng the first time a
 * hook draws from it. A hook that never uses `ctx.rng` leaves the match rng
 * sequence untouched, so a no-op mod reproduces the unmodded result exactly.
 */
export function derivedHookRng(rng: RNG): RNG {
  let derived: RNG | null = null;
  return () => {
    derived ??= createRNG(Math.floor(rng() * 4294967296));
    return derived();
  };
}

/** What a call site knows about the match around a ball; combined with the players into a context. */
export interface BallHookInfo {
  innings: 1 | 2;
  /** 1-based legal delivery within the over. */
  ball: number;
  maxOvers: number;
  venue: HookVenue;
  format?: MatchFormat | null;
}

export function buildBallContext(
  batter: HookPlayer,
  bowler: HookPlayer,
  over: number,
  target: number,
  score: number,
  wickets: number,
  ballsRemaining: number,
  info: BallHookInfo,
  rng: RNG,
): BallHookContext {
  return {
    batter,
    bowler,
    over,
    ball: info.ball,
    innings: info.innings,
    score,
    wickets,
    target,
    ballsRemaining,
    maxOvers: info.maxOvers,
    phase: getMatchPhase(normalizeOver(over, info.format)),
    venue: info.venue,
    rng,
  };
}

/** Run `engine.ballProbabilities` on (a normalised copy of) the probabilities. */
export function applyBallProbabilityHooks(
  hooks: EngineHooks,
  makeContext: () => BallHookContext,
  probs: BallProbabilities,
): BallProbabilities {
  if (!hooks.ballProbabilities) return probs;
  const total = Object.values(probs).reduce((s, v) => s + v, 0);
  const normalised = { ...probs };
  if (total > 0) for (const k of Object.keys(normalised) as BallOutcome[]) normalised[k] /= total;
  return hooks.ballProbabilities(makeContext(), normalised);
}
