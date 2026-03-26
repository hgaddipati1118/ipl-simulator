# Testing Strategy — IPL Simulator

Every module shipped must have corresponding unit tests. This document defines what to test for each phase.

## Test Framework

- **Runner**: Vitest (migrate from current `node --loader ts-node/esm` approach)
- **Assertion**: Vitest built-in `expect`
- **Structure**: `*.test.ts` colocated next to source files
- **Coverage target**: 90%+ for engine, 80%+ for ratings, 70%+ for app

---

## Phase 1: Data & Player System

### 1A: Player Database (`packages/ratings/src/__tests__/all-players.test.ts`)
- [ ] All 3,255 players parse without errors
- [ ] Every player has all 8 attributes (battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch)
- [ ] All attributes are in range [0, 99]
- [ ] Age is in range [16, 55]
- [ ] Country is a non-empty string
- [ ] 220 players have valid team assignments (0-9)
- [ ] No duplicate player IDs
- [ ] Name is non-empty for all players
- [ ] Team-assigned players: each team has 20-25 players

### 1B: Player Progression (`packages/engine/src/__tests__/progression.test.ts`)
- [ ] Young player (age 20) trends upward over 100 simulations (average change > 0)
- [ ] Old player (age 36) trends downward over 100 simulations (average change < 0)
- [ ] Player at peak age (28-30) has minimal average change
- [ ] No attribute goes below 0 or above 99 after progression
- [ ] Age increments by exactly 1 per progression call
- [ ] Stats reset after progression
- [ ] Progression is stochastic (two calls produce different results)
- [ ] NormSInv produces values matching expected normal distribution (KS test or similar)
- [ ] Edge case: player at 99 rating doesn't exceed 99
- [ ] Edge case: player at 1 rating doesn't go below 1

### 1C: Random Player Generation (`packages/engine/src/__tests__/create-player.test.ts`)
- [ ] Generated players have all 8 attributes in [1, 99]
- [ ] Country distribution: over 1000 players, India is most common (~33%)
- [ ] Specialist bias: batters (battingOvr > bowlingOvr + 20) have low bowling stats
- [ ] Specialist bias: bowlers (bowlingOvr > battingOvr + 20) have low batting stats
- [ ] Age distribution centered around 18 (for new players)
- [ ] All generated players have valid names (two words)
- [ ] isInternational set correctly (India = false, others = true)
- [ ] Unique IDs for all generated players

---

## Phase 2: IPL Rules Engine

### 2A: Mega Auction (`packages/engine/src/__tests__/mega-auction.test.ts`)
- [ ] All teams end with 18-25 players
- [ ] No team exceeds salary cap (₹120 Cr)
- [ ] No team has more than 8 overseas players
- [ ] Each team has at least 17 domestic players
- [ ] Base price tiers are respected (no player sold below base price)
- [ ] RTM: team can match winning bid and get player back
- [ ] RTM count doesn't exceed allowed cards per team
- [ ] Marquee players auctioned first (before general pool)
- [ ] Accelerated auction: unsold players re-enter at reduced base price
- [ ] Bidding increments follow tier rules (₹5L increment for <₹1Cr, ₹10L for ₹1-2Cr, etc.)
- [ ] CPU AI doesn't bid more than remaining purse
- [ ] CPU AI considers positional needs (doesn't buy 10 spinners)
- [ ] Retained players' costs correctly deducted from purse before auction starts

### 2B: Retention Rules (`packages/engine/src/__tests__/retention.test.ts`)
- [ ] 2025 mega auction: max 6 retentions allowed
- [ ] Retention costs match tier structure (₹18Cr, ₹14Cr, ₹11Cr for capped)
- [ ] Uncapped retention cost is ₹4Cr
- [ ] Total retention cost deducted from ₹120Cr purse
- [ ] Cannot retain more capped players than allowed
- [ ] Mini auction retention: different limits (2026, 2027)
- [ ] Released players have teamId cleared and bid reset to 0
- [ ] Retained players keep their teamId

### 2C: Impact Player (`packages/engine/src/__tests__/impact-sub.test.ts`)
- [ ] Exactly 4 candidates nominated pre-match
- [ ] Candidates come from squad members NOT in playing XI
- [ ] Only 1 substitution allowed per team per match
- [ ] Substituted player is removed from batting/bowling orders
- [ ] Impact sub is added to batting order (if hasn't batted yet) and bowling order
- [ ] Impact sub can bat AND bowl (full replacement)
- [ ] No substitution after match end
- [ ] CPU AI substitution logic: adds batter when chasing with wickets falling, adds bowler when defending
- [ ] Stats tracked correctly for both replaced player and substitute
- [ ] If no substitution made, match proceeds normally (11 players)

### 2D: Squad Composition (`packages/engine/src/__tests__/squad-rules.test.ts`)
- [ ] Playing XI: max 4 overseas players enforced
- [ ] Squad: max 8 overseas enforced
- [ ] Squad size: min 18, max 25
- [ ] Uncapped player identification: Indian + no international caps = uncapped
- [ ] Salary cap enforcement during auction (can't sign player if would exceed cap)
- [ ] Validate squad after every roster change (auction buy, retention, trade)

---

## Phase 3: Match Engine

### 3A: Free Hit & Powerplay (`packages/engine/src/__tests__/match-rules.test.ts`)
- [ ] After no-ball, next legal delivery is free hit
- [ ] On free hit: only run-out dismissal possible (no caught, bowled, LBW, stumped)
- [ ] Wide/no-ball on free hit: next ball is still free hit
- [ ] Powerplay (overs 1-6): boundary probability higher (fewer fielders outside)
- [ ] Middle overs (7-15): balanced probabilities
- [ ] Death overs (16-20): six probability highest
- [ ] Over 1000 simulated balls: distribution matches expected cricket patterns

### 3B: Super Over (`packages/engine/src/__tests__/super-over.test.ts`)
- [ ] Super over triggered when scores are tied after both innings
- [ ] Each team bats for 1 over (6 balls max)
- [ ] Team batting second knows target
- [ ] If super over ties, another super over is played (not boundary count)
- [ ] Super over repeats until there's a winner
- [ ] Super over stats tracked separately from main innings
- [ ] Player selection for super over: 3 batters + 1 bowler

### 3C: Strategic Timeout & DRS (`packages/engine/src/__tests__/timeout-drs.test.ts`)
- [ ] Strategic timeout occurs between overs 6-16
- [ ] One timeout per team per innings
- [ ] DRS: each team gets 1 review per innings
- [ ] Successful DRS review: review retained
- [ ] Failed DRS review: review lost
- [ ] Some wicket deliveries can be overturned by DRS (~10-15% chance)

---

## Phase 4: Season System

### 4A: Schedule (`packages/engine/src/__tests__/schedule.test.ts`)
- [ ] Generates exactly 70 league matches
- [ ] Each team plays exactly 14 matches
- [ ] Each team plays every other team at least once
- [ ] Official two-group matrix is respected
- [ ] No team plays itself
- [ ] Playoff bracket: correct format (Q1, Elim, Q2, Final)
- [ ] Top 4 teams qualify for playoffs
- [ ] Playoff winners advance correctly
- [ ] Total matches: 70 + 4 = 74

### 4B: Multi-Season Loop (`packages/engine/src/__tests__/season-loop.test.ts`)
- [ ] Season 1 (2025): starts with real rosters, no auction
- [ ] Season 2+: retention → auction → season flow
- [ ] Player ages increment between seasons
- [ ] Player ratings change between seasons (progression)
- [ ] Retired players (age > 42) removed from pool
- [ ] New players generated each year
- [ ] Season history accumulated correctly
- [ ] State persists to localStorage and reloads correctly
- [ ] 4-season simulation completes without errors

### 4C: SeasonRules Config (`packages/engine/src/__tests__/rules-config.test.ts`)
- [ ] 2021 config: 8 teams, 56 matches, no impact player, 1 DRS, ₹85Cr
- [ ] 2022 config: 10 teams, 70 matches, no impact player, 4 retentions max, ₹90Cr, new team draft for GT/LSG
- [ ] 2023 config: 10 teams, 70 league matches + 4 playoffs, impact player ENABLED, 2 DRS, ₹95Cr
- [ ] 2024 config: 10 teams, 70 league matches + 4 playoffs, impact player, ₹100Cr, ₹110Cr total cap
- [ ] 2025 config: 10 teams, 70 league matches + 4 playoffs, mega auction, ₹120Cr, 6 retentions, RTM, impact sub
- [ ] 2026 config: 10 teams, 70 league matches + 4 playoffs, ₹125Cr purse, 7 home matches per franchise
- [ ] 2027 config: 10 teams, 84 matches, ₹157Cr total cap
- [ ] 2028 config: mega auction, 94? matches
- [ ] All config fields have valid values
- [ ] Custom rules override defaults correctly
- [ ] Rules correctly flow into auction, retention, and match systems
- [ ] Schedule generator produces correct match count for each year's format

---

## Phase 5: Real Rosters

### 5A: IPL 2025 Rosters (`packages/ratings/src/__tests__/ipl-2025.test.ts`)
- [ ] All 10 teams have complete rosters
- [ ] Each team has 18-25 players
- [ ] No team has more than 8 overseas players
- [ ] Each team has at least 1 wicket-keeper
- [ ] Each team has at least 5 bowlers (includes all-rounders)
- [ ] Each team has at least 5 batters
- [ ] All players have valid ratings (8 attributes, 0-99)
- [ ] Player names match real IPL 2025 players
- [ ] Auction/retention prices are reasonable (not all 0 or maxed)
- [ ] Captain/key players have appropriately high ratings

### 5B: Player Pool (`packages/ratings/src/__tests__/player-pool.test.ts`)
- [ ] Master pool contains 3,255+ players
- [ ] Unassigned players (pool) available for future auctions
- [ ] Player lookup by name works (fuzzy matching for CSV→roster mapping)
- [ ] No duplicate names between team rosters and pool cause issues

---

## Phase 6: Frontend

### Frontend tests use React Testing Library + Vitest

### 6A: Auction UI (`packages/app/src/__tests__/AuctionPage.test.tsx`)
- [ ] Player card displays correct info (name, role, ratings, base price)
- [ ] Bid button increments bid correctly
- [ ] Team purse updates after each purchase
- [ ] Sold animation triggers
- [ ] Unsold display works
- [ ] User can bid for their team
- [ ] RTM button appears when applicable

### 6B: Impact Sub UI (`packages/app/src/__tests__/ImpactSub.test.tsx`)
- [ ] 4 candidates displayed before match
- [ ] User can select one candidate to substitute
- [ ] Substitution reflected in playing XI display
- [ ] Replaced player removed from lineup view
- [ ] Cannot substitute twice

### 6C: History View (`packages/app/src/__tests__/HistoryView.test.tsx`)
- [ ] Previous seasons display correctly
- [ ] Champion highlighted for each season
- [ ] Player progression chart renders
- [ ] Season stats (orange/purple cap) display

---

## Integration Tests (`packages/engine/src/__tests__/integration/`)

### Full Season Simulation
- [ ] Complete season (70 league matches + playoffs) runs without errors
- [ ] All players accumulate stats
- [ ] Standings are consistent (total wins + losses + ties = matches played)
- [ ] NRR calculation is correct
- [ ] Champion is determined
- [ ] Orange/Purple cap winners exist

### Multi-Season Simulation
- [ ] 4 consecutive seasons run without errors
- [ ] Player rosters change between seasons (retention + auction)
- [ ] Player ages and ratings evolve
- [ ] Season history grows each year
- [ ] No memory leaks or unbounded growth

### Auction → Season Flow
- [ ] Auction produces valid rosters for all teams
- [ ] All teams can field playing XIs after auction
- [ ] No team has 0 bowlers or 0 batters
- [ ] Season runs successfully with auction-produced rosters

---

## Statistical Validation Tests (`packages/engine/src/__tests__/statistical/`)

These tests run many simulations and validate distributions:

- [ ] Average first innings score: 150-180 (T20 cricket range)
- [ ] Average wickets per innings: 6-8
- [ ] Boundary percentage: 40-60% of runs
- [ ] Dot ball percentage: 30-40%
- [ ] Economy rates: 7-10 for average bowlers
- [ ] Strike rates: 120-150 for average batters
- [ ] Impact sub increases average first innings score by ~10-15 runs (known effect)
- [ ] Higher-rated teams win more often than lower-rated teams
- [ ] Home advantage is measurable but not overwhelming

---

## Test Execution Plan

```bash
# Run all tests
npm test

# Run engine tests only
npm run test --workspace=packages/engine

# Run ratings tests only
npm run test --workspace=packages/ratings

# Run app tests only
npm run test --workspace=packages/app

# Run with coverage
npm run test:coverage

# Run statistical validation (slow)
npm run test:stats
```

## CI Integration
- All tests must pass before merge
- Coverage report generated on each PR
- Statistical tests run nightly (too slow for PR checks)
