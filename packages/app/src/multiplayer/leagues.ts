/**
 * Leagues a multiplayer room can play: IPL, WPL and every extra league in engine/src/leagues.ts (BBL, WBBL, PSL, SA20,
 * The Hundred men / women, CPL, ILT20, MLC, BPL, LPL). Rules and franchises come from the same registry single
 * player uses; squads and free agents come from `createGameState` (game-state.ts) after `prepareLeaguePool`, exactly
 * like a single-player new game.
 */
import {
  ALL_LEAGUES, EXTRA_LEAGUES, RULE_PRESETS, getLeague,
  type ExtraLeagueId, type RuleSet, type TeamConfig,
} from "@ipl-sim/engine";

export type MultiplayerLeagueId = "ipl" | "wpl" | ExtraLeagueId;

export const MULTIPLAYER_LEAGUES: { id: MultiplayerLeagueId; short: string; name: string; teams: number; gender: "men" | "women" }[] =
  ALL_LEAGUES.map(l => ({
    id: l.id as MultiplayerLeagueId,
    short: l.short,
    name: l.name,
    teams: l.teams.filter(t => l.rules.teamIds.includes(t.id)).length,
    gender: l.gender,
  }));

export function isMultiplayerLeague(id: unknown): id is MultiplayerLeagueId {
  return typeof id === "string" && MULTIPLAYER_LEAGUES.some(l => l.id === id);
}

export function isExtraMultiplayerLeague(id: string): id is ExtraLeagueId {
  return EXTRA_LEAGUES.some(l => l.id === id);
}

/** Season-draft rules for a league (IPL: the 2026 preset, as before) */
export function multiplayerSeasonRules(id: MultiplayerLeagueId): RuleSet {
  if (id === "wpl") return RULE_PRESETS.wpl;
  if (id === "ipl") return RULE_PRESETS.modern2026;
  return getLeague(id)?.rules ?? RULE_PRESETS.modern2026;
}

/** Auction-room rules for a league (IPL: the modern preset the auction room always used) */
export function multiplayerAuctionRules(id: MultiplayerLeagueId): RuleSet {
  return id === "ipl" ? { ...RULE_PRESETS.modern } : { ...multiplayerSeasonRules(id) };
}

/** The franchises of a league that its rules field */
export function multiplayerLeagueTeams(id: MultiplayerLeagueId, rules: RuleSet = multiplayerSeasonRules(id)): TeamConfig[] {
  const league = getLeague(id) ?? getLeague("ipl")!;
  const ids = new Set(rules.teamIds);
  return league.teams.filter(c => ids.has(c.id));
}

export function multiplayerLeagueName(id: MultiplayerLeagueId): string {
  return MULTIPLAYER_LEAGUES.find(l => l.id === id)?.short ?? id.toUpperCase();
}
