/**
 * Hook runner. Composes enabled mods in install order, validates every output,
 * enforces a per-call time budget and disables a mod after three strikes.
 *
 * Contract for each hook call: a mod that throws, returns an invalid shape, or
 * takes longer than its budget is skipped for that call (the previous value
 * carries on to the next mod) and gets a strike. Budgets are measured after the
 * call returns: in-process code cannot be pre-empted, so a runaway loop still
 * blocks until it finishes. Moving hooks into a Worker (terminate on overrun) is
 * the follow-up that closes that gap.
 */

import type { EngineHooks } from "@ipl-sim/engine";
import { fingerprintOf, type ModFingerprint, type ModRecord } from "./fingerprint.js";
import type {
  BallContext, BallEvent, ModDefinition, ModHookName, ModManifest, ModNewsEvent, ModPanel,
  ModPlayer, ModRuleSet, ModScreen, ModTeam, ModTheme, NewsItem,
} from "./sdk.js";
import {
  SIM_HOOKS, ValidationError, validateMatchFormat, validatePlayers, validateProbabilities, validateRules, validateTeams,
  type RulesValidationOptions,
} from "./validate.js";

export interface Budgets {
  /** engine.ballProbabilities / onBall / matchFormat / commentary / news, per call. */
  engineMs: number;
  /** data.* and rules, per call. */
  dataMs: number;
}

export const DEFAULT_BUDGETS: Budgets = { engineMs: 20, dataMs: 1000 };
export const MAX_STRIKES = 3;

export interface ModStatus {
  id: string;
  name: string;
  version: string;
  hash: string;
  hooks: ModHookName[];
  enabled: boolean;
  strikes: number;
  /** Set when the runtime itself disabled the mod. */
  disabledReason?: string;
  lastError?: string;
}

export interface ModFault {
  modId: string;
  hook: ModHookName;
  message: string;
  strikes: number;
  disabled: boolean;
}

export interface RuntimeOptions {
  now?: () => number;
  budgets?: Partial<Budgets>;
  maxStrikes?: number;
  /** Called on every fault. */
  onFault?: (fault: ModFault) => void;
}

export interface AddModInput {
  manifest: ModManifest;
  definition: ModDefinition;
  hash: string;
  enabled?: boolean;
  strikes?: number;
  disabledReason?: string;
}

interface Entry {
  manifest: ModManifest;
  definition: ModDefinition;
  hash: string;
  enabled: boolean;
  strikes: number;
  disabledReason?: string;
  lastError?: string;
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

export class ModRuntime {
  private mods: Entry[] = [];
  private listeners = new Set<(statuses: ModStatus[]) => void>();
  private now: () => number;
  private budgets: Budgets;
  private maxStrikes: number;
  private onFault?: (fault: ModFault) => void;
  private parent?: ModRuntime;

  constructor(options: RuntimeOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
    this.maxStrikes = options.maxStrikes ?? MAX_STRIKES;
    this.onFault = options.onFault;
  }

  /* ───── Registry ───── */

  /** Install a mod at the end of the order (or replace the same id in place). */
  add(input: AddModInput): void {
    const entry: Entry = {
      manifest: input.manifest,
      definition: input.definition,
      hash: input.hash,
      enabled: input.enabled ?? true,
      strikes: input.strikes ?? 0,
      disabledReason: input.disabledReason,
    };
    const idx = this.mods.findIndex(m => m.manifest.id === input.manifest.id);
    if (idx >= 0) this.mods[idx] = entry;
    else this.mods.push(entry);
    this.emit();
  }

  remove(id: string): void {
    this.mods = this.mods.filter(m => m.manifest.id !== id);
    this.emit();
  }

  /** Enabling a mod clears its strikes. */
  setEnabled(id: string, enabled: boolean): void {
    const m = this.mods.find(x => x.manifest.id === id);
    if (!m) return;
    m.enabled = enabled;
    if (enabled) {
      m.strikes = 0;
      m.disabledReason = undefined;
      m.lastError = undefined;
    }
    this.emit();
  }

  list(): ModStatus[] {
    return this.mods.map(m => ({
      id: m.manifest.id,
      name: m.manifest.name,
      version: m.manifest.version,
      hash: m.hash,
      hooks: m.manifest.hooks,
      enabled: m.enabled,
      strikes: m.strikes,
      disabledReason: m.disabledReason,
      lastError: m.lastError,
    }));
  }

  subscribe(listener: (statuses: ModStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    if (this.parent) { this.parent.emit(); return; }
    const statuses = this.list();
    for (const l of this.listeners) l(statuses);
  }

  private active(hook: ModHookName): Entry[] {
    return this.mods.filter(m => m.enabled && m.manifest.hooks.includes(hook));
  }

  /* ───── Fault-isolated invocation ───── */

  private invoke<T>(mod: Entry, hook: ModHookName, budgetMs: number, call: () => unknown, validate: (out: unknown) => T): Outcome<T> {
    const t0 = this.now();
    let out: unknown;
    try {
      out = call();
    } catch (e) {
      this.strike(mod, hook, `threw: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
    const elapsed = this.now() - t0;
    if (elapsed > budgetMs) {
      this.strike(mod, hook, `took ${elapsed.toFixed(1)} ms (budget ${budgetMs} ms)`);
      return { ok: false };
    }
    try {
      return { ok: true, value: validate(out) };
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      this.strike(mod, hook, `invalid output: ${e.message}`);
      return { ok: false };
    }
  }

  private strike(mod: Entry, hook: ModHookName, message: string): void {
    mod.strikes++;
    mod.lastError = `${hook} ${message}`;
    const disabled = mod.strikes >= this.maxStrikes;
    if (disabled) {
      mod.enabled = false;
      mod.disabledReason = `Disabled after ${mod.strikes} failures. Last: ${mod.lastError}`;
    }
    this.onFault?.({ modId: mod.manifest.id, hook, message, strikes: mod.strikes, disabled });
    this.emit();
  }

  /* ───── Engine hooks ───── */

  /** True when any enabled mod has a hook that changes simulation results. */
  hasSimulationMods(): boolean {
    return this.mods.some(m => m.enabled && m.manifest.hooks.some(h => SIM_HOOKS.includes(h)));
  }

  /**
   * The composed hooks to register with the engine (`setEngineHooks`). Only the
   * hooks some enabled mod implements are present, so unmodded matches take the
   * engine's no-hook fast path. Re-register after the mod list changes.
   */
  engineHooks(): EngineHooks {
    const hooks: EngineHooks = {};
    if (this.active("engine.ballProbabilities").length) {
      hooks.ballProbabilities = (ctx, probs) => {
        let current = probs;
        for (const m of this.active("engine.ballProbabilities")) {
          const r = this.invoke(
            m, "engine.ballProbabilities", this.budgets.engineMs,
            () => m.definition.engine!.ballProbabilities!(ctx as unknown as BallContext, { ...current }),
            validateProbabilities,
          );
          if (r.ok) current = r.value;
        }
        return current;
      };
    }
    if (this.active("engine.onBall").length) {
      hooks.onBall = (ctx, event) => {
        for (const m of this.active("engine.onBall")) {
          this.invoke(
            m, "engine.onBall", this.budgets.engineMs,
            () => m.definition.engine!.onBall!(ctx as unknown as BallContext, { ...event } as BallEvent),
            () => undefined,
          );
        }
      };
    }
    if (this.active("engine.matchFormat").length) {
      hooks.matchFormat = (format) => {
        let current = format;
        for (const m of this.active("engine.matchFormat")) {
          const r = this.invoke(
            m, "engine.matchFormat", this.budgets.engineMs,
            () => m.definition.engine!.matchFormat!({ ...current }),
            validateMatchFormat,
          );
          if (r.ok) current = r.value;
        }
        return current;
      };
    }
    return hooks;
  }

  /* ───── Data and rules (apply once per save) ───── */

  applyRules(rules: ModRuleSet, opts: RulesValidationOptions = {}): ModRuleSet {
    let current = rules;
    for (const m of this.active("rules")) {
      const r = this.invoke(
        m, "rules", this.budgets.dataMs,
        () => m.definition.rules!(structuredClone(current)),
        out => validateRules(out, current, opts),
      );
      if (r.ok) current = r.value;
    }
    return current;
  }

  applyPlayers(players: ModPlayer[]): ModPlayer[] {
    let current = players;
    for (const m of this.active("data.players")) {
      const r = this.invoke(
        m, "data.players", this.budgets.dataMs,
        () => m.definition.data!.players!(structuredClone(current)),
        validatePlayers,
      );
      if (r.ok) current = r.value;
    }
    return current;
  }

  applyTeams(teams: ModTeam[]): ModTeam[] {
    let current = teams;
    for (const m of this.active("data.teams")) {
      const r = this.invoke(
        m, "data.teams", this.budgets.dataMs,
        () => m.definition.data!.teams!(structuredClone(current)),
        validateTeams,
      );
      if (r.ok) current = r.value;
    }
    return current;
  }

  /** Ids of the mods that have a data.* or rules hook enabled. */
  dataModIds(): string[] {
    return this.mods
      .filter(m => m.enabled && m.manifest.hooks.some(h => h === "data.players" || h === "data.teams" || h === "rules"))
      .map(m => m.manifest.id);
  }

  /** Apply data/rules hooks of one mod only (used to apply a mod to a save exactly once). */
  withOnly(ids: readonly string[]): ModRuntime {
    const scoped = new ModRuntime({ now: this.now, budgets: this.budgets, maxStrikes: this.maxStrikes, onFault: this.onFault });
    // Share Entry objects so strikes land on the real mods
    scoped.mods = this.mods.filter(m => ids.includes(m.manifest.id));
    scoped.parent = this;
    return scoped;
  }

  /* ───── Presentation ───── */

  /** Variables and fonts of all enabled theme mods merged in install order (later wins). */
  theme(): ModTheme {
    const merged: ModTheme = {};
    for (const m of this.active("ui.theme")) {
      const t = m.definition.ui!.theme!;
      if (t.variables) merged.variables = { ...merged.variables, ...t.variables };
      if (t.light) merged.light = { ...merged.light, ...t.light };
      if (t.dark) merged.dark = { ...merged.dark, ...t.dark };
      if (t.fonts) merged.fonts = { ...merged.fonts, ...t.fonts };
    }
    return merged;
  }

  screens(): (ModScreen & { modId: string; modName: string })[] {
    return this.active("ui.screens").flatMap(m =>
      m.definition.ui!.screens!.map(s => ({ ...s, modId: m.manifest.id, modName: m.manifest.name })));
  }

  panels(slot?: ModPanel["slot"]): (ModPanel & { modId: string; modName: string })[] {
    return this.active("ui.panels")
      .flatMap(m => m.definition.ui!.panels!.map(p => ({ ...p, modId: m.manifest.id, modName: m.manifest.name })))
      .filter(p => !slot || p.slot === slot);
  }

  /** First non-null line from enabled commentary mods, or null to keep the default. */
  commentaryLine(event: BallEvent, ctx: BallContext): string | null {
    for (const m of this.active("commentary.line")) {
      const r = this.invoke(
        m, "commentary.line", this.budgets.engineMs,
        () => m.definition.commentary!.line!(event, ctx),
        out => {
          if (out === null) return null;
          if (typeof out !== "string" || out.length > 300) throw new ValidationError("commentary.line must return a string under 300 characters or null");
          return out;
        },
      );
      if (r.ok && r.value !== null) return r.value;
    }
    return null;
  }

  newsItems(event: ModNewsEvent): NewsItem[] {
    const items: NewsItem[] = [];
    for (const m of this.active("news.item")) {
      const r = this.invoke(
        m, "news.item", this.budgets.engineMs,
        () => m.definition.news!.item!(event),
        out => {
          if (out === null) return null;
          const o = out as Partial<NewsItem>;
          if (typeof o !== "object" || typeof o.title !== "string" || !o.title || o.title.length > 140 ||
              (o.body !== undefined && (typeof o.body !== "string" || o.body.length > 600))) {
            throw new ValidationError("news.item must return { title, body? } or null");
          }
          return { title: o.title, ...(o.body !== undefined ? { body: o.body } : {}) } as NewsItem;
        },
      );
      if (r.ok && r.value) items.push(r.value);
    }
    return items;
  }

  /* ───── Identity ───── */

  /** Records of enabled mods for saves and lobbies, in install order. */
  records(): ModRecord[] {
    return this.mods
      .filter(m => m.enabled)
      .map(m => ({
        id: m.manifest.id,
        version: m.manifest.version,
        hash: m.hash,
        engine: m.manifest.hooks.some(h => SIM_HOOKS.includes(h)),
      }));
  }

  fingerprint(): ModFingerprint {
    return fingerprintOf(this.records());
  }
}
