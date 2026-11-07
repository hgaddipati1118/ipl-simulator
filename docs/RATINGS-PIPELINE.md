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

`python3 -I src/analysis/export-age-curves.py` still writes `packages/engine/src/age-curves.ts` from the CA T20 age
curves (rating points per season by gender and bat / pace / spin), but `Player.progress()` no longer uses it: since the
progression model below, season-to-season movement comes from `progression-model.ts`. The age curves stay exported for
analysis and the spin-vs-pace test.

## Progression model (ratings over time)

Fitted on the CricketArchive per-year T20 ratings (`ca_ratings_by_year.parquet`, men and women), exported to
`packages/engine/src/progression-model.ts`, sampled by `packages/engine/src/progression.ts` and used by
`Player.progress()`. From `packages/ratings`:

    python3 -I src/analysis/progression.py        # fit + export engine params, validation cohort fixture, report (~3 s)
    npm run progression -- --validate             # simulated vs real cohorts (tsx; build the engine first)
    npm run progression -- --player "Shubman Gill" --seasons 8
    npm run progression -- --age 19 --bat 55 --bowl 25 --role batsman

Outputs: `data/analysis/progression_params.json`, `progression-report.md` (fit tables, year effects, retirement
calibration), `packages/engine/src/__tests__/fixtures/progression-cohort.json` (the 2015 men / 2018 women cohorts the
tests validate against; committed, ~140 KB).

**What is modelled.** For each discipline (batting, bowling) the next season's overall (0-99; the game's discipline
overalls sit on the same scale, slope ~1.0 batting / ~0.9 bowling against the CA values of current players) moves by

    change = mean(age, level, last change, experience, kind) + sd(age, experience) * z

fitted on consecutive-season pairs of players who were regulars (120+ T20 balls) in that discipline, men and women
separately (women ridge-shrunk toward the men's coefficients):

| piece | what the data say (men, batting; bowling is similar) |
|---|---|
| age and experience | 10 age bins (linear between bin centres) plus log seasons of rating evidence. Net, for a 65 batter with typical experience: +0.3 a year at 20, +0.7 at 23-26, +0.5 at 29, +0.2 at 32, about -0.1 from 35. The age gradient is gentle: most of the decline of good players is regression to the mean plus retirement |
| regression to the mean | -0.073 points a season per point above 65 (a little weaker above 80): a 50 climbs 1.4-1.8 a year, an 80 falls 0.4-1.2, a 90 falls 0.9-1.7 |
| coming off an outlier season | the last season's change enters with a negative coefficient for batting (-0.03; about 0 for bowling): part of a jump is given back |
| experience (spread) | new players are rated from little data, so they move more: sd 3.9 points at one season of evidence, 2.5 at ten |
| kind | lower-order batters (-0.4), spinners (+0.7 bowling): small offsets |
| spread and tails | residual sd ~3.1 points; the empirical standardised residual quantiles are kept, so breakouts and collapses occur at their real rate: |z| > 3 in 1.0% of seasons (a normal would give 0.27%), |z| > 2 in 5.7% (4.6%) |
| calendar drift | the ovr scale is re-normalised each year, so a whole cohort drifts together (mean change by year swings between about -5 and +5). That is an artefact, so the fit and the validation both work net of it (`yearEffects` in the params JSON) |
| retirement | logistic hazard of never playing T20 again within four seasons, by age (10 bins), level, role (batter / pace / spin / all-rounder) and gender; calibrates to the observed rates by age (3.8% under 23, 6.5% at 29-31, 14% at 34-35, 26% at 38-39, 31% at 42+) |

Secondary disciplines (a bowler's batting) are not identified from the CA data (those ratings are heavily shrunk on a
different scale), so they are a judgement: half the age drift, 0.6x the spread, 8% a year reversion to the secondary
mean of the game's players (42 batting for bowlers, 35 bowling for batters).

**In the engine.** `Player.progress({ rng, gender })` draws the batting and bowling change, spreads each over the
discipline's attributes (weighted so the discipline overall moves by exactly the draw) with 1.8 points of individual
attribute noise, then applies the training focus and intensity as before. The previous season's overall comes from
`ratingHistory`, experience from `Player.experience` (estimated from age and T20 matches for real players). `potential`
(prospects) is a drawn talent (sd 3.5 points) on top of the typical path: `talentLeft` is realised evenly up to age 27 and
the prospect's own luck is scaled by 0.9 so the total spread stays what real careers show. `rng` makes it deterministic.

**Standalone simulator.** `projectPlayer(player, { seasons, runs, seed, gender })` in `progression-sim.ts` returns, per
season ahead, the share still playing and p10/p25/p50/p75/p90 bands of batting, bowling and overall; `simulateCareer`
runs one career; `retirementProbability` is the hazard. The CLI above wraps them.

**Validation** (`progression-validation.ts`; `npx vitest run packages/engine/src/__tests__/progression.test.ts`).
Real players' states in 2015 (men, 779 regulars) and 2018 (women, 490) are simulated forward with `Player.progress()` and
the retirement hazard (100 runs each) and compared with what happened, net of the calendar drift. Men:

| seasons ahead | still playing real / sim | ovr mean | ovr sd | mean change | share who improve | +8 breakouts | -8 collapses |
|---|---|---|---|---|---|---|---|
| 1 | 93% / 94% | 65.5 / 65.3 | 11.0 / 10.7 | -0.2 / +0.1 | 35% / 40% | 2.4% / 2.5% | 0.8% / 0.7% |
| 3 | 81% / 81% | 66.7 / 65.8 | 10.7 / 10.1 | 0.0 / +0.3 | 42% / 46% | 9.8% / 8.9% | 7.3% / 5.5% |
| 5 | 68% / 68% | 67.9 / 66.3 | 10.1 / 9.6 | +0.3 / +0.5 | 49% / 48% | 12.6% / 13.5% | 11.7% / 10.1% |
| 8 | 49% / 49% | 67.1 / 67.0 | 9.0 / 8.9 | +0.9 / +0.7 | 51% / 50% | 18.6% / 18.9% | 12.6% / 14.0% |

Peak age of players aged 18-24 at the start (best of the observed seasons): 26.8 real / 27.1 simulated. Median age of the
last regular season: batters 33 / 33, pace 31 / 31, spin 32 / 33, all-rounders 35 / 35. Women (cohort of 2018, thinner
data): still playing 96/94, 81/82, 70/70, 49/52%; spread at 5 seasons 8.6 / 9.1; peak age 24.0 / 24.9; the model keeps
a slight upward drift for women (+0.4 against -0.8 real at 5 seasons) that the tests allow for. The mean ovr of
survivors is up to 1.6 points lower in the simulation at 3-5 seasons because the simulated players never skip a year
(a real player with a gap year is missing from "plays that season" but still counts as playing).

**League balance.** A 20-season sim of a 500-player pool (hazard retirement, a regen per retiree, youth) keeps the average
overall within 1 point of where it started and the top-150 average within 1 (tests assert 2.5), with the spread about
15% narrower (the youngest entrants are rated from little data) and the average age settled near 28.

## Generated players

`packages/engine/src/player-generator.ts` samples fictional players from the real joint distribution of the game's ratings;
fit with `python3 -I src/analysis/player-generation.py` (needs `data/analysis/game_players.json` from
`npx tsx src/analysis/export-game-players.ts`), which writes `generation-model.ts` and `name-model.ts` into the engine.

- **Strata**: gender x role class (batter, keeper, all-rounder, pace, spin) of the 7,920 rated players (5,541 men, 2,379
  women). Per stratum each of the 8 ratings is turned into a normal score (rank -> normal quantile), regressed on age
  (quadratic) and region (India, other subcontinent, England/Australia/NZ/South Africa, West Indies, tier-2 nations, other),
  and the correlation of the residuals is kept as a Cholesky factor. Sampling draws correlated normals, adds the age /
  region mean, and maps every score back through the stratum's own marginal quantiles (21 quantiles per attribute), so
  marginals, between-attribute correlations (batting block ~0.6-0.95, bowling ~0.4-0.7) and the age and region shifts are
  the real ones. The result goes through `createPlayerFromData`, so the game's own role inference and secondary-rating
  balancing apply; draws that would be re-labelled (an all-rounder that is not good enough at both) are redrawn.
- **Role, country, age**: a role class, country and age (or range) can be asked for; the default role mix is that of the
  players on IPL / WPL rosters, tilted a little toward bowlers and all-rounders (a squad needs five bowling options and a
  keeper); countries default to the old T20 mix (India 40%, ...). `kind` presets: `youth` (17-20), `regen` (18-23),
  `fill` (22-34), `pool` (the real age profile). `overall: [lo, hi]` redraws until the player falls in a window.
- **Bowling style and hand** come from the stratum's real mix (batters: 80% don't bowl; 25-30% left-handed).
- **Potential**: for youth / regen / young pool players a talent is drawn (sd 3.5 points), `potential` = the typical
  path's rating at 27 + talent (0-99 rating scale: the best prospects reach the high 70s), `talentLeft` is what
  `progress()` still has to realise. Scout grades: Diamond 78+ (top ~4%), Gold 71+, Silver 64+.
- **Names** (`names.ts`): first and last names are drawn independently from pools built from ESPN long names, per name
  group (India, Pakistan, Bangladesh, Sri Lanka, Afghanistan, Nepal, British Isles, Australia, New Zealand, South Africa,
  West Indies, Africa, Gulf, diaspora, Asia-Pacific, Europe) and gender; frequencies are flattened (power 0.75) so common
  names don't dominate. A hashed blocklist (`REAL_NAME_HASHES`, FNV-1a, 9,511 hashes) holds every real full name
  (ESPN + all CricketArchive names, 34,874) that a first + last mix from the pools could reproduce, and generation
  redraws on a hit, so a generated player never carries a real person's full name (first or last names alone do repeat,
  as in real life).
- **Seeded**: everything draws from the `rng` passed in; `generatePlayers(n, rng, opts, idPrefix)` gives ids
  `prefix_1..n`, so a seed reproduces the same players, names and ids.

Samples (seed 3, `npm run progression -- --generate 6 --kind youth --seed 3`):

    Darren McAllister  West Indies  19 batsman     57 bat  27 bowl  57 ovr  potential 71
    Suresh Dinda       India        20 bowler      31 bat  56 bowl  56 ovr  potential 59
    Ali Faizan         Pakistan     20 bowler      37 bat  71 bowl  72 ovr  potential 72
    Ben Perchard       England      20 batsman+wk  80 bat  30 bowl  80 ovr  potential 81

**Where it is used.** Career mode (`nextSeason`): a regen replaces every retiree (same role class, country and gender),
15 fill-in squad players and 2-4 youth academy prospects join the pool, all seeded from `GameState.worldSeed`; the
fully-generated pools (`generatePlayerPool`, `generateRandomPlayer`, `playerSource: "generated"` leagues, the
multiplayer draft top-ups) use the same generator.

## Ratings over time (app)

`python3 -I src/analysis/export-rating-history.py` writes `packages/app/public/data/rating-history.json` (~520 KB,
~155 KB gzipped, fetched lazily by the player page): per game player the real T20 batting and bowling overall for each
year from first to last season (`-1` = none), keyed by CricketArchive id with a game-id map. The player page's
"Rating Projection" card now draws, on one age axis: the real history (blue), the career so far in the game
(`Player.ratingHistory`, one entry per season with the age, 25 seasons kept; green), and the simulated future (orange:
median, 50% and 80% bands over the careers still playing, 200 seeded runs). The real line is shown shifted by a few
points to meet the game's rating at the start of the career (stated under the chart); series buttons switch between
overall, batting and bowling.

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

### Fielding and keeping progression

`Player.progress()` used to move only the eight core ratings. The fielding and keeping ratings now age too, on curves fitted from the same Cricsheet
fielding innings. From `packages/ratings` (after `fielding-stats.sql` and `fielding-ratings.py`):

    python3 -I src/analysis/fielding-progression.py   # age curves -> engine/src/fielding-progression-model.ts (~10 s)
    python3 -I src/analysis/fielding-generation.py    # distributions for generated players -> engine/src/fielding-generation-model.ts

New outputs (nothing existing is touched): `packages/engine/src/fielding-progression-model.ts`, `fielding-generation-model.ts`,
`src/__tests__/fixtures/fielding-progression-cohort.json`, and in `data/analysis/`: `fielding_player_seasons.csv` (a 0-99 fielding and keeping value per
player-season, same shrinkage and scale as the career ratings), `fielding_progression.json`, `fielding-progression-report.md` (bin tables,
slopes with standard errors, variance decomposition, held-out check), `fielding_generation.json`.

**Data.** 14,502 fielding and 1,686 keeping player-seasons of the 2,154 players for whom a birth date is known (CricketArchive, through the Cricsheet
register): regulars of the big leagues, which is the population that matters. Seasons are calendar years with 10+ fielding (8+ keeper) innings.

**Method.** The obvious delta (next season's rating minus this season's, by age) is biased here: last season's ratio is noisy, and because a player's
expected catches are his teammates' catches in the same innings, they fall when he takes more, so the ratio's mean is biased up and the naive
delta shows a decline at every age (-3 to -5 points a season at 22-26). The shrunk season ratings are also attenuated by their reliability.
Both are avoided with a player fixed-effects Poisson model, `O(i,t) ~ Poisson(E(i,t) exp(alpha_i + g(age)))`: a player's own level `alpha_i` is
profiled out (his total is the sufficient statistic, so thin and lucky seasons do no harm), `g` is the age profile, and the expected change into age `a`
is `g(a) - g(a-1)`. Catching and run-outs (fielding) and stumpings, keeper catches and byes (keeping) each get a profile, combined with the weights and
scale of the rating (14 points per SD of true skill). Bins of two years of age; standard errors by bootstrap over players (80 resamples). The profile is
then smoothed with a two-segment line (a peak age, a slope before, a slope after) fitted by precision-weighted least squares to the bins with 40+
player-seasons, the slopes are shrunk toward their prior by empirical Bayes (prior sd 1.0 point a year for fielding, 0.8 for keeping), and women's curve
is pulled toward the men's in proportion to its precision.

**Results** (rating points per season, age after the coming birthday):

| | peak age | before | after | s.e. of the slope | notes |
|---|---|---|---|---|---|
| fielding, men | 28 | +0.01 | **-1.24** | 0.20 (raw -1.29) | level at 33-34 is -8.6 points below 27-28 (s.e. 1.9), at 39+ -14 |
| fielding, women | 27 | +0.70 | -1.25 | 0.66 (raw -1.81, men's curve pulled in 58%) | about 900 player-seasons; far noisier |
| keeping, men | 28 | -0.22 | -0.59 | 4.3 (raw +0.19) | not identifiable: about 650 player-seasons, bins have s.e. 8-16 points |
| keeping, women | 25 | +0.16 | -0.50 | | 130 player-seasons |

The keeping prior is half the fielding slope (judgement: the same reflexes and legs, but the data cannot tell); with a raw slope of +0.19 +- 4.3 the data neither
confirm nor contradict it, and the unshrunk keeping curve predicts a held-out half of the keepers worse than no ageing at all (RMS error 9.4 against 8.1 points), which is
why it is shrunk. Fielding men's curve predicts the held-out half's age profile with an RMS error of 1.9 points against 4.7 for no ageing; for women (7 to 150
player-seasons per bin) 8.3 against 9.7.

**Spread.** The sd of a season's *persistent* change comes from the autocovariance of a player's season deviations from his own level (Poisson noise
removed, and the negative covariance that removing a player's mean creates subtracted): there is almost nothing left over (excess covariance one season apart
+1.7 points^2 men, +3.4 women against a luck variance of 137 and 109 points^2 per season), so real year-to-year movement beyond the age curve
is small and the data cannot separate it from luck. The sd is therefore the persistent-innovation estimate floored at 1.5 points: fielding 1.6 (men), 2.26
(women), keeping 1.5. **Reversion** to 50 is chosen from stationarity, not fitted: innovations of sd s and a spread of true skill of 14 points are only compatible if
a fraction `s^2 / (2 * 14^2)` of the distance to 50 is given back each season (0.007 men, 0.013 women): negligible, kept for correctness.

**Validation** (`fielding-progression-validation.ts`, tested in `fielding-value-progression.test.ts`): `Player.progress()` is run forward for players starting
at ages 22, 25, 28, 31 and 34 over 1, 3 and 5 seasons and the mean change compared with the real age profile (the unsmoothed bin profile, with its s.e.). All
60 cells agree within two standard errors plus 1.5 points; men's fielding five-season changes are within 1.6 points of the real ones on average (real / simulated:
28 -> 33: -7.4 / -6.0, 31 -> 36: -6.5 / -6.2, 34 -> 39: -4.3 / -6.2). The 20-season league-balance test is unchanged.

**Youth prior (judgement, added later).** The fit found no youth gain, but single-season catching is too noisy to rule one out and the game wants young fielders to
improve. `fielding-progression.py` therefore exports `max(fitted, prior)` below age 28 with prior = **+1.0 fielding points a season up to age 25** (+0.5 for
keeping), tapering linearly to 0 at 28; from 28 the fitted decline is unchanged. Women keep their fitted +0.70 to 27 where it is larger (no stacking): their curve
is +1.0 to 25, then +0.70 at 26-27. The exported nodes are every integer age 20-30 plus 45. Effect on the validation: from the peak age on (starting ages 28, 31, 34) the
five-season error is 2.0 points on average (the unsmoothed bins are noisy; the gate is 2.5); the starting ages 22 and 25 now sit deliberately above the raw bins
(tested to be within 1 point below and above them), and the 60-cell two-s.e.-plus-1.5 check still passes. **League balance:** the 20-season test now also tracks the mean
fielding rating of the pool: men 46.7 -> 48.1, women 50.3 -> 51.2 (before the prior and the training share it fell 46.7 -> 43.6 for men); regens and youth draws (50-centred
distributions) and the decline after 28 balance the prior, and the test fails if the mean moves 2 points. Reversion was left at the stationarity value.

**Training focus.** `TrainingFocus` has a `fielding` option: +3.5 fielding a season on top of the age curve (+2.0 keeping for designated keepers only), scaled by the
intensity's gain multiplier, with -0.1 on battingIQ, timing, wicketTaking and economy (the other focuses' trade-off pattern). 3.5 fielding points are worth
3.5 x 0.145 = 0.51 overall (`FIELDING_OVR_PER_POINT`), about what the batting focus gives (tested within a factor 0.6-1.6). `balanced` gives +0.1 to both. The boost lands
at the season rollover only (the mid-season tick ignores fielding and keeping) and only on players who have the rating: absent stays absent.

### Fielding and keeping for generated players

`fielding-generation.py` takes the game's rated players (`game_players.json`, joined to `fielding_ratings.csv` by the Cricinfo id inside `espn_<id>`; 20+ fielding
innings, keepers 8+ keeper innings) and records, per gender and role class, the quantiles of the fielding rating (men: batters 52 median, keepers 50, all-rounders 53,
pace and spin 45) and, for keepers, of the keeping rating (men 52 mean, n=159; women 56, n=40). Fielding follows quality a little (normal score regressed on the stratum-centred
batting overall / 20 and bowling overall / 20: +0.31 and -0.05, residual sd 0.98), keeping is independent of fielding (r = 0.02). `sampleFieldingRatings` (`player-generator.ts`) draws
from these; non-keepers get no keeping rating, as in the real data. It runs on its own stream, seeded from the generated player, so adding it did not change any other draw of a seeded
generation.

