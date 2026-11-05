import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SIM_HOOKS, ValidationError, type ModBundle, type ModStatus } from "@ipl-sim/mods";
import {
  createModFromPrompt, fetchSharedMod, ModsApiError, modsApiEnabled, setConsent, shareMod, type CreateResult,
} from "../mods/api";
import { EXAMPLE_MODS } from "../mods/examples";
import { installBundle, modRuntime, removeMod, setModEnabled, storedBundle, useMods } from "../mods/registry";
import type { VerifyResult } from "../mods/verify";

const CONSENT_KEY = "ipl-sim-mods-consent";

/** What the player agreed the mods server may keep: their own mods (needed to share) and, separately, use in the daily sweep */
function useConsent(): [{ store: boolean; sweep: boolean }, (next: { store: boolean; sweep: boolean }) => void] {
  const [consent, setLocal] = useState<{ store: boolean; sweep: boolean }>(() => {
    try {
      return { store: false, sweep: false, ...JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "{}") };
    } catch {
      return { store: false, sweep: false };
    }
  });
  const update = (next: { store: boolean; sweep: boolean }) => {
    const value = { store: next.store, sweep: next.store && next.sweep };
    setLocal(value);
    localStorage.setItem(CONSENT_KEY, JSON.stringify(value));
    void setConsent(value.store, value.sweep).catch(() => {});
  };
  return [consent, update];
}

function errorText(e: unknown): string {
  if (e instanceof ModsApiError || e instanceof ValidationError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

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

function ShareButton({ id, canShare }: { id: string; canShare: boolean }) {
  const [state, setState] = useState<{ busy?: boolean; link?: string; error?: string }>({});
  if (!modsApiEnabled) return null;
  const share = async () => {
    const bundle = storedBundle(id);
    if (!bundle) return;
    setState({ busy: true });
    try {
      const { url } = await shareMod(bundle);
      await navigator.clipboard?.writeText(url).catch(() => {});
      setState({ link: url });
    } catch (e) {
      setState({ error: errorText(e) });
    }
  };
  return (
    <div className="text-right">
      <button
        onClick={() => void share()}
        disabled={!canShare || state.busy}
        title={canShare ? "Upload this mod and copy a link anyone can install it from" : "Allow the server to keep your mods (under Create a mod) to share them"}
        className="text-xs px-3 py-1.5 rounded-md text-th-secondary border border-th hover:text-th-primary hover:bg-th-hover disabled:opacity-50 transition-colors"
      >{state.busy ? "Sharing…" : "Share"}</button>
      {state.link && <p role="status" className="mt-1 text-[11px] text-emerald-400 break-all">Link copied: {state.link}</p>}
      {state.error && <p role="alert" className="mt-1 text-[11px] text-red-400">{state.error}</p>}
    </div>
  );
}

function ModRow({ mod, screens, canShare, onEdit }: { mod: ModStatus; screens: { id: string; title: string }[]; canShare: boolean; onEdit?: () => void }) {
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
          {onEdit && (
            <button
              onClick={onEdit}
              className="text-xs px-3 py-1.5 rounded-md text-th-secondary border border-th hover:text-th-primary hover:bg-th-hover transition-colors"
            >Edit</button>
          )}
          <ShareButton id={mod.id} canShare={canShare} />
        </div>
      </div>
    </li>
  );
}

function VerifiedCard({ verified, summary, onInstall, installed }: { verified: VerifyResult & { bundle: ModBundle }; summary?: string; onInstall: () => void; installed: boolean }) {
  const m = verified.bundle.manifest;
  return (
    <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-display font-semibold text-th-primary">{m.name} <span className="text-xs font-mono text-th-muted">v{m.version}</span></div>
          <p className="text-sm text-th-secondary">{summary ?? m.description}</p>
          <HookBadges hooks={m.hooks} />
          {verified.notes.map(n => <p key={n} className="mt-2 text-xs text-amber-400">Note: {n}</p>)}
        </div>
        <button
          onClick={onInstall}
          disabled={installed}
          className="text-xs px-3 py-1.5 rounded-md bg-orange-500/90 text-white hover:bg-orange-500 disabled:bg-th-raised disabled:text-th-muted transition-colors shrink-0"
        >{installed ? "Installed" : "Install"}</button>
      </div>
      <details className="mt-2">
        <summary className="text-xs text-th-muted cursor-pointer">View code</summary>
        <pre className="mt-2 text-[11px] font-mono text-th-secondary bg-th-raised rounded-md p-2 overflow-x-auto">{verified.bundle.source}</pre>
      </details>
    </div>
  );
}

function CreateModPanel({ installedIds, install, consent, onConsent, editing, onStopEditing }: {
  installedIds: Set<string>;
  install: (bundle: ModBundle, label: string) => Promise<void>;
  consent: { store: boolean; sweep: boolean };
  onConsent: (c: { store: boolean; sweep: boolean }) => void;
  /** An installed mod to change instead of creating a new one */
  editing: ModBundle | null;
  onStopEditing: () => void;
}) {
  const mods = useMods();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setResult(null);
    setBusy("Starting…");
    try {
      const installed = mods
        .filter(m => m.id !== editing?.manifest.id)
        .map(m => ({ name: m.name, description: storedBundle(m.id)?.manifest.description ?? "", hooks: m.hooks }));
      setResult(await createModFromPrompt(prompt.trim(), { installed, parent: editing ?? undefined, onProgress: setBusy }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-th bg-th-surface p-4 mb-6">
      <h2 className="font-display font-semibold text-th-primary mb-1">{editing ? `Edit ${editing.manifest.name}` : "Create a mod"}</h2>
      {editing ? (
        <p className="text-xs text-th-muted mb-3">
          Describe the change (e.g. "make it half as strong"). The new version is tested the same way and replaces v{editing.manifest.version} when you install it.{" "}
          <button onClick={() => { onStopEditing(); setResult(null); }} className="underline underline-offset-2 hover:text-th-primary">Stop editing</button>
          {editing.manifest.hooks.some(h => h === "rules" || h.startsWith("data.")) && (
            <span className="block mt-1 text-amber-400">
              This mod changes save data (players, teams or rules). Saves that already have v{editing.manifest.version} get the new version applied on top of it; new games get only the new version.
            </span>
          )}
        </p>
      ) : (
        <p className="text-xs text-th-muted mb-3">Describe what you want to change. It's written for you, tested in a few simulated matches, and you choose whether to install it.</p>
      )}
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        maxLength={2000}
        rows={3}
        aria-label="Describe your mod"
        placeholder="e.g. Spinners should take more wickets at Chepauk, or: a dark green theme"
        className="w-full rounded-md border border-th bg-th-raised p-2 text-sm text-th-primary placeholder:text-th-faint"
      />
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <button
          onClick={() => void create()}
          disabled={!prompt.trim() || busy !== null}
          className="text-xs px-3 py-1.5 rounded-md bg-orange-500/90 text-white hover:bg-orange-500 disabled:bg-th-raised disabled:text-th-muted transition-colors"
        >{busy ? "Working…" : editing ? "Update" : "Create"}</button>
        {busy && <span role="status" className="text-xs text-th-secondary">{busy}</span>}
      </div>
      <div className="mt-3 flex flex-col gap-1 text-xs text-th-secondary">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={consent.store} onChange={e => onConsent({ store: e.target.checked, sweep: consent.sweep })} />
          Let the server keep my prompts and mods (needed to share mods by link)
        </label>
        <label className={`flex items-center gap-2 ${consent.store ? "" : "opacity-50"}`}>
          <input type="checkbox" disabled={!consent.store} checked={consent.sweep} onChange={e => onConsent({ store: consent.store, sweep: e.target.checked })} />
          Also use them, anonymised, to decide what to build into the game for everyone
        </label>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      {result && result.kind === "ready" && (
        <VerifiedCard
          verified={result.verified}
          summary={result.summary}
          // An edit keeps the id, so "installed" means this exact version is the one installed
          installed={editing ? storedBundle(result.verified.bundle.manifest.id)?.source === result.verified.bundle.source : installedIds.has(result.verified.bundle.manifest.id)}
          onInstall={() => void install(result.verified.bundle, editing ? "your edit" : "your prompt").then(() => { if (editing) onStopEditing(); })}
        />
      )}
      {result && result.kind !== "ready" && (
        <div role="alert" className="mt-3 text-sm text-amber-400">
          <p>{result.summary}</p>
          {result.errors?.length ? <ul className="mt-1 list-disc pl-5 text-xs">{result.errors.map(e => <li key={e}>{e}</li>)}</ul> : null}
        </div>
      )}
    </div>
  );
}

/** ?install=<id>: a shared mod, checked locally before it's offered */
function SharedInstall({ id, installedIds, install }: { id: string; installedIds: Set<string>; install: (bundle: ModBundle, label: string) => Promise<void> }) {
  const [state, setState] = useState<{ verified?: VerifyResult; error?: string }>({});
  useEffect(() => {
    let live = true;
    fetchSharedMod(id).then(v => live && setState({ verified: v }), e => live && setState({ error: errorText(e) }));
    return () => { live = false; };
  }, [id]);
  return (
    <div className="rounded-xl border border-th bg-th-surface p-4 mb-6">
      <h2 className="font-display font-semibold text-th-primary mb-1">Shared mod</h2>
      {!state.verified && !state.error && <p role="status" className="text-sm text-th-secondary">Loading and testing it…</p>}
      {state.error && <p role="alert" className="text-sm text-red-400">{state.error}</p>}
      {state.verified && !state.verified.ok && (
        <p role="alert" className="text-sm text-red-400">This mod didn't pass the checks: {state.verified.errors.join("; ")}</p>
      )}
      {state.verified?.ok && state.verified.bundle && (
        <VerifiedCard
          verified={{ ...state.verified, bundle: state.verified.bundle }}
          installed={installedIds.has(state.verified.bundle.manifest.id)}
          onInstall={() => void install(state.verified!.bundle!, "a shared link")}
        />
      )}
    </div>
  );
}

export function ModsPage() {
  const mods = useMods();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [consent, setConsentState] = useConsent();
  const [editing, setEditing] = useState<ModBundle | null>(null);
  const createPanel = useRef<HTMLDivElement>(null);
  const startEditing = (id: string) => {
    const bundle = storedBundle(id);
    if (!bundle) return;
    setEditing(bundle);
    createPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const [params] = useSearchParams();
  const sharedId = params.get("install");

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

      {/* Results of any install on this page (shared link, prompt, file, example) */}
      {error && <p role="alert" className="mb-4 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">{error}</p>}
      {notice && <p role="status" className="mb-4 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400">{notice}</p>}

      {modsApiEnabled && sharedId && /^[0-9a-f-]{36}$/.test(sharedId) && (
        <SharedInstall id={sharedId} installedIds={installedIds} install={install} />
      )}
      {modsApiEnabled && (
        <div ref={createPanel}>
          <CreateModPanel
            installedIds={installedIds} install={install} consent={consent} onConsent={setConsentState}
            editing={editing} onStopEditing={() => setEditing(null)}
          />
        </div>
      )}

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
      </div>

      <h2 className="font-display font-semibold text-th-primary mb-2">Installed</h2>
      {mods.length === 0 ? (
        <p className="text-sm text-th-muted mb-6">No mods installed. The game runs exactly as shipped.</p>
      ) : (
        <ul className="flex flex-col gap-3 mb-6">
          {mods.map(m => (
            <ModRow key={m.id} mod={m} screens={screensOf(m.id)} canShare={consent.store} onEdit={modsApiEnabled ? () => startEditing(m.id) : undefined} />
          ))}
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
