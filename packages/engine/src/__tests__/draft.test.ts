import { describe, it, expect } from "vitest";
import {
  createDraft, applyDraftAction, runAiPicks, simulateRemainingDraft,
  buildPickOrder, toDraftPlayer, getCurrentSeatId, getSquad, getPickError,
  getLegalPlayers, canFieldValidXI, isDraftBowlingOption, squadStrength,
  type DraftConfig, type DraftPlayer, type DraftSeat, type DraftState,
} from "../draft.js";
import { generatePlayerPool } from "../create-player.js";

/** Generated pool with at least n/8 keepers (random pools occasionally have almost none). */
function pool(n: number): DraftPlayer[] {
  const players = generatePlayerPool(n).map(toDraftPlayer);
  let wk = players.filter(p => p.isWicketKeeper).length;
  for (const p of players) {
    if (wk >= Math.ceil(n / 8)) break;
    if (!p.isWicketKeeper && p.role === "batsman") { p.isWicketKeeper = true; wk++; }
  }
  return players;
}

function seats(n: number, controller: "ai" | "human" = "ai"): DraftSeat[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `Team ${i}`, controller }));
}

const SEASON_CFG: DraftConfig = {
  type: "snake", rounds: 18, maxOverseas: 8, maxOverseasInXI: 4,
  minWicketKeepers: 2, minBowlingOptions: 7, pickSeconds: 30, seed: 42,
};

function started(s: DraftState): DraftState {
  return applyDraftAction(s, { type: "start" }).state;
}

describe("pick order", () => {
  it("snake reverses every other round", () => {
    expect(buildPickOrder(["a", "b", "c"], 3, "snake")).toEqual(["a", "b", "c", "c", "b", "a", "a", "b", "c"]);
  });
  it("two-seat snake is ABBA", () => {
    expect(buildPickOrder(["a", "b"], 4, "snake").join("")).toBe("abbaabba");
  });
  it("linear keeps the same order", () => {
    expect(buildPickOrder(["a", "b"], 3, "linear").join("")).toBe("ababab");
  });
});

describe("state machine", () => {
  it("requires start before picks and enforces turn order", () => {
    const d = createDraft({ config: SEASON_CFG, seats: seats(3, "human"), pool: pool(120) });
    const p0 = d.pool[0].id;
    expect(applyDraftAction(d, { type: "pick", seatId: "t0", playerId: p0 }).error).toBeTruthy();
    const s = started(d);
    expect(applyDraftAction(s, { type: "pick", seatId: "t1", playerId: p0 }).error).toBe("Not your pick");
    const ok = applyDraftAction(s, { type: "pick", seatId: "t0", playerId: p0 });
    expect(ok.error).toBeUndefined();
    expect(ok.state.taken[p0]).toBe("t0");
    expect(getCurrentSeatId(ok.state)).toBe("t1");
    // Can't take the same player twice
    expect(applyDraftAction(ok.state, { type: "pick", seatId: "t1", playerId: p0 }).error).toBe("Already drafted");
  });

  it("never mutates its input", () => {
    const s = started(createDraft({ config: SEASON_CFG, seats: seats(2, "human"), pool: pool(80) }));
    const snapshot = JSON.stringify(s);
    applyDraftAction(s, { type: "pick", seatId: "t0", playerId: s.pool[3].id });
    applyDraftAction(s, { type: "auto-pick", seatId: "t0" });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("pause blocks picks; undo removes the last pick", () => {
    let s = started(createDraft({ config: SEASON_CFG, seats: seats(2, "human"), pool: pool(80) }));
    s = applyDraftAction(s, { type: "auto-pick", seatId: "t0" }).state;
    const first = s.picks[0].playerId;
    const paused = applyDraftAction(s, { type: "pause" }).state;
    expect(applyDraftAction(paused, { type: "auto-pick", seatId: "t1" }).error).toBeTruthy();
    const resumed = applyDraftAction(paused, { type: "resume" }).state;
    const undone = applyDraftAction(resumed, { type: "undo" }).state;
    expect(undone.picks).toHaveLength(0);
    expect(undone.taken[first]).toBeUndefined();
    expect(getCurrentSeatId(undone)).toBe("t0");
  });

  it("auto-pick uses the human's queue first", () => {
    const s = started(createDraft({ config: SEASON_CFG, seats: seats(2, "human"), pool: pool(80) }));
    const want = s.pool[40].id;
    const res = applyDraftAction(s, { type: "auto-pick", seatId: "t0", queue: ["nonexistent", want] });
    expect(res.pick?.playerId).toBe(want);
    expect(res.pick?.auto).toBe(true);
  });

  it("keepers pre-fill squads and shorten that seat's picks", () => {
    const p = pool(100);
    const d = createDraft({ config: { ...SEASON_CFG, rounds: 5 }, seats: seats(2), pool: p, keepers: { t0: [p[0].id, p[1].id] } });
    expect(d.squads.t0).toHaveLength(2);
    expect(d.order.filter(x => x === "t0")).toHaveLength(3);
    expect(d.order.filter(x => x === "t1")).toHaveLength(5);
  });

  it("set-controller swaps a seat to AI and runAiPicks takes over", () => {
    let s = started(createDraft({ config: SEASON_CFG, seats: seats(2, "human"), pool: pool(80) }));
    expect(runAiPicks(s).picks).toHaveLength(0);
    s = applyDraftAction(s, { type: "set-controller", seatId: "t0", controller: "ai" }).state;
    const res = runAiPicks(s);
    expect(res.picks).toHaveLength(1); // t0 picks, then it's human t1's turn
    expect(getCurrentSeatId(res.state)).toBe("t1");
  });
});

describe("rules enforcement", () => {
  it("blocks overseas picks past the squad limit", () => {
    const p = pool(200);
    const cfg: DraftConfig = { ...SEASON_CFG, rounds: 11, maxOverseas: 1, maxOverseasInXI: 4, minWicketKeepers: 1, minBowlingOptions: 5 };
    let s = started(createDraft({ config: cfg, seats: [{ id: "a", name: "A", controller: "human" }], pool: p }));
    const os = s.pool.filter(x => x.isInternational);
    s = applyDraftAction(s, { type: "pick", seatId: "a", playerId: os[0].id }).state;
    expect(getPickError(s, "a", os[1].id)).toBe("Overseas limit reached");
  });

  it("forces a keeper and enough bowlers before the squad fills", () => {
    const p = pool(200);
    const cfg: DraftConfig = { ...SEASON_CFG, rounds: 11, maxOverseas: undefined, maxOverseasInXI: undefined, minWicketKeepers: 1, minBowlingOptions: 5 };
    let s = started(createDraft({ config: cfg, seats: [{ id: "a", name: "A", controller: "human" }], pool: p }));
    // Take only pure batters until the rules start refusing them
    const batters = s.pool.filter(x => x.role === "batsman" && !x.isWicketKeeper);
    let taken = 0;
    for (const b of batters) {
      const res = applyDraftAction(s, { type: "pick", seatId: "a", playerId: b.id });
      if (res.error) break;
      s = res.state;
      taken++;
    }
    expect(taken).toBe(11 - 1 - 5); // 5 batters, then 6 slots must go to 1 WK + 5 bowlers
    const legal = getLegalPlayers(s, "a");
    expect(legal.every(x => x.isWicketKeeper || isDraftBowlingOption(x))).toBe(true);
  });
});

describe("AI drafts", () => {
  it("every AI squad in a 10-team season draft can field a legal XI", () => {
    const d = createDraft({ config: SEASON_CFG, seats: seats(10), pool: pool(320) });
    const done = simulateRemainingDraft(d);
    expect(done.status).toBe("complete");
    for (const seat of done.seats) {
      const squad = getSquad(done, seat.id);
      expect(squad).toHaveLength(18);
      expect(squad.filter(x => x.isInternational).length).toBeLessThanOrEqual(8);
      expect(squad.filter(x => x.isWicketKeeper).length).toBeGreaterThanOrEqual(2);
      expect(squad.filter(isDraftBowlingOption).length).toBeGreaterThanOrEqual(7);
      expect(canFieldValidXI(squad, { minWicketKeepers: 1, minBowlingOptions: 5, maxOverseasInXI: 4 })).toBe(true);
    }
    // No player drafted twice
    const all = done.seats.flatMap(s => done.squads[s.id]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("draft-match XIs (2 seats, 11 rounds) are always legal", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const cfg: DraftConfig = { type: "snake", rounds: 11, maxOverseas: 4, maxOverseasInXI: 4, minWicketKeepers: 1, minBowlingOptions: 5, pickSeconds: 20, seed };
      const done = simulateRemainingDraft(createDraft({ config: cfg, seats: seats(2), pool: pool(60) }));
      for (const seat of done.seats) {
        const xi = getSquad(done, seat.id);
        expect(xi).toHaveLength(11);
        expect(canFieldValidXI(xi, { minWicketKeepers: 1, minBowlingOptions: 5, maxOverseasInXI: 4 })).toBe(true);
      }
    }
  });

  it("is deterministic for the same seed and pool", () => {
    const p = pool(150);
    const cfg: DraftConfig = { ...SEASON_CFG, rounds: 12, seed: 7 };
    const a = simulateRemainingDraft(createDraft({ config: cfg, seats: seats(4), pool: p }));
    const b = simulateRemainingDraft(createDraft({ config: cfg, seats: seats(4), pool: p }));
    expect(a.picks.map(x => x.playerId)).toEqual(b.picks.map(x => x.playerId));
    const c = simulateRemainingDraft(createDraft({ config: { ...cfg, seed: 8 }, seats: seats(4), pool: p }));
    expect(c.picks.map(x => x.playerId)).not.toEqual(a.picks.map(x => x.playerId));
  });

  it("snake order keeps squads balanced", () => {
    const done = simulateRemainingDraft(createDraft({ config: SEASON_CFG, seats: seats(10), pool: pool(320) }));
    const strengths = done.seats.map(s => squadStrength(getSquad(done, s.id)));
    expect(Math.max(...strengths) - Math.min(...strengths)).toBeLessThan(6);
  });
});

describe("fuzz: random pools never produce an illegal squad or a stalled draft", () => {
  it("season drafts (10 teams × 18) and thin 4-side draft-match pools", () => {
    for (let k = 0; k < 40; k++) {
      const done = simulateRemainingDraft(createDraft({ config: { ...SEASON_CFG, seed: k }, seats: seats(10), pool: pool(300) }));
      expect(done.status).toBe("complete");
      for (const s of done.seats) {
        const sq = getSquad(done, s.id);
        expect(sq).toHaveLength(18);
        expect(canFieldValidXI(sq, { minWicketKeepers: 1, minBowlingOptions: 5, maxOverseasInXI: 4 })).toBe(true);
      }
    }
    for (let k = 0; k < 60; k++) {
      const cfg: DraftConfig = { type: "snake", rounds: 11, maxOverseas: 4, maxOverseasInXI: 4, minWicketKeepers: 1, minBowlingOptions: 5, pickSeconds: 0, seed: k };
      const done = simulateRemainingDraft(createDraft({ config: cfg, seats: seats(4), pool: pool(70) }));
      expect(done.status).toBe("complete");
      for (const s of done.seats) expect(getSquad(done, s.id)).toHaveLength(11);
    }
  }, 30_000);
});
