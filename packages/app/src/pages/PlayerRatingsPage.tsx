import { useState } from "react";
import { Team, Player } from "@ipl-sim/engine";

interface Props {
  teams: Team[];
}

type SortKey = "overall" | "battingOvr" | "bowlingOvr" | "age" | "runs" | "wickets" | "name";

export function PlayerRatingsPage({ teams }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>("overall");
  const [filterRole, setFilterRole] = useState<string>("all");
  const [filterTeam, setFilterTeam] = useState<string>("all");
  const [search, setSearch] = useState("");

  let allPlayers = teams.flatMap(t => t.roster.map(p => ({ player: p, team: t })));

  // Filter
  if (filterRole !== "all") {
    allPlayers = allPlayers.filter(({ player }) => player.role === filterRole);
  }
  if (filterTeam !== "all") {
    allPlayers = allPlayers.filter(({ team }) => team.id === filterTeam);
  }
  if (search) {
    const q = search.toLowerCase();
    allPlayers = allPlayers.filter(({ player }) => player.name.toLowerCase().includes(q));
  }

  // Sort
  allPlayers.sort((a, b) => {
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

  const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
    <th
      className={`text-center px-2 py-2 cursor-pointer hover:text-white ${sortBy === field ? "text-orange-400" : ""}`}
      onClick={() => setSortBy(field)}
    >
      {label}
    </th>
  );

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h2 className="text-2xl font-bold text-white mb-6">Player Ratings</h2>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 w-48"
        />
        <select
          value={filterRole}
          onChange={e => setFilterRole(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white"
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
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white"
        >
          <option value="all">All Teams</option>
          {teams.map(t => (
            <option key={t.id} value={t.id}>{t.shortName}</option>
          ))}
        </select>
        <span className="text-gray-500 text-sm self-center">{allPlayers.length} players</span>
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs uppercase bg-gray-800/50">
                <th className="text-left px-4 py-2">#</th>
                <SortHeader label="Player" field="name" />
                <th className="text-center px-2 py-2">Team</th>
                <SortHeader label="OVR" field="overall" />
                <SortHeader label="BAT" field="battingOvr" />
                <SortHeader label="BWL" field="bowlingOvr" />
                <th className="text-center px-2 py-2">IQ</th>
                <th className="text-center px-2 py-2">TIM</th>
                <th className="text-center px-2 py-2">PWR</th>
                <th className="text-center px-2 py-2">RUN</th>
                <th className="text-center px-2 py-2">WKT</th>
                <th className="text-center px-2 py-2">ECN</th>
                <th className="text-center px-2 py-2">ACC</th>
                <th className="text-center px-2 py-2">CLT</th>
                <SortHeader label="Age" field="age" />
                <SortHeader label="Runs" field="runs" />
                <SortHeader label="Wkts" field="wickets" />
              </tr>
            </thead>
            <tbody>
              {allPlayers.slice(0, 100).map(({ player: p, team }, i) => (
                <tr key={p.id} className="border-t border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-2 text-gray-600 text-xs">{i + 1}</td>
                  <td className="text-left px-2 py-2">
                    <span className="text-white">{p.name}</span>
                    {p.isInternational && <span className="text-blue-400 text-[10px] ml-1">OS</span>}
                  </td>
                  <td className="text-center px-2 py-2">
                    <span className="text-xs" style={{ color: team.config.primaryColor }}>
                      {team.shortName}
                    </span>
                  </td>
                  <td className="text-center px-2 py-2 font-bold text-white">{p.overall}</td>
                  <td className="text-center px-2 py-2 text-orange-300">{p.battingOvr}</td>
                  <td className="text-center px-2 py-2 text-purple-300">{p.bowlingOvr}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.battingIQ}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.timing}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.power}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.running}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.wicketTaking}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.economy}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.accuracy}</td>
                  <td className="text-center px-2 py-2 text-gray-400">{p.ratings.clutch}</td>
                  <td className="text-center px-2 py-2 text-gray-500">{p.age}</td>
                  <td className="text-center px-2 py-2 text-gray-300">{p.stats.runs}</td>
                  <td className="text-center px-2 py-2 text-gray-300">{p.stats.wickets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
