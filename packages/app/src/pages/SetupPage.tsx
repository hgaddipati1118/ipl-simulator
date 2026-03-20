import { Team } from "@ipl-sim/engine";

interface Props {
  teams: Team[];
  onSelectTeam: (teamId: string) => void;
}

export function SetupPage({ teams, onSelectTeam }: Props) {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-white mb-2">IPL Simulator</h1>
        <p className="text-gray-400 text-lg">Choose your franchise to begin</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {teams.map(team => (
          <button
            key={team.id}
            onClick={() => onSelectTeam(team.id)}
            className="group relative p-6 rounded-xl border-2 border-gray-800 hover:border-opacity-100 transition-all duration-200 hover:scale-105"
            style={{
              borderColor: team.config.primaryColor + "60",
              background: `linear-gradient(135deg, ${team.config.primaryColor}15, ${team.config.secondaryColor}10)`,
            }}
          >
            <div
              className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center text-white font-bold text-sm"
              style={{ backgroundColor: team.config.primaryColor }}
            >
              {team.shortName}
            </div>
            <div className="text-white text-sm font-medium text-center">{team.config.city}</div>
            <div className="text-gray-500 text-xs text-center mt-1">
              {team.roster.length} players
            </div>
            <div className="text-gray-600 text-xs text-center mt-1">
              PWR {team.powerRating}
            </div>
          </button>
        ))}
      </div>

      <div className="mt-12 text-center text-gray-600 text-sm">
        <p>Ball-by-ball T20 simulation with real IPL players</p>
        <p className="mt-1">Auction &bull; 70-match season &bull; Playoffs &bull; Multi-season progression</p>
      </div>
    </div>
  );
}
