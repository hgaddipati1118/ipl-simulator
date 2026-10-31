// Generates sdk/index.d.ts (the surface handed to the coding agent) from src/sdk.ts.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export function renderSdk() {
  const types = readFileSync(join(root, "src/sdk.ts"), "utf8");
  return `${types}
/** Identity helper that gives a mod module full type checking and completion. */
export declare function defineMod<T extends ModDefinition>(definition: T): T;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(root, "sdk"), { recursive: true });
  writeFileSync(join(root, "sdk/index.d.ts"), renderSdk());
  console.log("wrote sdk/index.d.ts");
}
