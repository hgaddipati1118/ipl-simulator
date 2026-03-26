import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { MultiplayerHost, MultiplayerGuest } from "../multiplayer/peer";
import { HostGameLogic } from "../multiplayer/host-logic";
import type {
  MultiAuctionState,
  LobbyPlayer,
  TeamBudgetInfo,
  HostMessage,
  RoomPhase,
} from "../multiplayer/protocol";
import { RULE_PRESETS, IPL_TEAMS, type RuleSet } from "@ipl-sim/engine";
import { TeamBadge } from "../components/TeamBadge";

type Mode = "choose" | "host" | "guest";

const ALL_TEAM_CONFIGS = IPL_TEAMS;

export function LobbyPage() {
  const navigate = useNavigate();

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

  // Refs for host/guest instances
  const hostRef = useRef<MultiplayerHost | null>(null);
  const guestRef = useRef<MultiplayerGuest | null>(null);
  const logicRef = useRef<HostGameLogic | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
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

      const rules: RuleSet = { ...RULE_PRESETS.modern };
      const logic = new HostGameLogic(host, rules);
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
      setTeams(
        ALL_TEAM_CONFIGS.map(c => ({
          teamId: c.id,
          teamName: c.name,
          shortName: c.shortName,
          primaryColor: c.primaryColor,
          budget: rules.salaryCap,
          spent: 0,
          rosterCount: 0,
          controlledBy: "",
          playerName: "",
        }))
      );

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
        }
      };

      setMode("host");
    } catch (err: any) {
      setError(err?.message ?? "Failed to create room");
    } finally {
      setConnecting(false);
    }
  }, [name]);

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
    logicRef.current?.startAuction();
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
        switch (msg.type) {
          case "lobby-state":
            setPlayers(msg.players);
            setTeams(msg.teams);
            setPhase(msg.phase);
            setRoomCode(msg.roomCode);
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

  // ── Derived State ──

  const isHost = mode === "host";
  const allTeamsAssigned = ALL_TEAM_CONFIGS.every(tc =>
    players.some(p => p.teamId === tc.id)
  );
  const humanCount = players.filter(p => !p.isCPU).length;

  // ── Choose Mode Screen ──

  if (mode === "choose") {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-16 animate-fade-in">
        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-display font-extrabold tracking-tight mb-3">
            <span className="text-gradient-orange">Multiplayer</span>
            <span className="text-th-primary ml-3">Auction</span>
          </h1>
          <p className="text-th-muted text-lg font-display">
            Compete with friends in a real-time P2P auction
          </p>
        </div>

        <div className="space-y-4 max-w-md mx-auto">
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
                  {ALL_TEAM_CONFIGS.find(c => c.id === p.teamId)?.shortName ?? p.teamId}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Team Selection Grid */}
      <div className="mb-6">
        <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-3">
          Choose Your Team
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {ALL_TEAM_CONFIGS.map(config => {
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
            disabled={!allTeamsAssigned}
            className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-2.5 text-sm font-display font-semibold text-white shadow-lg shadow-orange-500/20 transition-all duration-200 hover:from-orange-400 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
          >
            Start Auction
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
