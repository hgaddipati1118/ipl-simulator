// Export the sweep's input: everything from the last N days that players agreed to share
// (consent_sweep = 1), as one JSON file the routine reads. Run from packages/server:
//   node sweep/export-input.mjs [--days 1] [--local] [--out sweep-input.json]
// --local reads the `wrangler dev` database; otherwise the deployed D1 (needs CLOUDFLARE_API_TOKEN).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const days = parseInt(arg("--days", "1"), 10);
const out = arg("--out", "sweep-input.json");
const where = args.includes("--local") ? "--local" : "--remote";

function query(sql) {
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "ipl-sim-mods", where, "--json", "--command", sql], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(raw)[0].results;
}

const since = `datetime('now', '-${days} days')`;
const shared = "user_id IN (SELECT id FROM users WHERE consent_sweep = 1)";

const input = {
  exportedAt: new Date().toISOString(),
  days,
  prompts: query(`SELECT id, user_id, text, result_kind, result_id, attempts, created_at FROM prompts WHERE ${shared} AND created_at >= ${since}`),
  mods: query(`SELECT id, author_id, name, manifest, hash, parent_mod_id, created_at FROM mods
               WHERE author_id IN (SELECT id FROM users WHERE consent_sweep = 1) AND created_at >= ${since}`),
  codeChanges: query(`SELECT id, user_id, prompt_id, branch, base_sha, diff_key, build_status, created_at FROM code_changes WHERE ${shared} AND created_at >= ${since}`),
  // Adoption: how many sharing players have each mod enabled, and how recently it was used
  adoption: query(`SELECT m.id AS mod_id, m.name, count(*) AS installs, sum(i.enabled) AS enabled, max(i.last_used_at) AS last_used
                   FROM mod_installs i JOIN mods m ON m.id = i.mod_id
                   WHERE i.user_id IN (SELECT id FROM users WHERE consent_sweep = 1) GROUP BY m.id`),
  events: query(`SELECT kind, mod_id, count(*) AS n FROM events WHERE created_at >= ${since} GROUP BY kind, mod_id`),
  openClusters: query(`SELECT id, summary, user_count, first_seen, last_seen, status FROM intent_clusters WHERE status IN ('open', 'proposed')`),
};

writeFileSync(out, JSON.stringify(input, null, 2));
console.log(`Wrote ${out}: ${input.prompts.length} prompts, ${input.mods.length} mods, ${input.codeChanges.length} code changes`);
