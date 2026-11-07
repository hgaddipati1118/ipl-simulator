import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getLeaguePlayers, registerCaPlayerSource } from "@ipl-sim/ratings/dist/league-players.js";
import { createPoolLoader, prepareLeaguePool } from "../extended-pool";

const POOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "pool");
const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(POOL_DIR, f))));

const sources = (league: string) => {
  const out: Record<string, number> = {};
  for (const p of getLeaguePlayers(league)) out[p.source] = (out[p.source] ?? 0) + 1;
  return out;
};

describe("league squads use the extended pool", () => {
  afterAll(() => registerCaPlayerSource(null));

  it.each(["wbbl", "hundred-w", "psl", "bpl"])("%s: stand-ins become real CricketArchive players", async league => {
    registerCaPlayerSource(null);
    const before = sources(league);
    await prepareLeaguePool(league, loader);
    const after = sources(league);
    expect(after.pool).toBe(before.pool);
    expect(after["ca-pool"] ?? 0).toBeGreaterThan(0);
    expect(after.fallback ?? 0).toBeLessThan(before.fallback ?? 0);
    // every squad keeps a wicketkeeper
    const keepers: Record<string, number> = {};
    for (const p of getLeaguePlayers(league)) keepers[p.teamId] = (keepers[p.teamId] ?? 0) + (p.isWicketKeeper ? 1 : 0);
    expect(Object.entries(keepers).filter(([, n]) => n === 0)).toEqual([]);
    const ids = getLeaguePlayers(league).map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
