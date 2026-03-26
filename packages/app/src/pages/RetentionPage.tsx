import {
  MAX_RETENTIONS,
  RETENTION_BUDGET,
  evaluateRetentionSelection,
  type Player,
} from "@ipl-sim/engine";
import { GameState } from "../game-state";
import { ovrColorClass, roleLabel } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";

interface Props {
  state: GameState;
  onToggleRetention: (playerId: string) => void;
  onRunCPURetentions: () => void;
  onFinishRetention: () => void;
}

function PlayerRetentionRow({
  player,
  cost,
  isRetained,
  disabled,
  onToggle,
}: {
  player: Player;
  cost: number | null;
  isRetained: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex flex-col gap-3 px-4 py-3 rounded-xl border transition-all duration-200 sm:flex-row sm:items-center ${
        isRetained
          ? "border-emerald-500/30 bg-emerald-500/[0.06]"
          : "border-th bg-th-surface opacity-70"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display font-medium text-th-primary text-sm truncate">{player.name}</span>
          <span className={`text-xs font-bold ovr-badge ${ovrColorClass(player.overall)}`}>{player.overall}</span>
          <span className="text-[10px] text-th-muted font-display font-semibold">{roleLabel(player.role)}</span>
          {player.isInternational && (
            <span className="text-[10px] text-orange-400/70 font-semibold border border-orange-400/20 rounded px-1">OS</span>
          )}
          {player.isWicketKeeper && (
            <span className="text-[10px] text-cyan-400/70 font-semibold border border-cyan-400/20 rounded px-1">WK</span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-th-muted font-display">
          <span>Age {player.age}</span>
          <span>{player.country}</span>
          <span className={`font-semibold ${cost === null ? "text-th-faint" : "text-amber-400/80"}`}>
            {cost === null ? "No slot" : `${cost.toFixed(1)} Cr`}
          </span>
        </div>
      </div>

      <button
        onClick={onToggle}
        disabled={disabled}
        className={`w-full rounded-lg px-4 py-2 text-xs font-display font-semibold transition-all duration-200 sm:w-auto sm:min-w-[80px] ${
          isRetained
            ? "bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20"
            : disabled
              ? "bg-th-hover text-th-faint border border-th cursor-not-allowed"
              : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20"
        }`}
      >
        {isRetained ? "Release" : "Retain"}
      </button>
    </div>
  );
}

export function RetentionPage({ state, onToggleRetention, onRunCPURetentions, onFinishRetention }: Props) {
  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const retention = state.retentionState;

  if (!userTeam || !retention) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
        <p className="text-th-muted">No retention data available.</p>
      </div>
    );
  }

  const retainedSet = new Set(retention.retained);
  const sortedRoster = [...userTeam.roster].sort((a, b) => b.overall - a.overall);
  const retainedPlayers = retention.retained
    .map(id => userTeam.roster.find(player => player.id === id))
    .filter((player): player is Player => player !== undefined);
  const projectedCostByPlayerId = new Map<string, number | null>();

  for (const player of sortedRoster) {
    if (retainedSet.has(player.id)) {
      projectedCostByPlayerId.set(player.id, retention.costs[player.id] ?? null);
      continue;
    }

    const evaluation = evaluateRetentionSelection(
      [...retainedPlayers, player],
      RETENTION_BUDGET,
      MAX_RETENTIONS,
    );
    const cost = evaluation.retentionCosts.find(entry => entry.player.id === player.id)?.cost ?? null;
    projectedCostByPlayerId.set(player.id, evaluation.valid ? cost : null);
  }

  const retainedCount = retention.retained.length;
  const releasedCount = userTeam.roster.length - retainedCount;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
            Player Retention
          </h2>
          <p className="text-th-muted mt-1 font-display">
            Season <span className="stat-num">{state.seasonNumber}</span> — Choose up to {MAX_RETENTIONS} players using IPL fixed retention slabs
          </p>
        </div>
        <button
          onClick={onFinishRetention}
          disabled={!retention.cpuDone}
          className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-40 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 disabled:shadow-none w-full sm:w-auto"
        >
          Finish Retentions & Start Auction
        </button>
      </div>

      {/* Budget + Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="rounded-2xl border border-th bg-th-surface p-4 text-center">
          <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-1">Budget</div>
          <div className="text-2xl font-display font-bold text-th-primary stat-num">
            {retention.budget.toFixed(1)} <span className="text-sm text-th-muted font-normal">/ {RETENTION_BUDGET} Cr</span>
          </div>
        </div>

        <div className="rounded-2xl border border-th bg-th-surface p-4 text-center">
          <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-1">Spent</div>
          <div className="text-2xl font-display font-bold text-amber-400 stat-num">{retention.totalCost.toFixed(1)}</div>
        </div>

        <div className="rounded-2xl border border-th bg-th-surface p-4 text-center">
          <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-1">Retained / Released</div>
          <div className="text-2xl font-display font-bold text-th-primary stat-num">{retainedCount} / {releasedCount}</div>
        </div>
      </div>

      {/* CPU Retentions button */}
      {!retention.cpuDone && (
        <div className="rounded-2xl border border-th bg-th-surface p-5 mb-6">
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-display font-semibold text-th-primary">CPU Team Retentions</h3>
              <p className="text-xs text-th-muted font-display mt-1">Run retention simulation for all CPU-controlled teams before proceeding to auction.</p>
            </div>
            <button
              onClick={onRunCPURetentions}
              className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20 w-full sm:w-auto"
            >
              Sim CPU Retentions
            </button>
          </div>
        </div>
      )}

      {retention.cpuDone && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3 mb-6 text-sm text-emerald-400 font-display">
          CPU retentions complete. You can now finish retentions and start the auction.
        </div>
      )}

      {/* Team header */}
      <div className="rounded-2xl border border-th bg-th-surface p-5 sm:p-6">
        <div className="flex items-center gap-3 mb-5">
          <TeamBadge teamId={userTeam.id} shortName={userTeam.shortName} primaryColor={userTeam.config.primaryColor} size="sm" />
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">{userTeam.name} Roster</h3>
          <span className="text-xs text-th-muted font-display ml-auto">{userTeam.roster.length} players</span>
        </div>

        <div className="space-y-2">
          {sortedRoster.map(player => (
            <PlayerRetentionRow
              key={player.id}
              player={player}
              cost={projectedCostByPlayerId.get(player.id) ?? null}
              isRetained={retainedSet.has(player.id)}
              disabled={!retainedSet.has(player.id) && projectedCostByPlayerId.get(player.id) === null}
              onToggle={() => onToggleRetention(player.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
