/**
 * Extended player pool: every CricketArchive player the ESPN pool does not have.
 *
 *   npx tsx src/pipeline/generate-ca-pool.ts [--gender male|female] [--verify]
 *
 * Inputs (data/analysis/, from the CA analysis scripts):
 *   ca_ratings_by_year.parquet, ca_lower_ratings.parquet, ca_pool_stats.parquet, ca_pool_players.parquet, ca_espn_map.csv
 *   data/scraped/espn-ratings-base.json / espn-ratings-women-base.json (the generator's pool before the ratings model)
 * Output: ../../app/public/pool/ (manifest.json + gzip JSON shards, format in src/extended-pool.ts)
 *
 * Players: every CA player with a senior (Twenty20 / List A / First-Class) or lower-level (event-only) appearance since
 * 2000 who is not already in the ESPN pool (ca_espn_map.csv, plus same name + date of birth for ESPN profiles the map
 * missed). Ids are `ca_<CricketArchive id>`.
 *
 * Ratings use the same code path as the ESPN pool's players Cricsheet can't rate (model-ratings.ts applyModelRatings with
 * ca-model.ts scores): the CA score maps to the overall a Cricsheet-rated player with that score has, without shifting
 * anyone else. The pool's own players are passed through the same call and compared with espn-ratings.json (--verify)
 * so adding the extended pool provably moves none of them. Then the small-sample caps (percentiles taken over the
 * ESPN pool, as before) and, for the extended pool only, ceilings: a player rated only from a lower tier can't rate above
 * a tier-specific percentile of established ESPN players, and one with no usable CA record in a discipline can't rate
 * above the median of players with a real T20 record there.
 * Attribute mix comes from the player's own CA scorecard stats (calculator.ts, as the ESPN generator does with ESPN
 * stats), converted to T20 rates by the population ratio of each format and shrunk toward a below-average prior.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { gzipSync } from "zlib";
import { join } from "path";
import { calculateRatings, inferRole } from "../calculator.js";
import { calculateBattingOverall, calculateBowlingOverall, calculateOverallRating } from "@ipl-sim/engine";
import { applyModelRatings, loadModel, playerKey, battingOvr, bowlingOvr, shiftTo } from "./model-ratings.js";
import { caTunedK, loadCa } from "./ca-model.js";
import { applySmallSampleCaps, type RatedPlayer } from "./generate-ratings-espn.js";
import { TIER_NAMES } from "./event-tiers.js";
import { encodeShard, POOL_VERSION, type PoolManifest, type PoolRow, type PoolShard } from "../extended-pool.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = `${ROOT}data/analysis/`;
const SCRAPED = `${ROOT}data/scraped/`;
const OUT_DIR = new URL("../../../app/public/pool/", import.meta.url).pathname;
const NOW = new Date("2026-11-06T00:00:00Z");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const VERIFY = process.argv.includes("--verify");
/** Lower-level players need this many matches to enter the pool (1 = every rated player) */
const LL_MIN_MATCHES = Number(process.env.LL_MIN_MATCHES ?? 1);
const SHARD_ROWS = 40000;

// ── data access ───────────────────────────────────────────────────────

function duck<T>(sql: string): T[] {
  const out = execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf-8", cwd: ROOT, maxBuffer: 2 * 1024 * 1024 * 1024 });
  return JSON.parse(out || "[]") as T[];
}

interface StatRow {
  player_id: number; gender: string; format: "T20" | "ListA" | "FC"; level: string;
  bat_inns: number; bat_outs: number; bat_runs_all: number; bat_inns_b: number; bat_runs: number; bat_balls: number; bat_outs_b: number;
  bnd_balls: number; fours: number; sixes: number; keeper_inns: number; mean_position: number | null;
  bowl_inns: number; bowl_balls: number; bowl_runs: number; bowl_wkts: number; first_year: number; last_year: number; matches: number;
}
interface ProfileRow {
  player_id: number; name: string; full_name: string | null; dob: string | null; born: string | null; batting_hand: string | null;
  bowling_style: string | null; profile_gender: string | null; nat_team: string | null; modal_country: string | null;
}

// ── lookups ───────────────────────────────────────────────────────────

const CODE_COUNTRY: Record<string, string> = {
  ENG: "England", IND: "India", RSA: "South Africa", AUS: "Australia", PAK: "Pakistan", NZ: "New Zealand", CAN: "Canada",
  SL: "Sri Lanka", WI: "West Indies", BDESH: "Bangladesh", ZIM: "Zimbabwe", IRELAND: "Ireland", UAE: "UAE", SCOT: "Scotland",
  AFG: "Afghanistan", NEP: "Nepal", NAMIB: "Namibia", MAL: "Malaysia", NL: "Netherlands", USA: "USA", HK: "Hong Kong",
  KENYA: "Kenya", DENMARK: "Denmark", BMDA: "Bermuda", GHA: "Ghana", PNG: "Papua New Guinea", MLW: "Malawi", TZN: "Tanzania",
  SKOREA: "South Korea", GERMANY: "Germany", ITALY: "Italy", FRANCE: "France", AUSTRIA: "Austria", BELGIUM: "Belgium",
  JERSEY: "Jersey", GUERNSEY: "Guernsey", CYP: "Cyprus", CZK: "Czech Republic", BULG: "Bulgaria", GREECE: "Greece", FIJI: "Fiji",
  BRAZIL: "Brazil", SING: "Singapore", SINGAPORE: "Singapore", OMAN: "Oman", QATAR: "Qatar", UGANDA: "Uganda", RWN: "Rwanda",
};
const COUNTRY_ALIAS: Record<string, string> = {
  "United States of America": "USA", "United Arab Emirates": "UAE", "England and Wales": "England", Wales: "England",
  "Northern Ireland": "Ireland", "Republic of Ireland": "Ireland", "Hong Kong, China": "Hong Kong", "Papua New Guinea": "Papua New Guinea",
};

function countryOf(p: ProfileRow | undefined): string {
  const clean = (c: string) => COUNTRY_ALIAS[c] ?? c;
  if (p?.nat_team) return clean(p.nat_team.replace(/ Women$/, "").replace(/ Under-?\d+.*$/, ""));
  const born = p?.born?.split(",").map(s => s.trim()).pop();
  if (born && /^[A-Z][A-Za-z .'-]+$/.test(born) && !/^\d/.test(born)) return clean(born);
  const code = p?.modal_country;
  if (code) return CODE_COUNTRY[code] ?? code.charAt(0) + code.slice(1).toLowerCase();
  return "Unknown";
}

type BowlingStyle = RatedPlayer["bowlingStyle"];
function bowlingStyleOf(text: string | null | undefined): BowlingStyle {
  const s = (text ?? "").split(",")[0].toLowerCase().trim();
  const table: [RegExp, BowlingStyle][] = [
    [/^right-arm off-break/, "off-spin"], [/^leg-break/, "leg-spin"], [/^slow left-arm orthodox/, "left-arm-orthodox"],
    [/^slow left-arm (wrist spin|chinaman)/, "left-arm-wrist-spin"],
    [/^right-arm fast-medium/, "right-arm-fast-medium"], [/^right-arm medium-fast/, "right-arm-medium-fast"],
    [/^right-arm medium/, "right-arm-medium"], [/^right-arm fast/, "right-arm-fast"], [/^right-arm slow/, "right-arm-slow"],
    [/^left-arm fast-medium/, "left-arm-fast-medium"], [/^left-arm medium-fast/, "left-arm-medium-fast"],
    [/^left-arm medium/, "left-arm-medium"], [/^left-arm fast/, "left-arm-fast"], [/^left-arm slow/, "left-arm-slow"],
  ];
  for (const [re, v] of table) if (re.test(s)) return v;
  return "unknown";
}

function ageOf(dob: string | null): number {
  const m = dob?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 26;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  let age = NOW.getUTCFullYear() - d.getUTCFullYear();
  if (NOW.getUTCMonth() < d.getUTCMonth() || (NOW.getUTCMonth() === d.getUTCMonth() && NOW.getUTCDate() < d.getUTCDate())) age--;
  return Math.max(15, Math.min(55, age));
}

const normName = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\s-]/gu, " ").replace(/-/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
function namesCompatible(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const sa = a[a.length - 1], sb = b[b.length - 1];
  if (sa !== sb && !a.includes(sb) && !b.includes(sa)) return false;
  const ga = new Set(a.slice(0, -1)), gb = new Set(b.slice(0, -1));
  if ([...ga].some(t => gb.has(t))) return true;
  return a[0][0] === b[0][0];
}

// ── attribute mix from CA scorecard stats ─────────────────────────────

type Fmt = "T20" | "ListA" | "FC";
const FMTS: Fmt[] = ["T20", "ListA", "FC"];
interface Pop { rpb: number; opb: number; bnd: number; brpb: number; wpb: number }

function populationRates(rows: StatRow[], gender: string): Record<Fmt, Pop> {
  const out = {} as Record<Fmt, Pop>;
  for (const f of FMTS) {
    const r = rows.filter(x => x.format === f && x.level === "senior" && x.gender === gender);
    const sum = (k: (x: StatRow) => number) => r.reduce((t, x) => t + k(x), 0);
    out[f] = {
      rpb: sum(x => x.bat_runs) / Math.max(1, sum(x => x.bat_balls)),
      opb: sum(x => x.bat_outs_b) / Math.max(1, sum(x => x.bat_balls)),
      bnd: sum(x => x.fours + x.sixes) / Math.max(1, sum(x => x.bnd_balls)),
      brpb: sum(x => x.bowl_runs) / Math.max(1, sum(x => x.bowl_balls)),
      wpb: sum(x => x.bowl_wkts) / Math.max(1, sum(x => x.bowl_balls)),
    };
  }
  return out;
}

const PRIOR_BAT_BALLS = 90;
const PRIOR_BOWL_BALLS = 120;
/** Prior rates relative to the T20 population: a below-average player (a thin record says little) */
const PRIOR_BAT = { runs: 0.8, outs: 1.2 };
const PRIOR_BOWL = { runs: 1.12, wkts: 0.75 };
/** Players with no senior-level record start from a weaker prior, worth twice the evidence */
const PRIOR_BAT_LOWER = { runs: 0.62, outs: 1.4 };
const PRIOR_BOWL_LOWER = { runs: 1.22, wkts: 0.62 };

function baseRatings(rows: StatRow[], gender: "male" | "female", age: number, pop: Record<Fmt, Pop>) {
  const t = pop.T20;
  const byFmt = (f: Fmt) => rows.filter(r => r.format === f);
  const total = (f: Fmt, k: (x: StatRow) => number) => byFmt(f).reduce((s, x) => s + k(x), 0);
  const batFmt0 = FMTS.find(f => total(f, x => x.bat_balls) >= 60);
  // Most minor-cricket cards record no balls faced: rate the innings by runs and dismissals at the format's average pace
  const batFmt = batFmt0;
  const noBalls = !batFmt ? FMTS.filter(f => total(f, x => x.bat_inns) >= 1).sort((a, b) => total(b, x => x.bat_inns) - total(a, x => x.bat_inns))[0] : undefined;
  const bowlFmt = FMTS.find(f => total(f, x => x.bowl_balls) >= 60);
  let ballsFaced = 0, runs = 0, outs = 0, innings = 0, fours = 0, sixes = 0;
  let ballsBowled = 0, runsConceded = 0, wickets = 0, bowlingInnings = 0;
  if (batFmt) {
    const p = pop[batFmt];
    ballsFaced = total(batFmt, x => x.bat_balls);
    runs = total(batFmt, x => x.bat_runs) * (t.rpb / p.rpb);
    outs = total(batFmt, x => x.bat_outs_b) * (t.opb / p.opb);
    const k = t.bnd / p.bnd;
    const bndBalls = total(batFmt, x => x.bnd_balls);
    const share = bndBalls > 0 ? ballsFaced / bndBalls : 0;
    fours = total(batFmt, x => x.fours) * k * share;
    sixes = total(batFmt, x => x.sixes) * k * share;
    innings = total(batFmt, x => x.bat_inns_b);
  }
  if (noBalls) {
    const p = pop[noBalls];
    ballsFaced = Math.max(1, total(noBalls, x => x.bat_runs_all) / p.rpb);
    runs = total(noBalls, x => x.bat_runs_all) * (t.rpb / p.rpb);
    outs = total(noBalls, x => x.bat_outs) * (t.opb / p.opb);
    fours = ballsFaced * t.bnd * 0.7 * 0.8; sixes = ballsFaced * t.bnd * 0.3 * 0.8;
    innings = total(noBalls, x => x.bat_inns);
  }
  if (bowlFmt) {
    const p = pop[bowlFmt];
    ballsBowled = total(bowlFmt, x => x.bowl_balls);
    runsConceded = total(bowlFmt, x => x.bowl_runs) * (t.brpb / p.brpb);
    wickets = total(bowlFmt, x => x.bowl_wkts) * (t.wpb / p.wpb);
    bowlingInnings = total(bowlFmt, x => x.bowl_inns);
  }
  const lowerOnly = rows.every(r => r.level !== "senior");
  const pb0 = lowerOnly ? PRIOR_BAT_LOWER : PRIOR_BAT, pw0 = lowerOnly ? PRIOR_BOWL_LOWER : PRIOR_BOWL;
  const nb = PRIOR_BAT_BALLS * (lowerOnly ? 2 : 1), nw = PRIOR_BOWL_BALLS * (lowerOnly ? 2 : 1);
  if (ballsFaced > 0) {
    ballsFaced += nb;
    runs += nb * t.rpb * pb0.runs;
    const po = nb * t.opb * pb0.outs;
    outs += po; innings += po;
    const pb = nb * t.bnd * 0.8;
    fours += pb * 0.7; sixes += pb * 0.3;
  }
  if (ballsBowled > 0) {
    ballsBowled += nw;
    runsConceded += nw * t.brpb * pw0.runs;
    wickets += nw * t.wpb * pw0.wkts;
    bowlingInnings += nw / 18;
  }
  // calculator.ts shrinks thin records toward 50 by match count; the pseudo-balls above already shrink toward a
  // below-average prior, so hand it a neutral match count (a 1-match player must not outrate a 50-match weak one)
  const matches = 80;
  const inns = Math.max(innings, Math.round(outs));
  return calculateRatings({
    name: "", age, country: "", matches,
    battingInnings: Math.round(inns), notOuts: Math.max(0, Math.round(inns) - Math.round(outs)), runs: Math.round(runs), ballsFaced: Math.round(ballsFaced),
    fours: Math.round(fours), sixes: Math.round(sixes),
    bowlingInnings: Math.max(ballsBowled > 0 ? 1 : 0, Math.round(bowlingInnings)), ballsBowled: Math.round(ballsBowled), runsConceded: Math.round(runsConceded), wickets: Math.round(wickets),
    catches: 0,
  }, gender === "female" ? "women" : "men");
}

/**
 * Role from what the player does: bowls regularly (>= 35% of his matches, 2+ overs a time) and/or bats in the top 7.
 * Both: an all-rounder unless one side is far weaker. Neither discipline observed (cards with no balls) defaults to batter.
 */
function roleOf(rows: StatRow[], batOvr: number, bowlOvr: number): "batsman" | "bowler" | "all-rounder" {
  const sum = (k: (x: StatRow) => number) => rows.reduce((s, x) => s + k(x), 0);
  const matches = Math.max(1, sum(x => x.matches));
  const bowlInns = sum(x => x.bowl_inns), batInns = sum(x => x.bat_inns);
  const bowls = bowlInns >= 3 && bowlInns / matches >= 0.35 && sum(x => x.bowl_balls) / Math.max(1, bowlInns) >= 12;
  const pos = batInns > 0 ? sum(x => (x.mean_position ?? 11) * x.bat_inns) / batInns : 11;
  const bats = batInns >= 3 && pos <= 7.5;
  if (bowls && bats) return Math.abs(batOvr - bowlOvr) <= 25 ? "all-rounder" : batOvr > bowlOvr ? "batsman" : "bowler";
  if (bowls) return "bowler";
  if (bats || batInns > 0) return bowlInns > 0 && pos > 8 ? "bowler" : "batsman";
  return bowlInns > 0 ? "bowler" : "batsman";
}

// ── main ──────────────────────────────────────────────────────────────

/** Percentile ceilings of established ESPN players, by the lowest tier a player rates from (senior-event ... veterans) */
const TIER_CEILING_PCT = [0.85, 0.70, 0.55, 0.55, 0.40];

interface Built { row: PoolRow; tier: number }

function run(gender: "male" | "female"): { rows: Built[]; stats: Record<string, number> } {
  const baseFile = `${SCRAPED}${gender === "male" ? "espn-ratings-base.json" : "espn-ratings-women-base.json"}`;
  const finalFile = `${SCRAPED}${gender === "male" ? "espn-ratings.json" : "espn-ratings-women.json"}`;
  const espn = JSON.parse(readFileSync(baseFile, "utf-8")) as RatedPlayer[];
  const espnIds = new Set(espn.map(p => Number(p.id.replace(/^espn_/, ""))));

  // CA ids already in the pool
  const caInPool = new Set<number>();
  for (const line of readFileSync(`${DIR}ca_espn_map.csv`, "utf-8").split("\n").slice(1)) {
    const [e, c] = line.split(",");
    if (e && c && espnIds.has(Number(e))) caInPool.add(Number(c));
  }
  // Same full name, country and age as an ESPN pool player the map missed (ESPN profiles without a DOB match)
  const espnKeys = new Set(espn.map(p => `${normName(p.fullName || p.name).join(" ")}|${p.country}|${p.age}`));
  // Same name + date of birth as an ESPN pool player the map missed
  const dupDob = new Map<string, string[][]>();
  const espnPlayers = JSON.parse(readFileSync(`${SCRAPED}espn-players.json`, "utf-8")) as { profile: { espnId: number; name: string; longName: string; dateOfBirth: { year: number; month: number; date: number } | null } }[];
  for (const p of espnPlayers) {
    if (!espnIds.has(Number(p.profile.espnId)) || !p.profile.dateOfBirth) continue;
    const d = p.profile.dateOfBirth;
    const key = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.date).padStart(2, "0")}`;
    const list = dupDob.get(key) ?? [];
    list.push(normName(p.profile.longName || p.profile.name), normName(p.profile.name));
    dupDob.set(key, list);
  }

  const allStats = duck<StatRow>("SELECT * FROM 'data/analysis/ca_pool_stats.parquet'");
  const stats = allStats.filter(r => r.gender === gender);
  const profiles = new Map(duck<ProfileRow>("SELECT * FROM 'data/analysis/ca_pool_players.parquet'").map(p => [Number(p.player_id), p]));
  // A player belongs to the gender he has most matches in (the card's gender can be wrong for the odd match)
  const genderMatches = new Map<number, Record<string, number>>();
  for (const r of allStats) {
    const m = genderMatches.get(Number(r.player_id)) ?? {};
    m[r.gender] = (m[r.gender] ?? 0) + r.matches;
    genderMatches.set(Number(r.player_id), m);
  }
  const dominant = (id: number) => {
    const m = genderMatches.get(id) ?? {};
    return (m.male ?? 0) === (m.female ?? 0) ? profiles.get(id)?.profile_gender : (m.male ?? 0) > (m.female ?? 0) ? "male" : "female";
  };
  const byPlayer = new Map<number, StatRow[]>();
  for (const r of stats) {
    if (dominant(Number(r.player_id)) !== gender) continue;
    const id = Number(r.player_id);
    const list = byPlayer.get(id) ?? [];
    list.push(r);
    byPlayer.set(id, list);
  }
  const pop = populationRates(stats, gender);

  // candidates
  let dupCount = 0;
  const candidates: { id: number; rows: StatRow[]; profile: ProfileRow }[] = [];
  for (const [id, rows] of byPlayer) {
    if (process.env.NO_EXTENDED) break;
    if (caInPool.has(id)) continue;
    const profile = profiles.get(id);
    if (!profile?.name) continue;
    const matches = rows.reduce((s, r) => s + r.matches, 0);
    if (rows.every(r => r.level !== "senior") && matches < LL_MIN_MATCHES) continue;
    if (profile.dob && dupDob.has(profile.dob)) {
      const mine = [normName(profile.name), normName(profile.full_name ?? "")];
      if (dupDob.get(profile.dob)!.some(n => mine.some(m => namesCompatible(m, n)))) { dupCount++; continue; }
    }
    if (espnKeys.has(`${normName(profile.full_name ?? profile.name).join(" ")}|${countryOf(profile)}|${ageOf(profile.dob)}`) ||
        espnKeys.has(`${normName(profile.name).join(" ")}|${countryOf(profile)}|${ageOf(profile.dob)}`)) { dupCount++; continue; }
    candidates.push({ id, rows, profile });
  }

  // CA scores (senior + lower level) and the ESPN pool through the same model call
  const ca = loadCa(gender, { lower: true });
  const caMap = new Map(ca.byEspn);
  for (const [caId, p] of ca.byCa) caMap.set(-caId, p);
  const level = (rows: StatRow[]) => (rows.some(r => r.level === "senior") ? -1 : Math.min(...rows.map(r => Number(r.level.slice(4)))));
  const extended: RatedPlayer[] = candidates.map(c => {
    const age = ageOf(c.profile.dob);
    const ratings = baseRatings(c.rows, gender, age, pop);
    const bat = c.rows.reduce((s, r) => s + r.bat_inns, 0);
    const keeper = c.rows.reduce((s, r) => s + r.keeper_inns, 0);
    const country = countryOf(c.profile);
    const careerBest = FMTS.map(f => c.rows.filter(r => r.format === f)).find(r => r.reduce((s, x) => s + x.matches, 0) > 0) ?? c.rows;
    const sum = (k: (x: StatRow) => number) => careerBest.reduce((s, x) => s + k(x), 0);
    return {
      id: `ca_${c.id}`, name: c.profile.name, fullName: c.profile.full_name ?? c.profile.name, age, country,
      battingHand: /left/i.test(c.profile.batting_hand ?? "") ? "left" : "right",
      bowlingStyle: bowlingStyleOf(c.profile.bowling_style),
      role: inferRole(ratings),
      isWicketKeeper: bat >= 5 && keeper / bat >= 0.5 ? true : undefined,
      isInternational: country !== "India",
      ratings: { battingIQ: ratings.battingIQ, timing: ratings.timing, power: ratings.power, running: ratings.running, wicketTaking: ratings.wicketTaking, economy: ratings.economy, accuracy: ratings.accuracy, clutch: ratings.clutch },
      overalls: { battingOvr: ratings.battingOvr, bowlingOvr: ratings.bowlingOvr, overall: ratings.overall },
      sourceStats: {
        t20Matches: sum(x => x.matches), t20Runs: sum(x => x.bat_runs_all ?? x.bat_runs),
        t20Average: sum(x => x.bat_outs) > 0 ? sum(x => x.bat_runs_all ?? x.bat_runs) / sum(x => x.bat_outs) : 0,
        t20StrikeRate: sum(x => x.bat_balls) > 0 ? (sum(x => x.bat_runs) / sum(x => x.bat_balls)) * 100 : 0,
        t20Fours: sum(x => x.fours), t20Sixes: sum(x => x.sixes), t20Wickets: sum(x => x.bowl_wkts),
        t20Economy: sum(x => x.bowl_balls) > 0 ? (sum(x => x.bowl_runs) / sum(x => x.bowl_balls)) * 6 : 0, statClass: 0,
      },
      espnId: 0,
    } as RatedPlayer;
  });
  const tierOf = new Map(candidates.map((c, i) => [extended[i].id, level(c.rows)]));
  const lastYearOf = new Map(candidates.map((c, i) => [extended[i].id, Math.max(...c.rows.map(r => r.last_year))]));
  const matchesOf = new Map(candidates.map((c, i) => [extended[i].id, c.rows.reduce((s, r) => s + r.matches, 0)]));

  const all = [...espn, ...extended];
  const generated = new Map(all.map(p => [p.id, { bat: battingOvr(p.ratings), bowl: bowlingOvr(p.ratings) }]));
  const report = applyModelRatings(all, loadModel(gender), caMap);
  const caps = applySmallSampleCaps(all, report.evidence, gender, report.t20Unproven, generated, espn);

  // Ceilings for the extended pool
  const K = caTunedK(gender);
  const ev = (p: RatedPlayer, side: "bat" | "bowl") => report.evidence.get(p.id)?.[side] ?? 0;
  const ceilings: Record<string, number[]> = {};
  for (const side of ["bat", "bowl"] as const) {
    const threshold = Math.ceil((K[side] * 0.7) / 0.3 / 100) * 100;
    const ovr = side === "bat" ? battingOvr : bowlingOvr;
    const est = espn.filter(p => ev(p, side) >= threshold).map(p => ovr(p.ratings)).sort((a, b) => a - b);
    ceilings[side] = TIER_CEILING_PCT.map(q => est[Math.floor(q * (est.length - 1))] ?? 99);
    const regulars = espn.filter(p => ev(p, side) >= 240).map(p => ovr(p.ratings)).sort((a, b) => a - b);
    const median = regulars[Math.floor(0.5 * (regulars.length - 1))] ?? 99;
    const keys = side === "bat" ? (["battingIQ", "timing", "power", "running"] as const) : (["wicketTaking", "economy"] as const);
    for (const p of extended) {
      const tier = tierOf.get(p.id)!;
      let cap = tier >= 0 ? ceilings[side][tier] : 99;
      // no usable CA record in this discipline: rated from a thin stat line only
      const c = caMap.get(playerKey(p))?.[side];
      if (!c) cap = Math.min(cap, median);
      if (ovr(p.ratings) > cap) shiftTo(p.ratings, [...keys], ovr, cap);
    }
  }
  // recompute overalls + roles
  for (const p of all) {
    const b = calculateBattingOverall(p.ratings), w = calculateBowlingOverall(p.ratings);
    p.overalls = { battingOvr: b, bowlingOvr: w, overall: calculateOverallRating(b, w) };
  }
  const rowsOf = new Map(candidates.map(c => [`ca_${c.id}`, c.rows]));
  for (const p of extended) p.role = roleOf(rowsOf.get(p.id)!, p.overalls.battingOvr, p.overalls.bowlingOvr);

  const summary: Record<string, number> = {
    espn: espn.length, candidates: candidates.length, duplicatesSkipped: dupCount,
    senior: extended.filter(p => tierOf.get(p.id)! < 0).length,
    capsBat: caps.bat.capped, capsBowl: caps.bowl.capped,
  };
  if (VERIFY) {
    const final = new Map((JSON.parse(readFileSync(finalFile, "utf-8")) as RatedPlayer[]).map(p => [p.id, p]));
    let diff = 0;
    for (const p of espn) {
      const f = final.get(p.id);
      if (!f || JSON.stringify(f.ratings) !== JSON.stringify(p.ratings)) diff++;
    }
    summary.espnRatingsChangedVsCurrent = diff;
  }

  const rows: Built[] = extended.map(p => {
    const tier = tierOf.get(p.id)!;
    const s = p.sourceStats;
    const row: PoolRow = {
      id: Number(p.id.slice(3)), name: p.name, age: p.age, country: p.country, role: p.role,
      ratings: [p.ratings.battingIQ, p.ratings.timing, p.ratings.power, p.ratings.running, p.ratings.wicketTaking, p.ratings.economy, p.ratings.accuracy, p.ratings.clutch],
      bowlingStyle: p.bowlingStyle, battingHand: p.battingHand, isWicketKeeper: !!p.isWicketKeeper,
      matches: matchesOf.get(p.id) ?? 0, runs: s.t20Runs, average: Math.round(s.t20Average * 10) / 10, strikeRate: Math.round(s.t20StrikeRate * 10) / 10,
      wickets: s.t20Wickets, economy: Math.round(s.t20Economy * 100) / 100, lastYear: lastYearOf.get(p.id) ?? 0,
    };
    return { row, tier };
  });
  return { rows, stats: summary };
}

function writeShards(rowsByGender: Record<string, Built[]>): PoolManifest {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: PoolManifest = { version: POOL_VERSION, generated: new Date().toISOString(), shards: [] };
  for (const [gender, built] of Object.entries(rowsByGender)) {
    const groups = new Map<string, PoolRow[]>();
    for (const b of built) {
      const key = b.tier < 0 ? "senior" : `tier${b.tier}`;
      const list = groups.get(key) ?? [];
      list.push(b.row);
      groups.set(key, list);
    }
    for (const [key, rows] of [...groups].sort()) {
      rows.sort((a, b) => ovrOf(b) - ovrOf(a) || a.id - b.id);
      for (let i = 0, n = 1; i < rows.length; i += SHARD_ROWS, n++) {
        const chunk = rows.slice(i, i + SHARD_ROWS);
        const level = key === "senior" ? "senior" : (TIER_NAMES[Number(key.slice(4))] as string);
        const file = `ca-${gender === "male" ? "men" : "women"}-${key}${rows.length > SHARD_ROWS ? `-${n}` : ""}.json.gz`;
        const shard: PoolShard = encodeShard(gender === "male" ? "men" : "women", key, chunk);
        const bytes = gzipSync(Buffer.from(JSON.stringify(shard)), { level: 9 });
        writeFileSync(join(OUT_DIR, file), bytes);
        manifest.shards.push({
          file, gender: gender === "male" ? "men" : "women", tier: key, level, count: chunk.length, bytes: bytes.length,
          topOverall: ovrOf(chunk[0]), minOverall: ovrOf(chunk[chunk.length - 1]),
        });
      }
    }
  }
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}

function ovrOf(r: PoolRow): number {
  const [bi, ti, po, ru, wt, ec, ac, cl] = r.ratings;
  const b = calculateBattingOverall({ battingIQ: bi, timing: ti, power: po, running: ru, wicketTaking: wt, economy: ec, accuracy: ac, clutch: cl });
  const w = calculateBowlingOverall({ battingIQ: bi, timing: ti, power: po, running: ru, wicketTaking: wt, economy: ec, accuracy: ac, clutch: cl });
  return calculateOverallRating(b, w);
}

const only = arg("--gender");
const result: Record<string, Built[]> = {};
for (const g of ["male", "female"] as const) {
  if (only && only !== g) continue;
  const { rows, stats } = run(g);
  result[g] = rows;
  console.log(`${g}:`, JSON.stringify(stats));
}
if (!existsSync(DIR)) throw new Error("no data/analysis");
const manifest = writeShards(result);
for (const s of manifest.shards) console.log(`  ${s.file}: ${s.count} players, ${(s.bytes / 1024).toFixed(0)} KB`);
