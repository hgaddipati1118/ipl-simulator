/**
 * Player draft — an alternative to the auction for building squads.
 *
 * Everything here is a pure, deterministic state machine: `applyDraftAction(state, action)`
 * returns a new state and never mutates its input. AI choices draw from a seeded RNG whose
 * state lives inside DraftState, so a multiplayer host can be the single authority and any
 * peer replaying the same actions reaches the same board.
 *
 * Used by:
 *   - the season draft (every team drafts its whole squad; replaces the auction), and
 *   - Draft Match (two or more sides draft an XI each from one pool, then play).
 */

import type { Player, PlayerRole, BowlingStyle, BattingHand } from "./player.js";

// ── Types ───────────────────────────────────────────────────────────────

export type DraftType = "snake" | "linear";
export type DraftAiPersonality = "balanced" | "star-chaser" | "youth" | "bowling-first" | "batting-first";

/** Serializable player summary used on the draft board (and sent between peers). */
export interface DraftPlayer {
  id: string;
  name: string;
  role: PlayerRole;
  isWicketKeeper: boolean;
  isInternational: boolean;
  overall: number;
  battingOvr: number;
  bowlingOvr: number;
  age: number;
  country: string;
  bowlingStyle?: BowlingStyle;
  battingHand?: BattingHand;
  potential?: number;
  imageUrl?: string;
  /** Market value in crores, for display ("value") */
  value?: number;
}

export interface DraftSeat {
  id: string;            // team id (season draft) or side id (draft match)
  name: string;
  controller: "human" | "ai";
  /** Peer id of the human controlling this seat (multiplayer); undefined for local/AI */
  ownerId?: string;
  personality?: DraftAiPersonality;
}

export interface DraftConfig {
  type: DraftType;
  /** Picks per seat (= squad size for the draft) */
  rounds: number;
  /** Max overseas players per squad (undefined = no limit) */
  maxOverseas?: number;
  /** Max overseas in a playing XI; the squad must leave room for a legal XI */
  maxOverseasInXI?: number;
  minWicketKeepers: number;
  /** Genuine bowling options (bowlers + all-rounders, not the keeper) */
  minBowlingOptions: number;
  /** Seconds per pick for the UI/host clock (0 = no clock). Not enforced by the engine. */
  pickSeconds: number;
  /** Career mode: AI values youth/potential more */
  careerMode?: boolean;
  seed: number;
}

export interface DraftPick {
  /** 1-based overall pick number */
  pickNo: number;
  /** 1-based round */
  round: number;
  seatId: string;
  playerId: string;
  auto: boolean;
}

export type DraftStatus = "pending" | "in-progress" | "paused" | "complete";

export interface DraftState {
  config: DraftConfig;
  seats: DraftSeat[];
  /** Seat id for every pick slot, in order (length = seats × rounds) */
  order: string[];
  picks: DraftPick[];
  pool: DraftPlayer[];
  /** playerId → seatId for drafted players (keepers included) */
  taken: Record<string, string>;
  /** seatId → playerIds, in pick order (keepers first) */
  squads: Record<string, string[]>;
  /** Players pre-assigned before the draft (keeper/retention round); they use up rounds */
  keepers: Record<string, string[]>;
  status: DraftStatus;
  /** Seeded RNG state for AI picks (mulberry32) */
  rngState: number;
}

export type DraftAction =
  | { type: "start" }
  | { type: "pick"; seatId: string; playerId: string; auto?: boolean }
  /** Let the AI choose for this seat (AI seat, timer expiry, disconnected human). `queue` = the human's watchlist, tried first. */
  | { type: "auto-pick"; seatId: string; queue?: string[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "undo" }
  | { type: "set-controller"; seatId: string; controller: "human" | "ai"; ownerId?: string };

export interface DraftActionResult {
  state: DraftState;
  error?: string;
  pick?: DraftPick;
}

export interface SquadNeeds {
  slotsLeft: number;
  wicketKeepers: number;      // still needed
  bowlingOptions: number;     // still needed
  overseasLeft: number;       // Infinity if no limit
  /** Domestic players still needed so the squad can field a legal XI */
  domesticNeeded: number;
}

// ── Small deterministic RNG (mulberry32 with explicit state) ────────────

function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Genuine bowling option: a bowler or all-rounder who isn't the keeper (matches Team.autoBowlingOrder). */
export function isDraftBowlingOption(p: Pick<DraftPlayer, "role" | "isWicketKeeper">): boolean {
  return !p.isWicketKeeper && (p.role === "bowler" || p.role === "all-rounder");
}

export function toDraftPlayer(p: Player): DraftPlayer {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    isWicketKeeper: p.isWicketKeeper,
    isInternational: p.isInternational,
    overall: p.overall,
    battingOvr: p.battingOvr,
    bowlingOvr: p.bowlingOvr,
    age: p.age,
    country: p.country,
    bowlingStyle: p.bowlingStyle,
    battingHand: p.battingHand,
    potential: p.potential,
    imageUrl: p.imageUrl,
    value: Math.round(p.marketValue * 100) / 100,
  };
}

/** Pick order for `rounds` rounds. Snake reverses every other round (2 seats → ABBA ABBA…). */
export function buildPickOrder(seatIds: string[], rounds: number, type: DraftType): string[] {
  const order: string[] = [];
  for (let r = 0; r < rounds; r++) {
    const row = type === "snake" && r % 2 === 1 ? [...seatIds].reverse() : seatIds;
    order.push(...row);
  }
  return order;
}

/** Deterministic coin toss / shuffle of seat order from a seed. Returns [order, rngState]. */
export function shuffleSeats<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed | 0;
  for (let i = out.length - 1; i > 0; i--) {
    const [r, ns] = nextRandom(s);
    s = ns;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const DEFAULT_PERSONALITIES: DraftAiPersonality[] = ["balanced", "star-chaser", "bowling-first", "youth", "batting-first"];

// ── Creation ────────────────────────────────────────────────────────────

export function createDraft(input: {
  config: DraftConfig;
  seats: DraftSeat[];
  pool: DraftPlayer[];
  keepers?: Record<string, string[]>;
}): DraftState {
  const { config, pool } = input;
  const seats = input.seats.map((s, i) => ({
    ...s,
    personality: s.personality ?? DEFAULT_PERSONALITIES[i % DEFAULT_PERSONALITIES.length],
  }));
  const keepers = input.keepers ?? {};
  const poolIds = new Set(pool.map(p => p.id));
  const taken: Record<string, string> = {};
  const squads: Record<string, string[]> = {};
  for (const seat of seats) {
    squads[seat.id] = [];
    for (const pid of keepers[seat.id] ?? []) {
      if (!poolIds.has(pid) || taken[pid]) continue;
      if (squads[seat.id].length >= config.rounds) break;
      taken[pid] = seat.id;
      squads[seat.id].push(pid);
    }
  }

  // Each seat only drafts the rounds its keepers haven't filled. Build the full order, then
  // drop slots for seats that are already full at that point.
  const fullOrder = buildPickOrder(seats.map(s => s.id), config.rounds, config.type);
  const remaining: Record<string, number> = {};
  for (const seat of seats) remaining[seat.id] = config.rounds - squads[seat.id].length;
  const order = fullOrder.filter(seatId => {
    if (remaining[seatId] <= 0) return false;
    remaining[seatId]--;
    return true;
  });

  return {
    config,
    seats,
    order,
    picks: [],
    pool,
    taken,
    squads,
    keepers,
    status: "pending",
    rngState: config.seed | 0,
  };
}

// ── Queries ─────────────────────────────────────────────────────────────

export function getCurrentSeatId(state: DraftState): string | null {
  if (state.status === "complete") return null;
  return state.order[state.picks.length] ?? null;
}

export function getCurrentRound(state: DraftState): number {
  const seatId = getCurrentSeatId(state);
  if (!seatId) return state.config.rounds;
  return Math.min(state.config.rounds, (state.squads[seatId]?.length ?? 0) + 1);
}

export function isDraftComplete(state: DraftState): boolean {
  return state.picks.length >= state.order.length;
}

export function getDraftPlayer(state: DraftState, playerId: string): DraftPlayer | undefined {
  return poolIndex(state).get(playerId);
}

const indexCache = new WeakMap<DraftPlayer[], Map<string, DraftPlayer>>();
function poolIndex(state: DraftState): Map<string, DraftPlayer> {
  let idx = indexCache.get(state.pool);
  if (!idx) {
    idx = new Map(state.pool.map(p => [p.id, p]));
    indexCache.set(state.pool, idx);
  }
  return idx;
}

export function getSquad(state: DraftState, seatId: string): DraftPlayer[] {
  const idx = poolIndex(state);
  return (state.squads[seatId] ?? []).map(id => idx.get(id)).filter((p): p is DraftPlayer => !!p);
}

export function getAvailablePlayers(state: DraftState): DraftPlayer[] {
  return state.pool.filter(p => !state.taken[p.id]);
}

export function getSquadNeeds(state: DraftState, seatId: string): SquadNeeds {
  return needsFor(getSquad(state, seatId), state.config);
}

function needsFor(squad: DraftPlayer[], config: DraftConfig): SquadNeeds {
  const wk = squad.filter(p => p.isWicketKeeper).length;
  const bowl = squad.filter(isDraftBowlingOption).length;
  const overseas = squad.filter(p => p.isInternational).length;
  const domestic = squad.length - overseas;
  const xiSize = Math.min(11, config.rounds);
  const domesticForXI = config.maxOverseasInXI === undefined ? 0 : Math.max(0, xiSize - config.maxOverseasInXI);
  return {
    slotsLeft: Math.max(0, config.rounds - squad.length),
    wicketKeepers: Math.max(0, config.minWicketKeepers - wk),
    bowlingOptions: Math.max(0, config.minBowlingOptions - bowl),
    overseasLeft: config.maxOverseas === undefined ? Infinity : Math.max(0, config.maxOverseas - overseas),
    domesticNeeded: Math.max(0, domesticForXI - domestic),
  };
}

interface BoardCounts {
  wkAvail: number;
  bowlAvail: number;
  domWK: number;
  domBowl: number;
  needWK: number;
  needBowl: number;
  seatWK: (seatId: string) => number;
  seatBowl: (seatId: string) => number;
}

/** Availability + outstanding needs for the whole board (cached per board position). */
const boardCache = new WeakMap<Record<string, string>, BoardCounts>();
function boardCounts(state: DraftState): BoardCounts {
  const hit = boardCache.get(state.taken);
  if (hit) return hit;
  let wkAvail = 0;
  let bowlAvail = 0;
  let domWK = 0;
  let domBowl = 0;
  for (const p of state.pool) {
    if (state.taken[p.id]) continue;
    if (p.isWicketKeeper) { wkAvail++; if (!p.isInternational) domWK++; }
    else if (isDraftBowlingOption(p)) { bowlAvail++; if (!p.isInternational) domBowl++; }
  }
  const wk = new Map<string, number>();
  const bowl = new Map<string, number>();
  let needWK = 0;
  let needBowl = 0;
  for (const seat of state.seats) {
    const n = getSquadNeeds(state, seat.id);
    const w = Math.min(n.wicketKeepers, n.slotsLeft);
    const b = Math.min(n.bowlingOptions, Math.max(0, n.slotsLeft - w));
    wk.set(seat.id, w);
    bowl.set(seat.id, b);
    needWK += w;
    needBowl += b;
  }
  const counts: BoardCounts = {
    wkAvail, bowlAvail, domWK, domBowl, needWK, needBowl,
    seatWK: id => wk.get(id) ?? 0,
    seatBowl: id => bowl.get(id) ?? 0,
  };
  boardCache.set(state.taken, counts);
  return counts;
}

/** Why `player` can't be picked by `seatId` right now, or null if it's legal. */
export function getPickError(state: DraftState, seatId: string, playerId: string): string | null {
  const player = getDraftPlayer(state, playerId);
  if (!player) return "Unknown player";
  if (state.taken[playerId]) return "Already drafted";
  const squad = getSquad(state, seatId);
  if (squad.length >= state.config.rounds) return "Squad is full";
  const before = needsFor(squad, state.config);
  if (player.isInternational && before.overseasLeft <= 0) return "Overseas limit reached";

  const after = needsFor([...squad, player], state.config);
  // The remaining slots must still be able to cover every minimum. A keeper can't count as a
  // bowling option, and keepers/bowlers may be domestic, so the domestic need overlaps the others.
  const roleNeed = after.wicketKeepers + after.bowlingOptions;
  if (after.slotsLeft < roleNeed) {
    return after.wicketKeepers > 0 && after.slotsLeft <= after.wicketKeepers
      ? "Need a wicket-keeper"
      : "Need more bowling options";
  }
  if (after.slotsLeft < after.domesticNeeded) return "Need domestic players for a legal XI";
  if (after.slotsLeft < Math.max(roleNeed, after.domesticNeeded)) return "Squad needs can't be met";

  // Make sure the pool can still supply what every seat still needs. If the board is already
  // short overall (thin pool), only this seat's own needs are checked so the draft can go on.
  const board = boardCounts(state);
  const othersWK = board.needWK - board.seatWK(seatId);
  const othersBowl = board.needBowl - board.seatBowl(seatId);
  const isWK = player.isWicketKeeper;
  const isBowl = isDraftBowlingOption(player);
  const wkLeft = board.wkAvail - (isWK ? 1 : 0);
  const bowlLeft = board.bowlAvail - (isBowl ? 1 : 0);
  const feasibleWK = board.wkAvail >= before.wicketKeepers + othersWK;
  const feasibleBowl = board.bowlAvail >= before.bowlingOptions + othersBowl;
  if (wkLeft < after.wicketKeepers + (feasibleWK ? othersWK : 0)) return "Not enough wicket-keepers left";
  if (bowlLeft < after.bowlingOptions + (feasibleBowl ? othersBowl : 0)) return "Not enough bowlers left";

  // This seat can only sign as many overseas players as it has slots left: the keepers and
  // bowlers it still needs must be reachable within that.
  if (after.overseasLeft !== Infinity && (after.wicketKeepers > 0 || after.bowlingOptions > 0)) {
    const domWKLeft = board.domWK - (isWK && !player.isInternational ? 1 : 0);
    const domBowlLeft = board.domBowl - (isBowl && !player.isInternational ? 1 : 0);
    const osWKLeft = wkLeft - domWKLeft;
    const osBowlLeft = bowlLeft - domBowlLeft;
    const wkFromOs = Math.max(0, after.wicketKeepers - domWKLeft);
    if (wkFromOs > Math.min(after.overseasLeft, osWKLeft)) return "Need a domestic wicket-keeper";
    const bowlFromOs = Math.max(0, after.bowlingOptions - domBowlLeft);
    if (bowlFromOs > Math.min(after.overseasLeft - wkFromOs, osBowlLeft)) return "Need domestic bowlers";
  }
  return null;
}

/**
 * Last-resort pick when no player passes the full rules (very thin pools): best available that
 * respects the overseas limit, else anyone. Keeps a draft from ever stalling.
 */
function relaxedPick(state: DraftState, seatId: string): string | null {
  const squad = getSquad(state, seatId);
  if (squad.length >= state.config.rounds) return null;
  const needs = needsFor(squad, state.config);
  const avail = getAvailablePlayers(state);
  const score = (p: DraftPlayer) =>
    p.overall + (needs.wicketKeepers > 0 && p.isWicketKeeper ? 30 : 0) + (needs.bowlingOptions > 0 && isDraftBowlingOption(p) ? 20 : 0);
  const withinOs = avail.filter(p => !p.isInternational || needs.overseasLeft > 0);
  const list = (withinOs.length ? withinOs : avail).sort((a, b) => score(b) - score(a));
  return list[0]?.id ?? null;
}

export function getLegalPlayers(state: DraftState, seatId: string): DraftPlayer[] {
  return getAvailablePlayers(state).filter(p => getPickError(state, seatId, p.id) === null);
}

/**
 * Can this squad field a legal XI? (≥ min keepers, ≥ min bowling options, overseas within the XI cap.)
 */
export function canFieldValidXI(
  squad: DraftPlayer[],
  opts: { minWicketKeepers?: number; minBowlingOptions?: number; maxOverseasInXI?: number } = {},
): boolean {
  if (squad.length < 11) return false;
  const minWK = opts.minWicketKeepers ?? 1;
  const minBowl = opts.minBowlingOptions ?? 5;
  const maxOs = opts.maxOverseasInXI ?? 11;
  const domWK = squad.filter(p => p.isWicketKeeper && !p.isInternational).length;
  const osWK = squad.filter(p => p.isWicketKeeper && p.isInternational).length;
  const domBowl = squad.filter(p => isDraftBowlingOption(p) && !p.isInternational).length;
  const osBowl = squad.filter(p => isDraftBowlingOption(p) && p.isInternational).length;
  const domOther = squad.filter(p => !p.isWicketKeeper && !isDraftBowlingOption(p) && !p.isInternational).length;
  const osOther = squad.length - domWK - osWK - domBowl - osBowl - domOther;
  // Greedy: prefer domestic for the required roles, then fill the rest within the overseas cap.
  const wkDom = Math.min(domWK, minWK);
  const wkOs = minWK - wkDom;
  if (wkOs > osWK) return false;
  const bowlDom = Math.min(domBowl, minBowl);
  const bowlOs = minBowl - bowlDom;
  if (bowlOs > osBowl) return false;
  const osUsed = wkOs + bowlOs;
  if (osUsed > maxOs) return false;
  const restDomestic = (domWK - wkDom) + (domBowl - bowlDom) + domOther;
  const restOverseas = Math.min((osWK - wkOs) + (osBowl - bowlOs) + osOther, maxOs - osUsed);
  return minWK + minBowl + restDomestic + restOverseas >= 11;
}

/** Average overall of the best XI-sized group (a simple strength number for balance checks). */
export function squadStrength(squad: DraftPlayer[], xiSize = 11): number {
  if (squad.length === 0) return 0;
  const top = [...squad].sort((a, b) => b.overall - a.overall).slice(0, xiSize);
  return Math.round((top.reduce((s, p) => s + p.overall, 0) / top.length) * 10) / 10;
}

// ── AI ──────────────────────────────────────────────────────────────────

function aiScore(state: DraftState, seat: DraftSeat, player: DraftPlayer, squad: DraftPlayer[]): number {
  const cfg = state.config;
  const needs = needsFor(squad, cfg);
  let score = player.overall;

  // Age / potential (career mode cares about the long term)
  if (cfg.careerMode) {
    if (player.age < 25) score += (25 - player.age) * 0.4 + Math.max(0, (player.potential ?? 0) - player.overall) * 0.1;
    if (player.age > 33) score -= (player.age - 33) * 1.0;
  } else if (player.age > 36) {
    score -= (player.age - 36) * 0.5;
  }

  // Squad needs: urgency rises as slots run out.
  const tight = needs.slotsLeft <= needs.wicketKeepers + needs.bowlingOptions + 2;
  const midway = squad.length >= cfg.rounds * 0.45;
  const osTight = needs.overseasLeft !== Infinity && needs.overseasLeft <= needs.wicketKeepers + 1;
  if (needs.wicketKeepers > 0 && player.isWicketKeeper) {
    score += tight ? 18 : midway ? 12 : 5;
    // Keepers are scarce: once overseas slots run low, grab a domestic one
    if (osTight && !player.isInternational) score += 8;
  }
  if (needs.bowlingOptions > 0 && isDraftBowlingOption(player)) score += tight ? 12 : 3;
  if (needs.domesticNeeded > 0 && !player.isInternational && needs.slotsLeft <= needs.domesticNeeded + 2) score += 10;

  // Role balance: avoid piling up one discipline
  const bowlers = squad.filter(isDraftBowlingOption).length;
  const batters = squad.filter(p => p.role === "batsman" || p.isWicketKeeper).length;
  if (isDraftBowlingOption(player) && bowlers > batters + 3) score -= 4;
  if ((player.role === "batsman" || player.isWicketKeeper) && batters > bowlers + 3) score -= 4;
  if (player.isWicketKeeper && squad.filter(p => p.isWicketKeeper).length >= Math.max(2, cfg.minWicketKeepers + 1)) score -= 8;

  // Overseas slots are scarce: spend them on players clearly better than average
  if (player.isInternational && needs.overseasLeft !== Infinity) {
    const osScarcity = needs.overseasLeft <= 2 ? 3 : 1;
    score -= osScarcity;
  }

  switch (seat.personality) {
    case "star-chaser": score += Math.max(0, player.overall - 82) * 0.3; break;
    case "youth": if (player.age <= 24) score += 2; if (player.age >= 32) score -= 1.5; break;
    case "bowling-first": score += isDraftBowlingOption(player) ? 1.5 : 0; break;
    case "batting-first": score += player.role === "batsman" || player.isWicketKeeper ? 1.5 : 0; break;
    default: break;
  }
  return score;
}

/** Choose a player for `seatId` (AI logic). Returns the player id and the new RNG state. */
export function chooseAiPick(state: DraftState, seatId: string, queue?: string[]): { playerId: string | null; rngState: number } {
  // A human's queue wins if any of it is still legal
  if (queue) {
    for (const pid of queue) {
      if (getPickError(state, seatId, pid) === null) return { playerId: pid, rngState: state.rngState };
    }
  }
  const seat = state.seats.find(s => s.id === seatId);
  const legal = getLegalPlayers(state, seatId);
  if (!seat) return { playerId: null, rngState: state.rngState };
  if (legal.length === 0) return { playerId: relaxedPick(state, seatId), rngState: state.rngState };
  const squad = getSquad(state, seatId);

  let rng = state.rngState;
  const scored = legal.map(p => {
    const [r, ns] = nextRandom(rng);
    rng = ns;
    return { p, score: aiScore(state, seat, p, squad) + r * 2 };
  }).sort((a, b) => b.score - a.score);

  // Mostly the best, sometimes the 2nd/3rd: a little variety between drafts
  const [r, ns] = nextRandom(rng);
  rng = ns;
  const k = r < 0.8 ? 0 : r < 0.96 ? 1 : 2;
  const choice = scored[Math.min(k, scored.length - 1)];
  return { playerId: choice.p.id, rngState: rng };
}

// ── State machine ───────────────────────────────────────────────────────

function withPick(state: DraftState, seatId: string, playerId: string, auto: boolean, rngState = state.rngState): DraftActionResult {
  const pick: DraftPick = {
    pickNo: state.picks.length + 1,
    round: (state.squads[seatId]?.length ?? 0) + 1,
    seatId,
    playerId,
    auto,
  };
  const picks = [...state.picks, pick];
  const next: DraftState = {
    ...state,
    picks,
    taken: { ...state.taken, [playerId]: seatId },
    squads: { ...state.squads, [seatId]: [...(state.squads[seatId] ?? []), playerId] },
    rngState,
    status: picks.length >= state.order.length ? "complete" : state.status,
  };
  return { state: next, pick };
}

export function applyDraftAction(state: DraftState, action: DraftAction): DraftActionResult {
  switch (action.type) {
    case "start":
      if (state.status !== "pending") return { state, error: "Draft already started" };
      return { state: { ...state, status: state.order.length === 0 ? "complete" : "in-progress" } };

    case "pause":
      if (state.status !== "in-progress") return { state, error: "Draft isn't running" };
      return { state: { ...state, status: "paused" } };

    case "resume":
      if (state.status !== "paused") return { state, error: "Draft isn't paused" };
      return { state: { ...state, status: "in-progress" } };

    case "set-controller":
      return {
        state: {
          ...state,
          seats: state.seats.map(s => s.id === action.seatId
            ? { ...s, controller: action.controller, ownerId: action.controller === "human" ? action.ownerId : undefined }
            : s),
        },
      };

    case "pick": {
      if (state.status !== "in-progress") return { state, error: "Draft isn't running" };
      const current = getCurrentSeatId(state);
      if (current !== action.seatId) return { state, error: "Not your pick" };
      const err = getPickError(state, action.seatId, action.playerId);
      if (err) return { state, error: err };
      return withPick(state, action.seatId, action.playerId, action.auto ?? false);
    }

    case "auto-pick": {
      if (state.status !== "in-progress") return { state, error: "Draft isn't running" };
      const current = getCurrentSeatId(state);
      if (current !== action.seatId) return { state, error: "Not this seat's pick" };
      const { playerId, rngState } = chooseAiPick(state, action.seatId, action.queue);
      if (!playerId) return { state, error: "No legal player left" };
      return withPick(state, action.seatId, playerId, true, rngState);
    }

    case "undo": {
      if (state.picks.length === 0) return { state, error: "Nothing to undo" };
      const last = state.picks[state.picks.length - 1];
      const taken = { ...state.taken };
      delete taken[last.playerId];
      return {
        state: {
          ...state,
          picks: state.picks.slice(0, -1),
          taken,
          squads: { ...state.squads, [last.seatId]: (state.squads[last.seatId] ?? []).filter(id => id !== last.playerId) },
          status: state.status === "complete" ? "in-progress" : state.status,
        },
      };
    }
  }
}

/** Apply AI picks while the current seat is AI-controlled. Stops at a human's turn or the end. */
export function runAiPicks(state: DraftState, maxPicks = Infinity): { state: DraftState; picks: DraftPick[] } {
  let s = state;
  const made: DraftPick[] = [];
  while (s.status === "in-progress" && made.length < maxPicks) {
    const seatId = getCurrentSeatId(s);
    if (!seatId) break;
    const seat = s.seats.find(x => x.id === seatId);
    if (!seat || seat.controller !== "ai") break;
    const res = applyDraftAction(s, { type: "auto-pick", seatId });
    if (res.error || !res.pick) break;
    s = res.state;
    made.push(res.pick);
  }
  return { state: s, picks: made };
}

/** Finish the draft with auto-picks for everyone (humans included). */
export function simulateRemainingDraft(state: DraftState): DraftState {
  let s = state.status === "pending" ? applyDraftAction(state, { type: "start" }).state : state;
  if (s.status === "paused") s = applyDraftAction(s, { type: "resume" }).state;
  let guard = s.order.length + 5;
  while (!isDraftComplete(s) && guard-- > 0) {
    const seatId = getCurrentSeatId(s);
    if (!seatId) break;
    const res = applyDraftAction(s, { type: "auto-pick", seatId });
    if (res.error) {
      // No legal player for this seat: drop its remaining slots so the draft can finish.
      s = { ...s, order: s.order.filter((id, i) => i < s.picks.length || id !== seatId) };
      if (isDraftComplete(s)) s = { ...s, status: "complete" };
      continue;
    }
    s = res.state;
  }
  return s;
}
