/**
 * Before / after check for pricing fielding and keeping: run the CPU retention + mega auction on the game's real data
 * (the ten IPL squads retain, the rest go into the pool with the 2000+ unrostered ESPN-rated players) over several
 * seeds and print the spend per team, the most expensive players and the keepers.
 *
 *   npx tsx packages/engine/src/__tests__/benchmark-auction-value.ts [seeds=16]
 *   ENGINE=/path/to/old/dist/index.js npx tsx packages/engine/src/__tests__/benchmark-auction-value.ts 16   (the "before")
 *
 * docs/RULES-AUCTION.md section 9 has the numbers.
 */
import { pathToFileURL } from "node:url";
import { getRealPlayers, getPoolPlayers } from "../../../ratings/src/real-players.js";

const SEEDS = Number(process.argv[2] ?? 16);
const E: any = await import(process.env.ENGINE ? pathToFileURL(process.env.ENGINE).href : "../index.js");

const perTeam = new Map<string, number[]>();
const price = new Map<string, { name: string; sum: number; n: number; ovr: number; keeping: number | undefined; fielding: number | undefined; wk: boolean }>();
let total = 0, retainedTotal = 0, sold = 0, unsold = 0, noKeeper = 0, keeperTeams = 0, bestKeeperKeeping = 0, bestKeeperTeams = 0;
const keeperPrices: number[] = [];
const tiers: Record<string, number[]> = { "keeping 65+": [], "keeping 55-64": [], "keeping <55": [] };

for (let s = 0; s < SEEDS; s++) {
  const teams = E.IPL_TEAMS.map((c: any) => new E.Team(c, 120));
  for (const d of getRealPlayers()) {
    const t = teams.find((x: any) => x.id === d.teamId);
    if (t) t.addPlayer(E.createPlayerFromData({ ...d }), d.bid ?? 1);
  }
  const pool: any[] = [];
  for (const t of teams) {
    const { released } = E.retainPlayers(t);
    pool.push(...released);
    retainedTotal += t.totalSpent;
  }
  // Each seed auctions a random 40% of the unrostered pool (the same sample for any engine), so the average over seeds is
  // not one pool's accident: with 5,000 unsigned players and money for ~130 of them, who happens to rank first decides the prices
  let st = 7919 * (s + 1);
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const d of getPoolPlayers()) if (rnd() < 0.4) pool.push(E.createPlayerFromData({ ...d }));
  const res = E.runAuction(pool, teams, {}, E.createRNG(1000 + s));
  sold += res.bids.length; unsold += res.unsold.length;
  const byId = new Map<string, any>(pool.map(p => [p.id, p]));
  for (const t of teams) {
    const arr = perTeam.get(t.id) ?? [];
    arr.push(t.totalSpent);
    perTeam.set(t.id, arr);
    total += t.totalSpent;
    const keepers = t.roster.filter((p: any) => p.isWicketKeeper);
    if (keepers.length === 0) noKeeper++; else {
      keeperTeams++;
      const best = keepers.reduce((a: any, b: any) => (E.keepingRating(b) > E.keepingRating(a) ? b : a));
      bestKeeperKeeping += E.keepingRating(best); bestKeeperTeams++;
    }
  }
  for (const b of res.bids) {
    if (b.round === 0) continue; // free-agent fill at base price
    const p = byId.get(b.playerId);
    if (!p) continue;
    const key = p.sourceId ?? p.name;
    const e = price.get(key) ?? { name: p.name, sum: 0, n: 0, ovr: p.overall, keeping: p.ratings.keeping, fielding: p.ratings.fielding, wk: p.isWicketKeeper };
    e.sum += b.amount; e.n++;
    price.set(key, e);
    if (p.isWicketKeeper) {
      keeperPrices.push(b.amount);
      const k = E.keepingRating(p);
      tiers[k >= 65 ? "keeping 65+" : k >= 55 ? "keeping 55-64" : "keeping <55"].push(b.amount / Math.max(1, E.calculateMarketValue({ age: p.age, role: p.role, isInternational: p.isInternational, isWicketKeeper: true, battingOvr: p.battingOvr, bowlingOvr: p.bowlingOvr })));
    }
  }
}

{
  const mv = getRealPlayers().map((d: any) => E.createPlayerFromData({ ...d })).map((p: any) => p.marketValue).sort((a: number, b: number) => b - a);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  console.log(`marketValue of the ${mv.length} rostered real players: total ${sum(mv).toFixed(1)} Cr, top 20 ${sum(mv.slice(0, 20)).toFixed(1)}, top 100 ${sum(mv.slice(0, 100)).toFixed(1)}, median ${mv[Math.floor(mv.length / 2)].toFixed(2)}`);
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`${SEEDS} seeds, ${process.env.ENGINE ? "ENGINE=" + process.env.ENGINE : "current engine"}`);
console.log(`total spend (retention + auction), mean over seeds: ${(total / SEEDS).toFixed(1)} Cr  (retention part ${(retainedTotal / SEEDS).toFixed(1)}); sold ${(sold / SEEDS).toFixed(1)}, unsold ${(unsold / SEEDS).toFixed(0)}`);
console.log("per-team spend (Cr, mean over seeds):");
for (const [id, a] of [...perTeam.entries()].sort()) console.log(`  ${id.padEnd(5)} ${mean(a).toFixed(1)}`);
console.log(`teams ending without a keeper: ${noKeeper} of ${SEEDS * 10}; mean keeping of the best keeper per team ${(bestKeeperKeeping / Math.max(1, bestKeeperTeams)).toFixed(1)}`);
{
  const ks = [...keeperPrices].sort((a, b) => b - a);
  console.log(`keepers sold per seed ${(ks.length / SEEDS).toFixed(1)}; priced 8+ Cr: ${(ks.filter(x => x >= 8).length / SEEDS).toFixed(2)}, 12+ Cr: ${(ks.filter(x => x >= 12).length / SEEDS).toFixed(2)} per seed; median ${ks[Math.floor(ks.length / 2)]?.toFixed(2)}`);
}
console.log(`mean price of keepers sold in the auction (excl. base-price fills): ${keeperPrices.length ? mean(keeperPrices).toFixed(2) : "n/a"} Cr (n=${keeperPrices.length})`);
for (const [k, a] of Object.entries(tiers)) console.log(`  keepers ${k}: n=${a.length}, price / (market value without fielding and keeping) ${a.length ? mean(a).toFixed(2) : "n/a"}`);
const top = [...price.values()].filter(e => e.n >= 3).map(e => ({ ...e, avg: e.sum / e.n })).sort((a, b) => b.avg - a.avg).slice(0, 20);
console.log("top 20 by mean auction price (players sold in at least 3 seeds):");
for (const e of top) console.log(`  ${e.name.padEnd(24)} ${e.avg.toFixed(2).padStart(6)} Cr  sold in ${e.n}/${SEEDS}  ovr ${e.ovr}  fielding ${e.fielding ?? "-"}  keeping ${e.keeping ?? "-"}${e.wk ? "  WK" : ""}`);
const all = [...price.values()].map(e => e.sum / e.n).sort((a, b) => b - a);
console.log(`price distribution (mean per player, auction buys): p50 ${all[Math.floor(all.length * 0.5)]?.toFixed(2)}, p90 ${all[Math.floor(all.length * 0.1)]?.toFixed(2)}, p99 ${all[Math.floor(all.length * 0.01)]?.toFixed(2)}, max ${all[0]?.toFixed(2)}`);
