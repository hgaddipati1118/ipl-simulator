import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { type Team } from "@ipl-sim/engine";
import { TeamBadge } from "../components/TeamBadge";

interface Props {
  teams: Team[];
}

interface RankedTeam {
  team: Team;
  powerRating: number;
  healthyPowerRating: number;
  winPct: number;
}

function calcHealthyPowerRating(team: Team): number {
  const healthy = team.roster.filter(p => !p.injured);
  if (healthy.length === 0) return 0;
  const maxOverseas = 4;
  const sorted = [...healthy].sort((a, b) => b.overall - a.overall);
  const xi: typeof sorted = [];
  let intCount = 0;
  for (const p of sorted) {
    if (xi.length >= 11) break;
    if (p.isInternational) {
      if (intCount >= maxOverseas) continue;
      intCount++;
    }
    xi.push(p);
  }
  if (xi.length === 0) return 0;
  return Math.round(xi.reduce((s, p) => s + p.overall, 0) / xi.length);
}

export function PowerRankingsPage({ teams }: Props) {
  const navigate = useNavigate();
  const [showHealthy, setShowHealthy] = useState(false);

  const ranked = useMemo<RankedTeam[]>(() => {
    const list = teams.map(team => ({
      team,
      powerRating: team.powerRating,
      healthyPowerRating: calcHealthyPowerRating(team),
      winPct: team.matchesPlayed > 0 ? (team.wins / team.matchesPlayed) * 100 : 0,
    }));
    list.sort((a, b) => {
      const ratingA = showHealthy ? a.healthyPowerRating : a.powerRating;
      const ratingB = showHealthy ? b.healthyPowerRating : b.powerRating;
      return ratingB - ratingA;
    });
    return list;
  }, [teams, showHealthy]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
            Power Rankings
          </h2>
          <p className="text-th-muted text-sm mt-1 font-display">
            Teams ranked by average playing XI overall rating
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            onClick={() => setShowHealthy(prev => !prev)}
            className={`w-full rounded-xl px-4 py-2 text-sm font-display font-medium transition-colors sm:w-auto ${
              showHealthy
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                : "bg-th-raised text-th-secondary border border-th hover:bg-th-overlay"
            }`}
          >
            {showHealthy ? "Healthy Only" : "Show Healthy"}
          </button>
          <button
            onClick={() => navigate("/season")}
            className="w-full rounded-xl border border-th bg-th-raised px-4 py-2 text-sm font-display font-medium text-th-secondary transition-colors hover:bg-th-overlay sm:w-auto"
          >
            Back
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-th overflow-hidden bg-th-surface">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px]">
            <thead>
              <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider">
                <th scope="col" className="text-left px-3 sm:px-4 py-2.5 w-10">#</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2.5">Team</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">
                  {showHealthy ? "Healthy PWR" : "Power"}
                </th>
                {showHealthy && (
                  <th scope="col" className="text-center px-2 sm:px-3 py-2.5">Full PWR</th>
                )}
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">W-L</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">Win %</th>
                <th scope="col" className="text-center px-2 sm:px-3 py-2.5">NRR</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((entry, i) => {
                const { team } = entry;
                const displayRating = showHealthy ? entry.healthyPowerRating : entry.powerRating;
                const ratingDiff = showHealthy ? entry.healthyPowerRating - entry.powerRating : 0;

                return (
                  <tr
                    key={team.id}
                    className="border-t border-th cursor-pointer transition-colors hover:bg-th-hover"
                    onClick={() => navigate(`/team/${team.id}`)}
                  >
                    <td className="px-3 sm:px-4 py-3">
                      <span className="text-sm font-mono text-th-muted">{i + 1}</span>
                    </td>
                    <td className="px-3 sm:px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <TeamBadge teamId={team.id} shortName={team.shortName} primaryColor={team.config.primaryColor} size="sm" />
                        <span className="text-th-primary text-sm font-display font-medium">{team.name}</span>
                      </div>
                    </td>
                    <td className="text-center px-2 sm:px-3 py-3">
                      <span className="stat-num text-th-primary font-bold text-sm">{displayRating}</span>
                      {showHealthy && ratingDiff !== 0 && (
                        <span className={`text-[10px] ml-1 ${ratingDiff < 0 ? "text-red-400" : "text-emerald-400"}`}>
                          {ratingDiff > 0 ? "+" : ""}{ratingDiff}
                        </span>
                      )}
                    </td>
                    {showHealthy && (
                      <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-muted text-sm">
                        {entry.powerRating}
                      </td>
                    )}
                    <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-secondary text-sm">
                      {team.wins}-{team.losses}
                    </td>
                    <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-secondary text-sm">
                      {entry.winPct.toFixed(1)}%
                    </td>
                    <td className="text-center px-2 sm:px-3 py-3 stat-num text-th-muted text-sm">
                      {team.nrr >= 0 ? "+" : ""}{team.nrr.toFixed(3)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
