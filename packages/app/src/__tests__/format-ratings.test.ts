import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_RULES, RULE_PRESETS, Player } from "@ipl-sim/engine";
import { addPlayerToPool, createGameState } from "../game-state";
import { createPoolLoader } from "../extended-pool";
import { ensureFormatRatings, formatRatingsIfLoaded, statePlayers } from "../format-ratings";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const json = readFileSync(join(PUBLIC, "data", "format-ratings.json"), "utf-8");
const fetchMock = vi.fn(async (url: string) => ({ ok: url.endsWith("data/format-ratings.json"), json: async () => JSON.parse(json) }));

beforeAll(() => { vi.stubGlobal("fetch", fetchMock); });
afterAll(() => { vi.unstubAllGlobals(); });

describe("format ratings in the game", () => {
  it("attach to an IPL game's players by source id, once, and survive a save", async () => {
    const state = createGameState(DEFAULT_RULES);
    const players = statePlayers(state);
    const attached = await ensureFormatRatings(state);
    expect(attached).toBeGreaterThan(0.95 * players.filter(p => p.sourceId).length);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(formatRatingsIfLoaded()?.players).toBeDefined();
    const root = players.find(p => p.name === "Joe Root");
    const kohli = players.find(p => p.name === "Virat Kohli")!;
    expect(kohli.formatRatings?.test?.source).toBe("data");
    expect(kohli.forFormat("test").ratings).toEqual(kohli.formatRatings!.test!.ratings);
    expect(kohli.forFormat("t20")).toBe(kohli);
    if (root) expect(root.forFormat("test").battingOvr).toBeGreaterThan(root.battingOvr);
    // a second pass changes nothing and needs no new request
    expect(await ensureFormatRatings(state)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const restored = Player.fromJSON(JSON.parse(JSON.stringify(kohli.toJSON())));
    expect(restored.forFormat("odi").ratings).toEqual(kohli.forFormat("odi").ratings);
  });

  it("covers a WPL game and a league with squad fallback players", async () => {
    for (const rules of [RULE_PRESETS.wpl, { ...DEFAULT_RULES, league: "bbl" }]) {
      const state = createGameState(rules as typeof DEFAULT_RULES);
      await ensureFormatRatings(state);
      const rostered = state.teams.flatMap(t => t.roster).filter(p => p.sourceId);
      expect(rostered.length).toBeGreaterThan(50);
      expect(rostered.filter(p => p.formatRatings?.odi).length / rostered.length).toBeGreaterThan(0.95);
    }
  });

  it("extended-pool players bring their own sets from the shards", async () => {
    const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
    const [kallis] = await loader.search("jacques kallis", "men", ["senior"], 1);
    const state = addPlayerToPool(createGameState(DEFAULT_RULES), kallis);
    const player = state.playerPool.find(p => p.name === "Jacques Kallis")!;
    expect(player.formatRatings?.test?.source).toBe("data");
    expect(player.forFormat("test").ratings).toEqual(kallis.formatRatings!.test!.ratings);
  });

  it("an old save's players without sets play every format on their T20 ratings", () => {
    const state = createGameState(DEFAULT_RULES);
    const p = Player.fromJSON(JSON.parse(JSON.stringify({ ...state.teams[0].roster[0].toJSON(), formatRatings: undefined })));
    expect(p.formatRatings).toBeUndefined();
    expect(p.forFormat("odi")).toBe(p);
    expect(p.forFormat("test")).toBe(p);
  });
});
