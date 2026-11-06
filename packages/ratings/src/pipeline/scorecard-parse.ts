/**
 * Parse a CricketArchive scorecard page (/Archive/Scorecards/{id/1000}/{id}.html).
 *
 * Page shape (2026):
 *   - Header table: match codes cell ("tt17567<br>itt4224"), teams, event + match label,
 *     then label/value rows (Venue, Toss, Result, Umpires, Player of the Match, ...).
 *   - Per innings: a batting table whose header row reads "<Team> innings" followed by
 *     column names (Runs, Balls, Mins, 4s, 6s, Dots, S-Rate; older matches have fewer),
 *     "did not bat" rows, Extras, Total, Fall of wickets; then "<Team> bowling" with
 *     Overs, Mdns, Runs, Wkts, Wides, No-Balls, Dots, 4s, 6s, S-Rate, Econ (era dependent).
 * Columns are mapped by header name, so pre-modern scorecards with fewer columns parse too.
 */

import { parse, type HTMLElement } from 'node-html-parser';

/** CricketArchive match-type code prefixes seen in the header cell, e.g. "itt4224" */
export const MATCH_CODE_LABELS: Record<string, string> = {
  t: 'Test',
  o: 'ODI',
  itt: 'International Twenty20',
  f: 'First-Class',
  a: 'List A',
  tt: 'Twenty20',
  wt: "Women's Test",
  wo: "Women's ODI",
  witt: "Women's International Twenty20",
  wf: "Women's First-Class",
  wa: "Women's List A",
  wtt: "Women's Twenty20",
};

export interface PlayerRef {
  id: number;
  name: string;
}

export interface BattingRow {
  player: PlayerRef;
  fullName?: string;
  dob?: string;
  captain: boolean;
  keeper: boolean;
  dismissal: string;          // "c P Yadav b MP Yadav", "not out", "did not bat"
  bowler?: PlayerRef;
  fielders: PlayerRef[];
  /** Columns keyed by CricketArchive header: Runs, Balls, Mins, 4s, 6s, Dots, S-Rate */
  stats: Record<string, number | null>;
}

export interface BowlingRow {
  player: PlayerRef;
  /** Columns keyed by header: Overs, Mdns, Runs, Wkts, Wides, No-Balls, Dots, 4s, 6s, S-Rate, Econ */
  stats: Record<string, number | string | null>;
}

export interface Innings {
  team: string;
  teamId?: number;
  batting: BattingRow[];
  extras?: { detail: string; runs: number | null };
  total?: { detail: string; runs: number | null };
  fallOfWickets: { wicket: number; score: number; player?: PlayerRef; over?: string }[];
  bowling: BowlingRow[];
}

export interface Scorecard {
  id: number;
  title: string;                       // "New Zealand v India"
  matchCodes: string[];                // ["tt17567", "itt4224"]
  levels: string[];                    // ["Twenty20", "International Twenty20"]
  gender: 'male' | 'female';
  teams: { name: string; id?: number }[];
  event?: { name: string; url: string };
  info: Record<string, string>;        // Venue, Toss, Result, Umpires, ... as text
  venue?: { name: string; groundUrl?: string };
  date?: string;                       // "30th October 2026"
  playerOfMatch: PlayerRef[];
  innings: Innings[];
  notes: string[];
}

const PLAYER_HREF = /\/Archive\/Players\/\d+\/(\d+)\/\d+\.html/;
const TEAM_HREF = /\/Archive\/Teams\/\d+\/(\d+)\/\d+\.html/;

function text(el: HTMLElement | undefined | null): string {
  return (el?.text ?? '').replace(/ |&nbsp;?/g, ' ').replace(/\s+/g, ' ').trim();
}

function playerRefs(el: HTMLElement | undefined | null): PlayerRef[] {
  if (!el) return [];
  return el.querySelectorAll('a')
    .map(a => {
      const m = (a.getAttribute('href') ?? '').match(PLAYER_HREF);
      return m ? { id: parseInt(m[1], 10), name: text(a) } : null;
    })
    .filter((p): p is PlayerRef => p !== null);
}

function num(value: string): number | null {
  const v = value.replace(/\*$/, '').trim();
  if (v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function levelsFor(codes: string[]): string[] {
  return codes
    .map(c => c.match(/^([a-z]+)\d+$/)?.[1])
    .filter((p): p is string => !!p)
    .map(p => MATCH_CODE_LABELS[p] ?? p);
}

function parseHeader(table: HTMLElement, card: Scorecard): void {
  const rows = table.querySelectorAll('tr');
  // Row 0: codes cell + "Team A v Team B"
  const firstCells = rows[0]?.querySelectorAll('td') ?? [];
  card.matchCodes = (firstCells[0]?.innerHTML ?? '')
    .split(/<br\s*\/?>/i)
    .map(s => s.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  card.levels = levelsFor(card.matchCodes);
  card.title = text(firstCells[1]);
  card.teams = (firstCells[1]?.querySelectorAll('a') ?? []).map(a => {
    const m = (a.getAttribute('href') ?? '').match(TEAM_HREF);
    return { name: text(a), ...(m ? { id: parseInt(m[1], 10) } : {}) };
  });

  for (const row of rows.slice(1)) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) continue;
    const label = text(cells[0]);
    const value = cells[1];
    if (!label) {
      const eventLink = value.querySelector('a');
      if (eventLink) card.event = { name: text(eventLink), url: eventLink.getAttribute('href') ?? '' };
      continue;
    }
    card.info[label] = text(value);
    if (label === 'Venue') {
      const ground = value.querySelector('a');
      card.venue = { name: text(ground) || text(value), groundUrl: ground?.getAttribute('href') ?? undefined };
      card.date = text(value).match(/ on (\d{1,2}\w{2} \w+ \d{4}(?:[^(]*\d{4})?)/)?.[1]?.trim();
    }
    if (label === 'Player of the Match') card.playerOfMatch = playerRefs(value);
  }
}

function headerColumns(row: HTMLElement): string[] {
  return row.querySelectorAll('td').map(text);
}

/** "England first innings" / "Kent second innings (following on)" → the team name */
export function inningsTeam(title: string): string {
  return title
    .replace(/\s*\(following on\)\s*$/i, '')
    .replace(/ innings$/i, '')
    .replace(/ (first|second|third|fourth|1st|2nd|3rd|4th)$/i, '');
}

function parseBattingTable(table: HTMLElement): Innings | null {
  const rows = table.querySelectorAll('tr');
  const header = rows[0];
  const headerCells = header ? header.querySelectorAll('td') : [];
  const title = text(headerCells[0]);
  if (!/ innings$/i.test(title)) return null;

  const teamLink = headerCells[0].querySelector('a');
  const teamId = teamLink?.getAttribute('href')?.match(TEAM_HREF)?.[1];
  const cols = headerColumns(header).slice(1); // after the "<Team> innings" cell (colspan 2)
  const innings: Innings = {
    team: inningsTeam(title),
    ...(teamId ? { teamId: parseInt(teamId, 10) } : {}),
    batting: [],
    fallOfWickets: [],
    bowling: [],
  };

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].querySelectorAll('td');
    const first = text(cells[0]);
    if (first === 'Extras' || first === 'Total') {
      const entry = { detail: text(cells[1]), runs: num(text(cells[2])) };
      if (first === 'Extras') innings.extras = entry;
      else innings.total = entry;
      continue;
    }
    if (/^Fall of wickets/i.test(first)) {
      const fowCell = rows[i + 1]?.querySelectorAll('td')[0];
      const fowHtml = fowCell?.innerHTML ?? '';
      for (const m of fowHtml.matchAll(/(\d+)-(\d+)\s*\(([^)]*)\)/g)) {
        const inner = parse(m[3]);
        const [ref] = playerRefs(inner);
        innings.fallOfWickets.push({
          wicket: parseInt(m[1], 10),
          score: parseInt(m[2], 10),
          ...(ref ? { player: ref } : {}),
          over: m[3].match(/([\d.]+) ov/)?.[1],
        });
      }
      i++;
      continue;
    }
    const [batter] = playerRefs(cells[0]);
    if (!batter || cells.length < 2) continue;

    const tip = cells[0].getAttribute('onmouseover') ?? '';
    const tipMatch = tip.match(/Tip\('([^<']*)(?:<br>dob: ([^']*))?'\)/);
    const marker = first.slice(0, first.indexOf(batter.name));
    const dismissalCell = cells[1];
    const dismissal = text(dismissalCell);
    const refs = playerRefs(dismissalCell);
    // "b X" names the bowler last; "c Y b X" / "st Y b X" put fielders first
    const bowled = / b [^ ]/.test(` ${dismissal}`) || /^b /.test(dismissal);
    const bowler = bowled ? refs[refs.length - 1] : undefined;
    const fielders = bowled ? refs.slice(0, -1) : refs;

    const stats: Record<string, number | null> = {};
    cols.forEach((col, idx) => {
      if (col) stats[col] = num(text(cells[idx + 2]));
    });

    innings.batting.push({
      player: batter,
      ...(tipMatch?.[1] ? { fullName: tipMatch[1].trim() } : {}),
      ...(tipMatch?.[2] ? { dob: tipMatch[2].trim() } : {}),
      captain: marker.includes('*'),
      keeper: marker.includes('+'),
      dismissal,
      ...(bowler ? { bowler } : {}),
      fielders,
      stats,
    });
  }
  return innings;
}

function parseBowlingTable(table: HTMLElement): { team: string; rows: BowlingRow[] } | null {
  const rows = table.querySelectorAll('tr');
  const header = rows[0];
  if (!header) return null;
  const cols = headerColumns(header);
  if (!/ bowling$/i.test(cols[0] ?? '')) return null;

  const out: BowlingRow[] = [];
  for (const row of rows.slice(1)) {
    const cells = row.querySelectorAll('td');
    const [bowler] = playerRefs(cells[0]);
    if (!bowler) continue;
    const stats: Record<string, number | string | null> = {};
    cols.slice(1).forEach((col, idx) => {
      if (!col) return;
      const raw = text(cells[idx + 1]);
      // Overs can be "3.4" or "4" and must keep its ball notation as text
      stats[col] = col === 'Overs' ? raw || null : num(raw);
    });
    out.push({ player: bowler, stats });
  }
  return { team: cols[0].replace(/ bowling$/i, ''), rows: out };
}

export function parseScorecard(html: string, id: number): Scorecard | null {
  // Parse only the content column: malformed markup in the site header can make the parser
  // lose #columnLeft entirely (seen on 1404877)
  const start = html.indexOf('<div id="columnLeft"');
  const root = parse(start >= 0 ? html.slice(start) : html, { comment: false });
  const tables = root.querySelectorAll('table');
  if (tables.length === 0) return null;

  const card: Scorecard = {
    id,
    title: '',
    matchCodes: [],
    levels: [],
    gender: 'male',
    teams: [],
    info: {},
    playerOfMatch: [],
    innings: [],
    notes: [],
  };
  parseHeader(tables[0], card);
  if (!card.title) return null;

  for (const table of tables.slice(1)) {
    const innings = parseBattingTable(table);
    if (innings) {
      card.innings.push(innings);
      continue;
    }
    const bowling = parseBowlingTable(table);
    // A bowling table belongs to the innings just batted
    if (bowling && card.innings.length > 0) card.innings[card.innings.length - 1].bowling = bowling.rows;
  }

  const notesHtml = root.innerHTML.split(/<b>Notes<\/b>/i)[1]?.split(/<hr|This page was created|LATEST SCORES|<\/div>/i)[0] ?? '';
  card.notes = notesHtml
    .split(/<br\s*\/?>/i)
    .map(line => line.replace(/<[^>]+>/g, '').replace(/^\s*-->\s*/, '').trim())
    .filter(line => line && !/^<\/?div|^&nbsp/.test(line))
    .slice(0, 200);
  card.gender = inferGender(card.levels, card.matchCodes, card.title);
  return card;
}

const MEN_TIERS = /^(Twenty20|International Twenty20|List A|ODI|First-Class|Test)$/;

/**
 * Women's senior matches always carry a "Women's ..." level; a men's tier name means a men's match even
 * when a list code starts with "w" (CricketArchive's wc = World Cup, wctt = World Cup T20, wtc = World Test
 * Championship, wcsl = World Cup Super League, wid = West Indies domestic). Only untiered cards fall back to
 * the title or a "w" code (wmisc, nzaw).
 */
export function inferGender(levels: string[], matchCodes: string[], title: string): 'male' | 'female' {
  if (levels.some(l => /^Women's /.test(l))) return 'female';
  if (levels.some(l => MEN_TIERS.test(l))) return 'male';
  if (/\bWomen\b/.test(title)) return 'female';
  return [...levels, ...matchCodes].some(c => /^w/.test(c)) ? 'female' : 'male';
}
