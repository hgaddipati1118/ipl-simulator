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

**As implemented** (`packages/engine/src/auction.ts`): each CPU team's bid probability is `(1 - currentBid / value)` scaled by the
age, domestic, roster-size, over-bidding and budget-reserve factors above, where `value = max(marketValue, basePrice)`. `marketValue`
(`player.ts`, `calculateMarketValue`) is built from the overall **plus what fielding and keeping are worth** (section 9). Squad need for
a wicketkeeper is explicit: a team with no keeper bids at 1.7x the probability and values a keeper at 1.2x his market value; when the
keepers left in the pool are no more than the teams without one, the other teams sit out the bidding for them (`keeperNeed`), and a last
pass gives any team still without a keeper one from the unsold, or from a team with a spare, releasing its cheapest non-keeper if the
squad, the overseas places or the budget would otherwise stop it. The step-by-step auction (`cpuBidRound`, `AuctionState.keepersLeft`) applies
the same rules.

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
0. Every team ends the auction with a wicketkeeper (tests: `fielding-value-progression.test.ts`)
1. No team exceeds salary cap after auction
2. All teams have 18-25 players after auction
3. No team has >8 overseas players
4. Every player sold for >= base price
5. RTM count never exceeds allocated cards
6. Retained players correctly excluded from auction pool
7. Accelerated rounds correctly reduce base prices
8. CPU AI doesn't make illegal bids (over budget, over roster limit)

---

## 9. What fielding and keeping are worth (market value, retention, trades, draft)

`PlayerRatings.fielding` and `.keeping` (RULES-MATCH.md section 11) used to move wins but not prices. They now enter a player's value as
points of overall, so a better fielder or keeper costs more, consistently with how batting and bowling overall map to value.

### How much a rating point is worth in runs (measured in the engine)

`packages/engine/src/__tests__/benchmark-fielding-value.ts` simulates IPL matches between the ten real squads (40,000 per condition, same
match seeds) with the fielding side's whole squad shifted and reads the runs the opposition scores per innings:

| change to the fielding side | runs conceded per innings | win probability |
|---|---|---|
| fielding of every player -30 | +7.04 | -8.3 points |
| fielding of every player +30 | -7.67 | +8.4 |
| keeping of the keeper -30 | +0.77 | -0.1 (noise) |
| keeping of the keeper +30 | -0.95 | +0.7 |
| batting of every player -10 (all four batting attributes) | -13.6 own runs | -16.6 |
| batting of every player +10 (stars clip at 99) | +7.8 own runs | +10.2 |
| bowling of every player -10 | +7.5 | -6.5 |
| bowling of every player +10 | -8.0 | |

(30,000 matches for the batting and bowling rows; the standard error of a runs figure is about 0.2.) Linear and symmetric for
fielding and keeping, so per player and rating point:

- **Fielding**: 7.4 runs / 30 points / 11 fielders = **0.0224 runs per match per point** (a fielder at 80 against one at 48: 0.7 runs a
  match, about 10 a season). The mechanisms are the team's runs saved, who takes the catches and run-outs, and the keeper's catches.
- **Keeping**: 0.86 / 30 = **0.0287 runs per match per point** of the one keeper (70 against 50: 0.57 runs a match). Noisier: the standard
  error of this row is about 0.2 of 0.86.
- **Batting and bowling overall**, team-wide: about 1.07 runs per innings per overall point of batting and 0.77 for bowling. A regular
  top-six batter faces about 15% of the balls, a front-line bowler bowls 20% of the overs, so one overall point of a regular is worth
  about **0.155 runs per match** in either discipline.

### Pricing

A fielding point is worth 0.0224 / 0.155 = **0.145 overall points**, a keeping point 0.0287 / 0.155 = **0.185** (`FIELDING_OVR_PER_POINT`,
`KEEPING_OVR_PER_POINT` in `fielding.ts`):

```
bonus = 0.145 * (fielding - 48)  +  (designated keeper ? 0.185 * (keeping - 50) : 0)      clamped to [-6, +9]
valueOverall = overall + bonus
```

The bonus is added to the overall before the quality curve of `calculateMarketValue`, so a fielder or keeper is priced exactly like a
batter or bowler of that many more (or fewer) overall points. It is not shown as the overall and does not pick the XI. Pivots: fielding 48
(the neutral point of the engine, a little under 50 because bowlers rate lower) and keeping 50 (an average keeper, also the mean of the keepers in
the pool, most of whom have no record and sit at 50). Players without the ratings get a zero bonus and their old price. Only designated keepers
are paid for keeping: for anyone else it is a rating no match uses.

Where it is used: `Player.marketValue` (the auction order, the CPU bidding value, RTM decisions, the free-agent price), `tradeValue` in
`trade.ts` (`valueOverall` instead of `overall`), CPU retention (`retainPlayers` keeps the highest `valueOverall`; the slot costs and the
capped / uncapped rule still use the shown overall), the draft board (`DraftPlayer.fieldingBonus`, added to the overall in the draft AI's score). The
multiplayer host's CPU bidding reads `marketValue`, so it follows.

### Effect on the market (60 seeds, `benchmark-auction-value.ts`)

Real data: the ten squads retain with the CPU rule, their other players join a random 40% of the 5,300 unsigned players in the pool (a
different sample per seed, the same for both engines), then `runAuction`. Before = the engine as of the previous commit, after = this one.

| | before | after |
|---|---|---|
| market value of the 232 rostered players (total / top 20 / top 100) | 2739.8 / 381.3 / 1588.0 Cr | 2753.7 / 392.8 / 1620.1 Cr (+0.5%) |
| total spend per team, retention + auction, mean (Cr) | csk 130.0, dc 129.1, gt 130.2, kkr 129.5, lsg 130.1, mi 129.9, pbks 129.9, rcb 129.2, rr 129.7, srh 127.8 | csk 130.2, dc 128.5, gt 130.3, kkr 130.1, lsg 130.2, mi 130.3, pbks 130.1, rcb 129.2, rr 129.9, srh 127.9 |
| total spend, all teams | 1295.4 Cr | 1296.6 Cr (+0.1%) |
| price distribution of auction buys (p50 / p90 / p99) | 1.10 / 10.16 / 17.32 Cr | 0.82 / 9.43 / 18.13 Cr |
| teams ending without a keeper | 0 of 600 | 0 of 600 |
| keeping of the best keeper per team | 60.1 | 61.7 |
| keepers rated 65+ bought per seed (mean price / market value ignoring keeping) | 1.2 (0.23) | 2.3 (0.79) |

Spend per team is bounded by the 120 Cr purse (every team spends about all of it), so what moves is who gets bought: good fielders and keepers
go for more, poor ones for less, a few price changes of a Cr or two at the top. Top-20 most expensive players (mean price over the seeds in which
they were bought; Cr; fielding rating in brackets):

| before | after |
|---|---|
| Maaz Sadaqat 18.70 (50), Vaibhav Sooryavanshi 18.20 (35), Harry Brook 17.82 (59), Ayush Mhatre 17.32 (43), Hardik Pandya 17.16 (61), Venkatesh Iyer 16.23 (44), Lalit Yadav 16.11 (75), Shadab Khan 15.97 (58), Dipendra Singh Airee 15.01 (62), Priyansh Arya 14.82 (49), Lhuan-dre Pretorius 14.81 (42, WK 56), Sai Sudharsan 14.55 (37), Saim Ayub 14.48 (50), Rahul Tewatia 14.19 (47), Yuvraj Chaudhary 14.19, Salil Arora 14.00 (35, WK 50), Kartik Sharma 13.92 (40, WK 50), Tom Curran 13.61 (48), Riyan Parag 13.44 (60), Rachin Ravindra 13.37 (49) | Hardik Pandya 18.62 (61), Lalit Yadav 18.58 (75), Maaz Sadaqat 18.24 (50), Harry Brook 18.13 (59), Lhuan-dre Pretorius 17.23 (42, WK 56), Shadab Khan 16.93 (58), Dipendra Singh Airee 16.57 (62), Chris Green 16.50 (71), Ayush Mhatre 16.43 (43), Vaibhav Sooryavanshi 16.40 (35), Riyan Parag 15.75 (60), Venkatesh Iyer 15.58 (44), Akash Vasisht 15.47 (61), Kieron Pollard 15.19 (67), Yashasvi Jaiswal 14.51 (53), Priyansh Arya 14.38 (49), Saim Ayub 14.08 (50), Sanju Samson 14.07 (53, WK 31), Gerhard Erasmus 13.93 (74), Yuvraj Chaudhary 13.72 |

(The unsigned pool is dominated by players with 85+ overall at 15-20 Cr market values, so a handful of Cr moves the order a lot; the
means over 60 different pools are what to read, not any one auction.) The same effect is tested in `fielding-value-progression.test.ts`:
total spend, total market value and the average top-20 price stay within 3-5% of what they are with the ratings stripped from the same
players, and every team ends with a keeper, including when the pool holds only 11 keepers for 10 teams.

