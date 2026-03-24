/**
 * Multiplayer auction protocol — message types for P2P communication.
 */

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
  | { type: "ready" };

// ── Messages from Host → All ────────────────────────────────────────────

export type HostMessage =
  | { type: "lobby-state"; players: LobbyPlayer[]; teams: TeamBudgetInfo[]; roomCode: string; phase: RoomPhase }
  | { type: "auction-state"; state: MultiAuctionState }
  | { type: "bid-update"; teamId: string; teamName: string; amount: number; bidderName: string }
  | { type: "sold"; playerId: string; playerName: string; teamId: string; teamName: string; amount: number }
  | { type: "unsold"; playerId: string; playerName: string }
  | { type: "next-player"; player: AuctionPlayerInfo; basePrice: number }
  | { type: "timer-tick"; secondsLeft: number }
  | { type: "auction-complete"; teams: TeamBudgetInfo[] }
  | { type: "season-results"; champion: string; standings: { teamId: string; shortName: string; wins: number; losses: number; points: number }[] }
  | { type: "chat"; from: string; text: string }
  | { type: "error"; message: string };

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
