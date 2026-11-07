/**
 * Multiplayer protocol — message types for P2P communication.
 * Covers the live auction and the draft rooms (season draft + Draft Match).
 */

import type { DraftPlayer, DraftState, DraftPick, DraftType, PlayerData } from "@ipl-sim/engine";
import type { DraftMatchPoolId, DraftMatchResultSummary } from "../draft-pools";
import type { MultiplayerLeagueId } from "./leagues";

export interface LobbyPlayer {
  peerId: string;
  name: string;
  teamId: string | null; // null = hasn't picked yet
  isHost: boolean;
  isCPU: boolean;
}

export interface AuctionPlayerInfo {
  id: string;
  name: string;
  role: string;
  overall: number;
  battingOvr: number;
  bowlingOvr: number;
  bowlingStyle?: string;
  battingHand?: string;
  isInternational: boolean;
  isWicketKeeper: boolean;
  age: number;
  country: string;
  basePrice: number;
}

export interface TeamBudgetInfo {
  teamId: string;
  teamName: string;
  shortName: string;
  primaryColor: string;
  budget: number;
  spent: number;
  rosterCount: number;
  controlledBy: string; // peerId or "cpu"
  playerName: string;   // human player name or "CPU"
}

// ── Messages from Guest → Host ──────────────────────────────────────────

export type GuestMessage =
  | { type: "join"; name: string }
  | { type: "pick-team"; teamId: string }
  | { type: "bid" }
  | { type: "pass" }
  | { type: "chat"; text: string }
  | { type: "ready" }
  // Draft rooms
  | { type: "draft-claim-seat"; seatId: string | null }   // null = watch as a spectator
  | { type: "draft-pick"; playerId: string }
  | { type: "draft-queue"; playerIds: string[] }           // used for auto-picks when your clock runs out
  | { type: "draft-lineup"; battingOrder: string[]; captainId: string }
  | { type: "draft-rematch" }
  | { type: "draft-resync" };

// ── Messages from Host → All ────────────────────────────────────────────

export type HostMessage =
  | { type: "lobby-state"; players: LobbyPlayer[]; teams: TeamBudgetInfo[]; roomCode: string; phase: RoomPhase; league?: MultiplayerLeagueId }
  | { type: "auction-state"; state: MultiAuctionState }
  | { type: "bid-update"; teamId: string; teamName: string; amount: number; bidderName: string }
  | { type: "sold"; playerId: string; playerName: string; teamId: string; teamName: string; amount: number }
  | { type: "unsold"; playerId: string; playerName: string }
  | { type: "next-player"; player: AuctionPlayerInfo; basePrice: number }
  | { type: "timer-tick"; secondsLeft: number }
  | { type: "auction-complete"; teams: TeamBudgetInfo[] }
  | { type: "season-results"; champion: string; standings: { teamId: string; shortName: string; wins: number; losses: number; points: number }[] }
  | { type: "chat"; from: string; text: string }
  | { type: "error"; message: string }
  // Draft rooms
  | { type: "draft-room"; room: DraftRoomInfo }
  | { type: "draft-pool"; pool: DraftPlayer[] }
  /** Board state without the pool (sent once via draft-pool); clients re-attach their copy */
  | { type: "draft-state"; state: DraftState; secondsLeft: number | null }
  | { type: "draft-pick-made"; pick: DraftPick; playerName: string; seatName: string; byName: string }
  | { type: "draft-timer"; secondsLeft: number }
  | { type: "draft-kicked"; reason: string }
  | { type: "draft-match-start"; match: DraftMatchStart }
  | { type: "draft-match-result"; result: DraftMatchOutcome }
  | { type: "draft-round-robin"; table: DraftRoundRobinRow[]; results: DraftMatchOutcome[] }
  | { type: "draft-season-complete"; squads: { seatId: string; name: string; players: string[] }[] };

export type RoomPhase = "lobby" | "auction" | "results";

export interface MultiAuctionState {
  phase: RoomPhase;
  currentPlayer: AuctionPlayerInfo | null;
  currentBid: number;
  currentBidderId: string | null; // teamId
  currentBidderName: string;
  secondsLeft: number;
  playersAuctioned: number;
  totalPlayers: number;
  teams: TeamBudgetInfo[];
  recentSales: { playerName: string; teamName: string; amount: number }[];
}

export const BID_TIMER_SECONDS = 10;
export const MAX_PLAYERS_PER_ROOM = 10;

// ── Draft rooms ─────────────────────────────────────────────────────────

export type RoomMode = "auction" | "season-draft" | "draft-match";
export type DraftRoomPhase = "lobby" | "drafting" | "lineups" | "match" | "results";

export interface DraftRoomSettings {
  mode: "season-draft" | "draft-match";
  draftType: DraftType;
  pickSeconds: number;
  /** Season draft: which league's franchises (IPL, WPL or any extra league, multiplayer/leagues.ts) */
  league: MultiplayerLeagueId;
  /** Season draft: draft order random (coin toss/shuffle) or the order seats are listed in */
  order: "random" | "listed";
  /** Draft Match: pool and number of sides (2 = head-to-head, 3-4 = mini round-robin) */
  pool: DraftMatchPoolId;
  nations?: [string, string];
  sides: number;
  /** Draft Match: venue franchise id, or null for a random ground */
  venueTeamId: string | null;
}

export interface DraftRoomMember {
  peerId: string;
  name: string;
  seatId: string | null;   // null = spectator
  isHost: boolean;
  connected: boolean;
}

export interface DraftRoomSeat {
  seatId: string;
  name: string;
  shortName: string;
  color: string;
  controller: "human" | "ai";
  ownerPeerId?: string;
  ownerName?: string;
}

export interface DraftSeries {
  bestOf: number;
  game: number;
  wins: Record<string, number>;
  /** seat that picks first next game (the loser) */
  nextFirstSeatId?: string;
  winnerSeatId?: string;
}

export interface DraftRoomInfo {
  roomCode: string;
  phase: DraftRoomPhase;
  settings: DraftRoomSettings;
  members: DraftRoomMember[];
  seats: DraftRoomSeat[];
  series?: DraftSeries;
  /** Draft Match: seats that have submitted a lineup */
  lineupsIn?: string[];
  poolLabel?: string;
}

export interface DraftMatchStartSide {
  seatId: string;
  name: string;
  shortName: string;
  players: PlayerData[];
  battingOrder: string[];
  captainId: string;
}

export interface DraftMatchStart {
  gameNo: number;
  seed: number;
  venueTeamId: string;
  maxOverseasInXI?: number;
  sides: [DraftMatchStartSide, DraftMatchStartSide];
}

export interface DraftMatchOutcome {
  gameNo: number;
  summary: DraftMatchResultSummary;
  shareText: string;
  series?: DraftSeries;
}

export interface DraftRoundRobinRow {
  seatId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  points: number;
}

export const DRAFT_ROOM_MAX_MEMBERS = 16;
export const DRAFT_AI_DELAY_MS = 900;
