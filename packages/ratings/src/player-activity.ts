/**
 * When the shipped players last played (written by pipeline/generate-player-activity.ts from the CricketArchive data):
 * per player, his last international season in each format and his last senior domestic season. The app reads it to pick
 * national squads from players who are still playing. Pure (no I/O, browser-safe): the file format and its reading.
 *
 * File: { v, generated, asOf, players: { [sourceId]: [lastT20I, lastODI, lastTest, lastDomestic] } }, years (0 = never).
 * `asOf` is the latest season in the data. A player missing from the file has no CricketArchive record: unknown.
 */

export const PLAYER_ACTIVITY_VERSION = 1;

export interface PlayerActivityFile {
  v: number;
  generated: string;
  /** The latest season in the data */
  asOf: number;
  /** sourceId -> [last T20I, last ODI, last Test, last senior domestic season] (0 = never) */
  players: Record<string, [number, number, number, number]>;
}

export type ActivityFormat = "t20" | "odi" | "test";

export interface PlayerActivity {
  /** Last international season in each format (0 = never) */
  intl: Record<ActivityFormat, number>;
  /** Last senior domestic season (0 = never) */
  domestic: number;
  /** Last season at senior level at all */
  last: number;
}

export function playerActivity(file: PlayerActivityFile | null | undefined, sourceId: string | undefined): PlayerActivity | undefined {
  if (!file || file.v !== PLAYER_ACTIVITY_VERSION || !sourceId) return undefined;
  const a = file.players[sourceId];
  if (!a) return undefined;
  const [t20, odi, test, domestic] = a;
  return { intl: { t20, odi, test }, domestic, last: Math.max(t20, odi, test, domestic) };
}

/**
 * How available a player is for a national squad in a format, best first:
 *  0 = played the format internationally in the last `recent` seasons (default 2: this season and last),
 *  1 = played senior cricket (any international format, or domestic) in the last `recent` seasons,
 *  2 = played within the last `stale` seasons but not recently (only to fill a gap),
 *  3 = inactive for `stale` (default 3) seasons or more: never picked,
 *  null = unknown (no record).
 */
export function squadTier(activity: PlayerActivity | undefined, format: ActivityFormat, asOf: number, recent = 2, stale = 3): 0 | 1 | 2 | 3 | null {
  if (!activity) return null;
  if (activity.last <= asOf - stale) return 3;
  if (activity.intl[format] > asOf - recent) return 0;
  if (activity.last > asOf - recent) return 1;
  return 2;
}
