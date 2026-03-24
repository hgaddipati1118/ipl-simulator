# Ratings Pipeline — Automated Player Rating Generation

Generate accurate 8-attribute ratings for every T20 cricketer from real match data.

---

## Recommended Data Source: Cricsheet.org

After evaluating 10+ sources, **Cricsheet.org** is the clear winner:

| Criteria | Cricsheet.org |
|----------|--------------|
| Cost | **Free** (open data, attribution required) |
| Coverage | **21,332 matches**, 5,000+ players |
| IPL matches | **1,169** (all seasons) |
| T20I matches | **1,432+** |
| Other T20 leagues | BBL (662), CPL (407), T20 Blast (815), PSL (146), SA20 |
| Data format | **JSON** (ball-by-ball) |
| Rate limits | **None** (file download, no API) |
| Update frequency | Continuously updated |
| Can derive all stats? | **Yes** — ball-by-ball data lets us compute everything |

### Why Not Other Sources?

| Source | Verdict |
|--------|---------|
| ESPNCricinfo | No API, anti-bot measures, TOS prohibits scraping at scale |
| CricAPI/CricketData.org | 100 req/day free (30 days to scrape 3000 players) |
| Sportmonks | EUR 29-75/month, overkill for this |
| Roanuz | EUR 55+/month, IPL package ₹44,999 |
| EntitySport | $150-450/month |
| Kaggle | Static snapshots, IPL-only, not auto-updating |

### Supplementary Sources
- **Kaggle IPL 2025 Player Stats** — Quick bootstrap for IPL-specific data
- **ESPNCricinfo Statsguru** — Manual spot-checks for validation (not automated)

---

## Pipeline Architecture

```
┌─────────────────────────────┐
│  Cricsheet.org ZIP files    │
│  (JSON ball-by-ball data)   │
│  ~200MB total, 21K matches  │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Step 1: Download & Parse   │
│  npm run ratings:download   │
│  Download T20 match ZIPs    │
│  Parse JSON match files     │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Step 2: Aggregate Stats    │
│  npm run ratings:aggregate  │
│  Per-player career stats:   │
│  - matches, innings, runs   │
│  - balls faced, 4s, 6s     │
│  - balls bowled, wickets    │
│  - runs conceded, catches  │
│  Output: player-stats.json  │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Step 3: Calculate Ratings  │
│  npm run ratings:generate   │
│  Use calculator.ts formulas │
│  8 attributes per player    │
│  Output: all-players.ts     │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Step 4: Validate           │
│  npm run ratings:validate   │
│  Compare vs existing 3255   │
│  Spot-check known players   │
│  Flag outliers              │
└─────────────────────────────┘
```

---

## Step 1: Download Cricsheet Data

### Files to Download

| URL | Content | Size |
|-----|---------|------|
| `https://cricsheet.org/downloads/ipl_json.zip` | All IPL matches | ~30MB |
| `https://cricsheet.org/downloads/t20s_json.zip` | All T20I matches | ~20MB |
| `https://cricsheet.org/downloads/bbl_json.zip` | Big Bash League | ~10MB |
| `https://cricsheet.org/downloads/cpl_json.zip` | Caribbean PL | ~5MB |
| `https://cricsheet.org/downloads/psl_json.zip` | Pakistan SL | ~3MB |
| `https://cricsheet.org/downloads/t20_blast_json.zip` | T20 Blast | ~15MB |
| `https://cricsheet.org/downloads/sa20_json.zip` | SA20 | ~2MB |

### Implementation
```typescript
// packages/ratings/src/pipeline/download.ts
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Extract } from "unzip-stream";

const CRICSHEET_URLS = [
  "https://cricsheet.org/downloads/ipl_json.zip",
  "https://cricsheet.org/downloads/t20s_json.zip",
  // ... more leagues
];

async function downloadCricsheetData(outputDir: string): Promise<void> {
  for (const url of CRICSHEET_URLS) {
    const response = await fetch(url);
    await pipeline(
      response.body,
      Extract({ path: outputDir })
    );
  }
}
```

---

## Step 2: Aggregate Player Stats

### Cricsheet JSON Match Format
```json
{
  "info": {
    "teams": ["Mumbai Indians", "Chennai Super Kings"],
    "dates": ["2024-03-22"],
    "event": { "name": "Indian Premier League" },
    "match_type": "T20"
  },
  "innings": [{
    "team": "Mumbai Indians",
    "overs": [{
      "over": 0,
      "deliveries": [{
        "batter": "Rohit Sharma",
        "bowler": "Deepak Chahar",
        "runs": { "batter": 4, "extras": 0, "total": 4 },
        "wickets": []
      }]
    }]
  }]
}
```

### Aggregation Logic
```typescript
interface PlayerCareerStats {
  name: string;
  country: string;       // inferred from match data
  matchesPlayed: number;

  // Batting
  battingInnings: number;
  notOuts: number;
  totalRuns: number;
  totalBallsFaced: number;
  totalFours: number;
  totalSixes: number;
  highestScore: number;

  // Bowling
  bowlingInnings: number;
  totalBallsBowled: number;
  totalRunsConceded: number;
  totalWickets: number;

  // Fielding
  catches: number;

  // Derived (computed after aggregation)
  battingAverage: number;    // runs / (innings - notOuts)
  strikeRate: number;        // (runs / ballsFaced) * 100
  bowlingAverage: number;    // runsConceded / wickets
  economyRate: number;       // runsConceded / (ballsBowled / 6)
  bowlingStrikeRate: number; // ballsBowled / wickets
}
```

### Per-Delivery Processing
```typescript
for (const delivery of over.deliveries) {
  // Batting stats
  const batter = getOrCreatePlayer(delivery.batter);
  batter.totalRuns += delivery.runs.batter;
  batter.totalBallsFaced += 1; // legal delivery
  if (delivery.runs.batter === 4) batter.totalFours++;
  if (delivery.runs.batter === 6) batter.totalSixes++;

  // Bowling stats
  const bowler = getOrCreatePlayer(delivery.bowler);
  bowler.totalBallsBowled += 1;
  bowler.totalRunsConceded += delivery.runs.total;

  // Wicket
  if (delivery.wickets?.length > 0) {
    for (const wkt of delivery.wickets) {
      bowler.totalWickets++;
      // Mark batter dismissal (not notOut)
    }
  }

  // Extras (wides, noballs don't count as balls faced)
  if (delivery.extras?.wides || delivery.extras?.noballs) {
    batter.totalBallsFaced--; // undo the increment
    bowler.totalBallsBowled--; // undo
  }
}
```

---

## Step 3: Calculate Ratings

Use existing `calculator.ts` formulas. The mapping from career stats to raw stats input:

```typescript
import { calculateRatings } from "./calculator.js";

function statsToRatings(stats: PlayerCareerStats): CalculatedRatings {
  return calculateRatings({
    matches: stats.matchesPlayed,
    battingInnings: stats.battingInnings,
    notOuts: stats.notOuts,
    runs: stats.totalRuns,
    ballsFaced: stats.totalBallsFaced,
    fours: stats.totalFours,
    sixes: stats.totalSixes,
    bowlingInnings: stats.bowlingInnings,
    ballsBowled: stats.totalBallsBowled,
    runsConceded: stats.totalRunsConceded,
    wickets: stats.totalWickets,
    catches: stats.catches,
  });
}
```

### Rating Formulas Recap
| Attribute | Formula |
|-----------|---------|
| battingIQ | `20 + (avg / 50) × 70` |
| timing | `15 + (avg / 45) × 50 + expFactor × 25` |
| power | `15 + sixesPerInnings × 25 + (boundaryPct / 80) × 30` |
| running | `20 + runningRate × 40 + (SR - 100) × 0.3` |
| wicketTaking | `15 + (30 / max(bowlSR, 8)) × 50 + wktsPerMatch × 15` |
| economy | `15 + ((12 - econRate) / 6) × 70` |
| accuracy | `15 + ((10 - econRate) / 5) × 40 + bowlExpFactor × 30` |
| clutch | `(wicketTaking + economy) / 2 + (wktsPerMatch > 1.5 ? 10 : 0)` |

All clamped to **[15, 99]**.

---

## Step 4: Validate

### Automated Validation Tests
1. **Known player spot-checks** (10 players):
   - Virat Kohli: OVR 85+, battingOvr 88+
   - Jasprit Bumrah: bowlingOvr 85+
   - Ravindra Jadeja: all-rounder (|batOvr - bowlOvr| ≤ 15)
   - etc.

2. **Regression against existing data**:
   - Compare pipeline output to `2022PlayerRatingsWithTeams.csv`
   - 90% of players should match within ±5 for each attribute
   - Flag any player with >10 point difference for manual review

3. **Distribution validation**:
   - Average OVR should be ~45-55 (most players are average)
   - Top 20 players should have OVR 85+
   - Role distribution: ~40% batsmen, ~35% bowlers, ~25% all-rounders

4. **Edge cases**:
   - Players with <5 matches: flag as "insufficient data"
   - Players with 0 bowling: bowlingOvr should be 15-25
   - Players with 0 batting: battingOvr should be 15-25

---

## Player Name Matching

Cricsheet uses full names (e.g., "V Kohli", "Virat Kohli"). Need fuzzy matching to link:
- Cricsheet names → existing CSV names → IPL roster names

```typescript
function fuzzyMatchPlayer(
  cricsheetName: string,
  existingPlayers: Map<string, PlayerData>
): PlayerData | null {
  // Exact match first
  if (existingPlayers.has(cricsheetName)) return existingPlayers.get(cricsheetName)!;

  // Last name match
  const lastName = cricsheetName.split(" ").pop()!;
  const candidates = [...existingPlayers.values()].filter(p =>
    p.name.endsWith(lastName)
  );
  if (candidates.length === 1) return candidates[0];

  // Levenshtein distance for fuzzy match
  // ...
}
```

Cricsheet also provides a `people` field in newer JSON files with player registry IDs, which helps with disambiguation.

---

## npm Scripts

```json
{
  "scripts": {
    "ratings:download": "tsx src/pipeline/download.ts",
    "ratings:aggregate": "tsx src/pipeline/aggregate.ts",
    "ratings:generate": "tsx src/pipeline/generate.ts",
    "ratings:validate": "tsx src/pipeline/validate.ts",
    "ratings:full": "npm run ratings:download && npm run ratings:aggregate && npm run ratings:generate && npm run ratings:validate"
  }
}
```

---

## Output Format

The pipeline outputs `packages/ratings/src/all-players.ts`:
```typescript
export const ALL_PLAYERS: PlayerData[] = [
  {
    id: "cric_1",
    name: "Virat Kohli",
    age: 37,
    country: "India",
    role: "batsman",
    ratings: { battingIQ: 95, timing: 91, power: 84, running: 86, wicketTaking: 28, economy: 16, accuracy: 15, clutch: 22 },
    isInternational: false,
    isCapped: true,
  },
  // ... 5000+ more players
];
```

---

## Data Freshness Strategy

1. **Pre-season refresh**: Run `npm run ratings:full` before each simulated season
2. **Cricsheet updates**: Re-download ZIP files (they're updated after each match)
3. **Incremental updates**: Can diff new matches vs already-processed to only aggregate new data
4. **Snapshot after each generation**: Use existing snapshot system to track rating changes

---

## Estimated Player Counts

| League | Estimated Players |
|--------|------------------|
| IPL (all seasons) | ~800 unique |
| T20I (all countries) | ~2,500 unique |
| BBL | ~600 unique |
| CPL | ~400 unique |
| PSL | ~300 unique |
| T20 Blast | ~1,000 unique |
| SA20 | ~200 unique |
| **Total (with overlap)** | **~4,000-5,000 unique** |

---

## Unit Tests

See TESTING-STRATEGY.md Phase 1D-TEST:
- Known player validation (10 players against expected ranges)
- Edge cases (0 bowling, 0 batting stats)
- Range validation (all attributes in [15, 99])
- Role inference accuracy
- Regression against existing 3255-player CSV
- Stat conversion accuracy (avg 50 → battingIQ ~90)
