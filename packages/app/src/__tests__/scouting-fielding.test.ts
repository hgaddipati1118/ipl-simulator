import { describe, expect, it, vi } from "vitest";

vi.mock("@ipl-sim/ratings/dist/real-players.js", () => ({ getRealPlayers: () => [] }));
vi.mock("@ipl-sim/ratings/dist/wpl-players.js", () => ({ getWPLPlayers: () => [] }));

import { Player, type PlayerData } from "@ipl-sim/engine";
import { getPlayerScoutingView, createScoutingState } from "../scouting";

function keeper(id: string, over: Partial<PlayerData["ratings"]> = {}, data: Partial<PlayerData> = {}): Player {
  return new Player({
    id, name: `Player ${id}`, age: 28, country: "India", role: "batsman", isWicketKeeper: true, isInternational: false,
    ratings: { battingIQ: 70, timing: 70, power: 70, running: 65, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 60, fielding: 64, keeping: 71, ...over },
    injured: false, injuryGamesLeft: 0, ...data,
  });
}

describe("fielding and keeping in the scouting view", () => {
  it("shows exact values for your own players", () => {
    const view = getPlayerScoutingView(keeper("a"), "mine", undefined, "mine");
    expect(view.fielding?.exact).toBe(true);
    expect(view.fielding?.display).toBe("64");
    expect(view.keeping?.display).toBe("71");
  });

  it("follows the same visibility rules as the other attributes for players you cannot see exactly", () => {
    const p = keeper("b");
    const scouting = createScoutingState([], [p], "mine", 1);
    const view = getPlayerScoutingView(p, "other", scouting, "mine");
    expect(view.exactRatings).toBe(false);
    for (const v of [view.fielding!, view.keeping!, view.attributes.timing]) {
      expect(v.exact).toBe(false);
      expect(v.min).toBeLessThanOrEqual(v.max);
    }
    expect(view.fielding!.actual).toBe(64);
    // an estimate, not the true number: it is the player's rating blurred by the same margin as the others
    expect(view.fielding!.display === "64").toBe(false);
    expect(view.keeping!.min).toBeLessThanOrEqual(71);
    expect(view.keeping!.max).toBeGreaterThanOrEqual(71);
    // a full scouting report (92+) gives exact values again
    const full = getPlayerScoutingView(p, "other", { ...scouting, reports: { [p.id]: { playerId: p.id, confidence: 95, exposures: 0, lastUpdatedSeason: 1 } } }, "mine");
    expect(full.fielding!.exact).toBe(true);
    expect(full.keeping!.display).toBe("71");
  });

  it("has no fielding / keeping view for players without the ratings", () => {
    const bare = new Player({
      id: "c", name: "Bare", age: 25, country: "India", role: "batsman", isInternational: false, injured: false, injuryGamesLeft: 0,
      ratings: { battingIQ: 60, timing: 60, power: 60, running: 60, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 50 },
    });
    const view = getPlayerScoutingView(bare, "mine", undefined, "mine");
    expect(view.fielding).toBeUndefined();
    expect(view.keeping).toBeUndefined();
  });

  it("flags a shaky keeper and praises a good one, in the notes", () => {
    const shaky = getPlayerScoutingView(keeper("d", { keeping: 30 }), "mine", undefined, "mine");
    expect(shaky.concerns.join(" ")).toMatch(/Keeping looks shaky/);
    const good = getPlayerScoutingView(keeper("e", { keeping: 82, fielding: 78, battingIQ: 40, timing: 40, power: 40 }), "mine", undefined, "mine");
    expect(good.strengths.join(" ")).toMatch(/gloves|hands/i);
  });
});
