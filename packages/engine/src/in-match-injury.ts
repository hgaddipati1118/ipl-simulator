/**
 * In-match injuries the three match engines share (docs/RULES-MATCH.md section 13.9, docs/ENGINE-VENUES-AND-INJURIES.md):
 *
 * - Concussion substitutes, all formats (ICC playing conditions since August 2019; the IPL's is separate from the Impact Player):
 *   a batter hit at the crease, or a fielder, is replaced like for like by a player from the bench the match referee approves.
 *   Rates per legal ball by format, fitted from Cricsheet `replacements.match` (packages/ratings/src/analysis/concussion-subs.py ->
 *   in-match-injury-data.ts). A batter hit is replaced at once (not a wicket: the sub bats in his place); a fielder is replaced
 *   at the end of the over, and the sub bowls what is left of his quota when he was a bowling option.
 * - What an in-match injury costs afterwards: a concussed player misses the measured number of team matches; a retired-hurt
 *   batter or a bowler who broke down mid-over misses the next match with the measured probability (CricketArchive "confirmed"
 *   in-match injuries, docs/INJURY-RISK-REPORT.md) and then the measured layoff.
 *
 * Draws for the concussion itself come from `sideDraw` (a hash of the match seed and the ball), so the engines' own random
 * streams, and every seeded match without a concussion, are unchanged.
 */

import { IN_MATCH_INJURY_DATA as D } from "./in-match-injury-data.js";
import { isLikeForLikeReplacement } from "./ball-outcomes.js";
import { ruleOverrides } from "./dismissal-kinds.js";
import { applyInjury, type InjuryStatus, type InjurySeverity } from "./injury.js";
import type { Player, PlayerRole, BowlingStyle } from "./player.js";
import type { MatchInjuryEvent } from "./match.js";
import type { RNG } from "./rng.js";

export type InMatchFormat = "T20" | "ODI" | "Test";
export type InMatchInjuryKind = "concussion" | "retired_hurt" | "bowler_breakdown";

/** One in-match injury, as an engine records it */
export interface InMatchInjury {
  kind: InMatchInjuryKind;
  playerId: string;
  playerName: string;
  teamId: string;
  /** Innings of the match (1-based), over (0-based) and legal ball of the over */
  innings: number;
  over: number;
  ball: number;
  /** Concussion: the like-for-like replacement (absent: nobody on the bench, the side carried on a player short) */
  subId?: string;
  subName?: string;
  /** Concussion: hit batting (replaced at the crease) or in the field */
  side?: "batting" | "fielding";
}

/** The scorecard note: "X replaced by Y (concussion sub)" */
export function concussionNote(e: Pick<InMatchInjury, "playerName" | "subName">): string {
  return e.subName ? `${e.playerName} replaced by ${e.subName} (concussion sub)` : `${e.playerName} concussed (no replacement available)`;
}

/** Commentary when the concussion happens */
export function concussionLine(e: Pick<InMatchInjury, "playerName" | "subName" | "side">): string {
  const hit = e.side === "batting" ? `${e.playerName} is struck on the helmet and fails the concussion test` : `${e.playerName} takes a blow to the head in the field and fails the concussion test`;
  return e.subName ? `${hit}: ${e.subName} comes on as a like-for-like concussion substitute.` : `${hit} and leaves the field; there is nobody to replace him.`;
}

/** Engine format -> the fitted table's format (The Hundred plays at the T20 rate) */
export function inMatchFormatOf(id: string | undefined): InMatchFormat {
  return id === "odi" ? "ODI" : id === "test" ? "Test" : "T20";
}

/** Per legal ball: a batter concussed at the crease, a fielder concussed */
export function concussionRates(fmt: InMatchFormat): { batting: number; fielding: number } {
  const o = ruleOverrides();
  const total = o.concussionPerBall ?? D.concussion.formats[fmt].perBall;
  const share = o.concussionBattingShare ?? D.concussion.battingShare;
  return { batting: total * share, fielding: total * (1 - share) };
}

/** A uniform draw from the match seed and where the ball is in the match: not one of the engine's own random numbers */
export function sideDraw(seed: number, a: number, b: number, c = 0): number {
  let h = (seed ^ 0x9e3779b9) | 0;
  for (const x of [a, b, c]) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 0xc2b2ae35);
    h = (h ^ (h >>> 16)) | 0;
  }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** What the referee and the CPU look at in a replacement */
export interface SubCandidate {
  id: string;
  role: PlayerRole | string;
  isWicketKeeper?: boolean;
  isInternational?: boolean;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  bowlingStyle?: BowlingStyle | string;
}

const spin = (s?: string) => !!s && (s.includes("spin") || s === "left-arm-orthodox");

/**
 * The bench players the referee would approve for `out`, best first (the CPU takes the first): like for like on role
 * (isLikeForLikeReplacement), a keeper for a keeper who had the gloves, a spinner for a spinner and a seamer for a seamer
 * first, and no more overseas players on the field than the rules allow. With nobody like for like on the bench the
 * referee takes the nearest (any eligible player).
 */
export function concussionSubOptions<P extends SubCandidate>(
  out: SubCandidate,
  bench: readonly P[],
  opts: { overseasOnField?: number; maxOverseas?: number; keeping?: boolean } = {},
): P[] {
  const overseasLeft = opts.maxOverseas === undefined ? Infinity : opts.maxOverseas - (opts.overseasOnField ?? 0) + (out.isInternational ? 1 : 0);
  const eligible = bench.filter(p => !p.isInternational || overseasLeft > 0);
  const like = eligible.filter(p => isLikeForLikeReplacement(out.role, p.role));
  const pool = like.length > 0 ? like : eligible;
  const role = out.role === "wicket-keeper" ? "batsman" : out.role;
  const score = (p: P) => {
    let s = role === "batsman" ? p.battingOvr : role === "bowler" ? p.bowlingOvr : (p.battingOvr + p.bowlingOvr) / 2;
    if (p.role === out.role) s += 5;
    if (opts.keeping && p.isWicketKeeper) s += 100;
    if (role === "bowler" && spin(p.bowlingStyle) === spin(out.bowlingStyle)) s += 10;
    return s;
  };
  return [...pool].sort((a, b) => score(b) - score(a));
}

/** The replacement may bowl (the rest of the replaced player's quota) only when he replaced a bowling option */
export function subMayBowl(out: Pick<SubCandidate, "role">, outBowled = false): boolean {
  return outBowled || out.role === "bowler" || out.role === "all-rounder";
}

// ── After the match ──────────────────────────────────────────────────────────────────────────────────────────────────

function drawIndex(weights: readonly number[], rng: RNG): number {
  const tot = weights.reduce((a, b) => a + b, 0);
  let x = rng() * tot;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x < 0) return i; }
  return weights.length - 1;
}

function severityOf(matches: number): InjurySeverity {
  return matches >= 6 ? "severe" : matches >= 3 ? "moderate" : "minor";
}

const HURT_TYPES = ["finger", "hand", "hamstring", "calf"];
const BREAKDOWN_TYPES = ["hamstring", "side strain", "back", "groin", "ankle"];

/**
 * The team matches an in-match injury keeps the player out for (0 = fit for the next match). Concussion: the measured
 * matches missed after a concussion substitution (6+ spread over 6-8). Retired hurt / a mid-over breakdown: misses the next
 * match with the measured probability, then the measured layoff of confirmed in-match injuries (10+ spread over 10-12).
 */
export function inMatchInjuryStatus(kind: InMatchInjuryKind, fmt: InMatchFormat, rng: RNG): InjuryStatus {
  let n: number;
  let type: string;
  if (kind === "concussion") {
    const i = drawIndex(D.concussion.missed, rng);
    n = i < 6 ? i : 6 + Math.floor(rng() * 3);
    type = "concussion";
  } else {
    const p = kind === "retired_hurt" ? D.retiredHurt.missProb[fmt] : D.bowlerBreakdown.missProb;
    const types = kind === "retired_hurt" ? HURT_TYPES : BREAKDOWN_TYPES;
    type = types[Math.floor(rng() * types.length)];
    if (rng() >= p) n = 0;
    else {
      const i = drawIndex(D.retiredHurt.missed, rng);
      n = i < 9 ? i + 1 : 10 + Math.floor(rng() * 3);
    }
  }
  return { isInjured: n > 0, injuryType: type, matchesRemaining: n, severity: severityOf(n) };
}

/** Real per-1,000-match rates of the fit years, for tests and reports */
export function concussionFitPer1000(fmt: InMatchFormat): number {
  const f = D.concussion.formats[fmt];
  return (1000 * f.fitEvents) / f.fitMatches;
}

/**
 * Turn the match's in-match injuries into post-match injury status (one per player: the longest layoff when he had two)
 * and the match result's `injuries` entries. Players already out injured keep the longer layoff. With injuries off the
 * events stay in the scorecard and commentary only.
 */
export function applyInMatchInjuries(
  events: readonly InMatchInjury[],
  playerOf: (id: string) => Player | undefined,
  opts: { enabled: boolean; format: InMatchFormat; rng: RNG },
): MatchInjuryEvent[] {
  if (!opts.enabled) return [];
  const best = new Map<string, { e: InMatchInjury; s: InjuryStatus }>();
  for (const e of events) {
    const s = inMatchInjuryStatus(e.kind, opts.format, opts.rng);
    const cur = best.get(e.playerId);
    if (!cur || s.matchesRemaining > cur.s.matchesRemaining) best.set(e.playerId, { e, s });
  }
  const out: MatchInjuryEvent[] = [];
  for (const { e, s } of best.values()) {
    const p = playerOf(e.playerId);
    if (!p) continue;
    if (s.matchesRemaining > 0 && (!p.injured || p.injuryGamesLeft < s.matchesRemaining)) applyInjury(p, s);
    out.push({ playerId: p.id, playerName: p.name, teamId: e.teamId, injury: s, inMatch: e.kind });
  }
  return out;
}
