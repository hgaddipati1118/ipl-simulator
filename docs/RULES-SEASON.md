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

## 7. Player Retirement Model

### Probability per Season
```
if (age <= 35) retirementProb = 0.01;
else if (age <= 37) retirementProb = 0.05;
else if (age <= 39) retirementProb = 0.15;
else if (age <= 41) retirementProb = 0.30;
else retirementProb = 0.50;

// Adjustment for high-performers
if (overall >= 80) retirementProb *= 0.5;
// Stars play longer

// Adjustment for international players (may retire from IPL earlier)
if (isInternational) retirementProb *= 1.2;
```

### Retirement Processing
- Retired players removed from all pools (team rosters and auction pool)
- Their stats are preserved in season history
- Not available for future auctions

---

## 8. New Player Generation (Per Season)

### Each year, generate:
- **15-20 new Indian domestic players** (age 18-22, uncapped)
- **5-10 new international players** (age 20-25, from various countries)
- These enter the auction pool

### Additionally:
- Some existing players from the 3,255 master pool who weren't previously registered can "enter" the IPL system
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
