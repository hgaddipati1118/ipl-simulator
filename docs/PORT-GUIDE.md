# Code Porting Guide

Maps source code from both original repos to the new ipl-simulator TypeScript monorepo.

---

## 1. Player System Port

### Source: `IndianCricketLeague/PlayerClass.js` → Target: `packages/engine/src/player.ts`

| Original (JS) | Current (TS) | Status | Action Needed |
|---------------|-------------|--------|---------------|
| `CricketPlayer` class | `Player` class | PORTED | Mostly complete |
| `calcOveralls()` | `get battingOvr()`, `get bowlingOvr()`, `get overall()` | PORTED | Formulas match |
| `calcValue()` | `get marketValue()` | PORTED | Formula matches |
| `prog()` | `progress()` | PARTIAL | Need NormSInv, age curves, per-attribute tracking |
| `traitProg()` | — | MISSING | Port: normal dist sampling with age adjuster |
| `traitProgText()` | — | MISSING | Port: "+X"/"-X" display text for progression |
| `fakeProg()` | — | NOT NEEDED | Was for display only |
| `remakePlayer()` | `static fromJSON()` | PORTED | Different approach, works |
| `this.stats[]` | `this.stats.matchLog[]` | PORTED | Enhanced version |
| `this.injury` | `this.injured` | PORTED | ✓ |
| `this.refused` | — | MISSING | Port: player refusing to play for team |

### Key Progression Port Details

**Original `prog()` method (PlayerClass.js:102-143)**:
```javascript
let progDev = Math.pow(Math.pow(30 - age, 2), 0.7);
let overallAdjuster = (age < 26) ? ((100 - this.overall) / 50) : 1;
let ageAdjuster = ((Math.pow(30, 0.35) - Math.pow(age, 0.35)) / Math.pow(18, 0.35)) * overallAdjuster;
// For each attribute:
boost = (NormSInv(normalDist()) + ageAdjuster) * progDev;
```

**Current `progress()` method (player.ts:166-182)**:
```typescript
const ageBias = (30 - this.age) * 0.3;
const deviation = Math.pow(Math.abs(30 - this.age), 0.7);
const change = randomNormal(ageBias, deviation);
```

**Differences**:
- Original uses NormSInv (inverse normal CDF) for more accurate normal distribution
- Original has `overallAdjuster` for young players below ceiling (accelerates growth)
- Original has more nuanced age curve (power function vs linear)
- Current version is simpler but less realistic

**Action**: Port the original formula exactly. Need to implement `NormSInv()` and `normalDist()` utility functions.

### Unit Tests for Progression
- See TESTING-STRATEGY.md Phase 1B

---

## 2. Player Data Port

### Source: `Determine-Cricket-Player-Ratings/2022PlayerRatingsWithTeams.csv`
### Target: `packages/ratings/src/all-players.ts`

**CSV Schema**:
```
IPL Team, IPL Bid, First Name, Surname, country, age, OVR, Bat OVR, IQ, Technique, Power, Running, Bowl OVR, WicketTaking, Econ, Accuracy, Cltch
```

**Mapping to PlayerData**:
```typescript
{
  id: `csv_${rowIndex}`,
  name: `${firstName} ${surname}`,
  age: csvAge,                    // Column 5
  country: csvCountry,            // Column 4
  role: inferRole(batOvr, bowlOvr), // Derived
  ratings: {
    battingIQ: csvIQ,             // Column 8
    timing: csvTechnique,         // Column 9 ("Technique" = timing)
    power: csvPower,              // Column 10
    running: csvRunning,          // Column 11
    wicketTaking: csvWicketTaking, // Column 13
    economy: csvEcon,             // Column 14
    accuracy: csvAccuracy,        // Column 15
    clutch: csvCltch,             // Column 16
  },
  isInternational: csvCountry !== "India",
  teamId: mapTeamId(csvTeamId),   // 0-9 → srh,dc,rcb,etc.
  bid: csvBid || 0.2,
}
```

**Team ID Mapping**:
```typescript
const TEAM_ID_MAP: Record<string, string> = {
  "0": "srh",   // Sunrisers Hyderabad (Team 0 in CSV)
  "1": "dc",    // Delhi Capitals
  "2": "rcb",   // Royal Challengers Bengaluru
  "3": "kkr",   // Kolkata Knight Riders
  "4": "rr",    // Rajasthan Royals
  "5": "csk",   // Chennai Super Kings
  "6": "mi",    // Mumbai Indians
  "7": "pbks",  // Punjab Kings
  "8": "gt",    // Gujarat Titans
  "9": "lsg",   // Lucknow Super Giants
};
```

*Note: This mapping needs verification against actual 2022 IPL team IDs used in the CSV.*

**Role Inference**:
```typescript
function inferRole(batOvr: number, bowlOvr: number): PlayerRole {
  const gap = Math.abs(batOvr - bowlOvr);
  if (gap <= 15) return "all-rounder";
  return batOvr > bowlOvr ? "batsman" : "bowler";
  // WK detection: need additional data or heuristic
}
```

### Unit Tests for Data Port
- See TESTING-STRATEGY.md Phase 1A

---

## 3. Player Generation Port

### Source: `IndianCricketLeague/createPlayer.js` → Target: `packages/engine/src/create-player.ts`

| Original Function | Target | Status |
|-------------------|--------|--------|
| `createPlayerNew()` | `generatePlayerPool()` | PARTIAL |
| `createPlayer()` | — | Not needed (old version) |
| `importPlayer()` | `createPlayerFromData()` | PORTED |
| `importPlayerWithTeam()` | `createPlayerFromData()` | PORTED |
| `determineCountryNew()` | — | MISSING |
| `randIntN()` | `randomNormal()` | PORTED (different API) |

### Key Port: Country-Weighted Distribution

**Original** (createPlayer.js:5-6):
```javascript
let countryOddsNew = [0.0266, 0.0270, 0.0835, 0.3359, 0.4853, ...]
let countryNamesNew = ['West Indies', 'Singapore', 'Pakistan', 'India', 'Sri Lanka', ...]
```

This gives India ~25% probability, then Sri Lanka, England, etc. Need to port the exact probability weights.

### Key Port: Specialist Bias

**Original** (createPlayer.js:53-64):
```javascript
if (battingOverall > bowlingOverall && Math.random() > 0.3) {
    economy = randIntN(15, 15, 99, 1);     // Tank bowling stats
    wicketTaking = randIntN(economy, 15, 99, 1);
    clutch = randIntN(wicketTaking, 15, 99, 1);
    accuracy = randIntN(clutch, 15, 99, 1);
}
// Mirror for bowling > batting
```

70% chance that a player with higher batting becomes a pure batter (bowling stats tanked).

### Unit Tests for Generation
- See TESTING-STRATEGY.md Phase 1C

---

## 4. Auction Port

### Source: `IndianCricketLeague/AuctionClass.js` → Target: `packages/engine/src/auction.ts`

The current auction.ts is a basic port. Major enhancements needed:

| Feature | Original | Current | Action |
|---------|----------|---------|--------|
| Basic bidding | ✓ | ✓ | Working |
| CPU AI | Simple | Simple | Enhance with positional needs |
| Base price tiers | ✗ | ✗ | NEW: Add tier system |
| Marquee sets | ✗ | ✗ | NEW: Auction order |
| RTM | ✗ | ✗ | NEW: Right to match |
| Accelerated rounds | ✗ | ✗ | NEW: Unsold re-entry |
| Budget reservation | ✗ | ✗ | NEW: Reserve for min roster |
| Mega vs Mini | ✗ | ✗ | NEW: Two auction modes |

### Unit Tests for Auction
- See TESTING-STRATEGY.md Phase 2A

---

## 5. Match Engine Comparison

### Source: `IndianCricketLeague/GameClass.js` → Target: `packages/engine/src/match.ts`

The match engine is the most complete port. Key enhancements needed:

| Feature | Original | Current | Action |
|---------|----------|---------|--------|
| Ball-by-ball sim | ✓ | ✓ | Working |
| Phase multipliers | ✗ | ✓ | ENHANCED (better than original) |
| Chase context | ✗ | ✓ | ENHANCED |
| Clutch factor | ✗ | ✓ | ENHANCED |
| Stadium rating | ✗ | ✓ | ENHANCED |
| Commentary | ✗ | ✓ | ENHANCED |
| Super over | ✗ | ✓ (buggy) | FIX: repeat instead of boundary count |
| Free hit | ✗ | ✗ | NEW |
| Impact sub | ✗ | ✗ | NEW |
| DRS | ✗ | ✗ | NEW (low priority) |
| Strategic timeout | ✗ | ✗ | NEW (low priority) |
| Player stats tracking | Basic | ✓ | ENHANCED |
| Injury system | ✗ | ✓ | ENHANCED |

The current match engine is already significantly better than the original. The main gaps are gameplay rules (free hit, impact sub).

---

## 6. Files to Create (New)

| File | Purpose |
|------|---------|
| `packages/engine/src/rules.ts` | SeasonRules configuration type + presets for 2025-2028 |
| `packages/engine/src/impact-sub.ts` | Impact player nomination, substitution logic, AI |
| `packages/engine/src/retention.ts` | Authentic retention system with mega/mini variants |
| `packages/engine/src/mega-auction.ts` | Full mega auction (base tiers, marquee, RTM, accelerated) |
| `packages/engine/src/mini-auction.ts` | Mini auction variant |
| `packages/engine/src/validation.ts` | Squad and XI validation functions |
| `packages/ratings/src/all-players.ts` | Full 3,255 player database |
| `packages/ratings/src/ipl-2025-rosters.ts` | Real 2025 team squads |
| `packages/app/src/pages/AuctionPage.tsx` | Auction UI |
| `packages/app/src/pages/RetentionPage.tsx` | Retention selection UI |

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `packages/engine/src/player.ts` | Add `isCapped`, port NormSInv progression |
| `packages/engine/src/team.ts` | Add squad validation, budget tracking |
| `packages/engine/src/match.ts` | Add free hit state, impact sub support |
| `packages/engine/src/schedule.ts` | Fix to 74 matches, neutral playoff venues |
| `packages/engine/src/auction.ts` | Refactor to support mega/mini via rules config |
| `packages/engine/src/math.ts` | Add NormSInv, normalDist functions |
| `packages/app/src/game-state.ts` | Multi-season state, retention/auction flow |
| `packages/app/src/App.tsx` | New routes for auction, retention pages |
