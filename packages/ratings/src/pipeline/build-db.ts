/**
 * Build data/cricket.db (SQLite) from everything scraped, for querying by player.
 *
 * Sources:
 *   data/archive/profiles.jsonl      CricketArchive full profiles (archive-profiles.ts)
 *   data/scorecards/scorecards.jsonl CricketArchive scorecards (scorecards.ts)
 *   data/scorecards/scorecards-events.jsonl.gz  minor-cricket scorecards (scorecards.ts discover-events)
 *   data/scorecards/match-index.json season / country / match-list codes per scorecard
 *
 * Tables: players, player_teams, player_careers, matches, batting, bowling,
 * plus view `appearances` (one row per player per match, with team, opponent and age).
 * Rebuilt from scratch each run (cheap; the JSONL files are the source of truth).
 *
 * Usage: npx tsx src/pipeline/build-db.ts
 */

import { createReadStream, existsSync, readFileSync, rmSync } from 'fs';
import { createInterface } from 'readline';
import { createGunzip } from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import type { ArchiveProfile } from './archive-profile-parse.js';
import { inferGender, inningsTeam, type Scorecard } from './scorecard-parse.js';
import { eventTier } from './event-tiers.js';

const DATA = new URL('../../data', import.meta.url).pathname;
// --events-only builds a separate DB from the minor-cricket cards alone (the scrape keeps growing, so it is
// cheap to rebuild on its own and never touches cricket.db, which other analyses read).
const EVENTS_ONLY = process.argv.includes('--events-only');
export const DB_FILE = EVENTS_ONLY ? `${DATA}/cricket-events.db` : `${DATA}/cricket.db`;
const PROFILES_FILE = `${DATA}/archive/profiles.jsonl`;
const SCORECARDS_FILE = `${DATA}/scorecards/scorecards.jsonl`;
const EVENT_SCORECARDS_FILE = `${DATA}/scorecards/scorecards-events.jsonl.gz`;
const MATCH_INDEX_FILE = `${DATA}/scorecards/match-index.json`;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * "5th November 1988, Delhi, India" / "14 Dec 1994" / "1st, 2nd, 3rd November 2024" /
 * "28th February, 1st March 2025" -> ISO date of the first day mentioned.
 */
export function parseCricketDate(textValue: string | undefined): string | null {
  if (!textValue) return null;
  const re = /(\d{1,2})(?:st|nd|rd|th)?(?:[,\s-]+\d{1,2}(?:st|nd|rd|th)?)*\s+([A-Z][a-z]{2})[a-z]*,?\s+(\d{4})?/g;
  const first = re.exec(textValue);
  if (!first) return null;
  const year = first[3] ?? textValue.match(/\b(1[6-9]\d{2}|20\d{2})\b/)?.[1];
  const month = MONTHS[first[2].toLowerCase()];
  if (!year || !month) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(parseInt(first[1], 10)).padStart(2, '0')}`;
}

async function* jsonl<T>(path: string): AsyncGenerator<T> {
  if (!existsSync(path)) return;
  const raw = createReadStream(path);
  try {
    for await (const line of createInterface({ input: path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw })) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // A scraper killed mid-append leaves a partial last line; resume re-fetches that id
      }
    }
  } catch (err) {
    // A gzip member being appended right now reads as "unexpected end of file": keep what was read
    if (!path.endsWith('.gz')) throw err;
  }
}

async function* allScorecards(): AsyncGenerator<Scorecard> {
  // Two scrapers running at once can append the same card twice; keep the first
  const seen = new Set<number>();
  for (const file of EVENTS_ONLY ? [EVENT_SCORECARDS_FILE] : [SCORECARDS_FILE, EVENT_SCORECARDS_FILE]) {
    for await (const c of jsonl<Scorecard>(file)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      // Cards parsed before inningsTeam() existed carry "England first" as the team
      for (const inn of c.innings) inn.team = inningsTeam(inn.team + ' innings');
      yield c;
    }
  }
}

/** "14.2" overs → 14.333 (balls are sixths of an over) */
function oversToNumber(over?: string): number | null {
  const m = over?.match(/^(\d+)(?:\.(\d))?$/);
  return m ? parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 6 : 0) : null;
}

function numStat(stats: Record<string, unknown>, key: string): number | null {
  const v = stats[key];
  return typeof v === 'number' ? v : null;
}

async function main() {
  rmSync(DB_FILE, { force: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE players (
      id INTEGER PRIMARY KEY, name TEXT, full_name TEXT, born TEXT, dob TEXT, died TEXT,
      batting_hand TEXT, bowling_style TEXT, gender TEXT, levels TEXT
    );
    CREATE TABLE player_teams (player_id INTEGER, team TEXT, team_id INTEGER, level TEXT, years TEXT);
    CREATE TABLE player_careers (player_id INTEGER, format TEXT, kind TEXT, span TEXT, row_label TEXT, stats TEXT);
    CREATE TABLE matches (
      id INTEGER PRIMARY KEY, title TEXT, date TEXT, date_text TEXT, season TEXT, country TEXT,
      lists TEXT, levels TEXT, gender TEXT, event TEXT, venue TEXT, toss TEXT, result TEXT,
      team1 TEXT, team1_id INTEGER, team2 TEXT, team2_id INTEGER,
      -- Lower-level tier from the event name (event-tiers.ts): 0 senior, 1 university, 2 club/league, 3 youth, 4 veterans/disability
      tier INTEGER
    );
    CREATE TABLE batting (
      match_id INTEGER, innings INTEGER, team TEXT, team_id INTEGER, position INTEGER,
      player_id INTEGER, player_name TEXT, dob_on_card TEXT, captain INTEGER, keeper INTEGER,
      dismissal TEXT, bowler_id INTEGER, runs INTEGER, balls INTEGER, mins INTEGER,
      fours INTEGER, sixes INTEGER, dots INTEGER, strike_rate REAL,
      -- From the fall of wickets (approximate: assumes the card lists batters in arrival order)
      entry_wickets INTEGER, entry_score INTEGER, entry_over REAL,
      out_wicket INTEGER, out_score INTEGER, out_over REAL
    );
    -- Each fall of wicket, with the bowler credited (null for run outs etc.)
    CREATE TABLE wickets (
      match_id INTEGER, innings INTEGER, wicket INTEGER, score INTEGER, over REAL,
      batter_id INTEGER, bowler_id INTEGER, dismissal TEXT
    );
    CREATE TABLE bowling (
      match_id INTEGER, innings INTEGER, team TEXT, team_id INTEGER, player_id INTEGER,
      player_name TEXT, overs TEXT, maidens INTEGER, runs INTEGER, wickets INTEGER,
      wides INTEGER, no_balls INTEGER, dots INTEGER, economy REAL,
      -- Balls bowled when the card gives them directly (The Hundred has no overs; its Econ is runs per 100 balls)
      balls INTEGER
    );
  `);

  // ── Profiles ──
  const insPlayer = db.prepare('INSERT OR REPLACE INTO players VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insTeam = db.prepare('INSERT INTO player_teams VALUES (?,?,?,?,?)');
  const insCareer = db.prepare('INSERT INTO player_careers VALUES (?,?,?,?,?,?)');
  let profiles = 0;
  db.exec('BEGIN');
  for await (const p of jsonl<ArchiveProfile>(EVENTS_ONLY ? '/nonexistent' : PROFILES_FILE)) {
    insPlayer.run(p.id, p.name, p.fullName ?? null, p.born ?? null, parseCricketDate(p.born), p.died ?? null,
      p.battingHand ?? null, p.bowlingStyle ?? null, p.gender, JSON.stringify(p.levels));
    for (const t of p.teams) insTeam.run(p.id, t.team, t.teamId ?? null, t.level, t.years);
    for (const [format, career] of Object.entries(p.careers)) {
      for (const kind of ['batting', 'bowling'] as const) {
        const table = career[kind];
        if (!table) continue;
        for (const [label, stats] of Object.entries(table.rows)) {
          insCareer.run(p.id, format, kind, table.span ?? null, label, JSON.stringify(stats));
        }
      }
    }
    profiles++;
  }
  db.exec('COMMIT');

  // ── Scorecards ──
  const matchIndex: Record<string, { season: string; country: string; lists: string[] }> =
    existsSync(MATCH_INDEX_FILE) ? JSON.parse(readFileSync(MATCH_INDEX_FILE, 'utf-8')) : {};
  const insMatch = db.prepare('INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insBat = db.prepare('INSERT INTO batting VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insWicket = db.prepare('INSERT INTO wickets VALUES (?,?,?,?,?,?,?,?)');
  const insBowl = db.prepare('INSERT INTO bowling VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  // Players seen only on scorecards still get a players row (name + DOB from the tooltip)
  const insCardPlayer = db.prepare('INSERT OR IGNORE INTO players (id, name, full_name, dob) VALUES (?,?,?,?)');
  let cards = 0;
  db.exec('BEGIN');
  for await (const c of allScorecards()) {
    const idx = matchIndex[String(c.id)];
    const [t1, t2] = c.teams;
    const dateText = c.info.Venue?.split(' on ')[1] ?? c.date ?? null;
    insMatch.run(c.id, c.title, parseCricketDate(dateText ?? undefined), dateText, idx?.season ?? null, idx?.country ?? null,
      JSON.stringify(idx?.lists ?? []), JSON.stringify(c.levels), inferGender(c.levels, c.matchCodes ?? [], c.title ?? ''), c.event?.name ?? null, c.venue?.name ?? null,
      c.info.Toss ?? null, c.info.Result ?? null, t1?.name ?? null, t1?.id ?? null, t2?.name ?? null, t2?.id ?? null, eventTier(c.event?.name));

    c.innings.forEach((inn, i) => {
      const bowlingSide = c.teams.find(t => t.name !== inn.team && t.id !== inn.teamId);
      const fow = inn.fallOfWickets;
      inn.batting.forEach((b, pos) => {
        // Openers start at 0/0; batter n (n >= 3) comes in at the fall of wicket n - 2
        const entry = pos < 2 ? { wicket: 0, score: 0, over: '0' } : fow.find(f => f.wicket === pos - 1);
        const out = fow.find(f => f.player?.id === b.player.id);
        insBat.run(c.id, i + 1, inn.team, inn.teamId ?? null, pos + 1, b.player.id, b.player.name, b.dob ?? null,
          b.captain ? 1 : 0, b.keeper ? 1 : 0, b.dismissal, b.bowler?.id ?? null,
          numStat(b.stats, 'Runs'), numStat(b.stats, 'Balls'), numStat(b.stats, 'Mins'), numStat(b.stats, '4s'),
          numStat(b.stats, '6s'), numStat(b.stats, 'Dots'), numStat(b.stats, 'S-Rate'),
          entry?.wicket ?? null, entry?.score ?? null, oversToNumber(entry?.over),
          out?.wicket ?? null, out?.score ?? null, oversToNumber(out?.over));
        insCardPlayer.run(b.player.id, b.player.name, b.fullName ?? null, parseCricketDate(b.dob));
      });
      for (const f of fow) {
        const batter = inn.batting.find(b => b.player.id === f.player?.id);
        insWicket.run(c.id, i + 1, f.wicket, f.score, oversToNumber(f.over), f.player?.id ?? null,
          batter?.bowler?.id ?? null, batter?.dismissal ?? null);
      }
      for (const w of inn.bowling) {
        insBowl.run(c.id, i + 1, bowlingSide?.name ?? null, bowlingSide?.id ?? null, w.player.id, w.player.name,
          (w.stats.Overs as string | null) ?? null, numStat(w.stats, 'Mdns'), numStat(w.stats, 'Runs'), numStat(w.stats, 'Wkts'),
          numStat(w.stats, 'Wides'), numStat(w.stats, 'No-Balls'), numStat(w.stats, 'Dots'), numStat(w.stats, 'Econ'),
          numStat(w.stats, 'Balls'));
        insCardPlayer.run(w.player.id, w.player.name, null, null);
      }
    });
    cards++;
  }
  db.exec('COMMIT');

  db.exec(`
    CREATE INDEX batting_player ON batting(player_id);
    CREATE INDEX bowling_player ON bowling(player_id);
    CREATE INDEX wickets_bowler ON wickets(bowler_id);
    CREATE INDEX player_teams_player ON player_teams(player_id);
    CREATE INDEX careers_player ON player_careers(player_id);
    CREATE INDEX players_name ON players(name COLLATE NOCASE);
    CREATE INDEX players_full_name ON players(full_name COLLATE NOCASE);

    -- One row per player per match: which side they played for, against whom, and their age
    CREATE VIEW appearances AS
    WITH sides AS (
      SELECT DISTINCT match_id, player_id, team, team_id FROM batting
      UNION
      SELECT DISTINCT match_id, player_id, team, team_id FROM bowling
    )
    SELECT s.player_id, s.match_id, m.date, m.season, m.levels, m.lists, m.gender, m.event, m.venue,
           s.team, s.team_id,
           CASE WHEN s.team = m.team1 THEN m.team2 ELSE m.team1 END AS opponent,
           m.result,
           CASE WHEN p.dob IS NOT NULL AND m.date IS NOT NULL
                THEN round((julianday(m.date) - julianday(p.dob)) / 365.2425, 2) END AS age
    FROM sides s
    JOIN matches m ON m.id = s.match_id
    LEFT JOIN players p ON p.id = s.player_id;
  `);
  db.close();
  console.log(`Built ${DB_FILE}: ${profiles} profiles, ${cards} scorecards`);
}

if (process.argv[1]?.endsWith('build-db.ts')) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
