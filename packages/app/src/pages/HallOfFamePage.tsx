import { type GameState, type HallOfFameEntry } from "../game-state";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { ovrColorClass } from "../ui-utils";

interface Props {
  state: GameState;
}

function LegendCard({ entry }: { entry: HallOfFameEntry }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-4 sm:flex-row sm:items-start">
      <PlayerAvatar name={entry.name} imageUrl={entry.imageUrl} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="font-display font-bold text-th-primary truncate">{entry.name}</span>
          <span className={`text-xs font-bold ${ovrColorClass(entry.peakOverall)}`}>{entry.peakOverall} OVR</span>
        </div>
        <div className="text-xs text-th-muted font-display">
          {entry.country} • Retired age {entry.retiredAge} (Season {entry.retiredSeason})
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-th-secondary">
          <span>{entry.careerMatches} matches</span>
          {entry.careerRuns > 0 && <span>{entry.careerRuns} runs</span>}
          {entry.careerWickets > 0 && <span>{entry.careerWickets} wkt</span>}
        </div>
      </div>
    </div>
  );
}

export function HallOfFamePage({ state }: Props) {
  const entries = (state.hallOfFame ?? []).sort((a, b) => b.peakOverall - a.peakOverall);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <h1 className="text-2xl font-display font-bold text-th-primary mb-1">Hall of Fame</h1>
      <p className="text-th-muted text-sm mb-6">Legends who have retired from the IPL</p>

      {entries.length === 0 ? (
        <div className="text-center py-12 text-th-muted">
          <p className="text-lg font-display">No legends have retired yet</p>
          <p className="text-sm mt-2">Play through multiple seasons to see players enter the Hall of Fame</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map(entry => (
            <LegendCard key={entry.playerId} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
