/**
 * Innings formats.
 *
 * T20: 20 overs of 6 balls, a bowler delivers at most 4 overs (24 balls), a bowler may not bowl consecutive overs.
 * The Hundred: 100 balls, modelled as 20 "sets" of 5 balls. A bowler delivers 5 or 10 consecutive balls (one set
 * or two in a row, from the same end), at most 20 balls (4 sets) in an innings; the powerplay is the first
 * 25 balls (5 sets). The super over is a single 5-ball set per side.
 *
 * Both formats have 20 "overs" per innings, so every over-indexed table in the engine (phase multipliers,
 * clutch windows, ball-change rule) keeps its indexing; only the powerplay boundary moves (see phaseOver).
 * In the engine an innings' `overs` field counts completed sets, so for The Hundred use `totalBalls`.
 */

import type { RuleSet } from "./rules.js";

export interface MatchFormatSpec {
  id: "t20" | "hundred";
  /** "Overs" (sets) per innings */
  overs: number;
  ballsPerOver: number;
  /** Cap on overs (sets) for any one bowler */
  maxOversPerBowler: number;
  /** Most consecutive overs (sets) one bowler can deliver */
  maxConsecutiveOvers: number;
  /** Powerplay length in overs (sets) */
  powerplayOvers: number;
  /** Balls in an innings */
  totalBalls: number;
}

export const T20_FORMAT: MatchFormatSpec = {
  id: "t20", overs: 20, ballsPerOver: 6, maxOversPerBowler: 4, maxConsecutiveOvers: 1, powerplayOvers: 6, totalBalls: 120,
};

export const HUNDRED_FORMAT: MatchFormatSpec = {
  id: "hundred", overs: 20, ballsPerOver: 5, maxOversPerBowler: 4, maxConsecutiveOvers: 2, powerplayOvers: 5, totalBalls: 100,
};

export function matchFormatFor(rules: Pick<RuleSet, "matchFormat"> | undefined): MatchFormatSpec {
  return rules?.matchFormat === "hundred" ? HUNDRED_FORMAT : T20_FORMAT;
}

/**
 * Map an over (set) of the format onto the 20-over T20 timeline the phase tables were tuned for:
 * the powerplay (5 sets in The Hundred) stretches to T20's 6 overs, the rest keeps its index.
 * Identity for T20.
 */
export function phaseOver(over: number, fmt: MatchFormatSpec): number {
  if (fmt.powerplayOvers === T20_FORMAT.powerplayOvers) return over;
  const pp = fmt.powerplayOvers;
  if (over < pp) return (over * T20_FORMAT.powerplayOvers) / pp;
  // after the powerplay: sets pp..19 map onto overs 6..19 so the death overs (15+) line up with the last five sets
  return T20_FORMAT.powerplayOvers + ((over - pp) * (fmt.overs - T20_FORMAT.powerplayOvers)) / (fmt.overs - pp);
}
