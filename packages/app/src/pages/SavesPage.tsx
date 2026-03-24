import { useRef, useState } from "react";
import { type GameState, type SaveSlotInfo } from "../game-state";

interface Props {
  state: GameState;
  slots: SaveSlotInfo[];
  activeSlotId: string | null;
  onLoadSlot: (slotId: string) => void;
  onDeleteSlot: (slotId: string) => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onNewGame: () => void;
}

export function SavesPage({
  state,
  slots,
  activeSlotId,
  onLoadSlot,
  onDeleteSlot,
  onExport,
  onImportFile,
  onNewGame,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onImportFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "Unknown";
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-2xl font-bold text-th-primary">Saves & Data</h2>
          <p className="text-th-secondary mt-1">Manage your games, export, and import data</p>
        </div>
        <button
          onClick={onNewGame}
          className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          New Game
        </button>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div className={`mb-6 px-4 py-3 rounded-lg text-sm ${
          feedback.type === "success"
            ? "bg-green-900/30 border border-green-800 text-green-400"
            : "bg-red-900/30 border border-red-800 text-red-400"
        }`}>
          {feedback.message}
          <button onClick={() => setFeedback(null)} className="ml-3 text-th-muted hover:text-th-secondary">dismiss</button>
        </div>
      )}

      {/* ── Save Slots ────────────────────────────────────────────────── */}
      <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-8">
        <div className="px-4 py-3 bg-th-raised border-b border-th">
          <h3 className="text-sm font-semibold text-th-primary uppercase tracking-wider">Saved Games</h3>
        </div>
        {slots.length === 0 ? (
          <div className="px-4 py-8 text-center text-th-muted text-sm">
            No saved games yet. Start a game by selecting a team.
          </div>
        ) : (
          <div className="divide-y divide-th">
            {slots
              .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
              .map(slot => (
              <div
                key={slot.id}
                className={`px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3 ${
                  slot.id === activeSlotId ? "bg-orange-500/5" : ""
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-th-primary font-medium text-sm truncate">{slot.name}</span>
                    {slot.id === activeSlotId && (
                      <span className="text-orange-400 text-xs font-medium">(Active)</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-th-muted">
                    <span className={`uppercase font-medium ${slot.league === "wpl" ? "text-purple-400" : "text-blue-400"}`}>
                      {slot.league}
                    </span>
                    <span>Season {slot.season}</span>
                    <span>{formatDate(slot.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {slot.id !== activeSlotId && (
                    <button
                      onClick={() => onLoadSlot(slot.id)}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Load
                    </button>
                  )}
                  {confirmDelete === slot.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { onDeleteSlot(slot.id); setConfirmDelete(null); }}
                        className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(slot.id)}
                      className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs rounded-lg transition-colors border border-th"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Export ─────────────────────────────────────────────────────── */}
      <div className="bg-th-surface rounded-xl border border-th p-6 mb-8">
        <h3 className="text-sm font-semibold text-th-primary uppercase tracking-wider mb-4">Export</h3>
        <p className="text-th-muted text-sm mb-4">Download your current game as a JSON file.</p>
        <button
          onClick={onExport}
          disabled={!state.userTeamId}
          className="px-5 py-2.5 bg-orange-500 hover:bg-orange-400 disabled:bg-th-raised disabled:text-th-muted text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Export Save
        </button>
      </div>

      {/* ── Import ─────────────────────────────────────────────────────── */}
      <div className="bg-th-surface rounded-xl border border-th p-6">
        <h3 className="text-sm font-semibold text-th-primary uppercase tracking-wider mb-4">Import</h3>
        <p className="text-th-muted text-sm mb-4">
          Import a JSON file. Supports full saves, custom player ratings, and team rosters.
          The file type is auto-detected.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Import File
          </button>
        </div>

        <div className="mt-4 text-xs text-th-muted space-y-1">
          <p><span className="text-th-secondary">Full Save</span> — restores an entire game (creates a new save slot)</p>
          <p><span className="text-th-secondary">Player Ratings</span> — adds custom players to the auction pool</p>
          <p><span className="text-th-secondary">Team Roster</span> — replaces a team's roster with imported players</p>
        </div>
      </div>
    </div>
  );
}
