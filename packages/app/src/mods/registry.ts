/**
 * The app's single mod runtime: loads installed mods from IndexedDB at startup,
 * keeps the engine hooks and theme in sync with the enabled set, and persists
 * enable/strike changes (including the runtime disabling a misbehaving mod).
 *
 * Engine hooks run in-process behind the validator and time budget; the
 * simulation is not in a Worker today, so hooks run where it runs. Moving both
 * into a Worker is a follow-up (see docs/MODS-DESIGN.md).
 */

import { useSyncExternalStore } from "react";
import { setEngineHooks } from "@ipl-sim/engine";
import {
  ModRuntime, compileMod, hashBundle, parseBundle,
  type ModBundle, type ModStatus, type ModRecord, type ModTheme,
} from "@ipl-sim/mods";
import { deleteStoredMod, listStoredMods, putStoredMod, type StoredMod } from "./store";

export const modRuntime = new ModRuntime({
  onFault: f => console.warn(`[mods] ${f.modId} ${f.hook}: ${f.message} (${f.strikes} strike${f.strikes === 1 ? "" : "s"}${f.disabled ? ", disabled" : ""})`),
});

let started: Promise<void> | null = null;
let version = 0;
const versionListeners = new Set<() => void>();
const stored = new Map<string, StoredMod>();

function bump() {
  version++;
  for (const l of versionListeners) l();
}

/** Build the stylesheet for a merged theme. Exported for tests. */
export function themeToCss(theme: ModTheme): string {
  const block = (selector: string, vars?: Record<string, string>) =>
    vars && Object.keys(vars).length ? `${selector}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}` : "";
  const parts = [
    block(":root,.dark", theme.variables),
    block(":root:not(.dark)", theme.light),
    block(".dark", theme.dark),
    theme.fonts?.body ? `:root{--mod-font-body:${theme.fonts.body}}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function applyTheme() {
  if (typeof document === "undefined") return;
  let el = document.getElementById("mod-theme") as HTMLStyleElement | null;
  const css = themeToCss(modRuntime.theme());
  if (!css) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("style");
    el.id = "mod-theme";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function sync() {
  setEngineHooks(modRuntime.hasSimulationMods() ? modRuntime.engineHooks() : null);
  applyTheme();
}

// Persist whatever the runtime changed (enable/disable, strikes) and refresh engine hooks and theme.
modRuntime.subscribe(statuses => {
  for (const s of statuses) {
    const rec = stored.get(s.id);
    if (rec && (rec.enabled !== s.enabled || rec.strikes !== s.strikes || rec.disabledReason !== s.disabledReason)) {
      const next = { ...rec, enabled: s.enabled, strikes: s.strikes, disabledReason: s.disabledReason };
      stored.set(s.id, next);
      void putStoredMod(next);
    }
  }
  sync();
  bump();
});

function load(rec: StoredMod) {
  try {
    const bundle: ModBundle = { manifest: rec.manifest, source: rec.source };
    modRuntime.add({
      manifest: rec.manifest,
      definition: compileMod(bundle),
      hash: rec.hash,
      enabled: rec.enabled,
      strikes: rec.strikes,
      disabledReason: rec.disabledReason,
    });
  } catch (e) {
    // A stored mod that no longer loads (e.g. SDK change) is left installed but off, with the reason
    console.warn(`[mods] could not load ${rec.manifest.id}:`, e);
    const failed = { ...rec, enabled: false, disabledReason: `Failed to load: ${e instanceof Error ? e.message : String(e)}` };
    stored.set(rec.manifest.id, failed);
    void putStoredMod(failed);
  }
}

/** Load installed mods from IndexedDB. Safe to call repeatedly; resolves once startup loading is done. */
export function initMods(): Promise<void> {
  started ??= (async () => {
    try {
      for (const rec of await listStoredMods()) {
        stored.set(rec.manifest.id, rec);
        load(rec);
      }
    } catch (e) {
      console.warn("[mods] could not read installed mods:", e);
    }
    sync();
    bump();
  })();
  return started;
}

/** Validate, hash, store and activate a bundle. Throws ValidationError with a readable message on bad input. */
export async function installBundle(json: unknown): Promise<ModStatus> {
  await initMods();
  const bundle = parseBundle(json);
  const definition = compileMod(bundle); // throws before anything is stored
  const hash = await hashBundle(bundle);
  const rec: StoredMod = { manifest: bundle.manifest, source: bundle.source, hash, enabled: true, strikes: 0, installedAt: Date.now() };
  stored.set(bundle.manifest.id, rec);
  await putStoredMod(rec);
  modRuntime.add({ manifest: bundle.manifest, definition, hash });
  return modRuntime.list().find(s => s.id === bundle.manifest.id)!;
}

export async function removeMod(id: string): Promise<void> {
  stored.delete(id);
  await deleteStoredMod(id);
  modRuntime.remove(id);
}

export function setModEnabled(id: string, enabled: boolean): void {
  modRuntime.setEnabled(id, enabled);
}

/** Reactive list of installed mods for React components. */
export function useMods(): ModStatus[] {
  useSyncExternalStore(
    cb => { versionListeners.add(cb); return () => { versionListeners.delete(cb); }; },
    () => version,
  );
  return modRuntime.list();
}

/** Enabled mods as recorded in saves and compared between multiplayer peers. */
export function currentModRecords(): ModRecord[] {
  return modRuntime.records();
}

export function currentModFingerprint(): string[] {
  return modRuntime.fingerprint();
}
