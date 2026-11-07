# IPL Season Format & Rules Reference

---

## 1. League Stage

### IPL 2025 Format
- **10 teams**
- **70 league matches** (each team plays 14)
- Each team plays every other team **at least once**
- Each team plays **5 opponents twice** and **4 opponents once**
- Each team has **7 home + 7 away matches**

### Schedule Generation Logic
With 10 teams, IPL uses **two virtual groups of five**. Each team plays:
- The other four teams in its own group **twice**
- The same-row team in the other group **twice**
- The remaining four teams in the other group **once**

```
League matches: 10 teams × 14 matches / 2 = 70

Each team plays: 14 matches
  = 8 matches inside its virtual group
  + 2 matches against its same-row opponent in the other group
  + 4 one-off matches against the remaining other-group teams
```

### Home/Away Balance
- Each team should have ~7 home and ~7 away matches
- Not perfectly balanced due to odd number (14)
- Some teams may play 8 home + 6 away or vice versa

---

## 2. Points System

| Result | Points |
|--------|--------|
| Win | 2 |
| Loss | 0 |
| Tie (before super over) | N/A (super over resolves it) |
| No Result (rain) | 1 each |
| Abandoned | 1 each |

### Tiebreaker Order (for standings)
1. **Points** (higher is better)
2. **Net Run Rate (NRR)** (higher is better)
3. **Higher wickets taken per fair balls bowled**
4. If still tied: **drawing of lots**

---

## 3. Net Run Rate (NRR) Calculation

```
NRR = (Runs scored / Overs faced) - (Runs conceded / Overs bowled)
```

### Important Rules
- **If a team is bowled out**: overs faced = 20.0 (full allocation used for calculation)
- **If a team chases successfully**: actual overs count (e.g., 18.2 overs = 18.333)
- **Overs notation**: 18.2 means 18 overs + 2 balls = 18 + 2/6 = 18.333 overs

### Implementation
```typescript
function calculateNRR(team: Team): number {
  // Convert balls to overs (balls / 6)
  const oversFor = team.ballsFacedFor / 6;
  const oversAgainst = team.ballsFacedAgainst / 6;

  if (oversFor === 0 || oversAgainst === 0) return 0;

  const runRateFor = team.runsFor / oversFor;
  const runRateAgainst = team.runsAgainst / oversAgainst;

  return runRateFor - runRateAgainst;
}
```

### NRR Edge Case: Bowled Out
When a team is bowled out (10 wickets), the denominator uses 20 overs (120 balls) regardless of actual overs played. This is critical for accurate NRR calculation.

```typescript
// In match result processing:
if (innings.wickets >= 10) {
  team.ballsFacedFor += 120; // Use full 20 overs
} else {
  team.ballsFacedFor += innings.totalBalls; // Use actual balls
}
```

---

## 4. Playoff Format

### Qualification
- **Top 4 teams** in standings qualify for playoffs

### Bracket
```
Qualifier 1:  1st vs 2nd  → Winner goes to FINAL
                           → Loser goes to Qualifier 2

Eliminator:   3rd vs 4th  → Winner goes to Qualifier 2
                           → Loser eliminated

Qualifier 2:  Loser Q1 vs Winner Elim → Winner goes to FINAL
                                       → Loser eliminated

FINAL:        Winner Q1 vs Winner Q2 → CHAMPION
```

### Advantages
- **1st and 2nd place** get two chances to reach the final
- **3rd and 4th place** must win all remaining games
- No home advantage in playoffs (neutral venue)

### Implementation Note
Current engine should keep playoff matches neutral and should not let playoff wins/losses mutate the league table.

---

## 5. Season Awards

### Orange Cap (Most Runs)
- Awarded to the **highest run scorer** in the season
- Includes group stage + playoff matches
- Display: player name, team, runs, innings, average, strike rate

### Purple Cap (Most Wickets)
- Awarded to the **highest wicket-taker** in the season
- Includes group stage + playoff matches
- Display: player name, team, wickets, overs, economy, average

### Most Valuable Player (MVP)
- Based on a composite score:
```
mvpScore = (runs * 1.0) + (wickets * 20) + (catches * 10)
         + (SR_bonus if SR > 150) + (econ_bonus if econ < 7.5)
         + (fifties * 10) + (hundreds * 25)
```

### Emerging Player Award
- Best performer under age 23
- Same MVP formula but restricted to young players

---

## 6. Multi-Season Flow

### Year 1: IPL 2025
```
Start with real IPL 2025 rosters (pre-loaded)
→ Skip auction (teams already formed from real mega auction)
→ Play 70 league matches + playoffs
→ Awards & history recording
→ End of season
```

### Year 2: IPL 2026 (Mini Auction Year)
```
Player progression (age + rating changes)
→ Retirements (probabilistic for age > 38)
→ Release window (teams drop 3-5 players)
→ New young players enter pool
→ Mini auction (released + new players)
→ Play 70 league matches + playoffs
→ Awards & history recording
→ End of season
```

### Year 3: IPL 2027 (Mini Auction Year)
```
Same as Year 2
```

### Year 4: IPL 2028 (Mega Auction Year)
```
Player progression
→ Retirements
→ Retention window (teams keep up to 6 players)
→ All other players released to mega pool
→ New players enter pool
→ Mega auction (massive pool, fresh squads)
→ Play season
→ Awards
→ End (or loop to Year 5)
```

---

## 7. Player Progression and Retirement Model

### Progression (every off-season, `Player.progress()`)
Each player ages one year and each discipline's overall (batting, bowling) moves by an expected change plus luck, both
fitted on real careers (CricketArchive per-year T20 ratings, men and women; see `docs/RATINGS-PIPELINE.md`, "Progression
model"):

```
change = mean(age, level, last season's change, seasons of evidence, kind) + sd(age, seasons of evidence) * z
```
- **Regression to the mean**: players well above ~65 tend to slip (about -0.07 points a season per point above 65),
  weak ones climb; a jump is partly given back the next year.
- **Age**: young players rise, prime years are flat, decline is gentle until the mid-30s (retirement does most of the
  work). New players (little data behind their rating) swing by 3.9 points a season, veterans by 2.5.
- **Luck** (`z`) is drawn from the real, fat-tailed distribution of season-to-season changes: breakouts of +8 or more happen
  to 2.5% of regulars in a season, collapses of -8 to 0.7%.
- **Potential** (youth, regens): a drawn talent (sd 3.5 points) realised evenly up to age 27 on top of the typical path.
- Training focus and intensity still add their bias and volatility; women's leagues use the women's fit.
  The **Fielding** focus adds about +3.5 fielding (+2.0 keeping for a designated keeper) a season at a small cost in batting and bowling growth; Balanced gives a +0.1 share. Players without the ratings are unaffected.
- The change is spread over the discipline's attributes so the discipline overall moves by the drawn amount, with a little
  individual noise per attribute. Each player's `ratingHistory` keeps one entry per season (overall, batting, bowling, age;
  25 seasons) for the "ratings over time" chart.
- All draws come from an RNG derived from `GameState.worldSeed` and the season number, so a seed reproduces a career.
- **Fielding and keeping** (when a player has the ratings; absent stays absent) age on their own fitted curves (`fielding-progression.ts`,
  parameters in the generated `fielding-progression-model.ts`; method and numbers in `docs/RATINGS-PIPELINE.md`, "Fielding and keeping
  progression"): `change = ageEffect(age) - reversion * (rating - 50) + sd * z`, z standard normal, two draws per rating, taken after the
  eight core draws. Fielding rises about 1.0 a season to 25 (judgement prior, tapering to 0 at 28; keeping +0.5), is flat at 28 and then falls 1.2 points a season (men; women the same after shrinkage), so a 33-year-old
  loses about 6 points over five seasons; the sd of a season's change is about 1.6 (2.3 women); keeping is too noisy to read off its own data
  and falls at half the fielding rate (0.6 a season after 28), sd 1.5. Training intensity scales the sd.

### Retirement probability per season
Fitted hazard of a real regular never playing T20 again, by the age during the season just played (halved below 30, where
the real hazard also counts losing a place, which the auction models here), the player's overall, role and gender:

```
logit(p) = ageEffect(age) + level * (overall - 65) / 10 + role + (female ? women : 0)
```
At 65 overall a batter retires with about 4% (under 23), 6.5% (29-31), 14% (34-35), 26% (38-39), 31% (42+); a 45-overall
player roughly three times as often, an 85 about a third as often; all-rounders are retained longer. Median last regular season by
role in real data and in the simulation: batters 33, pace bowlers 31, spinners 32-33, all-rounders 35.

### Retirement processing
- Retired players are removed from all pools (team rosters and auction pool); the user's players never auto-retire.
- Their stats are preserved in season history; notable CPU retirees go to the Hall of Fame.
- Not available for future auctions.

---

## 8. New Player Generation (Per Season)

Generated players are sampled from the real joint distribution of the game's ratings (`docs/RATINGS-PIPELINE.md`,
"Generated players"), seeded from the world seed and season:

- **A regen for every retiree** (pool and CPU rosters): same role class (batter, keeper, all-rounder, pace, spin), nationality
  and gender, aged 18-23, with a potential. Pool size stays level.
- **15 fill-in squad players** (age 22-34, any nationality by the usual T20 mix).
- **2-4 youth academy prospects** (Indian, aged 17-20) with a potential and a scouting grade (Diamond 78+, Gold 71+,
  Silver 64+, Bronze); they enter the auction pool.
- Every generated player gets a **fielding** rating, keepers also a **keeping** rating (`sampleFieldingRatings`, drawn from the
  real distribution of the role class and gender, with good batters and bowlers fielding a little better; generated keepers average
  52 men / 56 women keeping, other players have none). The draw uses a stream of its own seeded from the player, so it does not
  change any other draw of a seeded generation.
- Names are drawn from real first and last names of the player's region and gender, mixed so that no generated player shares
  a real person's full name.

A 20-season simulation of this loop keeps the league's average overall, its top-150 average and its spread level (see the
tests in `packages/engine/src/__tests__/progression.test.ts`).

### Additionally:
- Some existing players from the master pool who weren't previously registered can "enter" the IPL system
- This simulates real-world scenarios where new talents emerge

---

## 9. Season Configuration Type

```typescript
interface SeasonConfig {
  year: number;                    // 2025, 2026, etc.
  auctionType: "mega" | "mini" | "none"; // "none" for year 1
  salaryCap: number;               // 120 Cr
  retentionRules: RetentionRules;
  matchRules: MatchRules;
  scheduleConfig: {
    leagueMatches: number;         // 74
    teamsCount: number;            // 10
    matchesPerTeam: number;        // 14
    playoffFormat: "top4";         // Standard IPL format
  };
  impactPlayerEnabled: boolean;    // true for 2025
  // Future expansions
  newPlayersPerSeason: { domestic: number; international: number };
}

const SEASON_CONFIGS: Record<number, SeasonConfig> = {
  2025: {
    year: 2025,
    auctionType: "none", // First season uses pre-loaded rosters
    salaryCap: 120,
    retentionRules: MEGA_RETENTION_2025,
    matchRules: MATCH_RULES_2025,
    scheduleConfig: { leagueMatches: 74, teamsCount: 10, matchesPerTeam: 14, playoffFormat: "top4" },
    impactPlayerEnabled: true,
    newPlayersPerSeason: { domestic: 0, international: 0 }, // Already loaded
  },
  2026: {
    year: 2026,
    auctionType: "mini",
    salaryCap: 120,
    retentionRules: MINI_RETENTION_2026,
    matchRules: MATCH_RULES_2025, // Same match rules
    scheduleConfig: { leagueMatches: 74, teamsCount: 10, matchesPerTeam: 14, playoffFormat: "top4" },
    impactPlayerEnabled: true, // Likely continues
    newPlayersPerSeason: { domestic: 18, international: 8 },
  },
  // ...2027, 2028
};
```

---

## Unit Tests Required

See TESTING-STRATEGY.md Phase 4A, 4B, 4C for complete test specifications.
