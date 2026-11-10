/**
 * Opposition-strength adjustment of national-squad ratings (docs/COUNTRY-VALIDATION.md, "Weak-nation ratings").
 *
 *   npx tsx src/pipeline/generate-intl-adjust.ts [--dry]
 *
 * Players of weaker nations are rated largely from records made against weak opposition (associate and weak-full-member
 * sides, small leagues), which the ratings do not discount enough: such sides read stronger than they play. For each player
 * with an international appearance since 2024 (the app's nations) this estimates what his record against STRONG opposition
 * says about him and moves his rating down toward it, by the share of his record that is against weak opposition. It never
 * raises a rating, and a player whose record against strong opposition is as good as his rating (an elite player from a weak
 * nation) is not moved.
 *
 *  1. Opposition: Bradley-Terry strengths of the national teams from real results since 2019 (T20I and ODI, per gender);
 *     strong = a team at or above the median strength of the full members, plus every delivery of the top franchise leagues
 *     (IPL, BBL, PSL, SA20, CPL, ILT20, MLC, The Hundred; WPL, WBBL). Everything else (weak internationals, other leagues) is weak.
 *  2. Per player and format (T20 = T20 + IT20 incl. leagues; ODI = ODI + ODM): batting and bowling records since 2019, split
 *     strong / weak. Weak share = weak balls / all balls on that side.
 *  3. The strong-opposition estimate E: the shrunk log-rate score of imports.ts' kind (prior at the 25th percentile of the
 *     pooled players' strong rates) of the strong record alone, mapped to a rating by a fit on the pooled players with at least
 *     300 strong balls (score and log balls), per gender and side.
 *  4. delta = -LAMBDA x weakness x max(0, rating - E - 5), with weakness = clamp((weak share - 0.25) / 0.5, 0, 1); capped at 20 points.
 *    An ODI drop is at most the player's T20 drop when he has 300+ T20 balls against strong opposition (top leagues included).
 *
 * Output: `adjust` in app/public/data/format-ratings.json (re-run after generate-format-ratings.ts, which rewrites the file) ({ sourceId: [t20 bat, t20 bowl, odi bat, odi bowl] } deltas, whole
 * points) and data/analysis/intl_adjust_report.json (every player with before / after and his records).
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { calculateBattingOverall, calculateBowlingOverall, type PlayerRatings } from "@ipl-sim/engine";
import { ALL_PLAYERS } from "../all-players.js";
import { WPL_PLAYERS } from "../wpl-players.js";
import { decodeShard, type PoolShard } from "../extended-pool.js";
import { CORE_KEYS, type FormatRatingsFile } from "../format-ratings.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const POOL_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const FR_FILE = new URL("../../../app/public/data/format-ratings.json", import.meta.url).pathname;
const ACT_FILE = FR_FILE;
const DRY = process.argv.includes("--dry");
const LAMBDA = Number(process.env.ADJ_LAMBDA ?? 0.7);
const MAX_DROP = 20;
/**
 * Formats whose deltas are shipped. The T20 adjustment is computed and reported but not shipped: replaying the real T20I fixtures with it
 * made the fit slightly worse (log loss per match men 0.637 -> 0.642, women 0.545 -> 0.553), the ODI one slightly better (men 0.662 -> 0.652,
 * women 0.498 -> 0.496): the strong-opposition record of weak-nation T20 players does not say they are rated too high.
 */
const SHIP: Record<Fmt, boolean> = { t20: false, odi: true };
/** An estimate this close to the rating is noise, not evidence (rating points) */
const DEADZONE = 5;
const MIN_REF_BALLS = 300;
const NATIONS = ["India", "Australia", "England", "South Africa", "New Zealand", "Pakistan", "Sri Lanka", "West Indies", "Bangladesh", "Afghanistan", "Zimbabwe", "Ireland",
  "Netherlands", "Scotland", "Nepal", "United Arab Emirates", "United States of America", "Namibia", "Oman", "Canada", "Kenya", "Thailand"];
const FULL = ["Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland", "New Zealand", "Pakistan", "South Africa", "Sri Lanka", "West Indies", "Zimbabwe"];
const TOP_LEAGUES = ["Indian Premier League", "Big Bash League", "Pakistan Super League", "SA20", "Caribbean Premier League", "International League T20", "Major League Cricket",
  "The Hundred Men's Competition", "Women's Premier League", "Women's Big Bash League", "The Hundred Women's Competition"];
type Gender = "male" | "female";
type Fmt = "t20" | "odi";
const MT: Record<Fmt, string[]> = { t20: ["T20", "IT20"], odi: ["ODI", "ODM"] };

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: DIR, maxBuffer: 2 * 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const log = Math.log;

/** Bradley-Terry strengths from results (MM iterations) */
function bradleyTerry(games: { a: string; b: string; w: string }[]): Map<string, number> {
  const teams = [...new Set(games.flatMap(g => [g.a, g.b]))];
  const p = new Map(teams.map(t => [t, 1]));
  for (let it = 0; it < 200; it++) {
    const next = new Map<string, number>();
    for (const t of teams) {
      let wins = 0.5, den = 0;
      for (const g of games) {
        if (g.a !== t && g.b !== t) continue;
        if (g.w === t) wins++;
        den += 1 / (p.get(g.a)! + p.get(g.b)!);
      }
      next.set(t, wins / Math.max(1e-9, den + 0.5 / p.get(t)!));
    }
    const mean = [...next.values()].reduce((s, v) => s + v, 0) / next.size;
    for (const t of teams) p.set(t, next.get(t)! / mean);
  }
  return new Map(teams.map(t => [t, log(p.get(t)!)]));
}

interface Side { balls: number; runs: number; outs: number }
interface Rec { bat: { s: Side; w: Side }; bowl: { s: Side; w: Side } }
const side = (): Side => ({ balls: 0, runs: 0, outs: 0 });
const newRec = (): Rec => ({ bat: { s: side(), w: side() }, bowl: { s: side(), w: side() } });

interface Pooled { key: string; id: string; name: string; country: string; gender: Gender; t20: PlayerRatings; odi?: PlayerRatings }

function main() {
  const fr = JSON.parse(readFileSync(FR_FILE, "utf8")) as FormatRatingsFile;
  const act = fr as FormatRatingsFile & Record<string, unknown>;
  const pooled: Pooled[] = [];
  for (const g of ["men", "women"] as const) {
    const shard = JSON.parse(gunzipSync(readFileSync(`${POOL_DIR}ca-${g}-senior.json.gz`)).toString()) as PoolShard;
    for (const p of decodeShard(shard)) pooled.push({ key: p.id, id: p.id, name: p.name, country: p.country, gender: g === "men" ? "male" : "female", t20: p.ratings, odi: p.formatRatings?.odi?.ratings });
  }
  for (const [list, g] of [[ALL_PLAYERS, "male"], [WPL_PLAYERS, "female"]] as const) {
    for (const p of list as unknown as { id: string; sourceId?: string; name: string; country: string; ratings: PlayerRatings }[]) {
      const id = p.sourceId ?? p.id;
      const sets = fr.players[id];
      const odi = sets?.[0]?.length >= 9 ? (Object.fromEntries(CORE_KEYS.map((k, j) => [k, sets[0][j]])) as unknown as PlayerRatings) : undefined;
      pooled.push({ key: id, id, name: p.name, country: p.country, gender: g, t20: p.ratings, odi });
    }
  }
  const byId = new Map(pooled.map(p => [p.id, p]));
  const nameKey = (name: string, country: string, g: Gender) => { const w = name.toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").split(" ").filter(Boolean); return `${country}|${g}|${w[w.length - 1]}|${w[0]?.[0]}`; };
  const byName = new Map(pooled.map(p => [nameKey(p.name, p.country, p.gender), p]));

  // international players since 2024 for the app's nations, with their ids
  const people = duck<{ pid: string; name: string; team: string; gender: Gender; ci: string | null; ca: string | null }>(`
WITH pm AS (SELECT d.match_id, d.batter_id pid, d.batting_team team FROM 'deliveries.parquet' d UNION SELECT d.match_id, d.non_striker_id, d.batting_team FROM 'deliveries.parquet' d
  UNION SELECT d.match_id, d.bowler_id, d.bowling_team FROM 'deliveries.parquet' d),
m AS (SELECT match_id, gender FROM 'matches.parquet' WHERE team_type = 'international' AND date >= DATE '2024-01-01'),
pp AS (SELECT DISTINCT pm.pid, pm.team, m.gender FROM pm JOIN m USING(match_id))
SELECT pp.pid, p.name, pp.team, pp.gender, any_value(p.key_cricinfo) ci, any_value(p.key_cricketarchive) ca FROM pp
LEFT JOIN read_csv('../cricsheet/people.csv', header=true, all_varchar=true) p ON p.identifier = pp.pid
WHERE pp.team IN (${NATIONS.map(n => `'${n}'`).join(",")}) GROUP BY pp.pid, p.name, pp.team, pp.gender`);
  const COUNTRY: Record<string, string> = { "United Arab Emirates": "UAE", "United States of America": "USA" };
  const poolOf = (p: { name: string; team: string; gender: Gender; ci: string | null; ca: string | null }) =>
    [p.ci ? `espn_${p.ci}` : "", p.ca ? `ca_${p.ca}` : "", p.ci ? `ca_${9e9 + Number(p.ci)}` : ""].map(i => byId.get(i)).find(Boolean) ?? byName.get(nameKey(p.name, COUNTRY[p.team] ?? p.team, p.gender));
  const pidToPool = new Map<string, Pooled>();
  for (const p of people) { const pl = poolOf(p); if (pl) pidToPool.set(p.pid, pl); }
  // every pooled player with a Cricsheet id (for the regressions): all of people.csv's ids that map to the pool
  const allPeople = duck<{ pid: string; ci: string | null; ca: string | null }>(`SELECT identifier pid, key_cricinfo ci, key_cricketarchive ca FROM read_csv('../cricsheet/people.csv', header=true, all_varchar=true) WHERE key_cricinfo IS NOT NULL OR key_cricketarchive IS NOT NULL`);
  for (const p of allPeople) { if (pidToPool.has(p.pid)) continue; const pl = [p.ci ? `espn_${p.ci}` : "", p.ca ? `ca_${p.ca}` : ""].map(i => byId.get(i)).find(Boolean); if (pl) pidToPool.set(p.pid, pl); }

  const report: Record<string, unknown>[] = [];
  const adjust: Record<string, number[]> = {};
  /** T20 drops by player and side: a player whose T20 record against strong opposition (top leagues included) holds up keeps his ODI rating too */
  const t20Drop = new Map<string, { drop: number; balls: number }>();
  const strengths: Record<string, Record<string, number>> = {};
  for (const g of ["male", "female"] as Gender[]) {
    const games = duck<{ a: string; b: string; w: string }>(`SELECT team1 a, team2 b, winner w FROM 'matches.parquet' WHERE team_type = 'international' AND gender = '${g}' AND date >= DATE '2019-01-01'
      AND match_type IN ('T20', 'IT20', 'ODI', 'ODM') AND winner IS NOT NULL AND (outcome_method IS NULL OR outcome_method = '')`);
    const bt = bradleyTerry(games.filter(x => x.w === x.a || x.w === x.b));
    strengths[g] = Object.fromEntries([...bt].sort((a, b) => b[1] - a[1]).map(([t, v]) => [t, Math.round(v * 100) / 100]));
    const fullS = FULL.filter(t => bt.has(t)).map(t => bt.get(t)!).sort((a, b) => a - b);
    const cut = fullS[Math.floor(fullS.length / 2)];
    const strongTeams = [...bt].filter(([, v]) => v >= cut).map(([t]) => t);
    console.log(`${g}: strong teams (BT >= ${cut.toFixed(2)}): ${strongTeams.join(", ")}`);
    for (const fmt of ["t20", "odi"] as Fmt[]) {
      const types = MT[fmt].map(t => `'${t}'`).join(",");
      const st = strongTeams.map(t => `'${t.replace(/'/g, "''")}'`).join(",");
      const leagues = fmt === "t20" ? TOP_LEAGUES.map(t => `'${t.replace(/'/g, "''")}'`).join(",") : "''";
      const strongSql = `(m.team_type = 'club' AND m.event IN (${leagues})) OR (m.team_type = 'international' AND OPP IN (${st}))`;
      const batRows = duck<{ pid: string; strong: boolean | string; balls: number; runs: number; outs: number }>(`
SELECT d.batter_id pid, (${strongSql.replace("OPP", "d.bowling_team")}) strong, sum(CASE WHEN d.wides = 0 THEN 1 ELSE 0 END)::BIGINT balls, sum(d.runs_batter)::BIGINT runs,
  sum(CASE WHEN d.is_wicket = 1 AND d.player_out_id = d.batter_id AND d.wicket_kind NOT IN ('retired hurt', 'retired not out') THEN 1 ELSE 0 END)::BIGINT outs
FROM 'deliveries.parquet' d JOIN 'matches.parquet' m USING(match_id) WHERE m.match_type IN (${types}) AND m.gender = '${g}' AND m.date >= DATE '2019-01-01' AND d.super_over = 0 GROUP BY 1, 2`);
      const bowlRows = duck<{ pid: string; strong: boolean | string; balls: number; runs: number; outs: number }>(`
SELECT d.bowler_id pid, (${strongSql.replace("OPP", "d.batting_team")}) strong, sum(CASE WHEN d.wides = 0 AND d.noballs = 0 THEN 1 ELSE 0 END)::BIGINT balls, sum(d.runs_batter + d.wides + d.noballs)::BIGINT runs,
  sum(CASE WHEN d.is_wicket = 1 AND d.wicket_kind IN ('bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket') THEN 1 ELSE 0 END)::BIGINT outs
FROM 'deliveries.parquet' d JOIN 'matches.parquet' m USING(match_id) WHERE m.match_type IN (${types}) AND m.gender = '${g}' AND m.date >= DATE '2019-01-01' AND d.super_over = 0 GROUP BY 1, 2`);
      const recs = new Map<string, Rec>();
      for (const [rows, k] of [[batRows, "bat"], [bowlRows, "bowl"]] as const) {
        for (const r of rows) {
          const rec = recs.get(r.pid) ?? newRec(); recs.set(r.pid, rec);
          const s = rec[k][(r.strong === true || r.strong === "true") ? "s" : "w"]; s.balls += r.balls; s.runs += r.runs; s.outs += r.outs;
        }
      }
      // per side: reference players (pooled, of this gender, >= MIN_REF_BALLS strong balls), the prior and the fit
      for (const sd of ["bat", "bowl"] as const) {
        const rating = (p: Pooled) => { const r = fmt === "t20" ? p.t20 : p.odi; return r ? (sd === "bat" ? calculateBattingOverall(r) : calculateBowlingOverall(r)) : NaN; };
        const ref: { pid: string; rec: Rec; pl: Pooled; y: number }[] = [];
        for (const [pid, rec] of recs) { const pl = pidToPool.get(pid); if (!pl || pl.gender !== g) continue; const y = rating(pl); if (Number.isFinite(y) && rec[sd].s.balls >= MIN_REF_BALLS) ref.push({ pid, rec, pl, y }); }
        const sum = (f: (r: { rec: Rec }) => number) => ref.reduce((s, r) => s + f(r), 0);
        const rate = (num: (x: Side) => number) => ref.map(r => num(r.rec[sd].s) / Math.max(1, r.rec[sd].s.balls));
        const pop = { r: sum(r => r.rec[sd].s.runs) / sum(r => r.rec[sd].s.balls), o: sum(r => r.rec[sd].s.outs) / sum(r => r.rec[sd].s.balls) };
        const prior = sd === "bat" ? { r: q(rate(x => x.runs), 0.25), o: q(rate(x => x.outs), 0.75) } : { r: q(rate(x => x.runs), 0.75), o: q(rate(x => x.outs), 0.25) };
        const K = sd === "bat" ? 150 : 180;
        const score = (s: Side) => {
          const r = (s.runs + prior.r * K) / (s.balls + K), o = (s.outs + prior.o * K) / (s.balls + K);
          return sd === "bat" ? log(r / pop.r) - 0.6 * log(o / pop.o) : 0.6 * log(o / pop.o) - log(r / pop.r);
        };
        // y = a + b1 score + b2 ln(balls)
        const xs = ref.map(r => score(r.rec[sd].s)), zs = ref.map(r => Math.log1p(r.rec[sd].s.balls)), ys = ref.map(r => r.y);
        const n = ys.length, m1 = xs.reduce((a, b) => a + b, 0) / n, m2 = zs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
        let s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0, syy = 0;
        for (let i = 0; i < n; i++) { const a = xs[i] - m1, b = zs[i] - m2, y = ys[i] - my; s11 += a * a; s22 += b * b; s12 += a * b; s1y += a * y; s2y += b * y; syy += y * y; }
        const det = s11 * s22 - s12 * s12 || 1;
        const b1 = (s1y * s22 - s2y * s12) / det, b2 = (s2y * s11 - s1y * s12) / det, a0 = my - b1 * m1 - b2 * m2;
        const r2 = (b1 * s1y + b2 * s2y) / (syy || 1);
        console.log(`${g} ${fmt} ${sd}: ${n} reference players, R = ${Math.sqrt(Math.max(0, r2)).toFixed(2)}`);
        for (const p of people) {
          if (p.gender !== g) continue;
          const pl = pidToPool.get(p.pid);
          const rec = recs.get(p.pid);
          if (!pl || !rec) continue;
          const cur = rating(pl);
          if (!Number.isFinite(cur)) continue;
          const total = rec[sd].s.balls + rec[sd].w.balls;
          if (total < 60) continue;
          const weak = rec[sd].w.balls / total;
          const E = Math.min(99, a0 + b1 * score(rec[sd].s) + b2 * Math.log1p(rec[sd].s.balls));
          const weakness = Math.max(0, Math.min(1, (weak - 0.25) / 0.5));
          let drop = Math.min(MAX_DROP, Math.round(LAMBDA * weakness * Math.max(0, cur - E - DEADZONE)));
          if (fmt === "t20") t20Drop.set(`${pl.id}|${sd}`, { drop, balls: rec[sd].s.balls });
          else { const t = t20Drop.get(`${pl.id}|${sd}`); if (t && t.balls >= MIN_REF_BALLS) drop = Math.min(drop, t.drop); }
          const slot = (adjust[pl.id] ??= [0, 0, 0, 0]);
          if (SHIP[fmt]) slot[(fmt === "t20" ? 0 : 2) + (sd === "bat" ? 0 : 1)] = -drop;
          report.push({ id: pl.id, name: pl.name, country: pl.country, gender: g, fmt, side: sd, rating: cur, estimate: Math.round(E), weakShare: Math.round(weak * 100) / 100, strongBalls: rec[sd].s.balls, weakBalls: rec[sd].w.balls,
            strongRate: Math.round((rec[sd].s.runs / Math.max(1, rec[sd].s.balls)) * 600) / 100, drop });
        }
      }
    }
  }
  const nonzero = Object.fromEntries(Object.entries(adjust).filter(([, v]) => v.some(x => x !== 0)));
  console.log(`${Object.keys(nonzero).length} players adjusted of ${Object.keys(adjust).length}`);
  writeFileSync(`${DIR}intl_adjust_report.json`, JSON.stringify({ strengths, rows: report }, null, 0));
  // the committed table: per nation and gender the six best players (by the better side's rating) and every player the adjustment moves by 8 or more
  const REPO_DOC = new URL("../../../../docs/data/intl_adjust.json", import.meta.url).pathname;
  const best = (r: Record<string, unknown>) => r.rating as number;
  const keep = new Set<Record<string, unknown>>();
  for (const key of new Set(report.map(r => `${r.country}|${r.gender}`))) {
    const rows = report.filter(r => `${r.country}|${r.gender}` === key && r.fmt === "t20");
    const byPlayer = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) byPlayer.set(r.id as string, [...(byPlayer.get(r.id as string) ?? []), r]);
    [...byPlayer.values()].sort((a, b) => Math.max(...b.map(best)) - Math.max(...a.map(best))).slice(0, 6).forEach(x => x.forEach(r => keep.add(r)));
  }
  for (const r of report) if ((r.drop as number) >= 8) keep.add(r);
  const ids = new Set([...keep].map(r => r.id as string));
  writeFileSync(REPO_DOC, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), strengths, shipped: SHIP, rows: report.filter(r => ids.has(r.id as string)) }));
  if (DRY) return;
  act.adjust = nonzero;
  writeFileSync(ACT_FILE, JSON.stringify(act));
  console.log(`wrote adjust for ${Object.keys(nonzero).length} players to ${ACT_FILE}`);
}
main();
