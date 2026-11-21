/**
 * The results of the league matches of docs/data/league_xi.json (docs/TACTICS.md section 10, the league actual-XI benchmark): for each
 * match its winner (null for a tie or no result; a super-over winner counts), the method (D/L), the city and venue, the toss and the side
 * that batted first, read from the same Cricsheet json files. Kept apart from league_xi.json so that file (and the fits on it) stay as
 * they are.
 *
 *   npx tsx src/pipeline/generate-league-results.ts      (reads data/cricsheet/<league>_json/*.json)   -> docs/data/league_results.json
 *   LXI_IN=../../docs/data/league_xi_hundred.json LXI_OUT=../../docs/data/league_results_hundred.json npx tsx src/pipeline/generate-league-results.ts
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const CS = `${ROOT}data/cricsheet/`;
const XI = new URL("../../../../docs/data/league_xi.json", import.meta.url).pathname;
const OUT = new URL("../../../../docs/data/league_results.json", import.meta.url).pathname;
const FOLDER: Record<string, string> = {
  ipl: "ipl_json", bbl: "bbl_json", psl: "psl_json", sa20: "sat_json", cpl: "cpl_json", ilt20: "ilt_json", mlc: "mlc_json", bpl: "bpl_json", lpl: "lpl_json",
  "hundred-m": "hnd_json",
};

interface CsInfo {
  city?: string; venue?: string; teams: string[];
  toss?: { winner: string; decision: string };
  outcome?: { winner?: string; eliminator?: string; method?: string; result?: string };
}

function main() {
  const xi = JSON.parse(readFileSync(process.env.LXI_IN ?? XI, "utf-8")) as Record<string, { id: string }[]>;
  const out: Record<string, unknown[]> = {};
  for (const [lg, list] of Object.entries(xi)) {
    const rows: unknown[] = [];
    for (const m of list) {
      const file = `${CS}${FOLDER[lg]}/${m.id}.json`;
      if (!existsSync(file)) continue;
      const cs = JSON.parse(readFileSync(file, "utf-8")) as { info: CsInfo; innings?: { team: string; super_over?: boolean }[] };
      const i = cs.info;
      const first = (cs.innings ?? []).find(x => !x.super_over)?.team ?? null;
      rows.push({
        id: m.id, winner: i.outcome?.winner ?? i.outcome?.eliminator ?? null, method: i.outcome?.method ?? null, result: i.outcome?.result ?? null,
        city: i.city ?? null, venue: i.venue ?? null, toss: i.toss ?? null, batFirst: first,
      });
    }
    out[lg] = rows;
    console.log(`${lg}: ${rows.length} matches, ${rows.filter(r => (r as { winner: string | null }).winner).length} decided`);
  }
  const outFile = process.env.LXI_OUT ?? OUT;
  writeFileSync(outFile, JSON.stringify(out));
  console.log("wrote " + outFile);
}
main();
