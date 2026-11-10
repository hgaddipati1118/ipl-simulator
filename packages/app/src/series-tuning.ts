/**
 * Series matches in the limited-overs formats: the two sides' ratings are moved, before the match, by (1) a stretch of the
 * gap between their strengths and (2) a home advantage, both fitted per format and gender on the real fixtures' results per
 * country (docs/FORMATS.md, "Per-country validation"). Strength is the mean overall of a side's best eleven. Both are rating
 * shifts of the six batting and bowling attributes, so the instant and the live engine play the same teams.
 */
import type { Player } from "@ipl-sim/engine";
import { SERIES_TUNING, type SeriesTuning } from "./series-tuning-data";

const SHIFTED = ["battingIQ", "timing", "power", "wicketTaking", "economy", "accuracy"] as const;

export function tuningFor(format: string, gender: "men" | "women"): SeriesTuning | undefined {
  return SERIES_TUNING[format]?.[gender];
}

/** Mean overall of a side's best eleven */
export function sideStrength(players: readonly Player[]): number {
  const best = players.map(p => p.overall).sort((a, b) => b - a).slice(0, 11);
  return best.reduce((s, x) => s + x, 0) / Math.max(1, best.length);
}

/** Shift one side's ratings (in place) by `delta` points */
export function shiftSide(players: readonly Player[], delta: number): void {
  if (!delta) return;
  for (const p of players) for (const k of SHIFTED) p.ratings[k] = Math.max(1, Math.min(99, p.ratings[k] + delta));
}

/**
 * Move two sides' players for a match: the gap between their strengths stretched by `spread` (each side moves (spread - 1) / 2
 * of the gap, apart), and the home side's ratings up and the away side's down by `home / 2` at a ground that is not neutral.
 * `homeIdx` is the home side (0 or 1), or -1 at a neutral ground.
 */
export function applySeriesTuning(sides: [Player[], Player[]], tuning: SeriesTuning | undefined, homeIdx: number, homeCountry?: string): void {
  if (!tuning) return;
  const home = (homeCountry ? tuning.homeBy?.[homeCountry] : undefined) ?? tuning.home;
  const gap = sideStrength(sides[0]) - sideStrength(sides[1]);
  const stretch = ((tuning.spread - 1) / 2) * gap;
  shiftSide(sides[0], stretch + (homeIdx === 0 ? home / 2 : homeIdx === 1 ? -home / 2 : 0));
  shiftSide(sides[1], -stretch + (homeIdx === 1 ? home / 2 : homeIdx === 0 ? -home / 2 : 0));
}

/** The opposition-strength adjustment of a national-squad player (rating points on the batting and the bowling attributes, in place) */
export function applyOppositionAdjust(p: Player, bat: number, bowl: number): void {
  for (const k of ["battingIQ", "timing", "power"] as const) p.ratings[k] = Math.max(1, Math.min(99, p.ratings[k] + bat));
  for (const k of ["wicketTaking", "economy", "accuracy"] as const) p.ratings[k] = Math.max(1, Math.min(99, p.ratings[k] + bowl));
}
