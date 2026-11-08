import { describe, expect, it } from "vitest";
import { RULE_PRESETS, generatePlayerPool } from "@ipl-sim/engine";
import { createGameState, initLiveAuction, liveAuctionSimRemaining } from "../game-state";

/**
 * "Sim Remaining Auction" plays the whole auction out. The standard pool is a shortlist of a few hundred, but the
 * "Deep" pool puts every free agent (5,000+ players) in the auction, and the engine's sim stops after 10,000 steps,
 * so a single pass used to leave such an auction unfinished (5001/5514 players, no "Start Season").
 */
describe("live auction: sim remaining", () => {
  it("finishes a Deep auction with a pool larger than one engine pass covers", () => {
    const base = createGameState(RULE_PRESETS.modern2026);
    const pool = [...base.playerPool, ...generatePlayerPool(Math.max(0, 6000 - base.playerPool.length))];
    expect(pool.length).toBeGreaterThan(5000);

    const state = initLiveAuction({
      ...base, rules: { ...base.rules, poolDepth: "deep" }, userTeamId: base.teams[0].id, phase: "auction", playerPool: pool,
    });
    expect(state.auctionLiveState!.players.length).toBe(pool.length);
    const done = liveAuctionSimRemaining(state).auctionLiveState!;

    expect(done.phase).toBe("complete");
    expect(done.completedBids.length + done.unsold.length).toBe(pool.length);
  });
});
