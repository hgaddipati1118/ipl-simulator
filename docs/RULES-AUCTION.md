# IPL Auction Rules Reference

Complete specification for auction system implementation.

---

## 1. Auction Types

### Mega Auction
- Happens every **3 years** (last: 2025, next expected: 2028)
- Most players released back to pool (only retained players stay)
- Entire squads rebuilt from scratch
- Full ₹120 Cr purse minus retention costs
- RTM (Right to Match) cards available

### Mini Auction
- Happens in years between mega auctions (2026, 2027)
- Teams fill remaining squad spots (replace released/retired players)
- Smaller player pool (only released + new entrants)
- Teams keep most of their roster
- No RTM cards

---

## 2. IPL 2025 Mega Auction Rules

### Salary Purse
- **₹120 Crore** total purse per team
- Retention costs deducted before auction
- Remaining purse = ₹120 Cr - total retention cost

### Retention Rules (Pre-Auction)
Each team could retain up to **6 players** total:
- Maximum **5 capped** players
- Maximum **2 uncapped** Indian players
- Various valid combinations (5+1, 4+2, 4+1, 3+2, etc.)

### Retention Cost Structure (2025)
| Slot | Capped Player Cost | Uncapped Player Cost |
|------|-------------------|---------------------|
| 1st  | ₹18 Crore         | ₹4 Crore            |
| 2nd  | ₹14 Crore          | ₹4 Crore            |
| 3rd  | ₹11 Crore          | ₹4 Crore            |
| 4th  | ₹18 Crore          | —                    |
| 5th  | ₹14 Crore          | —                    |

*Note: Slots 4-5 cost same as 1-2 because they use RTM card pricing*

### Right to Match (RTM)
- Teams get **6 RTM cards total** (shared with retentions: retentions + RTMs ≤ 6)
- RTM can be used during auction: when a player your team previously had is being auctioned, you can match the winning bid to keep them
- RTM costs the matched bid amount (deducted from purse)
- Example: If team retained 4, they have 2 RTM cards remaining

---

## 3. Base Price Tiers

Players register at a base price tier:

| Base Price | Typical Players |
|-----------|----------------|
| ₹2 Crore  | Proven international stars, experienced IPL performers |
| ₹1.5 Crore | Established international players |
| ₹1 Crore  | Good international/domestic players |
| ₹75 Lakhs | Experienced domestic or fringe international |
| ₹50 Lakhs | Promising domestic, young international |
| ₹40 Lakhs | Young domestic talent |
| ₹30 Lakhs | Uncapped domestic, associate nations |
| ₹20 Lakhs | Uncapped, unproven |

### Base Price Assignment Logic
```
if (overall >= 85) basePriceTier = 2.0;
else if (overall >= 78) basePriceTier = 1.5;
else if (overall >= 70) basePriceTier = 1.0;
else if (overall >= 62) basePriceTier = 0.75;
else if (overall >= 55) basePriceTier = 0.5;
else if (overall >= 48) basePriceTier = 0.4;
else if (overall >= 40) basePriceTier = 0.3;
else basePriceTier = 0.2;
```

---

## 4. Auction Order

### Marquee Players (auctioned first)
1. **Set 1**: Capped Indian batters/all-rounders (highest profile)
2. **Set 2**: Capped overseas batters/all-rounders
3. **Set 3**: Capped Indian bowlers/wicket-keepers
4. **Set 4**: Capped overseas bowlers/wicket-keepers

### General Pool (after marquee)
5. **Set 5+**: Remaining capped players by base price (highest first)
6. **Uncapped Indian players** by base price
7. **Uncapped overseas players** by base price

### Accelerated Auction
- After initial rounds, unsold players re-enter at **reduced base price**
- Typically base price drops by one tier
- Example: ₹1 Cr player unsold → re-enters at ₹75L
- Can repeat multiple times
- Final round: all remaining at ₹20L base

---

## 5. Bidding Mechanics

### Increment Rules
| Current Bid Range | Minimum Increment |
|-------------------|-------------------|
| ₹20L - ₹1 Cr     | ₹5 Lakhs          |
| ₹1 Cr - ₹2 Cr    | ₹10 Lakhs         |
| ₹2 Cr - ₹5 Cr    | ₹20 Lakhs         |
| ₹5 Cr - ₹10 Cr   | ₹25 Lakhs         |
| ₹10 Cr+           | ₹25 Lakhs         |

### Bidding Process
1. Auctioneer announces player (name, role, country, base price)
2. Teams raise paddles to bid
3. Bidding continues until no more bids
4. "Going once... going twice... SOLD to {team} for ₹X"
5. If no team bids at base price: "UNSOLD"

### CPU Bidding AI Factors
```typescript
interface BidDecision {
  shouldBid: boolean;
  maxBid: number;
}

function decideBid(team, player, currentBid): BidDecision {
  // Factor 1: Player value vs current bid
  const valueRatio = currentBid / player.marketValue;

  // Factor 2: Team needs
  const needsFactor = calculatePositionalNeed(team, player.role);

  // Factor 3: Budget remaining
  const budgetFactor = team.remainingBudget / team.salaryCap;

  // Factor 4: Roster spots remaining
  const spotsFactor = (25 - team.roster.length) / 25;

  // Factor 5: International slot availability
  const intlFactor = player.isInternational
    ? (8 - team.internationalCount) / 8
    : 1;

  // Factor 6: Age preference (prefer 22-30)
  const ageFactor = player.age < 22 ? 0.9 : player.age > 32 ? 0.7 : 1.0;

  // Factor 7: Competition (other teams also need this type)
  const competitionFactor = calculateCompetition(teams, player.role);

  const probability = baseProb * needsFactor * budgetFactor * spotsFactor * intlFactor * ageFactor;
  const maxBid = player.marketValue * 1.5 * needsFactor;

  return {
    shouldBid: Math.random() < probability && currentBid < maxBid,
    maxBid
  };
}
```

---

## 6. Team Composition Targets

CPU teams should aim for this approximate composition:

| Role | Target Count | Min | Max |
|------|-------------|-----|-----|
| Batters (pure) | 5-6 | 4 | 7 |
| Bowlers (pure) | 5-6 | 4 | 7 |
| All-rounders | 3-4 | 2 | 6 |
| Wicket-keepers | 2-3 | 1 | 3 |
| **Total** | **18-25** | **18** | **25** |
| Overseas | 6-8 | 4 | 8 |
| Indian | 15-19 | 17 | 21 |

### Positional Need Calculation
```
needScore = (targetCount - currentCount) / targetCount
```
Higher need = more aggressive bidding for that role.

---

## 7. Mini Auction Rules (2026, 2027)

### Key Differences from Mega Auction
- No RTM cards
- Smaller player pool (only released players + new entrants)
- Teams retain most of their squad (release 3-5 players typically)
- No marquee player sets (all players auctioned by base price tier)
- Same bidding mechanics and increments
- Same salary cap rules
- Retention limit: typically 4-5 players can be retained at reduced cost

### Retention for Mini Auction
- Teams can retain all players from previous season by default
- Must release enough players to free up purse for new signings
- No tiered retention costs (players keep their existing contract values)
- Can "release" players to create purse space

---

## 8. Auction Data Model

```typescript
interface AuctionConfig {
  type: "mega" | "mini";
  salaryCap: number;           // 120 (crores)
  maxRosterSize: number;       // 25
  minRosterSize: number;       // 18
  maxInternational: number;    // 8
  maxRetentions: number;       // 6 for mega, varies for mini
  rtmCards: number;            // 6 for mega, 0 for mini
  retentionCosts: {
    capped: number[];          // [18, 14, 11, 18, 14] for 2025
    uncapped: number[];        // [4, 4]
  };
  basePriceTiers: number[];    // [2.0, 1.5, 1.0, 0.75, 0.5, 0.4, 0.3, 0.2]
  bidIncrements: { upTo: number; increment: number }[];
}

interface AuctionState {
  currentPlayer: Player | null;
  currentBid: number;
  currentBidder: Team | null;
  round: number;
  phase: "marquee" | "general" | "accelerated";
  soldPlayers: { player: Player; team: Team; amount: number }[];
  unsoldPlayers: Player[];
  remainingPool: Player[];
}
```

---

## Unit Tests Required

See TESTING-STRATEGY.md Phase 2A and 2B for complete test specifications.

### Key Invariants to Test
1. No team exceeds salary cap after auction
2. All teams have 18-25 players after auction
3. No team has >8 overseas players
4. Every player sold for >= base price
5. RTM count never exceeds allocated cards
6. Retained players correctly excluded from auction pool
7. Accelerated rounds correctly reduce base prices
8. CPU AI doesn't make illegal bids (over budget, over roster limit)
