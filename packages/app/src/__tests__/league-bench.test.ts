import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { EXTRA_LEAGUES, IPL_TEAMS, LEAGUE_HOME, LEAGUE_LEVELS, LEAGUE_RULE_PRESETS, RULE_PRESETS, Team, createPlayerFromData, isOverseasIn, simulateMatch, type Player, type RuleSet, type TeamConfig } from "@ipl-sim/engine";
import { getPoolPlayers, getRealPlayers } from "@ipl-sim/ratings/dist/real-players.js";
import { toRealPlayerData } from "@ipl-sim/ratings/dist/extended-pool.js";
import { createPoolLoader } from "../extended-pool";
import { applyStateWicketsEnv } from "./state-wickets-env";
// SW_OFF / SW_FIRST_OFF / SW_CHASE_OFF / SW_FILE: the state-wickets term switched or replaced (docs/TACTICS.md section 11)
applyStateWicketsEnv();

/**
 * LEAGUE_BENCH=1 [LB_LEAGUES=ipl,psl,bbl,sa20,cpl,ilt20,mlc,hundred-m] [LB_REPLAYS=256] [LB_DUMP=prefix] [LEVELS_FILE=levels.json] [LB_HOME='{"bbl":3}']:
 * the men's league actual-XI match benchmark (docs/TACTICS.md section 10). Every decided match since 2021 of docs/data/league_xi.json
 * (results: league_results.json, generate-league-results.ts) replayed with the eleven that batted for each side in the real batting
 * order (the IPL's twelfth, the impact player or the man he replaced, as the bench, as in impact-player.test.ts), the real home side where the
 * ground is a side's home ground (else neutral), the engine's toss, the league's rules. Log loss per match of the real winner,
 * p = (wins + 1) / (replays + 2) clamped to [0.03, 0.97], on the fit half (to 2024) and the 2025+ holdout. Matches with a player the pool does
 * not have, a D/L result or a franchise the game does not have are left out. LB_HALF=fit|hold plays one half. LB_HOME replaces the leagues' home edges (LEAGUE_HOME,
 * home-advantage.ts; a league absent from it keeps its own, `{}` with LB_HOME_ONLY=1 plays none).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const PUBLIC = join(HERE, "..", "..", "public");

interface XiSide { team: string; xi: (string | null)[]; ov: number[]; off: number; batted: number }
interface XiMatch { id: string; date: string; season: string; sides: XiSide[] }
interface Result { id: string; winner: string | null; method: string | null; city: string | null; venue: string | null; toss: { winner: string; decision: string } | null; batFirst: string | null }

/** Cricsheet franchise names the game knows by another name */
const ALIAS: Record<string, string> = {
  "Royal Challengers Bangalore": "Royal Challengers Bengaluru", "Punjab Kings": "Punjab Kings", "Sharjah Warriors": "Sharjah Warriorz",
  "Jamaica Tallawahs": "Jamaica Kingsmen", "Barbados Royals": "Barbados Tridents", "Durban Super Giants": "Durban's Super Giants",
  // The Hundred's 2026 renamings
  "Oval Invincibles": "MI London", "Northern Superchargers": "Sunrisers Leeds", "Manchester Originals": "Manchester Super Giants",
};
/** The grounds that are a side's home (a Cricsheet venue containing the key), per league; others are neutral */
const HOME: Record<string, Record<string, string[]>> = {
  ipl: { srh: ["Hyderabad"], dc: ["Arun Jaitley", "Feroz Shah Kotla", "Visakhapatnam", "Delhi"], rcb: ["Chinnaswamy"], kkr: ["Eden Gardens"], rr: ["Sawai Mansingh", "Barsapara", "Guwahati"],
    csk: ["Chidambaram", "Chepauk"], mi: ["Wankhede"], pbks: ["Mohali", "Dharamsala", "Mullanpur", "Chandigarh", "Bindra"], gt: ["Narendra Modi", "Ahmedabad"], lsg: ["Ekana", "Lucknow"] },
  bbl: { "bbl-ads": ["Adelaide Oval"], "bbl-brh": ["Brisbane Cricket Ground", "Carrara", "Gabba"], "bbl-hbh": ["Bellerive", "Launceston"], "bbl-mlr": ["Marvel Stadium", "Docklands", "Geelong"],
    "bbl-mls": ["Melbourne Cricket Ground"], "bbl-prs": ["Perth Stadium", "Optus"], "bbl-sys": ["Sydney Cricket Ground"], "bbl-syt": ["Showground", "ENGIE", "Manuka"] },
  psl: { "psl-lq": ["Gaddafi"], "psl-krk": ["Karachi"], "psl-isu": ["Rawalpindi"], "psl-ms": ["Multan"] },
  sa20: { "sa20-dsg": ["Kingsmead"], "sa20-jsk": ["Wanderers"], "sa20-mict": ["Newlands"], "sa20-prl": ["Boland"], "sa20-ptc": ["SuperSport", "Centurion"], "sa20-sec": ["St George"] },
  cpl: { "cpl-abf": ["Vivian Richards"], "cpl-bt": ["Kensington"], "cpl-gaw": ["Providence"], "cpl-jk": ["Sabina"], "cpl-skn": ["Warner Park"], "cpl-slk": ["Gros Islet", "Sammy"], "cpl-tkr": ["Tarouba", "Queen's Park"] },
  ilt20: { "ilt20-adkr": ["Abu Dhabi"], "ilt20-mie": ["Sharjah"], "ilt20-sw": ["Sharjah"] },
  mlc: { "mlc-tsk": ["Grand Prairie"], "mlc-sfu": ["Oakland"], "mlc-lakr": ["Pomona"] },
  "hundred-m": { "hundred-m-bph": ["Edgbaston"], "hundred-m-lds": ["Lord's"], "hundred-m-mil": ["Oval"], "hundred-m-msg": ["Old Trafford"],
    "hundred-m-srl": ["Headingley"], "hundred-m-sbr": ["Rose Bowl"], "hundred-m-trk": ["Trent Bridge"], "hundred-m-wlf": ["Sophia Gardens"] },
};
/** Seasons played in a bubble or hub (packages/ratings/src/analysis/home-advantage.py): neutral, whatever ground a side played at */
const BUBBLE: Record<string, string[]> = { ipl: ["2021", "2022"], psl: ["2021"], cpl: ["2020", "2021"] };
// PSL 2026: Rawalpindiz share Pindi with Islamabad (neither is home when they meet)
HOME.psl["psl-rwp"] = ["Rawalpindi"];

function leagueTeams(lg: string): TeamConfig[] {
  return lg === "ipl" ? IPL_TEAMS : EXTRA_LEAGUES.find(l => l.id === lg)!.teams;
}
function rulesOf(lg: string): RuleSet {
  return { ...(lg === "ipl" ? RULE_PRESETS.modern2026 : LEAGUE_RULE_PRESETS[lg as keyof typeof LEAGUE_RULE_PRESETS]), injuriesEnabled: false } as RuleSet;
}

async function playerMaker(lg: string) {
  const loader = createPoolLoader(async f => new Uint8Array(readFileSync(join(PUBLIC, "pool", f))));
  const data = new Map<string, Parameters<typeof createPlayerFromData>[0]>();
  for (const p of await loader.players("men", ["senior", "tier0"])) data.set(p.id, { ...toRealPlayerData(p), id: p.id });
  for (const p of [...getRealPlayers(), ...getPoolPlayers()]) data.set(p.id, { ...p, teamId: undefined, bid: undefined });
  return (id: string): Player | undefined => {
    const d = data.get(id);
    if (!d) return undefined;
    const p = createPlayerFromData(d);
    p.isInternational = isOverseasIn(lg, d.country);
    return p;
  };
}

it.skipIf(!process.env.LEAGUE_BENCH)("league actual-XI benchmark", async () => {
  const replays = Number(process.env.LB_REPLAYS ?? 256);
  const leagues = (process.env.LB_LEAGUES ?? "ipl,psl,bbl,sa20,cpl").split(",");
  if (process.env.LEVELS_FILE) Object.assign(LEAGUE_LEVELS, JSON.parse(readFileSync(process.env.LEVELS_FILE, "utf-8")));
  if (process.env.LB_HOME_ONLY) for (const k of Object.keys(LEAGUE_HOME)) delete LEAGUE_HOME[k];
  if (process.env.LB_HOME) Object.assign(LEAGUE_HOME, JSON.parse(process.env.LB_HOME));
  const xiAll = JSON.parse(readFileSync(join(REPO, "docs", "data", "league_xi.json"), "utf-8")) as Record<string, XiMatch[]>;
  const resAll = JSON.parse(readFileSync(join(REPO, "docs", "data", "league_results.json"), "utf-8")) as Record<string, Result[]>;
  // The Hundred (men), kept in files of its own (generate-league-xi.ts LXI_LEAGUES)
  Object.assign(xiAll, JSON.parse(readFileSync(join(REPO, "docs", "data", "league_xi_hundred.json"), "utf-8")));
  Object.assign(resAll, JSON.parse(readFileSync(join(REPO, "docs", "data", "league_results_hundred.json"), "utf-8")));
  const from = process.env.LB_FROM ?? "2021-01-01";
  for (const lg of leagues) {
    const make = await playerMaker(lg);
    const configs = leagueTeams(lg);
    const configOf = (name: string) => configs.find(c => c.name === (ALIAS[name] ?? name));
    const res = new Map(resAll[lg].map(r => [r.id, r]));
    const rules = rulesOf(lg);
    const halves = ([["fit", (d: string) => d <= "2024-12-31"], ["hold", (d: string) => d >= "2025-01-01"]] as [string, (d: string) => boolean][])
      .filter(([h]) => !process.env.LB_HALF || process.env.LB_HALF === h);
    for (const [half, inHalf] of halves) {
      let skipped = 0;
      const losses: number[] = [];
      const per: unknown[] = [];
      let bf = 0, n0 = 0, runs = 0, inns = 0, simHome = 0, simHomeN = 0, realHome = 0, realHomeN = 0;
      xiAll[lg].filter(m => m.date >= from && inHalf(m.date)).forEach((m, i) => {
        const r = res.get(m.id);
        if (!r || !r.winner || r.method || m.sides.length !== 2) { skipped++; return; }
        const cfg = m.sides.map(s => configOf(s.team));
        if (cfg.some(c => !c) || cfg[0]!.id === cfg[1]!.id) { skipped++; return; }
        const sides = m.sides.map(s => {
          const keep = s.xi.map((id, j) => ({ id, j })).filter(x => x.j !== s.off);
          const eleven = keep.slice(0, 11).map(x => (x.id ? make(x.id) : undefined));
          const bench = s.off >= 0 && s.xi[s.off] ? [make(s.xi[s.off]!)] : [];
          return { eleven, bench: lg === "ipl" && rules.impactPlayer ? bench : [] };
        });
        if (sides.some(s => s.eleven.length < 11 || s.eleven.some(p => !p) || s.bench.some(p => !p))) { skipped++; return; }
        const bubble = (BUBBLE[lg] ?? []).includes(m.date.slice(0, 4));
        const homes = cfg.map(c => !bubble && (HOME[lg]?.[c!.id] ?? []).some(k => (r.venue ?? "").includes(k)));
        const homeIdx = homes[0] && !homes[1] ? 0 : homes[1] && !homes[0] ? 1 : -1;
        const order = homeIdx === 1 ? [1, 0] : [0, 1];
        const teams = order.map(k => {
          const t = new Team(cfg[k]!);
          const el = sides[k].eleven as Player[];
          t.roster = [...el, ...(sides[k].bench as Player[])];
          t.isUserControlled = true;
          t.userPlayingXI = el.map(p => p.id);
          t.userBattingOrder = el.map(p => p.id);
          return { t, name: m.sides[k].team };
        });
        let w = 0, n = 0;
        for (let j = 0; j < replays; j++) {
          const sim = simulateMatch(teams[0].t, teams[1].t, rules, 7919 * i + 104729 * (j + 1), { countTowardStandings: false, neutralVenue: homeIdx < 0 });
          if (!sim.winnerId) continue;
          n++;
          if ((sim.winnerId === teams[0].t.id ? teams[0].name : teams[1].name) === r.winner) w++;
          if (sim.winnerId === sim.innings[0].teamId) bf++;
          if (homeIdx >= 0) { simHomeN++; if (sim.winnerId === teams[0].t.id) simHome++; }
          n0++;
          for (const inn of sim.innings) { runs += inn.runs; inns++; }
        }
        if (homeIdx >= 0) { realHomeN++; if (r.winner === teams[0].name) realHome++; }
        const p = Math.min(0.97, Math.max(0.03, (w + 1) / (n + 2)));
        losses.push(-Math.log(p));
        const top = (v: number[], k: number) => [...v].sort((x, y) => y - x).slice(0, k).reduce((x, y) => x + y, 0) / k;
        per.push({ id: m.id, date: m.date, winner: r.winner, home: homeIdx < 0 ? -1 : 0, toss: r.toss, batFirst: r.batFirst, venue: r.venue, w, n,
          sides: order.map(k => { const el = sides[k].eleven as Player[]; return { name: m.sides[k].team, ovr: top(el.map(p => p.overall), 11), bat: top(el.map(p => p.battingOvr), 7), bowl: top(el.map(p => p.bowlingOvr), 5), os: el.filter(p => p.isInternational).length, ids: el.map(p => p.sourceId ?? p.id), pl: el.map(p => [p.overall, p.battingOvr, p.bowlingOvr, p.isInternational ? 1 : 0, p.age, p.careerStats?.m ?? -1, p.experience ?? -1]) }; }) });
      });
      const mean = losses.reduce((a, b) => a + b, 0) / Math.max(1, losses.length);
      const sd = Math.sqrt(losses.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, losses.length - 1));
      console.log(`${lg} ${half}: ${losses.length} matches (${skipped} left out), ${replays} replays: log loss ${mean.toFixed(4)} +- ${(sd / Math.sqrt(Math.max(1, losses.length))).toFixed(4)} | bat-first wins ${(bf / Math.max(1, n0)).toFixed(3)} | runs/inns ${(runs / Math.max(1, inns)).toFixed(1)} | home side won: sim ${(simHome / Math.max(1, simHomeN)).toFixed(3)}, real ${(realHome / Math.max(1, realHomeN)).toFixed(3)} of ${realHomeN}`);
      if (process.env.LB_DUMP) writeFileSync(`${process.env.LB_DUMP}-${lg}-${half}.json`, JSON.stringify(per));
    }
  }
}, 14_400_000);
