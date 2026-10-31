import { type ModPanel } from "@ipl-sim/mods";
import type { GameState } from "../game-state";
import { modRuntime, useMods } from "../mods/registry";
import { ModFrame } from "./ModFrame";

/** Renders every enabled mod panel registered for a slot of the host screen. Renders nothing when there are none. */
export function ModPanels({ slot, state }: { slot: ModPanel["slot"]; state: GameState | null }) {
  useMods(); // re-render when mods are added, removed or toggled
  const panels = modRuntime.panels(slot);
  if (!panels.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {panels.map(p => (
        <section key={`${p.modId}/${p.id}`} className="rounded-xl border border-th bg-th-surface overflow-hidden">
          <h3 className="text-xs font-mono uppercase tracking-wide text-th-muted px-3 pt-2">{p.title} <span className="text-th-faint">· {p.modName}</span></h3>
          <ModFrame title={`${p.modName}: ${p.title}`} html={p.html} state={state} height={p.height ?? 160} />
        </section>
      ))}
    </div>
  );
}
