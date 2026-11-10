import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";

/**
 * Elite players of weaker nations keep their standing (docs/COUNTRY-VALIDATION.md, "Weak-nation ratings"): the opposition-strength
 * adjustment of national-squad ratings (generate-intl-adjust.ts) must not move them. Reads docs/data/intl_adjust.json (each
 * listed player's rating, his estimate from his record against strong opposition and the shipped drop) and the shipped deltas in
 * format-ratings.json. ELITE_TABLE=1 prints the table: per weaker nation the best players with rating before / after and their
 * record against strong opposition.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
interface Row { id: string; name: string; country: string; gender: string; fmt: "t20" | "odi"; side: "bat" | "bowl"; rating: number; estimate: number; weakShare: number; strongBalls: number; strongRate: number; drop: number }
const DOC = JSON.parse(readFileSync(join(REPO, "docs", "data", "intl_adjust.json"), "utf-8")) as { shipped: Record<string, boolean>; rows: Row[] };
const FR = JSON.parse(readFileSync(join(HERE, "..", "..", "public", "data", "format-ratings.json"), "utf-8")) as FormatRatingsFile;

// name pattern, country, the side that is his craft (the one that must not move more than the tolerance)
const ELITE: [RegExp, string][] = [
  [/^Sikandar Raza$/, "Zimbabwe"], [/Muzarabani/, "Zimbabwe"], [/^Rashid Khan$/, "Afghanistan"], [/Gurbaz/, "Afghanistan"], [/Omarzai/, "Afghanistan"],
  [/Mustafizur/, "Bangladesh"], [/Shakib/, "Bangladesh"], [/^Litton Das$/, "Bangladesh"], [/Hasaranga/, "Sri Lanka"], [/Nissanka/, "Sri Lanka"],
  [/Kusal Mendis/, "Sri Lanka"], [/Pathirana/, "Sri Lanka"], [/^Nicholas Pooran$/, "West Indies"], [/^Shai Hope$/, "West Indies"], [/^Andre Russell$/, "West Indies"],
  [/^Alzarri Joseph$/, "West Indies"], [/Athapaththu/, "Sri Lanka"], [/^Hayley Matthews$/, "West Indies"], [/^Nigar Sultana$/, "Bangladesh"],
  [/^Scott Edwards$/, "Netherlands"], [/van Meekeren/, "Netherlands"], [/^George Munsey$/, "Scotland"],
];
/** The side a player is rated on (the better of his two, from the T20 rows) */
function craft(rows: Row[]): "bat" | "bowl" {
  const t20 = rows.filter(r => r.fmt === "t20");
  const bat = t20.find(r => r.side === "bat")?.rating ?? 0, bowl = t20.find(r => r.side === "bowl")?.rating ?? 0;
  return bat >= bowl ? "bat" : "bowl";
}

it("elite players of weaker nations keep their standing", () => {
  const found: string[] = [];
  for (const [re, country] of ELITE) {
    const rows = DOC.rows.filter(r => re.test(r.name) && r.country === country);
    if (rows.length === 0) continue;
    found.push(rows[0].name);
    const side = craft(rows);
    for (const r of rows.filter(x => x.side === side)) {
      // what is shipped: the T20 deltas are zero; the ODI craft side moves by at most 2 rating points
      const shipped = DOC.shipped[r.fmt] ? r.drop : 0;
      expect(shipped, `${r.name} ${r.fmt} ${r.side}`).toBeLessThanOrEqual(2);
      const a = FR.adjust?.[r.id];
      if (a) expect(Math.abs(a[(r.fmt === "t20" ? 0 : 2) + (r.side === "bat" ? 0 : 1)]), `${r.name} shipped`).toBeLessThanOrEqual(2);
    }
  }
  expect(found.length).toBeGreaterThanOrEqual(10);
  if (process.env.ELITE_TABLE) {
    const lines: string[] = ["| player | country | craft | rating | estimate from the record vs strong opposition | strong balls | weak share | ODI after | T20 after |", "|---|---|---|---|---|---|---|---|---|"];
    const players = new Map<string, Row[]>();
    for (const r of DOC.rows) players.set(r.id, [...(players.get(r.id) ?? []), r]);
    const weak = new Set(["Zimbabwe", "Bangladesh", "Afghanistan", "Sri Lanka", "West Indies", "Ireland", "Netherlands", "Scotland", "Nepal", "Namibia", "Oman", "UAE", "USA", "Canada"]);
    for (const [, rows] of [...players].sort((a, b) => a[1][0].country.localeCompare(b[1][0].country) || a[1][0].gender.localeCompare(b[1][0].gender) || Math.max(...b[1].map(r => r.rating)) - Math.max(...a[1].map(r => r.rating)))) {
      if (!weak.has(rows[0].country)) continue;
      const side = craft(rows);
      const t = rows.find(r => r.fmt === "t20" && r.side === side), o = rows.find(r => r.fmt === "odi" && r.side === side);
      if (!t) continue;
      const odiAfter = o ? o.rating - (DOC.shipped.odi ? o.drop : 0) : null;
      lines.push(`| ${t.name} | ${t.country}${t.gender === "female" ? " W" : ""} | ${side} | ${t.rating} | ${t.estimate} | ${t.strongBalls} | ${t.weakShare} | ${odiAfter === null ? "-" : `${o!.rating} -> ${odiAfter}`} | ${t.rating} |`);
    }
    console.log(lines.join("\n"));
  }
});
