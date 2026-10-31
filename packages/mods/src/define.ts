import type { ModDefinition } from "./sdk.js";

/** Identity helper that gives a mod module full type checking and completion. */
export function defineMod<T extends ModDefinition>(definition: T): T {
  return definition;
}
