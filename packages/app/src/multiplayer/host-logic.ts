/**
 * Host-side game logic for multiplayer auction.
 * Manages lobby, auction state, CPU bidding, timer, and season sim.
 */

import {
  type Player, Team, type RuleSet,
  getBasePrice, getBidIncrement,
  generatePlayerPool, createPlayerFromData,
  IPL_TEAMS, WPL_TEAMS,
  runSeason,
} from "@ipl-sim/engine";
import { getRealPlayers, getWPLPlayers } from "@ipl-sim/ratings";
import type {
  LobbyPlayer, TeamBudgetInfo, AuctionPlayerInfo,
  MultiAuctionState, GuestMessage, HostMessage, RoomPhase,
} from "./protocol";
import { BID_TIMER_SECONDS } from "./protocol";
import { MultiplayerHost } from "./peer";

export class HostGameLogic {
  private host: MultiplayerHost;
  private players: LobbyPlayer[] = [];
  private teams: Team[] = [];
  private auctionPool: Player[] = [];
  private currentPlayerIdx = 0;
  private currentBid = 0;
  private currentBidderTeamId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private secondsLeft = BID_TIMER_SECONDS;
  private recentSales: { playerName: string; teamName: string; amount: number }[] = [];
  private phase: RoomPhase = "lobby";
  private rules: RuleSet;
  private onStateChange: (state: MultiAuctionState) => void = () => {};

  constructor(host: MultiplayerHost, rules: RuleSet) {
    this.host = host;
    this.rules = rules;

    // Add host as first player
    this.players.push({
      peerId: "host",
      name: "Host",
      teamId: null,
      isHost: true,
      isCPU: false,
    });

    // Initialize teams
    const teamConfigs = rules.league === "wpl" ? WPL_TEAMS : IPL_TEAMS;
    const activeIds = new Set(rules.teamIds);
    this.teams = teamConfigs
      .filter(c => activeIds.has(c.id))
      .map(c => new Team(c, rules.salaryCap));

    // Setup message handling
    host.onMessage = (peerId, data) => this.handleMessage(peerId, data as GuestMessage);
    host.onConnection = (peerId) => console.log("[HostLogic] Peer connected:", peerId);
    host.onDisconnect = (peerId) => this.handleDisconnect(peerId);
  }

  setStateChangeHandler(handler: (state: MultiAuctionState) => void) {
    this.onStateChange = handler;
  }

  /** Host sets their own name */
  setHostName(name: string) {
    const hostPlayer = this.players.find(p => p.peerId === "host");
    if (hostPlayer) hostPlayer.name = name;
    this.broadcastLobbyState();
  }

  /** Assign unclaimed teams to CPU */
  fillWithCPU() {
    const claimedTeamIds = new Set(this.players.filter(p => p.teamId).map(p => p.teamId!));
    for (const team of this.teams) {
      if (!claimedTeamIds.has(team.id)) {
        this.players.push({
          peerId: `cpu_${team.id}`,
          name: `CPU (${team.shortName})`,
          teamId: team.id,
          isHost: false,
          isCPU: true,
        });
      }
    }
    this.broadcastLobbyState();
  }

  /** Host picks a team */
  pickTeam(teamId: string) {
    const hostPlayer = this.players.find(p => p.peerId === "host");
    if (hostPlayer) {
      // Remove any CPU assigned to this team
      this.players = this.players.filter(p => !(p.isCPU && p.teamId === teamId));
      hostPlayer.teamId = teamId;
    }
    this.broadcastLobbyState();
  }

  /** Start the auction */
  startAuction() {
    this.phase = "auction";

    // Load players
    if (this.rules.playerSource === "real" || !this.rules.playerSource) {
      const isWPL = this.rules.league === "wpl";
      const realPlayers = isWPL ? getWPLPlayers() : getRealPlayers();
      for (const data of realPlayers) {
        const player = createPlayerFromData(data);
        const team = this.teams.find(t => t.id === data.teamId);
        if (team && team.roster.length < this.rules.maxSquadSize) {
          team.addPlayer(player, Math.min(player.marketValue, 15));
        }
      }
    }

    // Generate auction pool
    const poolSize = this.teams.length <= 5 ? 80 : 200;
    this.auctionPool = generatePlayerPool(poolSize)
      .sort((a, b) => b.marketValue - a.marketValue);

    this.currentPlayerIdx = 0;
    this.startNextPlayer();
    this.broadcastAuctionState();
  }

  private startNextPlayer() {
    if (this.currentPlayerIdx >= this.auctionPool.length) {
      this.endAuction();
      return;
    }

    const player = this.auctionPool[this.currentPlayerIdx];
    this.currentBid = getBasePrice(player);
    this.currentBidderTeamId = null;
    this.secondsLeft = BID_TIMER_SECONDS;
    this.startTimer();
  }

  private startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.secondsLeft--;
      this.broadcastAuctionState();

      if (this.secondsLeft <= 0) {
        this.resolveCurrentPlayer();
      }
    }, 1000);
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private resolveCurrentPlayer() {
    this.stopTimer();
    const player = this.auctionPool[this.currentPlayerIdx];

    if (this.currentBidderTeamId) {
      // SOLD
      const team = this.teams.find(t => t.id === this.currentBidderTeamId);
      if (team) {
        team.addPlayer(player, this.currentBid);
        this.recentSales.unshift({
          playerName: player.name,
          teamName: team.shortName,
          amount: this.currentBid,
        });
        if (this.recentSales.length > 10) this.recentSales.pop();

        this.host.broadcast({
          type: "sold",
          playerId: player.id,
          playerName: player.name,
          teamId: team.id,
          teamName: team.shortName,
          amount: this.currentBid,
        } satisfies HostMessage);
      }
    } else {
      // UNSOLD
      this.host.broadcast({
        type: "unsold",
        playerId: player.id,
        playerName: player.name,
      } satisfies HostMessage);
    }

    // Brief pause then next player
    setTimeout(() => {
      this.currentPlayerIdx++;
      this.startNextPlayer();
      this.broadcastAuctionState();
    }, 2000);
  }

  /** Process a bid from a human player */
  private processBid(teamId: string) {
    const team = this.teams.find(t => t.id === teamId);
    if (!team) return;
    if (teamId === this.currentBidderTeamId) return; // already highest bidder

    const increment = getBidIncrement(this.currentBid);
    const newBid = Math.round((this.currentBid + increment) * 100) / 100;

    if (team.remainingBudget < newBid) return;
    if (team.roster.length >= this.rules.maxSquadSize) return;

    this.currentBid = newBid;
    this.currentBidderTeamId = teamId;
    this.secondsLeft = BID_TIMER_SECONDS; // Reset timer

    const bidderPlayer = this.players.find(p => p.teamId === teamId);
    this.host.broadcast({
      type: "bid-update",
      teamId,
      teamName: team.shortName,
      amount: newBid,
      bidderName: bidderPlayer?.name ?? "Unknown",
    } satisfies HostMessage);

    this.broadcastAuctionState();
  }

  /** CPU teams bid automatically */
  private cpuBidRound() {
    const player = this.auctionPool[this.currentPlayerIdx];
    if (!player) return;

    const cpuTeams = this.players
      .filter(p => p.isCPU && p.teamId)
      .map(p => this.teams.find(t => t.id === p.teamId))
      .filter((t): t is Team => !!t);

    for (const team of cpuTeams) {
      if (team.id === this.currentBidderTeamId) continue;
      const increment = getBidIncrement(this.currentBid);
      if (team.remainingBudget < this.currentBid + increment) continue;
      if (team.roster.length >= this.rules.maxSquadSize) continue;

      const value = player.marketValue;
      const valueRatio = this.currentBid / (value * 10 + 0.1);
      let bidProb = Math.max(0, (1 - valueRatio)) * 0.4; // Lower than single-player for pacing

      if (player.age < 25) bidProb *= 1.2;
      if (!player.isInternational) bidProb *= 1.15;
      if (team.roster.length < 12) bidProb *= 1.3;
      if (this.currentBid > team.salaryCap * 0.3) bidProb *= 0.05;

      if (Math.random() < bidProb) {
        this.currentBid = Math.round((this.currentBid + increment) * 100) / 100;
        this.currentBidderTeamId = team.id;
        this.secondsLeft = BID_TIMER_SECONDS;

        this.host.broadcast({
          type: "bid-update",
          teamId: team.id,
          teamName: team.shortName,
          amount: this.currentBid,
          bidderName: `CPU (${team.shortName})`,
        } satisfies HostMessage);
        break; // Only one CPU bid per round
      }
    }
  }

  private endAuction() {
    this.stopTimer();
    this.phase = "results";

    // Simulate season
    const result = runSeason(this.teams, this.rules);
    const standings = [...this.teams]
      .sort((a, b) => b.points !== a.points ? b.points - a.points : b.nrr - a.nrr)
      .map(t => ({
        teamId: t.id,
        shortName: t.shortName,
        wins: t.wins,
        losses: t.losses,
        points: t.points,
      }));

    this.host.broadcast({
      type: "auction-complete",
      teams: this.getTeamBudgets(),
    } satisfies HostMessage);

    setTimeout(() => {
      this.host.broadcast({
        type: "season-results",
        champion: result.champion,
        standings,
      } satisfies HostMessage);
      this.broadcastAuctionState();
    }, 3000);
  }

  /** Skip current player (host only) */
  skipPlayer() {
    this.stopTimer();
    this.currentPlayerIdx++;
    this.startNextPlayer();
    this.broadcastAuctionState();
  }

  /** Sim remaining auction (host only) */
  simRemaining() {
    this.stopTimer();
    // Quick-sim all remaining players with CPU logic
    while (this.currentPlayerIdx < this.auctionPool.length) {
      const player = this.auctionPool[this.currentPlayerIdx];
      const basePrice = getBasePrice(player);
      let bid = basePrice;
      let winner: Team | null = null;

      // Simple CPU auction for each player
      for (let round = 0; round < 10; round++) {
        let anyBid = false;
        for (const team of this.teams) {
          if (team === winner) continue;
          if (team.remainingBudget < bid + getBidIncrement(bid)) continue;
          if (team.roster.length >= this.rules.maxSquadSize) continue;
          if (Math.random() < 0.3) {
            bid += getBidIncrement(bid);
            bid = Math.round(bid * 100) / 100;
            winner = team;
            anyBid = true;
          }
        }
        if (!anyBid) break;
      }

      if (winner) {
        winner.addPlayer(player, bid);
      }
      this.currentPlayerIdx++;
    }

    this.endAuction();
  }

  // ── Message Handling ──────────────────────────────────────────────────

  private handleMessage(peerId: string, msg: GuestMessage) {
    switch (msg.type) {
      case "join":
        this.players.push({
          peerId,
          name: msg.name,
          teamId: null,
          isHost: false,
          isCPU: false,
        });
        this.broadcastLobbyState();
        break;

      case "pick-team": {
        const player = this.players.find(p => p.peerId === peerId);
        if (player) {
          // Remove any CPU on this team
          this.players = this.players.filter(p => !(p.isCPU && p.teamId === msg.teamId));
          player.teamId = msg.teamId;
        }
        this.broadcastLobbyState();
        break;
      }

      case "bid": {
        const bidder = this.players.find(p => p.peerId === peerId);
        if (bidder?.teamId) this.processBid(bidder.teamId);
        break;
      }

      case "pass":
        // Player passes — do nothing, timer continues
        break;

      case "chat": {
        const sender = this.players.find(p => p.peerId === peerId);
        this.host.broadcast({
          type: "chat",
          from: sender?.name ?? "Unknown",
          text: msg.text,
        } satisfies HostMessage);
        break;
      }
    }
  }

  private handleDisconnect(peerId: string) {
    const player = this.players.find(p => p.peerId === peerId);
    if (player?.teamId) {
      // Convert to CPU
      player.isCPU = true;
      player.name = `CPU (${this.teams.find(t => t.id === player.teamId)?.shortName ?? "?"})`;
    } else {
      this.players = this.players.filter(p => p.peerId !== peerId);
    }
    this.broadcastLobbyState();
  }

  // ── State Broadcasting ────────────────────────────────────────────────

  private getTeamBudgets(): TeamBudgetInfo[] {
    return this.teams.map(t => {
      const controller = this.players.find(p => p.teamId === t.id);
      return {
        teamId: t.id,
        teamName: t.name,
        shortName: t.shortName,
        primaryColor: t.config.primaryColor,
        budget: t.remainingBudget,
        spent: t.totalSpent,
        rosterCount: t.roster.length,
        controlledBy: controller?.peerId ?? "cpu",
        playerName: controller?.name ?? "CPU",
      };
    });
  }

  private getCurrentPlayerInfo(): AuctionPlayerInfo | null {
    if (this.currentPlayerIdx >= this.auctionPool.length) return null;
    const p = this.auctionPool[this.currentPlayerIdx];
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      overall: p.overall,
      battingOvr: p.battingOvr,
      bowlingOvr: p.bowlingOvr,
      bowlingStyle: p.bowlingStyle,
      battingHand: p.battingHand,
      isInternational: p.isInternational,
      isWicketKeeper: p.isWicketKeeper,
      age: p.age,
      country: p.country,
      basePrice: getBasePrice(p),
    };
  }

  getAuctionState(): MultiAuctionState {
    const bidderTeam = this.currentBidderTeamId
      ? this.teams.find(t => t.id === this.currentBidderTeamId)
      : null;
    return {
      phase: this.phase,
      currentPlayer: this.getCurrentPlayerInfo(),
      currentBid: this.currentBid,
      currentBidderId: this.currentBidderTeamId,
      currentBidderName: bidderTeam?.shortName ?? "",
      secondsLeft: this.secondsLeft,
      playersAuctioned: this.currentPlayerIdx,
      totalPlayers: this.auctionPool.length,
      teams: this.getTeamBudgets(),
      recentSales: this.recentSales,
    };
  }

  private broadcastLobbyState() {
    const msg: HostMessage = {
      type: "lobby-state",
      players: this.players,
      teams: this.getTeamBudgets(),
      roomCode: this.host.roomCode,
      phase: this.phase,
    };
    this.host.broadcast(msg);
    this.onStateChange(this.getAuctionState());
  }

  private broadcastAuctionState() {
    const state = this.getAuctionState();
    this.host.broadcast({ type: "auction-state", state } satisfies HostMessage);
    this.onStateChange(state);

    // Trigger CPU bids after a short delay
    if (this.phase === "auction" && this.secondsLeft > 2) {
      setTimeout(() => this.cpuBidRound(), 500 + Math.random() * 2000);
    }
  }

  destroy() {
    this.stopTimer();
    this.host.destroy();
  }
}
