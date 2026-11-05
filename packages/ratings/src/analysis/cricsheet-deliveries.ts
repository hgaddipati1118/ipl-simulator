/**
 * Flatten every Cricsheet match (data/cricsheet/all_json, all formats) into two Parquet
 * tables for ratings analysis:
 *   data/analysis/deliveries.parquet  one row per ball
 *   data/analysis/matches.parquet     one row per match
 * plus data/analysis/people.parquet (Cricsheet register: cricsheet id -> cricinfo / CricketArchive ids).
 *
 * Player columns use Cricsheet register ids (match.info.registry.people), so a player is the
 * same person across leagues and formats even when the display name changes.
 *
 * Usage: npx tsx src/analysis/cricsheet-deliveries.ts   (needs the duckdb CLI)
 */

import { execFileSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DATA = new URL('../../data', import.meta.url).pathname;
// env overrides exist so the audit tests (src/analysis/__tests__/ball_handling.test.py) can run this exact code on synthetic matches
const MATCH_DIR = process.env.RATINGS_MATCH_DIR ?? join(DATA, 'cricsheet/all_json');
const OUT = process.env.RATINGS_OUT_DIR ?? join(DATA, 'analysis');

const DELIVERY_COLS = [
  'match_id', 'innings', 'batting_team', 'bowling_team', 'over', 'ball', 'legal_ball_no',
  'batter_id', 'batter', 'bowler_id', 'bowler', 'non_striker_id',
  'runs_batter', 'runs_extras', 'runs_total', 'wides', 'noballs', 'byes', 'legbyes',
  'is_wicket', 'wicket_kind', 'player_out_id', 'fielder_ids', 'super_over',
  // audit additions: penalty runs, non-boundary fours/sixes, retirements that are not dismissals, wickets on the ball, innings context
  'penalty', 'non_boundary', 'retired_kind', 'retired_player_id', 'wickets_on_ball', 'inn_pp_end', 'inn_target_overs', 'inn_target_runs',
];
const MATCH_COLS = [
  'match_id', 'date', 'season', 'match_type', 'gender', 'team_type', 'event', 'stage', 'match_number',
  'team1', 'team2', 'venue', 'city', 'winner', 'result', 'toss_winner', 'toss_decision',
  'overs', 'balls_per_over', 'player_of_match_ids', 'outcome_method',
];

function csv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function line(values: unknown[]): string {
  return values.map(csv).join(',') + '\n';
}

async function main() {
  if (!existsSync(MATCH_DIR)) throw new Error(`Missing ${MATCH_DIR}; download Cricsheet all_json first`);
  mkdirSync(OUT, { recursive: true });
  const deliveriesCsv = join(OUT, 'deliveries.csv');
  const matchesCsv = join(OUT, 'matches.csv');
  const del = createWriteStream(deliveriesCsv);
  const mat = createWriteStream(matchesCsv);
  del.write(DELIVERY_COLS.join(',') + '\n');
  mat.write(MATCH_COLS.join(',') + '\n');

  const files = readdirSync(MATCH_DIR).filter(f => f.endsWith('.json'));
  let balls = 0;
  for (const [n, file] of files.entries()) {
    const matchId = file.replace('.json', '');
    const m = JSON.parse(readFileSync(join(MATCH_DIR, file), 'utf-8'));
    const info = m.info ?? {};
    const people: Record<string, string> = info.registry?.people ?? {};
    const pid = (name?: string) => (name ? people[name] ?? null : null);
    const [team1, team2] = info.teams ?? [];
    const outcome = info.outcome ?? {};
    const result = outcome.winner
      ? `won by ${Object.entries(outcome.by ?? {}).map(([k, v]) => `${v} ${k}`).join(' ')}`.trim()
      : outcome.result ?? null;

    mat.write(line([
      matchId, info.dates?.[0], info.season, info.match_type, info.gender, info.team_type,
      info.event?.name, info.event?.stage, info.event?.match_number, team1, team2, info.venue, info.city,
      outcome.winner, result, info.toss?.winner, info.toss?.decision, info.overs, info.balls_per_over,
      (info.player_of_match ?? []).map((p: string) => pid(p) ?? p).join(';'),
      outcome.method,
    ]));

    (m.innings ?? []).forEach((inn: any, i: number) => {
      const battingTeam = inn.team;
      const bowlingTeam = battingTeam === team1 ? team2 : team1;
      // last over index of the mandatory powerplay (T20: 5, i.e. overs 0-5; The Hundred: 4, i.e. the first five 5-ball sets)
      const ppTo = (inn.powerplays ?? []).find((p: any) => p.type === 'mandatory')?.to;
      const ppEnd = ppTo === undefined ? null : Math.floor(ppTo);
      for (const over of inn.overs ?? []) {
        let legal = 0;
        (over.deliveries ?? []).forEach((d: any, b: number) => {
          const ex = d.extras ?? {};
          if (!ex.wides && !ex.noballs) legal++;
          // Retired hurt / retired not out are not dismissals. A ball can carry two entries (e.g. caught + retired not out): the
          // primary dismissal is the first genuine one, preferring a real dismissal over a tactical 'retired out'.
          const entries: any[] = d.wickets ?? [];
          const real = entries.filter(x => x.kind !== 'retired hurt' && x.kind !== 'retired not out');
          const w = real.find(x => x.kind !== 'retired out') ?? real[0];
          const ret = entries.find(x => x.kind === 'retired hurt' || x.kind === 'retired not out');
          del.write(line([
            matchId, i + 1, battingTeam, bowlingTeam, over.over, b + 1, legal,
            pid(d.batter), d.batter, pid(d.bowler), d.bowler, pid(d.non_striker),
            d.runs?.batter ?? 0, d.runs?.extras ?? 0, d.runs?.total ?? 0,
            ex.wides ?? 0, ex.noballs ?? 0, ex.byes ?? 0, ex.legbyes ?? 0,
            real.length > 0 ? 1 : 0, w?.kind, pid(w?.player_out),
            (w?.fielders ?? []).map((f: any) => pid(f.name) ?? f.name).filter(Boolean).join(';'),
            inn.super_over ? 1 : 0,
            ex.penalty ?? 0, d.runs?.non_boundary ? 1 : 0, ret?.kind, pid(ret?.player_out), real.length, ppEnd,
            inn.target?.overs, inn.target?.runs,
          ]));
          balls++;
        });
      }
    });
    if ((n + 1) % 2000 === 0) console.log(`  ${n + 1}/${files.length} matches, ${balls.toLocaleString()} balls`);
  }
  await Promise.all([new Promise(r => del.end(r)), new Promise(r => mat.end(r))]);
  console.log(`Flattened ${files.length} matches, ${balls.toLocaleString()} balls`);

  const register = process.env.RATINGS_PEOPLE_CSV ?? join(DATA, 'cricsheet/people.csv');
  execFileSync('duckdb', ['-c', `
    COPY (SELECT * FROM read_csv('${deliveriesCsv}', header=true, all_varchar=false, sample_size=-1))
      TO '${join(OUT, 'deliveries.parquet')}' (FORMAT parquet, COMPRESSION zstd);
    COPY (SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_csv('${matchesCsv}', header=true, sample_size=-1))
      TO '${join(OUT, 'matches.parquet')}' (FORMAT parquet, COMPRESSION zstd);
    COPY (SELECT identifier AS cricsheet_id, name, unique_name,
                 TRY_CAST(key_cricinfo AS BIGINT) AS cricinfo_id,
                 TRY_CAST(key_cricketarchive AS BIGINT) AS cricketarchive_id
          FROM read_csv('${register}', header=true, all_varchar=true))
      TO '${join(OUT, 'people.parquet')}' (FORMAT parquet, COMPRESSION zstd);
  `], { stdio: 'inherit' });
  execFileSync('rm', [deliveriesCsv, matchesCsv]);
  console.log(`Wrote ${OUT}/{deliveries,matches,people}.parquet`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
