import { useMemo } from "react";
import { Link } from "react-router-dom";
import { GameState } from "../game-state";
import { PlayerLink } from "../components/PlayerLink";

interface Props {
  state: GameState;
}

const EVENT_STYLES: Record<string, string> = {
  praise: "bg-green-950/30 text-green-300 border-green-900/40",
  criticism: "bg-red-950/30 text-red-300 border-red-900/40",
  media: "bg-blue-950/30 text-blue-300 border-blue-900/40",
  board: "bg-amber-950/30 text-amber-300 border-amber-900/40",
  milestone: "bg-purple-950/30 text-purple-300 border-purple-900/40",
  rivalry: "bg-orange-950/30 text-orange-300 border-orange-900/40",
};

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-th bg-th-surface px-3 py-2.5">
      <div className="text-th-faint text-[10px] uppercase tracking-wider">{label}</div>
      <div className="text-th-primary text-base font-semibold mt-1">{value}</div>
    </div>
  );
}

export function InboxPage({ state }: Props) {
  const userTeam = state.teams.find(team => team.id === state.userTeamId) ?? null;

  const standings = useMemo(
    () => [...state.teams].sort((a, b) => (b.points !== a.points ? b.points - a.points : b.nrr - a.nrr)),
    [state.teams],
  );

  const userPosition = userTeam ? standings.findIndex(team => team.id === userTeam.id) + 1 : 0;
  const nextMatch = state.currentMatchIndex < state.schedule.length ? state.schedule[state.currentMatchIndex] : null;
  const latestStories = state.narrativeEvents;
  const recentTrades = [...state.completedTrades].reverse().slice(0, 4);
  const recentInjuries = state.recentInjuries.slice(0, 4);

  const hotPlayers = userTeam
    ? [...userTeam.roster].filter(player => player.form >= 65).sort((a, b) => b.form - a.form).slice(0, 4)
    : [];
  const coldPlayers = userTeam
    ? [...userTeam.roster].filter(player => player.form <= 35).sort((a, b) => a.form - b.form).slice(0, 4)
    : [];

  const actionItems = [
    state.needsLineup ? {
      title: "Lineup due",
      detail: "Your next match needs a confirmed XI and bowling plan.",
      href: "/lineup",
    } : null,
    nextMatch ? {
      title: "Next fixture",
      detail: `${nextMatch.homeTeamId} vs ${nextMatch.awayTeamId}`,
      href: "/season",
    } : null,
    state.tradeOffers.some(offer => offer.status === "pending") ? {
      title: "Trade window open",
      detail: `${state.tradeOffers.filter(offer => offer.status === "pending").length} offer(s) need an answer.`,
      href: "/trade",
    } : null,
  ].filter((item): item is { title: string; detail: string; href: string } => item !== null);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">Inbox</h2>
          <p className="text-th-muted mt-1">
            Match stories, board pressure, squad form, and what needs attention next.
          </p>
        </div>
        {userTeam && (
          <div className="text-sm text-th-secondary">
            {userTeam.name} {userPosition > 0 ? `• #${userPosition} in table` : ""}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <MetricCard label="Stories" value={String(latestStories.length)} />
        <MetricCard label="Recent Injuries" value={String(recentInjuries.length)} />
        <MetricCard label="Pending Offers" value={String(state.tradeOffers.filter(offer => offer.status === "pending").length)} />
        <MetricCard label="Lineup Needed" value={state.needsLineup ? "Yes" : "No"} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.5fr,1fr] gap-6">
        <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider">Story Feed</h3>
            <Link to="/season" className="text-th-muted hover:text-th-primary text-xs">Back to Season</Link>
          </div>

          {latestStories.length === 0 ? (
            <div className="rounded-xl border border-th bg-th-raised p-4 text-th-faint text-sm">
              No season stories yet. Play matches to build the inbox.
            </div>
          ) : (
            <div className="space-y-3">
              {latestStories.map((event, index) => {
                const playerExists = event.playerId && state.teams.some(team => team.roster.some(player => player.id === event.playerId));
                const teamExists = event.teamId && state.teams.some(team => team.id === event.teamId);

                return (
                  <div key={`${event.headline}-${index}`} className="rounded-xl border border-th bg-th-raised p-4">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${EVENT_STYLES[event.type] ?? "bg-th-surface text-th-secondary border-th"}`}>
                        {event.type}
                      </span>
                      {playerExists && (
                        <PlayerLink playerId={event.playerId!} className="text-xs text-blue-300">
                          Player Page
                        </PlayerLink>
                      )}
                      {teamExists && (
                        <Link to={`/team/${event.teamId}`} className="text-xs text-blue-300 hover:text-blue-200">
                          Team Page
                        </Link>
                      )}
                    </div>
                    <div className="text-th-primary font-semibold">{event.headline}</div>
                    <div className="text-th-secondary text-sm mt-1 leading-6">{event.body}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider mb-3">Action Items</h3>
            {actionItems.length === 0 ? (
              <div className="text-th-faint text-sm">Nothing urgent right now.</div>
            ) : (
              <div className="space-y-3">
                {actionItems.map((item, index) => (
                  <Link key={`${item.title}-${index}`} to={item.href} className="block rounded-xl border border-th bg-th-raised p-3 hover:bg-th-hover transition-colors">
                    <div className="text-th-primary font-medium">{item.title}</div>
                    <div className="text-th-muted text-sm mt-1">{item.detail}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider mb-3">Form Watch</h3>
            <div className="space-y-3">
              <div>
                <div className="text-green-300 text-xs uppercase tracking-wider mb-2">Hot</div>
                {hotPlayers.length === 0 ? (
                  <div className="text-th-faint text-sm">No one is on a real heater yet.</div>
                ) : (
                  <div className="space-y-2">
                    {hotPlayers.map(player => (
                      <div key={player.id} className="flex items-center justify-between text-sm">
                        <PlayerLink playerId={player.id} className="text-th-primary">{player.name}</PlayerLink>
                        <span className="text-green-300 font-medium">{Math.round(player.form)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-th">
                <div className="text-red-300 text-xs uppercase tracking-wider mb-2">Cold</div>
                {coldPlayers.length === 0 ? (
                  <div className="text-th-faint text-sm">No major cold streaks right now.</div>
                ) : (
                  <div className="space-y-2">
                    {coldPlayers.map(player => (
                      <div key={player.id} className="flex items-center justify-between text-sm">
                        <PlayerLink playerId={player.id} className="text-th-primary">{player.name}</PlayerLink>
                        <span className="text-red-300 font-medium">{Math.round(player.form)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider mb-3">Medical & Trades</h3>
            <div className="space-y-4">
              <div>
                <div className="text-th-muted text-xs uppercase tracking-wider mb-2">Injuries</div>
                {recentInjuries.length === 0 ? (
                  <div className="text-th-faint text-sm">No fresh injuries.</div>
                ) : (
                  <div className="space-y-2">
                    {recentInjuries.map((injury, index) => (
                      <div key={`${injury.playerId}-${index}`} className="text-sm">
                        <PlayerLink playerId={injury.playerId} className="text-th-primary">{injury.playerName}</PlayerLink>
                        <span className="text-th-muted"> • {injury.injury.injuryType} • {injury.injury.matchesRemaining} match(es)</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-th">
                <div className="text-th-muted text-xs uppercase tracking-wider mb-2">Recent Trades</div>
                {recentTrades.length === 0 ? (
                  <div className="text-th-faint text-sm">No trade activity logged.</div>
                ) : (
                  <div className="space-y-2">
                    {recentTrades.map((trade, index) => (
                      <div key={`${trade.fromTeam}-${trade.toTeam}-${index}`} className="text-sm">
                        <div className="text-th-primary">{trade.fromTeam} ↔ {trade.toTeam}</div>
                        <div className="text-th-muted text-xs mt-1">
                          {trade.accepted ? "Accepted" : "Rejected"} • In: {trade.playersIn.join(", ")} • Out: {trade.playersOut.join(", ")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
