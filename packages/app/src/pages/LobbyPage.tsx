import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { MultiplayerHost, MultiplayerGuest } from "../multiplayer/peer";
import { HostGameLogic } from "../multiplayer/host-logic";
import type {
  MultiAuctionState,
  LobbyPlayer,
  TeamBudgetInfo,
  HostMessage,
  RoomPhase,
  RoomMode,
} from "../multiplayer/protocol";
import { DraftRoomHost, reduceDraftRoomView, EMPTY_DRAFT_ROOM_VIEW, type DraftRoomView } from "../multiplayer/draft-room";
import { realDraftRoomDeps } from "../multiplayer/draft-room-deps";
import { DraftRoom, type DraftRoomActions } from "../components/DraftRoom";
import { TeamBadge } from "../components/TeamBadge";
import { MULTIPLAYER_LEAGUES, multiplayerAuctionRules, multiplayerLeagueName, type MultiplayerLeagueId } from "../multiplayer/leagues";

type Mode = "choose" | "host" | "guest" | "draft-host";

const ROOM_MODES: { value: RoomMode; label: string; desc: string }[] = [
  { value: "auction", label: "Auction", desc: "Bid against friends for players" },
  { value: "season-draft", label: "Season Draft", desc: "Snake-draft full squads, then a season" },
  { value: "draft-match", label: "Draft Match", desc: "Pick XIs head-to-head and play now" },
];

export function LobbyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [roomMode, setRoomMode] = useState<RoomMode>(
    ((location.state as { mode?: RoomMode } | null)?.mode) ?? "auction",
  );
  const [draftView, setDraftView] = useState<DraftRoomView>(EMPTY_DRAFT_ROOM_VIEW);
  const [inDraftRoom, setInDraftRoom] = useState(false);
  const inDraftRoomRef = useRef(false);
  const draftHostRef = useRef<DraftRoomHost | null>(null);

  // Connection mode
  const [mode, setMode] = useState<Mode>("choose");

  // Shared state
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Lobby state (synced from host)
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [teams, setTeams] = useState<TeamBudgetInfo[]>([]);
  const [phase, setPhase] = useState<RoomPhase>("lobby");
  const [auctionState, setAuctionState] = useState<MultiAuctionState | null>(null);
  const [myTeamId, setMyTeamId] = useState<string | null>(null);
  // Auction room league (host picks in the lobby; guests learn it from lobby-state)
  const [league, setLeague] = useState<MultiplayerLeagueId>("ipl");
  const [startingAuction, setStartingAuction] = useState(false);

  // Refs for host/guest instances
  const hostRef = useRef<MultiplayerHost | null>(null);
  const guestRef = useRef<MultiplayerGuest | null>(null);
  const logicRef = useRef<HostGameLogic | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      draftHostRef.current?.destroy();
      logicRef.current?.destroy();
      hostRef.current?.destroy();
      guestRef.current?.destroy();
    };
  }, []);

  // Navigate to auction when phase changes
  useEffect(() => {
    if (phase === "auction" && auctionState) {
      navigate("/multiplayer/auction", {
        state: {
          auctionState,
          myTeamId,
          isHost: mode === "host",
        },
      });
    }
  }, [phase, auctionState, myTeamId, mode, navigate]);

  // ── Host Flow ──

  const handleCreateRoom = useCallback(async () => {
    if (!name.trim()) { setError("Enter your name"); return; }
    setError("");
    setConnecting(true);

    try {
      const host = new MultiplayerHost();
      hostRef.current = host;
      const code = await host.create();
      setRoomCode(code);

      if (roomMode !== "auction") {
        const room = new DraftRoomHost(host, realDraftRoomDeps, { mode: roomMode }, name.trim());
        draftHostRef.current = room;
        room.onLocal = (msg) => setDraftView(v => reduceDraftRoomView(v, msg));
        setDraftView(v => ({ ...v, room: room.getRoomInfo() }));
        setMode("draft-host");
        return;
      }

      const logic = new HostGameLogic(host, multiplayerAuctionRules(league));
      logicRef.current = logic;
      logic.setHostName(name.trim());

      logic.setStateChangeHandler((state) => {
        setAuctionState(state);
        setPhase(state.phase);
        setTeams(state.teams);
      });

      // Set initial lobby state
      setPlayers([{
        peerId: "host",
        name: name.trim(),
        teamId: null,
        isHost: true,
        isCPU: false,
      }]);
      setTeams(logic.getTeamsInfo());

      // Listen for lobby updates via broadcast interception
      const origBroadcast = host.broadcast.bind(host);
      host.broadcast = (data: unknown) => {
        origBroadcast(data);
        // Also process locally for the host UI
        const msg = data as HostMessage;
        if (msg.type === "lobby-state") {
          setPlayers(msg.players);
          setTeams(msg.teams);
          setPhase(msg.phase);
          if (msg.league) setLeague(msg.league);
        }
      };

      setMode("host");
    } catch (err: any) {
      setError(err?.message ?? "Failed to create room");
    } finally {
      setConnecting(false);
    }
  }, [name, roomMode, league]);

  const handleHostPickTeam = useCallback((teamId: string) => {
    if (!logicRef.current) return;
    // Check if already claimed by someone else (not CPU, not host)
    const existingClaimer = players.find(
      p => p.teamId === teamId && !p.isCPU && p.peerId !== "host"
    );
    if (existingClaimer) return;

    logicRef.current.pickTeam(teamId);
    setMyTeamId(teamId);
  }, [players]);

  const handleFillCPU = useCallback(() => {
    logicRef.current?.fillWithCPU();
  }, []);

  const handleStartAuction = useCallback(() => {
    const started = logicRef.current?.startAuction();
    if (started) {
      setStartingAuction(true);
      void started.finally(() => setStartingAuction(false));
    }
  }, []);

  const handleHostLeague = useCallback((id: MultiplayerLeagueId) => {
    const logic = logicRef.current;
    if (!logic) return;
    logic.setLeague(id);
    setLeague(id);
    setMyTeamId(null);
  }, []);

  // ── Guest Flow ──

  const handleJoinRoom = useCallback(async () => {
    if (!name.trim()) { setError("Enter your name"); return; }
    if (!roomCode.trim() || roomCode.trim().length < 6) { setError("Enter a valid 6-character room code"); return; }
    setError("");
    setConnecting(true);

    try {
      const guest = new MultiplayerGuest();
      guestRef.current = guest;

      guest.onMessage = (data) => {
        const msg = data as HostMessage;
        // Draft rooms speak "draft-*" messages; once we see one, this is a draft room
        if (msg.type.startsWith("draft-")) { inDraftRoomRef.current = true; setInDraftRoom(true); }
        if (inDraftRoomRef.current) { setDraftView(v => reduceDraftRoomView(v, msg)); return; }
        switch (msg.type) {
          case "lobby-state":
            setPlayers(msg.players);
            setTeams(msg.teams);
            setPhase(msg.phase);
            setRoomCode(msg.roomCode);
            if (msg.league) setLeague(msg.league);
            // the host changed league: team claims were cleared
            if (!msg.players.some(p => p.peerId === guestRef.current?.peerId && p.teamId)) setMyTeamId(null);
            break;
          case "auction-state":
            setAuctionState(msg.state);
            setPhase(msg.state.phase);
            setTeams(msg.state.teams);
            break;
        }
      };

      guest.onDisconnect = () => {
        setError("Disconnected from host");
        setMode("choose");
      };

      await guest.join(roomCode.trim(), name.trim());
      setMode("guest");
    } catch (err: any) {
      setError(err?.message ?? "Failed to join room");
    } finally {
      setConnecting(false);
    }
  }, [name, roomCode]);

  const handleGuestPickTeam = useCallback((teamId: string) => {
    if (!guestRef.current) return;
    // Check if already claimed by someone else (not CPU)
    const existingClaimer = players.find(
      p => p.teamId === teamId && !p.isCPU && p.peerId !== guestRef.current?.peerId
    );
    if (existingClaimer) return;

    guestRef.current.send({ type: "pick-team", teamId });
    setMyTeamId(teamId);
  }, [players]);

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [roomCode]);

  // ── Draft rooms (season draft / Draft Match) ──

  const leaveDraftRoom = () => {
    draftHostRef.current?.destroy();
    draftHostRef.current = null;
    guestRef.current?.destroy();
    guestRef.current = null;
    navigate("/");
  };

  if (mode === "draft-host" && draftHostRef.current) {
    const room = draftHostRef.current;
    const actions: DraftRoomActions = {
      claimSeat: id => room.claimSeat(id),
      pick: id => room.pick(id),
      setQueue: ids => room.setQueue(ids),
      submitLineup: l => room.submitLineup(l.battingOrder, l.captainId),
      rematch: () => room.rematch(),
      leave: leaveDraftRoom,
      host: {
        updateSettings: patch => room.updateSettings(patch),
        start: () => room.start(),
        pause: () => room.pause(),
        resume: () => room.resume(),
        undo: () => room.undo(),
        simRemaining: () => room.simRemaining(),
        kick: id => room.kick(id),
        setSeatAI: id => room.setSeatAI(id),
      },
    };
    return <DraftRoom view={draftView} myPeerId="host" actions={actions} />;
  }

  if (inDraftRoom && guestRef.current) {
    const g = guestRef.current;
    const actions: DraftRoomActions = {
      claimSeat: seatId => g.send({ type: "draft-claim-seat", seatId }),
      pick: playerId => g.send({ type: "draft-pick", playerId }),
      setQueue: playerIds => g.send({ type: "draft-queue", playerIds }),
      submitLineup: l => g.send({ type: "draft-lineup", battingOrder: l.battingOrder, captainId: l.captainId }),
      rematch: () => g.send({ type: "draft-rematch" }),
      leave: leaveDraftRoom,
    };
    return <DraftRoom view={draftView} myPeerId={g.peerId} actions={actions} />;
  }

  // ── Derived State ──

  const isHost = mode === "host";
  const allTeamsAssigned = teams.length > 0 && teams.every(tc =>
    players.some(p => p.teamId === tc.teamId)
  );
  const humanCount = players.filter(p => !p.isCPU).length;

  // ── Choose Mode Screen ──

  if (mode === "choose") {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-16 animate-fade-in">
        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-display font-extrabold tracking-tight mb-3">
            <span className="text-gradient-orange">Multiplayer</span>
          </h1>
          <p className="text-th-muted text-lg font-display">
            Play friends in real time: auction, season draft, or a quick Draft Match
          </p>
        </div>

        <div className="space-y-4 max-w-md mx-auto">
          {/* Room type (host picks; guests join whatever the host made) */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2 block">
              Room type (when creating)
            </label>
            <div className="grid grid-cols-3 gap-2" data-testid="room-mode">
              {ROOM_MODES.map(m => (
                <button key={m.value} onClick={() => setRoomMode(m.value)}
                  className={`rounded-xl border px-2 py-2.5 text-left transition-colors ${roomMode === m.value ? "border-orange-500/40 bg-orange-500/[0.08]" : "border-th bg-th-surface hover:bg-th-hover"}`}>
                  <div className="text-xs font-display font-semibold text-th-primary">{m.label}</div>
                  <div className="text-[10px] text-th-muted leading-tight mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Name input */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2 block">
              Your Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Enter your name"
              className="w-full bg-th-surface border border-th rounded-xl px-4 py-3 text-sm text-th-primary font-display focus:outline-none focus:border-orange-500/50 transition-colors"
              maxLength={20}
            />
          </div>

          {/* Host / Join buttons */}
          <div className="grid grid-cols-2 gap-3 pt-2">
            <button
              onClick={handleCreateRoom}
              disabled={connecting}
              className="px-5 py-4 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-50 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20"
            >
              {connecting ? "Creating..." : "Create Room"}
            </button>
            <button
              onClick={() => {
                if (!name.trim()) { setError("Enter your name first"); return; }
                setMode("guest");
                setError("");
              }}
              className="px-5 py-4 bg-th-surface border border-th hover:bg-th-hover hover:border-th-strong text-th-primary font-display font-semibold rounded-xl transition-all duration-200"
            >
              Join Room
            </button>
          </div>

          {error && (
            <p className="text-red-400 text-sm font-display text-center">{error}</p>
          )}
        </div>

        {/* Back button */}
        <div className="text-center mt-8">
          <button
            onClick={() => navigate("/")}
            className="text-th-muted hover:text-th-primary text-sm font-display transition-colors"
          >
            Back to Setup
          </button>
        </div>
      </div>
    );
  }

  // ── Guest Join Screen (before connected) ──

  if (mode === "guest" && players.length === 0) {
    return (
      <div className="max-w-md mx-auto px-4 sm:px-6 py-10 sm:py-16 animate-fade-in">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-display font-extrabold tracking-tight mb-2">
            <span className="text-gradient-orange">Join</span>
            <span className="text-th-primary ml-2">Room</span>
          </h1>
          <p className="text-th-muted font-display">Enter the room code from your host</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2 block">
              Room Code
            </label>
            <input
              type="text"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              placeholder="ABCDEF"
              className="w-full bg-th-surface border border-th rounded-xl px-4 py-4 text-xl text-center text-th-primary font-mono tracking-[0.18em] focus:outline-none focus:border-orange-500/50 transition-colors uppercase sm:text-2xl sm:tracking-[0.3em]"
              maxLength={6}
            />
          </div>

          <button
            onClick={handleJoinRoom}
            disabled={connecting || roomCode.length < 6}
            className="w-full px-5 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-50 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20"
          >
            {connecting ? "Connecting..." : "Join"}
          </button>

          {error && (
            <p className="text-red-400 text-sm font-display text-center">{error}</p>
          )}

          <button
            onClick={() => { setMode("choose"); setError(""); }}
            className="w-full text-th-muted hover:text-th-primary text-sm font-display transition-colors py-2"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Lobby View (Host or Connected Guest) ──

  const getTeamController = (teamId: string): LobbyPlayer | undefined =>
    players.find(p => p.teamId === teamId);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-fade-in">
      {/* Header with room code */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
            {isHost ? "Your Room" : "Lobby"}
          </h2>
          <p className="text-th-muted text-sm font-display mt-1">
            {humanCount} player{humanCount !== 1 ? "s" : ""} connected
          </p>
        </div>

        {/* Room code display */}
        <div className="w-full sm:w-auto">
          <div className="flex w-full flex-col gap-2 rounded-xl border border-th bg-th-surface px-4 py-3 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:px-5">
            <span className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted">
              Code
            </span>
            <span className="text-2xl font-mono font-bold text-th-primary tracking-[0.08em] sm:text-4xl sm:tracking-[0.15em]">
              {roomCode}
            </span>
            <button
              onClick={handleCopyCode}
              className="self-start rounded-lg p-2 text-th-muted transition-colors hover:bg-th-hover hover:text-th-primary sm:self-auto"
              title="Copy room code"
            >
              {copied ? (
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Connected Players */}
      <div className="rounded-2xl border border-th bg-th-surface p-5 mb-6">
        <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-3">
          Connected Players
        </h3>
        <div className="flex flex-wrap gap-3">
          {players.filter(p => !p.isCPU).map(p => (
            <div
              key={p.peerId}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                p.peerId === "host" || p.peerId === guestRef.current?.peerId
                  ? "border-orange-500/30 bg-orange-500/[0.06]"
                  : "border-th bg-th-raised"
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${p.isHost ? "bg-amber-400" : "bg-emerald-400"}`} />
              <span className="text-sm font-display text-th-primary font-medium">
                {p.name}
              </span>
              {p.isHost && (
                <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded font-display font-semibold">
                  HOST
                </span>
              )}
              {p.teamId && (
                <span className="text-[10px] text-th-muted font-mono">
                  {teams.find(c => c.teamId === p.teamId)?.shortName ?? p.teamId}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* League (host decides; every league single player offers) */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor="mp-league" className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider">League</label>
        {isHost ? (
          <select
            id="mp-league"
            data-testid="mp-league"
            value={league}
            onChange={e => handleHostLeague(e.target.value as MultiplayerLeagueId)}
            disabled={startingAuction}
            className="rounded-lg border border-th bg-th-surface px-3 py-1.5 text-sm text-th-primary font-display"
          >
            {MULTIPLAYER_LEAGUES.map(l => (
              <option key={l.id} value={l.id}>{l.name} ({l.teams} teams)</option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-display text-th-primary" data-testid="mp-league">
            {MULTIPLAYER_LEAGUES.find(l => l.id === league)?.name ?? multiplayerLeagueName(league)}
          </span>
        )}
      </div>

      {/* Team Selection Grid */}
      <div className="mb-6">
        <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-3">
          Choose Your Team
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {teams.map(t => ({ id: t.teamId, name: t.teamName, shortName: t.shortName, primaryColor: t.primaryColor })).map(config => {
            const controller = getTeamController(config.id);
            const isMine = myTeamId === config.id;
            const isCPU = controller?.isCPU ?? false;
            const isClaimedByOther = !!controller && !isCPU && !isMine;

            return (
              <button
                key={config.id}
                onClick={() => {
                  if (isClaimedByOther) return;
                  if (isHost) handleHostPickTeam(config.id);
                  else handleGuestPickTeam(config.id);
                }}
                disabled={isClaimedByOther}
                className={`group relative p-4 rounded-2xl border transition-all duration-200 text-left ${
                  isMine
                    ? "border-orange-500/50 bg-orange-500/[0.08] ring-1 ring-orange-500/20"
                    : isClaimedByOther
                      ? "border-th bg-th-surface opacity-60 cursor-not-allowed"
                      : isCPU
                        ? "border-th bg-th-raised hover:border-th-strong"
                        : "border-th bg-th-surface hover:border-th-strong hover:bg-th-hover"
                }`}
                style={{
                  background: isMine
                    ? `linear-gradient(160deg, ${config.primaryColor}18, transparent 60%)`
                    : undefined,
                }}
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <TeamBadge
                    teamId={config.id}
                    shortName={config.shortName}
                    primaryColor={config.primaryColor}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-display font-semibold text-th-primary truncate">
                      {config.name}
                    </div>
                  </div>
                </div>

                {/* Controller info */}
                <div className="text-[10px] font-display text-th-muted mt-1">
                  {controller ? (
                    <span className={
                      isMine ? "text-orange-400 font-semibold" :
                      isCPU ? "text-th-faint" :
                      "text-emerald-400/70"
                    }>
                      {isMine ? "You" : controller.name}
                    </span>
                  ) : (
                    <span className="text-th-faint">Available</span>
                  )}
                </div>

                {/* Budget info from teams state */}
                {teams.find(t => t.teamId === config.id) && (
                  <div className="text-[10px] font-mono text-th-faint mt-0.5">
                    {teams.find(t => t.teamId === config.id)!.budget.toFixed(1)} Cr
                    <span className="text-th-faint mx-1">|</span>
                    {teams.find(t => t.teamId === config.id)!.rosterCount}p
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Host Actions */}
      {isHost && (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button
            onClick={handleFillCPU}
            className="w-full rounded-xl border border-th bg-th-surface px-5 py-2.5 text-sm font-display font-semibold text-th-secondary transition-all duration-200 hover:border-th-strong hover:bg-th-hover sm:w-auto"
          >
            Fill with CPU
          </button>
          <button
            onClick={handleStartAuction}
            disabled={!allTeamsAssigned || startingAuction}
            className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-2.5 text-sm font-display font-semibold text-white shadow-lg shadow-orange-500/20 transition-all duration-200 hover:from-orange-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
          >
            {startingAuction ? "Loading squads..." : "Start Auction"}
          </button>
        </div>
      )}

      {!isHost && (
        <div className="rounded-xl border border-th bg-th-raised p-4 text-center">
          <p className="text-th-muted text-sm font-display">
            Waiting for host to start the auction...
          </p>
        </div>
      )}

      {error && (
        <p className="text-red-400 text-sm font-display mt-4">{error}</p>
      )}
    </div>
  );
}
