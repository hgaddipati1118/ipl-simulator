import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPlayerFromData } from "@ipl-sim/engine";
import { getWPLPlayers } from "../wpl-players.js";

interface GeneratedWomenRating {
  id: string;
  name: string;
  country: string;
  teamId?: string;
  espnId: number;
  sourceStats: {
    statClass: number;
    t20Matches: number;
  };
}

describe("WPL player generation", () => {
  const ratingsPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "data",
    "scraped",
    "espn-ratings-women.json",
  );
  const generatedRatings = JSON.parse(readFileSync(ratingsPath, "utf-8")) as GeneratedWomenRating[];
  const generatedRosterPlayers = generatedRatings.filter((player) => player.teamId);
  const players = getWPLPlayers();
  const rosterPlayers = players.filter((player) => player.teamId);
  const runtimePlayers = rosterPlayers.map(createPlayerFromData);
  const generatedByName = new Map(generatedRatings.map((player) => [player.name, player]));
  const runtimeByName = new Map(runtimePlayers.map((player) => [player.name, player]));
  const generatedRosterByName = new Map(generatedRosterPlayers.map((player) => [player.name, player]));
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

  it("keeps a broader women's pool outside WPL", () => {
    const nonWplIndia = generatedRatings.filter((player) => player.country === "India" && !player.teamId);
    const lowSampleWomen = generatedRatings.filter(
      (player) => player.sourceStats.t20Matches >= 1 && player.sourceStats.t20Matches < 10,
    );

    expect(generatedRatings.length).toBeGreaterThanOrEqual(730);
    expect(lowSampleWomen.length).toBeGreaterThanOrEqual(200);
    expect(nonWplIndia.length).toBeGreaterThanOrEqual(7);

    expect(generatedByName.get("Mady Villiers")?.teamId).toBeUndefined();
    expect(generatedByName.get("Mady Villiers")?.sourceStats.t20Matches).toBeGreaterThanOrEqual(10);
    expect(generatedByName.get("Orla Prendergast")?.teamId).toBeUndefined();
    expect(generatedByName.get("Esha Oza")?.teamId).toBeUndefined();
    expect(generatedByName.get("Lizelle Lee")?.teamId).toBeUndefined();
    expect(generatedByName.get("Sneh Rana")?.teamId).toBeUndefined();
    expect(generatedByName.get("Vaishnavi Sharma")?.teamId).toBeUndefined();
    expect(generatedByName.get("Vaishnavi Sharma")?.sourceStats.t20Matches).toBeLessThan(10);
    expect(generatedByName.get("Tejal Hasabnis")?.teamId).toBeUndefined();
    expect(generatedByName.get("Tejal Hasabnis")?.sourceStats.t20Matches).toBeLessThan(10);
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
    expect(ecclestone.bowlingOvr).toBeGreaterThanOrEqual(78);
    expect(ecclestone.battingOvr).toBeLessThanOrEqual(56);

    expect(danni.role).toBe("batsman");
    expect(danni.bowlingOvr).toBeLessThan(50);
  });

  it("keeps recovered and thin-sample WPL players in the roster pool", () => {
    const pooja = rosterPlayers.find((player) => player.name === "Pooja Vastrakar")!;
    const alana = rosterPlayers.find((player) => player.name === "Alana King")!;
    const sophieM = rosterPlayers.find((player) => player.name === "Sophie Molineux")!;
    const rajeshwari = rosterPlayers.find((player) => player.name === "Rajeshwari Gayakwad")!;
    const saika = rosterPlayers.find((player) => player.name === "Saika Ishaque")!;
    const minnu = rosterPlayers.find((player) => player.name === "Minnu Mani")!;
    const kanika = rosterPlayers.find((player) => player.name === "Kanika Ahuja")!;
    const amandeep = rosterPlayers.find((player) => player.name === "Amandeep Kaur")!;
    const taniya = rosterPlayers.find((player) => player.name === "Taniya Bhatia")!;
    const sneha = rosterPlayers.find((player) => player.name === "Sneha Deepthi")!;
    const ekta = rosterPlayers.find((player) => player.name === "Ekta Bisht")!;
    const meghna = rosterPlayers.find((player) => player.name === "Meghna Singh")!;
    const anjali = rosterPlayers.find((player) => player.name === "Anjali Sarvani")!;
    const gouher = rosterPlayers.find((player) => player.name === "Gouher Sultana")!;
    const keerthana = rosterPlayers.find((player) => player.name === "SB Keerthana")!;
    const kranti = rosterPlayers.find((player) => player.name === "Kranti Gaud")!;
    const charani = rosterPlayers.find((player) => player.name === "N Charani")!;
    const dani = rosterPlayers.find((player) => player.name === "Dani Gibson")!;
    const sabbhineni = rosterPlayers.find((player) => player.name === "Sabbhineni Meghana")!;

    expect(pooja.teamId).toBe("mi-w");
    expect(alana.teamId).toBe("upw");
    expect(sophieM.teamId).toBe("rcb-w");
    expect(rajeshwari.teamId).toBe("upw");
    expect(saika.teamId).toBe("mi-w");
    expect(minnu.teamId).toBe("dc-w");
    expect(kanika.teamId).toBe("rcb-w");
    expect(amandeep.teamId).toBe("mi-w");
    expect(taniya.teamId).toBe("dc-w");
    expect(sneha.teamId).toBe("dc-w");
    expect(ekta.teamId).toBe("rcb-w");
    expect(meghna.teamId).toBe("gg-w");
    expect(anjali.teamId).toBe("upw");
    expect(gouher.teamId).toBe("upw");
    expect(keerthana.teamId).toBe("mi-w");
    expect(kranti.teamId).toBe("upw");
    expect(charani.teamId).toBe("dc-w");
    expect(dani.teamId).toBe("gg-w");
    expect(sabbhineni.teamId).toBe("rcb-w");
    expect(sophieM.role).toBe("bowler");

    expect(generatedRosterPlayers.every((player) => player.id.startsWith("espn_"))).toBe(true);
    expect(generatedRosterByName.get("Taniya Bhatia")!.espnId).toBe(883423);
    expect(generatedRosterByName.get("Sneha Deepthi")!.espnId).toBe(627072);
    expect(generatedRosterByName.get("Ekta Bisht")!.espnId).toBe(442048);
    expect(generatedRosterByName.get("Meghna Singh")!.espnId).toBe(709839);
    expect(generatedRosterByName.get("Anjali Sarvani")!.espnId).toBe(960673);
    expect(generatedRosterByName.get("Gouher Sultana")!.espnId).toBe(263980);
    expect(generatedRosterByName.get("SB Keerthana")!.espnId).toBe(961109);
    expect(generatedRosterByName.get("Kranti Gaud")!.espnId).toBe(1464471);
    expect(generatedRosterByName.get("N Charani")!.espnId).toBe(1464461);
    expect(generatedRosterByName.get("Dani Gibson")!.espnId).toBe(886203);
    expect(generatedRosterByName.get("Sabbhineni Meghana")!.espnId).toBe(556529);
    expect(generatedRosterByName.get("Taniya Bhatia")!.sourceStats.statClass).toBe(9);
    expect(generatedRosterByName.get("Ekta Bisht")!.sourceStats.statClass).toBe(9);
    expect(generatedRosterByName.get("Kranti Gaud")!.sourceStats.statClass).toBe(9);
    expect(generatedRosterByName.get("N Charani")!.sourceStats.statClass).toBe(9);

    expect(runtimeByName.get("Pooja Vastrakar")!.role).toBe("bowler");
    expect(runtimeByName.get("Alana King")!.role).toBe("all-rounder");
    expect(runtimeByName.get("Sophie Molineux")!.role).toBe("bowler");
    expect(runtimeByName.get("Sophie Molineux")!.bowlingOvr).toBeGreaterThan(runtimeByName.get("Sophie Molineux")!.battingOvr);
    expect(runtimeByName.get("Rajeshwari Gayakwad")!.role).toBe("bowler");
    expect(runtimeByName.get("Saika Ishaque")!.role).toBe("bowler");
    expect(runtimeByName.get("Minnu Mani")!.role).toBe("bowler");
    expect(runtimeByName.get("Kanika Ahuja")!.role).toBe("batsman");
    expect(runtimeByName.get("Ekta Bisht")!.role).toBe("bowler");
    expect(runtimeByName.get("Meghna Singh")!.role).toBe("bowler");
    expect(runtimeByName.get("Anjali Sarvani")!.role).toBe("bowler");
    expect(runtimeByName.get("Gouher Sultana")!.role).toBe("bowler");
    expect(runtimeByName.get("SB Keerthana")!.role).toBe("bowler");
    expect(runtimeByName.get("Kranti Gaud")!.role).toBe("bowler");
    expect(runtimeByName.get("N Charani")!.role).toBe("bowler");
    expect(runtimeByName.get("Taniya Bhatia")!.role).toBe("batsman");
    expect(runtimeByName.get("Dani Gibson")!.role).toBe("batsman");
    expect(runtimeByName.get("Sabbhineni Meghana")!.role).toBe("batsman");
  });
});
