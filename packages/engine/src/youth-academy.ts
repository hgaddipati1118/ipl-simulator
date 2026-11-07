/**
 * Youth Academy: generates young domestic prospects between seasons.
 *
 * Each prospect has a `potential` ceiling (0-99) that governs
 * how fast their ratings grow during `progress()`.
 */

import type { Player } from "./player.js";
import { clamp } from "./math.js";
import { generatePlayer } from "./player-generator.js";
import { type RNG, createRNG } from "./rng.js";

export interface YouthProspect {
  player: Player;
  potential: number; // 0-99, how high their ceiling is
  scoutRating: string; // "Diamond", "Gold", "Silver", "Bronze"
}

/** Scouting grade from the mature rating a prospect is expected to reach (potential is on the 0-99 rating scale) */
function scoutLabel(potential: number): string {
  if (potential >= SCOUT_DIAMOND) return "Diamond";
  if (potential >= SCOUT_GOLD) return "Gold";
  if (potential >= SCOUT_SILVER) return "Silver";
  return "Bronze";
}

// Thresholds sit at roughly the top 5%, 20% and 50% of generated prospects
const SCOUT_DIAMOND = 78;
const SCOUT_GOLD = 71;
const SCOUT_SILVER = 64;

/**
 * Generate 1-3 youth prospects for a team's academy.
 * All prospects are Indian domestic players aged 17-20, sampled from the real joint distribution of ratings
 * (player-generator.ts) with a potential and a progression path from the fitted career model.
 * `gender` picks the league's progression curves and name pools (default men).
 */
export function generateYouthProspects(
  teamId: string,
  count: number = 2,
  rng?: RNG,
  opts: { gender?: "male" | "female"; country?: string; idPrefix?: string } = {},
): YouthProspect[] {
  const _rng = rng ?? createRNG();
  const prospects: YouthProspect[] = [];
  const safeCount = clamp(count, 1, 3);

  for (let i = 0; i < safeCount; i++) {
    const player = generatePlayer(_rng, {
      kind: "youth",
      gender: opts.gender,
      country: opts.country ?? "India",
      teamId,
      id: opts.idPrefix ? `${opts.idPrefix}_${i + 1}` : undefined,
    });
    // an academy only signs prospects with something to build on
    const raw = player.potential ?? 60;
    const potential = clamp(raw, 60, 99);
    if (player.talentLeft !== undefined) player.talentLeft += potential - raw;
    player.potential = potential;
    prospects.push({ player, potential, scoutRating: scoutLabel(potential) });
  }

  return prospects;
}
