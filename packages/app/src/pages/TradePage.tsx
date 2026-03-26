import { useEffect, useState, useMemo } from "react";
import { type Team, type Player, type TradeOffer } from "@ipl-sim/engine";
import { GameState } from "../game-state";
import { ovrColorClass, roleLabel, bowlingStyleLabel } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";
import { PlayerLink } from "../components/PlayerLink";
import { getPlayerScoutingView, type PlayerScoutingView, type ScoutingState } from "../scouting";
import { getRecruitmentTag, type RecruitmentState } from "../recruitment";
import { RecruitmentBadge } from "../components/RecruitmentControls";

interface Props {
  state: GameState;
  scouting: ScoutingState;
  recruitment: RecruitmentState;
  onExtendContract: (playerId: string, years: number) => void;
  onReleaseExpiredContracts: () => void;
  onRespondToOffer: (offerId: string, accept: boolean) => void;
  onProposeTrade: (toTeamId: string, userPlayerIds: string[], targetPlayerIds: string[]) => { accepted: boolean; reason: string; counterOffer?: TradeOffer };
  onFinishTrades: () => void;
  onUpdateStadium: (rating: number) => void;
  onScoutTeam: (teamId: string, amount?: number) => void;
  onScoutPlayers: (playerIds: string[], amount?: number) => void;
  onPromoteProspect?: (index: number) => void;
  onSignFreeAgent?: (playerId: string, bid: number) => void;
}

function ContractDesk({
  userTeam,
  tradeLocked,
  onExtendContract,
  onReleaseExpiredContracts,
}: {
  userTeam: Team;
  tradeLocked: boolean;
  onExtendContract: (playerId: string, years: number) => void;
  onReleaseExpiredContracts: () => void;
}) {
  const expiredPlayers = [...userTeam.roster]
    .filter(player => player.contractYears <= 0)
    .sort((a, b) => b.overall - a.overall);
  const finalYearPlayers = [...userTeam.roster]
    .filter(player => player.contractYears === 1)
    .sort((a, b) => b.overall - a.overall);

  if (expiredPlayers.length === 0 && finalYearPlayers.length === 0) {
    return null;
  }

  return (
    <div className={`rounded-2xl border p-5 sm:p-6 mb-5 ${
      tradeLocked
        ? "border-amber-500/20 bg-amber-500/[0.05]"
        : "border-th bg-th-surface"
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Contract Desk</h3>
          <p className="text-th-muted text-sm mt-2 font-display leading-6">
            Resolve expired deals before the trade market opens. Final-year players can also be renewed here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-display">
          <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-red-300">
            {expiredPlayers.length} expired
          </span>
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-amber-300">
            {finalYearPlayers.length} on final year
          </span>
        </div>
      </div>

      {tradeLocked && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 mb-4">
          <div className="text-amber-300 font-display font-medium text-sm">Trade market locked</div>
          <div className="text-amber-100/80 text-sm mt-1 leading-6">
            Renew or release your expired contracts to unlock incoming offers and proposals.
          </div>
        </div>
      )}

      {expiredPlayers.length > 0 && (
        <div className="mb-5">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-red-300 text-[10px] uppercase tracking-wider font-display font-semibold">Expired Deals</div>
              <div className="text-th-faint text-xs mt-1">These players will hit the market unless you renew them now.</div>
            </div>
            <button
              onClick={onReleaseExpiredContracts}
              className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-display font-medium text-red-200 transition-colors hover:bg-red-500/15 sm:w-auto"
            >
              Release All Expired
            </button>
          </div>
          <div className="space-y-2">
            {expiredPlayers.map(player => (
              <div key={player.id} className="rounded-xl border border-th bg-th-raised px-4 py-3">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <PlayerLink playerId={player.id} className="text-th-primary font-display font-medium">{player.name}</PlayerLink>
                        <span className={`text-xs font-semibold ${ovrColorClass(player.overall)}`}>{player.overall} OVR</span>
                        {player.contractYears <= 0 && (
                          <span className="text-[10px] rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-red-300">
                            FA
                          </span>
                        )}
                      </div>
                      <div className="text-th-muted text-xs mt-1 font-display">
                        {player.role} • Age {player.age} • Last deal {player.bid.toFixed(1)} Cr
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => onExtendContract(player.id, 1)}
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-display font-medium text-amber-200 hover:bg-amber-500/15 transition-colors"
                    >
                      Renew +1 Year
                    </button>
                    <button
                      onClick={() => onExtendContract(player.id, 2)}
                      className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-display font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors"
                    >
                      Renew +2 Years
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {finalYearPlayers.length > 0 && (
        <div>
          <div className="text-amber-300 text-[10px] uppercase tracking-wider font-display font-semibold mb-3">Entering Final Year</div>
          <div className="space-y-2">
            {finalYearPlayers.map(player => (
              <div key={player.id} className="rounded-xl border border-th bg-th-raised px-4 py-3">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <PlayerLink playerId={player.id} className="text-th-primary font-display font-medium">{player.name}</PlayerLink>
                      <span className={`text-xs font-semibold ${ovrColorClass(player.overall)}`}>{player.overall} OVR</span>
                      {player.contractYears <= 0 && (
                        <span className="text-[10px] rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-red-300">
                          FA
                        </span>
                      )}
                    </div>
                    <div className="text-th-muted text-xs mt-1 font-display">
                      {player.role} • Age {player.age} • Current bid {player.bid.toFixed(1)} Cr
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => onExtendContract(player.id, 1)}
                      className="rounded-lg border border-th bg-th-overlay px-3 py-1.5 text-xs font-display font-medium text-th-secondary hover:text-th-primary hover:bg-th-hover transition-colors"
                    >
                      Add 1 Year
                    </button>
                    <button
                      onClick={() => onExtendContract(player.id, 2)}
                      className="rounded-lg border border-th bg-th-overlay px-3 py-1.5 text-xs font-display font-medium text-th-secondary hover:text-th-primary hover:bg-th-hover transition-colors"
                    >
                      Add 2 Years
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
      className={`flex min-h-[44px] flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition-all duration-200 ${
        selected
          ? "bg-blue-600/20 border-blue-500/40 text-white"
          : "bg-th-surface border-th text-th-secondary hover:bg-th-hover hover:text-th-primary"
      }`}
    >
      <span className="min-w-0 font-display font-medium">{player.name}</span>
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
            <div className="mb-3 flex items-start gap-2 sm:items-center">
              {fromTeam && (
                <TeamBadge teamId={fromTeam.id} shortName={fromTeam.shortName} primaryColor={fromTeam.config.primaryColor} size="sm" />
              )}
              <span className="text-th-primary font-display font-medium text-sm">{fromTeam?.name} offers a trade</span>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-2">You receive</p>
                <div className="space-y-1.5">
                  {playersOffered.map(p => (
                    <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
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
                    <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
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

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                onClick={() => onRespond(offer.id, true)}
                className="w-full rounded-lg bg-emerald-600/80 px-4 py-2 text-sm font-display font-medium text-white transition-colors hover:bg-emerald-500/80 sm:w-auto"
              >
                Accept
              </button>
              <button
                onClick={() => onRespond(offer.id, false)}
                className="w-full rounded-lg border border-th bg-th-raised px-4 py-2 text-sm font-display font-medium text-th-secondary transition-colors hover:bg-th-hover sm:w-auto"
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
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            onClick={handleSubmit}
            disabled={selectedUserPlayers.size === 0 || selectedTargetPlayers.size === 0}
            className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2.5 text-sm font-display font-semibold text-white shadow-lg shadow-blue-500/20 transition-all duration-200 hover:from-blue-500 hover:to-indigo-500 disabled:from-gray-800 disabled:to-gray-800 disabled:text-gray-600 disabled:shadow-none sm:w-auto"
          >
            Propose Trade
          </button>
          {lastResult && (
            <div className="flex w-full flex-col gap-1 sm:w-auto">
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
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <button
                        onClick={() => {
                          const result = onPropose(co.fromTeamId, co.playersRequested, co.playersOffered);
                          setLastResult(result);
                        }}
                        className="w-full rounded-lg bg-emerald-600/80 px-3 py-1.5 text-xs font-display font-medium text-white transition-colors hover:bg-emerald-500/80 sm:w-auto"
                      >
                        Accept Counter
                      </button>
                      <button
                        onClick={() => setLastResult(null)}
                        className="w-full rounded-lg border border-th bg-th-raised px-3 py-1.5 text-xs font-display font-medium text-th-secondary transition-colors hover:bg-th-hover sm:w-auto"
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
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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

const COUNTRY_FLAGS: Record<string, string> = {
  India: "\u{1F1EE}\u{1F1F3}",
  Australia: "\u{1F1E6}\u{1F1FA}",
  England: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  "South Africa": "\u{1F1FF}\u{1F1E6}",
  "New Zealand": "\u{1F1F3}\u{1F1FF}",
  "West Indies": "\u{1F3DD}\u{FE0F}",
  Afghanistan: "\u{1F1E6}\u{1F1EB}",
  Bangladesh: "\u{1F1E7}\u{1F1E9}",
  "Sri Lanka": "\u{1F1F1}\u{1F1F0}",
  Pakistan: "\u{1F1F5}\u{1F1F0}",
  Zimbabwe: "\u{1F1FF}\u{1F1FC}",
  Nepal: "\u{1F1F3}\u{1F1F5}",
  Netherlands: "\u{1F1F3}\u{1F1F1}",
  Ireland: "\u{1F1EE}\u{1F1EA}",
  Scotland: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  USA: "\u{1F1FA}\u{1F1F8}",
};
function countryFlag(country: string): string {
  return COUNTRY_FLAGS[country] ?? "\u{1F3CF}";
}

function FreeAgentBrowser({
  state,
  userTeam,
  onSignFreeAgent,
}: {
  state: GameState;
  userTeam: Team;
  onSignFreeAgent: (playerId: string, bid: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const topFreeAgents = useMemo(() => {
    return [...state.playerPool]
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 20);
  }, [state.playerPool]);

  const rosterFull = userTeam.roster.length >= 25;
  const overseasCount = userTeam.internationalCount;

  if (topFreeAgents.length === 0) return null;

  return (
    <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full"
      >
        <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">
          Sign Free Agents
          <span className="ml-2 text-th-faint font-mono stat-num">({state.playerPool.length} available)</span>
        </h3>
        <span className="text-th-muted text-sm font-display">{expanded ? "\u25B2" : "\u25BC"}</span>
      </button>

      {expanded && (
        <div className="mt-4">
          <p className="text-th-muted text-sm font-display mb-4">
            Top available players from the free agent pool. Signing costs their market value.
          </p>

          {rosterFull && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 mb-4">
              <span className="text-red-300 text-sm font-display">Roster full (25/25). Release a player before signing.</span>
            </div>
          )}

          <div className="space-y-2">
            {topFreeAgents.map(player => {
              const overseasBlocked = player.isInternational && overseasCount >= 8;
              const budgetShort = userTeam.remainingBudget < player.marketValue;
              const canSign = !rosterFull && !overseasBlocked && !budgetShort;

              let disabledReason = "";
              if (rosterFull) disabledReason = "Roster full";
              else if (overseasBlocked) disabledReason = "OS limit";
              else if (budgetShort) disabledReason = "No budget";

              return (
                <div key={player.id} className="flex flex-col gap-3 rounded-xl border border-th bg-th-raised px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-sm" title={player.country}>{countryFlag(player.country)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-th-primary font-display font-medium text-sm truncate">{player.name}</span>
                        <span className={`text-xs font-bold ${ovrColorClass(player.overall)}`}>{player.overall}</span>
                        <span className={`text-[10px] font-display font-semibold px-1.5 py-0.5 rounded ${
                          player.role === "bowler" ? "bg-purple-500/15 text-purple-400" :
                          player.role === "all-rounder" ? "bg-emerald-500/15 text-emerald-400" :
                          "bg-orange-500/15 text-orange-400"
                        }`}>{roleLabel(player.role)}</span>
                        {player.isInternational && (
                          <span className="text-[10px] text-orange-400/70 font-semibold border border-orange-400/20 rounded px-1">OS</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <span className="text-th-muted text-xs font-display">Age {player.age}</span>
                        {player.bowlingStyle && bowlingStyleLabel(player.bowlingStyle) && (
                          <span className="text-[10px] text-purple-400/70 font-display font-semibold bg-purple-500/10 px-1.5 py-0.5 rounded">
                            {bowlingStyleLabel(player.bowlingStyle)}
                          </span>
                        )}
                        <span className="text-th-faint text-xs font-mono stat-num">{player.marketValue.toFixed(2)} Cr</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:ml-3 sm:w-auto sm:justify-end">
                    {!canSign && disabledReason && (
                      <span className="text-[10px] text-red-400/70 font-display">{disabledReason}</span>
                    )}
                    <button
                      onClick={() => onSignFreeAgent(player.id, player.marketValue)}
                      disabled={!canSign}
                      className="w-full whitespace-nowrap rounded-lg border border-emerald-500/30 bg-emerald-600/20 px-3 py-1.5 text-xs font-display font-semibold text-emerald-400 transition-colors hover:bg-emerald-600/30 disabled:opacity-40 disabled:hover:bg-emerald-600/20 sm:w-auto"
                    >
                      Sign
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function TradePage({
  state,
  scouting,
  recruitment,
  onExtendContract,
  onReleaseExpiredContracts,
  onRespondToOffer,
  onProposeTrade,
  onFinishTrades,
  onUpdateStadium,
  onScoutTeam,
  onScoutPlayers,
  onPromoteProspect,
  onSignFreeAgent,
}: Props) {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const tradeLocked = state.contractsResolved === false || !!userTeam?.roster.some(player => player.contractYears <= 0);
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
          <p className="text-th-faint text-xs font-display mt-1">
            {tradeLocked
              ? "Resolve expired contracts first, then the trade market will open."
              : "Opposition values are filtered through scouting confidence instead of exact internals."}
          </p>
        </div>
        <button
          onClick={onFinishTrades}
          disabled={tradeLocked}
          className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:from-gray-800 disabled:to-gray-800 disabled:text-gray-500 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 disabled:shadow-none w-full sm:w-auto"
        >
          {tradeLocked ? "Resolve Contracts First" : "Finish Trades & Start Auction"}
        </button>
      </div>

      {userTeam && (
        <ContractDesk
          userTeam={userTeam}
          tradeLocked={tradeLocked}
          onExtendContract={onExtendContract}
          onReleaseExpiredContracts={onReleaseExpiredContracts}
        />
      )}

      {/* Incoming offers */}
      <div className={`rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5 transition-opacity ${tradeLocked ? "opacity-45 pointer-events-none" : ""}`}>
        <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Incoming Trade Offers</h3>
        {tradeLocked ? (
          <p className="text-th-muted text-sm font-display">Incoming offers unlock once your expired contracts are resolved.</p>
        ) : (
          <IncomingOffers state={state} scouting={scouting} recruitment={recruitment} onRespond={onRespondToOffer} />
        )}
      </div>

      {/* Propose trade */}
      <div className={`rounded-2xl border border-th bg-th-surface p-5 sm:p-6 mb-5 transition-opacity ${tradeLocked ? "opacity-45 pointer-events-none" : ""}`}>
        <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Propose a Trade</h3>
        {tradeLocked ? (
          <p className="text-th-muted text-sm font-display">Resolve contracts first, then you can start shopping the squad.</p>
        ) : (
          <ProposeTrade state={state} scouting={scouting} recruitment={recruitment} onPropose={onProposeTrade} onScoutTeam={onScoutTeam} />
        )}
      </div>

      {/* Free Agent Browser */}
      {userTeam && onSignFreeAgent && !tradeLocked && (
        <FreeAgentBrowser
          state={state}
          userTeam={userTeam}
          onSignFreeAgent={onSignFreeAgent}
        />
      )}

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
                <div key={p.id} className="flex flex-col gap-3 rounded-xl border border-th bg-th-raised px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-th-primary font-display font-medium text-sm">{p.name}</span>
                        <span className={`text-[10px] font-display font-bold ${scoutColor}`}>{prospect.scoutRating}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
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
                      className="w-full rounded-lg border border-emerald-500/30 bg-emerald-600/20 px-3 py-1.5 text-xs font-display font-semibold text-emerald-400 transition-colors hover:bg-emerald-600/30 sm:w-auto"
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
