import { GameState } from "../game-state";

interface Props {
  state: GameState;
  onNextSeason: () => void;
}

export function ResultsPage({ state, onNextSeason }: Props) {
  const { seasonResult, teams, history } = state;
  if (!seasonResult) return <div className="p-8 text-gray-400">No results yet</div>;

  const champion = teams.find(t => t.id === seasonResult.champion);
  const allPlayers = teams.flatMap(t => t.roster);
  const orangePlayer = allPlayers.find(p => p.id === seasonResult.orangeCap.playerId);
  const purplePlayer = allPlayers.find(p => p.id === seasonResult.purpleCap.playerId);

  // Top run scorers
  const topScorers = [...allPlayers]
    .sort((a, b) => b.stats.runs - a.stats.runs)
    .slice(0, 10);

  // Top wicket takers
  const topWicketTakers = [...allPlayers]
    .sort((a, b) => b.stats.wickets - a.stats.wickets)
    .slice(0, 10);

  // Standings
  const standings = seasonResult.standings;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Champion banner */}
      <div
        className="rounded-xl p-8 mb-8 text-center border-2"
        style={{
          borderColor: champion?.config.primaryColor,
          background: `linear-gradient(135deg, ${champion?.config.primaryColor}20, ${champion?.config.secondaryColor}10)`,
        }}
      >
        <p className="text-gray-400 text-sm uppercase tracking-wider mb-2">Season {state.seasonNumber} Champions</p>
        <h2 className="text-3xl font-bold text-white mb-4">{champion?.name}</h2>
        <div className="flex justify-center gap-8 text-sm">
          <div>
            <span className="text-orange-400 font-semibold">Orange Cap</span>
            <p className="text-white">{orangePlayer?.name} ({seasonResult.orangeCap.runs} runs)</p>
          </div>
          <div>
            <span className="text-purple-400 font-semibold">Purple Cap</span>
            <p className="text-white">{purplePlayer?.name} ({seasonResult.purpleCap.wickets} wkts)</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Top scorers */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 bg-orange-500/10 border-b border-gray-800">
            <h3 className="text-sm font-semibold text-orange-400 uppercase tracking-wider">Top Run Scorers</h3>
          </div>
          <div className="divide-y divide-gray-800/50">
            {topScorers.map((p, i) => (
              <div key={p.id} className="px-4 py-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-gray-600 text-xs w-4">{i + 1}</span>
                  <div>
                    <span className="text-white text-sm">{p.name}</span>
                    <span className="text-gray-600 text-xs ml-2">{teams.find(t => t.roster.includes(p))?.shortName}</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-white font-semibold text-sm">{p.stats.runs}</span>
                  <span className="text-gray-500 text-xs ml-2">SR {p.strikeRate.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top wicket takers */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 bg-purple-500/10 border-b border-gray-800">
            <h3 className="text-sm font-semibold text-purple-400 uppercase tracking-wider">Top Wicket Takers</h3>
          </div>
          <div className="divide-y divide-gray-800/50">
            {topWicketTakers.map((p, i) => (
              <div key={p.id} className="px-4 py-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-gray-600 text-xs w-4">{i + 1}</span>
                  <div>
                    <span className="text-white text-sm">{p.name}</span>
                    <span className="text-gray-600 text-xs ml-2">{teams.find(t => t.roster.includes(p))?.shortName}</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-white font-semibold text-sm">{p.stats.wickets}</span>
                  <span className="text-gray-500 text-xs ml-2">Econ {p.economyRate.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Final standings */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
        <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Final Standings</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase">
              <th className="text-left px-4 py-2">#</th>
              <th className="text-left px-4 py-2">Team</th>
              <th className="text-center px-4 py-2">P</th>
              <th className="text-center px-4 py-2">W</th>
              <th className="text-center px-4 py-2">L</th>
              <th className="text-center px-4 py-2">Pts</th>
              <th className="text-center px-4 py-2">NRR</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((s, i) => {
              const team = teams.find(t => t.id === s.teamId)!;
              return (
                <tr key={s.teamId} className={`border-t border-gray-800/50 ${i < 4 ? "bg-green-500/5" : ""}`}>
                  <td className="px-4 py-2 text-gray-500">{i + 1}</td>
                  <td className="px-4 py-2 text-white font-medium">{team.shortName}</td>
                  <td className="text-center px-4 py-2 text-gray-300">{s.played}</td>
                  <td className="text-center px-4 py-2 text-green-400">{s.wins}</td>
                  <td className="text-center px-4 py-2 text-red-400">{s.losses}</td>
                  <td className="text-center px-4 py-2 text-white font-semibold">{s.points}</td>
                  <td className="text-center px-4 py-2 text-gray-400">{s.nrr >= 0 ? "+" : ""}{s.nrr.toFixed(3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Season history */}
      {history.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 mb-8">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">History</h3>
          <div className="space-y-2">
            {history.map(h => (
              <div key={h.seasonNumber} className="flex items-center gap-4 text-sm">
                <span className="text-gray-500">S{h.seasonNumber}</span>
                <span className="text-white font-medium">{h.champion}</span>
                <span className="text-orange-400">{h.orangeCap.name} ({h.orangeCap.runs}r)</span>
                <span className="text-purple-400">{h.purpleCap.name} ({h.purpleCap.wickets}w)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-center">
        <button
          onClick={onNextSeason}
          className="px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors"
        >
          Next Season
        </button>
      </div>
    </div>
  );
}
