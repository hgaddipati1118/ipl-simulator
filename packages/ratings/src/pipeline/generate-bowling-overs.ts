/**
 * The over-by-over bowling record of the matches the bowling-attack fit uses (docs/TACTICS.md section 8): for every match of
 * docs/data/league_xi.json (the nine men's leagues since 2021) and of docs/data/actual_xi.json's men's T20Is, each bowling side's
 * innings as a list of overs [bowler, runs, the bowler's wickets], where `bowler` is the index of the over's bowler in the side's
 * player list of those files (the order of the batting card, then the players who did not bat: the same order both files use).
 *
 *   npx tsx src/pipeline/generate-bowling-overs.ts            -> docs/data/bowling_overs.json
 *
 * Runs are every run of the over (extras included); wickets are those credited to the bowler (not run outs, retirements or
 * obstruction). The first two innings only (no super overs). A bowler who is not in the side's list (a substitute fielder who bowled:
 * never in the data so far) is -1.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const CS = `${ROOT}data/cricsheet/`;
const DOCS = new URL("../../../../docs/data/", import.meta.url).pathname;

const FOLDERS: Record<string, string> = { ipl: "ipl_json", bbl: "bbl_json", psl: "psl_json", sa20: "sat_json", cpl: "cpl_json", ilt20: "ilt_json", mlc: "mlc_json", bpl: "bpl_json", lpl: "lpl_json" };
const NOT_BOWLER = new Set(["run out", "retired hurt", "retired out", "obstructing the field", "retired not out"]);

interface Delivery { batter: string; bowler: string; non_striker: string; runs: { total: number }; wickets?: { kind: string }[] }
interface CsMatch { info: { players: Record<string, string[]>; teams: string[] }; innings?: { team: string; overs?: { over: number; deliveries: Delivery[] }[]; super_over?: boolean }[] }

/** A side's players in the order of its batting card, then those who did not bat (generate-league-xi.ts, generate-actual-xi.ts) */
function ordered(cs: CsMatch, team: string): string[] {
  const names = cs.info.players[team] ?? [];
  const bats: string[] = [];
  const inn = (cs.innings ?? []).find(i => i.team === team && !i.super_over);
  for (const o of inn?.overs ?? []) for (const d of o.deliveries) for (const n of [d.batter, d.non_striker]) if (!bats.includes(n)) bats.push(n);
  return [...bats.filter(n => names.includes(n)), ...names.filter(n => !bats.includes(n))];
}

/** The innings `team` bowled in: [innings number (1, 2), overs] */
function bowled(cs: CsMatch, team: string): { inn: number; overs: [number, number, number][] } | null {
  const list = (cs.innings ?? []).filter(i => !i.super_over).slice(0, 2);
  const k = list.findIndex(i => i.team !== team);
  if (k < 0) return null;
  const names = ordered(cs, team);
  const overs: [number, number, number][] = [];
  for (const o of list[k].overs ?? []) {
    const ds = o.deliveries;
    if (ds.length === 0) continue;
    let runs = 0, wk = 0;
    for (const d of ds) { runs += d.runs.total; for (const w of d.wickets ?? []) if (!NOT_BOWLER.has(w.kind)) wk++; }
    overs[o.over] = [names.indexOf(ds[0].bowler), runs, wk];
  }
  return { inn: k + 1, overs: Array.from(overs, x => x ?? [-1, 0, 0]) };
}

function main() {
  const league = JSON.parse(readFileSync(`${DOCS}league_xi.json`, "utf-8")) as Record<string, { id: string; sides: { team: string }[] }[]>;
  const actual = JSON.parse(readFileSync(`${DOCS}actual_xi.json`, "utf-8")) as Record<string, { id: string; a: string; b: string }[]>;
  const out: { league: Record<string, Record<string, unknown>>; t20i: Record<string, Record<string, unknown>> } = { league: {}, t20i: {} };
  for (const [lg, ms] of Object.entries(league)) {
    let n = 0;
    for (const m of ms) {
      const file = `${CS}${FOLDERS[lg]}/${m.id}.json`;
      if (!existsSync(file)) continue;
      const cs = JSON.parse(readFileSync(file, "utf-8")) as CsMatch;
      out.league[m.id] = Object.fromEntries(m.sides.map(s => [s.team, bowled(cs, s.team)]));
      n++;
    }
    console.log(`${lg}: ${n}`);
  }
  let n = 0;
  for (const m of actual["t20i-men"] ?? []) {
    const file = `${CS}t20s_json/${m.id}.json`;
    if (!existsSync(file)) continue;
    const cs = JSON.parse(readFileSync(file, "utf-8")) as CsMatch;
    out.t20i[m.id] = { a: bowled(cs, m.a), b: bowled(cs, m.b) };
    n++;
  }
  console.log(`t20i-men: ${n}`);
  writeFileSync(`${DOCS}bowling_overs.json`, JSON.stringify(out));
}
main();
