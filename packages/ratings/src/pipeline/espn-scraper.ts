/**
 * ESPNCricinfo Playwright Scraper
 *
 * Scrapes player profiles from ESPNCricinfo using Playwright.
 * ESPNCricinfo uses Akamai CDN which blocks headless browsers and curl,
 * so we use headed Chrome with a persistent profile.
 *
 * Data is extracted from __NEXT_DATA__ embedded in each player's profile page.
 * A single page load gives us:
 *   - Player bio (name, DOB, batting/bowling style, role, country, teams)
 *   - Career stats across 6 formats (Test, ODI, T20I, FC, List A, T20)
 *   - Including 4s, 6s, balls faced — data not available from CricketArchive
 *
 * Usage:
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts [--limit N] [--resume]
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --index-only
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --skip-index --resume
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --skip-index --ids 883413,944373
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --normalize-only
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --resolve-wpl-only
 *   npx tsx packages/ratings/src/pipeline/espn-scraper.ts --resolve-women-elite-only
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { WPL_2025_ROSTERS } from '../wpl-rosters.js';

// ── Types ────────────────────────────────────────────────────────────────

interface ESPNPlayerProfile {
  espnId: number;
  name: string;
  longName: string;
  slug: string;
  dateOfBirth: { year: number; month: number; date: number } | null;
  gender: string;
  countryTeamId: number;
  battingStyles: string[];
  bowlingStyles: string[];
  playingRoles: string[];
  teams: string[];
  imageUrl: string;
  intlCareerSpan: string | null; // e.g. "2008 - 2026"
}

interface ESPNCareerStat {
  type: 'BATTING' | 'BOWLING';
  /** 1=Test, 2=ODI, 3=T20I, 4=FC, 5=ListA, 6=T20 */
  cl: number;
  mt: number;   // matches
  in: number;   // innings
  rn: number;   // runs
  bl: number;   // balls
  avg: number;  // average
  sr: number;   // strike rate
  no?: number;  // not outs (batting)
  fo?: number;  // fours (batting)
  si?: number;  // sixes (batting)
  hs?: string;  // high score (batting)
  hn?: number;  // hundreds (batting)
  ft?: number;  // fifties (batting)
  ct?: number;  // catches
  st?: number;  // stumpings
  wk?: number;  // wickets (bowling)
  bbi?: string; // best bowling innings
  bbm?: string; // best bowling match
  fwk?: number; // four-wicket hauls
  fw?: number;  // five-wicket hauls
  tw?: number;  // ten-wicket hauls
  bwe?: number; // economy (bowling)
}

interface ESPNPlayerData {
  profile: ESPNPlayerProfile;
  careerStats: ESPNCareerStat[];
  scrapedAt: string;
}

interface PlayerIndexEntry {
  name: string;
  slug: string;
  espnId: number;
  source: string; // which team page we found them on
}

// ── Constants ────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve('packages/ratings/data/scraped');
const ESPN_PLAYERS_FILE = path.join(DATA_DIR, 'espn-players.json');
const ESPN_INDEX_FILE = path.join(DATA_DIR, 'espn-player-index.json');
const CRICSHEET_T20I_DIR = path.resolve('packages/ratings/data/cricsheet/t20s_json');
const BROWSER_PROFILE_DIR = '/tmp/pw-espncricinfo-profile';
const WOMEN_TEAM_PATTERN = /\bwomen\b|\(women\)|supernovas|trailblazers|velocity\b|girls\b/i;
const SEARCH_USER_AGENT = 'Mozilla/5.0';
const SEARCH_SOURCE = 'search';
const WOMEN_WORLD_CUP_EVENT_NAMES = new Set([
  "ICC Women's T20 World Cup",
  "ICC Women's World Twenty20",
  "Women's World T20",
  "Women's World Twenty20",
]);
const WBBL_TEAM_SOURCES = [
  { label: 'Adelaide Strikers', baseUrl: 'https://www.adelaidestrikers.com.au' },
  { label: 'Brisbane Heat', baseUrl: 'https://www.brisbaneheat.com.au' },
  { label: 'Hobart Hurricanes', baseUrl: 'https://www.hobarthurricanes.com.au' },
  { label: 'Melbourne Renegades', baseUrl: 'https://www.melbournerenegades.com.au' },
  { label: 'Melbourne Stars', baseUrl: 'https://www.melbournestars.com.au' },
  { label: 'Perth Scorchers', baseUrl: 'https://www.perthscorchers.com.au' },
  { label: 'Sydney Sixers', baseUrl: 'https://www.sydneysixers.com.au' },
  { label: 'Sydney Thunder', baseUrl: 'https://www.sydneythunder.com.au' },
];
const HUNDRED_TEAM_SLUGS = [
  'birmingham-phoenix',
  'london-spirit',
  'manchester-super-giants',
  'mi-london',
  'southern-brave',
  'sunrisers-leeds',
  'trent-rockets',
  'welsh-fire',
];

// All countries with active cricketers on ESPNCricinfo
// Includes ICC Full Members, Associates, and Affiliates with T20I status
const TEAM_PAGES = [
  // ICC Full Members
  { name: 'India', slug: 'india', id: 6 },
  { name: 'Australia', slug: 'australia', id: 2 },
  { name: 'England', slug: 'england', id: 1 },
  { name: 'South Africa', slug: 'south-africa', id: 3 },
  { name: 'New Zealand', slug: 'new-zealand', id: 5 },
  { name: 'Pakistan', slug: 'pakistan', id: 7 },
  { name: 'West Indies', slug: 'west-indies', id: 4 },
  { name: 'Sri Lanka', slug: 'sri-lanka', id: 8 },
  { name: 'Bangladesh', slug: 'bangladesh', id: 25 },
  { name: 'Afghanistan', slug: 'afghanistan', id: 40 },
  { name: 'Zimbabwe', slug: 'zimbabwe', id: 9 },
  { name: 'Ireland', slug: 'ireland', id: 29 },
  // ICC Associates with T20I status
  { name: 'Netherlands', slug: 'netherlands', id: 15 },
  { name: 'Scotland', slug: 'scotland', id: 30 },
  { name: 'Nepal', slug: 'nepal', id: 32 },
  { name: 'USA', slug: 'usa', id: 11 },
  { name: 'Namibia', slug: 'namibia', id: 28 },
  { name: 'Oman', slug: 'oman', id: 36 },
  { name: 'UAE', slug: 'united-arab-emirates', id: 27 },
  { name: 'Papua New Guinea', slug: 'papua-new-guinea', id: 20 },
  { name: 'Canada', slug: 'canada', id: 17 },
  { name: 'Hong Kong', slug: 'hong-kong', id: 19 },
  { name: 'Kenya', slug: 'kenya', id: 26 },
  { name: 'Uganda', slug: 'uganda', id: 34 },
  { name: 'Jersey', slug: 'jersey', id: 37 },
  { name: 'Singapore', slug: 'singapore', id: 35 },
  { name: 'Bermuda', slug: 'bermuda', id: 12 },
  { name: 'Italy', slug: 'italy', id: 31 },
  { name: 'Germany', slug: 'germany', id: 41 },
  { name: 'Denmark', slug: 'denmark', id: 14 },
  { name: 'Malaysia', slug: 'malaysia', id: 42 },
  { name: 'Tanzania', slug: 'tanzania', id: 43 },
  { name: 'Qatar', slug: 'qatar', id: 44 },
  { name: 'Bahrain', slug: 'bahrain', id: 45 },
  { name: 'Kuwait', slug: 'kuwait', id: 46 },
  { name: 'Saudi Arabia', slug: 'saudi-arabia', id: 47 },
  { name: 'Vanuatu', slug: 'vanuatu', id: 48 },
  { name: 'Czech Republic', slug: 'czech-republic', id: 49 },
  { name: 'Austria', slug: 'austria', id: 50 },
  { name: 'Spain', slug: 'spain', id: 51 },
  { name: 'Romania', slug: 'romania', id: 52 },
  { name: 'Hungary', slug: 'hungary', id: 53 },
  { name: 'Sweden', slug: 'sweden', id: 54 },
  { name: 'Portugal', slug: 'portugal', id: 55 },
  { name: 'Luxembourg', slug: 'luxembourg', id: 56 },
  { name: 'Belgium', slug: 'belgium', id: 57 },
  { name: 'Norway', slug: 'norway', id: 58 },
  { name: 'Bulgaria', slug: 'bulgaria', id: 59 },
  { name: 'Croatia', slug: 'croatia', id: 60 },
  { name: 'Finland', slug: 'finland', id: 61 },
  { name: 'France', slug: 'france', id: 62 },
  { name: 'Greece', slug: 'greece', id: 63 },
  { name: 'Guernsey', slug: 'guernsey', id: 64 },
  { name: 'Isle of Man', slug: 'isle-of-man', id: 65 },
  { name: 'Nigeria', slug: 'nigeria', id: 66 },
  { name: 'Rwanda', slug: 'rwanda', id: 67 },
  { name: 'Cameroon', slug: 'cameroon', id: 68 },
  { name: 'Ghana', slug: 'ghana', id: 69 },
  { name: 'Mozambique', slug: 'mozambique', id: 70 },
  { name: 'Botswana', slug: 'botswana', id: 71 },
  { name: 'Cayman Islands', slug: 'cayman-islands', id: 72 },
  { name: 'Thailand', slug: 'thailand', id: 73 },
  { name: 'Philippines', slug: 'philippines', id: 74 },
  { name: 'Japan', slug: 'japan', id: 75 },
  { name: 'South Korea', slug: 'south-korea', id: 76 },
  { name: 'Mongolia', slug: 'mongolia', id: 77 },
  { name: 'China', slug: 'china', id: 78 },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, '-')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value).replace(/<[^>]+>/g, ' ');
}

function cleanCompetitionPlayerName(name: string): string {
  return stripHtmlTags(name)
    .replace(/\bCaptain\b/gi, ' ')
    .replace(/\bOverseas\b/gi, ' ')
    .replace(/^\d+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAttributeValue(attrs: string, attribute: string): string | null {
  const quoted = attrs.match(new RegExp(`\\b${attribute}=(["'])([\\s\\S]*?)\\1`, 'i'));
  if (quoted) return decodeHtmlEntities(quoted[2]).trim();
  const unquoted = attrs.match(new RegExp(`\\b${attribute}=([^\\s>]+)`, 'i'));
  if (!unquoted) return null;
  return decodeHtmlEntities(unquoted[1]).trim();
}

function extractPlayerNamesFromAnchors(
  html: string,
  hrefPattern: RegExp,
  options?: { useTitleFirst?: boolean },
): string[] {
  const names = new Set<string>();
  const anchorPattern = /<a\b([^>]*?)href=(["']?)([^"'\s>]+)\2([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const attrs = `${match[1]} ${match[4]}`;
    const href = decodeHtmlEntities(match[3]);
    if (!hrefPattern.test(href)) continue;

    const title = extractAttributeValue(attrs, 'title');
    const rawName = options?.useTitleFirst && title ? title : title || match[5];
    const cleanedName = cleanCompetitionPlayerName(rawName);
    if (!cleanedName) continue;
    names.add(cleanedName);
  }

  return [...names];
}

function extractHundredSquadNames(html: string): string[] {
  const yearMarkers = [...html.matchAll(/data-squad-year="(\d+)"/gi)]
    .map((match) => ({
      year: parseInt(match[1], 10),
      index: match.index ?? 0,
    }))
    .filter((marker) => Number.isFinite(marker.year));
  const currentYear = yearMarkers.reduce((max, marker) => Math.max(max, marker.year), 0);
  const names = new Set<string>();

  if (currentYear > 0) {
    for (let i = 0; i < yearMarkers.length; i++) {
      const marker = yearMarkers[i];
      if (marker.year !== currentYear) continue;
      const nextIndex = yearMarkers[i + 1]?.index ?? html.length;
      const yearChunk = html.slice(marker.index, nextIndex);
      for (const squadItem of yearChunk.matchAll(/<li[^>]*class="[^"]*team-squad-list__player[^"]*"[^>]*data-team-type="women"[^>]*>[\s\S]*?<\/li>/gi)) {
        for (const playerName of extractPlayerNamesFromAnchors(squadItem[0], /\/players\/\d+\//i)) {
          names.add(playerName);
        }
      }
    }
  }

  if (names.size === 0) {
    for (const squadItem of html.matchAll(/<li[^>]*class="[^"]*team-squad-list__player[^"]*"[^>]*data-team-type="women"[^>]*>[\s\S]*?<\/li>/gi)) {
      for (const playerName of extractPlayerNamesFromAnchors(squadItem[0], /\/players\/\d+\//i)) {
        names.add(playerName);
      }
    }
  }

  if (names.size === 0) {
    for (const squadItem of html.matchAll(/<li[^>]*class="[^"]*team-squad-list__player[^"]*"[^>]*>[\s\S]*?<\/li>/gi)) {
      if (!/data-team-type="women"/i.test(squadItem[0])) continue;
      for (const playerName of extractPlayerNamesFromAnchors(squadItem[0], /\/players\/\d+\//i)) {
        names.add(playerName);
      }
    }
  }

  return [...names];
}

async function fetchCompetitionHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': SEARCH_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function loadLatestWomenWorldCupNamesFromCricsheet(): string[] {
  if (!fs.existsSync(CRICSHEET_T20I_DIR)) return [];

  let latestYear = 0;
  const namesByYear = new Map<number, Set<string>>();
  const files = fs.readdirSync(CRICSHEET_T20I_DIR).filter((file) => file.endsWith('.json') && !file.startsWith('README'));

  for (const file of files) {
    try {
      const match = JSON.parse(fs.readFileSync(path.join(CRICSHEET_T20I_DIR, file), 'utf-8'));
      const info = match?.info as Record<string, any> | undefined;
      if (info?.gender !== 'female') continue;

      const eventName = info?.event?.name;
      if (!WOMEN_WORLD_CUP_EVENT_NAMES.has(eventName)) continue;

      const matchDate = String(info?.dates?.[0] ?? '');
      const year = parseInt(matchDate.slice(0, 4), 10);
      if (!Number.isFinite(year)) continue;

      latestYear = Math.max(latestYear, year);
      const yearNames = namesByYear.get(year) ?? new Set<string>();
      const players = info?.players ?? {};
      for (const teamPlayers of Object.values(players)) {
        if (!Array.isArray(teamPlayers)) continue;
        for (const playerName of teamPlayers) {
          if (typeof playerName !== 'string') continue;
          const cleanedName = cleanCompetitionPlayerName(playerName);
          if (cleanedName) yearNames.add(cleanedName);
        }
      }
      namesByYear.set(year, yearNames);
    } catch {
      // Ignore malformed Cricsheet files and keep indexing deterministic.
    }
  }

  return latestYear > 0 ? [...(namesByYear.get(latestYear) ?? new Set<string>())] : [];
}

function loadAllWomenCricsheetNames(): string[] {
  if (!fs.existsSync(CRICSHEET_T20I_DIR)) return [];

  const names = new Set<string>();
  const files = fs.readdirSync(CRICSHEET_T20I_DIR).filter((file) => file.endsWith('.json') && !file.startsWith('README'));

  for (const file of files) {
    try {
      const match = JSON.parse(fs.readFileSync(path.join(CRICSHEET_T20I_DIR, file), 'utf-8'));
      const info = match?.info as Record<string, any> | undefined;
      if (info?.gender !== 'female') continue;

      const players = info?.players ?? {};
      for (const teamPlayers of Object.values(players)) {
        if (!Array.isArray(teamPlayers)) continue;
        for (const playerName of teamPlayers) {
          if (typeof playerName !== 'string') continue;
          const cleanedName = cleanCompetitionPlayerName(playerName);
          if (cleanedName) names.add(cleanedName);
        }
      }
    } catch {
      // Ignore malformed Cricsheet files and keep indexing deterministic.
    }
  }

  return [...names];
}

async function loadWBBLPlayerNamesFromClubPages(): Promise<string[]> {
  const names = new Set<string>();

  for (const team of WBBL_TEAM_SOURCES) {
    let bestNames: string[] = [];

    for (const route of ['/players/wbbl', '/wbbl-players', '/players']) {
      const html = await fetchCompetitionHtml(`${team.baseUrl}${route}`);
      if (!html) continue;

      const extracted = extractPlayerNamesFromAnchors(html, /\/players\/CA:/i, { useTitleFirst: true });
      if (route !== '/players' && extracted.length >= 12) {
        bestNames = extracted;
        break;
      }
      if (extracted.length > bestNames.length) {
        bestNames = extracted;
      }
    }

    for (const playerName of bestNames) {
      names.add(playerName);
    }
  }

  return [...names];
}

async function loadHundredSquadPlayerNames(): Promise<string[]> {
  const names = new Set<string>();

  for (const teamSlug of HUNDRED_TEAM_SLUGS) {
    const html = await fetchCompetitionHtml(`https://www.thehundred.com/teams/${teamSlug}/squad`);
    if (!html) continue;

    for (const playerName of extractHundredSquadNames(html)) {
      names.add(playerName);
    }
  }

  return [...names];
}

function profileLooksFemale(teams: string[]): boolean {
  return teams.some(team => WOMEN_TEAM_PATTERN.test(team));
}

function normalizeProfileGender(rawGender: string, teams: string[]): "M" | "F" {
  if (profileLooksFemale(teams)) return "F";
  return rawGender === "F" ? "F" : "M";
}

function normalizePlayerData(player: ESPNPlayerData): ESPNPlayerData {
  return {
    ...player,
    profile: {
      ...player.profile,
      gender: normalizeProfileGender(player.profile.gender, player.profile.teams),
    },
  };
}

function hasUsableT20Stats(player: ESPNPlayerData): boolean {
  const gender = normalizeProfileGender(player.profile.gender, player.profile.teams);
  return player.careerStats.some((stat) => {
    if (stat.mt <= 0) return false;
    if (gender === "F") return stat.cl === 9 || stat.cl === 10;
    return stat.cl === 3 || stat.cl === 6;
  });
}

function loadExistingData(): Map<number, ESPNPlayerData> {
  const map = new Map<number, ESPNPlayerData>();
  if (fs.existsSync(ESPN_PLAYERS_FILE)) {
    const data: ESPNPlayerData[] = JSON.parse(fs.readFileSync(ESPN_PLAYERS_FILE, 'utf-8'));
    for (const p of data) {
      const normalized = normalizePlayerData(p);
      map.set(normalized.profile.espnId, normalized);
    }
  }
  return map;
}

function saveData(players: Map<number, ESPNPlayerData>): void {
  const arr = Array.from(players.values()).map(normalizePlayerData);
  fs.writeFileSync(ESPN_PLAYERS_FILE, JSON.stringify(arr, null, 2));
}

function loadIndex(): Map<number, PlayerIndexEntry> {
  const map = new Map<number, PlayerIndexEntry>();
  if (fs.existsSync(ESPN_INDEX_FILE)) {
    const data: PlayerIndexEntry[] = JSON.parse(fs.readFileSync(ESPN_INDEX_FILE, 'utf-8'));
    for (const p of data) {
      map.set(p.espnId, p);
    }
  }
  return map;
}

function saveIndex(index: Map<number, PlayerIndexEntry>): void {
  fs.writeFileSync(ESPN_INDEX_FILE, JSON.stringify(Array.from(index.values()), null, 2));
}

function normalizeSearchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchName(name: string): string[] {
  return normalizeSearchName(name).split(' ').filter(Boolean);
}

function levenshteinDistance(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    let rowMin = current[0];

    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      const value = Math.min(
        previous[j + 1] + 1,
        current[j] + 1,
        previous[j] + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[previous.length - 1];
}

function isMinorTokenVariant(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxDistance = Math.max(a.length, b.length) >= 8 ? 2 : 1;
  return levenshteinDistance(a, b, maxDistance) <= maxDistance;
}

function areSearchNamesCompatible(a: string, b: string): boolean {
  const tokensA = tokenizeSearchName(a);
  const tokensB = tokenizeSearchName(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  if (tokensA.length !== tokensB.length) return false;

  const candidateOrders = [tokensB];
  if (tokensB.length === 2) {
    candidateOrders.push([tokensB[1], tokensB[0]]);
  }

  for (const candidateTokens of candidateOrders) {
    let exactMatches = 0;
    let compatible = true;
    for (let i = 0; i < tokensA.length; i++) {
      if (tokensA[i] === candidateTokens[i]) {
        exactMatches += 1;
        continue;
      }
      if (!isMinorTokenVariant(tokensA[i], candidateTokens[i])) {
        compatible = false;
        break;
      }
    }

    if (compatible && exactMatches >= tokensA.length - 1) {
      return true;
    }
  }

  return false;
}

function buildSearchQueries(name: string): string[] {
  const tokens = tokenizeSearchName(name);
  const queries = new Set<string>();
  const normalized = tokens.join(' ');
  if (normalized) queries.add(normalized);
  if (tokens.length >= 2) {
    queries.add([...tokens].reverse().join(' '));
  }
  for (const token of tokens) {
    if (token.length >= 4) queries.add(token);
  }
  return [...queries];
}

function cleanSearchDisplayName(name: string): string {
  return name
    .replace(/&nbsp;/g, ' ')
    .replace(/,\s*\d{4}.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAnchorNameCandidates(anchorName: string): string[] {
  const cleaned = cleanSearchDisplayName(anchorName);
  const candidates = new Set<string>();
  if (cleaned) candidates.add(cleaned);

  if (!cleaned.includes(',')) return [...candidates];

  const [left, right] = cleaned.split(',').map((part) => part.trim()).filter(Boolean);
  if (!left || !right) return [...candidates];

  candidates.add(`${right} ${left}`);

  const leftTokens = tokenizeSearchName(left);
  const rightTokens = tokenizeSearchName(right);
  if (leftTokens.length > 0 && rightTokens.length > 0) {
    candidates.add(`${rightTokens.join(' ')} ${leftTokens[leftTokens.length - 1]}`);
  }

  return [...candidates];
}

function extractSearchCandidates(
  html: string,
  source: string = SEARCH_SOURCE,
): Array<{ entry: PlayerIndexEntry; candidateNames: string[] }> {
  const candidates = new Map<number, { entry: PlayerIndexEntry; candidateNames: Set<string> }>();

  for (const blockMatch of html.matchAll(/<li>[\s\S]*?<\/li>/g)) {
    const block = blockMatch[0];
    const hrefMatch = block.match(/(?:https:\/\/www\.espncricinfo\.com)?\/cricketers\/([a-z0-9-]+)-(\d+)/);
    if (!hrefMatch) continue;

    const slug = hrefMatch[1];
    const espnId = parseInt(hrefMatch[2], 10);
    if (!slug || !Number.isFinite(espnId)) continue;

    const alphabeticalName = block.match(/class="alphabetical-name">([^<]+)</)?.[1];
    const anchorName = block.match(/<a [^>]*>([^<]+)<\/a>/)?.[1];
    const entry = candidates.get(espnId) ?? {
      entry: {
        name: cleanSearchDisplayName(alphabeticalName ?? slug.replace(/-/g, ' ')),
        slug,
        espnId,
        source,
      },
      candidateNames: new Set<string>(),
    };

    entry.candidateNames.add(slug.replace(/-/g, ' '));
    if (alphabeticalName) entry.candidateNames.add(cleanSearchDisplayName(alphabeticalName));
    if (anchorName) {
      for (const candidateName of buildAnchorNameCandidates(anchorName)) {
        entry.candidateNames.add(candidateName);
      }
    }

    candidates.set(espnId, entry);
  }

  return [...candidates.values()].map(({ entry, candidateNames }) => ({
    entry,
    candidateNames: [...candidateNames].filter(Boolean),
  }));
}

function hasIndexedNameMatch(index: Map<number, PlayerIndexEntry>, playerName: string): boolean {
  for (const entry of index.values()) {
    if (areSearchNamesCompatible(playerName, entry.name)) return true;
  }
  return false;
}

async function searchPlayerByName(playerName: string, source: string = SEARCH_SOURCE): Promise<PlayerIndexEntry | null> {
  const scores = new Map<number, { entry: PlayerIndexEntry; score: number }>();
  const queries = buildSearchQueries(playerName);

  for (const [queryIndex, query] of queries.entries()) {
    try {
      const response = await fetch(
        `https://search.espncricinfo.com/ci/content/site/search.html?search=${encodeURIComponent(query)}`,
        {
          headers: {
            'user-agent': SEARCH_USER_AGENT,
            'accept-language': 'en-US,en;q=0.9',
          },
        },
      );
      if (!response.ok) continue;

      const html = await response.text();
      const matches = extractSearchCandidates(html, source)
        .filter((candidate) =>
          candidate.candidateNames.some((candidateName) => areSearchNamesCompatible(playerName, candidateName)),
        )
        .map((candidate) => candidate.entry);
      const weight = queryIndex === 0 ? 4 : queryIndex === 1 ? 3 : 1;

      for (const match of matches) {
        const current = scores.get(match.espnId);
        scores.set(match.espnId, {
          entry: match,
          score: (current?.score ?? 0) + weight,
        });
      }
    } catch {
      // Ignore search failures and keep the index build deterministic.
    }
  }

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.entry.espnId - b.entry.espnId);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0].entry;
}

async function resolvePlayerNamesFromSearch(
  index: Map<number, PlayerIndexEntry>,
  playerNames: string[],
  options: { label: string; source: string },
): Promise<void> {
  const unresolved: string[] = [];
  let alreadyIndexed = 0;
  let added = 0;

  console.log(`\n━━━ Resolving ${options.label} from ESPN Search ━━━`);

  for (const playerName of playerNames) {
    if (hasIndexedNameMatch(index, playerName)) {
      alreadyIndexed += 1;
      continue;
    }

    const resolved = await searchPlayerByName(playerName, options.source);
    if (!resolved) {
      unresolved.push(playerName);
      continue;
    }

    if (!index.has(resolved.espnId)) {
      index.set(resolved.espnId, resolved);
      added += 1;
    }

    await delay(250 + Math.random() * 250);
  }

  saveIndex(index);
  console.log(`  Candidate names: ${playerNames.length}`);
  console.log(`  Already indexed via team pages/search: ${alreadyIndexed}`);
  console.log(`  Added from ESPN search: ${added}`);
  if (unresolved.length > 0) {
    console.log(`  Still unresolved (${unresolved.length}): ${unresolved.join(', ')}`);
  } else {
    console.log(`  All ${options.label.toLowerCase()} resolved to ESPN ids`);
  }
}

async function resolveWPLPlayersFromSearch(index: Map<number, PlayerIndexEntry>): Promise<void> {
  const rosterNames = [...new Set(WPL_2025_ROSTERS.flatMap((roster) => roster.players.map((player) => player.name)))];
  await resolvePlayerNamesFromSearch(index, rosterNames, {
    label: 'WPL Players',
    source: 'wpl-search',
  });
}

async function resolveWomenElitePlayersFromSearch(index: Map<number, PlayerIndexEntry>): Promise<void> {
  const [allCricsheetNames, worldCupNames, wbblNames, hundredNames] = await Promise.all([
    Promise.resolve(loadAllWomenCricsheetNames()),
    Promise.resolve(loadLatestWomenWorldCupNamesFromCricsheet()),
    loadWBBLPlayerNamesFromClubPages(),
    loadHundredSquadPlayerNames(),
  ]);
  const eliteNames = [...new Set([...allCricsheetNames, ...wbblNames, ...hundredNames])];

  console.log('\n━━━ Women Elite Source Summary ━━━');
  console.log(`  Full women Cricsheet names: ${allCricsheetNames.length}`);
  console.log(`  World Cup names: ${worldCupNames.length}`);
  console.log(`  WBBL source names: ${wbblNames.length}`);
  console.log(`  Hundred source names: ${hundredNames.length}`);

  await resolvePlayerNamesFromSearch(index, eliteNames, {
    label: "Women's full Cricsheet / WBBL / Hundred Players",
    source: 'women-elite-search',
  });
}

async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--window-position=50,50',
    ],
    viewport: { width: 1440, height: 900 },
  });
}

// ── Extract player links from a page ────────────────────────────────────

async function extractPlayerLinks(page: Page): Promise<PlayerIndexEntry[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    return [...document.querySelectorAll('a')]
      .filter(a => a.href.match(/\/cricketers\/[^\/]+-\d+$/) && !a.href.includes('/team/'))
      .map(a => {
        const m = a.href.match(/\/cricketers\/(.+)-(\d+)$/);
        if (!m || seen.has(m[2])) return null;
        seen.add(m[2]);
        return {
          name: a.textContent?.trim() || '',
          slug: m[1],
          espnId: parseInt(m[2]),
          source: '',
        };
      })
      .filter(Boolean) as PlayerIndexEntry[];
  });
}

// ── Step 1: Build player index from team pages ──────────────────────────

async function buildPlayerIndex(page: Page): Promise<Map<number, PlayerIndexEntry>> {
  const index = loadIndex();
  const teamsScraped = new Set<string>();

  // Track which teams we've already scraped (from index source field)
  for (const [, entry] of index) {
    if (entry.source) teamsScraped.add(entry.source);
  }

  console.log('\n━━━ Building Player Index from Team Pages ━━━');
  if (index.size > 0) {
    console.log(`  Existing index: ${index.size} players`);
  }

  for (const team of TEAM_PAGES) {
    const teamKey = `${team.slug}-${team.id}`;

    // Always re-check active players (they change)
    const url = `https://www.espncricinfo.com/cricketers/team/${teamKey}`;
    process.stdout.write(`  ${team.name}...`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);

      // Check for access denied
      const title = await page.title();
      if (title.includes('Access Denied')) {
        console.log(' BLOCKED (Access Denied)');
        await delay(10000);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(5000);
        const retryTitle = await page.title();
        if (retryTitle.includes('Access Denied')) {
          console.log('  ⚠ Still blocked, skipping');
          continue;
        }
      }

      // Click "ALL" filter to get all players (not just international)
      const clickedAll = await page.evaluate(() => {
        const allSpan = [...document.querySelectorAll('span')].find(s =>
          s.textContent?.trim() === 'ALL' && s.className.includes('ds-text-tight')
        );
        const link = allSpan?.closest('a');
        if (link) { link.click(); return true; }
        return false;
      });
      if (clickedAll) await delay(2000);

      // Scroll to bottom to load all lazy-loaded players
      let prevCount = 0;
      for (let scroll = 0; scroll < 50; scroll++) {
        const currentCount = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a')].filter(a =>
            a.href.match(/\/cricketers\/[^\/]+-\d+$/) && !a.href.includes('/team/')
          );
          return new Set(links.map(a => a.href.match(/(\d+)$/)?.[1]).filter(Boolean)).size;
        });
        if (currentCount === prevCount && scroll > 0) break; // no new players loaded
        prevCount = currentCount;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);
      }

      const players = await extractPlayerLinks(page);
      let newCount = 0;
      for (const p of players) {
        if (!index.has(p.espnId)) {
          p.source = teamKey;
          index.set(p.espnId, p);
          newCount++;
        }
      }
      console.log(` ${players.length} players (${newCount} new). Total: ${index.size}`);

      // Save after each team in case we get blocked
      saveIndex(index);

    } catch (err) {
      console.log(` ⚠ Failed: ${(err as Error).message.slice(0, 80)}`);
    }

    // Rate limit between team pages
    await delay(2000 + Math.random() * 1000);
  }

  await resolveWPLPlayersFromSearch(index);
  await resolveWomenElitePlayersFromSearch(index);
  saveIndex(index);
  console.log(`\n  Total unique players indexed: ${index.size}`);
  return index;
}

// ── Step 2: Scrape individual player profiles ───────────────────────────

async function scrapePlayerProfile(page: Page, espnId: number, slug: string): Promise<ESPNPlayerData | null> {
  const url = `https://www.espncricinfo.com/cricketers/${slug}-${espnId}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    // Check for access denied
    const title = await page.title();
    if (title.includes('Access Denied')) {
      // Wait and retry
      await delay(15000);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);
      const retryTitle = await page.title();
      if (retryTitle.includes('Access Denied')) {
        return null;
      }
    }

    const data = await page.evaluate(() => {
      const nextDataEl = document.getElementById('__NEXT_DATA__');
      if (!nextDataEl) return null;

      const nextData = JSON.parse(nextDataEl.textContent || '{}');
      const appData = nextData?.props?.appPageProps?.data;
      if (!appData?.player) return null;

      const player = appData.player;
      const content = appData.content;

      // Extract team names
      const teams = (content?.teams || [])
        .map((t: any) => t?.team?.longName || t?.team?.name || '')
        .filter(Boolean);

      const profile = {
        espnId: player.objectId,
        name: player.name,
        longName: player.longName,
        slug: player.slug,
        dateOfBirth: player.dateOfBirth,
        gender: player.gender,
        countryTeamId: player.countryTeamId,
        battingStyles: player.longBattingStyles || player.battingStyles || [],
        bowlingStyles: player.longBowlingStyles || player.bowlingStyles || [],
        playingRoles: player.playingRoles || [],
        teams,
        imageUrl: player.imageUrl || '',
        intlCareerSpan: player.intlCareerSpan || null,
      };

      const careerStats = content?.careerAverages?.stats || [];

      return { profile, careerStats };
    });

    if (!data) return null;

    return normalizePlayerData({
      ...data,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.log(`    ⚠ Error: ${(err as Error).message.slice(0, 80)}`);
    return null;
  }
}

async function scrapeAllProfiles(
  browser: BrowserContext,
  index: Map<number, PlayerIndexEntry>,
  options: { limit?: number; resume: boolean; concurrency: number }
): Promise<void> {
  const existing = loadExistingData();
  const toScrape: PlayerIndexEntry[] = [];

  for (const [id, info] of index) {
    if (options.resume && existing.has(id)) continue;
    toScrape.push(info);
  }

  console.log(`\n━━━ Scraping Player Profiles ━━━`);
  console.log(`  Total in index: ${index.size}`);
  console.log(`  Already scraped: ${existing.size}`);
  console.log(`  To scrape: ${toScrape.length}`);
  console.log(`  Concurrency: ${options.concurrency} tabs`);
  if (options.limit) console.log(`  Limit: ${options.limit}`);

  const total = options.limit ? Math.min(options.limit, toScrape.length) : toScrape.length;
  let scraped = 0;
  let t20Active = 0;
  let failed = 0;
  let consecutiveBlocks = 0;
  const startTime = Date.now();

  // Create worker tabs
  const pages: Page[] = [];
  for (let t = 0; t < options.concurrency; t++) {
    pages.push(await browser.newPage());
  }
  console.log(`  Opened ${pages.length} tabs`);

  // Process in batches of concurrency
  for (let i = 0; i < total; i += options.concurrency) {
    const batch = toScrape.slice(i, Math.min(i + options.concurrency, total));

    const results = await Promise.all(
      batch.map((player, idx) =>
        scrapePlayerProfile(pages[idx], player.espnId, player.slug)
      )
    );

    for (const data of results) {
      if (data) {
        existing.set(data.profile.espnId, data);
        scraped++;
        consecutiveBlocks = 0;
        const hasT20 = hasUsableT20Stats(data);
        if (hasT20) t20Active++;
      } else {
        failed++;
        consecutiveBlocks++;
      }
    }

    // If getting blocked, slow down
    if (consecutiveBlocks >= options.concurrency * 2) {
      console.log(`  ⚠ ${consecutiveBlocks} consecutive failures, waiting 30s...`);
      await delay(30000);
      consecutiveBlocks = 0;
    }

    const done = Math.min(i + options.concurrency, total);
    if (done % 50 < options.concurrency || done === total) {
      const pct = (done / total * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (scraped / (Date.now() - startTime) * 1000 * 3600).toFixed(0);
      console.log(`  [${pct}%] ${done}/${total} | OK: ${scraped} | T20: ${t20Active} | Fail: ${failed} | ${elapsed}s | ~${rate}/hr`);
      saveData(existing);
    }

    // Small delay between batches to not hammer ESPN
    await delay(500 + Math.random() * 500);
  }

  // Close worker tabs
  for (const p of pages) await p.close();

  saveData(existing);
  const totalTime = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n  Done in ${totalTime} min! Scraped: ${scraped}, Failed: ${failed}, T20 active: ${t20Active}`);
  console.log(`  Total players in database: ${existing.size}`);
  console.log(`  Output: ${ESPN_PLAYERS_FILE}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : undefined;
  const resume = args.includes('--resume');
  const skipIndex = args.includes('--skip-index');
  const indexOnly = args.includes('--index-only');
  const normalizeOnly = args.includes('--normalize-only');
  const resolveWplOnly = args.includes('--resolve-wpl-only');
  const resolveWomenEliteOnly = args.includes('--resolve-women-elite-only');
  const concurrency = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : 1;
  const targetedIds = args.includes('--ids')
    ? args[args.indexOf('--ids') + 1]
      .split(',')
      .map(v => parseInt(v.trim(), 10))
      .filter(v => Number.isFinite(v))
    : [];

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  ESPNCricinfo Playwright Scraper             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Options: limit=${limit || 'none'}, resume=${resume}, concurrency=${concurrency}`);
  if (targetedIds.length > 0) console.log(`Targeted ids: ${targetedIds.join(', ')}`);
  if (normalizeOnly) console.log('Mode: normalize cached player data only');
  if (resolveWplOnly) console.log('Mode: resolve missing WPL roster players in index only');
  if (resolveWomenEliteOnly) console.log("Mode: resolve women's elite competition players in index only");
  console.log(`Browser profile: ${BROWSER_PROFILE_DIR}`);

  if (normalizeOnly) {
    const existing = loadExistingData();
    saveData(existing);
    console.log(`  Rewrote normalized cache for ${existing.size} players`);
    console.log(`  Output: ${ESPN_PLAYERS_FILE}`);
    return;
  }

  if (resolveWplOnly) {
    const index = loadIndex();
    console.log(`  Loaded existing index: ${index.size} players`);
    await resolveWPLPlayersFromSearch(index);
    console.log(`  Output: ${ESPN_INDEX_FILE}`);
    return;
  }

  if (resolveWomenEliteOnly) {
    const index = loadIndex();
    console.log(`  Loaded existing index: ${index.size} players`);
    await resolveWomenElitePlayersFromSearch(index);
    console.log(`  Output: ${ESPN_INDEX_FILE}`);
    return;
  }

  // Use headed Chrome with persistent profile to bypass Akamai
  const browser = await launchBrowser();

  try {
    // Step 1: Build index from team pages
    let index: Map<number, PlayerIndexEntry>;

    if (skipIndex) {
      index = loadIndex();
      console.log(`  Loaded existing index: ${index.size} players`);
    } else {
      const page = browser.pages()[0] || await browser.newPage();
      index = await buildPlayerIndex(page);
      await page.close();
    }

    if (indexOnly) {
      console.log('\n✓ Index complete.');
      return;
    }

    if (index.size === 0) {
      console.log('\n⚠ No players in index. Run without --skip-index first.');
      return;
    }

    if (targetedIds.length > 0) {
      index = new Map([...index.entries()].filter(([id]) => targetedIds.includes(id)));
      console.log(`  Filtered index to ${index.size} targeted players`);
    }

    // Step 2: Scrape profiles with parallel tabs
    await scrapeAllProfiles(browser, index, { limit, resume: targetedIds.length > 0 ? false : resume, concurrency });

  } finally {
    await browser.close();
  }
}

main().catch(console.error);
