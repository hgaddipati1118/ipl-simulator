import { useState, useMemo } from "react";
import { Team, Player } from "@ipl-sim/engine";
import { ovrBgClass, roleLabel, teamLabelColor } from "../ui-utils";
import { PlayerLink } from "../components/PlayerLink";

interface Props {
  teams: Team[];
}

type SortKey = "overall" | "battingOvr" | "bowlingOvr" | "age" | "runs" | "wickets" | "name";

export function PlayerRatingsPage({ teams }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>("overall");
  const [filterRole, setFilterRole] = useState<string>("all");
  const [filterTeam, setFilterTeam] = useState<string>("all");
  const [search, setSearch] = useState("");

  const allPlayers = useMemo(() => {
    let result = teams.flatMap(t => t.roster.map(p => ({ player: p, team: t })));
    if (filterRole !== "all") result = result.filter(({ player }) => player.role === filterRole);
    if (filterTeam !== "all") result = result.filter(({ team }) => team.id === filterTeam);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(({ player }) => player.name.toLowerCase().includes(q));
    }
    result.sort((a, b) => {
      const pa = a.player, pb = b.player;
      switch (sortBy) {
        case "overall": return pb.overall - pa.overall;
        case "battingOvr": return pb.battingOvr - pa.battingOvr;
        case "bowlingOvr": return pb.bowlingOvr - pa.bowlingOvr;
        case "age": return pa.age - pb.age;
        case "runs": return pb.stats.runs - pa.stats.runs;
        case "wickets": return pb.stats.wickets - pa.stats.wickets;
        case "name": return pa.name.localeCompare(pb.name);
        default: return 0;
      }
    });
    return result;
  }, [teams, sortBy, filterRole, filterTeam, search]);

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
        <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">Player Ratings</h2>
        <span className="text-th-muted text-sm stat-num">{allPlayers.length} players</span>
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
          <option value="wicket-keeper">Wicket-Keeper</option>
        </select>
        <select
          value={filterTeam}
          onChange={e => setFilterTeam(e.target.value)}
          className="bg-th-surface border border-th rounded-xl px-3 py-2 text-sm text-th-primary font-display focus:outline-none focus:border-th-strong"
        >
          <option value="all">All Teams</option>
          {teams.map(t => (
            <option key={t.id} value={t.id}>{t.shortName}</option>
          ))}
        </select>
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
              {allPlayers.slice(0, 100).map(({ player: p, team }, i) => (
                <tr key={p.id} className="border-t border-th hover:bg-th-hover transition-colors">
                  <td className="px-2 sm:px-4 py-2.5 text-th-faint text-xs stat-num">{i + 1}</td>
                  <td className="text-left px-2 py-2.5">
                    <PlayerLink playerId={p.id} className="text-th-primary font-display text-xs sm:text-sm">{p.name}</PlayerLink>
                    {p.isInternational && <span className="text-blue-400/60 text-[10px] ml-1 font-semibold">OS</span>}
                    {p.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] ml-1 font-semibold">WK</span>}
                    {/* Show team + role inline on mobile (hidden in dedicated columns) */}
                    <span className="sm:hidden block text-[10px] text-th-muted mt-0.5">
                      <span style={{ color: teamLabelColor(team.config.primaryColor) }}>{team.shortName}</span>
                      {" "}<span className={p.role === "bowler" ? "text-purple-400/70" : p.role === "all-rounder" ? "text-emerald-400/70" : p.role === "wicket-keeper" ? "text-cyan-400/70" : "text-orange-400/70"}>{roleLabel(p.role)}</span>
                    </span>
                  </td>
                  <td className="text-center px-2 py-2.5 hidden sm:table-cell">
                    <span
                      className="text-xs font-display font-medium"
                      style={{ color: teamLabelColor(team.config.primaryColor) }}
                    >
                      {team.shortName}
                    </span>
                  </td>
                  <td className="text-center px-2 py-2.5 hidden sm:table-cell">
                    <span className={`text-[10px] font-display font-semibold px-1.5 py-0.5 rounded ${
                      p.role === "bowler" ? "bg-purple-500/15 text-purple-400" :
                      p.role === "all-rounder" ? "bg-emerald-500/15 text-emerald-400" :
                      p.role === "wicket-keeper" ? "bg-cyan-500/15 text-cyan-400" :
                      "bg-orange-500/15 text-orange-400"
                    }`}>{roleLabel(p.role)}</span>
                  </td>
                  <td className="text-center px-2 py-2.5">
                    <span className={`ovr-badge text-sm inline-block min-w-[28px] rounded-md px-1 py-0.5 ${ovrBgClass(p.overall)}`}>{p.overall}</span>
                  </td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-300/60 text-sm hidden md:table-cell">{p.battingOvr}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-300/60 text-sm hidden md:table-cell">{p.bowlingOvr}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{p.ratings.battingIQ}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{p.ratings.timing}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{p.ratings.power}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-orange-400/40 text-sm hidden lg:table-cell">{p.ratings.running}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-400/40 text-sm hidden lg:table-cell">{p.ratings.wicketTaking}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-400/40 text-sm hidden lg:table-cell">{p.ratings.economy}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-purple-400/40 text-sm hidden lg:table-cell">{p.ratings.accuracy}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-cyan-400/40 text-sm hidden lg:table-cell">{p.ratings.clutch}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-muted text-sm hidden md:table-cell">{p.age}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.runs}</td>
                  <td className="text-center px-2 py-2.5 stat-num text-th-secondary text-sm hidden sm:table-cell">{p.stats.wickets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

