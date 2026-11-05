import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMod, hashBundle, implementedHooks, parseBundle, type ModManifest } from "@ipl-sim/mods";
import { describe, expect, it } from "vitest";
import { checkSource, modHash, parseManifest } from "../checks";
import { scrubPrompt } from "../scrub";

const examplesDir = fileURLToPath(new URL("../../../mods/examples", import.meta.url));

const manifest: ModManifest = {
  id: "spin-friendly-chepauk",
  name: "Spin-friendly Chepauk",
  version: "1.0.0",
  sdk: "1",
  hooks: ["engine.ballProbabilities"],
  description: "Spinners take more wickets in Chennai.",
};

const goodSource = `export default defineMod({
  engine: {
    ballProbabilities(ctx, probs) {
      if (ctx.venue.id !== "chepauk" || !ctx.bowler.isSpin) return probs;
      return { ...probs, wicket: probs.wicket * 1.15 };
    },
  },
});`;

describe("parseManifest", () => {
  it("accepts a valid manifest and drops unknown fields", () => {
    const { manifest: parsed, errors } = parseManifest({ ...manifest, payload: "arbitrary data" });
    expect(errors).toEqual([]);
    expect(parsed).toEqual(manifest);
  });

  it("uses the SDK's rules", () => {
    expect(parseManifest({ ...manifest, id: "Spin Mod" }).errors[0]).toMatch(/manifest.id/);
    expect(parseManifest({ ...manifest, sdk: "2" }).errors[0]).toMatch(/unsupported SDK version/);
    expect(parseManifest({ ...manifest, hooks: ["engine.rewriteEverything"] }).errors[0]).toMatch(/unknown hook/);
    expect(parseManifest({ ...manifest, hooks: [] }).errors[0]).toMatch(/at least one hook/);
  });
});

describe("checkSource", () => {
  it("accepts a pure engine mod", () => {
    expect(checkSource(goodSource, manifest)).toEqual([]);
  });

  it("rejects imports, network, storage and randomness", () => {
    const bad = `import x from "lodash";
export default defineMod({ engine: { ballProbabilities(ctx, p) {
  fetch("https://evil.example");
  localStorage.setItem("a", "b");
  return { ...p, wicket: p.wicket * Math.random() };
} } });`;
    const errors = checkSource(bad, manifest).join("\n");
    expect(errors).toMatch(/import statements/);
    expect(errors).toMatch(/network access \(fetch\)/);
    expect(errors).toMatch(/browser storage/);
    expect(errors).toMatch(/Math\.random/);
  });

  it("ignores banned words inside strings and comments", () => {
    const source = `${goodSource}\n// don't call fetch() or use window here\nconst note = "Math.random() is banned";`;
    expect(checkSource(source, manifest)).toEqual([]);
  });

  it("flags declared hooks the source doesn't define", () => {
    const errors = checkSource(goodSource, { ...manifest, hooks: ["engine.ballProbabilities", "commentary.line"] });
    expect(errors).toEqual(['manifest declares "commentary.line" but the source doesn\'t define it']);
  });

  it("requires export default defineMod(...)", () => {
    expect(checkSource("const a = 1;", manifest)).toContain("source must `export default defineMod({...})`");
  });
});

describe("server and app agree", () => {
  const examples = readdirSync(examplesDir).map(name => ({
    name,
    manifest: JSON.parse(readFileSync(join(examplesDir, name, "manifest.json"), "utf-8")),
    source: readFileSync(join(examplesDir, name, "mod.js"), "utf-8"),
  }));

  it.each(examples)("accepts the SDK example $name, and the app loads it", ({ manifest: m, source }) => {
    const { manifest: parsed, errors } = parseManifest(m);
    expect(errors).toEqual([]);
    expect(checkSource(source, parsed!)).toEqual([]);
    // What the server returns ({ manifest, source }) is exactly the app's install bundle
    const bundle = parseBundle({ manifest: parsed, source });
    expect(implementedHooks(compileMod(bundle)).sort()).toEqual([...parsed!.hooks].sort());
  });

  it("hashes mods the same way the app does", async () => {
    expect(await modHash(manifest, goodSource)).toBe(await hashBundle({ manifest, source: goodSource }));
  });
});

describe("scrubPrompt", () => {
  it("removes contact details and links but keeps cricket numbers", () => {
    const out = scrubPrompt("Email me at fan@example.com or call +91 98765 43210, see https://x.com/a. Make chases of 180/4 easier in 20 overs.");
    expect(out).toBe("Email me at [email] or call [number], see [link] Make chases of 180/4 easier in 20 overs.");
  });
});

describe("checkEdit", () => {
  it("requires the same id and a higher version", async () => {
    const { checkEdit } = await import("../index");
    expect(checkEdit(manifest, { ...manifest, version: "1.1.0" })).toEqual([]);
    expect(checkEdit(manifest, { ...manifest, version: "1.0.0" })[0]).toMatch(/raise manifest.version above 1.0.0/);
    expect(checkEdit(manifest, { ...manifest, id: "other-mod", version: "1.0.1" })[0]).toMatch(/keep manifest.id "spin-friendly-chepauk"/);
    expect(checkEdit({ ...manifest, version: "1.9.0" }, { ...manifest, version: "1.10.0" })).toEqual([]);
  });
});
