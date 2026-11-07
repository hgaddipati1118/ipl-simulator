/**
 * Multiplayer draft rooms: the season draft and Draft Match, for any number of humans.
 *
 * The host is authoritative. It owns the DraftState and applies every action through the
 * engine's pure state machine; guests only send intents (claim a seat, pick, queue, lineup).
 * After every change the host broadcasts the board (without the pool, which is sent once).
 * Humans who disconnect keep their seat but are auto-drafted until they rejoin by name.
 * Spectators can join without a seat and see everything live.
 *
 * `reduceDraftRoomView` turns host messages into the view both host and guests render.
 */

import {
  type Player, type RuleSet, type TeamConfig, type DraftState, type DraftPlayer, type DraftConfig,
  Team, IPL_TEAMS, WPL_TEAMS, RULE_PRESETS,
  createDraft, applyDraftAction, getCurrentSeatId, getSquad, toDraftPlayer, shuffleSeats,
  isDraftComplete, runSeason, Player as PlayerClass,
} from "@ipl-sim/engine";
import type {
  GuestMessage, HostMessage, DraftRoomInfo, DraftRoomMember, DraftRoomSeat, DraftRoomSettings,
  DraftRoomPhase, DraftSeries, DraftMatchStart, DraftMatchOutcome, DraftRoundRobinRow,
} from "./protocol";
import { DRAFT_AI_DELAY_MS, DRAFT_ROOM_MAX_MEMBERS } from "./protocol";
import {
  type DraftMatchPoolResult, type DraftMatchLineup,
  seasonDraftConfig, draftRoundPrice, autoLineup, buildDraftMatchTeam, draftMatchRules,
  simulateDraftMatch, shareableResult, draftMatchVenues, ensurePoolCoverage,
} from "../draft-pools";

/** What the host needs from the network layer (MultiplayerHost satisfies this). */
export interface DraftRoomTransport {
  roomCode: string;
  broadcast(data: unknown): void;
  sendTo(peerId: string, data: unknown): void;
  onMessage: (peerId: string, data: unknown) => void;
  onConnection: (peerId: string) => void;
  onDisconnect: (peerId: string) => void;
  destroy(): void;
}

export interface DraftRoomDeps {
  /** Season draft: teams + players + rules for a league */
  buildSeasonPool: (league: "ipl" | "wpl") => { teams: TeamConfig[]; players: Player[]; rules: RuleSet };
  /** Draft Match pool */
  buildMatchPool: (settings: DraftRoomSettings) => DraftMatchPoolResult;
  aiDelayMs?: number;
  tickMs?: number;
  random?: () => number;
}

const SIDE_COLORS = ["#f97316", "#2563eb", "#16a34a", "#9333ea"];

export const DEFAULT_DRAFT_ROOM_SETTINGS: DraftRoomSettings = {
  mode: "draft-match",
  draftType: "snake",
  pickSeconds: 30,
  league: "ipl",
  order: "random",
  pool: "ipl-current",
  sides: 2,
  venueTeamId: null,
};

const HOST_ID = "host";

export class DraftRoomHost {
  private transport: DraftRoomTransport;
  private deps: DraftRoomDeps;
  private settings: DraftRoomSettings;
  private phase: DraftRoomPhase = "lobby";
  private members: DraftRoomMember[] = [];
  private seats: DraftRoomSeat[] = [];
  private kicked = new Set<string>();
  private queues = new Map<string, string[]>();      // peerId → queue
  private draft: DraftState | null = null;
  private players = new Map<string, Player>();
  private poolLabel = "";
  private maxOverseasInXI: number | undefined;
  private rules: RuleSet = RULE_PRESETS.modern2026;
  private secondsLeft: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private lineups = new Map<string, DraftMatchLineup>();
  private series: DraftSeries | undefined;
  private gameNo = 0;
  private lastStart: DraftMatchStart | null = null;
  private seasonConfigs: TeamConfig[] = [];
  /** Local listener for the host's own UI (sees exactly what guests see) */
  onLocal: (msg: HostMessage) => void = () => {};

  constructor(transport: DraftRoomTransport, deps: DraftRoomDeps, settings: Partial<DraftRoomSettings> = {}, hostName = "Host") {
    this.transport = transport;
    this.deps = deps;
    this.settings = { ...DEFAULT_DRAFT_ROOM_SETTINGS, ...settings };
    this.members.push({ peerId: HOST_ID, name: hostName, seatId: null, isHost: true, connected: true });
    this.rebuildSeats();
    transport.onMessage = (peerId, data) => this.handleMessage(peerId, data as GuestMessage);
    transport.onConnection = () => {};
    transport.onDisconnect = (peerId) => this.handleDisconnect(peerId);
  }

  // ── Host-only controls ────────────────────────────────────────────────

  updateSettings(patch: Partial<DraftRoomSettings>) {
    if (this.phase !== "lobby") return;
    const modeChanged = patch.mode && patch.mode !== this.settings.mode;
    const leagueChanged = patch.league && patch.league !== this.settings.league;
    const sidesChanged = patch.sides && patch.sides !== this.settings.sides;
    this.settings = { ...this.settings, ...patch, sides: Math.max(2, Math.min(4, patch.sides ?? this.settings.sides)) };
    if (modeChanged || leagueChanged || sidesChanged) {
      for (const m of this.members) m.seatId = null;
      this.rebuildSeats();
    }
    this.broadcastRoom();
  }

  setHostName(name: string) {
    const h = this.member(HOST_ID);
    if (h) h.name = name;
    this.syncSeatOwners();
    this.broadcastRoom();
  }

  /** Take a member off their seat and hand it to the AI (they stay as a spectator). */
  setSeatAI(seatId: string) {
    for (const m of this.members) if (m.seatId === seatId) m.seatId = null;
    this.syncSeatOwners();
    this.broadcastRoom();
    this.afterChange();
  }

  /** Remove a member from the room. Their seat goes to the AI. */
  kick(peerId: string) {
    if (peerId === HOST_ID) return;
    const m = this.member(peerId);
    if (!m) return;
    this.transport.sendTo(peerId, { type: "draft-kicked", reason: "Removed by the host" } satisfies HostMessage);
    this.kicked.add(peerId);
    this.members = this.members.filter(x => x.peerId !== peerId);
    this.syncSeatOwners();
    this.broadcastRoom();
    this.afterChange();
  }

  start() {
    if (this.phase !== "lobby" && this.phase !== "results") return;
    if (this.settings.mode === "season-draft") this.startSeasonDraft();
    else this.startMatchDraft(true);
  }

  pause() { this.act({ type: "pause" }); }
  resume() { this.act({ type: "resume" }); }
  /** Host undo of the last pick */
  undo() { this.act({ type: "undo" }); }

  /** Auto-draft everyone (host shortcut) */
  simRemaining() {
    if (!this.draft) return;
    let guard = this.draft.order.length + 2;
    while (this.draft && !isDraftComplete(this.draft) && guard-- > 0) {
      const seatId = getCurrentSeatId(this.draft);
      if (!seatId) break;
      if (this.draft.status === "paused") this.act({ type: "resume" });
      if (!this.autoPick(seatId)) break;
    }
  }

  // Host acting as a player (same paths as guest messages)
  claimSeat(seatId: string | null) { this.handleMessage(HOST_ID, { type: "draft-claim-seat", seatId }); }
  pick(playerId: string) { this.handleMessage(HOST_ID, { type: "draft-pick", playerId }); }
  setQueue(playerIds: string[]) { this.handleMessage(HOST_ID, { type: "draft-queue", playerIds }); }
  submitLineup(battingOrder: string[], captainId: string) { this.handleMessage(HOST_ID, { type: "draft-lineup", battingOrder, captainId }); }
  rematch() { this.handleMessage(HOST_ID, { type: "draft-rematch" }); }

  getRoomInfo(): DraftRoomInfo {
    return {
      roomCode: this.transport.roomCode,
      phase: this.phase,
      settings: this.settings,
      members: this.members.map(m => ({ ...m })),
      seats: this.seats.map(s => ({ ...s })),
      series: this.series,
      lineupsIn: [...this.lineups.keys()],
      poolLabel: this.poolLabel,
    };
  }

  getDraft(): DraftState | null { return this.draft; }

  destroy() {
    this.stopTicker();
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.transport.destroy();
  }

  // ── Seats & members ───────────────────────────────────────────────────

  private member(peerId: string) { return this.members.find(m => m.peerId === peerId); }

  private rebuildSeats() {
    if (this.settings.mode === "season-draft") {
      const configs = this.settings.league === "wpl" ? WPL_TEAMS : IPL_TEAMS;
      const ids = new Set(this.settings.league === "wpl" ? RULE_PRESETS.wpl.teamIds : RULE_PRESETS.modern2026.teamIds);
      this.seasonConfigs = configs.filter(c => ids.has(c.id));
      this.seats = this.seasonConfigs.map(c => ({ seatId: c.id, name: c.name, shortName: c.shortName, color: c.primaryColor, controller: "ai" }));
    } else {
      this.seats = Array.from({ length: this.settings.sides }, (_, i) => ({
        seatId: `side-${i + 1}`, name: `Side ${i + 1}`, shortName: `S${i + 1}`, color: SIDE_COLORS[i % SIDE_COLORS.length], controller: "ai",
      }));
    }
    this.syncSeatOwners();
  }

  /** Seat controllers/owner names follow the members list; keeps the draft's seats in sync too. */
  private syncSeatOwners() {
    for (const seat of this.seats) {
      const owner = this.members.find(m => m.seatId === seat.seatId);
      seat.controller = owner ? "human" : "ai";
      seat.ownerPeerId = owner?.peerId;
      seat.ownerName = owner?.name;
      if (this.settings.mode === "draft-match") {
        seat.name = owner ? `${owner.name}'s XI` : `CPU ${seat.shortName}`;
      }
    }
    if (this.draft) {
      let d = this.draft;
      for (const seat of this.seats) {
        const ds = d.seats.find(s => s.id === seat.seatId);
        if (ds && (ds.controller !== seat.controller || ds.ownerId !== seat.ownerPeerId)) {
          d = applyDraftAction(d, { type: "set-controller", seatId: seat.seatId, controller: seat.controller, ownerId: seat.ownerPeerId }).state;
        }
        if (ds) d = { ...d, seats: d.seats.map(s => s.id === seat.seatId ? { ...s, name: seat.name } : s) };
      }
      this.draft = d;
    }
  }

  // ── Starting drafts ───────────────────────────────────────────────────

  private random(): number { return (this.deps.random ?? Math.random)(); }
  private newSeed(): number { return Math.floor(this.random() * 2 ** 31); }

  private startSeasonDraft() {
    const { players, rules } = this.deps.buildSeasonPool(this.settings.league);
    this.rules = { ...rules, draftType: this.settings.draftType, draftPickSeconds: this.settings.pickSeconds };
    this.players = new Map(players.map(p => [p.id, p]));
    this.poolLabel = `${players.length} players`;
    const seed = this.newSeed();
    const config: DraftConfig = { ...seasonDraftConfig(this.rules, seed, false), pickSeconds: this.settings.pickSeconds };
    const ordered = this.settings.order === "random" ? shuffleSeats(this.seats, seed) : this.seats;
    this.beginDraft(config, ordered, players.map(toDraftPlayer));
  }

  private startMatchDraft(newSeries: boolean) {
    const built = this.deps.buildMatchPool(this.settings);
    const pool = { ...built, players: ensurePoolCoverage(built.players, this.seats.length, built.maxOverseasInXI) };
    this.players = new Map(pool.players.map(p => [p.id, p]));
    this.poolLabel = pool.label;
    this.maxOverseasInXI = pool.maxOverseasInXI;
    this.rules = draftMatchRules(pool.maxOverseasInXI);
    const seed = this.newSeed();
    if (newSeries || !this.series || this.series.winnerSeatId) {
      this.series = this.seats.length === 2
        ? { bestOf: 3, game: 0, wins: Object.fromEntries(this.seats.map(s => [s.seatId, 0])) }
        : undefined;
    }
    let ordered = shuffleSeats(this.seats, seed); // coin toss
    const first = this.series?.nextFirstSeatId;
    if (first) ordered = [...this.seats.filter(s => s.seatId === first), ...this.seats.filter(s => s.seatId !== first)];
    const config: DraftConfig = {
      type: this.settings.draftType,
      rounds: 11,
      maxOverseas: pool.maxOverseasInXI,
      maxOverseasInXI: pool.maxOverseasInXI,
      minWicketKeepers: 1,
      minBowlingOptions: 5,
      pickSeconds: this.settings.pickSeconds,
      seed,
    };
    this.lineups.clear();
    this.beginDraft(config, ordered, pool.players.map(toDraftPlayer));
  }

  private beginDraft(config: DraftConfig, orderedSeats: DraftRoomSeat[], pool: DraftPlayer[]) {
    let d = createDraft({
      config,
      seats: orderedSeats.map(s => ({ id: s.seatId, name: s.name, controller: s.controller, ownerId: s.ownerPeerId })),
      pool,
    });
    d = applyDraftAction(d, { type: "start" }).state;
    this.draft = d;
    this.phase = "drafting";
    this.secondsLeft = config.pickSeconds > 0 ? config.pickSeconds : null;
    this.emit({ type: "draft-pool", pool });
    this.broadcastRoom();
    this.broadcastDraft();
    this.startTicker();
    this.afterChange();
  }

  // ── Draft actions ─────────────────────────────────────────────────────

  private act(action: Parameters<typeof applyDraftAction>[1], byName = "Host") {
    if (!this.draft) return null;
    const res = applyDraftAction(this.draft, action);
    if (res.error) return res;
    this.draft = res.state;
    if (res.pick) this.announcePick(res.pick, byName);
    if (res.pick || action.type === "undo") this.secondsLeft = this.draft.config.pickSeconds > 0 ? this.draft.config.pickSeconds : null;
    this.broadcastDraft();
    if (isDraftComplete(this.draft)) this.onDraftComplete();
    else this.afterChange();
    return res;
  }

  private announcePick(pick: NonNullable<ReturnType<typeof applyDraftAction>["pick"]>, byName: string) {
    if (!this.draft) return;
    const seat = this.seats.find(s => s.seatId === pick.seatId);
    const player = this.draft.pool.find(p => p.id === pick.playerId);
    this.emit({
      type: "draft-pick-made",
      pick,
      playerName: player?.name ?? pick.playerId,
      seatName: seat?.name ?? pick.seatId,
      byName: pick.auto ? (seat?.controller === "human" ? `${byName} (auto)` : "CPU") : byName,
    });
  }

  /** Auto-pick for a seat, using its owner's queue. Returns true if a pick was made. */
  private autoPick(seatId: string): boolean {
    const seat = this.seats.find(s => s.seatId === seatId);
    const queue = seat?.ownerPeerId ? this.queues.get(seat.ownerPeerId) : undefined;
    const res = this.act({ type: "auto-pick", seatId, queue }, seat?.ownerName ?? "CPU");
    return !!res && !res.error;
  }

  /** After any change: schedule AI picks for AI seats and seats whose human is offline. */
  private afterChange() {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    if (!this.draft || this.draft.status !== "in-progress" || isDraftComplete(this.draft)) return;
    const seatId = getCurrentSeatId(this.draft);
    const seat = this.seats.find(s => s.seatId === seatId);
    if (!seatId || !seat) return;
    const owner = seat.ownerPeerId ? this.member(seat.ownerPeerId) : undefined;
    if (seat.controller === "ai" || !owner || !owner.connected) {
      const delay = this.deps.aiDelayMs ?? DRAFT_AI_DELAY_MS;
      this.aiTimer = setTimeout(() => { this.aiTimer = null; this.autoPick(seatId); }, delay);
    }
  }

  private startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => this.tick(), this.deps.tickMs ?? 1000);
  }

  private stopTicker() {
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
  }

  private tick() {
    if (!this.draft || this.phase !== "drafting" || this.draft.status !== "in-progress" || this.secondsLeft === null) return;
    const seatId = getCurrentSeatId(this.draft);
    const seat = this.seats.find(s => s.seatId === seatId);
    if (!seatId || !seat || seat.controller !== "human") return; // AI seats use the AI timer
    this.secondsLeft = Math.max(0, this.secondsLeft - 1);
    this.emit({ type: "draft-timer", secondsLeft: this.secondsLeft });
    if (this.secondsLeft === 0) this.autoPick(seatId);
  }

  // ── Completion ────────────────────────────────────────────────────────

  private onDraftComplete() {
    this.stopTicker();
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    if (!this.draft) return;
    if (this.settings.mode === "season-draft") this.finishSeasonDraft();
    else {
      this.phase = "lineups";
      for (const seat of this.seats) {
        if (seat.controller === "ai" || !this.member(seat.ownerPeerId ?? "")?.connected) {
          this.lineups.set(seat.seatId, autoLineup(getSquad(this.draft, seat.seatId)));
        }
      }
      this.broadcastRoom();
      this.maybeStartMatches();
    }
  }

  private finishSeasonDraft() {
    const d = this.draft!;
    const teams = this.seasonConfigs.map(c => new Team(c, this.rules.salaryCap));
    for (const pick of d.picks) {
      const team = teams.find(t => t.id === pick.seatId);
      const player = this.players.get(pick.playerId);
      if (team && player) team.addPlayer(PlayerClass.fromJSON(player.toJSON()), draftRoundPrice(pick.round, this.rules.salaryCap));
    }
    this.emit({
      type: "draft-season-complete",
      squads: this.seats.map(s => ({ seatId: s.seatId, name: s.name, players: getSquad(d, s.seatId).map(p => p.name) })),
    });
    const result = runSeason(teams, this.rules);
    const standings = [...teams]
      .sort((a, b) => b.points !== a.points ? b.points - a.points : b.nrr - a.nrr)
      .map(t => ({ teamId: t.id, shortName: t.shortName, wins: t.wins, losses: t.losses, points: t.points }));
    this.phase = "results";
    this.emit({ type: "season-results", champion: result.champion, standings });
    this.broadcastRoom();
  }

  private sideTeam(seatId: string, index: number, venueTeamId: string): Team {
    const d = this.draft!;
    const seat = this.seats.find(s => s.seatId === seatId)!;
    const players = getSquad(d, seatId).map(p => this.players.get(p.id)!).filter(Boolean);
    const lineup = this.lineups.get(seatId) ?? autoLineup(getSquad(d, seatId));
    return buildDraftMatchTeam({ id: seatId, name: seat.name, shortName: seat.shortName }, index, players, lineup, venueTeamId);
  }

  private pickVenue(): string {
    if (this.settings.venueTeamId) return this.settings.venueTeamId;
    const venues = draftMatchVenues().filter(v => this.settings.pool === "wpl-current" ? v.teamId.endsWith("-w") || v.teamId === "upw" : !v.teamId.endsWith("-w") && v.teamId !== "upw");
    const list = venues.length ? venues : draftMatchVenues();
    return list[Math.floor(this.random() * list.length)]?.teamId ?? "mi";
  }

  private maybeStartMatches() {
    if (!this.draft || this.phase !== "lineups") return;
    if (!this.seats.every(s => this.lineups.has(s.seatId))) return;
    this.gameNo++;
    const venueTeamId = this.pickVenue();

    if (this.seats.length === 2) {
      const seed = this.newSeed();
      const [a, b] = this.draft.seats.map(s => s.id); // draft order: a picked first
      const home = this.sideTeam(a, 0, venueTeamId);
      const away = this.sideTeam(b, 1, venueTeamId);
      const start: DraftMatchStart = {
        gameNo: this.gameNo,
        seed,
        venueTeamId,
        maxOverseasInXI: this.maxOverseasInXI,
        sides: [home, away].map(t => ({
          seatId: t.id, name: t.name, shortName: t.shortName,
          players: t.roster.map(p => p.toJSON()),
          battingOrder: t.userBattingOrder ?? [],
          captainId: this.lineups.get(t.id)?.captainId ?? "",
        })) as unknown as DraftMatchStart["sides"],
      };
      this.lastStart = start;
      this.phase = "match";
      this.emit({ type: "draft-match-start", match: start });
      this.broadcastRoom();

      // Official result: same teams, same seed, no user decisions
      const { summary } = simulateDraftMatch(home, away, this.rules, seed);
      if (this.series) {
        this.series.game = this.gameNo;
        if (summary.winnerSideId) this.series.wins[summary.winnerSideId] = (this.series.wins[summary.winnerSideId] ?? 0) + 1;
        const loser = summary.winnerSideId ? [a, b].find(id => id !== summary.winnerSideId) : b;
        this.series.nextFirstSeatId = loser;
        const need = Math.ceil(this.series.bestOf / 2);
        const champ = Object.entries(this.series.wins).find(([, w]) => w >= need);
        this.series.winnerSeatId = champ?.[0];
      }
      const outcome: DraftMatchOutcome = {
        gameNo: this.gameNo,
        summary,
        shareText: shareableResult({
          sides: start.sides.map(s => ({
            id: s.seatId, name: s.name,
            xi: s.battingOrder.map(id => s.players.find(p => p.id === id)?.name ?? id),
            captain: s.players.find(p => p.id === s.captainId)?.name,
          })),
          summary,
          series: this.series ? `Game ${this.gameNo} of best-of-${this.series.bestOf}` : undefined,
        }),
        series: this.series ? { ...this.series, wins: { ...this.series.wins } } : undefined,
      };
      this.phase = "results";
      this.emit({ type: "draft-match-result", result: outcome });
      this.broadcastRoom();
      return;
    }

    // 3-4 sides: everyone plays everyone once (simulated), table by points then wins
    const table = new Map<string, DraftRoundRobinRow>(this.seats.map(s => [s.seatId, {
      seatId: s.seatId, name: s.name, played: 0, won: 0, lost: 0, tied: 0, points: 0,
    }]));
    const results: DraftMatchOutcome[] = [];
    const ids = this.seats.map(s => s.seatId);
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const home = this.sideTeam(ids[i], i, venueTeamId);
        const away = this.sideTeam(ids[j], j, venueTeamId);
        const { summary } = simulateDraftMatch(home, away, this.rules, this.newSeed());
        n++;
        for (const id of [ids[i], ids[j]]) {
          const row = table.get(id)!;
          row.played++;
          if (!summary.winnerSideId) { row.tied++; row.points += 1; }
          else if (summary.winnerSideId === id) { row.won++; row.points += 2; }
          else row.lost++;
        }
        results.push({
          gameNo: n,
          summary,
          shareText: shareableResult({
            sides: [home, away].map(t => ({ id: t.id, name: t.name, xi: t.roster.map(p => p.name) })),
            summary,
          }),
        });
      }
    }
    this.phase = "results";
    this.emit({
      type: "draft-round-robin",
      table: [...table.values()].sort((a, b) => b.points - a.points || b.won - a.won),
      results,
    });
    this.broadcastRoom();
  }

  // ── Messages ──────────────────────────────────────────────────────────

  private handleMessage(peerId: string, msg: GuestMessage) {
    if (this.kicked.has(peerId)) return;
    switch (msg.type) {
      case "join": {
        const returning = this.members.find(m => !m.connected && m.name === msg.name);
        if (returning) {
          // Rejoin by name: take back the seat (and the queue)
          const q = this.queues.get(returning.peerId);
          if (q) { this.queues.delete(returning.peerId); this.queues.set(peerId, q); }
          returning.peerId = peerId;
          returning.connected = true;
        } else if (this.members.length < DRAFT_ROOM_MAX_MEMBERS) {
          this.members.push({ peerId, name: msg.name, seatId: null, isHost: false, connected: true });
        } else {
          this.transport.sendTo(peerId, { type: "error", message: "Room is full" } satisfies HostMessage);
          return;
        }
        this.syncSeatOwners();
        this.broadcastRoom();
        this.sendFullState(peerId);
        this.afterChange();
        break;
      }

      case "draft-resync":
        this.sendFullState(peerId);
        break;

      case "draft-claim-seat": {
        const m = this.member(peerId);
        if (!m) return;
        if (msg.seatId === null) { m.seatId = null; }
        else {
          const seat = this.seats.find(s => s.seatId === msg.seatId);
          const taken = this.members.find(x => x.seatId === msg.seatId && x.peerId !== peerId);
          if (!seat || taken) return;
          // Mid-draft you can only take over an AI seat (not someone else's)
          m.seatId = msg.seatId;
        }
        this.syncSeatOwners();
        this.broadcastRoom();
        if (this.draft) this.broadcastDraft();
        this.afterChange();
        break;
      }

      case "draft-queue":
        this.queues.set(peerId, msg.playerIds.slice(0, 60));
        break;

      case "draft-pick": {
        const m = this.member(peerId);
        if (!m?.seatId || !this.draft) return;
        const res = this.act({ type: "pick", seatId: m.seatId, playerId: msg.playerId }, m.name);
        if (res?.error) this.transport.sendTo(peerId, { type: "error", message: res.error } satisfies HostMessage);
        if (res?.error && peerId === HOST_ID) this.onLocal({ type: "error", message: res.error });
        break;
      }

      case "draft-lineup": {
        const m = this.member(peerId);
        if (!m?.seatId || this.phase !== "lineups" || !this.draft) return;
        const squadIds = new Set(this.draft.squads[m.seatId] ?? []);
        const order = msg.battingOrder.filter(id => squadIds.has(id));
        for (const id of squadIds) if (!order.includes(id)) order.push(id);
        this.lineups.set(m.seatId, { battingOrder: order, captainId: squadIds.has(msg.captainId) ? msg.captainId : order[0] });
        this.broadcastRoom();
        this.maybeStartMatches();
        break;
      }

      case "draft-rematch": {
        if (this.settings.mode !== "draft-match" || this.phase !== "results") return;
        this.startMatchDraft(!!this.series?.winnerSeatId || !this.series);
        break;
      }

      case "chat": {
        const sender = this.member(peerId);
        this.emit({ type: "chat", from: sender?.name ?? "Unknown", text: msg.text.slice(0, 200) });
        break;
      }
    }
  }

  private handleDisconnect(peerId: string) {
    const m = this.member(peerId);
    if (!m) return;
    if (m.seatId) m.connected = false;              // keep the seat; auto-draft until they rejoin
    else this.members = this.members.filter(x => x.peerId !== peerId);
    this.syncSeatOwners();
    this.broadcastRoom();
    this.afterChange();
  }

  // ── Broadcasting ──────────────────────────────────────────────────────

  private emit(msg: HostMessage) {
    this.transport.broadcast(msg);
    this.onLocal(msg);
  }

  private broadcastRoom() {
    this.emit({ type: "draft-room", room: this.getRoomInfo() });
  }

  private boardMessage(): HostMessage | null {
    if (!this.draft) return null;
    return { type: "draft-state", state: { ...this.draft, pool: [] }, secondsLeft: this.secondsLeft };
  }

  private broadcastDraft() {
    const msg = this.boardMessage();
    if (msg) this.emit(msg);
  }

  private sendFullState(peerId: string) {
    this.transport.sendTo(peerId, { type: "draft-room", room: this.getRoomInfo() } satisfies HostMessage);
    if (this.draft) {
      this.transport.sendTo(peerId, { type: "draft-pool", pool: this.draft.pool } satisfies HostMessage);
      this.transport.sendTo(peerId, this.boardMessage());
    }
    if (this.lastStart && (this.phase === "match" || this.phase === "results")) {
      this.transport.sendTo(peerId, { type: "draft-match-start", match: this.lastStart } satisfies HostMessage);
    }
  }
}

// ── Client view (host UI and guests both use this) ─────────────────────

export interface DraftRoomView {
  room: DraftRoomInfo | null;
  pool: DraftPlayer[];
  draft: DraftState | null;
  secondsLeft: number | null;
  feed: string[];
  matchStart: DraftMatchStart | null;
  matchResult: DraftMatchOutcome | null;
  roundRobin: { table: DraftRoundRobinRow[]; results: DraftMatchOutcome[] } | null;
  seasonSquads: { seatId: string; name: string; players: string[] }[] | null;
  seasonResults: { champion: string; standings: { teamId: string; shortName: string; wins: number; losses: number; points: number }[] } | null;
  chat: { from: string; text: string }[];
  error: string | null;
  kicked: string | null;
}

export const EMPTY_DRAFT_ROOM_VIEW: DraftRoomView = {
  room: null, pool: [], draft: null, secondsLeft: null, feed: [], matchStart: null, matchResult: null,
  roundRobin: null, seasonSquads: null, seasonResults: null, chat: [], error: null, kicked: null,
};

export function reduceDraftRoomView(view: DraftRoomView, msg: HostMessage): DraftRoomView {
  switch (msg.type) {
    case "draft-room":
      return { ...view, room: msg.room };
    case "draft-pool":
      // A new draft: clear the previous game's match data
      return {
        ...view, pool: msg.pool, draft: view.draft ? { ...view.draft, pool: msg.pool } : null,
        feed: [], matchStart: null, matchResult: null, roundRobin: null, seasonSquads: null, seasonResults: null,
      };
    case "draft-state":
      return { ...view, draft: { ...msg.state, pool: view.pool }, secondsLeft: msg.secondsLeft };
    case "draft-timer":
      return { ...view, secondsLeft: msg.secondsLeft };
    case "draft-pick-made":
      return { ...view, feed: [`#${msg.pick.pickNo} ${msg.seatName}: ${msg.playerName} — ${msg.byName}`, ...view.feed].slice(0, 40) };
    case "draft-match-start":
      return { ...view, matchStart: msg.match };
    case "draft-match-result":
      return { ...view, matchResult: msg.result };
    case "draft-round-robin":
      return { ...view, roundRobin: { table: msg.table, results: msg.results } };
    case "draft-season-complete":
      return { ...view, seasonSquads: msg.squads };
    case "season-results":
      return { ...view, seasonResults: { champion: msg.champion, standings: msg.standings } };
    case "chat":
      return { ...view, chat: [...view.chat, { from: msg.from, text: msg.text }].slice(-50) };
    case "error":
      return { ...view, error: msg.message };
    case "draft-kicked":
      return { ...view, kicked: msg.reason };
    default:
      return view;
  }
}

/** Rebuild playable teams on a client from a match-start message (same seed → same match). */
export function teamsFromMatchStart(start: DraftMatchStart, userSeatId: string | null = null): [Team, Team] {
  return start.sides.map((side, i) => buildDraftMatchTeam(
    { id: side.seatId, name: side.name, shortName: side.shortName },
    i,
    side.players.map(d => new PlayerClass(d)),
    { battingOrder: side.battingOrder, captainId: side.captainId },
    start.venueTeamId,
    // Watching (no user side): both lineups explicit. Playing: only the user's side is user-controlled.
    userSeatId === null || side.seatId === userSeatId,
  )) as [Team, Team];
}
