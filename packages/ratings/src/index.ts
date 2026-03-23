/**
 * @ipl-sim/ratings - Player rating generation and historical snapshots
 */

export { calculateRatings, inferRole } from "./calculator.js";
export type { RawPlayerStats, CalculatedRatings } from "./calculator.js";

export {
  saveSnapshot,
  loadAllSnapshots,
  loadSnapshot,
  getPlayerHistory,
  compareSnapshots,
} from "./snapshot.js";
export type { PlayerRatingSnapshot, RatingSnapshot } from "./snapshot.js";

export { getRealPlayers, REAL_PLAYERS } from "./real-players.js";
export type { RealPlayerData } from "./real-players.js";

export { ALL_PLAYERS, PLAYER_COUNT } from "./all-players.js";

export { getWPLPlayers, WPL_PLAYERS } from "./wpl-players.js";
export type { WPLPlayerData } from "./wpl-players.js";
