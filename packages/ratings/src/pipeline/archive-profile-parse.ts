/**
 * Full parse of a CricketArchive player profile (/Archive/Players/{id/1000}/{id}/{id}.html):
 * bio, every team with its level and years, and every career table on the page.
 *
 * parse-stats.ts keeps only the T20 fields the game's ratings use; this keeps everything,
 * for the all-players dataset.
 *
 * Career tables all look like:
 *   <tr><td colspan=8><b>{Format} Career Batting and Fielding ({span})</b></td></tr>
 *   <tr><td></td><td><b>M</b></td>…<td><b>Ct</b></td></tr>
 *   <tr><td>Overall</td><td>156</td>…</tr>          (or one row per team)
 * and the same with "Career Bowling". Columns differ by format and era, so they're keyed
 * by header name.
 */

import { parse, type HTMLElement } from 'node-html-parser';

export interface CareerTable {
  span?: string;
  /** Row label ("Overall" or a team name) -> column header -> value as shown */
  rows: Record<string, Record<string, string>>;
}

export interface CareerFormat {
  batting?: CareerTable;
  bowling?: CareerTable;
}

export interface TeamSpell {
  team: string;
  teamId?: number;
  /** CricketArchive's level label, e.g. "Test", "International Twenty20", "Main FC", "Main Twenty20" */
  level: string;
  years: string;
}

export interface ArchiveProfile {
  id: number;
  name: string;
  fullName?: string;
  born?: string;
  died?: string;
  battingHand?: string;
  bowlingStyle?: string;
  gender: 'male' | 'female' | 'unknown';
  teams: TeamSpell[];
  /** Distinct levels played, from the team list and career tables */
  levels: string[];
  /** Format name ("Test", "Twenty20", "Indian Premier League", "Women's ODI", ...) -> tables */
  careers: Record<string, CareerFormat>;
  awards: string[];
}

const TEAM_HREF = /\/Archive\/Teams\/\d+\/(\d+)\/\d+\.html/;

function text(el: HTMLElement | undefined | null): string {
  return (el?.text ?? '').replace(/ |&nbsp;?/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Bio rows are label/value cell pairs: <td>Born:</td><td>…</td> */
function bioField(root: HTMLElement, label: string): HTMLElement | undefined {
  for (const td of root.querySelectorAll('td')) {
    if (text(td) === `${label}:`) return td.nextElementSibling ?? undefined;
  }
  return undefined;
}

function parseTeams(cell: HTMLElement | undefined): TeamSpell[] {
  if (!cell) return [];
  return cell.innerHTML
    .split(/;\s*<br\s*\/?>|<br\s*\/?>/i)
    .map(chunk => {
      const part = parse(chunk);
      const link = part.querySelector('a');
      const label = text(part);
      const m = label.match(/^(.*?)\s*\(([^:]+):\s*([^)]*)\);?$/);
      if (!m) return null;
      const teamId = link?.getAttribute('href')?.match(TEAM_HREF)?.[1];
      return { team: m[1].trim(), ...(teamId ? { teamId: parseInt(teamId, 10) } : {}), level: m[2].trim(), years: m[3].trim() };
    })
    .filter((t): t is TeamSpell => t !== null);
}

function parseCareerTable(table: HTMLElement): { format: string; kind: 'batting' | 'bowling'; data: CareerTable } | null {
  const rows = table.querySelectorAll('tr');
  const title = text(rows[0]);
  const m = title.match(/^(.*?) Career (Batting and Fielding|Bowling)(?: \(([^)]*)\))?$/);
  if (!m || rows.length < 3) return null;

  const headers = rows[1].querySelectorAll('td').map(text);
  const data: CareerTable = { ...(m[3] ? { span: m[3] } : {}), rows: {} };
  for (const row of rows.slice(2)) {
    const cells = row.querySelectorAll('td').map(text);
    if (!cells[0]) continue;
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && cells[i] !== undefined && cells[i] !== '') values[h] = cells[i];
    });
    data.rows[cells[0]] = values;
  }
  return { format: m[1].trim(), kind: m[2] === 'Bowling' ? 'bowling' : 'batting', data };
}

export function parseArchiveProfile(html: string, id: number): ArchiveProfile | null {
  const root = parse(html, { comment: false });
  const name = root.querySelector('#columnLeft h2, #columnLeft h1')?.text?.trim()
    ?? html.match(/document\.title = "([^"]+)"/)?.[1]
    ?? '';
  const fullName = text(bioField(root, 'Full name')) || undefined;
  if (!name && !fullName) return null;

  const teams = parseTeams(bioField(root, 'Teams'));
  const careers: Record<string, CareerFormat> = {};
  for (const table of root.querySelectorAll('table')) {
    const parsed = parseCareerTable(table);
    if (!parsed) continue;
    (careers[parsed.format] ??= {})[parsed.kind] = parsed.data;
  }

  const levels = [...new Set([...teams.map(t => t.level), ...Object.keys(careers)])];
  const womenSignal = teams.some(t => /\bWomen\b/i.test(t.team) || /^Women's/i.test(t.level)) ||
    Object.keys(careers).some(f => /^Women's/i.test(f));
  const anyCricket = teams.length > 0 || Object.keys(careers).length > 0;

  const awards = root.querySelectorAll('td')
    .map(text)
    .filter(t => /(of the Year|Cricketer of the|Player of the Year):?\s*\d{4}/.test(t))
    .slice(0, 50);

  return {
    id,
    name: name || fullName!,
    ...(fullName ? { fullName } : {}),
    ...(text(bioField(root, 'Born')) ? { born: text(bioField(root, 'Born')) } : {}),
    ...(text(bioField(root, 'Died')) ? { died: text(bioField(root, 'Died')) } : {}),
    ...(text(bioField(root, 'Batting')) ? { battingHand: text(bioField(root, 'Batting')) } : {}),
    ...(text(bioField(root, 'Bowling')) ? { bowlingStyle: text(bioField(root, 'Bowling')) } : {}),
    gender: womenSignal ? 'female' : anyCricket ? 'male' : 'unknown',
    teams,
    levels,
    careers,
    awards,
  };
}
