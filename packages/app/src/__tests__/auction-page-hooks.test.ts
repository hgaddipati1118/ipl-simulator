import { describe, expect, it, vi } from "vitest";

/** Every hook AuctionPage itself calls, in order, for the render under test (its children's hooks are their own) */
const hookCalls: string[] = [];

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  const track = <F extends (...args: never[]) => unknown>(name: string, hook: F) =>
    ((...args: Parameters<F>) => {
      const caller = new Error().stack?.split("\n")[2] ?? "";
      if (/\bAuctionPage\b/.test(caller)) hookCalls.push(name);
      return hook(...args);
    }) as unknown as F;
  return {
    ...actual,
    useState: track("useState", actual.useState),
    useEffect: track("useEffect", actual.useEffect),
    useMemo: track("useMemo", actual.useMemo),
    useRef: track("useRef", actual.useRef),
    useCallback: track("useCallback", actual.useCallback),
  };
});

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RULE_PRESETS } from "@ipl-sim/engine";
import { AuctionPage } from "../pages/AuctionPage";
import { createGameState, initLiveAuction, liveAuctionSimRemaining, type GameState } from "../game-state";

function hooksFor(state: GameState): string[] {
  hookCalls.length = 0;
  const noop = () => {};
  renderToString(createElement(AuctionPage, {
    state, scouting: state.scouting, recruitment: state.recruitment,
    onUserBid: noop, onUserPass: noop, onCpuRound: noop, onNextPlayer: noop, onSimPlayer: noop, onSimRemaining: noop,
    onFinishAuction: noop, onRtmAccept: noop, onRtmDecline: noop, onScoutPlayers: noop, onToggleShortlist: noop,
    onToggleWatchlist: noop,
  }));
  return [...hookCalls];
}

/**
 * React needs the same hooks on every render of a component. The auction page renders "Auction Complete" once the
 * last player goes; a hook after that early return made the finishing render crash ("Rendered fewer hooks than
 * expected"), so Sim Remaining Auction never reached Start Season.
 */
describe("AuctionPage hooks", () => {
  it("calls the same hooks while bidding and once the auction is complete", () => {
    const base = createGameState({ ...RULE_PRESETS.modern2026, playerSource: "generated" });
    const bidding = initLiveAuction({ ...base, userTeamId: base.teams[0].id, phase: "auction" });
    expect(bidding.auctionLiveState?.phase).toBe("bidding");
    const complete = liveAuctionSimRemaining(bidding);
    expect(complete.auctionLiveState?.phase).toBe("complete");

    const whileBidding = hooksFor(bidding);
    expect(whileBidding.length).toBeGreaterThan(0);
    expect(hooksFor(complete)).toEqual(whileBidding);
  });
});
