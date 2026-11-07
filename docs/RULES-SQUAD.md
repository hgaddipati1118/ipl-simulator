# IPL Squad Composition Rules Reference

---

## 1. Squad Size Limits

| Constraint | Value | Notes |
|-----------|-------|-------|
| Maximum squad size | 25 | After auction, no more signings allowed |
| Minimum squad size | 18 | Must have at least 18 after auction |
| Playing XI | 11 | Selected from squad for each match |
| Impact player candidates | 4 | Nominated from non-XI squad members |

---

## 2. Overseas Player Limits

| Constraint | Value |
|-----------|-------|
| Max overseas in **squad** | 8 |
| Max overseas in **playing XI** | 4 |
| Max overseas as **impact sub candidates** | No specific limit (comes from squad pool) |
| Max overseas on field at any time | 4 (if impact sub replaces domestic with overseas, another overseas must exit) |

### Definition of "Overseas"
- Any player NOT holding Indian citizenship
- Players with dual nationality including Indian: count as Indian
- Associate nation players (USA, UAE, etc.): count as overseas
- This means `isInternational = country !== "India"`

---

## 3. Uncapped Player Rules

### Definition
An **uncapped** Indian player is one who has **NOT** played any international cricket (no Test, ODI, or T20I caps for India).

### Significance
- Lower retention cost (₹4 Cr vs ₹18/14/11 Cr for capped)
- Separate auction category
- Once a player receives an international cap, they become **capped** permanently
- In the simulator: we need a `isCapped` boolean on Indian players

### Tracking
```typescript
interface Player {
  // ...existing fields
  isCapped: boolean;  // NEW: only relevant for Indian players
  // For overseas players, this field is always true (they're capped by definition for IPL purposes)
}
```

### Transition
- A player starts as uncapped (young Indian domestic player)
- After being picked for Indian national team: becomes capped
- In simulator: can model this as a probability per season for highly-rated uncapped Indians
  - `capProbability = overall > 75 ? 0.3 : overall > 65 ? 0.1 : 0.02`

---

## 4. Salary Cap

### 2025 Values
| Item | Amount |
|------|--------|
| Total purse | ₹120 Crore |
| Minimum spend | ~75% of purse (~₹90 Cr) |
| Maximum retention deduction | ₹75 Cr (if retaining max with highest costs) |

### Budget Tracking
```typescript
interface TeamBudget {
  totalPurse: number;        // 120 Cr
  retentionSpend: number;    // Sum of retention costs
  auctionSpend: number;      // Sum of auction bids
  totalSpent: number;        // retention + auction
  remainingPurse: number;    // totalPurse - totalSpent
}
```

### Budget Rules
- Cannot bid more than remaining purse
- Must reserve enough to fill remaining roster spots at base price (₹20L each)
- Example: If team has 15 players and purse of ₹5 Cr, they need to reserve ₹0.6 Cr (3 spots × ₹20L), so max bid = ₹4.4 Cr
- This is an important constraint for CPU AI bidding logic

---

## 5. Playing XI Selection

### Constraints
- Exactly 11 players
- Max 4 overseas
- Must have at least 5 "bowling options" (bowlers + all-rounders who bowl)
- Must have a wicket-keeper
- Cannot select injured players

### Selection Algorithm (CPU, and the Lineup page's Auto Select)
`Team.autoSelectPlayingXI()` in `packages/engine/src/team.ts`:
```
value(p)        = fitness-adjusted overall (selectionScore) + 0.145 * (fielding - 48)            (xiSelectionValue)
keeperValue(p)  = value(p) + 0.185 * (keeping - 50)                                              (keeperSelectionValue)
                  (the fielding / keeping parts are fieldingValueBonus, clamped to [-6, +9]; absent ratings add 0)

1. Keeper first: the designated keeper with the best keeperValue
2. Bowling core: the five best bowling options by fitness-adjusted bowling overall (fielding does NOT reorder the core)
3. Fill to 11 by value, max 4 overseas; a sixth bowling option is preferred if within 3 value points of the next batter
4. Guarantee a designated keeper (swap one in if step 1 found none that fits the overseas cap)
5. No designated keeper available: bring in the squad's best keeping rating if 10+ points better than anyone in the XI
6. Batting order: WK + top-order batters first, all-rounders middle, bowlers last
7. Bowling rotation: 5-6 bowlers, each max 4 overs
```
The fielding and keeping weights are the match-engine-measured exchange rates (RULES-AUCTION.md section 9): one fielding point is worth 0.145
overall points, one keeping point (for the man who keeps) 0.185. So a 20-point better fielder edges out a batter up to ~3 overall points better,
and a specialist gloveman (keeping 80) beats a batter-keeper who keeps at 25 unless the batter is ~10 points better. Fielding only reorders the
batting/all-rounder fill and the keeper choice; the five-man bowling core is still chosen on bowling. On the 2026 IPL squads this changes 0-2
players per XI, keeps every side's five best bowlers, raises the mean XI fielding by ~1.4 points and changes runs per innings by <0.5%
(`benchmark-fielding.ts`, 6,000 matches). Tests: `packages/engine/src/__tests__/xi-fielding.test.ts`.

The Lineup page shows each player's fielding (and keeping, for keepers) in the FLD column, lists the bench by the same value, and its advisor
adds "Sharp in the Field" / "Leaky Fielding" (XI mean fielding >= 54 / <= 42), "Keeper Choice" (a benched keeper keeps 15+ points better and is
worth more behind the stumps) and "No Specialist Keeper" insights.

### Impact Sub Considerations
- If team plans to use batting impact sub: can start with 5 bowlers (sub in 6th batter later)
- If team plans to use bowling impact sub: can start with 5 batters + WK (sub in 5th bowler later)
- This decision should be made pre-match based on opponent strength

---

## 6. Playing XI — Batting Order

### Order Logic
```
1. Opener 1 (aggressive batter, high SR)
2. Opener 2 (can be WK-batter, or anchor)
3. #3 (best batter by overall, often key player)
4. #4 (strong middle-order, good vs spin)
5. #5 (all-rounder or finisher)
6. #6 (all-rounder or WK if not opening)
7. #7 (all-rounder, lower-order hitter)
8. #8 (bowling all-rounder)
9. #9 (bowler with some batting)
10. #10 (bowler)
11. #11 (bowler, usually worst batter)
```

### Sorting Key
```
battingPriority = battingOvr * 1.5 + (role === "wicket-keeper" ? 10 : 0) + (role === "all-rounder" ? 5 : 0)
```

---

## 7. Playing XI — Bowling Order

### Constraints
- Each bowler can bowl **maximum 4 overs** in a 20-over match
- Need 5 bowlers to fill 20 overs (5 × 4 = 20)
- Some teams use 6-7 bowling options for flexibility
- **No bowler can bowl consecutive overs**

### Selection Logic
```
1. Identify all players with bowlingOvr > 30 (can bowl)
2. Sort by bowlingOvr descending
3. Death over specialists (overs 16-20): best economy + clutch
4. Powerplay bowlers (overs 1-6): best wicketTaking
5. Middle over bowlers (7-15): best economy + accuracy (often spinners)
```

### Bowling Allocation Strategy
```
Overs 1-6: 2 pace bowlers alternate (each bowls 3)
Overs 7-12: 2 spinners + 1 pace (each bowls 2)
Overs 13-16: Mix of pace and spin
Overs 17-20: Best death bowlers (highest economy + clutch ratings)
```

---

## 8. Team Composition Validation

### Pre-match Validation
```typescript
function validatePlayingXI(xi: Player[], team: Team): ValidationResult {
  const errors: string[] = [];

  if (xi.length !== 11)
    errors.push(`Playing XI must be exactly 11 players (got ${xi.length})`);

  const overseas = xi.filter(p => p.isInternational).length;
  if (overseas > 4)
    errors.push(`Max 4 overseas in XI (got ${overseas})`);

  const wk = xi.filter(p => p.role === "wicket-keeper").length;
  if (wk < 1)
    errors.push(`Must have at least 1 wicket-keeper`);

  const bowlers = xi.filter(p => p.bowlingOvr >= 40).length;
  if (bowlers < 5)
    errors.push(`Need at least 5 bowling options (got ${bowlers})`);

  const injured = xi.filter(p => p.injured).length;
  if (injured > 0)
    errors.push(`${injured} injured player(s) in XI`);

  return { valid: errors.length === 0, errors };
}
```

### Post-Auction Validation
```typescript
function validateSquad(team: Team): ValidationResult {
  const errors: string[] = [];

  if (team.roster.length < 18)
    errors.push(`Squad too small: ${team.roster.length} (min 18)`);
  if (team.roster.length > 25)
    errors.push(`Squad too large: ${team.roster.length} (max 25)`);
  if (team.internationalCount > 8)
    errors.push(`Too many overseas: ${team.internationalCount} (max 8)`);
  if (team.totalSpent > team.salaryCap)
    errors.push(`Over salary cap: ₹${team.totalSpent}Cr (max ₹${team.salaryCap}Cr)`);

  return { valid: errors.length === 0, errors };
}
```

---

## Unit Tests Required

See TESTING-STRATEGY.md Phase 2D for complete test specifications.
