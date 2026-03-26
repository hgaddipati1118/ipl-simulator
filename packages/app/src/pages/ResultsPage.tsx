import { useMemo } from "react";
import { Link } from "react-router-dom";
import { GameState } from "../game-state";
import { TeamBadge } from "../components/TeamBadge";
import { PlayerLink } from "../components/PlayerLink";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { roleLabel, bowlingStyleLabel, ovrColorClass } from "../ui-utils";

interface Props {
  state: GameState;
  onNextSeason: () => void;
}

export function ResultsPage({ state, onNextSeason }: Props) {
  const { seasonResult, teams, history } = state;
  if (!seasonResult) return <div className="p-8 text-th-secondary">No results yet</div>;

  const teamMap = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);
  const champion = teamMap.get(seasonResult.champion);
  const allPlayers = useMemo(() => teams.flatMap(t => t.roster), [teams]);
  const orangePlayer = allPlayers.find(p => p.id === seasonResult.orangeCap.playerId);
  const purplePlayer = allPlayers.find(p => p.id === seasonResult.purpleCap.playerId);

  const topScorers = [...allPlayers]
    .sort((a, b) => b.stats.runs - a.stats.runs)
    .slice(0, 10);

  const topWicketTakers = [...allPlayers]
    .sort((a, b) => b.stats.wickets - a.stats.wickets)
    .slice(0, 10);

  const standings = seasonResult.standings;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Champion banner */}
      <div
        className="rounded-2xl p-8 sm:p-10 mb-8 text-center relative overflow-hidden border border-th-strong"
        style={{
          background: `linear-gradient(160deg, ${champion?.config.primaryColor}18, ${champion?.config.secondaryColor}08, transparent)`,
        }}
      >
        {/* Radial glow */}
        <div
          className="absolute inset-0 opacity-20 -z-0"
          style={{ background: `radial-gradient(circle at 50% 0%, ${champion?.config.primaryColor}40, transparent 70%)` }}
        />
        <div className="relative z-10">
          <p className="text-th-muted text-xs uppercase tracking-[0.2em] font-display font-medium mb-4">Season {state.seasonNumber} Champions</p>
          {champion && (
            <div className="mx-auto mb-4 w-20 h-20 animate-slide-up">
              <TeamBadge teamId={champion.id} shortName={champion.shortName} primaryColor={champion.config.primaryColor} size="lg" />
            </div>
          )}
          <h2 className="text-3xl sm:text-4xl font-display font-extrabold text-th-primary mb-1 tracking-tight">{champion?.name}</h2>
          <div
            className="w-16 h-1 rounded-full mx-auto mt-3 mb-6"
            style={{ background: `linear-gradient(to right, ${champion?.config.primaryColor}, ${champion?.config.secondaryColor})` }}
          />
          {/* Season Awards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto">
            {/* Orange Cap */}
            <div className="rounded-xl bg-orange-500/[0.06] border border-orange-500/20 p-4">
              <div className="text-[10px] text-orange-400 uppercase tracking-wider font-display font-semibold mb-2">Orange Cap</div>
              {orangePlayer && (
                <div className="flex items-center gap-3">
                  <PlayerAvatar name={orangePlayer.name} imageUrl={orangePlayer.imageUrl} size="md" teamColor={teams.find(t => t.id === orangePlayer.teamId)?.config.primaryColor} />
                  <div className="text-left">
                    <PlayerLink playerId={orangePlayer.id} className="text-th-primary text-sm font-display font-semibold">{orangePlayer.name}</PlayerLink>
                    <div className="text-[10px] text-th-muted">{teams.find(t => t.id === orangePlayer.teamId)?.shortName}</div>
                    <div className="text-orange-300 font-mono stat-num text-sm mt-1">{seasonResult.orangeCap.runs} runs <span className="text-[10px] text-th-muted">SR {seasonResult.orangeCap.strikeRate?.toFixed(1)}</span></div>
                  </div>
                </div>
              )}
            </div>

            {/* Purple Cap */}
            <div className="rounded-xl bg-purple-500/[0.06] border border-purple-500/20 p-4">
              <div className="text-[10px] text-purple-400 uppercase tracking-wider font-display font-semibold mb-2">Purple Cap</div>
              {purplePlayer && (
                <div className="flex items-center gap-3">
                  <PlayerAvatar name={purplePlayer.name} imageUrl={purplePlayer.imageUrl} size="md" teamColor={teams.find(t => t.id === purplePlayer.teamId)?.config.primaryColor} />
                  <div className="text-left">
                    <PlayerLink playerId={purplePlayer.id} className="text-th-primary text-sm font-display font-semibold">{purplePlayer.name}</PlayerLink>
                    <div className="text-[10px] text-th-muted">{teams.find(t => t.id === purplePlayer.teamId)?.shortName} {purplePlayer.bowlingStyle !== "unknown" && <span className="text-purple-400/60">{bowlingStyleLabel(purplePlayer.bowlingStyle)}</span>}</div>
                    <div className="text-purple-300 font-mono stat-num text-sm mt-1">{seasonResult.purpleCap.wickets} wkts <span className="text-[10px] text-th-muted">Econ {seasonResult.purpleCap.economy?.toFixed(2)}</span></div>
                  </div>
                </div>
              )}
            </div>

            {/* MVP */}
            {seasonResult.mvp && (() => {
              const mvpPlayer = allPlayers.find(p => p.name === seasonResult.mvp.name);
              return (
                <div className="rounded-xl bg-sky-500/[0.06] border border-sky-500/20 p-4">
                  <div className="text-[10px] text-sky-400 uppercase tracking-wider font-display font-semibold mb-2">Most Valuable Player</div>
                  {mvpPlayer && (
                    <div className="flex items-center gap-3">
                      <PlayerAvatar name={mvpPlayer.name} imageUrl={mvpPlayer.imageUrl} size="md" teamColor={teams.find(t => t.id === mvpPlayer.teamId)?.config.primaryColor} />
                      <div className="text-left">
                        <PlayerLink playerId={mvpPlayer.id} className="text-th-primary text-sm font-display font-semibold">{mvpPlayer.name}</PlayerLink>
                        <div className="text-[10px] text-th-muted">{teams.find(t => t.id === mvpPlayer.teamId)?.shortName} <span className={ovrColorClass(mvpPlayer.overall)}>{mvpPlayer.overall} OVR</span></div>
                        <div className="text-sky-300 font-mono stat-num text-sm mt-1">{seasonResult.mvp.points.toFixed(1)} pts</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
        {/* Top scorers */}
        <div className="rounded-2xl border border-th overflow-hidden bg-th-surface">
          <div className="px-4 py-3 border-b border-th bg-orange-500/[0.04]">
            <h3 className="text-xs font-display font-semibold text-orange-400 uppercase tracking-wider">Top Run Scorers</h3>
          </div>
          <div className="divide-y divide-th">
            {topScorers.map((p, i) => (
              <div key={p.id} className="px-4 py-2.5 flex items-center justify-between hover:bg-th-hover transition-colors">
                <div className="flex items-center gap-3">
                  <span className={`stat-num text-xs w-4 ${i < 3 ? "text-orange-400" : "text-th-faint"}`}>{i + 1}</span>
                  <PlayerAvatar name={p.name} imageUrl={p.imageUrl} size="sm" teamColor={teams.find(t => t.id === p.teamId)?.config.primaryColor} />
                  <div>
                    <PlayerLink playerId={p.id} className="text-th-primary text-sm font-display">{p.name}</PlayerLink>
                    <span className="text-th-faint text-xs ml-2">{teams.find(t => t.id === p.teamId)?.shortName}</span>
                  </div>
                </div>
                <div className="text-right flex items-baseline gap-2">
                  <span className="text-th-primary font-semibold text-sm stat-num">{p.stats.runs}</span>
                  <span className="text-th-muted text-[10px] stat-num">SR {p.strikeRate.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top wicket takers */}
        <div className="rounded-2xl border border-th overflow-hidden bg-th-surface">
          <div className="px-4 py-3 border-b border-th bg-purple-500/[0.04]">
            <h3 className="text-xs font-display font-semibold text-purple-400 uppercase tracking-wider">Top Wicket Takers</h3>
          </div>
          <div className="divide-y divide-th">
            {topWicketTakers.map((p, i) => (
              <div key={p.id} className="px-4 py-2.5 flex items-center justify-between hover:bg-th-hover transition-colors">
                <div className="flex items-center gap-3">
                  <span className={`stat-num text-xs w-4 ${i < 3 ? "text-purple-400" : "text-th-faint"}`}>{i + 1}</span>
                  <PlayerAvatar name={p.name} imageUrl={p.imageUrl} size="sm" teamColor={teams.find(t => t.id === p.teamId)?.config.primaryColor} />
                  <div>
                    <PlayerLink playerId={p.id} className="text-th-primary text-sm font-display">{p.name}</PlayerLink>
                    <span className="text-th-faint text-xs ml-2">{teams.find(t => t.id === p.teamId)?.shortName}</span>
                    {p.bowlingStyle !== "unknown" && <span className="text-purple-400/50 text-[10px] ml-1">{bowlingStyleLabel(p.bowlingStyle)}</span>}
                  </div>
                </div>
                <div className="text-right flex items-baseline gap-2">
                  <span className="text-th-primary font-semibold text-sm stat-num">{p.stats.wickets}</span>
                  <span className="text-th-muted text-[10px] stat-num">Econ {p.economyRate.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Final standings */}
      <div className="rounded-2xl border border-th overflow-hidden mb-8 bg-th-surface">
        <div className="px-4 py-3 border-b border-th">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Final Standings</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[420px]">
            <thead>
              <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider">
                <th className="text-left px-4 py-2">#</th>
                <th className="text-left px-4 py-2">Team</th>
                <th className="text-center px-3 py-2">P</th>
                <th className="text-center px-3 py-2">W</th>
                <th className="text-center px-3 py-2">L</th>
                <th className="text-center px-3 py-2">Pts</th>
                <th className="text-center px-3 py-2">NRR</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s, i) => {
                const team = teamMap.get(s.teamId)!;
                return (
                  <tr key={s.teamId} className={`border-t border-th ${i < 4 ? "bg-emerald-500/[0.03]" : ""}`}>
                    <td className="px-4 py-2 text-th-muted stat-num">{i + 1}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <TeamBadge teamId={team.id} shortName={team.shortName} primaryColor={team.config.primaryColor} size="sm" />
                        <span className="text-th-primary font-display font-medium">{team.shortName}</span>
                      </div>
                    </td>
                    <td className="text-center px-3 py-2 text-th-secondary stat-num">{s.played}</td>
                    <td className="text-center px-3 py-2 text-emerald-400 stat-num">{s.wins}</td>
                    <td className="text-center px-3 py-2 text-red-400/80 stat-num">{s.losses}</td>
                    <td className="text-center px-3 py-2 text-th-primary font-bold stat-num">{s.points}</td>
                    <td className="text-center px-3 py-2 text-th-muted stat-num">{s.nrr >= 0 ? "+" : ""}{s.nrr.toFixed(3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Season history */}
      {history.length > 0 && (
        <div className="rounded-2xl border border-th bg-th-surface p-4 mb-8">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-3">History</h3>
          <div className="space-y-2">
            {history.map(h => (
              <div key={h.seasonNumber} className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm">
                <span className="text-th-muted stat-num text-xs">S{h.seasonNumber}</span>
                <span className="text-th-primary font-display font-medium">{h.champion}</span>
                <span className="text-orange-400/80 text-xs">{h.orangeCap.name} <span className="stat-num">{h.orangeCap.runs}r</span></span>
                <span className="text-purple-400/80 text-xs">{h.purpleCap.name} <span className="stat-num">{h.purpleCap.wickets}w</span></span>
                {h.stadiumRating != null && (
                  <span className="text-th-muted text-[10px] font-mono" title="Your stadium rating">
                    Stadium {h.stadiumRating.toFixed(2)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fantasy Points Leaderboard */}
      {state.fantasyLeaderboard && state.fantasyLeaderboard.length > 0 && (
        <div className="rounded-2xl border border-th overflow-hidden mb-8 bg-th-surface">
          <div className="px-4 py-3 border-b border-th bg-pink-500/[0.04]">
            <h3 className="text-xs font-display font-semibold text-pink-400 uppercase tracking-wider">Fantasy Points Leaderboard</h3>
          </div>
          <div className="divide-y divide-th">
            {state.fantasyLeaderboard.slice(0, 10).map((fp, i) => {
              const fpPlayer = allPlayers.find(p => p.id === fp.playerId);
              return (
                <div key={fp.playerId} className="px-4 py-2.5 flex items-center justify-between hover:bg-th-hover transition-colors">
                  <div className="flex items-center gap-3">
                    <span className={`stat-num text-xs w-4 ${i < 3 ? "text-pink-400" : "text-th-faint"}`}>{i + 1}</span>
                    {fpPlayer && (
                      <PlayerAvatar name={fpPlayer.name} imageUrl={fpPlayer.imageUrl} size="sm" teamColor={teams.find(t => t.id === fpPlayer.teamId)?.config.primaryColor} />
                    )}
                    <div>
                      <PlayerLink playerId={fp.playerId} className="text-th-primary text-sm font-display">{fp.playerName || "Unknown"}</PlayerLink>
                      <span className="text-th-faint text-xs ml-2">{teamMap.get(fp.teamId)?.shortName}</span>
                    </div>
                  </div>
                  <div className="text-right flex items-baseline gap-3">
                    <span className="text-th-muted text-[10px] stat-num">Bat {fp.battingPoints}</span>
                    <span className="text-th-muted text-[10px] stat-num">Bowl {fp.bowlingPoints}</span>
                    <span className="text-pink-300 font-semibold text-sm stat-num">{fp.totalPoints} pts</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Board Evaluation */}
      {state.boardState && (
        <div className="rounded-2xl border border-th overflow-hidden mb-8 bg-th-surface">
          <div className="px-4 py-3 border-b border-th bg-blue-500/[0.04]">
            <h3 className="text-xs font-display font-semibold text-blue-400 uppercase tracking-wider">Board Evaluation</h3>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-th-primary font-display font-semibold text-sm">{state.boardState.message}</div>
                <div className="flex gap-2 mt-2">
                  {state.boardState.objectives.map((obj, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-th-overlay text-th-muted font-display border border-th">
                      {obj.description}
                    </span>
                  ))}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-th-muted font-display uppercase tracking-wider">Satisfaction</div>
                <div className={`font-display font-bold text-xl stat-num ${
                  state.boardState.satisfaction >= 60 ? "text-green-400" :
                  state.boardState.satisfaction >= 30 ? "text-yellow-400" : "text-red-400"
                }`}>
                  {state.boardState.satisfaction}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-th-muted font-display">
              {state.boardState.budgetModifier !== 1.0 && (
                <span className={state.boardState.budgetModifier > 1 ? "text-green-400" : "text-red-400"}>
                  Budget {state.boardState.budgetModifier > 1 ? "+" : ""}{Math.round((state.boardState.budgetModifier - 1) * 100)}% next season
                </span>
              )}
              {state.boardState.warnings > 0 && (
                <span className="text-red-400 font-semibold">
                  {state.boardState.warnings}/3 warnings
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Contract Expiry Report */}
      {state.contractReport && (state.contractReport.finalYear.length > 0 || state.contractReport.freeAgents.length > 0) && (
        <div className="rounded-2xl border border-th overflow-hidden mb-8 bg-th-surface">
          <div className="px-4 py-3 border-b border-th bg-amber-500/[0.04]">
            <h3 className="text-xs font-display font-semibold text-amber-400 uppercase tracking-wider">Contract Report</h3>
          </div>
          <div className="p-4 space-y-2">
            {state.contractReport.freeAgents.length > 0 && (
              <div>
                <div className="text-red-400 text-[10px] uppercase font-display font-semibold tracking-wider mb-1">Free Agents (contract expired)</div>
                <div className="flex flex-wrap gap-2">
                  {state.contractReport.freeAgents.map(c => (
                    <span key={c.playerId} className="text-xs px-2 py-1 rounded bg-red-950/30 text-red-300 font-display border border-red-800/30">
                      {c.playerName}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {state.contractReport.finalYear.length > 0 && (
              <div>
                <div className="text-amber-400 text-[10px] uppercase font-display font-semibold tracking-wider mb-1">Entering Final Year</div>
                <div className="flex flex-wrap gap-2">
                  {state.contractReport.finalYear.map(c => (
                    <span key={c.playerId} className="text-xs px-2 py-1 rounded bg-amber-950/30 text-amber-300 font-display border border-amber-800/30">
                      {c.playerName}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-4">
        <button
          onClick={onNextSeason}
          className="px-8 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30"
        >
          Next Season
        </button>
        {(state.hallOfFame?.length ?? 0) > 0 && (
          <Link
            to="/hall-of-fame"
            className="px-6 py-3 border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 font-display font-semibold rounded-xl transition-all text-sm"
          >
            Hall of Fame ({state.hallOfFame!.length})
          </Link>
        )}
      </div>
    </div>
  );
}
