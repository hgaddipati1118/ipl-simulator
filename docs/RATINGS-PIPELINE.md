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

`python3 -I src/analysis/export-age-curves.py` writes `packages/engine/src/age-curves.ts` from the CA T20 age
curves: rating points per season by gender, for batting attributes (`bat`) and bowling attributes (`pace` /
`spin`). `Player.progress()` uses it in place of the old hand-set `(30 - age) * 0.3` trend (and extra decline
after 32); randomness, training focus and youth potential are unchanged. Women's leagues use the women's
curves (`nextSeason` passes the gender).

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
