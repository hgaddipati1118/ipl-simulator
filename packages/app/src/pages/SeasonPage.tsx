import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  GameState,
  getBoardExpectation,
  getBoardExpectationStatus,
  getPlayerSeasonStats,
  isSeasonComplete,
  isGroupStageComplete,
  type PlayerSeasonStat,
} from "../game-state";
import { useNavigate } from "react-router-dom";
import { TeamBadge } from "../components/TeamBadge";
import { PlayerLink } from "../components/PlayerLink";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { getTeamLogo } from "../team-logos";
import { roleLabel } from "../ui-utils";
import { displayOversToReal } from "@ipl-sim/engine";

interface Props {
  state: GameState;
  onSimSeason: () => void;
  onStartMatchBased?: () => void;
  onPlayNextMatch?: () => void;
  onSimBatch?: (count: number) => void;
  onSimToPlayoffs?: () => void;
  onViewResults?: () => void;
  onPromoteProspect?: (index: number) => void;
}

export function SeasonPage({ state, onSimSeason, onStartMatchBased, onPlayNextMatch, onSimBatch, onSimToPlayoffs, onViewResults, onPromoteProspect }: Props) {
  const navigate = useNavigate();
  const standings = useMemo(() =>
    [...state.teams].sort((a, b) => b.points !== a.points ? b.points - a.points : b.nrr - a.nrr),
    [state.teams]
  );

  const userTeam = state.teams.find(t => t.id === state.userTeamId);
  const userPosition = userTeam ? standings.findIndex(t => t.id === userTeam.id) + 1 : 0;
  const playoffSlots = state.rules.playoffTeams || 4;
  const userInPlayoffs = userPosition > 0 && userPosition <= playoffSlots;

  // Build form guide: last 5 results per team from match results
  const formGuide = useMemo(() => {
    const guide = new Map<string, ("W" | "L" | "NR")[]>();
    for (const r of state.matchResults) {
      if (!r.winnerId) continue;
      const teams = [r.innings[0]?.teamId, r.innings[1]?.teamId].filter(Boolean) as string[];
      for (const tid of teams) {
        const list = guide.get(tid) ?? [];
        list.push(tid === r.winnerId ? "W" : "L");
        guide.set(tid, list);
      }
    }
    // Keep only last 5
    for (const [k, v] of guide) guide.set(k, v.slice(-5));
    return guide;
  }, [state.matchResults]);

  // Match-by-match mode
  const matchBasedActive = state.schedule.length > 0;
  const seasonDone = matchBasedActive ? isSeasonComplete(state) : false;
  const groupDone = matchBasedActive ? isGroupStageComplete(state) : false;
  const nextMatch = matchBasedActive && state.currentMatchIndex < state.schedule.length
    ? state.schedule[state.currentMatchIndex]
    : null;

  // Find next user match index (for "Sim to My Match" button)
  const nextUserMatchIndex = useMemo(() => {
    if (!state.userTeamId || !matchBasedActive) return -1;
    for (let i = state.currentMatchIndex; i < state.schedule.length; i++) {
      const m = state.schedule[i];
      if (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId) return i;
    }
    return -1;
  }, [state.schedule, state.currentMatchIndex, state.userTeamId, matchBasedActive]);
  const canSimToUserMatch = nextUserMatchIndex > state.currentMatchIndex;
  const nextUserMatch = nextUserMatchIndex >= state.currentMatchIndex && nextUserMatchIndex < state.schedule.length
    ? state.schedule[nextUserMatchIndex]
    : null;
  const averageReadiness = userTeam
    ? Math.round(userTeam.roster.reduce((sum, player) => sum + player.readiness, 0) / Math.max(1, userTeam.roster.length))
    : 0;
  const tiredPlayers = userTeam ? userTeam.roster.filter(player => !player.injured && player.readiness <= 55).length : 0;
  const pendingOffers = state.tradeOffers.filter(offer => offer.status === "pending").length;
  const latestStory = state.narrativeEvents[0] ?? null;
  const boardExpectation = getBoardExpectation(state);
  const boardStatus = getBoardExpectationStatus(state, boardExpectation);

  // Hovered schedule match for "sim to here"
  const [hoveredMatchIdx, setHoveredMatchIdx] = useState<number | null>(null);

  // Auto-scroll schedule to current match
  const nextMatchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (nextMatchRef.current) {
      nextMatchRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [state.currentMatchIndex]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* User team hero card */}
      {userTeam && userTeam.matchesPlayed > 0 && (
        <div
          className="rounded-2xl p-4 sm:p-5 mb-6 border border-th flex flex-col sm:flex-row items-center gap-4"
          style={{ background: `linear-gradient(135deg, ${userTeam.config.primaryColor}10, transparent 60%)` }}
        >
          <TeamBadge teamId={userTeam.id} shortName={userTeam.shortName} primaryColor={userTeam.config.primaryColor} />
          <div className="flex-1 text-center sm:text-left">
            <div className="font-display font-bold text-th-primary text-lg">{userTeam.name}</div>
            <div className="text-th-muted text-sm font-display">
              {userInPlayoffs ? "Playoff position" : userPosition > 0 ? `Position #${userPosition}` : ""}
            </div>
          </div>
          <div className="flex gap-5 sm:gap-8">
            <div className="text-center">
              <div className="text-[10px] text-th-muted uppercase font-display tracking-wider">W-L</div>
              <div className="text-th-primary font-display font-bold stat-num">{userTeam.wins}-{userTeam.losses}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-th-muted uppercase font-display tracking-wider">Pts</div>
              <div className="text-th-primary font-display font-bold stat-num">{userTeam.points}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-th-muted uppercase font-display tracking-wider">Pos</div>
              <div className={`font-display font-bold stat-num ${userInPlayoffs ? "text-emerald-400" : "text-th-secondary"}`}>#{userPosition}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-th-muted uppercase font-display tracking-wider">NRR</div>
              <div className="text-th-secondary font-display font-bold stat-num text-sm">{userTeam.nrr >= 0 ? "+" : ""}{userTeam.nrr.toFixed(3)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Board Expectations card */}
      {state.boardState && (
        <div className="rounded-xl border border-th bg-th-surface p-4 mb-4">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-2">Board Expectations</h3>
          <div className="space-y-1.5">
            {state.boardState.objectives.map((obj, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
                <span className="text-th-secondary font-display">{obj.description}</span>
              </div>
            ))}
          </div>
          {state.boardState.message && (
            <p className="text-xs text-th-muted mt-2 font-display italic">{state.boardState.message}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] text-th-muted">Satisfaction:</span>
            <div className="flex-1 h-1.5 rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full transition-all" style={{
                width: `${state.boardState.satisfaction}%`,
                background: state.boardState.satisfaction > 60 ? '#34d399' : state.boardState.satisfaction > 30 ? '#fbbf24' : '#ef4444'
              }} />
            </div>
            <span className="text-[10px] text-th-muted stat-num">{state.boardState.satisfaction}%</span>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
              Season <span className="stat-num">{state.seasonNumber}</span>
            </h2>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-display font-medium ${
                (state.rules.injuriesEnabled ?? true)
                  ? "bg-red-950/40 text-red-400 border border-red-800/30"
                  : "bg-th-raised text-th-muted border border-th"
              }`}
              title={(state.rules.injuriesEnabled ?? true) ? "Injuries are enabled" : "Injuries are disabled"}
            >
              {(state.rules.injuriesEnabled ?? true) ? "Injuries ON" : "Injuries OFF"}
            </span>
          </div>
          {userTeam && (
            <p className="text-th-muted mt-1 font-display">
              Managing <span style={{ color: userTeam.config.primaryColor + "cc" }}>{userTeam.name}</span>
            </p>
          )}
          {matchBasedActive && (
            <p className="text-th-muted text-xs mt-1 font-display">
              {state.currentMatchIndex} / {state.schedule.length} matches played
              {groupDone && !seasonDone && " -- Playoffs"}
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 w-full sm:w-auto">
          {!matchBasedActive ? (
            <>
              <button
                onClick={onSimSeason}
                className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 hover:shadow-orange-500/30 w-full sm:w-auto"
              >
                Simulate Season
              </button>
              {onStartMatchBased && (
                <button
                  onClick={onStartMatchBased}
                  className="px-5 py-3 bg-th-raised hover:bg-th-overlay text-th-secondary font-display font-medium rounded-xl transition-colors w-full sm:w-auto text-sm"
                >
                  Match by Match
                </button>
              )}
            </>
          ) : (
            <>
              {!seasonDone && nextMatch && onPlayNextMatch && (
                <button
                  onClick={onPlayNextMatch}
                  className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all text-sm w-full sm:w-auto"
                >
                  Play Next Match
                </button>
              )}
              {canSimToUserMatch && onSimBatch && (
                <button
                  onClick={() => onSimBatch(nextUserMatchIndex - state.currentMatchIndex)}
                  className="px-4 py-2.5 bg-th-raised hover:bg-th-overlay text-orange-400 font-display font-medium rounded-xl transition-colors text-sm w-full sm:w-auto border border-orange-500/20"
                >
                  Sim to My Match
                </button>
              )}
              {!groupDone && onSimBatch && (
                <button
                  onClick={() => onSimBatch(5)}
                  className="px-4 py-2.5 bg-th-raised hover:bg-th-overlay text-th-primary font-display font-medium rounded-xl transition-colors text-sm w-full sm:w-auto"
                >
                  Sim Next 5
                </button>
              )}
              {!groupDone && onSimToPlayoffs && (
                <button
                  onClick={onSimToPlayoffs}
                  className="px-4 py-2.5 bg-th-raised hover:bg-th-overlay text-th-primary font-display font-medium rounded-xl transition-colors text-sm w-full sm:w-auto"
                >
                  {state.rules.playoffTeams > 0 ? "Sim to Playoffs" : "Sim All Matches"}
                </button>
              )}
              {seasonDone && onViewResults && (
                <button
                  onClick={onViewResults}
                  className="px-6 py-2.5 bg-gradient-to-r from-yellow-500 to-amber-500 text-black font-display font-semibold rounded-xl transition-all text-sm w-full sm:w-auto"
                >
                  View Results
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Season progress bar */}
      {matchBasedActive && (
        <div className="mb-6">
          <div className="flex items-center justify-between text-[10px] text-th-muted font-display mb-1.5">
            <span>Group Stage</span>
            {state.rules.playoffTeams > 0 && <span>Playoffs</span>}
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.04]">
            {(() => {
              const groupTotal = state.schedule.filter(m => !m.isPlayoff).length;
              const groupPlayed = state.schedule.filter(m => !m.isPlayoff && m.result).length;
              const playoffTotal = state.schedule.filter(m => m.isPlayoff).length;
              const playoffPlayed = state.schedule.filter(m => m.isPlayoff && m.result).length;
              const total = state.schedule.length;
              return (
                <>
                  <div className="relative" style={{ width: `${(groupTotal / total) * 100}%` }}>
                    <div
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-500"
                      style={{ width: groupTotal > 0 ? `${(groupPlayed / groupTotal) * 100}%` : "0%" }}
                    />
                  </div>
                  {playoffTotal > 0 && (
                    <div className="relative border-l border-white/10" style={{ width: `${(playoffTotal / total) * 100}%` }}>
                      <div
                        className="h-full bg-gradient-to-r from-yellow-500 to-amber-400 transition-all duration-500"
                        style={{ width: playoffTotal > 0 ? `${(playoffPlayed / playoffTotal) * 100}%` : "0%" }}
                      />
                    </div>
                  )}
                </>
              );
            })()}
          </div>
          <div className="flex items-center justify-between text-[10px] text-th-faint font-mono mt-1">
            <span>{state.schedule.filter(m => !m.isPlayoff && m.result).length}/{state.schedule.filter(m => !m.isPlayoff).length}</span>
            {state.rules.playoffTeams > 0 && (
              <span>{state.schedule.filter(m => m.isPlayoff && m.result).length}/{state.schedule.filter(m => m.isPlayoff).length}</span>
            )}
          </div>
        </div>
      )}

      {userTeam && (
        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr,0.8fr] gap-4 mb-6">
          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Manager Desk</h3>
                <p className="text-th-faint text-xs mt-1">Condition, inbox pressure, and your next decision point.</p>
              </div>
              <button
                onClick={() => navigate("/inbox")}
                className="text-[11px] font-display font-medium text-th-secondary hover:text-th-primary bg-th-raised hover:bg-th-overlay px-2.5 py-1 rounded-lg transition-colors border border-th"
              >
                Open Inbox
              </button>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
              <SquadStat label="Avg Ready" value={String(averageReadiness)} />
              <SquadStat label="Tired" value={String(tiredPlayers)} />
              <SquadStat label="Offers" value={String(pendingOffers)} />
              <SquadStat label="Training" value={`${5 - (state.currentMatchIndex % 5)}`} hint="matches to next boost" />
              <SquadStat label="Board" value={boardStatus?.label ?? "-"} />
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-th bg-th-raised p-3">
                <div className="text-th-muted text-[10px] uppercase font-display tracking-wider">Next Call</div>
                <div className="text-th-primary text-sm font-display font-medium mt-1">
                  {state.needsLineup
                    ? "Lineup needed before your next match."
                    : nextUserMatch
                      ? `${nextUserMatch.homeTeamId.toUpperCase()} vs ${nextUserMatch.awayTeamId.toUpperCase()} is your next fixture.`
                      : "No fixture queued right now."}
                </div>
                <div className="text-th-faint text-xs mt-1">
                  {state.needsLineup
                    ? tiredPlayers > 0
                      ? `${tiredPlayers} player(s) are carrying low readiness into selection.`
                      : "Condition is stable for selection."
                    : pendingOffers > 0
                      ? `${pendingOffers} trade offer(s) still need an answer.`
                      : boardStatus
                        ? boardStatus.detail
                        : "No immediate off-field pressure."}
                </div>
              </div>

              {boardExpectation && boardStatus && (
                <div className="rounded-xl border border-th bg-th-raised p-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-th-muted text-[10px] uppercase font-display tracking-wider">Board Expectation</div>
                    {state.boardState && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] text-th-muted font-display">Satisfaction</span>
                        <div className="w-16 h-1.5 bg-th-overlay rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              state.boardState.satisfaction >= 60 ? "bg-green-500" :
                              state.boardState.satisfaction >= 30 ? "bg-yellow-500" : "bg-red-500"
                            }`}
                            style={{ width: `${state.boardState.satisfaction}%` }}
                          />
                        </div>
                        <span className="text-[10px] stat-num text-th-muted">{state.boardState.satisfaction}</span>
                        {state.boardState.warnings > 0 && (
                          <span className="text-[10px] text-red-400 font-display font-semibold">
                            {state.boardState.warnings === 1 ? "1 warning" : `${state.boardState.warnings} warnings`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-th-primary text-sm font-display font-medium mt-1">
                    {boardExpectation.label}
                  </div>
                  {state.boardState?.objectives && state.boardState.objectives.length > 1 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {state.boardState.objectives.map((obj, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-th-overlay text-th-muted font-display">
                          {obj.description}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className={`text-xs mt-1 ${
                    boardStatus.tone === "good"
                      ? "text-green-300"
                      : boardStatus.tone === "warn"
                        ? "text-orange-300"
                        : "text-blue-300"
                  }`}>
                    {boardStatus.label} {"\u2022"} {boardStatus.detail}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {state.needsLineup && (
                  <button
                    onClick={() => navigate("/lineup")}
                    className="px-3 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white text-xs font-display font-semibold rounded-lg transition-all"
                  >
                    Review Lineup
                  </button>
                )}
                {pendingOffers > 0 && (
                  <button
                    onClick={() => navigate("/trade")}
                    className="px-3 py-2 bg-th-raised hover:bg-th-overlay text-th-primary text-xs font-display font-medium rounded-lg transition-colors border border-th"
                  >
                    Review Trades
                  </button>
                )}
                {!state.needsLineup && (
                  <button
                    onClick={() => navigate("/inbox")}
                    className="px-3 py-2 bg-th-raised hover:bg-th-overlay text-th-primary text-xs font-display font-medium rounded-lg transition-colors border border-th"
                  >
                    Read Reports
                  </button>
                )}
                <button
                  onClick={() => navigate("/training")}
                  className="px-3 py-2 bg-th-raised hover:bg-th-overlay text-th-primary text-xs font-display font-medium rounded-lg transition-colors border border-th"
                >
                  Training Setup
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="mb-3 text-xs font-display font-semibold uppercase tracking-wider text-th-secondary">Latest Report</h3>
            {latestStory ? (
              <div className="rounded-xl border border-th bg-th-raised p-3">
                <div className="text-th-primary font-display font-medium">{latestStory.headline}</div>
                <div className="text-th-muted text-sm mt-2 leading-6">{latestStory.body}</div>
              </div>
            ) : (
              <div className="rounded-xl border border-th bg-th-raised p-3 text-th-faint text-sm">
                The inbox will start filling once matches are played.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Injury alerts */}
      {(state.recentInjuries?.length ?? 0) > 0 && (
        <div className="bg-red-950/20 border border-red-800/30 rounded-xl p-4 mb-6">
          <h3 className="text-red-400 font-display font-semibold text-sm mb-2">Recent Injuries</h3>
          <div className="flex flex-wrap gap-3">
            {state.recentInjuries.map((inj, i) => (
              <div key={i} className="flex items-center gap-2 text-sm bg-red-950/30 rounded px-2 py-1">
                <PlayerLink playerId={inj.playerId} className="text-red-300">{inj.playerName}</PlayerLink>
                <span className="text-th-muted">({state.teams.find(t => t.id === inj.teamId)?.shortName})</span>
                <span className="text-red-500/70 text-xs">
                  {inj.injury.injuryType} - {inj.injury.matchesRemaining}m
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Schedule panel (match-by-match mode) */}
      {matchBasedActive && state.schedule.length > 0 && (
        <div className="rounded-2xl border border-th overflow-hidden mb-6 bg-th-surface">
          <div className="px-4 py-3 border-b border-th">
            <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Schedule</h3>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {state.schedule.map((match, idx) => {
              const home = state.teams.find(t => t.id === match.homeTeamId);
              const away = state.teams.find(t => t.id === match.awayTeamId);
              const isPlayed = !!match.result;
              const isNext = idx === state.currentMatchIndex && !seasonDone;
              const isPlayoff = match.isPlayoff;
              const isUpcoming = !isPlayed && !isNext && idx > state.currentMatchIndex;
              const isUserMatch = state.userTeamId && (match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId);
              const matchLabel = match.type === "group" ? `#${match.matchNumber}` : ({ qualifier1: "Q1", eliminator: "Elim", qualifier2: "Q2", semi1: "SF1", semi2: "SF2", final: "FINAL" } as Record<string, string>)[match.type] ?? match.type;
              const isHovered = hoveredMatchIdx === idx;

              return (
                <div
                  key={idx}
                  ref={isNext ? nextMatchRef : undefined}
                  className={`px-4 py-2 border-b border-th flex items-center gap-3 text-sm transition-colors ${
                    isNext ? "bg-orange-500/10 border-l-2 border-l-orange-500"
                      : isPlayed ? "hover:bg-th-hover cursor-pointer"
                      : isUpcoming ? "hover:bg-th-hover/50 opacity-60 hover:opacity-100 cursor-pointer" : "opacity-40"
                  } ${isPlayoff ? "bg-yellow-500/[0.03]" : ""} ${isUserMatch && !isPlayed ? "border-l-2 border-l-orange-500/30" : ""}`}
                  onClick={() => { if (isPlayed) navigate(`/match/${idx}`); }}
                  onMouseEnter={() => { if (isUpcoming) setHoveredMatchIdx(idx); }}
                  onMouseLeave={() => setHoveredMatchIdx(null)}
                >
                  <span className={`text-xs w-12 flex-shrink-0 ${isPlayoff ? "text-yellow-400 font-semibold" : "text-th-muted"}`}>
                    {matchLabel}
                  </span>
                  <div className="flex-1 flex items-center gap-1.5 min-w-0">
                    {home && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: home.config.primaryColor }} />}
                    <span className={`text-xs font-medium ${isPlayed && match.result?.winnerId === match.homeTeamId ? "text-th-primary font-semibold" : "text-th-secondary"}`}>{home?.shortName}</span>
                    <span className="text-th-faint text-xs">vs</span>
                    {away && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: away.config.primaryColor }} />}
                    <span className={`text-xs font-medium ${isPlayed && match.result?.winnerId === match.awayTeamId ? "text-th-primary font-semibold" : "text-th-secondary"}`}>{away?.shortName}</span>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {isPlayed ? (
                      <span className="text-th-muted text-xs">{match.result?.margin}</span>
                    ) : isNext ? (
                      <span className="text-orange-400 text-xs font-medium">NEXT</span>
                    ) : isHovered && isUpcoming && onSimBatch ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); onSimBatch(idx - state.currentMatchIndex); setHoveredMatchIdx(null); }}
                        className="text-[11px] font-display font-medium text-orange-400 hover:text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 px-2 py-0.5 rounded transition-colors"
                      >
                        Sim to here
                      </button>
                    ) : isUserMatch && !isPlayed ? (
                      <span className="text-orange-400/50 text-[10px]">YOUR MATCH</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Standings */}
      <div className="rounded-2xl border border-th overflow-hidden mb-8 bg-th-surface">
        <div className="px-4 py-3 border-b border-th flex items-center justify-between">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Points Table</h3>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400/60" aria-label="Playoff qualification indicator" />
            <span className="text-[10px] text-th-muted font-display">Playoff zone</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px]">
            <thead>
              <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider">
                <th scope="col" className="text-left px-3 sm:px-4 py-2.5 w-8">#</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2.5">Team</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">P</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">W</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">L</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">Pts</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5 hidden sm:table-cell">NRR</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5 hidden sm:table-cell">PWR</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5 hidden md:table-cell">Form</th>
              </tr>
            </thead>
            <tbody className="stagger">
              {standings.map((team, i) => (
                <tr
                  key={team.id}
                  className={`border-t border-th cursor-pointer transition-colors hover:bg-th-hover ${
                    team.id === state.userTeamId ? "bg-orange-500/[0.06]" : ""
                  }`}
                  style={{
                    borderLeft: i < playoffSlots
                      ? "3px solid rgba(52, 211, 153, 0.5)"
                      : i >= standings.length - 2
                        ? "3px solid rgba(239, 68, 68, 0.25)"
                        : "3px solid transparent",
                  }}
                  onClick={() => navigate(`/team/${team.id}`)}
                >
                  <td className="px-3 sm:px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {i < 4 && <span className="w-1 h-4 rounded-full" style={{ backgroundColor: team.config.primaryColor + "90" }} />}
                      <span className={`text-sm font-mono ${i < 4 ? "text-th-primary" : "text-th-muted"}`}>{i + 1}</span>
                    </div>
                  </td>
                  <td className="px-3 sm:px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <TeamBadge teamId={team.id} shortName={team.shortName} primaryColor={team.config.primaryColor} size="sm" />
                      <div>
                        <span className="text-th-primary text-sm font-display font-medium">{team.shortName}</span>
                        {team.id === state.userTeamId && (
                          <span className="text-orange-400/70 text-[10px] ml-1.5 font-display">YOU</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-muted text-sm">{team.matchesPlayed}</td>
                  <td className="text-center px-2 sm:px-3 py-3 stat-num text-emerald-400 text-sm">{team.wins}</td>
                  <td className="text-center px-2 sm:px-3 py-3 stat-num text-red-400/80 text-sm">{team.losses}</td>
                  <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-primary font-bold text-sm">{team.points}</td>
                  <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-muted text-sm hidden sm:table-cell">
                    {team.nrr >= 0 ? "+" : ""}{team.nrr.toFixed(3)}
                  </td>
                  <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-muted text-sm hidden sm:table-cell">{team.powerRating}</td>
                  <td className="text-center px-2 sm:px-3 py-3 hidden md:table-cell">
                    <div className="flex items-center justify-center gap-1">
                      {(formGuide.get(team.id) ?? []).map((r, fi) => (
                        <span
                          key={fi}
                          className={`w-[7px] h-[7px] rounded-full ${
                            r === "W" ? "bg-emerald-400" : "bg-red-400/70"
                          }`}
                          title={r}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Team roster summary */}
      {userTeam && (
        <div className="rounded-2xl border border-th bg-th-surface p-4">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Your Squad</h3>
            <button
              onClick={() => navigate("/power-rankings")}
              className="text-[11px] font-display font-medium text-th-secondary hover:text-th-primary bg-th-raised hover:bg-th-overlay px-2.5 py-1 rounded-lg transition-colors border border-th"
            >
              Power Rankings
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SquadStat label="Players" value={String(userTeam.roster.length)} />
            <SquadStat label="Overseas" value={String(userTeam.internationalCount)} />
            <SquadStat label="Budget" value={`${userTeam.totalSpent.toFixed(1)} Cr`} />
            <SquadStat label="Power" value={String(userTeam.powerRating)} />
          </div>
        </div>
      )}

      {/* Youth Academy */}
      {state.youthProspects && state.youthProspects.length > 0 && (
        <div className="rounded-2xl border border-th bg-th-surface p-4 mt-4 mb-4">
          <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-3">Youth Academy</h3>
          {state.youthProspects.map((prospect, i) => (
            <div key={i} className="flex flex-col items-start gap-3 border-t border-th py-3 sm:flex-row sm:items-center">
              <PlayerAvatar name={prospect.player.name} size="sm" />
              <div className="flex-1">
                <span className="text-sm text-th-primary font-display">{prospect.player.name}</span>
                <span className="text-[10px] text-th-muted ml-2">Age {prospect.player.age} &bull; {roleLabel(prospect.player.role)}</span>
              </div>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                prospect.scoutRating === "Diamond" ? "bg-cyan-500/15 text-cyan-400" :
                prospect.scoutRating === "Gold" ? "bg-amber-500/15 text-amber-400" :
                prospect.scoutRating === "Silver" ? "bg-gray-500/15 text-gray-400" :
                "bg-orange-900/15 text-orange-400"
              }`}>{prospect.scoutRating}</span>
              <span className="text-xs text-th-muted stat-num">{prospect.player.overall} OVR</span>
              {onPromoteProspect && (
                <button onClick={() => onPromoteProspect(i)} className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors">Promote</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Leaderboards */}
      <SeasonLeaderboards teams={state.teams} fantasyLeaderboard={state.fantasyLeaderboard} />
    </div>
  );
}

function SquadStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-th-surface rounded-xl px-3 py-2.5" title={hint}>
      <div className="text-th-muted text-[10px] uppercase font-display tracking-wider">{label}</div>
      <div className="text-th-primary font-display font-semibold text-lg stat-num">{value}</div>
    </div>
  );
}

// ── Leaderboards ────────────────────────────────────────────────────

interface LeaderboardEntry {
  playerId: string;
  playerName: string;
  teamShortName: string;
  value: string;
  numValue: number;
}

interface LeaderboardDef {
  title: string;
  color: string;
  bgColor: string;
  entries: LeaderboardEntry[];
}

function buildLeaderboards(teams: import("@ipl-sim/engine").Team[]): LeaderboardDef[] {
  const stats = getPlayerSeasonStats(teams);
  const teamMap = new Map(teams.map(t => [t.id, t.shortName]));

  if (stats.length === 0) return [];

  // Orange Cap - most runs
  const orangeCap: LeaderboardEntry[] = [...stats]
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5)
    .filter(s => s.runs > 0)
    .map(s => ({
      playerId: s.playerId,
      playerName: s.playerName,
      teamShortName: teamMap.get(s.teamId) ?? "",
      value: `${s.runs} runs`,
      numValue: s.runs,
    }));

  // Purple Cap - most wickets
  const purpleCap: LeaderboardEntry[] = [...stats]
    .sort((a, b) => b.wickets - a.wickets)
    .slice(0, 5)
    .filter(s => s.wickets > 0)
    .map(s => ({
      playerId: s.playerId,
      playerName: s.playerName,
      teamShortName: teamMap.get(s.teamId) ?? "",
      value: `${s.wickets} wkts`,
      numValue: s.wickets,
    }));

  // Most Sixes
  const mostSixes: LeaderboardEntry[] = [...stats]
    .sort((a, b) => b.sixes - a.sixes)
    .slice(0, 5)
    .filter(s => s.sixes > 0)
    .map(s => ({
      playerId: s.playerId,
      playerName: s.playerName,
      teamShortName: teamMap.get(s.teamId) ?? "",
      value: `${s.sixes} sixes`,
      numValue: s.sixes,
    }));

  // Best Economy (min 2 overs bowled)
  const qualifiedBowlers = stats.filter(s => s.oversBowled >= 2);
  const bestEconomy: LeaderboardEntry[] = [...qualifiedBowlers]
    .map(s => ({ ...s, economy: s.runsConceded / displayOversToReal(s.oversBowled) }))
    .sort((a, b) => a.economy - b.economy)
    .slice(0, 5)
    .map(s => ({
      playerId: s.playerId,
      playerName: s.playerName,
      teamShortName: teamMap.get(s.teamId) ?? "",
      value: `${s.economy.toFixed(2)} econ`,
      numValue: s.economy,
    }));

  // Most Valuable (MVP = runs/10 + wickets*3)
  const mvp: LeaderboardEntry[] = [...stats]
    .map(s => ({ ...s, mvpScore: s.runs / 10 + s.wickets * 3 }))
    .sort((a, b) => b.mvpScore - a.mvpScore)
    .slice(0, 5)
    .filter(s => s.mvpScore > 0)
    .map(s => ({
      playerId: s.playerId,
      playerName: s.playerName,
      teamShortName: teamMap.get(s.teamId) ?? "",
      value: `${s.mvpScore.toFixed(1)} MVP`,
      numValue: s.mvpScore,
    }));

  return [
    { title: "Orange Cap", color: "text-orange-400", bgColor: "bg-orange-500/10 border-orange-500/20", entries: orangeCap },
    { title: "Purple Cap", color: "text-purple-400", bgColor: "bg-purple-500/10 border-purple-500/20", entries: purpleCap },
    { title: "Most Sixes", color: "text-amber-400", bgColor: "bg-amber-500/10 border-amber-500/20", entries: mostSixes },
    { title: "Best Economy", color: "text-emerald-400", bgColor: "bg-emerald-500/10 border-emerald-500/20", entries: bestEconomy },
    { title: "Most Valuable", color: "text-sky-400", bgColor: "bg-sky-500/10 border-sky-500/20", entries: mvp },
  ].filter(lb => lb.entries.length > 0);
}

function SeasonLeaderboards({ teams, fantasyLeaderboard }: { teams: import("@ipl-sim/engine").Team[]; fantasyLeaderboard?: import("@ipl-sim/engine").FantasyPoints[] }) {
  const [open, setOpen] = useState(false);
  const leaderboards = useMemo(() => {
    const base = buildLeaderboards(teams);
    // Add fantasy points leaderboard if available
    if (fantasyLeaderboard && fantasyLeaderboard.length > 0) {
      const teamMap = new Map(teams.map(t => [t.id, t.shortName]));
      const fantasyEntries: LeaderboardEntry[] = fantasyLeaderboard
        .slice(0, 5)
        .map(fp => ({
          playerId: fp.playerId,
          playerName: fp.playerName || "Unknown",
          teamShortName: teamMap.get(fp.teamId) ?? "",
          value: `${fp.totalPoints} pts`,
          numValue: fp.totalPoints,
        }));
      if (fantasyEntries.length > 0) {
        base.push({
          title: "Fantasy XI",
          color: "text-pink-400",
          bgColor: "bg-pink-500/10 border-pink-500/20",
          entries: fantasyEntries,
        });
      }
    }
    return base;
  }, [teams, fantasyLeaderboard]);

  if (leaderboards.length === 0) return null;

  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen(prev => !prev)}
        className="flex items-center gap-2 text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-3 hover:text-th-primary transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        Leaderboards
      </button>

      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 animate-fade-in">
          {leaderboards.map(lb => (
            <div key={lb.title} className="rounded-xl border border-th bg-th-surface overflow-hidden">
              <div className={`px-3 py-2 border-b ${lb.bgColor}`}>
                <span className={`text-xs font-display font-bold ${lb.color}`}>{lb.title}</span>
              </div>
              <div className="px-3 py-1.5">
                {lb.entries.map((entry, i) => (
                  <div key={entry.playerId} className="flex items-center gap-2 py-1 text-sm">
                    <span className="text-th-faint text-xs w-4 text-right font-mono">{i + 1}</span>
                    <PlayerLink playerId={entry.playerId} className="text-th-primary font-display font-medium truncate flex-1">
                      {entry.playerName}
                    </PlayerLink>
                    <span className="text-th-muted text-xs font-display shrink-0">{entry.teamShortName}</span>
                    <span className="text-th-secondary text-xs font-mono shrink-0 w-16 text-right">{entry.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
