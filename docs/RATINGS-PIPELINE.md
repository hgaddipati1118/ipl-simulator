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
- The pool is unchanged: CA-only players with no ESPN profile don't meet the pool's rules.

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
