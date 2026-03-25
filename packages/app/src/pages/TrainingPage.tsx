import { Link } from "react-router-dom";
import { getTrainingCampFatigue, type TrainingFocus, type TrainingIntensity } from "@ipl-sim/engine";
import { GameState } from "../game-state";
import { PlayerLink } from "../components/PlayerLink";
import { roleLabel } from "../ui-utils";

interface Props {
  state: GameState;
  onSetPlayerFocus: (playerId: string, focus: TrainingFocus) => void;
  onSetIntensity: (teamId: string, intensity: TrainingIntensity) => void;
}

const FOCUS_OPTIONS: { value: TrainingFocus; label: string; summary: string }[] = [
  { value: "balanced", label: "Balanced", summary: "Even development across the profile." },
  { value: "batting", label: "Batting", summary: "Batting IQ and timing are the priority." },
  { value: "power", label: "Power", summary: "Boundary hitting gets the extra work." },
  { value: "bowling", label: "Bowling", summary: "Wicket-taking tools get the main lift." },
  { value: "control", label: "Control", summary: "Economy and accuracy are the focus." },
  { value: "fitness", label: "Fitness", summary: "Running and freshness are protected." },
  { value: "clutch", label: "Clutch", summary: "Pressure handling gets extra reps." },
];

const INTENSITY_OPTIONS: { value: TrainingIntensity; label: string; detail: string }[] = [
  { value: "light", label: "Light", detail: "Better freshness, lower upside." },
  { value: "balanced", label: "Balanced", detail: "Neutral growth and recovery." },
  { value: "hard", label: "Hard", detail: "More upside, more camp fatigue." },
];

export function TrainingPage({ state, onSetPlayerFocus, onSetIntensity }: Props) {
  const userTeam = state.teams.find(team => team.id === state.userTeamId) ?? null;

  if (!userTeam) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="rounded-2xl border border-th bg-th-surface p-5 text-th-secondary">
          No team selected.
        </div>
      </div>
    );
  }

  const teamReport = state.trainingReport
    .filter(entry => entry.teamId === userTeam.id)
    .sort((a, b) => b.overallChange - a.overallChange);
  const risers = teamReport.filter(entry => entry.overallChange > 0).slice(0, 4);
  const stalls = [...teamReport].sort((a, b) => a.overallChange - b.overallChange).slice(0, 4);
  const projectedAverageReadiness = Math.round(
    userTeam.roster.reduce(
      (sum, player) => sum + projectedReadiness(player.trainingFocus, userTeam.trainingIntensity),
      0,
    ) / Math.max(1, userTeam.roster.length),
  );
  const sortedRoster = [...userTeam.roster].sort(
    (a, b) => b.selectionScore - a.selectionScore || b.overall - a.overall,
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">Training Ground</h2>
          <p className="text-th-muted mt-1">
            Set squad focus, control preseason load, and review who actually moved from last year.
          </p>
        </div>
        <Link
          to="/season"
          className="inline-flex items-center justify-center rounded-xl border border-th bg-th-surface px-4 py-2 text-sm font-display font-medium text-th-secondary hover:text-th-primary hover:bg-th-hover transition-colors"
        >
          Back to Season
        </Link>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr,0.8fr] gap-5 mb-6">
        <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider">Camp Intensity</h3>
              <div className="text-th-faint text-xs mt-1">
                This controls how much freshness the squad carries into the next season.
              </div>
            </div>
            <div className={`text-xs font-display font-semibold ${readinessTone(projectedAverageReadiness)}`}>
              Projected Ready {projectedAverageReadiness}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {INTENSITY_OPTIONS.map(option => {
              const active = userTeam.trainingIntensity === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => onSetIntensity(userTeam.id, option.value)}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    active
                      ? "border-orange-500/40 bg-orange-500/10"
                      : "border-th bg-th-raised hover:bg-th-hover"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-th-primary font-display font-semibold">{option.label}</span>
                    {active && <span className="text-orange-300 text-[10px] uppercase tracking-wider">Active</span>}
                  </div>
                  <div className="text-th-muted text-xs mt-2 leading-5">{option.detail}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5">
          <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider mb-3">Offseason Review</h3>
          {teamReport.length === 0 ? (
            <div className="rounded-xl border border-th bg-th-raised p-4 text-th-faint text-sm">
              No development review yet. The first report appears after you roll into the next season.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <MetricCard label="Risers" value={String(teamReport.filter(entry => entry.overallChange > 0).length)} />
                <MetricCard label="Flat" value={String(teamReport.filter(entry => entry.overallChange === 0).length)} />
                <MetricCard label="Down" value={String(teamReport.filter(entry => entry.overallChange < 0).length)} />
              </div>

              <div className="space-y-3">
                <ReportList title="Moved Up" tone="good" entries={risers} empty="No clear risers yet." />
                <ReportList title="Stalled / Slipped" tone="warn" entries={stalls} empty="No soft spots flagged." />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-th bg-th-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-th flex items-center justify-between">
          <div>
            <h3 className="text-th-primary text-sm font-semibold uppercase tracking-wider">Squad Plans</h3>
            <div className="text-th-faint text-xs mt-1">
              Focus changes apply at season rollover. The readiness column is your projected camp freshness.
            </div>
          </div>
          <div className="text-th-muted text-xs">{userTeam.name}</div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-th-faint text-[11px] uppercase tracking-wider border-b border-th">
                <th className="text-left px-4 py-3">Player</th>
                <th className="text-left px-3 py-3">Role</th>
                <th className="text-center px-3 py-3">OVR</th>
                <th className="text-left px-3 py-3">Focus</th>
                <th className="text-left px-3 py-3">Expected Lift</th>
                <th className="text-center px-3 py-3">Camp Ready</th>
              </tr>
            </thead>
            <tbody>
              {sortedRoster.map(player => {
                const focusMeta = FOCUS_OPTIONS.find(option => option.value === player.trainingFocus) ?? FOCUS_OPTIONS[0];
                const campReadiness = projectedReadiness(player.trainingFocus, userTeam.trainingIntensity);
                return (
                  <tr key={player.id} className="border-t border-th hover:bg-th-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <PlayerLink playerId={player.id} className="text-th-primary font-display font-medium">
                          {player.name}
                        </PlayerLink>
                        <span className="text-th-faint text-xs">
                          Current ready {player.readiness} • Form {Math.round(player.form)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-th-secondary">{roleLabel(player.role)}</td>
                    <td className="px-3 py-3 text-center stat-num text-th-primary">{player.overall}</td>
                    <td className="px-3 py-3">
                      <label className="sr-only" htmlFor={`training-${player.id}`}>Training focus for {player.name}</label>
                      <select
                        id={`training-${player.id}`}
                        value={player.trainingFocus}
                        onChange={(event) => onSetPlayerFocus(player.id, event.target.value as TrainingFocus)}
                        className="w-full rounded-lg border border-th bg-th-raised px-3 py-2 text-sm text-th-primary focus:outline-none focus:ring-2 focus:ring-orange-500/30"
                      >
                        {FOCUS_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-3 text-th-muted text-xs leading-5">{focusMeta.summary}</td>
                    <td className={`px-3 py-3 text-center stat-num ${readinessTone(campReadiness)}`}>{campReadiness}</td>
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

function projectedReadiness(focus: TrainingFocus, intensity: TrainingIntensity): number {
  return Math.max(0, 100 - getTrainingCampFatigue(focus, intensity));
}

function readinessTone(readiness: number): string {
  if (readiness >= 95) return "text-cyan-300";
  if (readiness >= 90) return "text-green-300";
  if (readiness >= 85) return "text-yellow-300";
  return "text-orange-300";
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-th bg-th-raised px-3 py-2.5">
      <div className="text-th-faint text-[10px] uppercase tracking-wider">{label}</div>
      <div className="text-th-primary font-display font-semibold text-lg mt-1">{value}</div>
    </div>
  );
}

function ReportList({
  title,
  tone,
  entries,
  empty,
}: {
  title: string;
  tone: "good" | "warn";
  entries: GameState["trainingReport"];
  empty: string;
}) {
  const titleClass = tone === "good" ? "text-green-300" : "text-orange-300";
  const deltaClass = tone === "good" ? "text-green-300" : "text-red-300";

  return (
    <div>
      <div className={`text-[10px] uppercase tracking-wider mb-2 ${titleClass}`}>{title}</div>
      {entries.length === 0 ? (
        <div className="text-th-faint text-sm">{empty}</div>
      ) : (
        <div className="space-y-2">
          {entries.map(entry => (
            <div key={entry.playerId} className="flex items-center justify-between gap-3 text-sm">
              <PlayerLink playerId={entry.playerId} className="text-th-primary">
                {entry.playerName}
              </PlayerLink>
              <span className={`stat-num ${deltaClass}`}>
                {entry.overallChange > 0 ? "+" : ""}{entry.overallChange}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
