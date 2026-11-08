/**
 * When the shipped players last played (public/data/player-activity.json, written by
 * packages/ratings/src/pipeline/generate-player-activity.ts): fetched once, lazily, outside the JS bundle. National
 * squads (international.ts) pick from players who are still playing; without the file they fall back to an age rule.
 */

import type { PlayerActivityFile } from "@ipl-sim/ratings/dist/player-activity.js";

let cached: Promise<PlayerActivityFile | null> | null = null;

/** Fetch the file once (null if it is not available) */
export function loadPlayerActivity(): Promise<PlayerActivityFile | null> {
  if (!cached) {
    const base = (typeof import.meta !== "undefined" && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || "/";
    cached = fetch(`${base}data/player-activity.json`)
      .then(r => (r.ok ? (r.json() as Promise<PlayerActivityFile>) : null))
      .catch(() => null);
  }
  return cached;
}
