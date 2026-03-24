# CricketArchive Scraping Plan

Automated pipeline to extract T20 stats for every player who has played cricket since 2021.

---

## Site Structure (Discovered via Browser Exploration)

### URL Patterns

| Page Type | URL Pattern | Example |
|-----------|------------|---------|
| Countries list | `/Archive/Players/index.html` | ~90+ countries |
| Country players | `/Archive/Players/{CODE}.html` | `/Archive/Players/IND.html` |
| Letter page | `/Archive/Players/{CODE}_{letter}.html` | `/Archive/Players/IND_K.html` |
| Sub-page | `/Archive/Players/{CODE}_{letter}{n}.html` | `/Archive/Players/IND_K4.html` |
| Player profile | `/Archive/Players/{bucket}/{id}/{id}.html` | `/Archive/Players/101/101095/101095.html` |
| Player Oracle | POST to `/cgi-bin/player_oracle_reveals_results1.cgi` | Form-based search |

### Player Page Data (Confirmed from Virat Kohli's page)

**Biographical data:**
- Full name, DOB, country, batting hand, bowling style
- Teams with date ranges per format

**Stats tables per format** (each has batting + bowling):
- Test, ODI, T20I, First-Class, List A, **Twenty20** (all T20s), **IPL** (IPL specifically)
- Under-19 Test/ODI

**Batting table columns:** `M, I, NO, Runs, HS, Ave, 100, 50, SRate, Ct`
**Bowling table columns:** `Balls, Mdns, Runs, Wkts, BBA, Ave, 4wI, 5wI, SRate, Econ`

### Stats We Need for Rating Calculation

From the **Twenty20 Career** section (all T20s combined):

| Stat | Available? | Column |
|------|-----------|--------|
| Matches | Yes | M |
| Innings | Yes | I |
| Not Outs | Yes | NO |
| Runs | Yes | Runs |
| Highest Score | Yes | HS |
| Average | Yes | Ave |
| Strike Rate | Yes | SRate |
| 100s/50s | Yes | 100, 50 |
| Catches | Yes | Ct |
| Balls Bowled | Yes | Balls (bowling table) |
| Runs Conceded | Yes | Runs (bowling table) |
| Wickets | Yes | Wkts |
| Economy | Yes | Econ |
| Bowling SR | Yes | SRate (bowling) |

**Missing (must derive or skip):**
- Balls Faced (not in table — derive from Runs and SRate: `ballsFaced = runs / (SRate/100)`)
- 4s and 6s (not in career summary — available only in match-by-match view)
- These can be estimated: `power = f(SRate, 6s_estimate)` where 6s_estimate is based on SRate

### Also Available: IPL-Specific Stats
Separate section for IPL career — same columns. Useful for IPL-specific ratings.

---

## Scraping Strategy

### Approach 1: Country → Letter → Sub-page → Player Links (RECOMMENDED)

**Step 1: Collect all player URLs**
```
For each country (90+ country codes):
  Fetch /Archive/Players/{CODE}.html
  → Get letter links (A-Z)
  For each letter:
    Fetch /Archive/Players/{CODE}_{letter}.html
    → Get sub-page links ({CODE}_{letter}0, {CODE}_{letter}1, ...)
    For each sub-page:
      Fetch /Archive/Players/{CODE}_{letter}{n}.html
      → Extract all player links: /Archive/Players/{bucket}/{id}/{id}.html
      → Store: { name, url, playerID, country }
```

**Estimated scale:**
- ~90 countries × ~26 letters × ~3 sub-pages avg = ~7,000 index pages
- Each has ~100-1000 player links
- Total players in database: likely 200,000+ (all cricket history)

**Step 2: Filter to active T20 players**
```
For each player URL:
  Fetch player page
  Check if "Twenty20 Career" section exists
  Check if date range overlaps 2021+ (e.g., "2019-2025" includes 2021)
  If yes: extract T20 batting + bowling stats
  If no: skip
```

**Estimated T20 players active since 2021:** ~5,000-8,000

### Approach 2: Player Oracle Batch Query (ALTERNATIVE)

The Player Oracle form accepts:
- `searchtype=PlayerProfile`
- `playernumber={ID}` — query by numeric player ID
- `matchtype=Twenty20` — T20 stats only
- `startseason=2021` / `endseason=2025` — season filters (but only works for match lists, not profiles)

However: season filter doesn't work on PlayerProfile view (confirmed by testing). It always shows career totals.

### Approach 3: Hybrid — Cricsheet + CricketArchive

1. Use **Cricsheet.org** ball-by-ball data to identify all players who played T20 since 2021 (get player names)
2. Use **CricketArchive** to get career stats for those specific players (by name search or direct URL)
3. Cross-reference for validation

**This is the best approach** — Cricsheet gives us the player list, CricketArchive gives us pre-aggregated career stats.

---

## Recommended Hybrid Pipeline

### Phase A: Build player list from Cricsheet (FREE, no scraping)

```typescript
// Download Cricsheet T20 ZIPs for 2021-2025 matches only
// Parse each match JSON
// Extract unique player names + their country (from match info)
// Output: Set of ~5000-8000 players with names and countries

interface CricsheetPlayer {
  name: string;          // "V Kohli"
  fullName?: string;     // from "people" field in newer files
  country: string;       // from team they played for
  registryId?: string;   // from "people" field
  matchesPlayed: number; // count of T20 matches since 2021
  lastPlayed: string;    // most recent match date
}
```

### Phase B: Look up each player on CricketArchive

**Option B1: Direct URL if we can map IDs**
```
GET /Archive/Players/{bucket}/{id}/{id}.html
```
Parse HTML → extract T20 batting + bowling tables.

**Option B2: Player Oracle POST**
```
POST /cgi-bin/player_oracle_reveals_results1.cgi
  searchtype=PlayerProfile
  playername={name}
  playermatch=exact
  matchtype=Twenty20
```
This returns the profile page with T20 stats. If multiple matches, user must disambiguate.

**Option B3: Build local player ID index first**
Crawl country index pages to build `{ name → playerID }` mapping. Then use direct URLs.

### Phase C: Parse stats from HTML

```typescript
function parsePlayerPage(html: string): PlayerStats {
  // Extract biographical info
  const fullName = html.match(/Full name:([^<]+)/)?.[1]?.trim();
  const born = html.match(/Born:([^<]+)/)?.[1]?.trim();
  const batting = html.match(/Batting:([^<]+)/)?.[1]?.trim();
  const bowling = html.match(/Bowling:([^<]+)/)?.[1]?.trim();

  // Extract T20 batting stats
  const t20BatRegex = /Twenty20 Career Batting and Fielding[^<]*<\/b><\/td><\/tr>\s*<tr>(?:<td><b>\w+<\/b><\/td>)+<\/tr>\s*<tr><td>[^<]+<\/td>((?:<td>[^<]*<\/td>)+)/;
  const batMatch = html.match(t20BatRegex);
  // Parse: M, I, NO, Runs, HS, Ave, 100, 50, SRate, Ct

  // Extract T20 bowling stats
  const t20BowlRegex = /Twenty20 Career Bowling[^<]*<\/b><\/td><\/tr>\s*<tr>(?:<td><b>\w+<\/b><\/td>)+<\/tr>\s*<tr><td>[^<]+<\/td>((?:<td>[^<]*<\/td>)+)/;
  const bowlMatch = html.match(t20BowlRegex);
  // Parse: Balls, Mdns, Runs, Wkts, BBA, Ave, 4wI, 5wI, SRate, Econ

  // Also extract IPL-specific stats if available
  // Same regex with "Indian Premier League Career" prefix

  return {
    fullName, born, battingHand: batting, bowlingStyle: bowling,
    t20Batting: { matches, innings, notOuts, runs, highScore, average, hundreds, fifties, strikeRate, catches },
    t20Bowling: { balls, maidens, runs: runsConceded, wickets, bestBowling, average: bowlAvg, fourWickets, fiveWickets, strikeRate: bowlSR, economy },
    iplBatting: { /* same fields */ },
    iplBowling: { /* same fields */ },
  };
}
```

### Phase D: Convert to ratings

```typescript
import { calculateRatings } from "./calculator.js";

function cricketArchiveToRatings(stats: PlayerStats): CalculatedRatings {
  // Derive ballsFaced from runs and strikeRate
  const ballsFaced = stats.t20Batting.strikeRate > 0
    ? Math.round(stats.t20Batting.runs / (stats.t20Batting.strikeRate / 100))
    : 0;

  // Estimate 4s and 6s from strike rate (since CricketArchive doesn't show them in career view)
  // Higher SR → more boundaries. Average T20: ~60% of runs from boundaries
  const boundaryRuns = stats.t20Batting.runs * 0.6;
  const estimatedSixes = Math.round(boundaryRuns * 0.3 / 6); // ~30% of boundary runs from 6s
  const estimatedFours = Math.round(boundaryRuns * 0.7 / 4); // ~70% of boundary runs from 4s

  return calculateRatings({
    name: stats.fullName,
    age: calculateAge(stats.born),
    country: stats.country,
    matches: stats.t20Batting.matches,
    battingInnings: stats.t20Batting.innings,
    notOuts: stats.t20Batting.notOuts,
    runs: stats.t20Batting.runs,
    ballsFaced,
    fours: estimatedFours,
    sixes: estimatedSixes,
    bowlingInnings: stats.t20Bowling.balls > 0 ? stats.t20Batting.matches : 0,
    ballsBowled: stats.t20Bowling.balls,
    runsConceded: stats.t20Bowling.runs,
    wickets: stats.t20Bowling.wickets,
    catches: stats.t20Batting.catches,
  });
}
```

---

## Rate Limiting & Politeness

CricketArchive is a community-run site. Must be respectful:

| Setting | Value |
|---------|-------|
| Delay between requests | **2-3 seconds** minimum |
| Concurrent requests | **1** (sequential only) |
| Batch size | 500 players per run |
| Total scraping time | ~5000 players × 3s = ~4 hours |
| User-Agent | Custom identifying string |
| Retry on error | 3 retries with 10s backoff |
| Cache | Cache all fetched pages locally (don't re-fetch) |
| robots.txt | Check and respect |

### Estimated Timeline
- Phase A (Cricsheet): 10 minutes (file download + parse)
- Phase B (CricketArchive): ~4 hours for 5000 players at 3s/request
- Phase C (Parse): Near-instant (local HTML parsing)
- Phase D (Ratings): Near-instant
- **Total: ~5 hours for complete pipeline run**

---

## Output

The pipeline produces `packages/ratings/src/all-players.ts`:

```typescript
export const ALL_PLAYERS: PlayerData[] = [
  {
    id: "ca_101095",
    name: "Virat Kohli",
    age: 37,
    country: "India",
    role: "batsman",
    ratings: {
      battingIQ: 95, timing: 91, power: 84, running: 86,
      wicketTaking: 20, economy: 18, accuracy: 15, clutch: 19
    },
    isInternational: false,
    isCapped: true,
    source: "cricketarchive",
    cricketArchiveId: 101095,
  },
  // ... 5000+ more players
];
```

---

## Missing Data: 4s and 6s

CricketArchive career pages don't show 4s/6s in the summary tables. Three options:

1. **Estimate from strike rate** (simplest — implemented above)
2. **Scrape match-by-match detailed stats** (available on CricketArchive but 100x more requests)
3. **Cross-reference with Cricsheet** (ball-by-ball data has exact 4s/6s — RECOMMENDED)

**Best approach: Hybrid**
- Get career aggregates (M, I, NO, Runs, Ave, SR, Wkts, Econ) from **CricketArchive** (fast, pre-aggregated)
- Get 4s and 6s counts from **Cricsheet** ball-by-ball aggregation (free, accurate)
- Merge by player name fuzzy matching

---

## npm Scripts

```json
{
  "ratings:cricsheet-players": "tsx src/pipeline/cricsheet-players.ts",
  "ratings:scrape-archive": "tsx src/pipeline/scrape-archive.ts",
  "ratings:merge-sources": "tsx src/pipeline/merge-sources.ts",
  "ratings:generate": "tsx src/pipeline/generate.ts",
  "ratings:validate": "tsx src/pipeline/validate.ts",
  "ratings:full": "npm run ratings:cricsheet-players && npm run ratings:scrape-archive && npm run ratings:merge-sources && npm run ratings:generate && npm run ratings:validate"
}
```

---

## Unit Tests

| Test | Description |
|------|-------------|
| `parse-player-page.test.ts` | Parse Kohli's HTML → verify M=414, Runs=13543, Ave=41.92, SR=134.67 |
| `derive-balls-faced.test.ts` | Runs=100, SR=150 → ballsFaced=67 |
| `estimate-boundaries.test.ts` | Estimated 4s/6s within 20% of Cricsheet actuals |
| `country-index.test.ts` | Crawl IND_K0 → extract 967 player links |
| `rating-conversion.test.ts` | Kohli stats → OVR 85+, Bumrah → bowlingOvr 85+ |
| `merge-sources.test.ts` | CricketArchive + Cricsheet merge for same player matches |
