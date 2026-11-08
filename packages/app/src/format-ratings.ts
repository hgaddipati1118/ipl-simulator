/**
 * ODI and Test ratings in the app. The ESPN pool's and the league squads' sets live in public/data/format-ratings.json
 * (written by packages/ratings/src/pipeline/generate-format-ratings.ts, ~145 KB gzipped), outside the JS bundle: it is
 * fetched once, lazily, and its sets are attached to the game's players by `sourceId` (Player.formatRatings). Extended-
 * pool players carry their own sets from the pool shards (createPlayerFromData keeps them). Players that already have
 * sets (from a save) keep them, and a save without any still plays every format on the T20 ratings.
 */

import { useEffect, useState } from "react";
import type { Player, LongFormat } from "@ipl-sim/engine";
import { attachFormatRatings, type FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import type { GameState } from "./game-state";

export type RatingFormat = "t20" | LongFormat;
export const RATING_FORMATS: { id: RatingFormat; label: string }[] = [
  { id: "t20", label: "T20" }, { id: "odi", label: "ODI" }, { id: "test", label: "Test" },
];

let cached: Promise<FormatRatingsFile | null> | null = null;
let loadedFile: FormatRatingsFile | null = null;

/** Fetch the file once (null if it is not available) */
export function loadFormatRatings(): Promise<FormatRatingsFile | null> {
  if (!cached) {
    const base = (typeof import.meta !== "undefined" && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || "/";
    cached = fetch(`${base}data/format-ratings.json`)
      .then(r => (r.ok ? (r.json() as Promise<FormatRatingsFile>) : null))
      .then(f => { loadedFile = f; return f; })
      .catch(() => null);
  }
  return cached;
}

/** The file if it has already been fetched (no request) */
export function formatRatingsIfLoaded(): FormatRatingsFile | null {
  return loadedFile;
}

/** Every player a game state holds: squads, free agents, youth prospects, a live auction's lots */
export function statePlayers(state: Pick<GameState, "teams" | "playerPool" | "youthProspects" | "auctionLiveState">): Player[] {
  return [
    ...state.teams.flatMap(t => t.roster),
    ...state.playerPool,
    ...(state.youthProspects ?? []).map(y => y.player),
    ...(state.auctionLiveState?.players ?? []),
    ...(state.auctionLiveState?.unsold ?? []),
  ];
}

/** Attach the file's sets to a game state's players (in place); resolves to how many players got them */
export async function ensureFormatRatings(state: Pick<GameState, "teams" | "playerPool" | "youthProspects" | "auctionLiveState">): Promise<number> {
  const file = await loadFormatRatings();
  return attachFormatRatings(statePlayers(state), file);
}

/**
 * For pages that show format ratings: loads the file, attaches it to `players`, and returns true once done (the
 * caller re-renders then). True straight away when the file is already loaded.
 */
export function useFormatRatings(players: Player[]): boolean {
  const [ready, setReady] = useState(() => {
    const file = formatRatingsIfLoaded();
    if (file) attachFormatRatings(players, file);
    return !!file;
  });
  useEffect(() => {
    let alive = true;
    loadFormatRatings().then(file => {
      attachFormatRatings(players, file);
      if (alive) setReady(true);
    });
    return () => { alive = false; };
  }, [players]);
  return ready;
}
