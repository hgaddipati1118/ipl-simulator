/** Example mods shipped with the app (sources live in packages/mods/examples). */
import type { ModBundle } from "@ipl-sim/mods";
import spinManifest from "../../../mods/examples/spin-friendly-chennai/manifest.json";
import spinSource from "../../../mods/examples/spin-friendly-chennai/mod.js?raw";
import themeManifest from "../../../mods/examples/midnight-theme/manifest.json";
import themeSource from "../../../mods/examples/midnight-theme/mod.js?raw";

export const EXAMPLE_MODS: ModBundle[] = [
  { manifest: spinManifest as ModBundle["manifest"], source: spinSource },
  { manifest: themeManifest as ModBundle["manifest"], source: themeSource },
];
