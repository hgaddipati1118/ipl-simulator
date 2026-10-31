/**
 * Applies the one-shot data hooks (`data.players`, `data.teams`, `rules`) to a game.
 *
 * Each mod version is applied to a save exactly once (recorded in `modsApplied` as
 * `id@hash`), because hooks like "+5 batting for everyone" would otherwise compound
 * on every load. Mods installed or updated later are picked up the next time a save
 * loads or a season starts. A season in progress is left alone: changing rules or
 * squads under a fixed schedule would corrupt it.
 */

import { ALL_TEAM_IDS, Player, Team, type RuleSet, type TeamConfig } from "@ipl-sim/engine";
import type { ModPlayer, ModRuleSet, ModTeam } from "@ipl-sim/mods";
import type { GameState } from "../game-state";
import { modRuntime } from "./registry";

function key(m: { id: string; hash: string }) {
  return `${m.id}@${m.hash}`;
}

/** Enabled data/rules mods this game has not seen yet. */
export function pendingDataMods(state: Pick<GameState, "modsApplied">): string[] {
  const applied = new Set(state.modsApplied ?? []);
  const hashes = new Map(modRuntime.list().map(s => [s.id, s.hash]));
  return modRuntime.dataModIds().filter(id => !applied.has(key({ id, hash: hashes.get(id)! })));
}

/** Run pending `rules` hooks over a rule set (before a new game builds its teams). */
export function applyRulesMods(rules: RuleSet, ids: string[] = pendingDataMods({})): RuleSet {
  if (!ids.length) return rules;
  return modRuntime.withOnly(ids).applyRules(rules as ModRuleSet, { knownTeamIds: ALL_TEAM_IDS }) as RuleSet;
}

const teamConfigKeys: (keyof TeamConfig)[] = [
  "id", "name", "shortName", "city", "primaryColor", "secondaryColor",
  "stadiumBowlingRating", "stadiumName", "pitchType", "boundarySize", "dewFactor",
];

function toConfig(t: ModTeam): TeamConfig {
  const config: Record<string, unknown> = {};
  for (const k of teamConfigKeys) if (t[k] !== undefined) config[k] = t[k];
  return config as unknown as TeamConfig;
}

export function applyPendingMods(state: GameState, opts: { skipRules?: boolean } = {}): GameState {
  const ids = pendingDataMods(state);
  if (!ids.length || state.phase === "season") return state;
  const scoped = modRuntime.withOnly(ids);
  const hashes = new Map(modRuntime.list().map(s => [s.id, s.hash]));
  // Teams and players are mutable engine objects; they are edited in place, the container is new
  const next: GameState = { ...state, rules: { ...state.rules } };

  // ── Players: edited players are rebuilt in their existing slot; new ids go to their team (teamId) or the pool ──
  const before = [...state.teams.flatMap(t => t.roster), ...state.playerPool];
  const beforeById = new Map(before.map(p => [p.id, p]));
  const edited = scoped.applyPlayers(before.map(p => p.toJSON() as unknown as ModPlayer));
  const playerById = new Map<string, Player>();
  let changed = edited.length !== before.length;
  for (const data of edited) {
    const old = beforeById.get(data.id);
    if (old && JSON.stringify(old.toJSON()) === JSON.stringify(data)) {
      playerById.set(data.id, old);
    } else {
      changed = true;
      playerById.set(data.id, Player.fromJSON({ injured: false, injuryGamesLeft: 0, ...data } as never));
    }
  }
  if (changed) {
    for (const t of state.teams) t.roster = t.roster.filter(p => playerById.has(p.id)).map(p => playerById.get(p.id)!);
    const pool = state.playerPool.filter(p => playerById.has(p.id)).map(p => playerById.get(p.id)!);
    for (const data of edited) {
      if (beforeById.has(data.id)) continue;
      const added = playerById.get(data.id)!;
      const home = typeof data.teamId === "string" ? state.teams.find(t => t.id === data.teamId) : undefined;
      if (home) home.roster.push(added);
      else pool.push(added);
    }
    next.playerPool = pool;
  }

  // ── Teams: configs, squads, additions. If the user's team would vanish the whole result is dropped ──
  const teamInput: ModTeam[] = state.teams.map(t => ({ ...t.config, squad: t.roster.map(p => p.id) }));
  const editedTeams = scoped.applyTeams(teamInput);
  const keepsUser = !state.userTeamId || editedTeams.some(t => t.id === state.userTeamId);
  if (keepsUser && JSON.stringify(editedTeams) !== JSON.stringify(teamInput)) {
    const free = new Map<string, Player>();
    for (const p of next.playerPool) free.set(p.id, p);
    for (const t of state.teams) for (const p of t.roster) free.set(p.id, p);
    const claimed = new Set<string>();
    const rebuilt: Team[] = editedTeams.map(def => {
      const team = state.teams.find(t => t.id === def.id) ?? new Team(toConfig(def), state.rules.salaryCap);
      team.config = toConfig(def);
      return team;
    });
    // Teams whose squad changed claim their players first; every other team keeps what is left of its roster
    const changedSquad = editedTeams.map((def, i) =>
      !!def.squad && JSON.stringify(def.squad) !== JSON.stringify(rebuilt[i].roster.map(p => p.id)));
    editedTeams.forEach((def, i) => {
      if (!changedSquad[i]) return;
      const team = rebuilt[i];
      const roster: Player[] = [];
      for (const pid of def.squad!) {
        const p = free.get(pid);
        if (!p || claimed.has(pid)) continue;
        claimed.add(pid);
        p.teamId = def.id;
        roster.push(p);
      }
      team.roster = roster;
      team.totalSpent = roster.reduce((sum, p) => sum + (p.bid ?? 0), 0);
      team.userPlayingXI = undefined;
      team.userBattingOrder = undefined;
      team.userBowlingOrder = undefined;
    });
    rebuilt.forEach((team, i) => {
      if (changedSquad[i]) return;
      const kept = team.roster.filter(p => !claimed.has(p.id));
      if (kept.length !== team.roster.length) {
        team.roster = kept;
        team.totalSpent = kept.reduce((sum, p) => sum + (p.bid ?? 0), 0);
      }
      for (const p of kept) claimed.add(p.id);
    });
    for (const p of free.values()) if (!claimed.has(p.id)) p.teamId = undefined;
    next.teams = rebuilt;
    next.playerPool = [...free.values()].filter(p => !claimed.has(p.id));
    next.rules.teamIds = rebuilt.map(t => t.id);
  }

  // ── Rules: team membership stays whatever the teams hook left it as ──
  if (!opts.skipRules) {
    const currentIds = next.teams.map(t => t.id);
    const ruled = scoped.applyRules(next.rules as ModRuleSet, { knownTeamIds: [...ALL_TEAM_IDS, ...currentIds] }) as RuleSet;
    next.rules = { ...ruled, teamIds: currentIds };
  }

  next.modsApplied = [...(state.modsApplied ?? []), ...ids.map(id => key({ id, hash: hashes.get(id)! }))];
  return next;
}

/** Engine-affecting mods this save was played with that are missing or different now. Empty when compatible. */
export function describeSaveModMismatch(saved: { id: string; hash: string; engine: boolean }[] | undefined, current: { id: string; hash: string; engine: boolean }[]): string[] {
  const now = new Map(current.filter(m => m.engine).map(m => [m.id, m.hash]));
  const notes: string[] = [];
  for (const m of (saved ?? []).filter(x => x.engine)) {
    if (!now.has(m.id)) notes.push(`${m.id} (not enabled)`);
    else if (now.get(m.id) !== m.hash) notes.push(`${m.id} (different version)`);
  }
  return notes;
}
