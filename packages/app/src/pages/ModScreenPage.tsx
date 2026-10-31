import { Link, useParams } from "react-router-dom";
import type { GameState } from "../game-state";
import { ModFrame } from "../components/ModFrame";
import { modRuntime, useMods } from "../mods/registry";

/** /mods/screen/:modId/:screenId — a full page supplied by a mod, shown in a sandboxed iframe. */
export function ModScreenPage({ state }: { state: GameState | null }) {
  const { modId, screenId } = useParams();
  useMods();
  const screen = modRuntime.screens().find(s => s.modId === modId && s.id === screenId);

  if (!screen) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-2xl font-display font-bold text-th-primary mb-2">Screen not found</h1>
        <p className="text-th-muted mb-6">That mod screen is not installed or the mod is disabled.</p>
        <Link to="/mods" className="text-orange-400 hover:text-orange-300 underline underline-offset-2">Manage mods</Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-baseline gap-3 mb-3">
        <h1 className="text-2xl font-display font-bold text-th-primary">{screen.title}</h1>
        <span className="text-xs text-th-muted">from {screen.modName}</span>
      </div>
      <ModFrame title={screen.title} html={screen.html} state={state} />
    </div>
  );
}
