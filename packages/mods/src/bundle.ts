/**
 * The install format and loader. A bundle is `{ manifest, source }` as JSON; the
 * source is an ES module body with a default export (`export default defineMod({...})`).
 *
 * The module is evaluated with `new Function`, so it cannot `import` anything and
 * only sees the globals of the page. That is not a security boundary: engine hooks
 * run in-process behind the validator and time budget (see MODS-DESIGN.md, "Worker
 * follow-up"). UI hooks are the part that renders inside a sandboxed iframe.
 */

import { defineMod } from "./define.js";
import type { ModDefinition, ModHookName, ModManifest } from "./sdk.js";
import { ValidationError, validateManifest, validatePanels, validateScreens, validateTheme } from "./validate.js";

export interface ModBundle {
  manifest: ModManifest;
  source: string;
}

const MAX_SOURCE = 256_000;

export function parseBundle(json: unknown): ModBundle {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new ValidationError("bundle must be a JSON object with manifest and source");
  const { manifest, source } = json as Record<string, unknown>;
  if (typeof source !== "string" || !source.trim()) throw new ValidationError("bundle.source must be the module source as a string");
  if (source.length > MAX_SOURCE) throw new ValidationError("bundle.source is larger than 256 KB");
  return { manifest: validateManifest(manifest), source };
}

/** Evaluate the module source and return its default export. Throws on syntax or shape errors. */
export function compileMod(bundle: ModBundle): ModDefinition {
  const marker = /\bexport\s+default\b/;
  if (!marker.test(bundle.source)) throw new ValidationError('module must have a default export: export default defineMod({ ... })');
  if (/^\s*import\s/m.test(bundle.source)) throw new ValidationError("mods cannot import modules; defineMod is provided");
  const body = bundle.source.replace(marker, "__exports.default =");
  let def: unknown;
  try {
    const factory = new Function("defineMod", "__exports", `"use strict";\n${body}\n;return __exports.default;`);
    def = factory(defineMod, {});
  } catch (e) {
    throw new ValidationError(`module failed to load: ${e instanceof Error ? e.message : String(e)}`);
  }
  return checkDefinition(def, bundle.manifest);
}

const TOP_LEVEL: Record<string, string[]> = {
  data: ["players", "teams"],
  engine: ["ballProbabilities", "onBall", "matchFormat"],
  ui: ["theme", "screens", "panels"],
  commentary: ["line"],
  news: ["item"],
};

/** Hooks a definition actually implements, in manifest naming. */
export function implementedHooks(def: ModDefinition): ModHookName[] {
  const out: ModHookName[] = [];
  if (typeof def.data?.players === "function") out.push("data.players");
  if (typeof def.data?.teams === "function") out.push("data.teams");
  if (typeof def.rules === "function") out.push("rules");
  if (typeof def.engine?.ballProbabilities === "function") out.push("engine.ballProbabilities");
  if (typeof def.engine?.onBall === "function") out.push("engine.onBall");
  if (typeof def.engine?.matchFormat === "function") out.push("engine.matchFormat");
  if (def.ui?.theme !== undefined) out.push("ui.theme");
  if (def.ui?.screens !== undefined) out.push("ui.screens");
  if (def.ui?.panels !== undefined) out.push("ui.panels");
  if (typeof def.commentary?.line === "function") out.push("commentary.line");
  if (typeof def.news?.item === "function") out.push("news.item");
  return out;
}

/** Static checks: known keys, manifest agreement, and a valid theme/screens/panels. Returns normalised UI content. */
export function checkDefinition(def: unknown, manifest: ModManifest): ModDefinition {
  if (typeof def !== "object" || def === null || Array.isArray(def)) throw new ValidationError("default export must be an object (use defineMod)");
  const d = def as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (key !== "rules" && !(key in TOP_LEVEL)) throw new ValidationError(`unknown key "${key}" in mod definition`);
  }
  if (d.rules !== undefined && typeof d.rules !== "function") throw new ValidationError('"rules" must be a function');
  for (const [group, keys] of Object.entries(TOP_LEVEL)) {
    const g = d[group];
    if (g === undefined) continue;
    if (typeof g !== "object" || g === null) throw new ValidationError(`"${group}" must be an object`);
    for (const k of Object.keys(g)) if (!keys.includes(k)) throw new ValidationError(`unknown key "${group}.${k}"`);
  }
  const def2 = def as ModDefinition;
  const implemented = implementedHooks(def2);
  for (const h of implemented) {
    if (!manifest.hooks.includes(h)) throw new ValidationError(`hook "${h}" is implemented but not declared in manifest.hooks`);
  }
  for (const h of manifest.hooks) {
    if (!implemented.includes(h)) throw new ValidationError(`manifest declares "${h}" but the module does not implement it`);
  }
  const normalised: ModDefinition = { ...def2, ui: def2.ui ? { ...def2.ui } : undefined };
  if (def2.ui?.theme !== undefined) normalised.ui!.theme = validateTheme(def2.ui.theme);
  if (def2.ui?.screens !== undefined) normalised.ui!.screens = validateScreens(def2.ui.screens);
  if (def2.ui?.panels !== undefined) normalised.ui!.panels = validatePanels(def2.ui.panels);
  if (!normalised.ui) delete normalised.ui;
  return normalised;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the canonical manifest plus module source. Identifies exact mod content across peers and saves. */
export async function hashBundle(bundle: ModBundle): Promise<string> {
  const data = new TextEncoder().encode(canonical({ manifest: bundle.manifest, source: bundle.source }));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
