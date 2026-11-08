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
 *
 * ODI: 50 overs of 6 balls, a bowler delivers at most 10 overs and never two in a row; fielding restrictions of at most
 * 2 / 4 / 5 fielders outside the 30-yard circle in overs 1-10 / 11-40 / 41-50; men's ODIs use a new ball from each end;
 * no Impact Player and no strategic timeouts; a tie stands unless the competition settles it with a super over. The
 * ODI does not use the T20 tables: its balls come from its own fitted model (odi-model.ts, docs/FORMATS.md).
 */

import type { RuleSet } from "./rules.js";

export interface MatchFormatSpec {
  id: "t20" | "hundred" | "odi";
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
  /** Extras for a no-ball (1 in T20; The Hundred charges 2: 85% of Cricsheet Hundred no-balls cost 2) */
  noBallPenalty: number;
  /** Fielding restrictions: from over `from` (0-based) on, at most `maxOutside` fielders outside the 30-yard circle */
  fieldingRestrictions?: readonly { from: number; maxOutside: number }[];
  /** One new ball from each end (each ball is about half as old as the innings); absent = one ball per innings */
  newBallEachEnd?: { men: boolean; women: boolean };
  /** Overs (6-ball) each side must have had for a result after rain */
  minOversForResult?: number;
}

export const T20_FORMAT: MatchFormatSpec = {
  id: "t20", overs: 20, ballsPerOver: 6, maxOversPerBowler: 4, maxConsecutiveOvers: 1, powerplayOvers: 6, totalBalls: 120, noBallPenalty: 1,
};

export const HUNDRED_FORMAT: MatchFormatSpec = {
  id: "hundred", overs: 20, ballsPerOver: 5, maxOversPerBowler: 4, maxConsecutiveOvers: 2, powerplayOvers: 5, totalBalls: 100, noBallPenalty: 2,
};

export const ODI_FORMAT: MatchFormatSpec = {
  id: "odi", overs: 50, ballsPerOver: 6, maxOversPerBowler: 10, maxConsecutiveOvers: 1, powerplayOvers: 10, totalBalls: 300, noBallPenalty: 1,
  fieldingRestrictions: [{ from: 0, maxOutside: 2 }, { from: 10, maxOutside: 4 }, { from: 40, maxOutside: 5 }],
  newBallEachEnd: { men: true, women: false },
  minOversForResult: 20,
};

export function matchFormatFor(rules: Pick<RuleSet, "matchFormat"> | undefined): MatchFormatSpec {
  return rules?.matchFormat === "hundred" ? HUNDRED_FORMAT : rules?.matchFormat === "odi" ? ODI_FORMAT : T20_FORMAT;
}

/** A limited-overs format played on its own fitted ball model rather than the T20 tables (the ODI) */
export function hasOwnBallModel(fmt: MatchFormatSpec): boolean {
  return fmt.id === "odi";
}

/** Most fielders allowed outside the 30-yard circle in over `over` (0-based); T20 / Hundred: 2 in the powerplay, else 5 */
export function maxFieldersOutside(over: number, fmt: MatchFormatSpec): number {
  const fr = fmt.fieldingRestrictions;
  if (!fr) return over < fmt.powerplayOvers ? 2 : 5;
  let n = fr[0].maxOutside;
  for (const p of fr) if (over >= p.from) n = p.maxOutside;
  return n;
}

/** Overs the ball in use has bowled at the start of over `over`: with a new ball from each end each ball bowls every other over */
export function ballAgeOvers(over: number, fmt: MatchFormatSpec, gender: "male" | "female" = "male"): number {
  const each = fmt.newBallEachEnd?.[gender === "female" ? "women" : "men"];
  return each ? Math.floor(over / 2) : over;
}

/**
 * Map an over (set) of the format onto the 20-over T20 timeline the phase tables were tuned for:
 * the powerplay (5 sets in The Hundred) stretches to T20's 6 overs, the rest keeps its index.
 * Identity for T20. The ODI's balls do not use the T20 tables; its phases map here only for phase-keyed plans
 * (the live engine's powerplay / middle / death bowling plan).
 */
export function phaseOver(over: number, fmt: MatchFormatSpec): number {
  if (fmt.powerplayOvers === T20_FORMAT.powerplayOvers) return over;
  const fr = fmt.fieldingRestrictions;
  if (fr && fr.length >= 3) {
    // ODI: the powerplay (1-10), the middle overs (11-40) and the last ten map onto T20's 1-6, 7-15 and 16-20
    const pp = fr[1].from, death = fr[fr.length - 1].from;
    if (over < pp) return (over * 6) / pp;
    if (over < death) return 6 + ((over - pp) * 9) / (death - pp);
    return 15 + ((over - death) * 5) / (fmt.overs - death);
  }
  const pp = fmt.powerplayOvers;
  if (over < pp) return (over * T20_FORMAT.powerplayOvers) / pp;
  // after the powerplay: sets pp..19 map onto overs 6..19 so the death overs (15+) line up with the last five sets
  return T20_FORMAT.powerplayOvers + ((over - pp) * (fmt.overs - T20_FORMAT.powerplayOvers)) / (fmt.overs - pp);
}
