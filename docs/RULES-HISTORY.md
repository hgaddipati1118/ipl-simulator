# IPL Rules History (2021-2028)

Complete year-by-year rules reference for the simulator. Every season has different rules that the engine must respect.

---

## IPL 2021 (8 Teams, Pre-Expansion)

### Teams (8) and Captains
| Team | Captain |
|------|---------|
| CSK | MS Dhoni |
| DC | Rishabh Pant |
| KKR | Eoin Morgan |
| MI | Rohit Sharma |
| PBKS | KL Rahul |
| RR | Sanju Samson |
| RCB | Virat Kohli |
| SRH | David Warner |

### Format
- **56 league matches + 4 playoffs = 60 total**
- **14 matches per team** (7 home, 7 away)
- Double round-robin format
- Top 4 playoffs (Q1, Eliminator, Q2, Final)
- COVID disruption: started in India (Apr 9), suspended May 4, completed in UAE (Sep-Oct)

### Auction & Salary
- **Mini auction** (February 18, 2021, Chennai)
- **Purse**: ₹85 Crore
- 292 players auctioned, 57 sold
- Most expensive: Chris Morris → RR for ₹16.25 Cr
- No RTM cards

### Match Rules
- **No Impact Player** (not introduced until 2023)
- 1 DRS review per innings
- **Soft signal removed** (on-field umpire no longer gives soft signal for catches)
- Short-run review by third umpire
- Unlimited super overs (up to 1 hour after scheduled finish)

### Champion: Chennai Super Kings (4th title)

### Key Context
- Last 8-team season. The IndianCricketLeague repo data is from this era.
- `cricketPlayerList.js` has 392 players across these 8 teams.

---

## IPL 2022 (EXPANSION — 10 Teams)

### Teams (10) — NEW: GT and LSG
CSK, MI, RCB, KKR, RR, DC, SRH, PBKS, **Gujarat Titans (GT)**, **Lucknow Super Giants (LSG)**

### Teams (10) and Captains
| Team | Captain | Notes |
|------|---------|-------|
| CSK | Ravindra Jadeja → MS Dhoni | Jadeja handed back mid-season |
| DC | Rishabh Pant | |
| **GT** | **Hardik Pandya** | **NEW TEAM** |
| KKR | Shreyas Iyer | |
| **LSG** | **KL Rahul** | **NEW TEAM** |
| MI | Rohit Sharma | |
| PBKS | Mayank Agarwal | |
| RR | Sanju Samson | |
| RCB | Faf du Plessis | |
| SRH | Kane Williamson | |

### Format
- **70 league matches + 4 playoffs = 74 total**
- **14 matches per team**
- Two groups of 5 (seeded): Group A (MI, KKR, RR, DC, LSG), Group B (CSK, SRH, RCB, PBKS, GT)
- Each team plays same-group teams twice + 1 crossover twice + 4 crossover once = 14

### Mega Auction (February 12-13, 2022, Bengaluru)
- **Purse**: ₹90 Crore
- 600 players shortlisted, **Max 4 retentions** per existing team
- **NO RTM cards** (scrapped for 2022)
- Retention limits: Max 3 Indian, Max 2 overseas, Max 2 uncapped

### Retention Cost Structure
| Retentions | P1 | P2 | P3 | P4 | Total Deducted |
|-----------|-----|-----|-----|-----|----------------|
| 4 | ₹16Cr | ₹12Cr | ₹8Cr | ₹6Cr | ₹42Cr |
| 3 | ₹15Cr | ₹11Cr | ₹7Cr | — | ₹33Cr |
| 2 | ₹14Cr | ₹10Cr | — | — | ₹24Cr |
| 1 | ₹14Cr | — | — | — | ₹14Cr |
| Uncapped | ₹4Cr (regardless of slot) | | | | |

### Actual Retentions
| Team | Retained | Cost | Remaining |
|------|----------|------|-----------|
| CSK (4) | Jadeja, Dhoni, Moeen Ali, Ruturaj | ₹42Cr | ₹48Cr |
| MI (4) | Rohit, Bumrah, SKY, Pollard | ₹42Cr | ₹48Cr |
| DC (4) | Pant, Axar, Shaw, Nortje | ₹39Cr | ₹47.5Cr |
| KKR (4) | Russell, Varun C, Venkatesh, Narine | ₹34Cr | ₹48Cr |
| RCB (3) | Kohli, Maxwell, Siraj | ₹33Cr | ₹57Cr |
| RR (3) | Samson, Buttler, Jaiswal | ₹28Cr | ₹62Cr |
| SRH (3) | Williamson, Abdul Samad, Umran | ₹22Cr | ₹68Cr |
| PBKS (2) | Mayank, Arshdeep | ₹16Cr | ₹72Cr |

### New Team Draft (GT and LSG only)
| Team | Player 1 | Player 2 | Player 3 | Draft Spend |
|------|----------|----------|----------|-------------|
| GT | Hardik Pandya (₹15Cr) | Rashid Khan (₹15Cr) | Shubman Gill (₹8Cr) | ₹38Cr |
| LSG | KL Rahul (₹17Cr) | Marcus Stoinis (₹9.25Cr) | Ravi Bishnoi (₹4Cr) | ₹30.25Cr |

Draft rules: max 2 Indian capped + 1 overseas (or combination with uncapped)

### Match Rules
- **No Impact Player**
- 1 DRS review per innings

### Champion: Gujarat Titans (1st title, inaugural season)

### Data
- `2022PlayerRatingsWithTeams.csv` has 220 players assigned to 10 teams (IDs 0-9)

---

## IPL 2023 (Impact Player Introduced)

### Format
- **70 league matches + 4 playoffs = 74 total**
- **14 matches per team**
- Same two-group system as 2022

### Auction (December 23, 2022, Kochi)
- **Mini auction**
- **Purse**: ₹95 Crore
- 163 retained, 85 released, 87 slots available
- No RTM cards

### IMPACT PLAYER RULE — FIRST SEASON
- **Introduction date**: March 31, 2023 (first used in CSK vs GT)
- Each team names **5 substitutes** pre-match
- **1 substitution** allowed per team per match
- Substitute gets **full bat and bowl rights**
- Can be made at: start of innings, fall of wicket, end of over, batter retirement
- Max 4 overseas at any time (including impact sub)
- First Impact Player: Tushar Deshpande (CSK, replacing Ambati Rayudu)

### Scoring Impact
- Average first innings score jumped from **171.1** (2022) to **183.4** (2023)
- 200+ totals: 12.16% → 25% of innings

### Match Rules
- **DRS reviews increased to 2 per innings** (from 1)
- Smart Replay System trial
- Strategic timeouts: bowling team overs 6-9, batting team overs 13-16

---

### Champion: Chennai Super Kings (5th title)

---

## IPL 2024

### Format
- **70 league matches + 4 playoffs = 74 total**
- **14 matches per team**
- Same two-group system

### Auction (December 19, 2023, Dubai — first IPL auction outside India)
- **Mini auction**
- **Purse**: ₹100 Crore
- **Total salary cap**: ₹110 Crore (first time a total cap was specified)
- Records: Mitchell Starc → KKR ₹24.75Cr (then all-time record), Pat Cummins → SRH ₹20.5Cr
- Notable: Hardik Pandya **traded** from GT to MI (not auctioned)

### Match Rules
- Impact Player continues (second season)
- 2 DRS reviews per innings
- **Smart Replay System** fully introduced — 8 Hawk-Eye cameras, AI-assisted
- **Two bouncers per over** allowed (previously 1)
- 200+ totals: 28.47% of innings
- Runs per over exceeded 9 for first time

### Champion: Kolkata Knight Riders (3rd title)
- Runs per over exceeded 9 for the first time

---

## IPL 2025 (MEGA AUCTION — Current Season)

### Format
- **70 league matches + 4 playoffs**
- **14 matches per team**
- 2 groups of 5, with crossover matches:
  - Group A: MI, KKR, RR, DC, LSG
  - Group B: CSK, SRH, RCB, PBKS, GT
  - Each team plays 4 group opponents twice (8 matches) + 1 designated crossover twice (2) + 4 other group once (4) = 14
- Top 4 playoffs

### Mega Auction (November 24-25, 2024, Jeddah, Saudi Arabia)
- **Purse**: ₹120 Crore (biggest ever)
- **Total salary cap**: ₹146 Crore (3-part: purse + performance pay + match fees)
- **Max 6 retentions** (retentions + RTM combined)
  - Max 5 capped players
  - Max 2 uncapped Indian players
- **RTM RETURNS** (first time since 2017)
  - Modified RTM: highest bidder gets one final counter-bid chance
  - RTM cards = 6 minus retentions

### Retention Cost Structure (2025)
| Slot | Capped Cost | Uncapped Cost |
|------|------------|---------------|
| 1st | ₹18 Cr | ₹4 Cr |
| 2nd | ₹14 Cr | ₹4 Cr |
| 3rd | ₹11 Cr | — |
| 4th | ₹18 Cr | — |
| 5th | ₹14 Cr | — |

### Uncapped Player Rule (Re-Introduced)
- Indian player NOT in international starting XI for **5 calendar years** AND no BCCI central contract = uncapped
- Retention cost: ₹4 Cr (vs ₹11-18 Cr for capped)
- Notable: MS Dhoni retained as uncapped (last international: 2019)

### Match Rules
- Impact Player continues (5 nominees, 1 sub)
- 2 DRS reviews per innings
- **Hawk-Eye for wides**: technology adjudicates off-side and head-high wides
- **Match fee**: ₹7.5 Lakh per playing member per match (including Impact Player)
- **Ball change rule**: bowling team can request 1 ball change between overs 11-20 in second innings
- **Availability penalty**: 2-season ban for players who register then become unavailable
- 200+ totals: 36.62% of innings (all-time high)

### Base Price Tiers
| Price | Description |
|-------|-------------|
| ₹2 Cr | 82 marquee players |
| ₹1.5 Cr | 27 established |
| ₹1.25 Cr | 18 players |
| ₹1 Cr | 23 players |
| ₹30-75 L | Remaining pool |

### Record Purchases
- Rishabh Pant → LSG: ₹27 Cr (most expensive ever)
- Shreyas Iyer → PBKS: ₹26.75 Cr
- Jos Buttler → GT: ₹15.75 Cr (most expensive overseas)

---

## IPL 2026 (CONFIRMED — Major Format Change)

### Format
- **84 league matches** (80 round-robin + 4 playoffs)
- **16 matches per team** (up from 14)
- **DOUBLE ROUND-ROBIN RETURNS**: every team plays every other team twice (home and away)
- No more group system
- Tournament: March 28 - May 31, 2026, 13 venues

### Auction (December 16, 2025, Abu Dhabi)
- **Mini auction** (one day)
- **Purse**: ₹125 Crore
- No limit on retentions (mini auction)
- No RTM cards
- 173 players retained (49 overseas), 77 sold at auction
- Most expensive: Cameron Green at ₹25.20 Cr

### New Rules
- **Overseas salary cap**: ₹18 Crore maximum for any overseas player (excess goes to BCCI development)
- **Captain penalties**: Demerit points replace match bans for slow over rate
- **Team sheet flexibility**: Captains can bring 2 team sheets and finalize XI after the toss
- **Second ball**: Introduced after 11th over of second innings
- Impact Player continues

---

## IPL 2027 (Projected)

- **Mini auction** expected
- Total salary cap: ₹157 Crore
- Impact Player continues (confirmed through 2027)
- 84-match double round-robin format expected to continue
- No RTM (mini auction year)

---

## IPL 2028 (Projected)

- **MEGA AUCTION** expected (new 3-year cycle)
- Possible expansion to **94 matches**
- RTM likely to return (mega auction feature)
- Impact Player rule future beyond 2027 undetermined
- Max 6 retentions expected (following 2025 precedent)

---

## Summary: What Changes Year to Year

The SeasonRules config must handle ALL of these variables:

```typescript
interface SeasonRules {
  year: number;
  numberOfTeams: 8 | 10;
  teamIds: string[];  // 8 or 10 team IDs

  // Schedule
  leagueMatches: number;        // 56, 70, 74, or 84
  matchesPerTeam: number;       // 14 or 16
  scheduleFormat: "doubleRR8" | "partial10" | "groups10" | "doubleRR10";

  // Auction
  auctionType: "mega" | "mini" | "none";
  salaryCap: number;            // 85, 90, 95, 100, 120, 125
  totalSalaryCap?: number;      // 110, 146, 151, 157 (introduced 2024)
  retentionRules: RetentionConfig;
  rtmEnabled: boolean;
  rtmCards: number;             // 0 or 6
  basePriceTiers: number[];
  newTeamDraft?: { enabled: boolean; maxDraft: number; }; // 2022 only

  // Match
  impactPlayerEnabled: boolean; // false before 2023, true 2023+
  impactSubNominees: number;    // 5 (when enabled)
  drsReviewsPerInnings: number; // 1 (pre-2023) or 2 (2023+)
  overseasSalaryCap?: number;   // 18 Cr (2026+)
  matchFee?: number;            // 7.5 Lakh (2025+)

  // Composition
  maxOverseasInXI: 4;
  maxOverseasInSquad: 8;
  maxSquadSize: 25;
  minSquadSize: 18;
}
```

---

## Unit Tests for Historical Rules

Each historical SeasonRules config must be validated:
- 2021: 8 teams, 56 matches, no impact player, 1 DRS
- 2022: 10 teams, 70 matches, no impact player, 4 retentions max, new team draft
- 2023: 10 teams, 70 league matches + 4 playoffs, IMPACT PLAYER, 2 DRS, ₹95Cr
- 2024: 10 teams, 70 league matches + 4 playoffs, impact player, ₹100Cr, ₹110Cr total cap
- 2025: 10 teams, 70 league matches + 4 playoffs, impact player, ₹120Cr, 6 retentions, RTM
- 2026: 10 teams, 70 league matches + 4 playoffs, impact player, ₹125Cr purse
- 2027: 10 teams, 84 matches, impact player, ₹157Cr total cap
- 2028: 10 teams, 94? matches, TBD rules

See TESTING-STRATEGY.md Phase 4C for test specifications.
