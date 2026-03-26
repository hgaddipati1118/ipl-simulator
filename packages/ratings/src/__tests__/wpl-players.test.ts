import { describe, expect, it } from "vitest";
import { createPlayerFromData } from "@ipl-sim/engine";
import { getWPLPlayers } from "../wpl-players.js";

describe("WPL player generation", () => {
  const players = getWPLPlayers();
  const rosterPlayers = players.filter((player) => player.teamId);
  const runtimePlayers = rosterPlayers.map(createPlayerFromData);
  const runtimeByName = new Map(runtimePlayers.map((player) => [player.name, player]));
  const rosterCounts = new Map<string, number>();

  for (const player of rosterPlayers) {
    rosterCounts.set(player.teamId!, (rosterCounts.get(player.teamId!) ?? 0) + 1);
  }

  it("covers all five WPL teams with complete current rosters", () => {
    expect(rosterPlayers.length).toBe(90);
    for (const teamId of ["dc-w", "gg-w", "mi-w", "rcb-w", "upw"]) {
      expect(rosterCounts.get(teamId) ?? 0).toBe(18);
    }
  });

  it("keeps frontline WPL all-rounders as all-rounders at runtime", () => {
    const hayley = runtimeByName.get("Hayley Matthews")!;
    const ellyse = runtimeByName.get("Ellyse Perry")!;
    const nat = runtimeByName.get("Nat Sciver-Brunt")!;
    const deepti = runtimeByName.get("Deepti Sharma")!;

    expect(hayley.role).toBe("all-rounder");
    expect(hayley.bowlingOvr).toBeGreaterThanOrEqual(72);

    expect(ellyse.role).toBe("all-rounder");
    expect(nat.role).toBe("all-rounder");
    expect(deepti.role).toBe("all-rounder");
  });

  it("keeps bowling specialists and batting specialists in sane women-role buckets", () => {
    const ecclestone = runtimeByName.get("Sophie Ecclestone")!;
    const danni = runtimeByName.get("Danni Wyatt-Hodge")!;

    expect(ecclestone.role).toBe("bowler");
    expect(ecclestone.bowlingOvr).toBeGreaterThanOrEqual(84);
    expect(ecclestone.battingOvr).toBeLessThanOrEqual(56);

    expect(danni.role).toBe("batsman");
    expect(danni.bowlingOvr).toBeLessThan(50);
  });

  it("keeps recovered and fallback WPL players in the roster pool", () => {
    const pooja = rosterPlayers.find((player) => player.name === "Pooja Vastrakar")!;
    const alana = rosterPlayers.find((player) => player.name === "Alana King")!;
    const sophieM = rosterPlayers.find((player) => player.name === "Sophie Molineux")!;
    const rajeshwari = rosterPlayers.find((player) => player.name === "Rajeshwari Gayakwad")!;
    const saika = rosterPlayers.find((player) => player.name === "Saika Ishaque")!;
    const minnu = rosterPlayers.find((player) => player.name === "Minnu Mani")!;
    const kanika = rosterPlayers.find((player) => player.name === "Kanika Ahuja")!;
    const amandeep = rosterPlayers.find((player) => player.name === "Amandeep Kaur")!;

    expect(pooja.teamId).toBe("mi-w");
    expect(alana.teamId).toBe("upw");
    expect(sophieM.teamId).toBe("rcb-w");
    expect(rajeshwari.teamId).toBe("upw");
    expect(saika.teamId).toBe("mi-w");
    expect(minnu.teamId).toBe("dc-w");
    expect(kanika.teamId).toBe("rcb-w");
    expect(amandeep.teamId).toBe("mi-w");
    expect(sophieM.role).toBe("all-rounder");

    expect(runtimeByName.get("Pooja Vastrakar")!.role).toBe("bowler");
    expect(runtimeByName.get("Alana King")!.role).toBe("bowler");
    expect(runtimeByName.get("Sophie Molineux")!.role).toBe("bowler");
    expect(runtimeByName.get("Sophie Molineux")!.bowlingOvr).toBeGreaterThan(runtimeByName.get("Sophie Molineux")!.battingOvr);
    expect(runtimeByName.get("Rajeshwari Gayakwad")!.role).toBe("bowler");
    expect(runtimeByName.get("Saika Ishaque")!.role).toBe("bowler");
    expect(runtimeByName.get("Minnu Mani")!.role).toBe("bowler");
    expect(runtimeByName.get("Kanika Ahuja")!.role).toBe("batsman");
  });
});
