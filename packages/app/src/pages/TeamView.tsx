import { useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Team, type RuleSet, DEFAULT_RULES } from "@ipl-sim/engine";
import { ovrBgClass, roleLabel, bowlingStyleLabel, battingPositionLabel, battingPositionColor } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";
import { PlayerLink } from "../components/PlayerLink";
import { PlayerAvatar } from "../components/PlayerAvatar";
import {
  getPlayerScoutingView,
  getScoutingAssignment,
  MAX_SCOUTING_ASSIGNMENTS,
  type ScoutingAssignment,
  type ScoutingState,
} from "../scouting";
import { getRecruitmentTag, type RecruitmentState } from "../recruitment";
import { RecruitmentBadge } from "../components/RecruitmentControls";

interface Props {
  teams: Team[];
  rules?: RuleSet;
  scouting: ScoutingState;
  scoutingAssignments: ScoutingAssignment[];
  recruitment: RecruitmentState;
  userTeamId: string | null;
  onScoutTeam?: (teamId: string, amount?: number) => void;
  onToggleScoutAssignment?: (teamId: string) => void;
}

export function TeamView({ teams, rules = DEFAULT_RULES, scouting, scoutingAssignments, recruitment, userTeamId, onScoutTeam, onToggleScoutAssignment }: Props) {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const team = teams.find(t => t.id === teamId);

  useEffect(() => {
    if (!teamId || teamId === userTeamId || !onScoutTeam) return;
    onScoutTeam(teamId, 10);
  }, [teamId, userTeamId, onScoutTeam]);

  const isUserTeam = team?.id === userTeamId;
  const teamAssignment = team ? getScoutingAssignment(scoutingAssignments, "team", team.id) : null;
  const assignmentCapacityFull = scoutingAssignments.length >= MAX_SCOUTING_ASSIGNMENTS;
  const watchlistCount = useMemo(
    () => team ? team.roster.filter(player => getRecruitmentTag(recruitment, player.id) === "watchlist").length : 0,
    [team, recruitment],
  );
  const roster = useMemo(
    () => team ? [...team.roster].sort((a, b) => b.selectionScore - a.selectionScore || b.overall - a.overall) : [],
    [team],
  );
  const rosterViews = useMemo(() => roster.map(player => ({
    player,
    scoutingView: getPlayerScoutingView(player, team?.id, scouting, userTeamId),
  })), [roster, team?.id, scouting, userTeamId]);
  const xi = useMemo(() => team ? team.getPlayingXI(rules.maxOverseasInXI) : [], [team, rules.maxOverseasInXI]);
  const xiIds = useMemo(() => new Set(xi.map(player => player.id)), [xi]);

  if (!team) return <div className="p-8 text-th-secondary">Team not found</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <button onClick={() => navigate(-1)} className="text-th-muted hover:text-th-primary text-sm mb-5 font-display flex items-center gap-1.5 transition-colors">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back
      </button>

      {/* Team header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start">
        <TeamBadge teamId={team.id} shortName={team.shortName} primaryColor={team.config.primaryColor} size="lg" />
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">{team.name}</h2>
          <p className="text-th-muted text-sm font-display">
            <span className="stat-num">{team.roster.length}</span> players
            <span className="text-th-faint mx-1.5">&bull;</span>
            <span className="stat-num">{team.internationalCount}</span> overseas
            <span className="text-th-faint mx-1.5">&bull;</span>
            <span className="stat-num">{team.totalSpent.toFixed(1)}</span>/<span className="stat-num">{team.salaryCap}</span> Cr
          </p>
        </div>
        {!isUserTeam && (
          <div className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto sm:items-end">
            <button
              onClick={() => onToggleScoutAssignment?.(team.id)}
              disabled={!teamAssignment && assignmentCapacityFull}
              className={`rounded-lg border px-3 py-2 text-xs font-display font-medium transition-colors ${
                teamAssignment
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                  : assignmentCapacityFull
                    ? "border-th bg-th-raised text-th-faint cursor-not-allowed"
                    : "border-th bg-th-raised text-th-secondary hover:text-th-primary hover:bg-th-hover"
              }`}
            >
              {teamAssignment
                ? `Stop Team Sweep (${teamAssignment.cyclesWorked}/${teamAssignment.cyclesRequired})`
                : "Assign Team Scout"}
            </button>
            <div className="text-th-faint text-[10px] font-display">
              {watchlistCount > 0
                ? `${watchlistCount} watchlist ${watchlistCount === 1 ? "player" : "players"} on this roster`
                : `${scoutingAssignments.length}/${MAX_SCOUTING_ASSIGNMENTS} desk slots active`}
            </div>
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="W-L" value={`${team.wins}-${team.losses}`} color={team.config.primaryColor} />
        <Stat label="Points" value={String(team.points)} />
        <Stat label="NRR" value={(team.nrr >= 0 ? "+" : "") + team.nrr.toFixed(3)} />
        <Stat label="Power" value={String(team.powerRating)} />
      </div>

      {/* Role composition */}
      <RoleBar roster={roster} teamColor={team.config.primaryColor} />

      {/* Injury panel */}
      {roster.filter(p => p.injured).length > 0 && (
        <div className="bg-red-950/20 border border-red-800/30 rounded-xl p-4 mb-6">
          <h3 className="text-red-400 font-display font-semibold text-sm mb-2">Injured Players</h3>
          <div className="space-y-2">
            {roster.filter(p => p.injured).map(p => (
              <div key={p.id} className="flex flex-col items-start gap-2 text-sm sm:flex-row sm:items-center sm:flex-wrap">
                <PlayerLink playerId={p.id} className="text-red-300 font-medium sm:w-40">{p.name}</PlayerLink>
                <span className="text-th-muted text-xs sm:w-20">{roleLabel(p.role)}</span>
                <span className="text-red-500/70 text-xs">{p.injuryType ?? "injury"}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  p.injurySeverity === "severe" ? "bg-red-900/30 text-red-300" :
                  p.injurySeverity === "moderate" ? "bg-orange-900/30 text-orange-400" :
                  "bg-yellow-900/30 text-yellow-400"
                }`}>
                  {p.injurySeverity ?? "minor"}
                </span>
                <span className="text-th-muted text-xs">
                  {p.injuryGamesLeft} {p.injuryGamesLeft === 1 ? "match" : "matches"} remaining
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Roster cards */}
      <div className="rounded-2xl border border-th overflow-hidden bg-th-surface">
        <div className="space-y-3 p-3 md:hidden">
          {rosterViews.map(({ player: p, scoutingView }) => (
            <div
              key={p.id}
              className={`rounded-xl border border-th bg-th-raised p-4 ${xiIds.has(p.id) ? "" : "opacity-60"}`}
            >
              <div className="flex items-start gap-3">
                <PlayerAvatar name={p.name} imageUrl={p.imageUrl} size="sm" teamColor={team.config.primaryColor} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <PlayerLink playerId={p.id} className="text-th-primary font-display font-medium">{p.name}</PlayerLink>
                    <span className={`ovr-badge inline-block rounded-md px-1.5 py-0.5 text-sm ${ovrBgClass(scoutingView.overall.sortValue)}`}>{scoutingView.overall.compactDisplay}</span>
                  </div>
                  <div className="mt-1 text-xs font-display text-th-faint">{p.country}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {isUserTeam && <FormBadge form={p.form} />}
                    {isUserTeam && <ConditionBadge readiness={p.readiness} />}
                    {p.isInternational && <span className="text-blue-400/70 text-[10px] font-display font-semibold bg-blue-500/10 px-1 rounded">OS</span>}
                    {p.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] font-display font-semibold bg-cyan-500/10 px-1 rounded">WK</span>}
                    {p.injured && <span className="text-red-400 text-[10px] font-display font-semibold bg-red-500/10 px-1 rounded">INJ</span>}
                    {xiIds.has(p.id) && <span className="text-emerald-400/70 text-[10px] font-display font-semibold bg-emerald-500/10 px-1 rounded">XI</span>}
                    {p.battingPosition && battingPositionLabel(p.battingPosition) && (
                      <span className={`text-[10px] font-display font-semibold px-1 rounded ${battingPositionColor(p.battingPosition)}`}>
                        {battingPositionLabel(p.battingPosition)}
                      </span>
                    )}
                    {isUserTeam && <MoraleDot morale={p.morale} />}
                    {isUserTeam && p.contractYears <= 0 && (
                      <span className="text-[10px] font-display font-semibold px-1 rounded text-red-400 bg-red-500/10">FA</span>
                    )}
                    <RecruitmentBadge tier={getRecruitmentTag(recruitment, p.id)} compact />
                    {!isUserTeam && <span className="text-th-faint text-[10px] font-display">{scoutingView.confidenceLabel}</span>}
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                <MiniStat label="BAT" value={scoutingView.batting.compactDisplay} tone="text-orange-300" />
                <MiniStat label="BWL" value={scoutingView.bowling.compactDisplay} tone="text-purple-300" />
                <MiniStat label="Role" value={roleLabel(p.role)} />
                <MiniStat
                  label={isUserTeam ? "Ready" : "Scout"}
                  value={isUserTeam ? conditionLabel(p.readiness) : scoutingView.confidenceLabel}
                  tone={isUserTeam ? conditionColor(p.readiness) : "text-th-secondary"}
                />
                <MiniStat
                  label="Style"
                  value={scoutingView.showStyleDetails ? bowlingStyleLabel(p.bowlingStyle) || "Unknown" : scoutingView.confidenceLabel}
                  tone="text-th-secondary"
                />
                <MiniStat label="Age" value={scoutingView.ageDisplay} />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Runs" value={String(p.stats.runs)} />
                <MiniStat label="Wkts" value={String(p.stats.wickets)} />
                <MiniStat
                  label={isUserTeam ? "Bid" : "Value"}
                  value={isUserTeam ? p.bid.toFixed(1) : scoutingView.marketValue.compactDisplay}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm min-w-[520px]">
            <thead>
              <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider border-b border-th">
                <th className="text-left px-3 sm:px-4 py-3">Player</th>
                <th className="text-center px-2 py-3">OVR</th>
                <th className="text-center px-2 py-3">BAT</th>
                <th className="text-center px-2 py-3">BWL</th>
                <th className="text-center px-2 py-3">Role</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Style</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Age</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">{isUserTeam ? "Ready" : "Scout"}</th>
                <th className="text-center px-2 py-3 hidden md:table-cell">M</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Runs</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Wkts</th>
                <th className="text-center px-2 py-3 hidden md:table-cell">{isUserTeam ? "Bid" : "Value"}</th>
              </tr>
            </thead>
            <tbody>
              {rosterViews.map(({ player: p, scoutingView }) => (
                <tr key={p.id} className={`border-t border-th transition-colors hover:bg-th-hover ${xiIds.has(p.id) ? "" : "opacity-40"}`}>
                  <td className="px-3 sm:px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <PlayerAvatar name={p.name} imageUrl={p.imageUrl} size="sm" teamColor={team.config.primaryColor} />
                      <PlayerLink playerId={p.id} className="text-th-primary font-display font-medium">{p.name}</PlayerLink>
                      {isUserTeam && <FormBadge form={p.form} />}
                      {isUserTeam && <ConditionBadge readiness={p.readiness} />}
                      {p.isInternational && <span className="text-blue-400/70 text-[10px] font-display font-semibold bg-blue-500/10 px-1 rounded">OS</span>}
                      {p.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] font-display font-semibold bg-cyan-500/10 px-1 rounded">WK</span>}
                      {p.injured && <span className="text-red-400 text-[10px] font-display font-semibold bg-red-500/10 px-1 rounded" aria-label="Player is injured">INJ</span>}
                      {xiIds.has(p.id) && <span className="text-emerald-400/70 text-[10px] font-display font-semibold bg-emerald-500/10 px-1 rounded">XI</span>}
                      {p.battingPosition && battingPositionLabel(p.battingPosition) && (
                        <span className={`text-[10px] font-display font-semibold px-1 rounded ${battingPositionColor(p.battingPosition)}`}>
                          {battingPositionLabel(p.battingPosition)}
                        </span>
                      )}
                      {isUserTeam && <MoraleDot morale={p.morale} />}
                      {isUserTeam && p.contractYears <= 0 && (
                        <span className="text-[10px] font-display font-semibold px-1 rounded text-red-400 bg-red-500/10">FA</span>
                      )}
                      <RecruitmentBadge tier={getRecruitmentTag(recruitment, p.id)} compact />
                      {!isUserTeam && <span className="text-th-faint text-[10px] font-display">{scoutingView.confidenceLabel}</span>}
                    </div>
                    <span className="text-th-faint text-xs font-display">{p.country}</span>
                  </td>
                  <td className="text-center px-2 py-2.5">
                    <span className={`ovr-badge text-sm inline-block min-w-[28px] rounded-md px-1 py-0.5 ${ovrBgClass(scoutingView.overall.sortValue)}`}>{scoutingView.overall.compactDisplay}</span>
                  </td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-300/70 text-sm">{scoutingView.batting.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-300/70 text-sm">{scoutingView.bowling.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 text-th-muted text-xs font-display">{roleLabel(p.role)}</td>
                  <td className="text-center px-2 py-2.5 text-purple-400/60 text-[10px] font-display font-semibold hidden sm:table-cell">{scoutingView.showStyleDetails ? bowlingStyleLabel(p.bowlingStyle) : scoutingView.confidenceLabel}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden sm:table-cell">{scoutingView.ageDisplay}</td>
                  <td className={`text-center px-2 py-2.5 stat-num text-sm hidden sm:table-cell ${isUserTeam ? conditionColor(p.readiness) : "text-th-muted"}`}>
                    {isUserTeam ? p.readiness : scoutingView.confidenceLabel}
                  </td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden md:table-cell">{p.stats.matches}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.runs}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.wickets}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden md:table-cell">
                    {isUserTeam ? p.bid.toFixed(1) : scoutingView.marketValue.compactDisplay}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-th bg-th-surface p-3 text-center relative overflow-hidden">
      {color && <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: color }} />}
      <div className="text-th-muted text-[10px] uppercase font-display tracking-wider">{label}</div>
      <div className="text-th-primary font-display font-bold text-lg stat-num">{value}</div>
    </div>
  );
}

function MiniStat({ label, value, tone = "text-th-primary" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-th bg-th-surface px-2.5 py-2 text-center">
      <div className="text-[10px] uppercase tracking-wider text-th-faint">{label}</div>
      <div className={`mt-1 text-xs font-display font-medium ${tone}`}>{value}</div>
    </div>
  );
}

import type { Player } from "@ipl-sim/engine";

const ROLE_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  batsman:          { bg: "bg-orange-500",  text: "text-orange-300",  label: "BAT" },
  bowler:           { bg: "bg-purple-500",  text: "text-purple-300",  label: "BWL" },
  "all-rounder":    { bg: "bg-emerald-500", text: "text-emerald-300", label: "AR" },
  "wicket-keeper":  { bg: "bg-cyan-500",    text: "text-cyan-300",    label: "WK" },
};

function FormBadge({ form }: { form: number }) {
  if (form > 65) {
    return <span className="text-green-400 text-xs" title={`Form: ${Math.round(form)}`}>&#9650;</span>;
  }
  if (form < 35) {
    return <span className="text-red-400 text-xs" title={`Form: ${Math.round(form)}`}>&#9660;</span>;
  }
  return null;
}

function conditionColor(readiness: number): string {
  if (readiness >= 85) return "text-cyan-300";
  if (readiness >= 70) return "text-green-300";
  if (readiness >= 55) return "text-yellow-300";
  if (readiness >= 40) return "text-orange-300";
  return "text-red-300";
}

function conditionLabel(readiness: number): string {
  if (readiness >= 85) return "Fresh";
  if (readiness >= 70) return "Good";
  if (readiness >= 55) return "Managed";
  if (readiness >= 40) return "Tired";
  return "Exhausted";
}

function ConditionBadge({ readiness }: { readiness: number }) {
  return (
    <span className={`text-[10px] font-display font-semibold px-1 rounded ${conditionColor(readiness)}`}>
      {conditionLabel(readiness)}
    </span>
  );
}

function MoraleDot({ morale }: { morale: number }) {
  const color = morale >= 70 ? "bg-green-400" : morale >= 40 ? "bg-yellow-400" : "bg-red-400";
  const label = morale >= 70 ? "Happy" : morale >= 40 ? "Content" : "Unhappy";
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${color}`}
      title={`Morale: ${Math.round(morale)} (${label})`}
    />
  );
}

function RoleBar({ roster, teamColor }: { roster: Player[]; teamColor: string }) {
  const counts: Record<string, number> = {};
  for (const p of roster) {
    counts[p.role] = (counts[p.role] ?? 0) + 1;
  }
  const total = roster.length;
  const roles = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="mb-6">
      {/* Visual bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-2.5">
        {roles.map(([role, count]) => (
          <div
            key={role}
            className={`${ROLE_COLORS[role]?.bg ?? "bg-gray-600"} first:rounded-l-full last:rounded-r-full`}
            style={{ width: `${(count / total) * 100}%` }}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {roles.map(([role, count]) => {
          const rc = ROLE_COLORS[role];
          return (
            <div key={role} className="flex items-center gap-1.5 text-xs">
              <div className={`w-2 h-2 rounded-full ${rc?.bg ?? "bg-gray-600"}`} />
              <span className={`font-display ${rc?.text ?? "text-gray-400"}`}>{rc?.label ?? role}</span>
              <span className="text-th-muted stat-num">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
