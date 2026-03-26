/**
 * Two-tier persistence layer with multiple save slots:
 *
 * - localStorage: slot index, active slot ID, per-slot metadata
 * - IndexedDB: bulk data per slot (teams, player pool, season results, history)
 *
 * Also provides import/export functionality for save files,
 * including granular imports (custom players, team rosters).
 */

import { get, set, del, createStore } from "idb-keyval";
import {
  Player, Team, DEFAULT_RULES,
  createPlayerFromData, clamp,
  type RuleSet, type TradeOffer, type TeamConfig,
  type AuctionState,
} from "@ipl-sim/engine";
import type { GameState, SeasonSummary, CompletedTrade } from "./game-state";
import { clearAllMatchData as clearMatchDataOnClear } from "./match-db";
import { createScoutingState } from "./scouting";
import { createRecruitmentState } from "./recruitment";

// ── IndexedDB Store ──────────────────────────────────────────────────────

const DB_NAME = "ipl-sim";
const STORE_NAME = "game-data";
const idbStore = createStore(DB_NAME, STORE_NAME);

// IDB key suffixes (prefixed with slot:{id}: at runtime)
const IDB_KEYS = [
  "teams", "playerPool", "seasonResult", "auctionResult",
  "history", "tradeOffers", "completedTrades",
  "schedule", "matchResults", "recentInjuries", "narrativeEvents", "trainingReport",
  "scouting", "scoutingAssignments", "scoutingInbox", "recruitment", "youthProspects", "fantasyLeaderboard", "boardState",
  "contractReport", "auctionLiveState", "hallOfFame",
] as const;

function slotKey(slotId: string, key: string): string {
  return `slot:${slotId}:${key}`;
}

// ── localStorage Keys ────────────────────────────────────────────────────

const LS_PREFIX = "ipl-sim";
const LS_SLOTS = `${LS_PREFIX}:slots`;
const LS_ACTIVE_SLOT = `${LS_PREFIX}:activeSlot`;
const CURRENT_VERSION = 8; // bump: active scouting desk persistence

// Legacy keys (for migration)
const LS_META_LEGACY = `${LS_PREFIX}:meta`;
const LS_VERSION_LEGACY = `${LS_PREFIX}:version`;

function lsMeta(slotId: string): string {
  return `${LS_PREFIX}:meta:${slotId}`;
}

// ── Types ────────────────────────────────────────────────────────────────

interface SaveMeta {
  phase: GameState["phase"];
  seasonNumber: number;
  userTeamId: string | null;
  rules: RuleSet;
  retentionState?: GameState["retentionState"];
  contractsResolved?: boolean;
  // Season progress (lightweight scalars in localStorage)
  currentMatchIndex?: number;
  playoffsStarted?: boolean;
  needsLineup?: boolean;
}

export interface SaveSlotInfo {
  id: string;
  name: string;
  league: "ipl" | "wpl";
  season: number;
  teamName: string;
  updatedAt: string;
}

// ── ID generation ────────────────────────────────────────────────────────

function generateSlotId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Serialization helpers ────────────────────────────────────────────────

function serializeTeams(teams: Team[]) {
  return teams.map(t => ({
    config: t.config,
    roster: t.roster.map(p => p.toJSON()),
    salaryCap: t.salaryCap,
    totalSpent: t.totalSpent,
    wins: t.wins, losses: t.losses, ties: t.ties,
    nrr: t.nrr, runsFor: t.runsFor, ballsFacedFor: t.ballsFacedFor,
    runsAgainst: t.runsAgainst, ballsFacedAgainst: t.ballsFacedAgainst,
    isUserControlled: t.isUserControlled,
    userPlayingXI: t.userPlayingXI,
    userBattingOrder: t.userBattingOrder,
    userBowlingOrder: t.userBowlingOrder,
    trainingIntensity: t.trainingIntensity,
    bowlingPlan: t.bowlingPlan,
    batterAggression: t.batterAggression,
    bowlerFieldSettings: t.bowlerFieldSettings,
  }));
}

function deserializeTeams(data: any[]): Team[] {
  return data.map((t: any) => {
    const team = new Team(t.config, t.salaryCap);
    team.roster = t.roster.map((p: any) => Player.fromJSON(p));
    team.totalSpent = t.totalSpent ?? 0;
    team.wins = t.wins ?? 0;
    team.losses = t.losses ?? 0;
    team.ties = t.ties ?? 0;
    team.nrr = t.nrr ?? 0;
    team.runsFor = t.runsFor ?? 0;
    team.ballsFacedFor = t.ballsFacedFor ?? 0;
    team.runsAgainst = t.runsAgainst ?? 0;
    team.ballsFacedAgainst = t.ballsFacedAgainst ?? 0;
    team.isUserControlled = t.isUserControlled ?? false;
    team.userPlayingXI = t.userPlayingXI;
    team.userBattingOrder = t.userBattingOrder;
    team.userBowlingOrder = t.userBowlingOrder;
    team.trainingIntensity = t.trainingIntensity ?? "balanced";
    team.bowlingPlan = t.bowlingPlan;
    team.batterAggression = t.batterAggression;
    team.bowlerFieldSettings = t.bowlerFieldSettings;
    return team;
  });
}

function serializePlayers(players: Player[]) {
  return players.map(p => p.toJSON());
}

function deserializePlayers(data: any[]): Player[] {
  return data.map((p: any) => Player.fromJSON(p));
}

function serializeYouthProspects(prospects: GameState["youthProspects"]) {
  return prospects.map(prospect => ({
    ...prospect,
    player: prospect.player.toJSON(),
  }));
}

function deserializeYouthProspects(data: any[] | undefined): GameState["youthProspects"] {
  return (data ?? []).map((prospect: any) => ({
    ...prospect,
    player: Player.fromJSON(prospect.player),
  }));
}

function serializeAuctionLiveState(state: AuctionState) {
  return {
    ...state,
    players: serializePlayers(state.players),
    unsold: serializePlayers(state.unsold),
  };
}

function deserializeAuctionLiveState(data: any): AuctionState {
  return {
    ...data,
    players: deserializePlayers(data.players ?? []),
    unsold: deserializePlayers(data.unsold ?? []),
  };
}

// ── Save Slot Management ─────────────────────────────────────────────────

export function listSaveSlots(): SaveSlotInfo[] {
  try {
    const raw = localStorage.getItem(LS_SLOTS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeSlotsIndex(slots: SaveSlotInfo[]): void {
  try {
    localStorage.setItem(LS_SLOTS, JSON.stringify(slots));
  } catch { /* localStorage full */ }
}

export function getActiveSlotId(): string | null {
  return localStorage.getItem(LS_ACTIVE_SLOT);
}

export function setActiveSlotId(id: string | null): void {
  if (id) {
    localStorage.setItem(LS_ACTIVE_SLOT, id);
  } else {
    localStorage.removeItem(LS_ACTIVE_SLOT);
  }
}

export function createSaveSlot(name: string, state: GameState): string {
  const id = generateSlotId();
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const info: SaveSlotInfo = {
    id,
    name,
    league: state.rules.league === "wpl" ? "wpl" : "ipl",
    season: state.seasonNumber,
    teamName: userTeam?.name ?? "Unknown",
    updatedAt: new Date().toISOString(),
  };
  const slots = listSaveSlots();
  slots.push(info);
  writeSlotsIndex(slots);
  return id;
}

function updateSlotInfo(slotId: string, state: GameState): void {
  const slots = listSaveSlots();
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  slot.season = state.seasonNumber;
  slot.teamName = userTeam?.name ?? slot.teamName;
  slot.name = `${slot.teamName} — Season ${state.seasonNumber}`;
  slot.updatedAt = new Date().toISOString();
  writeSlotsIndex(slots);
}

export async function deleteSaveSlot(slotId: string): Promise<void> {
  // Remove IDB data
  try {
    await Promise.all(
      IDB_KEYS.map(key => del(slotKey(slotId, key), idbStore))
    );
  } catch { /* ignore */ }

  // Remove localStorage meta
  localStorage.removeItem(lsMeta(slotId));

  // Remove from index
  const slots = listSaveSlots().filter(s => s.id !== slotId);
  writeSlotsIndex(slots);

  // Clear active if it was this slot
  if (getActiveSlotId() === slotId) {
    setActiveSlotId(null);
  }
}

// ── Save State (to active slot) ──────────────────────────────────────────

export async function saveState(state: GameState): Promise<void> {
  let slotId = getActiveSlotId();

  // Auto-create slot if none exists and user has selected a team
  if (!slotId && state.userTeamId) {
    const userTeam = state.teams.find(t => t.id === state.userTeamId);
    const name = `${userTeam?.name ?? "Game"} — Season ${state.seasonNumber}`;
    slotId = createSaveSlot(name, state);
    setActiveSlotId(slotId);
  }

  if (!slotId) return; // no slot, no save (setup phase before team selection)

  // Update slot index info
  updateSlotInfo(slotId, state);

  // Write metadata to localStorage
  const meta: SaveMeta = {
    phase: state.phase,
    seasonNumber: state.seasonNumber,
    userTeamId: state.userTeamId,
    rules: state.rules,
    retentionState: state.retentionState,
    contractsResolved: state.contractsResolved,
    currentMatchIndex: state.currentMatchIndex,
    playoffsStarted: state.playoffsStarted,
    needsLineup: state.needsLineup,
  };

  try {
    localStorage.setItem(lsMeta(slotId), JSON.stringify(meta));
  } catch { /* localStorage full */ }

  // Write bulk data to IndexedDB
  try {
    await Promise.all([
      set(slotKey(slotId, "teams"), serializeTeams(state.teams), idbStore),
      set(slotKey(slotId, "playerPool"), serializePlayers(state.playerPool), idbStore),
      set(slotKey(slotId, "seasonResult"), state.seasonResult, idbStore),
      set(slotKey(slotId, "auctionResult"), state.auctionResult, idbStore),
      set(slotKey(slotId, "history"), state.history, idbStore),
      set(slotKey(slotId, "tradeOffers"), state.tradeOffers, idbStore),
      set(slotKey(slotId, "completedTrades"), state.completedTrades, idbStore),
      set(slotKey(slotId, "schedule"), state.schedule, idbStore),
      set(slotKey(slotId, "matchResults"), state.matchResults, idbStore),
      set(slotKey(slotId, "recentInjuries"), state.recentInjuries, idbStore),
      set(slotKey(slotId, "narrativeEvents"), state.narrativeEvents, idbStore),
      set(slotKey(slotId, "trainingReport"), state.trainingReport, idbStore),
      set(slotKey(slotId, "scouting"), state.scouting, idbStore),
      set(slotKey(slotId, "scoutingAssignments"), state.scoutingAssignments, idbStore),
      set(slotKey(slotId, "scoutingInbox"), state.scoutingInbox, idbStore),
      set(slotKey(slotId, "recruitment"), state.recruitment, idbStore),
      set(slotKey(slotId, "youthProspects"), serializeYouthProspects(state.youthProspects), idbStore),
      set(slotKey(slotId, "fantasyLeaderboard"), state.fantasyLeaderboard, idbStore),
      set(slotKey(slotId, "boardState"), state.boardState, idbStore),
      set(slotKey(slotId, "contractReport"), state.contractReport, idbStore),
      set(slotKey(slotId, "auctionLiveState"), state.auctionLiveState
        ? serializeAuctionLiveState(state.auctionLiveState) : undefined, idbStore),
      set(slotKey(slotId, "hallOfFame"), state.hallOfFame ?? [], idbStore),
    ]);
  } catch { /* IDB write failed */ }
}

// ── Load State ───────────────────────────────────────────────────────────

export async function loadState(): Promise<GameState | null> {
  try {
    // Try migrating legacy data first
    const migrated = await migrateLegacyData();
    if (migrated) return migrated;

    const slotId = getActiveSlotId();
    if (!slotId) return null;
    return loadStateFromSlot(slotId);
  } catch {
    // If anything fails (corrupted IDB, etc.), start fresh
    return null;
  }
}

export async function loadStateFromSlot(slotId: string): Promise<GameState | null> {
  try {
    const [teamsData, poolData, seasonResult, auctionResult, history, tradeOffers, completedTrades,
           schedule, matchResults, recentInjuries, narrativeEvents, trainingReport, scouting,
           scoutingAssignments, scoutingInbox,
           recruitment, youthProspects, fantasyLeaderboard, boardState, contractReport, auctionLiveStateRaw] =
      await Promise.all([
        get(slotKey(slotId, "teams"), idbStore),
        get(slotKey(slotId, "playerPool"), idbStore),
        get(slotKey(slotId, "seasonResult"), idbStore),
        get(slotKey(slotId, "auctionResult"), idbStore),
        get(slotKey(slotId, "history"), idbStore),
        get(slotKey(slotId, "tradeOffers"), idbStore),
        get(slotKey(slotId, "completedTrades"), idbStore),
        get(slotKey(slotId, "schedule"), idbStore),
        get(slotKey(slotId, "matchResults"), idbStore),
        get(slotKey(slotId, "recentInjuries"), idbStore),
        get(slotKey(slotId, "narrativeEvents"), idbStore),
        get(slotKey(slotId, "trainingReport"), idbStore),
        get(slotKey(slotId, "scouting"), idbStore),
        get(slotKey(slotId, "scoutingAssignments"), idbStore),
        get(slotKey(slotId, "scoutingInbox"), idbStore),
        get(slotKey(slotId, "recruitment"), idbStore),
        get(slotKey(slotId, "youthProspects"), idbStore),
        get(slotKey(slotId, "fantasyLeaderboard"), idbStore),
        get(slotKey(slotId, "boardState"), idbStore),
        get(slotKey(slotId, "contractReport"), idbStore),
        get(slotKey(slotId, "auctionLiveState"), idbStore),
      ]);

    if (!teamsData || !poolData) return null;

    let meta: SaveMeta;
    const metaRaw = localStorage.getItem(lsMeta(slotId));
    if (metaRaw) {
      meta = JSON.parse(metaRaw);
    } else {
      meta = { phase: "setup", seasonNumber: 1, userTeamId: null, rules: DEFAULT_RULES };
    }

    const teams = deserializeTeams(teamsData);
    const playerPool = deserializePlayers(poolData);

    return {
      phase: meta.phase,
      rules: meta.rules ?? DEFAULT_RULES,
      teams,
      userTeamId: meta.userTeamId,
      playerPool,
      auctionResult: auctionResult ?? null,
      seasonResult: seasonResult ?? null,
      seasonNumber: meta.seasonNumber,
      history: history ?? [],
      tradeOffers: tradeOffers ?? [],
      completedTrades: completedTrades ?? [],
      schedule: schedule ?? [],
      currentMatchIndex: meta.currentMatchIndex ?? 0,
      matchResults: matchResults ?? [],
      playoffsStarted: meta.playoffsStarted ?? false,
      needsLineup: meta.needsLineup ?? false,
      recentInjuries: recentInjuries ?? [],
      narrativeEvents: narrativeEvents ?? [],
      trainingReport: trainingReport ?? [],
      scouting: scouting ?? createScoutingState(teams, playerPool, meta.userTeamId, meta.seasonNumber),
      scoutingAssignments: scoutingAssignments ?? [],
      scoutingInbox: scoutingInbox ?? [],
      recruitment: recruitment ?? createRecruitmentState(),
      youthProspects: deserializeYouthProspects(youthProspects),
      fantasyLeaderboard: fantasyLeaderboard ?? [],
      boardState: boardState ?? undefined,
      contractReport: contractReport ?? undefined,
      contractsResolved: meta.contractsResolved ?? true,
      retentionState: meta.retentionState,
      auctionLiveState: auctionLiveStateRaw
        ? deserializeAuctionLiveState(auctionLiveStateRaw) : undefined,
    };
  } catch {
    return null;
  }
}

// ── Migration from legacy (non-slot) storage ─────────────────────────────

async function migrateLegacyData(): Promise<GameState | null> {
  // Check if we already have slots — no migration needed
  if (listSaveSlots().length > 0 || getActiveSlotId()) return null;

  // Try loading from old IDB keys (v2 format)
  try {
    const [teamsData, poolData, seasonResult, auctionResult, history, tradeOffers, completedTrades] =
      await Promise.all([
        get("teams", idbStore),
        get("playerPool", idbStore),
        get("seasonResult", idbStore),
        get("auctionResult", idbStore),
        get("history", idbStore),
        get("tradeOffers", idbStore),
        get("completedTrades", idbStore),
      ]);

    if (teamsData && poolData) {
      let meta: SaveMeta;
      const metaRaw = localStorage.getItem(LS_META_LEGACY);
      if (metaRaw) {
        meta = JSON.parse(metaRaw);
      } else {
        meta = { phase: "setup", seasonNumber: 1, userTeamId: null, rules: DEFAULT_RULES };
      }

      const state: GameState = {
        phase: meta.phase,
        rules: meta.rules ?? DEFAULT_RULES,
        teams: deserializeTeams(teamsData),
        userTeamId: meta.userTeamId,
        playerPool: deserializePlayers(poolData),
        auctionResult: auctionResult ?? null,
        seasonResult: seasonResult ?? null,
        seasonNumber: meta.seasonNumber,
        history: history ?? [],
        tradeOffers: tradeOffers ?? [],
        completedTrades: completedTrades ?? [],
        schedule: [],
        currentMatchIndex: 0,
        matchResults: [],
        playoffsStarted: false,
        needsLineup: false,
        recentInjuries: [],
        narrativeEvents: [],
        trainingReport: [],
        scouting: createScoutingState(deserializeTeams(teamsData), deserializePlayers(poolData), meta.userTeamId, meta.seasonNumber),
        scoutingAssignments: [],
        scoutingInbox: [],
        recruitment: createRecruitmentState(),
        youthProspects: [],
        fantasyLeaderboard: [],
        contractsResolved: true,
      };

      // Migrate into a new slot
      const userTeam = state.teams.find(t => t.id === state.userTeamId);
      const name = `${userTeam?.name ?? "Game"} — Season ${state.seasonNumber}`;
      const slotId = createSaveSlot(name, state);
      setActiveSlotId(slotId);
      await saveState(state);

      // Clean up legacy keys
      await Promise.all([
        del("teams", idbStore), del("playerPool", idbStore),
        del("seasonResult", idbStore), del("auctionResult", idbStore),
        del("history", idbStore), del("tradeOffers", idbStore),
        del("completedTrades", idbStore),
      ]).catch(() => {});
      localStorage.removeItem(LS_META_LEGACY);
      localStorage.removeItem(LS_VERSION_LEGACY);
      localStorage.removeItem("ipl-sim-state");

      return state;
    }
  } catch { /* ignore */ }

  // Try legacy localStorage-only format
  try {
    const raw = localStorage.getItem("ipl-sim-state");
    if (!raw) return null;
    const data = JSON.parse(raw);

    const state: GameState = {
      phase: data.phase,
      rules: data.rules ?? DEFAULT_RULES,
      teams: deserializeTeams(data.teams),
      userTeamId: data.userTeamId,
      playerPool: deserializePlayers(data.playerPool),
      auctionResult: data.auctionResult ?? null,
      seasonResult: data.seasonResult ?? null,
      seasonNumber: data.seasonNumber ?? 1,
      history: data.history ?? [],
      tradeOffers: data.tradeOffers ?? [],
      completedTrades: data.completedTrades ?? [],
      schedule: data.schedule ?? [],
      currentMatchIndex: data.currentMatchIndex ?? 0,
      matchResults: data.matchResults ?? [],
      playoffsStarted: data.playoffsStarted ?? false,
      needsLineup: data.needsLineup ?? false,
      recentInjuries: data.recentInjuries ?? [],
      narrativeEvents: data.narrativeEvents ?? [],
      trainingReport: data.trainingReport ?? [],
      scouting: data.scouting ?? createScoutingState(deserializeTeams(data.teams), deserializePlayers(data.playerPool), data.userTeamId, data.seasonNumber ?? 1),
      scoutingAssignments: data.scoutingAssignments ?? [],
      scoutingInbox: data.scoutingInbox ?? [],
      recruitment: data.recruitment ?? createRecruitmentState(),
      youthProspects: deserializeYouthProspects(data.youthProspects),
      fantasyLeaderboard: data.fantasyLeaderboard ?? [],
      boardState: data.boardState ?? undefined,
      contractReport: data.contractReport ?? undefined,
      contractsResolved: data.contractsResolved ?? true,
    };

    // Migrate into a slot
    const userTeam = state.teams.find(t => t.id === state.userTeamId);
    const name = `${userTeam?.name ?? "Game"} — Season ${state.seasonNumber}`;
    const slotId = createSaveSlot(name, state);
    setActiveSlotId(slotId);
    await saveState(state);
    localStorage.removeItem("ipl-sim-state");
    localStorage.removeItem(LS_META_LEGACY);
    localStorage.removeItem(LS_VERSION_LEGACY);

    return state;
  } catch {
    return null;
  }
}

// ── Clear State (active slot) ────────────────────────────────────────────

export async function clearState(): Promise<void> {
  const slotId = getActiveSlotId();
  if (slotId) {
    await deleteSaveSlot(slotId);
  }
  setActiveSlotId(null);
  // Also clean up any remaining legacy keys
  localStorage.removeItem(LS_META_LEGACY);
  localStorage.removeItem(LS_VERSION_LEGACY);
  localStorage.removeItem("ipl-sim-state");

  // Clear match detail data from IndexedDB
  try {
    await clearMatchDataOnClear();
  } catch { /* match-db may not be available */ }
}

// ── Export Save ──────────────────────────────────────────────────────────

export interface SaveFile {
  type: "full-save";
  version: number;
  exportedAt: string;
  meta: SaveMeta;
  teams: ReturnType<typeof serializeTeams>;
  playerPool: ReturnType<typeof serializePlayers>;
  seasonResult: any;
  auctionResult: any;
  history: SeasonSummary[];
  tradeOffers: TradeOffer[];
  completedTrades: CompletedTrade[];
  schedule?: any[];
  matchResults?: any[];
  narrativeEvents?: GameState["narrativeEvents"];
  trainingReport?: GameState["trainingReport"];
  scouting?: GameState["scouting"];
  scoutingAssignments?: GameState["scoutingAssignments"];
  scoutingInbox?: GameState["scoutingInbox"];
  recruitment?: GameState["recruitment"];
  youthProspects?: ReturnType<typeof serializeYouthProspects>;
  fantasyLeaderboard?: GameState["fantasyLeaderboard"];
  boardState?: GameState["boardState"];
  contractReport?: GameState["contractReport"];
}

/** Export current game state as a downloadable JSON file */
export function exportSave(state: GameState): void {
  const saveFile: SaveFile = {
    type: "full-save",
    version: CURRENT_VERSION,
    exportedAt: new Date().toISOString(),
    meta: {
      phase: state.phase,
      seasonNumber: state.seasonNumber,
      userTeamId: state.userTeamId,
      rules: state.rules,
      retentionState: state.retentionState,
      contractsResolved: state.contractsResolved,
      currentMatchIndex: state.currentMatchIndex,
      playoffsStarted: state.playoffsStarted,
      needsLineup: state.needsLineup,
    },
    teams: serializeTeams(state.teams),
    playerPool: serializePlayers(state.playerPool),
    seasonResult: state.seasonResult,
    auctionResult: state.auctionResult,
    history: state.history,
    tradeOffers: state.tradeOffers,
    completedTrades: state.completedTrades,
    schedule: state.schedule,
    matchResults: state.matchResults,
    narrativeEvents: state.narrativeEvents,
    trainingReport: state.trainingReport,
    scouting: state.scouting,
    scoutingAssignments: state.scoutingAssignments,
    scoutingInbox: state.scoutingInbox,
    recruitment: state.recruitment,
    youthProspects: serializeYouthProspects(state.youthProspects),
    fantasyLeaderboard: state.fantasyLeaderboard,
    boardState: state.boardState,
    contractReport: state.contractReport,
  };

  downloadJSON(saveFile, `${leaguePrefix(state)}-sim-season${state.seasonNumber}-${Date.now()}.json`);
}

// ── Import Save ──────────────────────────────────────────────────────────

/** Import a full save file and return the reconstructed game state */
export async function importSave(file: File): Promise<GameState> {
  const text = await file.text();
  const data = JSON.parse(text);

  // Support both old format (no type field) and new format
  if (data.type && data.type !== "full-save") {
    throw new Error(`Expected full save file, got "${data.type}"`);
  }

  if (!data.teams || !data.playerPool) {
    throw new Error("Invalid save file format");
  }

  if (!Array.isArray(data.teams) || data.teams.length === 0) {
    throw new Error("Invalid save: no teams found");
  }

  const teams = deserializeTeams(data.teams);
  const playerPool = deserializePlayers(data.playerPool);

  const state: GameState = {
    phase: data.meta.phase,
    rules: data.meta.rules ?? DEFAULT_RULES,
    teams,
    userTeamId: data.meta.userTeamId,
    playerPool,
    auctionResult: data.auctionResult ?? null,
    seasonResult: data.seasonResult ?? null,
    seasonNumber: data.meta.seasonNumber,
    history: data.history ?? [],
    tradeOffers: data.tradeOffers ?? [],
    completedTrades: data.completedTrades ?? [],
    schedule: data.schedule ?? [],
    currentMatchIndex: data.meta?.currentMatchIndex ?? data.currentMatchIndex ?? 0,
    matchResults: data.matchResults ?? [],
    playoffsStarted: data.meta?.playoffsStarted ?? data.playoffsStarted ?? false,
    needsLineup: data.meta?.needsLineup ?? data.needsLineup ?? false,
    recentInjuries: data.recentInjuries ?? [],
    narrativeEvents: data.narrativeEvents ?? [],
    trainingReport: data.trainingReport ?? [],
    scouting: data.scouting ?? createScoutingState(teams, playerPool, data.meta.userTeamId, data.meta.seasonNumber),
    scoutingAssignments: data.scoutingAssignments ?? [],
    scoutingInbox: data.scoutingInbox ?? [],
    recruitment: data.recruitment ?? createRecruitmentState(),
    youthProspects: deserializeYouthProspects(data.youthProspects),
    fantasyLeaderboard: data.fantasyLeaderboard ?? [],
    boardState: data.boardState ?? undefined,
    contractReport: data.contractReport ?? undefined,
    contractsResolved: data.meta?.contractsResolved ?? data.contractsResolved ?? true,
  };

  // Create a new slot for the import
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const name = `${userTeam?.name ?? "Imported"} — Season ${state.seasonNumber}`;
  const slotId = createSaveSlot(name, state);
  setActiveSlotId(slotId);
  await saveState(state);

  return state;
}

// ── Granular Imports ─────────────────────────────────────────────────────

/** File format for importing custom player ratings */
export interface PlayerRatingsFile {
  type: "player-ratings";
  version: 1;
  players: {
    name: string;
    age: number;
    country: string;
    role?: string;
    teamId?: string;
    battingIQ: number;
    timing: number;
    power: number;
    running: number;
    wicketTaking: number;
    economy: number;
    accuracy: number;
    clutch: number;
  }[];
}

/** File format for importing a team roster */
export interface TeamRosterFile {
  type: "team-roster";
  version: 1;
  team: {
    config: TeamConfig;
    roster: any[]; // Player.toJSON() format
    totalSpent: number;
    salaryCap: number;
  };
}

/** Import custom players from a player-ratings file. Returns new Player objects. */
export async function importCustomPlayers(file: File): Promise<Player[]> {
  const text = await file.text();
  const data = JSON.parse(text);

  if (data.type !== "player-ratings" || !Array.isArray(data.players)) {
    throw new Error("Invalid player ratings file");
  }

  const players: Player[] = [];
  for (const entry of data.players) {
    if (!entry.name || typeof entry.age !== "number" || !entry.country) continue;
    // Validate and clamp all 8 rating fields
    const ratings = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"] as const;
    const hasAllRatings = ratings.every(r => typeof entry[r] === "number");
    if (!hasAllRatings) continue;

    try {
      const clamped = {
        name: entry.name,
        age: clamp(entry.age, 15, 50),
        country: entry.country,
        role: entry.role,
        battingIQ: clamp(entry.battingIQ, 1, 99),
        timing: clamp(entry.timing, 1, 99),
        power: clamp(entry.power, 1, 99),
        running: clamp(entry.running, 1, 99),
        wicketTaking: clamp(entry.wicketTaking, 1, 99),
        economy: clamp(entry.economy, 1, 99),
        accuracy: clamp(entry.accuracy, 1, 99),
        clutch: clamp(entry.clutch, 1, 99),
      };
      players.push(createPlayerFromData(clamped));
    } catch {
      // Skip malformed entries
    }
  }

  if (players.length === 0) {
    throw new Error("No valid players found in file");
  }

  return players;
}

/** Import a team roster file. Returns the team config and players. */
export async function importTeamRoster(file: File): Promise<{
  config: TeamConfig;
  players: Player[];
  totalSpent: number;
}> {
  const text = await file.text();
  const data = JSON.parse(text);

  if (data.type !== "team-roster" || !data.team) {
    throw new Error("Invalid team roster file");
  }

  const { config, roster, totalSpent } = data.team;

  if (!config?.id || !config?.name || !Array.isArray(roster)) {
    throw new Error("Invalid team roster format");
  }

  const players = roster.map((p: any) => Player.fromJSON(p));

  return { config, players, totalSpent: totalSpent ?? 0 };
}

/** Detect the type of an import file without fully parsing it */
export async function detectImportType(file: File): Promise<"full-save" | "player-ratings" | "team-roster" | "unknown"> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.type === "player-ratings") return "player-ratings";
    if (data.type === "team-roster") return "team-roster";
    if (data.type === "full-save" || (data.teams && data.playerPool && data.meta)) return "full-save";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function leaguePrefix(state: GameState): string {
  return state.rules.league === "wpl" ? "wpl" : "ipl";
}

function downloadJSON(data: any, filename: string): void {
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
