/**
 * Static checks on a generated mod, run before it leaves the server. Workers can't eval code,
 * so this is the cheap first gate; the app then type-checks the mod against the SDK and runs a
 * seeded headless match with it, sending any failures back for another attempt.
 */

/** SDK v1 hook names (docs/MODS-DESIGN.md, "Hooks") */
export const KNOWN_HOOKS = [
  "data.players", "data.teams", "rules",
  "engine.ballProbabilities", "engine.onBall", "engine.matchFormat",
  "ui.theme", "ui.screens", "ui.panels",
  "commentary.line", "news.item",
] as const;

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  sdk: string;
  hooks: string[];
  description: string;
}

const MAX_MODULE_BYTES = 64 * 1024;

/**
 * Engine and data hooks must be pure functions of their inputs; anything that reaches outside
 * (network, storage, the page, dynamic code) is rejected. UI mods render in a sandboxed iframe,
 * but the same list keeps them from phoning home.
 */
const BANNED: [RegExp, string][] = [
  [/\bfetch\s*\(/, "network access (fetch)"],
  [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnavigator\.sendBeacon\b/, "network access"],
  [/\bimportScripts\b|\bimport\s*\(/, "dynamic imports"],
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, "dynamic code (eval / Function)"],
  [/\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\bdocument\.cookie\b/, "browser storage"],
  [/\bwindow\b|\bglobalThis\b|\bself\b|\btop\b\.|\bparent\b\./, "global objects"],
  [/\bMath\.random\s*\(/, "Math.random (use ctx.rng so multiplayer stays in sync)"],
  [/\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/, "the current time (mods must be deterministic)"],
  [/\brequire\s*\(/, "require()"],
];

export function checkManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") return ["manifest is not an object"];
  const m = manifest as Record<string, unknown>;
  if (typeof m.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id) || m.id.length > 64) {
    errors.push("manifest.id must be kebab-case, at most 64 characters");
  }
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 80) errors.push("manifest.name must be 1-80 characters");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push("manifest.version must be semver like 1.0.0");
  if (m.sdk !== "1") errors.push('manifest.sdk must be "1"');
  if (typeof m.description !== "string" || m.description.length > 500) errors.push("manifest.description must be a string of at most 500 characters");
  if (!Array.isArray(m.hooks) || m.hooks.length === 0) {
    errors.push("manifest.hooks must list at least one hook");
  } else {
    for (const hook of m.hooks) {
      if (!(KNOWN_HOOKS as readonly string[]).includes(hook as string)) errors.push(`unknown hook "${String(hook)}"`);
    }
  }
  return errors;
}

export function checkModule(source: string, manifest: ModManifest): string[] {
  const errors: string[] = [];
  if (new TextEncoder().encode(source).length > MAX_MODULE_BYTES) errors.push(`module is over ${MAX_MODULE_BYTES / 1024}KB`);
  if (!/\bexport\s+default\s+defineMod\s*\(/.test(source)) errors.push("module must `export default defineMod({...})`");
  // The game injects defineMod; mods have nothing to import
  if (/^\s*import\b/m.test(source)) errors.push("mods can't use import statements (defineMod is provided by the game)");

  const code = stripStringsAndComments(source);
  for (const [re, what] of BANNED) {
    if (re.test(code)) errors.push(`uses ${what}, which mods aren't allowed to`);
  }

  // Each declared hook should appear in the code by its last name segment ("ballProbabilities")
  for (const hook of manifest.hooks ?? []) {
    const leaf = hook.split(".").at(-1)!;
    if (!new RegExp(`\\b${leaf}\\b`).test(code)) errors.push(`manifest declares "${hook}" but the module doesn't define it`);
  }
  return errors;
}

/** Blank out string literals and comments so banned words inside them don't trip the checks */
function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
}
