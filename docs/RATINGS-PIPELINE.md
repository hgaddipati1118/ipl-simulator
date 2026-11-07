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

## CricketArchive per-year ratings and age curves (all senior formats)

Analysis only; the game's runtime ratings are unchanged. From `packages/ratings`:

    duckdb < src/analysis/ca-player-seasons.sql      # scorecards -> player x competition x year cells (~10 s)
    python3 -I src/analysis/ca-ratings.py            # strengths, per-year ratings, age curves, validation (~1 min)
    python3 -I src/analysis/ca-ratings-report.py     # report + sanity checks (exit 1 on failure)
    python3 -I src/analysis/ca-espn-map.py           # ESPN -> CricketArchive id map for the game
    python3 -I src/analysis/export-age-curves.py     # engine age curves for career mode

Outputs in `data/analysis/` (gitignored, backed up to R2): `ca_ratings_by_year.parquet` (player x format x year:
season value, decayed rating, uncertainty, 0-99 ovr and next-year projection for batting and bowling),
`ca_age_curves.csv`, `ca_comp_strength.csv`, `ca_validation.json`, `ca-ratings-report.md`
(snapshot in `docs/CA-RATINGS-REPORT.md`). Needs `data/cricket.db` from `build-db.ts`.

### In the game (`generate-ratings-espn.ts --model`)

`ca-model.ts` loads the CA ratings for every ESPN player matched by `src/analysis/ca-espn-map.py`
(Cricsheet's register, else same date of birth + compatible name; 99.5% correct on register pairs).
`model-ratings.ts` then, per discipline:

- **Cricsheet-rated players**: the ranking score is an inverse-variance blend of the Cricsheet score and the
  CA T20 score mapped onto the Cricsheet scale (regression over players with 500+ balls in both). CA's
  precision is discounted to the share of its balls Cricsheet doesn't have, so shared matches aren't
  counted twice.
- **Players Cricsheet can't rate**: the mapped CA score alone, falling back to List A, then (batting only)
  first-class, translated to the T20 scale through players rated in both. They get the overall a
  Cricsheet-rated player with the same score has (interpolated), without shifting anyone else's rating, and
  keep the generator's attribute mix. A discipline Cricsheet judged a player barely does (< 6 balls a match)
  stays as generated.
- **Small-sample caps**: below B = 7/3 x K career T20 balls (K = the CA model's tuned shrinkage; 70% weight
  on the player's own record) a discipline can't rate above the 95th percentile of established players. A
  discipline rated only from List A / first-class can't rate above the median of players with a real T20
  record (240+ balls), and never below what the generator gave it.
- The ESPN pool (`all-players.ts` / `wpl-players.ts`) is unchanged: CA-only players with no ESPN profile live in the extended pool (next section), which is rated through this same code path.

### Career mode

`python3 -I src/analysis/export-age-curves.py` writes `packages/engine/src/age-curves.ts` from the CA T20 age
curves: rating points per season by gender, for batting attributes (`bat`) and bowling attributes (`pace` /
`spin`). `Player.progress()` uses it in place of the old hand-set `(30 - age) * 0.3` trend (and extra decline
after 32); randomness, training focus and youth potential are unchanged. Women's leagues use the women's
curves (`nextSeason` passes the gender).

## Extended pool: every CricketArchive player, down to club cricket

The bundled pool (5,541 men + 2,379 women, all with ESPN profiles) is joined by an **extended pool** of every other CricketArchive
player with an appearance since 2000: `ca_<CricketArchive id>` ids, rated from CA scorecards only. Counts today (partial lower-level scrape, 10%):

| | men | women |
|---|---|---|
| Senior (Twenty20 / List A / First-Class cards, no ESPN profile) | 18,573 | 12,406 |
| Lower level, tier0: second XIs, touring and other senior sides (event-only cards) | 129,313 | 4,560 |
| tier1 university / tier2 club-league / tier3 youth / tier4 veterans | 0 / 506 / 55 / 22 | 0 |

(165,435 players, 3.7 MB of gzip shards; the 4 tiers below tier0 are small only because the scraper walks tier0 first.)

### Pipeline (from `packages/ratings`, in this order; the CA outputs in `data/analysis/` are gitignored)

    npx tsx src/pipeline/build-db.ts --events-only          # data/cricket-events.db from scorecards-events.jsonl.gz (20 s; cricket.db is untouched)
    duckdb < src/analysis/ca-lower-cells.sql                # lower-level player x competition x year cells
    CA_RATINGS_WORK=/some/tmp python3 -I src/analysis/ca-lower-ratings.py   # lower-level ratings on the senior scale (~1 min)
    duckdb < src/analysis/ca-pool-stats.sql                 # career stats + profile facts for every candidate
    npx tsx src/pipeline/generate-ca-pool.ts --verify       # rates the pool, writes ../app/public/pool/*.json.gz + manifest.json

Re-run all of it as the scrape grows (the events DB is rebuilt from the gzip file; a gzip member being appended is tolerated).
`--verify` proves the bundled pool is untouched: it re-runs the ESPN players through the same model call next to the extended
players and compares with `espn-ratings.json` (0 players changed, both genders). `build-db.ts` without the flag still builds
`cricket.db` as before (it now also stores each match's event tier in `matches.tier`).

### Lower-level ratings (`ca-lower-cells.sql`, `ca-lower-ratings.py`)

Event-only cards (second XIs, university, club, youth, veterans; tiered by `event-tiers.ts`, the scraper's `EVENT_TIERS`, now shared)
become cells like the senior ones: format inferred from the card ("20-over match" -> T20, 25..60 overs -> List A, "N-day" / timed -> FC; else from the
most overs bowled), value = runs above the competition-season average ball. Cards already counted as senior are skipped. Batting is valued only on
innings with balls recorded (29% of tier0 and 67% of club innings have them); bowling uses overs, which every card has.

The senior fit (strengths, weak-tier translation, pools, role offsets, tuned h/K) is re-used unchanged, so no senior rating moves. A lower-level cell is put
on the senior scale as `a = L_c + rho_t * r` (r = rate vs. its competition-season average): `rho_t, alpha_t` are the tier's translation, fitted on cells of
players who also played senior cricket in the same year (the links between the levels, errors-in-variables corrected, rho clipped to [0.3, 1]);
`L_c = alpha_t +` the shrunk mean residual of the links in that competition. A tier with < 40 link cells has no fit and falls back to rho 0.5 and a level below the
weakest senior competitions (5th percentile of senior pools minus 0..1.5 SDs by tier). Ratings then use the senior estimator (decay, shrinkage K, role offset)
over the player's senior and lower-level cells together; sd adds the link regression's residual. Partial-data fits (`ca_lower_validation.json`): T20 men tier0
rho 0.30 (853 links), club rho 1.0 / alpha -24.9 (270 links); List A men tier0 rho 1.0 (561 links); the other tiers are on the fallback until the scrape reaches them.
The link players are selected (good enough to play senior cricket), which flatters alpha, hence the ceilings below.

### Game ratings (`generate-ca-pool.ts`)

- **Who**: every CA player in the stats (senior or lower level) whose id is not mapped to a pool player by `ca_espn_map.csv`, not an ESPN profile with the same
  DOB and a compatible name, and not the same full name + country + age as a pool player (the map missed ~160 men, ~55 women); one gender per player (most matches).
  `LL_MIN_MATCHES` (default 1 = everyone) raises the bar for lower-level-only players when the pool outgrows what you want to ship.
- **Overall and discipline scores**: `ca-model.ts` `loadCa(gender, { lower: true })` gives each CA-only player a batting and bowling score (T20, else List A,
  else batting-only FC, translated exactly as for ESPN players; a lower-level rating replaces the senior one per side as it includes it). `model-ratings.ts` maps the score to the overall a
  Cricsheet-rated player with that score has, without shifting anyone (`playerKey()`: `ca_<id>` is key -id). Small-sample caps are the same function, with
  percentiles still taken over the ESPN pool; List A / FC-only sides cap at the median of T20 regulars.
- **Attribute mix**: the generator's job for ESPN players. For CA-only players it is `calculator.ts` on their own scorecard stats, converted to T20 rates by each
  format's population ratio, and shrunk toward a below-average prior (worth 90 balls batting / 120 bowling, doubled and weaker for lower-level-only players); innings without balls are rated by
  runs and dismissals at the format's average pace. Disciplines without a usable CA record are capped at the median of T20 regulars.
- **Lower-tier ceilings**: a player whose best cricket is tier t can't rate above the 85 / 70 / 55 / 55 / 40th percentile (tier0..4) of established ESPN players per discipline.
- **Role, keeper, style, country, age**: role from what he does (bowls in 35%+ of matches with 2+ overs a spell, bats in the top 7; both within 25 overall points -> all-rounder),
  keeper if he keeps in half his innings, bowling style / hand from the CA profile, country from the international side, else birth country, else the country of his matches; age from DOB (26 when unknown, true for most lower-level players).

### Sanity checks (this run)

- Overall distribution (p10 / median / p90 / p99 / max): ESPN men 44 / 59 / 77 / 87 / 97; extended senior men 34 / 51 / 73 / 81 / 89; tier0 men 26 / 28 / 45 / 67 / 77; club (tier2) men 27 / 28 / 41 / 60 / 69;
  ESPN women 43 / 53 / 73 / 83 / 96; extended senior women 43 / 51 / 67 / 74 / 81; tier0 women 41 / 41 / 48 / 63 / 71.
- Club, youth and veterans players never reach the median of the bundled pool's 100+-match players (77) and none is above the 80th percentile of the pool in either discipline (tests).
- Spot checks: Anil Kumble, Jacques Kallis, Shane Watson (retired, so not in the ESPN pool) rate 87-89 in the extended senior pool.
- Retired players are included (`lastYear` in each row); the deep auction pool uses only players active since 2022 and 40 or younger.

### How the app loads it

`packages/app/public/pool/` holds `manifest.json` and gzip JSON shards (`ca-<men|women>-<senior|tier0..4>[-n].json.gz`, 40,000 players max per shard, sorted best first), format in
`packages/ratings/src/extended-pool.ts`. They are not in the JS bundle: `app/src/extended-pool.ts` fetches the manifest and the shards a request needs
(gunzip with `DecompressionStream`; also fine if the server already decoded them), caches them, and offers `players`, `search`, `counts` and `auctionExtras`.
Set `VITE_POOL_BASE_URL` to serve the shards from object storage once they outgrow the repo (the full scrape could be tens of MB; the pipeline already shards by tier and size).
Shards for 840k lower-level matches should be generated into that storage rather than committed.

- **Player Ratings page**: "Full player database" panel (name / country search over the senior pool, optional lower-level tiers, 50 results, "Add to free agents" via `addPlayerToPool`).
  The page's own table is still the game state's pool and stays capped at 125 rows; only a league's pool is ever scored for scouting.
- **Auction pools**: unchanged by default. A custom league can pick "Deep" (`rules.poolDepth = "deep"`): the best 1,500 active senior extended-pool players per gender join the free-agent pool.
  Lower-level players never enter default or deep pools; they are for search, signing, and (later) youth and domestic squads.
- Presets, saves and multiplayer are untouched (`createGameState(rules, extras)` takes the extras as a second argument).

### Known gaps

Batting for lower-level players rests on the minority of innings with balls recorded; tiers below tier0 are thin or on fallback translations until the scrape reaches them (re-run the pipeline then);
selection bias in the link players (see above); no per-ground or per-team lower-level strength; lower-level players have no DOB on most cards (age 26) and no batting position.

## Venues, pitches, toss/chase and geography (analysis only)

From `packages/ratings` (needs `data/cricket.db`, `data/analysis/match_strength.parquet` from `league-strength-index.py`, and the
Cricsheet `deliveries.parquet` / `matches.parquet`):

    python3 -I src/analysis/venue-conditions.py          # ~4 min; REUSE_BALL=1 skips rebuilding the ball-level stage
    python3 -I src/analysis/venue-conditions-report.py   # report + data-export/venue-conditions.json

Ground names are canonicalised by `src/analysis/venue_canon.py` + `venue_aliases.csv` (renames and sponsor names). Outputs in
`data/analysis/`: `venue_factors.csv` / `venue_factors_by_era.csv` (run / wicket / six factors and pitch profile per ground x
format x scope (all, T20I, ODI, Test) x gender), `venue_ball_factors.csv` (phase and Test-day profiles), `venue_bowler_types.csv`
(bowler-type edges by ground / country / region, phase and batter hand), `toss_chase.csv`, `geography_effects.csv`,
`player_region_splits.parquet`, `venue_validation.csv`, `venue-conditions-report.md` (snapshot in
`docs/VENUE-CONDITIONS-REPORT.md`). `data-export/venue-conditions.json` is a compact table the engine could load later; it is
not wired in (see section 11 of the report for where it would plug in).


## Fielding and wicketkeeping ratings

Two further ratings, `fielding` and `keeping` (0-99, 50 = average), built from Cricsheet ball-by-ball and used by the
match engine (RULES-MATCH.md section 11). From `packages/ratings`:

    duckdb < src/analysis/fielding-stats.sql         # ball-by-ball -> per fielding-innings counts, keepers identified (~15 s)
    python3 -I src/analysis/fielding-ratings.py      # shrinkage, ratings, split-half validation (~10 s)
    python3 -I src/analysis/fielding-report.py       # report + sanity checks (exit 1 on failure)
    npx tsx src/pipeline/patch-fielding.ts           # write the two fields into src/all-players.ts and src/wpl-players.ts

Outputs in `data/analysis/` (new files, nothing existing is touched): `fielding_player_innings.parquet`, `keeping_innings.parquet`,
`keeper_match_map.parquet`, `fielding_match_link.csv`, `fielding_ratings.csv` (one row per Cricsheet player: counts, ratios, ratings, keyed by
Cricinfo id), `fielding_validation.json`, `fielding_ca_keepers.csv` (CricketArchive keeper-flag counts per player and format),
`fielding-report.md` (snapshot in `docs/FIELDING-REPORT.md`: top fielders and keepers, validation, caveats).

### Data

- **Cricsheet** T20 and IT20 matches (2005 on, men and women; 14,745 matches) give every dismissal with its fielders (`fielder_ids`: caught,
  run out, stumped), byes per ball and who bowled it. Cricsheet has no lineups or keeper flag, so a player is "on the field" if he batted, bowled
  or took a fielding credit for that side in the match (11 players on 90% of sides).
- **CricketArchive** scorecards (`data/cricket.db`, `batting.keeper`) give the keeper of each side. Each Cricsheet match is linked to its CA
  match (same date +-1 day, men / women, at least 8 player surname+initial keys in common: 95.5% of matches), and the keeper's name key picks
  the Cricsheet player on that side. A keeper is identified for 87% of team-matches; a further 2% from a stumping credit (not used for rates:
  those innings are selected on the outcome); 11% unknown (the innings is left out of the keeper-dependent statistics and out of the catch
  baseline, where the keeper is needed to separate keeper catches).
- The ESPN pool links through Cricsheet's register (`people.csv` Cricinfo id), which is the id the game's `espn_<id>` players carry; the CA
  <-> ESPN map isn't needed. 5,231 of 5,541 men and 2,152 of 2,379 women have a fielding rating; players Cricsheet doesn't know keep the engine default.

### Fielding (catching and run-outs)

- **Catches** (caught and bowled excluded) are shared among the ten non-keeper fielders of the innings. A fielder's expected catches are his
  teammates' mean in that innings, `E = (team catches - catches off his own bowling - his catches) / 9`. A team that creates many chances, a flat
  pitch, a format or an era with more catches raise every E equally, so chances created, era, format and gender drop out and only the share of the
  side's chances he took is informative. (He can't catch off his own bowling, so those are removed from his pool.) `ratio = sum(O) / sum(E)`.
- **Role**: bowlers are posted at fine leg / third man and take far fewer catches (0.94 of the mean against 1.28-1.29 for batters and part-timers
  among men); position isn't observed. Each fielder is compared with his bowling-load class (balls bowled per fielding innings: 15+, 3-15, <3)
  and half of the class gap is kept in his rating, so a front-line bowler is rated below a batter of equal skill but not buried.
- **Run-outs**: run-outs in which the player was credited (direct hit or assist) against the same leave-one-out expectation, separately for
  keepers (who are involved far more).
- **Shrinkage**: each ratio gets a Gamma(k, k) prior, `k` fitted per gender by maximum marginal likelihood (negative binomial) over all players
  (men: catching k = 8.5, true-skill SD ~34%; women 6.5, ~39%). Posterior mean `(O + k) / (E + k)`: a fielder with 30 innings stays near 50, one with
  300 mostly shows his own record.
- **Rating** = `50 + 14 x (log catch ratio + role offset + 0.4 x log run-out ratio) / SD of true skill`. 14 points per SD of true skill, so
  regulars (100+ innings) have SD ~13 and the whole pool SD ~8 (thin records shrink to 50).
- Validation: catch ratio of a player's odd-numbered vs even-numbered matches correlates 0.72 (men, 518 players with 40+ innings per half) and 0.59 (women, 127):
  catching skill (including where a player is usually posted) is a persistent trait, not noise.

### Keeping

On innings with a known keeper (CA flag), per keeper-innings:

- **Stumpings, catches taken by the keeper, bye events** (deliveries with byes; fewer is better), each against an expectation built from *who
  bowled*: a bowler's own stumping / keeper-catch / bye rate per legal ball (shrunk to the gender mean with a 1,500-ball prior), so a keeper behind
  spinners isn't credited for stumpings the bowlers create. Expectations are then scaled by the event-season factor (observed / expected over the
  tournament-season, shrunk): byes in particular are recorded very differently across leagues.
- Same Gamma-Poisson shrinkage per component. Rating = `50 + 14 x (0.40 log stumpings + 0.25 log catches - 0.35 log byes) / SD`.
- Honest limits: stumpings and keeper catches are mostly the bowlers' (split-half correlation of a keeper's ratio: -0.08 stumpings, 0.19 catches
  for men); byes are the reliable part (0.22 men, 0.38 women). Ratings therefore spread little (keepers with 100+ innings: SD 7 men, 12 women).
  Players who never kept get no keeping rating; the engine gives them 25 (or 50 for a designated keeper with no record).

### In the game

`PlayerRatings.fielding?` and `.keeping?` are optional (absent = fielding 50, keeping 50 for a keeper / 25 otherwise), so saves, mods and
generated players are unaffected. `src/pipeline/fielding-model.ts` maps the CSV onto ESPN players (keeper-tagged players with no record get 50);
`generate-ratings-espn.ts` applies it after the ratings model (`applyFielding`) and writes the fields into `all-players.ts` / `wpl-players.ts`
(`RATINGS_OUT_DIR=<dir>` redirects the generator's JSON outputs away from `data/scraped` when experimenting). A full regeneration re-reads every
source on disk and moves unrelated ratings, so the committed files were produced by `patch-fielding.ts`, which adds only the two fields.
`getRealPlayers()` now also marks a player a keeper when the ESPN data does (it used to rely only on its short curated list).
