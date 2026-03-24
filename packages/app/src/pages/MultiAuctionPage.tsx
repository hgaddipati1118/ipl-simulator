import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { MultiAuctionState, TeamBudgetInfo } from "../multiplayer/protocol";
import { getBidIncrement } from "@ipl-sim/engine";
import { TeamBadge } from "../components/TeamBadge";
import { ovrColorClass, roleLabel, bowlingStyleLabel, battingHandLabel } from "../ui-utils";

/* ── Attribute bar (same as AuctionPage) ─────────────────────────────── */

function AttributeBar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(value, 99);
  let color = "bg-gray-500";
  if (value >= 85) color = "bg-emerald-500";
  else if (value >= 70) color = "bg-blue-500";
  else if (value >= 55) color = "bg-amber-500";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-th-muted font-display font-semibold w-20 text-right uppercase tracking-wider">
        {label}
      </span>
      <div className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-th-primary font-mono stat-num w-6 text-right">{value}</span>
    </div>
  );
}

/* ── Budget bar for the teams panel ──────────────────────────────────── */

function BudgetBar({ team, isHighlighted, isCurrentBidder }: {
  team: TeamBudgetInfo;
  isHighlighted: boolean;
  isCurrentBidder: boolean;
}) {
  const total = team.budget + team.spent;
  const pct = total > 0 ? (team.budget / total) * 100 : 0;

  return (
    <div
      className={`px-3 py-2 rounded-lg transition-all duration-200 ${
        isHighlighted
          ? "bg-orange-500/[0.08] border border-orange-500/20"
          : isCurrentBidder
            ? "bg-blue-500/[0.06] border border-blue-500/20"
            : "border border-transparent"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <TeamBadge
          teamId={team.teamId}
          shortName={team.shortName}
          primaryColor={team.primaryColor}
          size="sm"
        />
        <span className={`text-xs font-display font-medium flex-1 truncate ${
          isHighlighted ? "text-orange-400" : "text-th-secondary"
        }`}>
          {team.shortName}
        </span>
        <span className="text-[10px] font-mono text-th-muted stat-num">
          {team.rosterCount}p
        </span>
        <span className="text-xs font-mono text-th-primary stat-num">
          {team.budget.toFixed(1)}
        </span>
      </div>
      <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isCurrentBidder
              ? "bg-blue-500"
              : isHighlighted
                ? "bg-gradient-to-r from-orange-500 to-amber-500"
                : "bg-th-overlay"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ── Timer ring ──────────────────────────────────────────────────────── */

function TimerRing({ seconds, maxSeconds }: { seconds: number; maxSeconds: number }) {
  const pct = maxSeconds > 0 ? (seconds / maxSeconds) * 100 : 0;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;
  const isUrgent = seconds <= 3;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
        <circle
          cx="50" cy="50" r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="6"
        />
        <circle
          cx="50" cy="50" r={radius}
          fill="none"
          stroke={isUrgent ? "#ef4444" : "#f97316"}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-all duration-1000 ease-linear"
        />
      </svg>
      <span className={`absolute text-2xl font-mono font-bold stat-num ${
        isUrgent ? "text-red-400 animate-pulse" : "text-th-primary"
      }`}>
        {seconds}
      </span>
    </div>
  );
}

/* ── Main Component ──────────────────────────────────────────────────── */

interface LocationState {
  auctionState: MultiAuctionState;
  myTeamId: string | null;
  isHost: boolean;
}

export function MultiAuctionPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const locState = location.state as LocationState | null;

  // State
  const [auctionState, setAuctionState] = useState<MultiAuctionState | null>(
    locState?.auctionState ?? null
  );
  const [myTeamId] = useState<string | null>(locState?.myTeamId ?? null);
  const [isHost] = useState(locState?.isHost ?? false);
  const [chatMessages, setChatMessages] = useState<{ from: string; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [flashState, setFlashState] = useState<"sold" | "unsold" | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show sold/unsold flash
  useEffect(() => {
    if (!auctionState) return;
    // Detect sold/unsold from recentSales changes or when no current player
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, [auctionState]);

  if (!auctionState) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
        <p className="text-th-muted font-display">Connecting to auction...</p>
        <button
          onClick={() => navigate("/multiplayer")}
          className="mt-4 text-th-muted hover:text-th-primary text-sm font-display transition-colors"
        >
          Back to Lobby
        </button>
      </div>
    );
  }

  const { currentPlayer, currentBid, currentBidderId, currentBidderName, secondsLeft, teams, recentSales, playersAuctioned, totalPlayers, phase } = auctionState;

  const myTeam = teams.find(t => t.teamId === myTeamId);
  const isMyBid = currentBidderId === myTeamId;
  const increment = getBidIncrement(currentBid);
  const nextBidAmount = Math.round((currentBid + increment) * 100) / 100;
  const canBid = !!(
    currentPlayer &&
    myTeam &&
    !isMyBid &&
    myTeam.budget >= nextBidAmount &&
    myTeam.rosterCount < 25
  );
  const isUrgent = secondsLeft <= 3;

  // Placeholder bid/pass/sim handlers (these would send messages via peer in a real integration)
  const handleBid = () => {
    // In a real implementation, this sends a bid message to host
    console.log("[MultiAuction] Bid sent");
  };

  const handlePass = () => {
    console.log("[MultiAuction] Pass");
  };

  const handleSimRemaining = () => {
    console.log("[MultiAuction] Sim remaining (host only)");
  };

  const handleChat = () => {
    if (!chatInput.trim()) return;
    setChatMessages(prev => [...prev, { from: "You", text: chatInput.trim() }]);
    setChatInput("");
  };

  // ── Auction Complete ──

  if (phase === "results") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
        <div className="rounded-2xl border border-th bg-th-surface p-8 text-center">
          <h2 className="text-3xl font-display font-bold text-gradient-orange mb-4">
            Auction Complete
          </h2>
          <p className="text-th-secondary font-display mb-6">
            <span className="stat-num">{playersAuctioned}</span> players auctioned
          </p>

          {/* All teams summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-8">
            {teams.map(t => (
              <div
                key={t.teamId}
                className={`rounded-xl border p-3 text-left ${
                  t.teamId === myTeamId
                    ? "border-orange-500/30 bg-orange-500/[0.06]"
                    : "border-th bg-th-raised"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <TeamBadge
                    teamId={t.teamId}
                    shortName={t.shortName}
                    primaryColor={t.primaryColor}
                    size="sm"
                  />
                  <span className="text-xs font-display font-semibold text-th-primary">{t.shortName}</span>
                </div>
                <div className="text-[10px] font-mono text-th-muted">
                  {t.rosterCount} players
                </div>
                <div className="text-[10px] font-mono text-amber-400 stat-num">
                  {t.spent.toFixed(1)} Cr spent
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() => navigate("/multiplayer")}
            className="px-8 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  // ── Active Auction ──

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
            Multiplayer Auction
          </h2>
          <p className="text-th-muted mt-1 font-display">
            <span className="stat-num">{playersAuctioned}</span>/{totalPlayers} players auctioned
          </p>
        </div>
        {isHost && (
          <button
            onClick={handleSimRemaining}
            className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 w-full sm:w-auto"
          >
            Sim Remaining
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* ── Left Column: Your Team ── */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-th bg-th-surface p-4 sticky top-20">
            {myTeam ? (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <TeamBadge
                    teamId={myTeam.teamId}
                    shortName={myTeam.shortName}
                    primaryColor={myTeam.primaryColor}
                    size="sm"
                  />
                  <div>
                    <div className="font-display font-semibold text-th-primary text-sm">
                      {myTeam.teamName}
                    </div>
                    <div className="text-[10px] text-th-muted font-display">
                      <span className="stat-num">{myTeam.budget.toFixed(1)}</span> Cr left
                      <span className="text-th-faint mx-1">|</span>
                      <span className="stat-num">{myTeam.rosterCount}</span> players
                    </div>
                  </div>
                </div>

                {/* Budget visual */}
                <div className="mb-3">
                  <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-500"
                      style={{
                        width: `${(myTeam.budget + myTeam.spent) > 0 ? (myTeam.budget / (myTeam.budget + myTeam.spent)) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-[9px] text-th-faint font-mono">
                      {myTeam.spent.toFixed(1)} spent
                    </span>
                    <span className="text-[9px] text-th-faint font-mono">
                      {myTeam.budget.toFixed(1)} left
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-th-muted text-sm font-display">Spectating</p>
            )}
          </div>
        </div>

        {/* ── Center Column: Current Player + Bid ── */}
        <div className="lg:col-span-5">
          {currentPlayer ? (
            <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6">
              {/* Player info */}
              <div className="flex items-start gap-4 mb-4">
                <div className="flex-1">
                  <h3 className="text-xl font-display font-bold text-th-primary">
                    {currentPlayer.name}
                    {currentPlayer.isWicketKeeper && (
                      <span className="text-cyan-400/70 text-[10px] ml-2 font-semibold">WK</span>
                    )}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <span className={`text-sm font-bold ${ovrColorClass(currentPlayer.overall)}`}>
                      {currentPlayer.overall} OVR
                    </span>
                    <span className="text-xs text-th-muted font-display">{roleLabel(currentPlayer.role)}</span>
                    {currentPlayer.battingHand && (
                      <span className="text-[10px] text-th-muted font-display font-semibold bg-th-body px-1.5 py-0.5 rounded border border-th">
                        {battingHandLabel(currentPlayer.battingHand)}
                      </span>
                    )}
                    {currentPlayer.bowlingStyle && bowlingStyleLabel(currentPlayer.bowlingStyle) && (
                      <span className="text-[10px] text-purple-400/70 font-display font-semibold bg-purple-500/10 px-1.5 py-0.5 rounded">
                        {bowlingStyleLabel(currentPlayer.bowlingStyle)}
                      </span>
                    )}
                    <span className="text-xs text-th-muted font-display">Age {currentPlayer.age}</span>
                    <span className="text-xs text-th-muted font-display">{currentPlayer.country}</span>
                    {currentPlayer.isInternational && (
                      <span className="text-[10px] text-orange-400/70 font-semibold border border-orange-400/20 rounded px-1">OS</span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold">
                    Base Price
                  </div>
                  <div className="text-sm text-th-secondary font-mono stat-num">
                    {currentPlayer.basePrice.toFixed(2)} Cr
                  </div>
                </div>
              </div>

              {/* Attribute bars */}
              <div className="space-y-1.5 mb-5">
                <AttributeBar label="Bat OVR" value={currentPlayer.battingOvr} />
                <AttributeBar label="Bowl OVR" value={currentPlayer.bowlingOvr} />
              </div>

              {/* Timer + Current Bid */}
              <div className="flex items-center gap-6 mb-5">
                <TimerRing seconds={secondsLeft} maxSeconds={10} />
                <div className="flex-1">
                  <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-1">
                    Current Bid
                  </div>
                  <div className="text-3xl font-display font-bold text-amber-400 stat-num">
                    {currentBid.toFixed(2)} Cr
                  </div>
                  {currentBidderName ? (
                    <p className="text-sm text-th-secondary font-display mt-1">
                      {currentBidderName}
                      {isMyBid && <span className="text-orange-400 ml-1">(You)</span>}
                    </p>
                  ) : (
                    <p className="text-xs text-th-muted font-display mt-1">No bids yet</p>
                  )}
                </div>
              </div>

              {/* Flash states */}
              {flashState === "sold" && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 mb-5 text-center animate-fade-in">
                  <span className="text-emerald-400 font-display font-bold text-2xl">SOLD!</span>
                </div>
              )}
              {flashState === "unsold" && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 mb-5 text-center animate-fade-in">
                  <span className="text-red-400 font-display font-bold text-2xl">UNSOLD</span>
                </div>
              )}

              {/* Bid / Pass buttons */}
              {myTeam && (
                <div className="flex gap-3">
                  <button
                    onClick={handleBid}
                    disabled={!canBid}
                    className={`px-6 py-3 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 flex-1 sm:flex-none ${
                      canBid
                        ? isUrgent
                          ? "bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 shadow-lg shadow-red-500/20 animate-pulse"
                          : "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-lg shadow-blue-500/20"
                        : "bg-gray-700 text-gray-500 cursor-not-allowed"
                    }`}
                  >
                    Bid {nextBidAmount.toFixed(2)} Cr
                  </button>
                  <button
                    onClick={handlePass}
                    className="px-5 py-3 bg-th-raised hover:bg-th-hover text-th-secondary text-sm font-display font-semibold rounded-xl transition-all duration-200 border border-th flex-1 sm:flex-none"
                  >
                    Pass
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-th bg-th-surface p-8 text-center">
              <p className="text-th-muted font-display">
                Waiting for next player...
              </p>
            </div>
          )}
        </div>

        {/* ── Right Column: Teams + Sales Feed ── */}
        <div className="lg:col-span-4 space-y-5">
          {/* All Teams Budgets */}
          <div className="rounded-2xl border border-th bg-th-surface p-4 sticky top-20">
            <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-3">
              Teams
            </h3>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {teams
                .sort((a, b) => b.budget - a.budget)
                .map(t => (
                  <BudgetBar
                    key={t.teamId}
                    team={t}
                    isHighlighted={t.teamId === myTeamId}
                    isCurrentBidder={t.teamId === currentBidderId}
                  />
                ))}
            </div>
          </div>

          {/* Recent Sales */}
          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-3">
              Recent Sales
            </h3>
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {recentSales.length > 0 ? (
                recentSales.map((sale, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                  >
                    <span className="font-display text-th-secondary truncate flex-1">
                      {sale.playerName}
                    </span>
                    <span className="text-[10px] text-th-muted font-display font-semibold">
                      {sale.teamName}
                    </span>
                    <span className="font-mono text-amber-400 stat-num text-xs">
                      {sale.amount.toFixed(2)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-th-faint text-xs font-display py-2">No sales yet</p>
              )}
            </div>
          </div>

          {/* Mini Chat */}
          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-3">
              Chat
            </h3>
            <div className="space-y-1 max-h-[120px] overflow-y-auto mb-3">
              {chatMessages.length > 0 ? (
                chatMessages.map((msg, i) => (
                  <div key={i} className="text-xs">
                    <span className="font-display font-semibold text-th-secondary">{msg.from}: </span>
                    <span className="text-th-muted">{msg.text}</span>
                  </div>
                ))
              ) : (
                <p className="text-th-faint text-[10px] font-display">No messages yet</p>
              )}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleChat(); }}
                placeholder="Type a message..."
                className="flex-1 bg-th-raised border border-th rounded-lg px-3 py-1.5 text-xs text-th-primary font-display focus:outline-none focus:border-orange-500/50"
                maxLength={100}
              />
              <button
                onClick={handleChat}
                className="px-3 py-1.5 bg-th-raised hover:bg-th-hover border border-th rounded-lg text-xs text-th-secondary font-display transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-6 rounded-2xl border border-th bg-th-surface p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-th-muted font-display">Auction Progress</span>
          <span className="text-xs text-th-secondary font-mono stat-num">
            {playersAuctioned} / {totalPlayers}
          </span>
        </div>
        <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-500"
            style={{
              width: `${totalPlayers > 0 ? (playersAuctioned / totalPlayers) * 100 : 0}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
