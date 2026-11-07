import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@ipl-sim/engine";
import { createGameState } from "../game-state";
import { realSeasonsFor, type RatingHistoryData } from "../rating-history";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "data", "rating-history.json");
const data = JSON.parse(readFileSync(FILE, "utf-8")) as RatingHistoryData;

describe("real rating history reaches players in a game", () => {
  it("game players keep their source id and find their real seasons", () => {
    const state = createGameState(DEFAULT_RULES);
    const players = [...state.teams.flatMap(t => t.roster), ...state.playerPool];
    const kohli = players.find(p => p.name === "Virat Kohli")!;
    expect(kohli.id).not.toMatch(/^espn_/);
    expect(kohli.sourceId).toMatch(/^espn_\d+$/);
    expect(realSeasonsFor(data, kohli.sourceId!).length).toBeGreaterThan(10);
    // most real players have history
    const withHistory = players.filter(p => p.sourceId && realSeasonsFor(data, p.sourceId).length > 0).length;
    expect(withHistory / players.length).toBeGreaterThan(0.5);
  });
});
