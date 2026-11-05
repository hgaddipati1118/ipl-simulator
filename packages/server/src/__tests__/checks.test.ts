import { describe, expect, it } from "vitest";
import { checkManifest, checkModule, type ModManifest } from "../checks";
import { scrubPrompt } from "../scrub";

const manifest: ModManifest = {
  id: "spin-friendly-chepauk",
  name: "Spin-friendly Chepauk",
  version: "1.0.0",
  sdk: "1",
  hooks: ["engine.ballProbabilities"],
  description: "Spinners take more wickets in Chennai.",
};

const goodModule = `import { defineMod } from "@ipl-sim/mods";
export default defineMod({
  engine: {
    ballProbabilities(ctx, probs) {
      if (ctx.venue.id !== "chepauk" || !ctx.bowler.isSpin) return probs;
      return { ...probs, wicket: probs.wicket * 1.15 };
    },
  },
});`;

describe("checkManifest", () => {
  it("accepts a valid manifest", () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  it("rejects bad ids, versions, sdk and unknown hooks", () => {
    const errors = checkManifest({ ...manifest, id: "Spin Mod", version: "1", sdk: "2", hooks: ["engine.rewriteEverything"] });
    expect(errors).toHaveLength(4);
    expect(errors.join(" ")).toMatch(/kebab-case/);
    expect(errors.join(" ")).toMatch(/unknown hook "engine.rewriteEverything"/);
  });

  it("requires at least one hook", () => {
    expect(checkManifest({ ...manifest, hooks: [] })).toEqual(["manifest.hooks must list at least one hook"]);
  });
});

describe("checkModule", () => {
  it("accepts a pure engine mod", () => {
    expect(checkModule(goodModule, manifest)).toEqual([]);
  });

  it("rejects network, storage, randomness and foreign imports", () => {
    const bad = `import x from "lodash";
export default defineMod({ engine: { ballProbabilities(ctx, p) {
  fetch("https://evil.example");
  localStorage.setItem("a", "b");
  return { ...p, wicket: p.wicket * Math.random() };
} } });`;
    const errors = checkModule(bad, manifest).join("\n");
    expect(errors).toMatch(/lodash/);
    expect(errors).toMatch(/network access \(fetch\)/);
    expect(errors).toMatch(/browser storage/);
    expect(errors).toMatch(/Math\.random/);
  });

  it("ignores banned words inside strings and comments", () => {
    const source = `${goodModule}\n// don't call fetch() or use window here\nconst note = "Math.random() is banned";`;
    expect(checkModule(source, manifest)).toEqual([]);
  });

  it("flags declared hooks the module doesn't define", () => {
    const errors = checkModule(goodModule, { ...manifest, hooks: ["engine.ballProbabilities", "commentary.line"] });
    expect(errors).toEqual(['manifest declares "commentary.line" but the module doesn\'t define it']);
  });

  it("requires a default export", () => {
    expect(checkModule("const a = 1;", manifest)).toContain("module must `export default defineMod({...})`");
  });
});

describe("scrubPrompt", () => {
  it("removes contact details and links but keeps cricket numbers", () => {
    const out = scrubPrompt("Email me at fan@example.com or call +91 98765 43210, see https://x.com/a. Make chases of 180/4 easier in 20 overs.");
    expect(out).toBe("Email me at [email] or call [number], see [link] Make chases of 180/4 easier in 20 overs.");
  });
});
