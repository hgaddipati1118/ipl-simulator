import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RULES, IPL_TEAMS } from "@ipl-sim/engine";

const { deleteSlotMatchDataMock, idbData } = vi.hoisted(() => ({
  deleteSlotMatchDataMock: vi.fn(async () => true),
  idbData: new Map<string, unknown>(),
}));

vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: vi.fn(async (key: string) => idbData.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    idbData.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    idbData.delete(key);
  }),
}));

vi.mock("../match-db", () => ({
  deleteSlotMatchData: deleteSlotMatchDataMock,
}));

import {
  buildLiveMatchStorageKey,
  clearLiveMatchLocalState,
  clearState,
  deleteSaveSlot,
  loadStateFromSlot,
} from "../storage";

class MockLocalStorage {
  private store = new Map<string, string>();

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  get length() {
    return this.store.size;
  }
}

const storage = new MockLocalStorage();

function buildSerializedTeam(teamIndex = 0) {
  return [{
    config: IPL_TEAMS[teamIndex],
    roster: [],
    salaryCap: 120,
    totalSpent: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    nrr: 0,
    runsFor: 0,
    ballsFacedFor: 0,
    runsAgainst: 0,
    ballsFacedAgainst: 0,
    isUserControlled: true,
    userPlayingXI: undefined,
    userBattingOrder: undefined,
    userBowlingOrder: undefined,
    trainingIntensity: "balanced",
    bowlingPlan: undefined,
    batterAggression: undefined,
    bowlerFieldSettings: undefined,
  }];
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  storage.clear();
  idbData.clear();
  deleteSlotMatchDataMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage persistence", () => {
  it("restores hall of fame entries when loading a save slot", async () => {
    const slotId = "slot-hof";
    const hallOfFame = [{
      playerId: "legend-1",
      name: "Legend One",
      country: "India",
      retiredAge: 36,
      retiredSeason: 7,
      peakOverall: 94,
      careerRuns: 6500,
      careerWickets: 120,
      careerMatches: 220,
    }];

    storage.setItem(`ipl-sim:meta:${slotId}`, JSON.stringify({
      phase: "results",
      seasonNumber: 7,
      userTeamId: IPL_TEAMS[0].id,
      rules: DEFAULT_RULES,
      currentMatchIndex: 0,
      playoffsStarted: false,
      needsLineup: false,
    }));

    idbData.set(`slot:${slotId}:teams`, buildSerializedTeam());
    idbData.set(`slot:${slotId}:playerPool`, []);
    idbData.set(`slot:${slotId}:hallOfFame`, hallOfFame);

    const loaded = await loadStateFromSlot(slotId);

    expect(loaded?.hallOfFame).toEqual(hallOfFame);
  });

  it("clears only slot-scoped live match local storage keys", () => {
    storage.setItem(buildLiveMatchStorageKey("slot-a", 1, 2), "slot-a-state");
    storage.setItem(buildLiveMatchStorageKey("slot-b", 1, 2), "slot-b-state");
    storage.setItem("ipl-live-1-2", "legacy-state");

    clearLiveMatchLocalState("slot-a");

    expect(storage.getItem(buildLiveMatchStorageKey("slot-a", 1, 2))).toBeNull();
    expect(storage.getItem("ipl-live-1-2")).toBeNull();
    expect(storage.getItem(buildLiveMatchStorageKey("slot-b", 1, 2))).toBe("slot-b-state");
  });

  it("deletes slot-scoped match persistence when a save slot is removed", async () => {
    const slotId = "slot-delete";

    storage.setItem("ipl-sim:slots", JSON.stringify([{
      id: slotId,
      name: "Delete Me",
      league: "ipl",
      season: 1,
      teamName: "Mumbai Indians",
      updatedAt: "2026-03-26T00:00:00.000Z",
    }]));
    storage.setItem("ipl-sim:activeSlot", slotId);
    storage.setItem(`ipl-sim:meta:${slotId}`, JSON.stringify({
      phase: "season",
      seasonNumber: 1,
      userTeamId: IPL_TEAMS[0].id,
      rules: DEFAULT_RULES,
    }));
    storage.setItem(buildLiveMatchStorageKey(slotId, 1, 1), "live");

    await deleteSaveSlot(slotId);

    expect(deleteSlotMatchDataMock).toHaveBeenCalledWith(slotId);
    expect(storage.getItem(buildLiveMatchStorageKey(slotId, 1, 1))).toBeNull();
    expect(storage.getItem("ipl-sim:activeSlot")).toBeNull();
  });

  it("clears the active slot before resetting state", async () => {
    const slotId = "slot-reset";

    storage.setItem("ipl-sim:slots", JSON.stringify([{
      id: slotId,
      name: "Reset Me",
      league: "ipl",
      season: 1,
      teamName: "Mumbai Indians",
      updatedAt: "2026-03-26T00:00:00.000Z",
    }]));
    storage.setItem("ipl-sim:activeSlot", slotId);
    storage.setItem(`ipl-sim:meta:${slotId}`, JSON.stringify({
      phase: "season",
      seasonNumber: 1,
      userTeamId: IPL_TEAMS[0].id,
      rules: DEFAULT_RULES,
    }));

    await clearState();

    expect(storage.getItem("ipl-sim:activeSlot")).toBeNull();
    expect(deleteSlotMatchDataMock).toHaveBeenCalledWith(slotId);
  });
});
