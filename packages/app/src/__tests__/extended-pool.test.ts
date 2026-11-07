import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({
  getRealPlayers: () => [],
  getPoolPlayers: () => [],
}));
vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({
  getWPLPlayers: () => [],
}));

import { DEFAULT_RULES } from "@ipl-sim/engine";
import { addPlayerToPool, createGameState } from "../game-state";
import { createPoolLoader, overallsOf } from "../extended-pool";

const POOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "pool");
/** Reads pool files off disk, returning the gzip bytes untouched (the loader gunzips them like the browser) */
const diskReader = async (file: string) => new Uint8Array(readFileSync(join(POOL_DIR, file)));

describe("extended pool loader", () => {
  it("lists counts from the manifest without loading any shard", async () => {
    const reads: string[] = [];
    const loader = createPoolLoader(async f => { reads.push(f); return diskReader(f); });
    const counts = await loader.counts();
    expect(counts["men/senior"]).toBeGreaterThan(15000);
    expect(counts["women/senior"]).toBeGreaterThan(10000);
    expect(reads).toEqual(["manifest.json"]);
  });

  it("loads only the shards a request needs and caches them", async () => {
    const reads: string[] = [];
    const loader = createPoolLoader(async f => { reads.push(f); return diskReader(f); });
    const women = await loader.players("women", ["senior"]);
    expect(women.length).toBeGreaterThan(10000);
    expect(women.every(p => p.gender === "women" && p.tier === "senior")).toBe(true);
    expect(reads.every(f => f === "manifest.json" || f.includes("women-senior"))).toBe(true);
    const before = reads.length;
    await loader.players("women", ["senior"]);
    expect(reads.length).toBe(before);
  });

  it("builds a deep auction pool from active senior players only", async () => {
    const loader = createPoolLoader(diskReader);
    const extras = await loader.auctionExtras("men", 400);
    expect(extras).toHaveLength(400);
    expect(extras.every(p => p.tier === "senior" && p.lastYear >= 2022)).toBe(true);
  });

  it("searches a gender's senior pool, and lower tiers only when asked", async () => {
    const loader = createPoolLoader(diskReader);
    const seniorHits = await loader.search("kallis", "men", ["senior"], 5);
    expect(seniorHits.some(p => p.name === "Jacques Kallis")).toBe(true);
    const lowerOnly = await loader.search("zzzzqq", "men", ["tier2"], 5);
    expect(lowerOnly).toEqual([]);
  });

  it("copes with a server that already decoded the gzip", async () => {
    const { gunzipSync } = await import("node:zlib");
    const loader = createPoolLoader(async f => {
      const raw = readFileSync(join(POOL_DIR, f));
      return new Uint8Array(f.endsWith(".gz") ? gunzipSync(raw) : raw);
    });
    expect((await loader.players("men", ["tier4"])).length).toBeGreaterThan(0);
    expect((await loader.counts())["men/senior"]).toBeGreaterThan(0);
  });

  it("a failed shard read is retried, not cached", async () => {
    let fail = true;
    const loader = createPoolLoader(async f => {
      if (f !== "manifest.json" && fail) { fail = false; throw new Error("network"); }
      return diskReader(f);
    });
    await expect(loader.players("men", ["tier4"])).rejects.toThrow("network");
    expect((await loader.players("men", ["tier4"])).length).toBeGreaterThan(0);
  });
});

describe("deep player pool in the game", () => {
  it("adds extended players to the auction pool only for a deep league", async () => {
    const loader = createPoolLoader(diskReader);
    const extras = await loader.auctionExtras("men", 300);
    const standard = createGameState({ ...DEFAULT_RULES }, extras);
    const deep = createGameState({ ...DEFAULT_RULES, poolDepth: "deep" }, extras);
    expect(deep.playerPool.length).toBeGreaterThanOrEqual(300);
    expect(deep.playerPool.length).toBeGreaterThan(standard.playerPool.length + 200);
    expect(new Set(deep.playerPool.map(p => p.id)).size).toBe(deep.playerPool.length);
  });

  it("signs a database player as a free agent once", async () => {
    const loader = createPoolLoader(diskReader);
    const [kallis] = await loader.search("jacques kallis", "men", ["senior"], 1);
    const state = createGameState({ ...DEFAULT_RULES });
    const before = state.playerPool.length;
    const added = addPlayerToPool(state, kallis);
    expect(added.playerPool).toHaveLength(before + 1);
    const player = added.playerPool.find(p => p.name === "Jacques Kallis")!;
    expect(player.overall).toBe(overallsOf(kallis).overall);
    expect(addPlayerToPool(added, kallis).playerPool).toHaveLength(before + 1);
  });
});
