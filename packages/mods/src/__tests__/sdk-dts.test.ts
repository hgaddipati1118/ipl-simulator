import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM script without types
import { renderSdk } from "../../scripts/build-sdk.mjs";

describe("published SDK surface", () => {
  it("sdk/index.d.ts is in sync with src/sdk.ts (run `npm run sdk --workspace=packages/mods`)", () => {
    const dts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../sdk/index.d.ts"), "utf8");
    expect(dts).toBe(renderSdk());
  });

  it("declares every hook the runtime accepts", async () => {
    const dts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../sdk/index.d.ts"), "utf8");
    const { HOOK_NAMES } = await import("../validate.js");
    for (const h of HOOK_NAMES) expect(dts).toContain(`"${h}"`);
    expect(dts).toContain('export type SdkVersion = "1"');
    expect(dts).toContain("export declare function defineMod");
  });
});
