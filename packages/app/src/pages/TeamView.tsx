import { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Team, type RuleSet, DEFAULT_RULES } from "@ipl-sim/engine";
import { ovrBgClass, roleLabel } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";
import { PlayerLink } from "../components/PlayerLink";

interface Props {
  teams: Team[];
  rules?: RuleSet;
}

export function TeamView({ teams, rules = DEFAULT_RULES }: Props) {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const team = teams.find(t => t.id === teamId);

  if (!team) return <div className="p-8 text-th-secondary">Team not found</div>;

  const roster = useMemo(() => [...team.roster].sort((a, b) => b.overall - a.overall), [team.roster]);
  const xi = team.getPlayingXI(rules.maxOverseasInXI);
  const xiIds = new Set(xi.map(p => p.id));

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <button onClick={() => navigate(-1)} className="text-th-muted hover:text-th-primary text-sm mb-5 font-display flex items-center gap-1.5 transition-colors">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back
      </button>

      {/* Team header */}
      <div className="flex items-center gap-4 mb-6">
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
              <div key={p.id} className="flex items-center gap-3 text-sm">
                <PlayerLink playerId={p.id} className="text-red-300 font-medium w-40">{p.name}</PlayerLink>
                <span className="text-th-muted text-xs w-20">{roleLabel(p.role)}</span>
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

      {/* Roster table */}
      <div className="rounded-2xl border border-th overflow-hidden bg-th-surface">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[540px]">
            <thead>
              <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider border-b border-th">
                <th className="text-left px-3 sm:px-4 py-3">Player</th>
                <th className="text-center px-2 py-3">OVR</th>
                <th className="text-center px-2 py-3">BAT</th>
                <th className="text-center px-2 py-3">BWL</th>
                <th className="text-center px-2 py-3">Role</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Age</th>
                <th className="text-center px-2 py-3 hidden md:table-cell">M</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Runs</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Wkts</th>
                <th className="text-center px-2 py-3 hidden md:table-cell">Bid</th>
              </tr>
            </thead>
            <tbody>
              {roster.map(p => (
                <tr key={p.id} className={`border-t border-th transition-colors hover:bg-th-hover ${xiIds.has(p.id) ? "" : "opacity-40"}`}>
                  <td className="px-3 sm:px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <PlayerLink playerId={p.id} className="text-th-primary font-display font-medium">{p.name}</PlayerLink>
                      {p.isInternational && <span className="text-blue-400/70 text-[10px] font-display font-semibold bg-blue-500/10 px-1 rounded">OS</span>}
                      {p.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] font-display font-semibold bg-cyan-500/10 px-1 rounded">WK</span>}
                      {p.injured && <span className="text-red-400 text-[10px] font-display font-semibold bg-red-500/10 px-1 rounded" aria-label="Player is injured">INJ</span>}
                      {xiIds.has(p.id) && <span className="text-emerald-400/70 text-[10px] font-display font-semibold bg-emerald-500/10 px-1 rounded">XI</span>}
                    </div>
                    <span className="text-th-faint text-xs font-display">{p.country}</span>
                  </td>
                  <td className="text-center px-2 py-2.5">
                    <span className={`ovr-badge text-sm inline-block min-w-[28px] rounded-md px-1 py-0.5 ${ovrBgClass(p.overall)}`}>{p.overall}</span>
                  </td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-300/70 text-sm">{p.battingOvr}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-300/70 text-sm">{p.bowlingOvr}</td>
                  <td className="text-center px-2 py-2.5 text-th-muted text-xs font-display">{roleLabel(p.role)}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden sm:table-cell">{p.age}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden md:table-cell">{p.stats.matches}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.runs}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.wickets}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden md:table-cell">{p.bid.toFixed(1)}</td>
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

import type { Player } from "@ipl-sim/engine";

const ROLE_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  batsman:          { bg: "bg-orange-500",  text: "text-orange-300",  label: "BAT" },
  bowler:           { bg: "bg-purple-500",  text: "text-purple-300",  label: "BWL" },
  "all-rounder":    { bg: "bg-emerald-500", text: "text-emerald-300", label: "AR" },
  "wicket-keeper":  { bg: "bg-cyan-500",    text: "text-cyan-300",    label: "WK" },
};

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
