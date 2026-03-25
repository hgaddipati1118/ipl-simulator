import { useState, useEffect, useRef } from "react";
import { type Player, type AuctionState, getBidIncrement, getBasePrice } from "@ipl-sim/engine";
import { GameState } from "../game-state";
import { ovrColorClass, roleLabel, bowlingStyleLabel, battingHandLabel, battingPositionLabel, battingPositionColor } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { getPlayerScoutingView, type ScoutingState } from "../scouting";
import { getRecruitmentTag, type RecruitmentState } from "../recruitment";
import { RecruitmentActions, RecruitmentBadge } from "../components/RecruitmentControls";

interface Props {
  state: GameState;
  scouting: ScoutingState;
  recruitment: RecruitmentState;
  onUserBid: () => void;
  onUserPass: () => void;
  onCpuRound: () => void;
  onNextPlayer: () => void;
  onSimPlayer: () => void;
  onSimRemaining: () => void;
  onFinishAuction: () => void;
  onScoutPlayers: (playerIds: string[], amount?: number) => void;
  onToggleShortlist: (playerId: string) => void;
  onToggleWatchlist: (playerId: string) => void;
}

function AttributeBar({ label, value, valueLabel }: { label: string; value: number; valueLabel: string }) {
  const pct = Math.min(value, 99);
  let color = "bg-gray-500";
  if (value >= 85) color = "bg-emerald-500";
  else if (value >= 70) color = "bg-blue-500";
  else if (value >= 55) color = "bg-amber-500";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-th-muted font-display font-semibold w-20 text-right uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-th-primary font-mono stat-num min-w-[42px] text-right">{valueLabel}</span>
    </div>
  );
}

function MiniPlayerRow({ player }: { player: Player }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm">
      <span className="font-display font-medium text-th-primary truncate flex-1">
        {player.name}
        {player.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] ml-1 font-semibold">WK</span>}
      </span>
      <span className={`text-xs font-bold ${ovrColorClass(player.overall)}`}>{player.overall}</span>
      <span className="text-[10px] text-th-muted font-display">{roleLabel(player.role)}</span>
    </div>
  );
}

export function AuctionPage({
  state,
  scouting,
  recruitment,
  onUserBid,
  onUserPass,
  onCpuRound,
  onNextPlayer,
  onSimPlayer,
  onSimRemaining,
  onFinishAuction,
  onScoutPlayers,
  onToggleShortlist,
  onToggleWatchlist,
}: Props) {
  const auction = state.auctionLiveState;
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const autoRunRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const currentPlayer = auction?.players[auction.currentPlayerIndex];

  // Auto-run CPU bid rounds when in bidding phase and user is not highest bidder
  useEffect(() => {
    if (!auction || auction.phase !== "bidding") {
      setAutoRunning(false);
      return;
    }

    // If user is still in bidding and not highest bidder, we need user input
    const userInBidding = state.userTeamId && auction.biddingTeams.includes(state.userTeamId);
    const userIsHighest = auction.currentBidderId === state.userTeamId;

    // Auto-run CPU rounds if user has passed or is highest bidder
    if (!userInBidding || userIsHighest) {
      setAutoRunning(true);
      autoRunRef.current = setTimeout(() => {
        onCpuRound();
      }, 300);
    } else {
      setAutoRunning(false);
    }

    return () => {
      if (autoRunRef.current) clearTimeout(autoRunRef.current);
    };
  }, [auction?.phase, auction?.round, auction?.currentBidderId, auction?.biddingTeams]);

  useEffect(() => {
    if (!currentPlayer) return;
    onScoutPlayers([currentPlayer.id], 12);
  }, [currentPlayer?.id, onScoutPlayers]);

  if (!auction) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
        <p className="text-th-muted">No auction in progress.</p>
      </div>
    );
  }

  // Handle auction complete
  if (auction.phase === "complete") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
        <div className="rounded-2xl border border-th bg-th-surface p-8 text-center">
          <h2 className="text-3xl font-display font-bold text-gradient-orange mb-4">Auction Complete</h2>
          <p className="text-th-secondary font-display mb-2">
            <span className="stat-num">{auction.completedBids.length}</span> players sold
          </p>
          <p className="text-th-muted font-display mb-6">
            <span className="stat-num">{auction.unsold.length}</span> players unsold
          </p>

          {/* Summary of user team acquisitions */}
          {userTeam && (
            <div className="mb-6">
              <h3 className="text-sm font-display font-semibold text-th-secondary uppercase tracking-wider mb-3">
                {userTeam.name} Acquisitions
              </h3>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {auction.completedBids
                  .filter(b => b.teamId === state.userTeamId)
                  .map(b => {
                    const player = auction.players.find(p => p.id === b.playerId);
                    return (
                      <div key={b.playerId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-th-raised text-sm">
                        <span className="font-display text-th-primary flex-1">{b.playerName}</span>
                        {player && (
                          <>
                            <span className={`text-[10px] font-display font-semibold px-1.5 py-0.5 rounded ${
                              player.role === "bowler" ? "bg-purple-500/15 text-purple-400" :
                              player.role === "all-rounder" ? "bg-emerald-500/15 text-emerald-400" :
                              "bg-orange-500/15 text-orange-400"
                            }`}>{roleLabel(player.role)}</span>
                            <span className={`${ovrColorClass(player.overall)} text-xs font-bold stat-num w-6 text-right`}>{player.overall}</span>
                          </>
                        )}
                        <span className="font-mono text-amber-400 stat-num text-xs">{b.amount.toFixed(2)} Cr</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          <button
            onClick={onFinishAuction}
            className="px-8 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20"
          >
            Start Season
          </button>
        </div>
      </div>
    );
  }

  const currentBidderTeam = auction.currentBidderId
    ? state.teams.find(t => t.id === auction.currentBidderId)
    : null;
  const currentPlayerView = currentPlayer
    ? getPlayerScoutingView(currentPlayer, currentPlayer.teamId, scouting, state.userTeamId)
    : null;
  const currentPlayerRecruitmentTag = currentPlayer ? getRecruitmentTag(recruitment, currentPlayer.id) : null;

  const userInBidding = !!(state.userTeamId && auction.biddingTeams.includes(state.userTeamId));
  const userIsHighest = auction.currentBidderId === state.userTeamId;
  const nextIncrement = getBidIncrement(auction.currentBid);
  const nextBidAmount = Math.round((auction.currentBid + nextIncrement) * 100) / 100;
  const canUserBid = auction.phase === "bidding" && userInBidding && !userIsHighest &&
    userTeam && userTeam.remainingBudget >= nextBidAmount;

  const totalPlayers = auction.players.length;
  const completedCount = auction.completedBids.length + auction.unsold.length;

  // Remaining players to show (after current)
  const remainingPlayers = auction.players.slice(auction.currentPlayerIndex + 1);
  const remainingPlayerViews = remainingPlayers.slice(0, 50).map(player => ({
    player,
    scoutingView: getPlayerScoutingView(player, player.teamId, scouting, state.userTeamId),
    recruitmentTag: getRecruitmentTag(recruitment, player.id),
  }));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
            Live Auction
          </h2>
          <p className="text-th-muted mt-1 font-display">
            Season <span className="stat-num">{state.seasonNumber}</span> — <span className="stat-num">{completedCount}</span>/{totalPlayers} players auctioned
          </p>
        </div>
        <button
          onClick={onSimRemaining}
          className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 w-full sm:w-auto"
        >
          Sim Remaining Auction
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Your Team */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-th bg-th-surface p-4 sticky top-20">
            {userTeam && (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <TeamBadge teamId={userTeam.id} shortName={userTeam.shortName} primaryColor={userTeam.config.primaryColor} size="sm" />
                  <div>
                    <div className="font-display font-semibold text-th-primary text-sm">{userTeam.name}</div>
                    <div className="text-[10px] text-th-muted font-display">
                      <span className="stat-num">{userTeam.remainingBudget.toFixed(1)}</span> Cr left | <span className="stat-num">{userTeam.roster.length}</span> players
                    </div>
                  </div>
                </div>

                <div className="space-y-0.5 max-h-[calc(100vh-280px)] overflow-y-auto">
                  {userTeam.roster
                    .sort((a, b) => b.overall - a.overall)
                    .map(p => (
                      <MiniPlayerRow key={p.id} player={p} />
                    ))}
                  {userTeam.roster.length === 0 && (
                    <p className="text-th-muted text-xs font-display py-2">No players yet</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Center Column: Current Player */}
        <div className="lg:col-span-6">
          {currentPlayer && (
            <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6">
              {/* Player info */}
              <div className="flex items-start gap-4 mb-5">
                <PlayerAvatar name={currentPlayer.name} imageUrl={currentPlayer.imageUrl} size="md" />
                <div className="flex-1">
                  <h3 className="text-xl font-display font-bold text-th-primary">
                    {currentPlayer.name}
                    {currentPlayer.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] ml-2 font-semibold">WK</span>}
                  </h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className={`text-sm font-bold ${ovrColorClass(currentPlayerView?.overall.sortValue ?? currentPlayer.overall)}`}>{currentPlayerView?.overall.display ?? currentPlayer.overall} OVR</span>
                    <span className="text-xs text-th-muted font-display">{roleLabel(currentPlayer.role)}</span>
                    {currentPlayer.battingPosition && battingPositionLabel(currentPlayer.battingPosition) && (
                      <span className={`text-[10px] font-display font-semibold px-1.5 py-0.5 rounded ${battingPositionColor(currentPlayer.battingPosition)}`}>
                        {battingPositionLabel(currentPlayer.battingPosition)}
                      </span>
                    )}
                    {currentPlayerView?.showStyleDetails && currentPlayer.battingHand && (
                      <span className="text-[10px] text-th-muted font-display font-semibold bg-th-body px-1.5 py-0.5 rounded border border-th">
                        {battingHandLabel(currentPlayer.battingHand)}
                      </span>
                    )}
                    {currentPlayerView?.showStyleDetails && currentPlayer.bowlingStyle && bowlingStyleLabel(currentPlayer.bowlingStyle) && (
                      <span className="text-[10px] text-purple-400/70 font-display font-semibold bg-purple-500/10 px-1.5 py-0.5 rounded">
                        {bowlingStyleLabel(currentPlayer.bowlingStyle)}
                      </span>
                    )}
                    <span className="text-xs text-th-muted font-display">Age {currentPlayerView?.ageDisplay ?? currentPlayer.age}</span>
                    <span className="text-xs text-th-muted font-display">{currentPlayer.country}</span>
                    {currentPlayer.isInternational && (
                      <span className="text-[10px] text-orange-400/70 font-semibold border border-orange-400/20 rounded px-1">OS</span>
                    )}
                    {currentPlayerView && (
                      <span className="text-[10px] text-th-faint font-display">{currentPlayerView.confidenceLabel}</span>
                    )}
                    {currentPlayerRecruitmentTag && <RecruitmentBadge tier={currentPlayerRecruitmentTag} />}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold">Base Price</div>
                  <div className="text-sm text-th-secondary font-mono stat-num">{getBasePrice(currentPlayer).toFixed(2)} Cr</div>
                </div>
              </div>

              {/* Attribute bars */}
              <div className="space-y-1.5 mb-6">
                <AttributeBar label="Bat IQ" value={currentPlayerView?.attributes.battingIQ.barValue ?? currentPlayer.ratings.battingIQ} valueLabel={currentPlayerView?.attributes.battingIQ.display ?? String(currentPlayer.ratings.battingIQ)} />
                <AttributeBar label="Timing" value={currentPlayerView?.attributes.timing.barValue ?? currentPlayer.ratings.timing} valueLabel={currentPlayerView?.attributes.timing.display ?? String(currentPlayer.ratings.timing)} />
                <AttributeBar label="Power" value={currentPlayerView?.attributes.power.barValue ?? currentPlayer.ratings.power} valueLabel={currentPlayerView?.attributes.power.display ?? String(currentPlayer.ratings.power)} />
                <AttributeBar label="Running" value={currentPlayerView?.attributes.running.barValue ?? currentPlayer.ratings.running} valueLabel={currentPlayerView?.attributes.running.display ?? String(currentPlayer.ratings.running)} />
                <AttributeBar label="Wickets" value={currentPlayerView?.attributes.wicketTaking.barValue ?? currentPlayer.ratings.wicketTaking} valueLabel={currentPlayerView?.attributes.wicketTaking.display ?? String(currentPlayer.ratings.wicketTaking)} />
                <AttributeBar label="Economy" value={currentPlayerView?.attributes.economy.barValue ?? currentPlayer.ratings.economy} valueLabel={currentPlayerView?.attributes.economy.display ?? String(currentPlayer.ratings.economy)} />
                <AttributeBar label="Accuracy" value={currentPlayerView?.attributes.accuracy.barValue ?? currentPlayer.ratings.accuracy} valueLabel={currentPlayerView?.attributes.accuracy.display ?? String(currentPlayer.ratings.accuracy)} />
                <AttributeBar label="Clutch" value={currentPlayerView?.attributes.clutch.barValue ?? currentPlayer.ratings.clutch} valueLabel={currentPlayerView?.attributes.clutch.display ?? String(currentPlayer.ratings.clutch)} />
              </div>

              {currentPlayer.careerStats && currentPlayer.careerStats.m > 0 && (
                <div className="rounded-xl bg-th-raised p-3 mb-4">
                  <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-2">T20 Career</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-th-muted">M:</span> <span className="text-th-primary stat-num">{currentPlayer.careerStats.m}</span></div>
                    <div><span className="text-th-muted">Runs:</span> <span className="text-orange-300 stat-num">{currentPlayer.careerStats.r}</span></div>
                    <div><span className="text-th-muted">Avg:</span> <span className="text-th-primary stat-num">{currentPlayer.careerStats.avg}</span></div>
                    <div><span className="text-th-muted">SR:</span> <span className="text-th-primary stat-num">{currentPlayer.careerStats.sr}</span></div>
                    <div><span className="text-th-muted">Wkts:</span> <span className="text-purple-300 stat-num">{currentPlayer.careerStats.w}</span></div>
                    <div><span className="text-th-muted">Econ:</span> <span className="text-th-primary stat-num">{currentPlayer.careerStats.econ}</span></div>
                  </div>
                </div>
              )}

              {currentPlayerView && (
                <div className="rounded-xl border border-th bg-th-raised px-4 py-3 mb-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] text-th-faint uppercase tracking-wider font-display">Scout Read</div>
                      <div className="text-sm text-th-secondary font-display mt-1">{currentPlayerView.summary}</div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="text-right">
                        <div className="text-[10px] text-th-faint uppercase tracking-wider font-display">Market Read</div>
                        <div className="text-sm text-th-primary font-mono stat-num mt-1">{currentPlayerView.marketValue.display}</div>
                      </div>
                      <RecruitmentActions
                        tier={currentPlayerRecruitmentTag}
                        onToggleShortlist={() => onToggleShortlist(currentPlayer.id)}
                        onToggleWatchlist={() => onToggleWatchlist(currentPlayer.id)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Current bid */}
              <div className="rounded-xl border border-th bg-th-raised p-4 mb-5 text-center">
                <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-1">Current Bid</div>
                <div className="text-3xl font-display font-bold text-amber-400 stat-num">{auction.currentBid.toFixed(2)} Cr</div>
                {currentBidderTeam && (
                  <div className="flex items-center justify-center gap-2 mt-2">
                    <TeamBadge teamId={currentBidderTeam.id} shortName={currentBidderTeam.shortName} primaryColor={currentBidderTeam.config.primaryColor} size="sm" />
                    <span className="text-sm text-th-secondary font-display">{currentBidderTeam.name}</span>
                  </div>
                )}
                {!currentBidderTeam && auction.phase === "bidding" && (
                  <p className="text-xs text-th-muted font-display mt-1">No bids yet</p>
                )}
              </div>

              {/* Status messages */}
              {auction.phase === "sold" && currentBidderTeam && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 mb-5 text-center">
                  <span className="text-emerald-400 font-display font-bold text-lg">SOLD</span>
                  <span className="text-th-secondary font-display"> to </span>
                  <span className="text-th-primary font-display font-semibold">{currentBidderTeam.name}</span>
                  <span className="text-th-secondary font-display"> for </span>
                  <span className="text-amber-400 font-mono font-bold stat-num">{auction.currentBid.toFixed(2)} Cr</span>
                </div>
              )}

              {auction.phase === "unsold" && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 mb-5 text-center">
                  <span className="text-red-400 font-display font-bold text-lg">UNSOLD</span>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap gap-3">
                {auction.phase === "bidding" && (
                  <>
                    <button
                      onClick={onUserBid}
                      disabled={!canUserBid}
                      className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20 disabled:shadow-none flex-1 sm:flex-none"
                    >
                      Bid {nextBidAmount.toFixed(2)} Cr
                    </button>
                    <button
                      onClick={onUserPass}
                      disabled={!userInBidding}
                      className="px-5 py-2.5 bg-th-raised hover:bg-th-hover text-th-secondary text-sm font-display font-semibold rounded-xl transition-all duration-200 border border-th disabled:opacity-40 flex-1 sm:flex-none"
                    >
                      Pass
                    </button>
                    <button
                      onClick={onSimPlayer}
                      className="px-5 py-2.5 bg-th-raised hover:bg-th-hover text-th-secondary text-sm font-display font-semibold rounded-xl transition-all duration-200 border border-th flex-1 sm:flex-none"
                    >
                      Sim Player
                    </button>
                  </>
                )}

                {(auction.phase === "sold" || auction.phase === "unsold") && (
                  <button
                    onClick={onNextPlayer}
                    className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20"
                  >
                    Next Player
                  </button>
                )}
              </div>

              {/* Auto running indicator */}
              {autoRunning && auction.phase === "bidding" && (
                <div className="mt-3 text-xs text-th-muted font-display flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  CPU teams bidding...
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Available Players */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-th bg-th-surface p-4 sticky top-20">
            <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-3">
              Remaining ({remainingPlayers.length})
            </h3>
            <div className="space-y-0.5 max-h-[calc(100vh-280px)] overflow-y-auto">
              {remainingPlayerViews.map(({ player, scoutingView, recruitmentTag }) => (
                <div key={player.id} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm">
                  <span className="font-display text-th-secondary truncate flex-1">{player.name}</span>
                  {recruitmentTag && <RecruitmentBadge tier={recruitmentTag} compact />}
                  <span className={`text-xs font-bold ${ovrColorClass(scoutingView.overall.sortValue)}`}>{scoutingView.overall.compactDisplay}</span>
                  <span className="text-[10px] text-th-muted font-display">{roleLabel(player.role)}</span>
                  {player.battingPosition && battingPositionLabel(player.battingPosition) && (
                    <span className={`text-[9px] font-display font-semibold px-1 py-0.5 rounded ${battingPositionColor(player.battingPosition)}`}>
                      {battingPositionLabel(player.battingPosition)}
                    </span>
                  )}
                  <span className="text-[10px] text-th-faint font-mono stat-num">{scoutingView.marketValue.compactDisplay}</span>
                </div>
              ))}
              {remainingPlayers.length > 50 && (
                <p className="text-xs text-th-muted font-display text-center py-2">
                  +{remainingPlayers.length - 50} more
                </p>
              )}
              {remainingPlayers.length === 0 && (
                <p className="text-th-muted text-xs font-display py-2">No more players</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom progress bar */}
      <div className="mt-6 rounded-2xl border border-th bg-th-surface p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-th-muted font-display">Auction Progress</span>
          <span className="text-xs text-th-secondary font-mono stat-num">{completedCount} / {totalPlayers}</span>
        </div>
        <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-500"
            style={{ width: `${totalPlayers > 0 ? (completedCount / totalPlayers) * 100 : 0}%` }}
          />
        </div>
      </div>
    </div>
  );
}
