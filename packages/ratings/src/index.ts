/**
 * @ipl-sim/ratings - Player rating generation and historical snapshots
 */

export { calculateRatings, inferRole } from "./calculator.js";
export type { RawPlayerStats, CalculatedRatings, GenderPop } from "./calculator.js";

export {
  saveSnapshot,
  loadAllSnapshots,
  loadSnapshot,
  getPlayerHistory,
  compareSnapshots,
} from "./snapshot.js";
export type { PlayerRatingSnapshot, RatingSnapshot } from "./snapshot.js";

export { getRealPlayers, getPoolPlayers, REAL_PLAYERS } from "./real-players.js";
export type { RealPlayerData } from "./real-players.js";

export { ALL_PLAYERS, PLAYER_COUNT } from "./all-players.js";

export { getWPLPlayers, WPL_PLAYERS, WPL_PLAYER_COUNT } from "./wpl-players.js";
export type { WPLPlayerData } from "./wpl-players.js";

export { WPL_2025_ROSTERS } from "./wpl-rosters.js";
export type { WPLRosterPlayer, WPLRoster } from "./wpl-rosters.js";

export { POOL_VERSION, encodeShard, decodeShard, searchPlayers, overallsOf, toRealPlayerData, topActive } from "./extended-pool.js";
export type { PoolRow, PoolShard, PoolManifest, PoolShardInfo, PoolGender, ExtendedPlayer } from "./extended-pool.js";
export { FORMAT_RATINGS_VERSION, LONG_FORMATS, encodeSet, decodeSet, decodeFormatSets, formatRatingsFor, attachFormatRatings } from "./format-ratings.js";
export { PLAYER_ACTIVITY_VERSION, playerActivity, squadTier } from "./player-activity.js";
export type { PlayerActivityFile, PlayerActivity, ActivityFormat } from "./player-activity.js";
export type { FormatRatingsFile, EncodedSet, AttachablePlayer } from "./format-ratings.js";
export {
  getLeaguePlayers, getLeagueMatchStats, getLeagueSeason, getLeagueRosteredIds, getPoolPlayersForLeague,
  registerCaPlayerSource, EXTRA_LEAGUE_IDS,
} from "./league-players.js";
export type {
  LeaguePlayerData, LeagueRosterPlayer, LeagueRosterTeam, LeagueRosters, LeagueMatchStats, LeaguePlayerSource, CaPlayerSource, CaPlayerRecord,
} from "./league-players.js";
export { LEAGUE_ROSTERS } from "./league-rosters.js";
