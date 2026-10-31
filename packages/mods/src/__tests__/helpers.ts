import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMod, hashBundle, parseBundle, type ModBundle } from "../index.js";
import { ModRuntime, type RuntimeOptions } from "../runtime.js";
import type { ModDefinition, ModManifest } from "../sdk.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../../examples");

export function loadExample(name: string): ModBundle {
  return parseBundle({
    manifest: JSON.parse(readFileSync(join(examples, name, "manifest.json"), "utf8")),
    source: readFileSync(join(examples, name, "mod.js"), "utf8"),
  });
}

export async function addBundle(runtime: ModRuntime, bundle: ModBundle): Promise<void> {
  runtime.add({ manifest: bundle.manifest, definition: compileMod(bundle), hash: await hashBundle(bundle) });
}

/** Add an inline mod definition (no source) with a fake hash. */
export function addInline(runtime: ModRuntime, id: string, hooks: ModManifest["hooks"], definition: ModDefinition): void {
  runtime.add({
    manifest: { id, name: id, version: "1.0.0", sdk: "1", hooks },
    definition,
    hash: `hash-${id}`,
  });
}

export function runtimeWithClock(options: RuntimeOptions = {}): { runtime: ModRuntime; clock: { t: number } } {
  const clock = { t: 0 };
  return { runtime: new ModRuntime({ now: () => clock.t, ...options }), clock };
}

export const PROBS = { dot: 0.3, "1": 0.3, "2": 0.06, "3": 0.01, "4": 0.15, "6": 0.08, wicket: 0.05, wide: 0.03, noball: 0.005, legbye: 0.015 };
export const CTX = {} as never;
