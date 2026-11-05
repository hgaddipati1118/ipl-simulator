/**
 * Look up a player in data/cricket.db: profile, every team they've played for, career
 * tables, and every scorecard we have for them with their age on the day.
 *
 * Usage:
 *   npx tsx src/pipeline/player.ts "Virat Kohli"        # name or full name (partial ok)
 *   npx tsx src/pipeline/player.ts 101095               # CricketArchive id
 *   npx tsx src/pipeline/player.ts "Kohli" --json       # machine-readable
 *   npx tsx src/pipeline/player.ts "Kohli" --level Twenty20 --from 2020
 *
 * Run build-db.ts first (and again after more scraping) to refresh the database.
 */

import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './build-db.js';

type Row = Record<string, any>;

function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const query = args.find((a, i) => !a.startsWith('--') && !['--level', '--from', '--to'].includes(args[i - 1]));
  if (!query) {
    console.error('Usage: npx tsx src/pipeline/player.ts "<name or CricketArchive id>" [--json] [--level X] [--from YYYY] [--to YYYY]');
    process.exit(1);
  }
  if (!existsSync(DB_FILE)) {
    console.error(`No ${DB_FILE}; run: npx tsx src/pipeline/build-db.ts`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_FILE, { readOnly: true });

  const candidates = (/^\d+$/.test(query)
    ? db.prepare('SELECT * FROM players WHERE id = ?').all(Number(query))
    : db.prepare(`
        SELECT p.*, (SELECT count(*) FROM appearances a WHERE a.player_id = p.id) AS matches
        FROM players p
        WHERE p.name LIKE ? OR p.full_name LIKE ?
        ORDER BY (p.name = ? OR p.full_name = ?) DESC, matches DESC
        LIMIT 20`).all(`%${query}%`, `%${query}%`, query, query)) as Row[];

  if (candidates.length === 0) {
    console.log(`No player matching "${query}"`);
    return;
  }
  const player = candidates[0];
  const id = player.id as number;

  const teams = db.prepare('SELECT team, level, years FROM player_teams WHERE player_id = ?').all(id) as Row[];
  const careers = db.prepare(`SELECT format, kind, span, row_label, stats FROM player_careers WHERE player_id = ? AND row_label = 'Overall'
                               UNION ALL
                               SELECT format, kind, span, row_label, stats FROM player_careers c WHERE player_id = ?
                                 AND NOT EXISTS (SELECT 1 FROM player_careers o WHERE o.player_id = c.player_id AND o.format = c.format AND o.kind = c.kind AND o.row_label = 'Overall')`)
    .all(id, id) as Row[];

  const level = flag('--level');
  const from = flag('--from');
  const to = flag('--to');
  const games = db.prepare(`
    SELECT a.*, b.positions, b.runs, b.balls, b.fours, b.sixes, b.dismissal, w.overs, w.wickets, w.runs AS runs_conceded
    FROM appearances a
    LEFT JOIN (SELECT match_id, player_id, sum(runs) runs, sum(balls) balls, sum(fours) fours, sum(sixes) sixes,
                      group_concat(dismissal, ' & ') dismissal, group_concat(position, ' & ') positions
               FROM batting GROUP BY match_id, player_id) b ON b.match_id = a.match_id AND b.player_id = a.player_id
    LEFT JOIN (SELECT match_id, player_id, group_concat(overs, ' & ') overs, sum(wickets) wickets, sum(runs) runs
               FROM bowling GROUP BY match_id, player_id) w ON w.match_id = a.match_id AND w.player_id = a.player_id
    WHERE a.player_id = ?
      AND (? IS NULL OR a.levels LIKE '%' || ? || '%')
      AND (? IS NULL OR a.date >= ?)
      AND (? IS NULL OR a.date <= ?)
    ORDER BY a.date`).all(id, level ?? null, level ?? null, from ?? null, from ? `${from}-01-01` : null, to ?? null, to ? `${to}-12-31` : null) as Row[];

  // Every side they've turned out for, from scorecards (complements the profile's team list)
  const sides = db.prepare(`SELECT team, count(*) AS matches, min(date) AS first, max(date) AS last
                            FROM appearances WHERE player_id = ? GROUP BY team ORDER BY first`).all(id) as Row[];

  if (args.includes('--json')) {
    console.log(JSON.stringify({ player, teams, sides, careers: careers.map(c => ({ ...c, stats: JSON.parse(c.stats) })), games }, null, 2));
    return;
  }

  console.log(`${player.full_name ?? player.name}  (CricketArchive ${id})`);
  if (candidates.length > 1) {
    console.log(`  also matched: ${candidates.slice(1, 6).map(c => `${c.full_name ?? c.name} [${c.id}]`).join(', ')}`);
  }
  console.log(`  born ${player.born ?? player.dob ?? '?'} | ${player.gender ?? '?'} | ${player.batting_hand ?? '?'} | ${player.bowling_style ?? 'no bowling style listed'}`);

  console.log(`\nTeams (profile):`);
  for (const t of teams) console.log(`  ${t.team.padEnd(36)} ${t.level.padEnd(26)} ${t.years}`);

  if (sides.length) {
    console.log(`\nTeams (from scorecards we have):`);
    for (const s of sides) console.log(`  ${String(s.team).padEnd(36)} ${String(s.matches).padStart(4)} matches  ${s.first} → ${s.last}`);
  }

  console.log(`\nCareer:`);
  for (const c of careers) {
    const s = JSON.parse(c.stats);
    const line = c.kind === 'batting'
      ? `M ${s.M ?? '-'}  Runs ${s.Runs ?? '-'}  Ave ${s.Ave ?? '-'}  SR ${s.SRate ?? '-'}  HS ${s.HS ?? '-'}`
      : `Balls ${s.Balls ?? '-'}  Wkts ${s.Wkts ?? '-'}  Ave ${s.Ave ?? '-'}  Econ ${s.Econ ?? '-'}  BB ${s.BB ?? '-'}`;
    console.log(`  ${`${c.format} ${c.kind}`.padEnd(40)} ${line}  (${c.span ?? ''})`);
  }

  console.log(`\nScorecards: ${games.length}${level || from || to ? ' (filtered)' : ''}`);
  // Where they bat: list order on the card, counted over innings they actually batted in
  const byPosition = new Map<number, number>();
  for (const g of games) {
    if (g.runs === null || g.runs === undefined) continue;
    for (const pos of String(g.positions ?? '').split(' & ').map(Number).filter(Boolean)) byPosition.set(pos, (byPosition.get(pos) ?? 0) + 1);
  }
  if (byPosition.size > 0) {
    const shown = [...byPosition].sort((a, b) => a[0] - b[0]).map(([pos, n]) => `#${pos} x${n}`).join(', ');
    console.log(`  batting positions: ${shown}`);
  }
  for (const g of games) {
    const batted = g.runs !== null && g.runs !== undefined;
    const pos = batted && g.positions ? `#${String(g.positions).split(' & ').join('&#')} ` : '';
    const bat = batted ? `${pos}${g.runs}${g.balls ? ` (${g.balls}b)` : ''}` : (g.dismissal ?? '');
    const bowl = g.overs ? `  ${g.wickets ?? 0}/${g.runs_conceded ?? '?'} (${g.overs} ov)` : '';
    const age = g.age !== null && g.age !== undefined ? `age ${Number(g.age).toFixed(1)}` : 'age ?';
    const lvl = (JSON.parse(g.levels ?? '[]') as string[]).at(-1) ?? '';
    console.log(`  ${g.date ?? '????-??-??'}  ${age.padEnd(8)}  ${lvl.padEnd(24)} ${String(g.team).padEnd(26)} v ${String(g.opponent).padEnd(26)} bat ${String(bat).padEnd(16)}${bowl}  [${g.match_id}]`);
  }
}

main();
