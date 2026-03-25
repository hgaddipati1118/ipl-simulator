import { useEffect, useState } from "react";
import { type Team, type Player, type TradeOffer } from "@ipl-sim/engine";
import { GameState } from "../game-state";
import { ovrColorClass } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";
import { getPlayerScoutingView, type PlayerScoutingView, type ScoutingState } from "../scouting";
import { getRecruitmentTag, type RecruitmentState } from "../recruitment";
import { RecruitmentBadge } from "../components/RecruitmentControls";

interface Props {
  state: GameState;
  scouting: ScoutingState;
  recruitment: RecruitmentState;
  onRespondToOffer: (offerId: string, accept: boolean) => void;
  onProposeTrade: (toTeamId: string, userPlayerIds: string[], targetPlayerIds: string[]) => { accepted: boolean; reason: string; counterOffer?: TradeOffer };
  onFinishTrades: () => void;
  onUpdateStadium: (rating: number) => void;
  onScoutTeam: (teamId: string, amount?: number) => void;
  onScoutPlayers: (playerIds: string[], amount?: number) => void;
  onPromoteProspect?: (index: number) => void;
}

function PlayerChip({
  player,
  scoutingView,
  recruitment,
  selected,
  onClick,
}: {
  player: Player;
  scoutingView: PlayerScoutingView;
  recruitment: RecruitmentState;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 min-h-[44px] border ${
        selected
          ? "bg-blue-600/20 border-blue-500/40 text-white"
          : "bg-th-surface border-th text-th-secondary hover:bg-th-hover hover:text-th-primary"
      }`}
    >
      <span className="font-display font-medium">{player.name}</span>
      <span className={`text-xs ovr-badge ${ovrColorClass(scoutingView.overall.sortValue)}`}>{scoutingView.overall.compactDisplay}</span>
      <span className="text-[10px] text-th-muted font-display">{player.role}</span>
      {player.isInternational && <span className="text-[10px] text-orange-400/60 font-semibold">OS</span>}
      <RecruitmentBadge tier={getRecruitmentTag(recruitment, player.id)} compact />
      {!scoutingView.exactRatings && (
        <span className="text-[10px] text-th-faint font-display">{scoutingView.confidenceLabel}</span>
      )}
    </button>
  );
}

function IncomingOffers({
  state,
  scouting,
  recruitment,
  onRespond,
}: {
  state: GameState;
  scouting: ScoutingState;
  recruitment: RecruitmentState;
  onRespond: (id: string, accept: boolean) => void;
}) {
  const pending = state.tradeOffers.filter(o => o.status === "pending");
  if (pending.length === 0) {
    return <p className="text-th-muted text-sm font-display">No incoming trade offers.</p>;
  }

  return (
    <div className="space-y-4">
      {pending.map(offer => {
        const fromTeam = state.teams.find(t => t.id === offer.fromTeamId);
        const toTeam = state.teams.find(t => t.id === offer.toTeamId);
        const playersOffered = offer.playersOffered.map(id =>
          fromTeam?.roster.find(p => p.id === id)
        ).filter((p): p is Player => !!p);
        const playersRequested = offer.playersRequested.map(id =>
          toTeam?.roster.find(p => p.id === id)
        ).filter((p): p is Player => !!p);

        return (
          <div key={offer.id} className="rounded-xl p-4 border border-th bg-th-surface">
            <div className="flex items-center gap-2 mb-3">
              {fromTeam && (
                <TeamBadge teamId={fromTeam.id} shortName={fromTeam.shortName} primaryColor={fromTeam.config.primaryColor} size="sm" />
              )}
              <span className="text-th-primary font-display font-medium text-sm">{fromTeam?.name} offers a trade</span>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-2">You receive</p>
                <div className="space-y-1.5">
                  {playersOffered.map(p => (
                    <div key={p.id} className="flex items-center gap-2 text-sm">
                      <span className="text-emerald-400 text-xs">+</span>
                      <span className="text-th-primary font-display">{p.name}</span>
                      <RecruitmentBadge tier={getRecruitmentTag(recruitment, p.id)} compact />
                      <span className={`text-xs ovr-badge ${ovrColorClass(getPlayerScoutingView(p, fromTeam?.id, scouting, state.userTeamId).overall.sortValue)}`}>
                        {getPlayerScoutingView(p, fromTeam?.id, scouting, state.userTeamId).overall.compactDisplay}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-2">You send</p>
                <div className="space-y-1.5">
                  {playersRequested.map(p => (
                    <div key={p.id} className="flex items-center gap-2 text-sm">
                      <span className="text-red-400 text-xs">-</span>
                      <span className="text-th-primary font-display">{p.name}</span>
                      <RecruitmentBadge tier={getRecruitmentTag(recruitment, p.id)} compact />
                      <span className={`text-xs ovr-badge ${ovrColorClass(getPlayerScoutingView(p, toTeam?.id, scouting, state.userTeamId).overall.sortValue)}`}>
                        {getPlayerScoutingView(p, toTeam?.id, scouting, state.userTeamId).overall.compactDisplay}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => onRespond(offer.id, true)}
                className="px-4 py-2 bg-emerald-600/80 hover:bg-emerald-500/80 text-white text-sm font-display font-medium rounded-lg transition-colors"
              >
                Accept
              </button>
              <button
                onClick={() => onRespond(offer.id, false)}
                className="px-4 py-2 bg-th-raised hover:bg-th-hover text-th-secondary text-sm font-display font-medium rounded-lg transition-colors border border-th"
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProposeTrade({ state, scouting, recruitment, onPropose, onScoutTeam }: {
  state: GameState;
  scouting: ScoutingState;
  recruitment: RecruitmentState;
  onPropose: (toTeamId: string, userPlayerIds: string[], targetPlayerIds: string[]) => { accepted: boolean; reason: string };
  onScoutTeam: (teamId: string, amount?: number) => void;
}) {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [selectedUserPlayers, setSelectedUserPlayers] = useState<Set<string>>(new Set());
  const [selectedTargetPlayers, setSelectedTargetPlayers] = useState<Set<string>>(new Set());
  const [shortlistFirst, setShortlistFirst] = useState(true);
  const [lastResult, setLastResult] = useState<{ accepted: boolean; reason: string; counterOffer?: TradeOffer } | null>(null);

  useEffect(() => {
    if (!selectedTarget) return;
    onScoutTeam(selectedTarget, 10);
  }, [selectedTarget, onScoutTeam]);

  if (!userTeam) return null;

  const targetTeam = state.teams.find(t => t.id === selectedTarget);
  const cpuTeams = state.teams.filter(t => t.id !== state.userTeamId);

  const toggleUserPlayer = (id: string) => {
    const next = new Set(selectedUserPlayers);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedUserPlayers(next);
  };

  const toggleTargetPlayer = (id: string) => {
    const next = new Set(selectedTargetPlayers);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedTargetPlayers(next);
  };

  const handleSubmit = () => {
    if (!selectedTarget || selectedUserPlayers.size === 0 || selectedTargetPlayers.size === 0) return;
    const result = onPropose(selectedTarget, [...selectedUserPlayers], [...selectedTargetPlayers]);
    setLastResult(result);
    if (result.accepted) {
      setSelectedUserPlayers(new Set());
      setSelectedTargetPlayers(new Set());
    }
  };

  return (
    <div>
      {/* Team selection */}
      <div className="mb-5">
        <p className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-2">Trade with</p>
        <div className="flex flex-wrap gap-2">
          {cpuTeams.map(t => (
            <button
              key={t.id}
              onClick={() => {
                setSelectedTarget(t.id);
                setSelectedTargetPlayers(new Set());
                setLastResult(null);
              }}
              className={`px-3 py-2 rounded-lg text-xs font-display font-semibold transition-all duration-200 border min-h-[36px] ${
                selectedTarget === t.id
                  ? "border-blue-500/40 text-white"
                  : "border-th text-th-muted hover:text-th-primary hover:bg-th-hover"
              }`}
              style={selectedTarget === t.id ? { backgroundColor: t.config.primaryColor + "20" } : {}}
            >
              {t.shortName}
            </button>
          ))}
        </div>
      </div>

      {selectedTarget && targetTeam && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Your players */}
          <div>
            <p className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-2">Your players to offer</p>
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {userTeam.roster
                .sort((a, b) => b.overall - a.overall)
                .map(p => (
                  <PlayerChip
                    key={p.id}
                    player={p}
                    scoutingView={getPlayerScoutingView(p, userTeam.id, scouting, state.userTeamId)}
                    recruitment={recruitment}
                    selected={selectedUserPlayers.has(p.id)}
                    onClick={() => toggleUserPlayer(p.id)}
                  />
                ))}
            </div>
          </div>

          {/* Target team's players */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold">{targetTeam.shortName}'s players you want</p>
              <label className="flex items-center gap-2 text-[10px] text-th-muted font-display">
                <input
                  type="checkbox"
                  checked={shortlistFirst}
                  onChange={e => setShortlistFirst(e.target.checked)}
                  className="accent-orange-500"
                />
                Shortlist first
              </label>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {targetTeam.roster
                .sort((a, b) => {
                  if (shortlistFirst) {
                    const aShortlisted = getRecruitmentTag(recruitment, a.id) === "shortlist" ? 1 : 0;
                    const bShortlisted = getRecruitmentTag(recruitment, b.id) === "shortlist" ? 1 : 0;
                    if (aShortlisted !== bShortlisted) return bShortlisted - aShortlisted;
                  }
                  return b.overall - a.overall;
                })
                .map(p => (
                  <PlayerChip
                    key={p.id}
                    player={p}
                    scoutingView={getPlayerScoutingView(p, targetTeam.id, scouting, state.userTeamId)}
                    recruitment={recruitment}
                    selected={selectedTargetPlayers.has(p.id)}
                    onClick={() => toggleTargetPlayer(p.id)}
                  />
                ))}
            </div>
          </div>
        </div>
      )}

      {selectedTarget && (
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button
            onClick={handleSubmit}
            disabled={selectedUserPlayers.size === 0 || selectedTargetPlayers.size === 0}
            className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:from-gray-800 disabled:to-gray-800 disabled:text-gray-600 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20 disabled:shadow-none"
          >
            Propose Trade
          </button>
          {lastResult && (
            <div className="flex flex-col gap-1">
              <span className={`text-sm font-display ${lastResult.accepted ? "text-emerald-400" : lastResult.counterOffer ? "text-amber-400" : "text-red-400"}`}>
                {lastResult.accepted
                  ? "Trade accepted!"
                  : lastResult.counterOffer
                    ? "Counter-offer received!"
                    : `Rejected: ${lastResult.reason}`}
              </span>
              {lastResult.counterOffer && (() => {
                const co = lastResult.counterOffer;
                const coFrom = state.teams.find(t => t.id === co.fromTeamId);
                const coTo = state.teams.find(t => t.id === co.toTeamId);
                const coOffered = co.playersOffered.map(id => coFrom?.roster.find(p => p.id === id)).filter(Boolean);
                const coRequested = co.playersRequested.map(id => coTo?.roster.find(p => p.id === id)).filter(Boolean);
                return (
                  <div className="bg-amber-900/10 border border-amber-800/20 rounded-xl p-3 mt-2 text-sm">
                    <p className="text-amber-400 font-display font-medium mb-2">{coFrom?.shortName} counter-proposes:</p>
                    <p className="text-th-secondary font-display">
                      They'll give: <span className="text-th-primary">{coOffered.map(p => p!.name).join(", ")}</span>
                    </p>
                    <p className="text-th-secondary font-display">
                      They want: <span className="text-th-primary">{coRequested.map(p => p!.name).join(", ")}</span>
                    </p>
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => {
                          const result = onPropose(co.fromTeamId, co.playersRequested, co.playersOffered);
                          setLastResult(result);
                        }}
                        className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-500/80 text-white text-xs font-display font-medium rounded-lg transition-colors"
                      >
                        Accept Counter
                      </button>
                      <button
                        onClick={() => setLastResult(null)}
                        className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs font-display font-medium rounded-lg transition-colors border border-th"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stadiumLabel(rating: number): { text: string; color: string } {
  if (rating <= 0.80) return { text: "Batting Paradise", color: "text-orange-400" };
  if (rating <= 0.95) return { text: "Batting-Friendly", color: "text-amber-400" };
  if (rating <= 1.05) return { text: "Neutral", color: "text-gray-400" };
  if (rating <= 1.15) return { text: "Bowling-Friendly", color: "text-emerald-400" };
  return { text: "Bowling Paradise", color: "text-green-400" };
}

function StadiumEditor({ team, onUpdate }: { team: Team; onUpdate: (rating: number) => void }) {
  const rating = team.config.stadiumBowlingRating ?? 1.0;
  const label = stadiumLabel(rating);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-th-primary font-display font-medium text-sm">{team.config.stadiumName ?? `${team.config.city} Stadium`}</span>
          <span className={`ml-2 text-xs font-display ${label.color}`}>{label.text}</span>
        </div>
        <span className="text-th-primary font-mono text-sm stat-num">{rating.toFixed(2)}</span>
      </div>

      <input
        type="range"
        min="0.70"
        max="1.30"
        step="0.05"
        value={rating}
        onChange={e => onUpdate(parseFloat(e.target.value))}
        className="w-full h-2 rounded-full appearance-none cursor-pointer bg-white/10 accent-orange-500"
      />

      <div className="flex justify-between mt-1.5 text-[10px] text-th-muted font-mono">
        <span>0.70 (Flat)</span>
        <span>1.00</span>
        <span>1.30 (Green)</span>
      </div>

      <p className="text-th-muted text-xs mt-3 font-display">
        Higher values increase wicket and dot ball probability at your home ground.
      </p>
    </div>
  );
}

export function TradePage({
  state,
  scouting,
  recruitment,
  onRespondToOffer,
  onProposeTrade,
  onFinishTrades,
  onUpdateStadium,
  onScoutTeam,
  onScoutPlayers,
  onPromoteProspect,
}: Props) {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const pendingOfferPlayerIds = state.tradeOffers
    .filter(offer => offer.status === "pending")
    .flatMap(offer => [...offer.playersOffered, ...offer.playersRequested]);

  useEffect(() => {
    if (pendingOfferPlayerIds.length === 0) return;
    onScoutPlayers(pendingOfferPlayerIds, 8);
  }, [pendingOfferPlayerIds.join(","), onScoutPlayers]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">Trade Window</h2>
          <p className="text-th-muted mt-1 font-display">Season <span className="stat-num">{state.seasonNumber}</span> — Pre-auction trades</p>
          <p className="text-th-faint text-xs font-display mt-1">Opposition values are now filtered through scouting confidence instead of exact internals.</p>
        </div>
        <button
          onClick={onFinishTrades}
          className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 w-full sm:w-auto"
        >
          Finish Trades & Start Auction
        </button>
      </div>

      {/* Incoming offers */}
      <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5">
        <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Incoming Trade Offers</h3>
        <IncomingOffers state={state} scouting={scouting} recruitment={recruitment} onRespond={onRespondToOffer} />
      </div>

      {/* Propose trade */}
      <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5">
        <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Propose a Trade</h3>
        <ProposeTrade state={state} scouting={scouting} recruitment={recruitment} onPropose={onProposeTrade} onScoutTeam={onScoutTeam} />
      </div>

      {/* Stadium settings */}
      {userTeam && (
        <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Stadium Settings</h3>
          <StadiumEditor team={userTeam} onUpdate={onUpdateStadium} />
        </div>
      )}

      {/* Youth Academy Prospects */}
      {state.youthProspects && state.youthProspects.length > 0 && (
        <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Youth Academy</h3>
          <p className="text-th-muted text-sm mb-4">Your academy has produced {state.youthProspects.length} prospect{state.youthProspects.length > 1 ? "s" : ""} this season. Promote them to your squad for free.</p>
          <div className="space-y-3">
            {state.youthProspects.map((prospect, i) => {
              const p = prospect.player;
              const scoutColor = prospect.scoutRating === "Diamond" ? "text-cyan-400" : prospect.scoutRating === "Gold" ? "text-yellow-400" : prospect.scoutRating === "Silver" ? "text-gray-300" : "text-amber-700";
              return (
                <div key={p.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-th-raised border border-th">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-th-primary font-display font-medium text-sm">{p.name}</span>
                        <span className={`text-[10px] font-display font-bold ${scoutColor}`}>{prospect.scoutRating}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-th-muted text-xs">{p.role}</span>
                        <span className="text-th-faint text-xs">Age {p.age}</span>
                        <span className="text-th-faint text-xs">Pot {prospect.potential}</span>
                        <span className={`text-xs ${ovrColorClass(p.overall)}`}>{p.overall} OVR</span>
                      </div>
                    </div>
                  </div>
                  {onPromoteProspect && (
                    <button
                      onClick={() => onPromoteProspect(i)}
                      className="px-3 py-1.5 text-xs font-display font-semibold bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-600/30 transition-colors"
                    >
                      Promote
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed trades */}
      {state.completedTrades.length > 0 && (
        <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Trade History</h3>
          <div className="space-y-2">
            {state.completedTrades.map((t, i) => (
              <div key={i} className={`text-sm px-3 py-2.5 rounded-xl border ${t.accepted ? "bg-emerald-500/[0.04] border-emerald-500/10" : "bg-red-500/[0.04] border-red-500/10"}`}>
                <span className={`font-display font-medium ${t.accepted ? "text-emerald-400" : "text-red-400"}`}>
                  {t.accepted ? "Accepted" : "Rejected"}
                </span>
                {" — "}
                <span className="text-th-primary font-display">{t.fromTeam}</span>
                <span className="text-th-muted"> sends </span>
                <span className="text-th-secondary font-display">{t.playersIn.join(", ")}</span>
                <span className="text-th-muted"> for </span>
                <span className="text-th-secondary font-display">{t.playersOut.join(", ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
