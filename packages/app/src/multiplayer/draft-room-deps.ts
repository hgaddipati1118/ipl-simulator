/** Real-data pool builders for multiplayer draft rooms. */

import { RULE_PRESETS, IPL_TEAMS, WPL_TEAMS, createPlayerFromData, generatePlayerPool, type Player } from "@ipl-sim/engine";
import { getRealPlayers, getPoolPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { getWPLPlayers } from "@ipl-sim/ratings/dist/wpl-players.js";
import { buildDraftMatchPool } from "../draft-pools";
import { createGameState } from "../game-state";
import { prepareLeaguePool } from "../extended-pool";
import type { DraftRoomDeps } from "./draft-room";
import { isExtraMultiplayerLeague, multiplayerLeagueTeams, multiplayerSeasonRules } from "./leagues";

/** The pool is sent to every peer once, so cap it at a size that keeps the room responsive. */
const SEASON_POOL_CAP = 600;

export const realDraftRoomDeps: DraftRoomDeps = {
  buildSeasonPool(league) {
    if (isExtraMultiplayerLeague(league)) {
      // Same squads and free agents a single-player game of the league starts with (after prepareSeasonPool)
      const rules = multiplayerSeasonRules(league);
      const teams = multiplayerLeagueTeams(league, rules);
      let players: Player[] = [];
      try {
        const state = createGameState(rules);
        players = [...state.teams.flatMap(t => t.roster), ...state.playerPool];
      } catch {
        players = [];
      }
      const needed = teams.length * Math.min(rules.maxSquadSize, rules.gender === "women" ? 15 : 18);
      if (players.length < needed * 1.2) players = [...players, ...generatePlayerPool(Math.ceil(needed * 1.5), Math.random, rules.gender === "women" ? "female" : "male")];
      players = players.sort((a, b) => b.overall - a.overall).slice(0, Math.max(SEASON_POOL_CAP, Math.ceil(needed * 1.6)));
      return { teams, players, rules };
    }
    const rules = league === "wpl" ? RULE_PRESETS.wpl : RULE_PRESETS.modern2026;
    const ids = new Set(rules.teamIds);
    const teams = (league === "wpl" ? WPL_TEAMS : IPL_TEAMS).filter(c => ids.has(c.id));
    let players: Player[] = [];
    try {
      const data = league === "wpl" ? getWPLPlayers() : [...getRealPlayers(), ...getPoolPlayers()];
      players = data.map(d => createPlayerFromData(d));
    } catch {
      players = [];
    }
    const needed = teams.length * (league === "wpl" ? 15 : 18);
    if (players.length < needed * 1.2) players = [...players, ...generatePlayerPool(Math.ceil(needed * 1.5), Math.random, league === "wpl" ? "female" : "male")];
    players = players.sort((a, b) => b.overall - a.overall).slice(0, Math.max(SEASON_POOL_CAP, Math.ceil(needed * 1.6)));
    return { teams, players, rules };
  },
  prepareSeasonPool(league) {
    return isExtraMultiplayerLeague(league) ? prepareLeaguePool(league) : undefined;
  },
  buildMatchPool(settings) {
    return buildDraftMatchPool(settings.pool, settings.nations);
  },
};
