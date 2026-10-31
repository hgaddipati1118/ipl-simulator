import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SIM_HOOKS, ValidationError, type ModStatus } from "@ipl-sim/mods";
import { EXAMPLE_MODS } from "../mods/examples";
import { installBundle, modRuntime, removeMod, setModEnabled, useMods } from "../mods/registry";

function HookBadges({ hooks }: { hooks: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {hooks.map(h => (
        <span
          key={h}
          className={`text-[11px] font-mono rounded-full px-2 py-0.5 border ${
            (SIM_HOOKS as readonly string[]).includes(h)
              ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
              : "text-th-muted bg-th-raised border-th"
          }`}
          title={(SIM_HOOKS as readonly string[]).includes(h) ? "Affects simulation results" : "Presentation only"}
        >{h}</span>
      ))}
    </div>
  );
}

function ModRow({ mod, screens }: { mod: ModStatus; screens: { id: string; title: string }[] }) {
  const faulty = mod.strikes > 0 || mod.disabledReason;
  return (
    <li className="rounded-xl border border-th bg-th-surface p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="font-display font-semibold text-th-primary">{mod.name}</h2>
            <span className="text-xs font-mono text-th-muted">v{mod.version}</span>
            <span className="text-[11px] font-mono text-th-faint" title={mod.hash}>{mod.hash.slice(0, 8)}</span>
          </div>
          <HookBadges hooks={mod.hooks} />
          {faulty && (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {mod.disabledReason ?? `${mod.strikes} of 3 failures. Last: ${mod.lastError}`}
            </p>
          )}
          {mod.enabled && screens.length > 0 && (
            <p className="mt-2 text-xs text-th-secondary">
              Screens: {screens.map((s, i) => (
                <span key={s.id}>{i > 0 && ", "}<Link className="text-orange-400 hover:text-orange-300 underline underline-offset-2" to={`/mods/screen/${mod.id}/${s.id}`}>{s.title}</Link></span>
              ))}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setModEnabled(mod.id, !mod.enabled)}
            aria-pressed={mod.enabled}
            className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
              mod.enabled
                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20"
                : "text-th-muted border-th hover:text-th-primary hover:bg-th-hover"
            }`}
          >{mod.enabled ? "Enabled" : "Disabled"}</button>
          <button
            onClick={() => { if (confirm(`Remove "${mod.name}"? Changes it already made to saves stay.`)) void removeMod(mod.id); }}
            className="text-xs px-3 py-1.5 rounded-md text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >Remove</button>
        </div>
      </div>
    </li>
  );
}

export function ModsPage() {
  const mods = useMods();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const install = async (json: unknown, label: string) => {
    setError(null);
    setNotice(null);
    try {
      const status = await installBundle(json);
      setNotice(`Installed ${status.name} v${status.version} from ${label}.`);
    } catch (e) {
      setError(e instanceof ValidationError ? e.message : `Could not install ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setError(`${file.name} is not valid JSON. A mod bundle is { "manifest": {...}, "source": "..." }.`);
      return;
    }
    await install(json, file.name);
    if (fileInput.current) fileInput.current.value = "";
  };

  const installedIds = new Set(mods.map(m => m.id));
  const screensOf = (id: string) => modRuntime.screens().filter(s => s.modId === id);

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-8">
      <h1 className="text-3xl font-display font-extrabold text-th-primary mb-1">Mods</h1>
      <p className="text-th-muted text-sm mb-6">
        Mods change data, rules, the match engine and the look of your game. They run in install order. A mod that
        crashes, returns bad numbers or is too slow is skipped, and disabled after three failures.
      </p>

      <div className="rounded-xl border border-th bg-th-surface p-4 mb-6">
        <h2 className="font-display font-semibold text-th-primary mb-2">Install from file</h2>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          aria-label="Mod bundle file"
          onChange={e => void onFile(e.target.files?.[0])}
          className="text-sm text-th-secondary file:mr-3 file:rounded-md file:border-0 file:bg-orange-500/90 file:px-3 file:py-1.5 file:text-white hover:file:bg-orange-500"
        />
        <p className="text-xs text-th-muted mt-2">A JSON bundle: <code className="font-mono">{`{ "manifest": { ... }, "source": "export default defineMod({ ... })" }`}</code></p>
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        {notice && <p role="status" className="mt-3 text-sm text-emerald-400">{notice}</p>}
      </div>

      <h2 className="font-display font-semibold text-th-primary mb-2">Installed</h2>
      {mods.length === 0 ? (
        <p className="text-sm text-th-muted mb-6">No mods installed. The game runs exactly as shipped.</p>
      ) : (
        <ul className="flex flex-col gap-3 mb-6">
          {mods.map(m => <ModRow key={m.id} mod={m} screens={screensOf(m.id)} />)}
        </ul>
      )}
      {modRuntime.hasSimulationMods() && (
        <p className="text-xs text-amber-400 mb-6">
          Mods marked in amber change simulation results. In multiplayer every player needs the same ones, in the same order.
        </p>
      )}

      <h2 className="font-display font-semibold text-th-primary mb-2">Examples</h2>
      <ul className="flex flex-col gap-3">
        {EXAMPLE_MODS.map(b => (
          <li key={b.manifest.id} className="rounded-xl border border-th bg-th-surface p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-display font-semibold text-th-primary">{b.manifest.name}</div>
              <p className="text-sm text-th-secondary">{b.manifest.description}</p>
              <HookBadges hooks={b.manifest.hooks} />
            </div>
            <button
              disabled={installedIds.has(b.manifest.id)}
              onClick={() => void install(b, `the ${b.manifest.name} example`)}
              className="text-xs px-3 py-1.5 rounded-md bg-orange-500/90 text-white hover:bg-orange-500 disabled:bg-th-raised disabled:text-th-muted transition-colors shrink-0"
            >{installedIds.has(b.manifest.id) ? "Installed" : "Install"}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
