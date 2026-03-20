import { useParams, useNavigate } from "react-router-dom";
import { Team } from "@ipl-sim/engine";

interface Props {
  teams: Team[];
}

export function TeamView({ teams }: Props) {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const team = teams.find(t => t.id === teamId);

  if (!team) return <div className="p-8 text-gray-400">Team not found</div>;

  const roster = [...team.roster].sort((a, b) => b.overall - a.overall);
  const xi = team.getPlayingXI();
  const xiIds = new Set(xi.map(p => p.id));

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white text-sm mb-4">&larr; Back</button>

      <div className="flex items-center gap-4 mb-6">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center text-white font-bold text-lg"
          style={{ backgroundColor: team.config.primaryColor }}
        >
          {team.shortName}
        </div>
        <div>
          <h2 className="text-2xl font-bold text-white">{team.name}</h2>
          <p className="text-gray-400 text-sm">
            {team.roster.length} players &bull; {team.internationalCount} overseas &bull;
            Budget: {team.totalSpent.toFixed(1)}/{team.salaryCap} Cr
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <Stat label="W-L" value={`${team.wins}-${team.losses}`} />
        <Stat label="Points" value={String(team.points)} />
        <Stat label="NRR" value={(team.nrr >= 0 ? "+" : "") + team.nrr.toFixed(3)} />
        <Stat label="Power" value={String(team.powerRating)} />
      </div>

      {/* Roster table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase bg-gray-800/50">
              <th className="text-left px-4 py-2">Player</th>
              <th className="text-center px-2 py-2">OVR</th>
              <th className="text-center px-2 py-2">BAT</th>
              <th className="text-center px-2 py-2">BWL</th>
              <th className="text-center px-2 py-2">Role</th>
              <th className="text-center px-2 py-2">Age</th>
              <th className="text-center px-2 py-2">M</th>
              <th className="text-center px-2 py-2">Runs</th>
              <th className="text-center px-2 py-2">Wkts</th>
              <th className="text-center px-2 py-2">Bid</th>
            </tr>
          </thead>
          <tbody>
            {roster.map(p => (
              <tr key={p.id} className={`border-t border-gray-800/50 ${xiIds.has(p.id) ? "" : "opacity-50"}`}>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{p.name}</span>
                    {p.isInternational && <span className="text-blue-400 text-[10px]">OS</span>}
                    {p.injured && <span className="text-red-400 text-[10px]">INJ</span>}
                    {xiIds.has(p.id) && <span className="text-green-400 text-[10px]">XI</span>}
                  </div>
                  <span className="text-gray-600 text-xs">{p.country}</span>
                </td>
                <td className="text-center px-2 py-2">
                  <span className={`font-bold ${ovrColor(p.overall)}`}>{p.overall}</span>
                </td>
                <td className="text-center px-2 py-2 text-gray-300">{p.battingOvr}</td>
                <td className="text-center px-2 py-2 text-gray-300">{p.bowlingOvr}</td>
                <td className="text-center px-2 py-2 text-gray-400 text-xs">{roleLabel(p.role)}</td>
                <td className="text-center px-2 py-2 text-gray-400">{p.age}</td>
                <td className="text-center px-2 py-2 text-gray-300">{p.stats.matches}</td>
                <td className="text-center px-2 py-2 text-gray-300">{p.stats.runs}</td>
                <td className="text-center px-2 py-2 text-gray-300">{p.stats.wickets}</td>
                <td className="text-center px-2 py-2 text-gray-500">{p.bid.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-3 text-center">
      <div className="text-gray-500 text-xs uppercase">{label}</div>
      <div className="text-white font-semibold text-lg">{value}</div>
    </div>
  );
}

function ovrColor(ovr: number): string {
  if (ovr >= 85) return "text-green-400";
  if (ovr >= 70) return "text-blue-400";
  if (ovr >= 55) return "text-yellow-400";
  return "text-gray-400";
}

function roleLabel(role: string): string {
  switch (role) {
    case "batsman": return "BAT";
    case "bowler": return "BWL";
    case "all-rounder": return "AR";
    case "wicket-keeper": return "WK";
    default: return role;
  }
}
