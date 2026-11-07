/**
 * Add `fielding` / `keeping` to the committed player files (src/all-players.ts, src/wpl-players.ts) without
 * regenerating anything else: a full run of generate-ratings-espn.ts re-reads every source on disk and can move
 * unrelated ratings, so this inserts only the two new fields (same rules as the generator's applyFielding).
 * Idempotent: existing fielding / keeping fields are replaced.
 *
 *   npx tsx src/pipeline/patch-fielding.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { applyFieldingRatings, fieldingAvailable, type FieldingTarget } from "./fielding-model.js";

const FILES: { path: string; gender: "male" | "female" }[] = [
  { path: new URL("../all-players.ts", import.meta.url).pathname, gender: "male" },
  { path: new URL("../wpl-players.ts", import.meta.url).pathname, gender: "female" },
];

function patch(path: string, gender: "male" | "female"): void {
  const text = readFileSync(path, "utf-8");
  // One player entry per "  {\n    id: ...  }," block; ratings are on one line
  const entryRe = /  \{\n    id: "((?:espn_(\d+))|manual_\w+)"[\s\S]*?\n  \}/g;
  const targets = new Map<string, FieldingTarget>();
  for (const m of text.matchAll(entryRe)) {
    targets.set(m[1], { id: m[1], espnId: Number(m[2] ?? 0), isWicketKeeper: /\n    isWicketKeeper: true,/.test(m[0]), ratings: {} });
  }
  const res = applyFieldingRatings([...targets.values()], gender);
  let patched = 0;
  const out = text.replace(entryRe, (block, id: string) => {
    const t = targets.get(id)!;
    return block.replace(/(clutch: \d+)(?:, fielding: \d+)?(?:, keeping: \d+)? \},/, (_all, c: string) => {
      patched++;
      return `${c}${t.ratings.fielding !== undefined ? `, fielding: ${t.ratings.fielding}` : ""}${t.ratings.keeping !== undefined ? `, keeping: ${t.ratings.keeping}` : ""} },`;
    });
  });
  writeFileSync(path, out, "utf-8");
  console.log(`${path}: ${targets.size} players, fielding ${res.fielding}, keeping ${res.keeping}, not in Cricsheet ${res.unmatched}, lines patched ${patched}`);
}

if (!fieldingAvailable()) throw new Error("data/analysis/fielding_ratings.csv missing (run src/analysis/fielding-stats.sql + fielding-ratings.py)");
for (const f of FILES) patch(f.path, f.gender);
