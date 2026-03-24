# IPL Retention Rules Reference

---

## 1. Mega Auction Retention (2025)

### Overview
Before the IPL 2025 mega auction, each team was allowed to retain up to **6 players** from their previous squad.

### Retention Slots & Costs

| Slot | Capped Player | Uncapped Indian |
|------|--------------|-----------------|
| 1st  | ₹18 Crore    | ₹4 Crore        |
| 2nd  | ₹14 Crore    | ₹4 Crore        |
| 3rd  | ₹11 Crore    | —                |
| 4th  | ₹18 Crore    | —                |
| 5th  | ₹14 Crore    | —                |

### Valid Retention Combinations
- 5 capped + 1 uncapped = 6 retentions (cost: ₹18+14+11+18+14+4 = ₹79 Cr)
- 5 capped + 0 uncapped = 5 retentions (cost: ₹75 Cr)
- 4 capped + 2 uncapped = 6 retentions (cost: ₹18+14+11+18+4+4 = ₹69 Cr)
- 4 capped + 1 uncapped = 5 retentions
- 3 capped + 2 uncapped = 5 retentions
- etc.

### RTM (Right to Match) Interaction
- Total of retentions + RTM cards = 6 maximum
- If team retains 4, they get 2 RTM cards
- If team retains 6, they get 0 RTM cards
- RTM can be used during auction to match the winning bid for a former player

### Purse Deduction
```
remainingPurse = 120 - sum(retentionCosts)
```
Example: Team retains 3 capped + 1 uncapped:
- Cost: 18 + 14 + 11 + 4 = ₹47 Cr
- Remaining purse: ₹73 Cr
- RTM cards: 2

---

## 2. Mini Auction Retention (2026, 2027)

### Overview
In mini auction years, teams keep most of their squad and only release a few players.

### Key Differences
- **No tiered retention costs** — players keep their existing contract values
- **No RTM cards** — only available in mega auctions
- Teams can release players to free up purse space
- Released players enter the mini auction pool

### Retention Rules (Projected)
| Constraint | Value |
|-----------|-------|
| Default retention | All current squad members |
| Max releases | No limit (but must keep min 18) |
| Cost of retention | Player's existing contract value |
| Purse for mini auction | ₹120 Cr - sum of retained contract values |

### Release Strategy
```
releasePriority = (salary / marketValue) * agePenalty
// Release players who are overpaid relative to current form
// Older players with declining ratings become release candidates
```

---

## 3. Between-Season Retention Flow

### For Mega Auction Year (2025, 2028)
```
1. Team has 18-25 players from previous season
2. Retention window opens:
   - CPU: Auto-select best players within rules
   - User: Manual selection with cost display
3. Retained players stay, all others released
4. Released players enter mega auction pool
5. New young players + international registrations added to pool
6. Purse calculated: 120 - retention costs
7. Mega auction runs
8. Post-auction roster finalization
```

### For Mini Auction Year (2026, 2027)
```
1. Team has 18-25 players from previous season
2. Release window opens:
   - CPU: Release underperformers and overpaid players
   - User: Manual release selection
3. Released players enter mini auction pool
4. New players added to pool
5. Available purse: 120 - sum of retained contracts
6. Mini auction runs (smaller pool, fewer rounds)
7. Post-auction roster finalization
```

---

## 4. CPU Retention Logic

### Mega Auction CPU Strategy
```typescript
function cpuRetentionMega(team: Team, rules: RetentionRules): Player[] {
  // Sort by "retention value" = overall × ageFactor × performanceFactor
  const candidates = [...team.roster].sort((a, b) => {
    const scoreA = retentionScore(a);
    const scoreB = retentionScore(b);
    return scoreB - scoreA;
  });

  const retained: Player[] = [];
  let cappedCount = 0;
  let uncappedCount = 0;
  let totalCost = 0;

  for (const player of candidates) {
    if (retained.length >= rules.maxRetentions) break;

    const isCapped = player.isCapped || player.isInternational;
    const isUncapped = !player.isInternational && !player.isCapped;

    if (isCapped && cappedCount >= rules.maxCapped) continue;
    if (isUncapped && uncappedCount >= rules.maxUncapped) continue;

    const cost = isCapped
      ? rules.cappedCosts[cappedCount]
      : rules.uncappedCosts[uncappedCount];

    if (totalCost + cost > rules.maxRetentionBudget) continue;

    retained.push(player);
    totalCost += cost;
    if (isCapped) cappedCount++;
    else uncappedCount++;
  }

  return retained;
}

function retentionScore(player: Player): number {
  const ageBonus = player.age <= 28 ? 1.2 : player.age <= 32 ? 1.0 : 0.7;
  const performanceBonus = (player.stats.runs / 100) + (player.stats.wickets * 3);
  return player.overall * ageBonus + performanceBonus;
}
```

### Mini Auction CPU Strategy
```typescript
function cpuReleaseMini(team: Team, targetPurse: number): Player[] {
  // Sort by "release priority" = salary / value ratio (highest = most overpaid)
  const releaseCandidates = [...team.roster].sort((a, b) => {
    const ratioA = a.bid / Math.max(a.marketValue, 0.2);
    const ratioB = b.bid / Math.max(b.marketValue, 0.2);
    return ratioB - ratioA; // Most overpaid first
  });

  const released: Player[] = [];
  let freedPurse = 0;

  for (const player of releaseCandidates) {
    if (team.roster.length - released.length <= 18) break; // Keep minimum squad
    if (freedPurse >= targetPurse) break;

    // Never release franchise players (top 3 by overall)
    const topPlayers = [...team.roster]
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 3);
    if (topPlayers.includes(player)) continue;

    released.push(player);
    freedPurse += player.bid;
  }

  return released;
}
```

---

## 5. Data Model

```typescript
interface RetentionRules {
  type: "mega" | "mini";
  maxRetentions: number;       // 6 for mega
  maxCapped: number;           // 5 for mega
  maxUncapped: number;         // 2 for mega
  cappedCosts: number[];       // [18, 14, 11, 18, 14] for 2025
  uncappedCosts: number[];     // [4, 4] for 2025
  maxRetentionBudget: number;  // Typically no hard limit (just purse reduction)
  rtmCards: number;            // 6 - retentions for mega, 0 for mini
}

interface RetentionResult {
  retained: { player: Player; cost: number; slot: number }[];
  released: Player[];
  totalRetentionCost: number;
  remainingPurse: number;
  rtmCardsAvailable: number;
}
```

---

## 6. Season-by-Season Retention Rules

| Parameter | 2025 (Mega) | 2026 (Mini) | 2027 (Mini) | 2028 (Mega) |
|-----------|-------------|-------------|-------------|-------------|
| Max Retentions | 6 | All squad | All squad | 6 |
| Max Capped | 5 | N/A | N/A | 5 |
| Max Uncapped | 2 | N/A | N/A | 2 |
| Capped Costs | 18,14,11,18,14 | Existing contract | Existing contract | TBD |
| Uncapped Costs | 4,4 | Existing contract | Existing contract | TBD |
| RTM Cards | 6 total | 0 | 0 | 6 total |
| Purse | ₹120 Cr | ₹120 Cr | ₹120 Cr+ | TBD |

---

## Unit Tests Required

See TESTING-STRATEGY.md Phase 2B for complete test specifications.

### Key Invariants
1. Retained count never exceeds maxRetentions
2. Capped retained count never exceeds maxCapped
3. Uncapped retained count never exceeds maxUncapped
4. Total retention cost matches sum of tier costs
5. Remaining purse = salaryCap - retentionCost
6. RTM cards = maxRetentions - retainedCount (for mega)
7. Released players have teamId cleared
8. All retained players still on team roster
