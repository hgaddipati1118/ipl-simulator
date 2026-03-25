import { useState, useMemo } from "react";
import { Team, Player } from "@ipl-sim/engine";
import { ovrBgClass, roleLabel, teamLabelColor, battingPositionLabel, battingPositionColor } from "../ui-utils";
import { PlayerLink } from "../components/PlayerLink";
import {
  getPlayerScoutingView,
  getScoutingAssignment,
  MAX_SCOUTING_ASSIGNMENTS,
  type ScoutingAssignment,
  type ScoutingState,
} from "../scouting";
import { getRecruitmentCounts, getRecruitmentTag, type RecruitmentState } from "../recruitment";
import { RecruitmentActions, RecruitmentBadge } from "../components/RecruitmentControls";

interface Props {
  teams: Team[];
  playerPool: Player[];
  scouting: ScoutingState;
  scoutingAssignments: ScoutingAssignment[];
  userTeamId: string | null;
  recruitment: RecruitmentState;
  onTogglePlayerAssignment: (playerId: string) => void;
  onToggleShortlistAssignment: () => void;
  onToggleMarketAssignment: () => void;
  onToggleShortlist: (playerId: string) => void;
  onToggleWatchlist: (playerId: string) => void;
}

type SortKey = "overall" | "battingOvr" | "bowlingOvr" | "age" | "runs" | "wickets" | "name";
type RecruitmentFilter = "all" | "shortlist" | "watchlist";

export function PlayerRatingsPage({
  teams,
  playerPool,
  scouting,
  scoutingAssignments,
  userTeamId,
  recruitment,
  onTogglePlayerAssignment,
  onToggleShortlistAssignment,
  onToggleMarketAssignment,
  onToggleShortlist,
  onToggleWatchlist,
}: Props) {
  const [sortBy, setSortBy] = useState<SortKey>("overall");
  const [filterRole, setFilterRole] = useState<string>("all");
  const [filterTeam, setFilterTeam] = useState<string>("all");
  const [filterRecruitment, setFilterRecruitment] = useState<RecruitmentFilter>("all");
  const [hideOwned, setHideOwned] = useState(false);
  const [search, setSearch] = useState("");
  const recruitmentCounts = useMemo(() => getRecruitmentCounts(recruitment), [recruitment]);
  const shortlistAssignment = useMemo(() => getScoutingAssignment(scoutingAssignments, "shortlist"), [scoutingAssignments]);
  const marketAssignment = useMemo(() => getScoutingAssignment(scoutingAssignments, "market"), [scoutingAssignments]);
  const assignmentCapacityFull = scoutingAssignments.length >= MAX_SCOUTING_ASSIGNMENTS;

  const allPlayers = useMemo(() => {
    let result = [
      ...teams.flatMap(team => team.roster.map(player => ({
        player,
        team,
        teamKey: team.id,
        teamLabel: team.shortName,
        scoutingView: getPlayerScoutingView(player, team.id, scouting, userTeamId),
        recruitmentTag: getRecruitmentTag(recruitment, player.id),
      }))),
      ...playerPool.map(player => ({
        player,
        team: null,
        teamKey: "free-agents",
        teamLabel: "FA",
        scoutingView: getPlayerScoutingView(player, undefined, scouting, userTeamId),
        recruitmentTag: getRecruitmentTag(recruitment, player.id),
      })),
    ];
    if (filterRole !== "all") result = result.filter(({ player }) => player.role === filterRole);
    if (filterTeam !== "all") result = result.filter(({ teamKey }) => teamKey === filterTeam);
    if (filterRecruitment !== "all") result = result.filter(({ recruitmentTag }) => recruitmentTag === filterRecruitment);
    if (hideOwned) result = result.filter(({ team }) => team?.id !== userTeamId);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(({ player }) => player.name.toLowerCase().includes(q));
    }
    result.sort((a, b) => {
      const pa = a.player, pb = b.player;
      const va = a.scoutingView, vb = b.scoutingView;
      switch (sortBy) {
        case "overall": return vb.overall.sortValue - va.overall.sortValue;
        case "battingOvr": return vb.batting.sortValue - va.batting.sortValue;
        case "bowlingOvr": return vb.bowling.sortValue - va.bowling.sortValue;
        case "age": return va.ageSortValue - vb.ageSortValue;
        case "runs": return pb.stats.runs - pa.stats.runs;
        case "wickets": return pb.stats.wickets - pa.stats.wickets;
        case "name": return pa.name.localeCompare(pb.name);
        default: return 0;
      }
    });
    return result;
  }, [teams, playerPool, scouting, userTeamId, recruitment, sortBy, filterRole, filterTeam, filterRecruitment, hideOwned, search]);

  const activeAssignments = useMemo(
    () => scoutingAssignments
      .map(assignment => ({
        ...assignment,
        progressLabel: `${assignment.cyclesWorked}/${assignment.cyclesRequired}`,
      })),
    [scoutingAssignments],
  );

  const SortHeader = ({ label, field, className = "" }: { label: string; field: SortKey; className?: string }) => (
    <th
      className={`text-center px-2 py-3 cursor-pointer transition-colors hover:text-th-primary ${sortBy === field ? "text-orange-400" : ""} ${className}`}
      onClick={() => setSortBy(field)}
    >
      {label}
      {sortBy === field && <span className="ml-0.5 text-[8px]">▼</span>}
    </th>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">Player Ratings</h2>
          <p className="text-th-faint text-xs font-display mt-1">External players show scouting estimates until your report is strong enough.</p>
          <p className="text-th-faint text-xs font-display mt-1">
            <span className="stat-num">{recruitmentCounts.shortlist}</span> shortlisted
            <span className="mx-1.5 text-th-faint">•</span>
            <span className="stat-num">{recruitmentCounts.watchlist}</span> watched
          </p>
        </div>
        <span className="text-th-muted text-sm stat-num">{allPlayers.length} players</span>
      </div>

      <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5 mb-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider">Scouting Desk</h3>
            <p className="text-th-muted text-sm mt-2 leading-6">
              {scoutingAssignments.length}/{MAX_SCOUTING_ASSIGNMENTS} assignments active. Use the desk to keep pressure on your shortlist and the top of the free-agent market instead of only browsing estimates.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onToggleShortlistAssignment}
              disabled={(!shortlistAssignment && recruitmentCounts.shortlist === 0) || (assignmentCapacityFull && !shortlistAssignment)}
              className={`rounded-lg border px-3 py-2 text-xs font-display font-medium transition-colors ${
                shortlistAssignment
                  ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                  : (recruitmentCounts.shortlist === 0 || assignmentCapacityFull)
                    ? "border-th bg-th-raised text-th-faint cursor-not-allowed"
                    : "border-th bg-th-raised text-th-secondary hover:text-th-primary hover:bg-th-hover"
              }`}
            >
              {shortlistAssignment ? `Stop Shortlist Scout (${shortlistAssignment.cyclesWorked}/${shortlistAssignment.cyclesRequired})` : "Scout Shortlist"}
            </button>
            <button
              onClick={onToggleMarketAssignment}
              disabled={(!marketAssignment && playerPool.length === 0) || (assignmentCapacityFull && !marketAssignment)}
              className={`rounded-lg border px-3 py-2 text-xs font-display font-medium transition-colors ${
                marketAssignment
                  ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
                  : (playerPool.length === 0 || assignmentCapacityFull)
                    ? "border-th bg-th-raised text-th-faint cursor-not-allowed"
                    : "border-th bg-th-raised text-th-secondary hover:text-th-primary hover:bg-th-hover"
              }`}
            >
              {marketAssignment ? `Stop Market Scan (${marketAssignment.cyclesWorked}/${marketAssignment.cyclesRequired})` : "Scan Free Agents"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {activeAssignments.length === 0 ? (
            <div className="md:col-span-3 rounded-xl border border-th bg-th-raised p-3 text-th-faint text-sm">
              No active assignments. Shortlist a few targets or run a market scan to start getting timed scouting updates through the inbox.
            </div>
          ) : (
            activeAssignments.map(assignment => (
              <div key={assignment.id} className="rounded-xl border border-th bg-th-raised px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-th-primary font-display font-semibold">{assignment.label}</div>
                  <div className="text-th-faint text-[10px] uppercase tracking-wider">{assignment.progressLabel}</div>
                </div>
                <div className="text-th-muted text-xs mt-2">
                  {assignment.type === "player"
                    ? "Direct player file"
                    : assignment.type === "shortlist"
                      ? "Shortlist sweep"
                      : assignment.type === "market"
                        ? "Free-agent market scan"
                        : "Club sweep"}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 sm:gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 sm:flex-none">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-th-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-th-surface border border-th rounded-xl pl-9 pr-3 py-2 text-sm text-th-primary placeholder-[var(--th-text-faint)] w-full sm:w-48 focus:outline-none focus:border-th-strong focus:bg-th-raised transition-all font-display"
          />
        </div>
        <select
          value={filterRole}
          onChange={e => setFilterRole(e.target.value)}
          className="bg-th-surface border border-th rounded-xl px-3 py-2 text-sm text-th-primary font-display focus:outline-none focus:border-th-strong"
        >
          <option value="all">All Roles</option>
          <option value="batsman">Batsman</option>
          <option value="bowler">Bowler</option>
          <option value="all-rounder">All-Rounder</option>
        </select>
        <select
          value={filterTeam}
          onChange={e => setFilterTeam(e.target.value)}
          className="bg-th-surface border border-th rounded-xl px-3 py-2 text-sm text-th-primary font-display focus:outline-none focus:border-th-strong"
        >
          <option value="all">All Teams</option>
          <option value="free-agents">Free Agents</option>
          {teams.map(t => (
            <option key={t.id} value={t.id}>{t.shortName}</option>
          ))}
        </select>
        <select
          value={filterRecruitment}
          onChange={e => setFilterRecruitment(e.target.value as RecruitmentFilter)}
          className="bg-th-surface border border-th rounded-xl px-3 py-2 text-sm text-th-primary font-display focus:outline-none focus:border-th-strong"
        >
          <option value="all">All Targets</option>
          <option value="shortlist">Shortlist</option>
          <option value="watchlist">Watchlist</option>
        </select>
        <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-th bg-th-surface text-sm text-th-secondary font-display">
          <input
            type="checkbox"
            checked={hideOwned}
            onChange={e => setHideOwned(e.target.checked)}
            className="accent-orange-500"
          />
          Hide Owned
        </label>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-th overflow-hidden bg-th-surface">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[540px]">
            <thead>
              <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider border-b border-th">
                <th className="text-left px-2 sm:px-4 py-3">#</th>
                <SortHeader label="Player" field="name" />
                <th className="text-center px-2 py-3 hidden sm:table-cell">Team</th>
                <th className="text-center px-2 py-3 hidden sm:table-cell">Role</th>
                <th className="text-center px-2 py-3 hidden md:table-cell">Track</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell">Scout</th>
                <SortHeader label="OVR" field="overall" />
                <SortHeader label="BAT" field="battingOvr" className="hidden md:table-cell" />
                <SortHeader label="BWL" field="bowlingOvr" className="hidden md:table-cell" />
                <th className="text-center px-2 py-3 hidden lg:table-cell text-orange-500/40">IQ</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-orange-500/40">TIM</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-orange-500/40">PWR</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-orange-500/40">RUN</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-purple-500/40">WKT</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-purple-500/40">ECN</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-purple-500/40">ACC</th>
                <th className="text-center px-2 py-3 hidden lg:table-cell text-cyan-500/40">CLT</th>
                <SortHeader label="Age" field="age" className="hidden md:table-cell" />
                <SortHeader label="Runs" field="runs" className="hidden sm:table-cell" />
                <SortHeader label="Wkts" field="wickets" className="hidden sm:table-cell" />
              </tr>
            </thead>
            <tbody>
              {allPlayers.slice(0, 125).map(({ player: p, team, teamLabel, scoutingView, recruitmentTag }, i) => {
                const playerAssignment = getScoutingAssignment(scoutingAssignments, "player", p.id);
                const canAssignPlayer = team?.id !== userTeamId;
                const playerButtonDisabled = !playerAssignment && (!canAssignPlayer || assignmentCapacityFull);
                return (
                <tr key={p.id} className="border-t border-th hover:bg-th-hover transition-colors">
                  <td className="px-2 sm:px-4 py-2.5 text-th-faint text-xs stat-num">{i + 1}</td>
                  <td className="text-left px-2 py-2.5">
                    <PlayerLink playerId={p.id} className="text-th-primary font-display text-xs sm:text-sm">{p.name}</PlayerLink>
                    {p.isInternational && <span className="text-blue-400/60 text-[10px] ml-1 font-semibold">OS</span>}
                    {p.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] ml-1 font-semibold">WK</span>}
                    {p.battingPosition && battingPositionLabel(p.battingPosition) && (
                      <span className={`text-[10px] ml-1 font-semibold px-1 rounded ${battingPositionColor(p.battingPosition)}`}>
                        {battingPositionLabel(p.battingPosition)}
                      </span>
                    )}
                    {recruitmentTag && <span className="ml-1"><RecruitmentBadge tier={recruitmentTag} compact /></span>}
                    {/* Show team + role inline on mobile (hidden in dedicated columns) */}
                    <span className="sm:hidden block text-[10px] text-th-muted mt-0.5">
                      <span style={{ color: team ? teamLabelColor(team.config.primaryColor) : "var(--th-text-secondary)" }}>{teamLabel}</span>
                      {" "}<span className={p.role === "bowler" ? "text-purple-400/70" : p.role === "all-rounder" ? "text-emerald-400/70" : "text-orange-400/70"}>{roleLabel(p.role)}</span>
                      {p.battingPosition && battingPositionLabel(p.battingPosition) && (
                        <>{" "}<span className={battingPositionColor(p.battingPosition)}>{battingPositionLabel(p.battingPosition)}</span></>
                      )}
                      {" "}<span className="text-th-faint">| {scoutingView.confidenceLabel}</span>
                    </span>
                  </td>
                  <td className="text-center px-2 py-2.5 hidden sm:table-cell">
                    <span
                      className="text-xs font-display font-medium"
                      style={{ color: team ? teamLabelColor(team.config.primaryColor) : "var(--th-text-secondary)" }}
                    >
                      {teamLabel}
                    </span>
                  </td>
                  <td className="text-center px-2 py-2.5 hidden sm:table-cell">
                    <span className={`text-[10px] font-display font-semibold px-1.5 py-0.5 rounded ${
                      p.role === "bowler" ? "bg-purple-500/15 text-purple-400" :
                      p.role === "all-rounder" ? "bg-emerald-500/15 text-emerald-400" :
                      "bg-orange-500/15 text-orange-400"
                    }`}>{roleLabel(p.role)}</span>
                  </td>
                  <td className="text-center px-2 py-2.5 hidden md:table-cell">
                    {team?.id !== userTeamId ? (
                      <div className="flex flex-col items-center gap-2">
                        <RecruitmentActions
                          tier={recruitmentTag}
                          compact
                          onToggleShortlist={() => onToggleShortlist(p.id)}
                          onToggleWatchlist={() => onToggleWatchlist(p.id)}
                        />
                        <button
                          onClick={() => onTogglePlayerAssignment(p.id)}
                          disabled={playerButtonDisabled}
                          className={`rounded-lg border px-2 py-1 text-[10px] font-display font-medium transition-colors ${
                            playerAssignment
                              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                              : playerButtonDisabled
                                ? "border-th bg-th-raised text-th-faint cursor-not-allowed"
                                : "border-th bg-th-raised text-th-secondary hover:text-th-primary hover:bg-th-hover"
                          }`}
                        >
                          {playerAssignment ? `Scouting ${playerAssignment.cyclesWorked}/${playerAssignment.cyclesRequired}` : "Assign Scout"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-th-faint font-display">Own squad</span>
                    )}
                  </td>
                  <td className="text-center px-2 py-2.5 hidden lg:table-cell">
                    <span className="text-[10px] text-th-muted font-display">{scoutingView.confidenceLabel}</span>
                    <span className="block text-[10px] text-th-faint stat-num">{scoutingView.confidence}%</span>
                    {playerAssignment && (
                      <span className="block text-[10px] text-emerald-300 font-display mt-1">
                        Active {playerAssignment.cyclesWorked}/{playerAssignment.cyclesRequired}
                      </span>
                    )}
                  </td>
                  <td className="text-center px-2 py-2.5">
                    <span className={`ovr-badge text-sm inline-block min-w-[28px] rounded-md px-1 py-0.5 ${ovrBgClass(scoutingView.overall.sortValue)}`}>{scoutingView.overall.compactDisplay}</span>
                  </td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-300/60 text-sm hidden md:table-cell">{scoutingView.batting.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-300/60 text-sm hidden md:table-cell">{scoutingView.bowling.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.battingIQ.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.timing.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.power.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.running.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.wicketTaking.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.economy.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.accuracy.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-cyan-400/40 text-sm hidden lg:table-cell">{scoutingView.attributes.clutch.compactDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden md:table-cell">{scoutingView.ageDisplay}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.runs}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.wickets}</td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
