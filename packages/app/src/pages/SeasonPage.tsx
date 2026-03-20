import { GameState } from "../game-state";
import { useNavigate } from "react-router-dom";

interface Props {
  state: GameState;
  onSimSeason: () => void;
}

export function SeasonPage({ state, onSimSeason }: Props) {
  const navigate = useNavigate();
  const standings = [...state.teams].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return b.nrr - a.nrr;
  });

  const userTeam = state.teams.find(t => t.id === state.userTeamId);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white">Season {state.seasonNumber}</h2>
          {userTeam && (
            <p className="text-gray-400 mt-1">Managing {userTeam.name}</p>
          )}
        </div>
        <button
          onClick={onSimSeason}
          className="px-6 py-3 bg-orange-500 hover:bg-orange-400 text-white font-semibold rounded-lg transition-colors"
        >
          Simulate Season
        </button>
      </div>

      {/* Standings */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
        <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Points Table</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="text-gray-500 text-xs uppercase">
              <th className="text-left px-4 py-2">#</th>
              <th className="text-left px-4 py-2">Team</th>
              <th className="text-center px-4 py-2">P</th>
              <th className="text-center px-4 py-2">W</th>
              <th className="text-center px-4 py-2">L</th>
              <th className="text-center px-4 py-2">Pts</th>
              <th className="text-center px-4 py-2">NRR</th>
              <th className="text-center px-4 py-2">PWR</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((team, i) => (
              <tr
                key={team.id}
                className={`border-t border-gray-800/50 cursor-pointer hover:bg-gray-800/30 ${
                  team.id === state.userTeamId ? "bg-orange-500/5" : ""
                } ${i < 4 ? "border-l-2" : ""}`}
                style={i < 4 ? { borderLeftColor: team.config.primaryColor } : {}}
                onClick={() => navigate(`/team/${team.id}`)}
              >
                <td className="px-4 py-3 text-gray-500 text-sm">{i + 1}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                      style={{ backgroundColor: team.config.primaryColor }}
                    >
                      {team.shortName.slice(0, 2)}
                    </div>
                    <span className="text-white text-sm font-medium">{team.shortName}</span>
                    {team.id === state.userTeamId && (
                      <span className="text-orange-400 text-xs">(You)</span>
                    )}
                  </div>
                </td>
                <td className="text-center px-4 py-3 text-gray-300 text-sm">{team.matchesPlayed}</td>
                <td className="text-center px-4 py-3 text-green-400 text-sm">{team.wins}</td>
                <td className="text-center px-4 py-3 text-red-400 text-sm">{team.losses}</td>
                <td className="text-center px-4 py-3 text-white font-semibold text-sm">{team.points}</td>
                <td className="text-center px-4 py-3 text-gray-400 text-sm">
                  {team.nrr >= 0 ? "+" : ""}{team.nrr.toFixed(3)}
                </td>
                <td className="text-center px-4 py-3 text-gray-500 text-sm">{team.powerRating}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Team roster summary */}
      {userTeam && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">Your Squad</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="text-gray-400">Players: <span className="text-white">{userTeam.roster.length}</span></div>
            <div className="text-gray-400">Overseas: <span className="text-white">{userTeam.internationalCount}</span></div>
            <div className="text-gray-400">Budget Used: <span className="text-white">{userTeam.totalSpent.toFixed(1)} Cr</span></div>
            <div className="text-gray-400">Power Rating: <span className="text-white">{userTeam.powerRating}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
