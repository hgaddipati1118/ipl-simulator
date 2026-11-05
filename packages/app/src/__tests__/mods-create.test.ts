import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMod } from "../mods/verify";

const examples = fileURLToPath(new URL("../../../mods/examples", import.meta.url));
const example = (name: string) => ({
  manifest: JSON.parse(readFileSync(`${examples}/${name}/manifest.json`, "utf-8")),
  source: readFileSync(`${examples}/${name}/mod.js`, "utf-8"),
});

const spinManifest = {
  id: "spin-test", name: "Spin test", version: "1.0.0", sdk: "1",
  hooks: ["engine.ballProbabilities"], description: "test",
};

describe("verifyMod", () => {
  it("passes the SDK examples", async () => {
    for (const name of ["spin-friendly-chennai", "midnight-theme"]) {
      const result = await verifyMod(example(name));
      expect(result.errors, name).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fails a mod that doesn't compile", async () => {
    const result = await verifyMod({ manifest: spinManifest, source: "export default defineMod({ engine: { ballProbabilities(ctx, p) { return p " });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("fails a mod whose hook breaks during the test matches", async () => {
    const source = `export default defineMod({ engine: { ballProbabilities(ctx, p) { return { ...p, wicket: NaN }; } } });`;
    const result = await verifyMod({ manifest: spinManifest, source });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/engine hook failed/);
  });

  it("notes a mod that never changes anything", async () => {
    const source = `export default defineMod({ engine: { ballProbabilities(ctx, p) { return ctx.venue.id === "nowhere" ? { ...p, wicket: p.wicket * 2 } : p; } } });`;
    const result = await verifyMod({ manifest: spinManifest, source });
    expect(result.ok).toBe(true);
    expect(result.notes[0]).toMatch(/didn't change anything/);
  });
});

describe("createModFromPrompt", () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    calls.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubEnv("VITE_MODS_API", "https://mods.test");
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends browser test failures back to the server and installs the fixed mod", async () => {
    const broken = `export default defineMod({ engine: { ballProbabilities(ctx, p) { return { ...p, wicket: -1 }; } } });`;
    const fixed = example("spin-friendly-chennai");
    const responses = [
      { kind: "mod", summary: "first try", manifest: fixed.manifest, source: broken },
      { kind: "mod", summary: "Spinners take more wickets at Chepauk.", manifest: fixed.manifest, source: fixed.source },
    ];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
      expect((init.headers as Record<string, string>)["x-device-id"]).toMatch(/^[0-9a-f-]{36}$/);
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    });

    const { createModFromPrompt } = await import("../mods/api");
    const result = await createModFromPrompt("spinners should matter more in Chennai");

    expect(result.kind).toBe("ready");
    expect(calls).toHaveLength(2);
    expect(calls[0].body.previous).toBeUndefined();
    const previous = calls[1].body.previous as { source: string; errors: string[] };
    expect(previous.source).toBe(broken);
    expect(previous.errors.join(" ")).toMatch(/engine hook failed/);
  });

  it("passes through 'unsupported' without retrying", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ kind: "unsupported", summary: "Needs a new auction screen." }), { status: 200 });
    });
    const { createModFromPrompt } = await import("../mods/api");
    expect(await createModFromPrompt("rebuild the auction")).toEqual({ kind: "unsupported", summary: "Needs a new auction screen." });
    expect(calls).toHaveLength(1);
  });

  it("edits keep the mod id: a renamed result goes back for another try", async () => {
    const parent = example("spin-friendly-chennai");
    const bumped = { ...parent.manifest, version: "1.1.0" };
    const responses = [
      { kind: "mod", summary: "renamed", manifest: { ...bumped, id: "a-different-id" }, source: parent.source },
      { kind: "mod", summary: "Half as strong.", manifest: bumped, source: parent.source.replace("1.15", "1.07") },
    ];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    });
    const { createModFromPrompt } = await import("../mods/api");
    const result = await createModFromPrompt("make it half as strong", { parent });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.verified.bundle.manifest).toMatchObject({ id: parent.manifest.id, version: "1.1.0" });
    expect((calls[0].body.parent as { manifest: { id: string } }).manifest.id).toBe(parent.manifest.id);
    expect((calls[1].body.previous as { errors: string[] }).errors.join(" ")).toMatch(/keep manifest.id/);
  });
});

