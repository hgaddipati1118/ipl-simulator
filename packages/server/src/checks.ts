/**
 * Static checks on a mod before the server returns or stores it. The manifest rules and the bundle
 * hash come from @ipl-sim/mods itself, so the server and the app can never disagree about what a
 * valid mod is or which content a hash names. Workers can't evaluate code, so on top of that this
 * scans the source for things mods must not do; the app then compiles the mod and runs a seeded
 * headless match with it, sending any failures back for another attempt.
 */

import { hashBundle, validateManifest, ValidationError, type ModManifest } from "@ipl-sim/mods";

export type { ModManifest };

/** Same ceiling the app's bundle loader enforces (parseBundle) */
export const MAX_SOURCE_CHARS = 256_000;

/**
 * Engine and data hooks must be pure functions of their inputs; anything that reaches outside
 * (network, storage, the page, dynamic code) is rejected. UI screens and panels are HTML strings
 * rendered in a sandboxed iframe, so string contents aren't scanned.
 */
const BANNED: [RegExp, string][] = [
  [/\bfetch\s*\(/, "network access (fetch)"],
  [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnavigator\.sendBeacon\b/, "network access"],
  [/\bimportScripts\b|\bimport\s*\(/, "dynamic imports"],
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, "dynamic code (eval / Function)"],
  [/\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\bdocument\b/, "the page or browser storage"],
  [/\bwindow\b|\bglobalThis\b|\bself\b|\btop\b\.|\bparent\b\./, "global objects"],
  [/\bMath\.random\s*\(/, "Math.random (use ctx.rng so multiplayer stays in sync)"],
  [/\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/, "the current time (mods must be deterministic)"],
  [/\brequire\s*\(/, "require()"],
];

/** Validate and normalise a manifest with the SDK's own rules (unknown fields are dropped) */
export function parseManifest(manifest: unknown): { manifest?: ModManifest; errors: string[] } {
  try {
    return { manifest: validateManifest(manifest), errors: [] };
  } catch (err) {
    if (err instanceof ValidationError) return { errors: [err.message] };
    throw err;
  }
}

export function checkSource(source: string, manifest: ModManifest): string[] {
  const errors: string[] = [];
  if (source.length > MAX_SOURCE_CHARS) errors.push("source is larger than 256 KB");
  if (!/\bexport\s+default\s+defineMod\s*\(/.test(source)) errors.push("source must `export default defineMod({...})`");
  // The game provides defineMod; mods have nothing to import
  if (/^\s*import\b/m.test(source)) errors.push("mods can't use import statements (defineMod is provided by the game)");

  const code = stripStringsAndComments(source);
  for (const [re, what] of BANNED) {
    if (re.test(code)) errors.push(`uses ${what}, which mods aren't allowed to`);
  }

  // Each declared hook should appear in the code by its last name segment ("ballProbabilities")
  for (const hook of manifest.hooks) {
    const leaf = hook.split(".").at(-1)!;
    if (!new RegExp(`\\b${leaf}\\b`).test(code)) errors.push(`manifest declares "${hook}" but the source doesn't define it`);
  }
  return errors;
}

/** The hash the app records in saves and compares in multiplayer lobbies */
export function modHash(manifest: ModManifest, source: string): Promise<string> {
  return hashBundle({ manifest, source });
}

/** Blank out string literals and comments so banned words inside them don't trip the checks */
function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
}
