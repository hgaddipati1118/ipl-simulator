# Venues, pitches, toss/chase and geography

Generated 2026-11-06 by `src/analysis/venue-conditions.py` + `venue-conditions-report.py`. Analysis only; nothing here changes player ratings or the engine.

## 1. Method in one screen

- **Match level (CricketArchive, every senior match 2000+; T20, List A, first-class, men and women).** Each innings: `y = mu[competition x season x innings] + beta x (batting XI strength - bowling XI strength) + region + country + ground` for runs per 100 balls (bowler-charged: bat + wides + no-balls), wickets per 100 balls and sixes per 100 balls. Strengths are the pre-match ratings from `match_strength.parquet`, so a ground isn't credited for the teams that play there. Ground effects are shrunk to the country, the country to the region (priors: 12 / 40 / 150 innings-equivalents). Factors: 100 = an average ground for that format and gender; 110 = 10% more runs (or wickets, sixes) than the same teams would get on an average ground.
- **Pitch profile** (same model): 2nd minus 1st innings scoring (FC: innings 1-4 and late-minus-early), variability (spread of innings residuals vs the format's; 1.0 = typical), low-score rate (share of innings in the format's bottom 15% after allowing for the teams), collapse rate (more than 1.5 sd below the full expectation; baseline 6.7%), dismissal mix (bowled + lbw share: low/skiddy; caught-behind share: bounce and carry; stumpings: turn), first-class draw / result rates. Everything shrunk to the format baseline by sample size.
- **Ball level (Cricsheet, 2005+).** Each ball's runs / bowler wicket / six minus its context mean (format x gender x event-season x innings x phase), then batter + bowler + country + ground effects by alternating shrunken least squares. What's left, averaged per ground (or country, region) x bowler type (x phase, x batter hand), is the type's **edge**: how much better or worse that type does there than the same bowlers do elsewhere. Value = runs saved per 100 balls + wicket value x extra wickets per 100 balls (8 runs a wicket in T20, 15 in List A, 25 in FC). Bowler types come from ESPNcricinfo bowling styles, falling back to CricketArchive (first listed style); 87-99% of balls have a type. Test days are approximate (90 overs a day).
- **Toss / chase / home**: logistic regressions on the strength gap (per 10 runs/100 balls), with home terms; venue and competition chase effects are random-intercept estimates shrunk toward the format.  'Were captains right?' compares each toss decision with the chase effect at that ground and competition estimated from **earlier seasons only**.

## 2. Validation: does knowing the ground help predict 2025-26?

Fit on 2000-2024, predict every 2025-26 innings (runs and wickets per 100 balls) from the teams' strengths, with and without the ground effects. Ground effects only help where the ground was seen before 2025.

| format | gender | metric | test innings | RMSE without ground | RMSE with ground | MSE reduction | grounds seen |
|---|---|---|---|---|---|---|---|
| T20 | male | runs/100 | 5968 | 30.733 | 30.299 | 2.8% | 85.3% |
| T20 | male | wkts/100 | 5968 | 2.458 | 2.468 | -0.79% | 85.3% |
| T20 | female | runs/100 | 3936 | 28.14 | 27.815 | 2.3% | 77.6% |
| T20 | female | wkts/100 | 3936 | 2.553 | 2.525 | 2.21% | 77.6% |
| ListA | male | runs/100 | 2888 | 19.121 | 18.953 | 1.75% | 87.1% |
| ListA | male | wkts/100 | 2888 | 1.152 | 1.154 | -0.25% | 87.1% |
| ListA | female | runs/100 | 2250 | 20.601 | 19.86 | 7.07% | 77.6% |
| ListA | female | wkts/100 | 2250 | 1.233 | 1.215 | 2.9% | 77.6% |
| FC | male | runs/100 | 4521 | 11.804 | 11.836 | -0.53% | 92.7% |
| FC | male | wkts/100 | 4521 | 0.962 | 0.953 | 1.78% | 92.7% |

## 3. Most batting- and bowling-friendly grounds

Headline tables list grounds in full-member countries plus the UAE; associate grounds (and women's first-class, too thin to rank) are in `venue_factors.csv`.

Run factor 100 = average; the standard error is about 1 point at well-used grounds and 2-3 at thin ones (`run_se` in the CSV is in runs per 100 balls). Wicket factor > 100 = more wickets than the same teams would lose elsewhere. First-class and Tests are ranked by runs per wicket (run-rate factor / wicket factor), the usual meaning of a batting pitch in long-form cricket; limited-overs grounds by run rate.

### T20, men (min 40 matches)

**Best for batting**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Alokozay Kabul International Cricket Stadium | AFG | 148 | 113.5 | 89.6 | 114.4 | +0.2 | 1.11 | 0.068 | +5.3 | -2.7 |
| Pukekura Park | NZ | 44 | 112.5 | 106.9 | 110.0 | -0.8 | 1.10 | 0.077 | -3.1 | +2.0 |
| Iqbal Stadium | PAK | 69 | 111.1 | 92.2 | 99.3 | -0.6 | 1.01 | 0.059 | -1.3 | -1.0 |
| University Oval, Dunedin | NZ | 56 | 108.7 | 95.1 | 93.4 | +3.4 | 1.00 | 0.048 | -4.3 | -1.5 |
| Eden Park Outer Oval | NZ | 45 | 108.2 | 98.6 | 100.1 | -0.0 | 0.85 | 0.040 | -7.9 | +2.0 |
| Eden Park | NZ | 48 | 106.9 | 112.9 | 108.9 | -1.8 | 1.27 | 0.063 | -6.4 | +3.0 |
| Rawalpindi Cricket Stadium | PAK | 236 | 106.9 | 93.0 | 92.5 | -1.1 | 0.87 | 0.041 | -0.7 | +0.2 |
| Bloomfield Cricket and Athletic Club Ground | SL | 43 | 106.1 | 100.7 | 100.8 | +0.3 | 1.19 | 0.022 | +1.3 | -1.8 |
| County Ground, Taunton | ENG | 138 | 105.8 | 105.0 | 90.4 | +0.5 | 0.88 | 0.038 | -3.8 | -1.4 |
| Holkar Cricket Stadium | IND | 94 | 105.8 | 99.2 | 93.8 | +8.7 | 1.18 | 0.074 | -3.3 | +1.5 |

**Best for bowling**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Stanford Cricket Ground | WI | 43 | 89.5 | 102.0 | 102.1 | -0.3 | 1.27 | 0.060 | +5.5 | +0.2 |
| Providence Stadium | WI | 128 | 90.7 | 104.1 | 99.0 | -1.2 | 0.82 | 0.041 | +10.1 | -2.0 |
| Civil Service Cricket Club | IRELAND | 40 | 90.7 | 111.3 | 92.3 | +0.3 | 0.77 | 0.043 | -0.8 | +1.8 |
| Brian Lara Stadium | WI | 57 | 91.8 | 104.4 | 103.0 | +0.1 | 0.90 | 0.040 | -0.6 | +1.4 |
| Melbourne Cricket Ground | AUS | 109 | 92.5 | 102.3 | 76.7 | +3.6 | 0.71 | 0.039 | -5.7 | +0.5 |
| Ekana Cricket Stadium | IND | 74 | 92.9 | 98.8 | 91.4 | +0.1 | 0.86 | 0.056 | -4.2 | +1.6 |
| Palam A Ground | IND | 50 | 93.1 | 93.1 | 90.0 | +3.9 | 0.67 | 0.036 | +0.9 | -0.1 |
| Perth Stadium | AUS | 56 | 93.3 | 107.9 | 88.2 | -0.7 | 0.85 | 0.033 | -8.3 | +4.0 |
| St George's Park | RSA | 96 | 93.4 | 101.8 | 81.9 | -2.6 | 0.76 | 0.044 | +1.0 | -0.1 |
| Boland Park, Paarl | RSA | 95 | 93.5 | 97.9 | 83.3 | +3.4 | 0.78 | 0.030 | +6.6 | -0.2 |

### T20, women (min 20 matches)

**Best for batting**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| National Stadium, Karachi | PAK | 21 | 117.6 | 81.8 | 98.4 | +0.5 | 0.49 | 0.022 | -11.4 | +3.4 |
| Poona Young Cricketers Hindu Gymkhana Ground | IND | 20 | 117.2 | 80.0 | – | +0.3 | 0.92 | 0.022 | -11.4 | +0.9 |
| Brabourne Stadium | IND | 25 | 116.7 | 99.8 | 93.9 | +1.6 | 1.06 | 0.076 | -8.3 | +0.9 |
| Saurashtra Cricket Association Stadium B | IND | 21 | 114.7 | 77.3 | – | +3.6 | 0.96 | 0.054 | -8.7 | -0.1 |
| Diamond Club Ground | PAK | 23 | 114.5 | 86.1 | – | +4.8 | 0.88 | 0.051 | -1.2 | -2.6 |
| Sharad Pawar Cricket Academy Ground | IND | 39 | 113.5 | 89.7 | – | +1.3 | 1.25 | 0.075 | -8.8 | +1.7 |
| Bandra Kurla Complex | IND | 38 | 112.8 | 89.4 | – | -1.6 | 0.80 | 0.046 | -10.9 | +0.4 |
| The Kent County Cricket Ground | ENG | 21 | 112.7 | 93.4 | – | +4.1 | 0.66 | 0.022 | -3.3 | -0.2 |
| Jharkhand State Cricket Association Oval Ground | IND | 37 | 111.6 | 89.4 | – | +3.2 | 0.65 | 0.025 | -2.9 | -0.8 |
| Gaddafi Stadium | PAK | 32 | 111.4 | 83.2 | – | -1.7 | 0.71 | 0.028 | +0.2 | -0.3 |

**Best for bowling**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Drummoyne Oval | AUS | 37 | 81.3 | 120.8 | 95.1 | +3.2 | 0.69 | 0.047 | -3.5 | +0.3 |
| Blacktown Olympic Park Oval | AUS | 41 | 85.7 | 113.8 | 93.9 | +3.8 | 0.60 | 0.023 | -2.1 | +0.5 |
| Melbourne Cricket Ground | AUS | 37 | 88.6 | 117.8 | 95.2 | +2.0 | 0.87 | 0.057 | -7.8 | -0.2 |
| Hurstville Oval | AUS | 22 | 88.7 | 114.0 | 94.2 | -4.5 | 0.83 | 0.068 | +6.2 | -0.1 |
| Dubai International Cricket Stadium | UAE | 33 | 89.5 | 103.4 | 97.3 | +3.1 | 0.88 | 0.027 | -6.1 | +2.0 |
| Adelaide Oval | AUS | 42 | 89.5 | 117.4 | 94.8 | +2.4 | 0.98 | 0.071 | -9.0 | +1.2 |
| WACA Ground | AUS | 64 | 90.3 | 108.6 | 98.5 | -1.6 | 0.66 | 0.023 | -9.2 | +1.9 |
| Lilac Hill Park | AUS | 22 | 90.9 | 117.4 | 98.7 | -3.4 | 0.65 | 0.037 | -12.5 | -0.3 |
| Great Barrier Reef Arena | AUS | 21 | 92.8 | 112.7 | 90.7 | +2.0 | 0.83 | 0.070 | -8.0 | +1.3 |
| Sydney Cricket Ground | AUS | 20 | 92.9 | 126.5 | – | +3.3 | 0.85 | 0.039 | -3.0 | +0.8 |

### T20Is, men (min 15 matches)

**Best for batting**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| SuperSport Park | RSA | 17 | 112.6 | 100.4 | 96.8 | +4.0 | 1.56 | 0.043 | -3.1 | +3.7 |
| Eden Park | NZ | 33 | 107.5 | 118.1 | 115.2 | -2.5 | 1.51 | 0.062 | -4.2 | +2.1 |
| Wankhede Stadium | IND | 17 | 107.1 | 100.0 | 104.7 | +3.4 | 1.07 | 0.025 | -5.5 | -1.9 |
| Wanderers Stadium | RSA | 35 | 105.6 | 102.5 | 96.4 | -1.9 | 1.32 | 0.048 | +1.5 | +1.2 |
| Sylhet Stadium | BDESH | 15 | 104.3 | 88.5 | 102.3 | +6.5 | 1.30 | 0.027 | -5.7 | -0.6 |
| Narendra Modi Stadium (Motera) | IND | 15 | 104.0 | 109.9 | 95.2 | +1.0 | 1.07 | 0.087 | -4.4 | -0.7 |
| The Oval | ENG | 16 | 103.3 | 106.2 | 90.4 | +0.8 | 1.34 | 0.026 | +3.6 | -0.7 |
| The Village Malahide | IRELAND | 20 | 102.8 | 100.3 | 95.9 | +1.2 | 1.07 | 0.072 | -3.2 | +1.9 |
| Daren Sammy Stadium | WI | 26 | 102.8 | 96.7 | 108.3 | +1.3 | 0.70 | 0.033 | -6.7 | +0.1 |
| Gaddafi Stadium | PAK | 31 | 102.4 | 95.0 | 93.2 | -8.1 | 0.91 | 0.065 | +2.5 | -0.6 |

**Best for bowling**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Providence Stadium | WI | 17 | 89.0 | 104.0 | – | -6.1 | 1.01 | 0.082 | +5.6 | +0.4 |
| Melbourne Cricket Ground | AUS | 19 | 89.3 | 104.8 | 75.2 | +6.0 | 0.70 | 0.058 | -4.8 | +1.6 |
| Civil Service Cricket Club | IRELAND | 28 | 89.4 | 112.7 | 85.8 | +0.0 | 0.90 | 0.057 | -2.9 | +2.2 |
| Shere Bangla National Stadium | BDESH | 68 | 90.2 | 99.4 | 89.2 | -1.8 | 0.92 | 0.073 | +0.6 | +0.0 |
| R Premadasa Stadium | SL | 54 | 93.5 | 100.6 | 91.9 | +3.6 | 0.72 | 0.057 | +2.8 | -2.1 |
| Dubai International Cricket Stadium | UAE | 109 | 93.8 | 100.2 | 77.2 | +1.1 | 0.90 | 0.052 | +2.4 | +0.1 |
| Newlands | RSA | 21 | 94.8 | 102.1 | 88.4 | +1.0 | 0.62 | 0.038 | -5.2 | +1.8 |
| Sheikh Zayed Stadium | UAE | 76 | 95.0 | 91.6 | 90.6 | +1.9 | 0.78 | 0.043 | +6.7 | +0.1 |
| Harare Sports Club | ZIM | 76 | 95.2 | 93.1 | 79.4 | -3.7 | 0.84 | 0.031 | -0.2 | +0.5 |
| Sydney Cricket Ground | AUS | 19 | 95.3 | 108.3 | 76.9 | -0.5 | 0.92 | 0.041 | -2.0 | +0.2 |

### List A, men (min 40 matches)

**Best for batting**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Saurashtra Cricket Association Stadium | IND | 43 | 112.5 | 90.4 | 99.6 | +0.2 | 0.72 | 0.022 | -8.5 | -1.2 |
| North Sydney Oval | AUS | 57 | 111.2 | 96.6 | 111.8 | +2.7 | 1.07 | 0.062 | -6.0 | +0.4 |
| County Ground, Taunton | ENG | 174 | 110.4 | 104.4 | 89.9 | +0.3 | 1.20 | 0.050 | -0.6 | -0.4 |
| Jinnah Stadium, Sialkot | PAK | 46 | 110.0 | 91.7 | 90.2 | -2.7 | 1.43 | 0.066 | -1.1 | +0.3 |
| Khost Cricket Stadium | AFG | 58 | 108.8 | 96.3 | 110.2 | -0.9 | 0.86 | 0.047 | +4.0 | -1.7 |
| Bloomfield Cricket and Athletic Club Ground | SL | 125 | 107.5 | 97.0 | 103.2 | +0.9 | 1.35 | 0.042 | +1.3 | -3.1 |
| Ghazi Amanullah Khan International Cricket Stadium | AFG | 54 | 107.2 | 93.9 | 101.6 | -0.1 | 0.76 | 0.042 | +2.7 | +2.2 |
| Panadura Esplanade | SL | 88 | 106.8 | 102.9 | 110.2 | -2.3 | 1.12 | 0.043 | +4.0 | -2.9 |
| The Oval | ENG | 169 | 106.6 | 105.7 | 106.5 | +0.0 | 1.30 | 0.054 | -1.3 | +1.9 |
| SuperSport Park | RSA | 172 | 106.5 | 101.6 | 94.1 | +1.8 | 1.23 | 0.062 | -3.3 | +2.4 |

**Best for bowling**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Providence Stadium | WI | 52 | 87.9 | 99.9 | 101.4 | -1.3 | 0.81 | 0.035 | +7.4 | -3.4 |
| Dubai International Cricket Stadium | UAE | 87 | 90.8 | 98.3 | 92.7 | +1.6 | 0.65 | 0.033 | +2.1 | +0.9 |
| Moti Bagh Stadium | IND | 47 | 91.3 | 104.9 | 102.8 | +3.3 | 1.03 | 0.082 | +0.6 | +2.2 |
| Sri Lanka Army Ordnance Corps International Cricket Stadium, Dombagoda | SL | 40 | 92.4 | 96.0 | 105.2 | +3.6 | 0.99 | 0.014 | +1.5 | -0.8 |
| Sheikh Zayed Stadium | UAE | 89 | 93.4 | 100.5 | 101.4 | -1.9 | 0.60 | 0.017 | +6.0 | -1.0 |
| Sabina Park | WI | 58 | 93.4 | 99.2 | 99.9 | +0.0 | 0.69 | 0.032 | -2.1 | +0.1 |
| Air Force Ground, Katunayake | SL | 46 | 93.7 | 99.6 | – | -0.0 | 0.59 | 0.039 | +6.6 | -4.1 |
| Sir Vivian Richards Stadium | WI | 71 | 93.9 | 98.3 | 99.0 | +2.9 | 0.79 | 0.033 | -3.9 | +0.7 |
| Palam A Ground | IND | 74 | 94.6 | 98.6 | 94.1 | -1.5 | 0.77 | 0.056 | +3.6 | -0.5 |
| Khan Shaheb Osman Ali Stadium | BDESH | 226 | 94.9 | 99.9 | 103.2 | -0.0 | 0.87 | 0.037 | +2.1 | -3.2 |

### ODIs, men (min 15 matches)

**Best for batting**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| M Chinnaswamy Stadium | IND | 20 | 112.9 | 97.8 | 110.9 | +2.5 | 1.47 | 0.074 | +1.4 | -3.3 |
| National Stadium, Karachi | PAK | 25 | 109.6 | 92.6 | 94.1 | -3.8 | 0.83 | 0.048 | +0.8 | -1.8 |
| The Village Malahide | IRELAND | 19 | 107.4 | 93.8 | – | -2.0 | 1.13 | 0.058 | -0.2 | +4.0 |
| Gaddafi Stadium | PAK | 46 | 107.2 | 95.7 | 96.5 | -2.2 | 0.89 | 0.066 | +0.4 | -0.5 |
| Trent Bridge | ENG | 29 | 106.7 | 102.5 | 91.0 | +0.7 | 1.23 | 0.030 | -5.9 | +0.6 |
| Mahinda Rajapaksa International Stadium | SL | 24 | 106.4 | 100.2 | 102.1 | -0.1 | 1.19 | 0.080 | +1.1 | +1.5 |
| Warner Park | WI | 21 | 105.1 | 97.2 | 114.2 | -2.1 | 0.98 | 0.022 | -2.6 | -2.9 |
| Wankhede Stadium | IND | 17 | 104.9 | 100.8 | 106.9 | -5.2 | 1.10 | 0.043 | -3.9 | +3.0 |
| Bellerive Oval | AUS | 22 | 104.8 | 98.4 | 107.5 | -0.1 | 0.88 | 0.021 | -5.1 | -1.2 |
| Punjab Cricket Association IS Bindra Stadium | IND | 19 | 104.7 | 101.3 | – | +0.4 | 0.80 | 0.040 | +0.8 | -0.4 |

**Best for bowling**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Providence Stadium | WI | 27 | 87.0 | 99.9 | 100.8 | -1.6 | 0.78 | 0.045 | +8.7 | -3.5 |
| Rangiri Dambulla Stadium | SL | 53 | 89.6 | 106.8 | 104.8 | +1.0 | 1.03 | 0.106 | -1.1 | +1.9 |
| Civil Service Cricket Club | IRELAND | 33 | 90.8 | 100.2 | – | +2.4 | 0.73 | 0.062 | -1.9 | +1.1 |
| Dubai International Cricket Stadium | UAE | 69 | 90.9 | 97.6 | 90.0 | +2.3 | 0.65 | 0.034 | +1.8 | +1.2 |
| Zahur Ahmed Chowdhury Stadium | BDESH | 26 | 91.8 | 95.5 | – | +1.7 | 1.09 | 0.074 | +3.0 | +0.1 |
| St George's Park | RSA | 19 | 92.3 | 103.3 | – | -0.2 | 0.82 | 0.040 | +1.6 | +0.6 |
| Shere Bangla National Stadium | BDESH | 129 | 92.4 | 101.5 | 123.2 | +1.7 | 0.96 | 0.077 | +1.4 | -0.8 |
| Sheikh Zayed Stadium | UAE | 60 | 93.1 | 100.1 | 101.2 | -3.1 | 0.63 | 0.017 | +6.9 | -2.0 |
| Sabina Park | WI | 32 | 93.9 | 97.8 | 99.2 | -0.1 | 0.83 | 0.052 | -5.8 | +1.0 |
| Kensington Oval | WI | 38 | 94.5 | 105.4 | 90.6 | +3.2 | 1.27 | 0.076 | -1.7 | -0.1 |

### ODIs, women (min 8 matches)

**Best for batting**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Indian Institute of Technology Chemplast Ground | IND | 8 | 114.6 | 97.0 | – | +0.3 | 0.70 | 0.037 | +4.9 | +2.7 |
| Senwes Park | RSA | 18 | 114.0 | 90.3 | – | +0.9 | 0.92 | 0.061 | -3.5 | +4.2 |
| National Bank Cricket Arena | PAK | 9 | 111.3 | 87.0 | – | -2.7 | 0.89 | 0.035 | +0.5 | -0.3 |
| Castle Avenue | IRELAND | 8 | 110.3 | 93.9 | – | -4.0 | 1.20 | 0.067 | +0.5 | +1.4 |
| Harare Sports Club | ZIM | 18 | 110.2 | 91.3 | – | +1.3 | 1.14 | 0.077 | +5.1 | +3.5 |
| Gaddafi Stadium | PAK | 16 | 109.6 | 95.1 | – | +3.1 | 3.48 | 0.045 | -2.7 | +0.2 |
| Brabourne Stadium | IND | 11 | 109.6 | 99.7 | – | -0.0 | 1.01 | 0.056 | -7.6 | +2.1 |
| Bert Sutcliffe Oval | NZ | 57 | 108.2 | 99.9 | – | +1.4 | 1.07 | 0.032 | -7.5 | +3.3 |
| County Ground, Taunton | ENG | 22 | 107.7 | 99.5 | – | +5.7 | 1.87 | 0.099 | -5.7 | +2.9 |
| Grace Road | ENG | 17 | 107.4 | 109.5 | – | -4.1 | 1.28 | 0.044 | +3.4 | +0.2 |

**Best for bowling**

| ground | country | matches | run factor | wkt factor | six factor | 2nd-1st inn (runs/100) | variability | collapse rate | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Arnos Vale Playing Field | WI | 8 | 83.5 | 108.3 | – | +2.0 | 1.02 | 0.093 | +4.5 | +0.5 |
| Shere Bangla National Stadium | BDESH | 19 | 86.8 | 102.4 | – | -0.3 | 0.80 | 0.058 | -6.8 | +0.8 |
| Sheikh Kamal International Cricket Stadium | BDESH | 8 | 88.5 | 103.4 | – | +1.9 | 1.36 | 0.093 | -0.8 | -1.2 |
| ACA-VDCA Stadium | IND | 10 | 90.8 | 93.9 | – | -0.0 | 1.06 | 0.083 | -7.1 | -2.0 |
| Sharjah Cricket Stadium | UAE | 9 | 93.0 | 96.9 | – | +0.8 | 0.99 | 0.062 | -5.1 | -0.9 |
| P Sara Oval | SL | 10 | 93.0 | 98.6 | – | -1.4 | 1.26 | 0.060 | -6.4 | +2.6 |
| Lord's | ENG | 11 | 93.6 | 103.7 | – | +0.2 | 0.81 | 0.033 | +3.5 | -1.1 |
| Barabati Stadium | IND | 8 | 94.1 | 105.3 | – | +0.8 | 0.97 | 0.067 | -4.2 | +5.9 |
| St Kilda Cricket Ground | AUS | 9 | 94.3 | 106.1 | – | +1.2 | 1.15 | 0.167 | +3.1 | +0.5 |
| R Premadasa Stadium | SL | 26 | 94.9 | 110.8 | – | +5.1 | 1.10 | 0.089 | -9.0 | +1.9 |

### Tests, men (min 10 matches)

**Best for batting**

| ground | country | matches | run-rate factor | wkt factor | runs per wkt factor | late-early inn (runs/100) | draw rate | variability | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Queens Sports Club | ZIM | 26 | 98.9 | 84.3 | 117.3 | +0.1 | 0.19 | 0.72 | -1.1 | -2.6 |
| Hagley Oval | NZ | 15 | 103.0 | 89.6 | 115.0 | -3.4 | 0.16 | 1.47 | -9.8 | +3.2 |
| Gaddafi Stadium | PAK | 12 | 102.8 | 90.6 | 113.5 | -2.9 | 0.26 | 1.08 | +3.2 | -1.8 |
| Zahur Ahmed Chowdhury Stadium | BDESH | 20 | 98.7 | 88.1 | 112.0 | +2.5 | 0.26 | 0.62 | +5.6 | -2.3 |
| Sinhalese Sports Club Ground | SL | 33 | 100.1 | 90.4 | 110.7 | -1.1 | 0.25 | 0.97 | -1.2 | -3.7 |
| Sheikh Zayed Stadium | UAE | 16 | 94.1 | 85.1 | 110.6 | -0.1 | 0.26 | 0.80 | +5.7 | -2.5 |
| National Stadium, Karachi | PAK | 11 | 100.4 | 91.9 | 109.2 | +1.9 | 0.19 | 0.78 | +1.9 | -0.8 |
| Harare Sports Club | ZIM | 26 | 100.1 | 91.9 | 108.9 | +2.0 | 0.14 | 0.73 | -0.6 | -0.5 |
| Sir Vivian Richards Stadium | WI | 14 | 94.2 | 86.8 | 108.5 | +1.4 | 0.31 | 0.68 | -3.3 | +2.9 |
| Seddon Park | NZ | 16 | 102.0 | 94.2 | 108.3 | +0.3 | 0.16 | 1.12 | -9.0 | +3.3 |

**Best for bowling**

| ground | country | matches | run-rate factor | wkt factor | runs per wkt factor | late-early inn (runs/100) | draw rate | variability | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Sabina Park | WI | 22 | 91.4 | 117.3 | 77.9 | +2.0 | 0.11 | 1.07 | -1.2 | +2.6 |
| Wankhede Stadium | IND | 11 | 97.4 | 118.2 | 82.4 | -0.9 | 0.15 | 1.10 | -5.2 | -1.9 |
| Wanderers Stadium | RSA | 23 | 103.0 | 116.5 | 88.4 | +2.1 | 0.13 | 0.57 | -9.9 | +7.6 |
| Kensington Oval | WI | 21 | 93.2 | 104.8 | 88.9 | +1.2 | 0.22 | 0.74 | -7.4 | -0.9 |
| Asgiriya Stadium | SL | 12 | 96.6 | 108.1 | 89.4 | +0.1 | 0.18 | 0.63 | +3.5 | -1.5 |
| Kingsmead | RSA | 20 | 96.9 | 107.1 | 90.5 | +0.6 | 0.17 | 0.69 | -7.5 | +2.4 |
| Daren Sammy Stadium | WI | 10 | 93.7 | 102.2 | 91.7 | +3.4 | 0.28 | 0.69 | -7.3 | +2.2 |
| Melbourne Cricket Ground | AUS | 26 | 95.6 | 103.1 | 92.7 | -1.4 | 0.12 | 0.69 | -7.0 | +3.8 |
| M Chinnaswamy Stadium | IND | 13 | 96.9 | 103.8 | 93.4 | +1.8 | 0.25 | 0.93 | +3.5 | -4.0 |
| Punjab Cricket Association IS Bindra Stadium | IND | 11 | 95.5 | 102.1 | 93.5 | +0.3 | 0.23 | 0.91 | +2.6 | -1.2 |

### First-class, men (min 40 matches)

**Best for batting**

| ground | country | matches | run-rate factor | wkt factor | runs per wkt factor | late-early inn (runs/100) | draw rate | variability | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Mutare Sports Club | ZIM | 58 | 111.7 | 86.6 | 129.0 | +0.3 | 0.35 | 1.01 | +5.2 | -1.2 |
| Old Hararians | ZIM | 46 | 109.5 | 91.4 | 119.8 | -1.6 | 0.39 | 1.04 | +5.6 | -3.4 |
| Welagedara Stadium | SL | 60 | 106.6 | 89.8 | 118.7 | +0.7 | 0.57 | 1.35 | +0.3 | -5.5 |
| Queens Sports Club | ZIM | 105 | 102.2 | 86.6 | 118.0 | +0.6 | 0.25 | 0.85 | +1.9 | -3.5 |
| Sinhalese Sports Club Ground | SL | 188 | 109.1 | 92.9 | 117.4 | -0.8 | 0.51 | 1.11 | -5.0 | -1.2 |
| Nondescripts Cricket Club Ground | SL | 169 | 110.8 | 94.4 | 117.4 | +1.0 | 0.59 | 1.48 | -3.8 | -2.8 |
| Senwes Park | RSA | 91 | 110.0 | 94.2 | 116.8 | -0.6 | 0.47 | 0.90 | +2.8 | +1.9 |
| Air Force Ground, Colombo | SL | 46 | 114.7 | 98.7 | 116.2 | +1.8 | 0.42 | 1.38 | -5.7 | -5.7 |
| Sawai Mansingh Stadium | IND | 56 | 98.4 | 85.3 | 115.4 | +0.6 | 0.60 | 0.80 | +4.3 | +1.3 |
| Zahur Ahmed Chowdhury Stadium | BDESH | 75 | 99.0 | 86.1 | 115.0 | +0.6 | 0.41 | 1.01 | +3.5 | -1.9 |

**Best for bowling**

| ground | country | matches | run-rate factor | wkt factor | runs per wkt factor | late-early inn (runs/100) | draw rate | variability | bowled+lbw pp | caught-behind pp |
|---|---|---|---|---|---|---|---|---|---|---|
| Chaudhary Bansi Lal Cricket Stadium | IND | 73 | 92.9 | 126.4 | 73.5 | -0.0 | 0.25 | 0.64 | +4.7 | +2.3 |
| Sabina Park | WI | 96 | 89.4 | 111.3 | 80.3 | +0.2 | 0.19 | 0.77 | -1.7 | -1.2 |
| Providence Stadium | WI | 54 | 88.2 | 104.8 | 84.2 | -0.3 | 0.27 | 0.67 | +6.8 | -2.7 |
| The Gabba | AUS | 134 | 98.0 | 112.8 | 86.9 | +0.3 | 0.18 | 0.83 | -11.7 | +7.5 |
| Moti Bagh Stadium | IND | 63 | 97.4 | 111.7 | 87.2 | +0.6 | 0.27 | 0.70 | -2.1 | +1.0 |
| Daren Sammy Stadium | WI | 41 | 94.1 | 105.4 | 89.3 | +2.0 | 0.35 | 1.43 | -6.0 | -0.3 |
| Queen's Park Oval | WI | 68 | 91.6 | 101.9 | 89.9 | +0.9 | 0.25 | 1.04 | +2.5 | -3.1 |
| Ghazi Amanullah Khan International Cricket Stadium | AFG | 70 | 107.0 | 118.0 | 90.7 | +1.1 | 0.28 | 1.19 | +2.5 | -3.6 |
| Karnail Singh Stadium | IND | 74 | 89.9 | 97.8 | 91.9 | -1.0 | 0.50 | 0.61 | +3.9 | -1.0 |
| Iqbal Stadium | PAK | 144 | 96.6 | 104.1 | 92.8 | +0.2 | 0.38 | 0.82 | +1.7 | +0.1 |

## 4. Pitch profile extremes

### T20 men (full-member and UAE grounds)

- **Most variable** (spread of scores vs expectation): Emerald High School Ground (1.78), Eden Park (1.27), Stanford Cricket Ground (1.27), Burgher Recreation Club Ground (1.26), Lalabhai Contractor Stadium (1.24), SuperSport Park (1.21)
- **Most predictable**: Diamond Oval (0.64), Palam A Ground (0.67), Multan Cricket Stadium (0.67), Hagley Oval (0.69), Basin Reserve (0.70), Melbourne Cricket Ground (0.71)
- **Highest collapse rate**: Lalabhai Contractor Stadium (0.092), Barabati Stadium (0.085), Sydney Parade (0.082), Emerald High School Ground (0.079), Burgher Recreation Club Ground (0.079), Saurashtra Cricket Association Stadium (0.077)
- **Bounce / carry** (caught-behind share, pp vs format): Perth Stadium (+4.0), Willowmoore Park Main Oval (+3.6), DY Patil Stadium (+3.5), JB Marks Cricket Oval (+3.2), Eden Park (+3.0), Bay Oval (+2.1)
- **Low / skiddy** (bowled + lbw share, pp): Senwes Park (+10.6), Providence Stadium (+10.1), Burgher Recreation Club Ground (+8.0), Boland Park, Paarl (+6.6), Willowmoore Park Main Oval (+6.2), Queens Sports Club (+6.1)
- **Turn** (stumping share, pp): Colombo Cricket Club Ground, Colombo (+3.7), Bloomfield Cricket and Athletic Club Ground (+3.0), Colts Cricket Club Ground (+2.8), P Sara Oval (+2.5), Burgher Recreation Club Ground (+2.3), Stanford Cricket Ground (+2.0)
- **Easier to bat 2nd** (runs/100, 2nd minus 1st innings): Holkar Cricket Stadium (+8.7), County Ground, Bristol (+4.6), Brabourne Stadium (+4.2), Daren Sammy Stadium (+4.0), Palam A Ground (+3.9), Sophia Gardens (+3.8)
- **Harder to bat 2nd**: Barabati Stadium (-7.9), Headingley (-5.5), Emerald High School Ground (-4.9), WACA Ground (-4.4), Lord's (-4.2), Senwes Park (-4.0)

### ODIs men (full-member and UAE grounds)

- **Most variable** (spread of scores vs expectation): Wellington Regional Stadium (1.66), M Chinnaswamy Stadium (1.47), Wanderers Stadium (1.41), Kensington Oval (1.27), Trent Bridge (1.23), Sydney Cricket Ground (1.23)
- **Most predictable**: Sheikh Zayed Stadium (0.63), ICC Cricket Academy Ground (0.64), Dubai International Cricket Stadium (0.65), Kingsmead (0.67), Melbourne Cricket Ground (0.71), Civil Service Cricket Club (0.73)
- **Highest collapse rate**: Sinhalese Sports Club Ground (0.165), Rangiri Dambulla Stadium (0.106), Wellington Regional Stadium (0.105), Wanderers Stadium (0.103), WACA Ground (0.103), Arun Jaitley Stadium (Feroz Shah Kotla) (0.092)
- **Bounce / carry** (caught-behind share, pp vs format): Old Trafford (+4.7), WACA Ground (+4.6), Narendra Modi Stadium (Motera) (+4.5), The Gabba (+4.5), Hagley Oval (+4.5), Newlands (+4.4)
- **Low / skiddy** (bowled + lbw share, pp): Providence Stadium (+8.7), Rawalpindi Cricket Stadium (+8.6), Sheikh Zayed Stadium (+6.9), Pallekele International Stadium (+5.7), Sharjah Cricket Stadium (+3.9), Arun Jaitley Stadium (Feroz Shah Kotla) (+3.2)
- **Turn** (stumping share, pp): Providence Stadium (+1.8), Punjab Cricket Association IS Bindra Stadium (+1.1), Rangiri Dambulla Stadium (+0.6), Bangabandhu National Stadium (+0.5), National Stadium, Karachi (+0.5), Zahur Ahmed Chowdhury Stadium (+0.5)
- **Easier to bat 2nd** (runs/100, 2nd minus 1st innings): Willowmoore Park Main Oval (+5.5), MA Chidambaram Stadium (Chepauk) (+3.5), Sophia Gardens (+3.3), Wellington Regional Stadium (+3.2), Kensington Oval (+3.2), Seddon Park (+2.6)
- **Harder to bat 2nd**: Wankhede Stadium (-5.2), Queen's Park Oval (-4.6), Eden Gardens (-4.3), Newlands (-4.1), R Premadasa Stadium (-3.8), National Stadium, Karachi (-3.8)

### Tests men (full-member and UAE grounds)

- **Most variable** (spread of scores vs expectation): Queen's Park Oval (1.98), Old Trafford (1.78), Edgbaston (1.77), Hagley Oval (1.47), Sydney Cricket Ground (1.30), Rawalpindi Cricket Stadium (1.28)
- **Most predictable**: SuperSport Park (0.47), Dubai International Cricket Stadium (0.49), Lord's (0.56), Wanderers Stadium (0.57), Eden Gardens (0.61), Zahur Ahmed Chowdhury Stadium (0.62)
- **Highest collapse rate**: Punjab Cricket Association IS Bindra Stadium (0.057), Wankhede Stadium (0.056), Sinhalese Sports Club Ground (0.055), Queen's Park Oval (0.054), Hagley Oval (0.045), Rawalpindi Cricket Stadium (0.040)
- **Bounce / carry** (caught-behind share, pp vs format): Wanderers Stadium (+7.6), SuperSport Park (+6.2), The Gabba (+5.6), Basin Reserve (+4.5), St George's Park (+4.2), Newlands (+4.2)
- **Low / skiddy** (bowled + lbw share, pp): Arun Jaitley Stadium (Feroz Shah Kotla) (+10.4), Dubai International Cricket Stadium (+6.6), Eden Gardens (+5.8), Sheikh Zayed Stadium (+5.7), Zahur Ahmed Chowdhury Stadium (+5.6), Narendra Modi Stadium (Motera) (+5.4)
- **Turn** (stumping share, pp): M Chinnaswamy Stadium (+2.2), Rawalpindi Cricket Stadium (+1.7), Galle International Stadium (+1.6), Wankhede Stadium (+1.5), Dubai International Cricket Stadium (+1.4), Sinhalese Sports Club Ground (+1.2)
- **Deteriorates most** (innings 3-4 minus 1-2, runs/100): Adelaide Oval (-3.7), Hagley Oval (-3.4), Eden Gardens (-3.1), Gaddafi Stadium (-2.9), Trent Bridge (-2.7), Multan Cricket Stadium (-2.6)
- **Gets better to bat on**: Daren Sammy Stadium (+3.4), Zahur Ahmed Chowdhury Stadium (+2.5), Sydney Cricket Ground (+2.1), Wanderers Stadium (+2.1), Shere Bangla National Stadium (+2.1), Sabina Park (+2.0)
- **Most results** (lowest draw rate): Headingley (0.10), Sabina Park (0.11), Shere Bangla National Stadium (0.11), Melbourne Cricket Ground (0.12), SuperSport Park (0.12), Wanderers Stadium (0.13)
- **Most draws**: Sir Vivian Richards Stadium (0.31), Narendra Modi Stadium (Motera) (0.30), Daren Sammy Stadium (0.28), Gaddafi Stadium (0.26), Sheikh Zayed Stadium (0.26), Zahur Ahmed Chowdhury Stadium (0.26)

## 5. IPL grounds over time (T20 men, all T20 at the ground)

Run factor per era (matches in brackets); the era value is shrunk toward the ground's overall value, so thin eras move less.

| ground | matches | overall | 2008-13 | 2014-19 | 2020-23 | 2024-26 | 2nd-1st inn |
|---|---|---|---|---|---|---|---|
| Brabourne Stadium | 44 | 103.9 | 107.4 (12) | 107.4 (4) | 105.7 (16) | – | +4.2 |
| Punjab Cricket Association IS Bindra Stadium | 130 | 103.6 | 104.3 (29) | 102.0 (57) | 103.4 (20) | 107.2 (24) | -0.2 |
| M Chinnaswamy Stadium | 140 | 102.9 | 103.1 (51) | 104.1 (56) | 103.7 (8) | 100.6 (25) | +1.0 |
| Wankhede Stadium | 225 | 102.3 | 99.1 (32) | 103.2 (75) | 105.5 (64) | 97.7 (44) | +0.7 |
| ACA-VDCA Stadium | 58 | 102.3 | 101.8 (6) | 100.0 (32) | 104.4 (7) | 106.9 (13) | -3.7 |
| Rajiv Gandhi International Stadium | 164 | 102.0 | 102.1 (62) | 98.9 (46) | 98.1 (8) | 106.0 (48) | +0.2 |
| Narendra Modi Stadium (Motera) | 96 | 101.2 | 105.7 (10) | 100.3 (9) | 101.3 (22) | 100.0 (45) | -2.6 |
| DY Patil Stadium | 51 | 100.5 | 95.8 (17) | – | 99.9 (20) | 106.9 (14) | +0.7 |
| Eden Gardens | 191 | 100.1 | 95.7 (37) | 100.8 (73) | 104.6 (30) | 98.4 (41) | +0.3 |
| Arun Jaitley Stadium (Feroz Shah Kotla) | 184 | 100.1 | 97.5 (43) | 100.4 (73) | 100.4 (29) | 104.6 (29) | +1.4 |
| Sawai Mansingh Stadium | 138 | 98.0 | 100.9 (43) | 97.2 (37) | 97.2 (18) | 95.3 (30) | +2.7 |
| HPCA Stadium | 37 | 98.0 | 100.6 (9) | 92.3 (16) | 102.4 (4) | 100.0 (8) | -3.3 |
| Maharashtra Cricket Association Stadium | 81 | 97.7 | 94.5 (18) | 97.9 (31) | 97.9 (15) | 100.1 (17) | -2.7 |
| Maharaja Yadavindra Singh Stadium | 38 | 96.7 | – | – | 91.7 (14) | 99.2 (24) | -6.0 |
| Sharjah Cricket Stadium | 189 | 96.2 | 93.8 (26) | 97.3 (78) | 95.1 (41) | 96.9 (44) | +0.6 |
| MA Chidambaram Stadium (Chepauk) | 133 | 95.5 | 98.4 (57) | 92.7 (27) | 91.3 (19) | 95.0 (30) | -0.9 |
| Sheikh Zayed Stadium | 218 | 95.4 | 96.8 (27) | 93.5 (72) | 96.0 (71) | 96.2 (48) | +0.0 |
| Barsapara Cricket Stadium | 21 | 95.1 | – | – | 94.7 (13) | 94.7 (7) | +3.3 |
| Dubai International Cricket Stadium | 273 | 93.8 | 91.7 (41) | 94.0 (101) | 95.7 (67) | 92.9 (64) | +0.8 |
| Ekana Cricket Stadium | 74 | 92.9 | – | 89.8 (4) | 91.8 (32) | 93.7 (38) | +0.1 |

## 6. Which bowler types work where

Edge = value per 100 balls vs what the same bowlers do elsewhere (runs saved + wicket value x extra wickets); ± = 1 SE. Thin cells are shrunk hard, so small edges are the norm; treat |edge| < 2 SE as noise.

### By region, T20 men (edge per 100 balls)

| region | RA fast | RA fast-medium | RA medium | LA pace | off-spin | wrist-spin | LA orthodox |
|---|---|---|---|---|---|---|---|
| Africa (other) | +1.2 | -1.7 | -1.7 | +1.9 | +1.1 | -1.1 | +2.7 |
| East Asia | – | -0.1 | -1.8 | -0.1 | +1.6 | +0.9 | +2.9 |
| Europe (other) | +0.7 | +0.7 | -1.3 | +0.9 | +0.7 | +2.0 | +1.7 |
| Gulf | +2.1 | -0.0 | -1.4 | -0.2 | -1.7 | +2.1 | +1.0 |
| SENA | +1.9 | +0.1 | -1.5 | +0.3 | +0.5 | -0.5 | +0.8 |
| Subcontinent | -0.6 | -0.1 | -1.7 | +1.3 | -0.1 | +0.9 | +2.0 |
| West Indies | -0.8 | -1.6 | -0.3 | -1.1 | +1.5 | +3.2 | -0.5 |

### By region, List A men (edge per 100 balls)

| region | RA fast | RA fast-medium | RA medium | LA pace | off-spin | wrist-spin | LA orthodox |
|---|---|---|---|---|---|---|---|
| Africa (other) | +0.5 | +1.0 | +0.2 | +1.1 | +0.5 | +0.1 | -1.1 |
| Europe (other) | +1.0 | +1.1 | -1.2 | +0.4 | -0.3 | -0.0 | +1.3 |
| Gulf | +0.2 | -1.0 | -1.0 | +0.5 | +1.2 | +0.7 | +0.4 |
| SENA | +1.4 | +0.8 | -0.3 | +1.5 | -1.9 | -0.3 | -0.1 |
| Subcontinent | +1.1 | -0.3 | -2.3 | +1.4 | +0.8 | -0.6 | +1.7 |
| West Indies | +0.1 | -0.3 | +1.1 | +0.5 | -0.2 | +1.4 | -0.0 |

### By region, First-class men (edge per 100 balls)

| region | RA fast | RA fast-medium | RA medium | LA pace | off-spin | wrist-spin | LA orthodox |
|---|---|---|---|---|---|---|---|
| Africa (other) | +0.3 | +0.6 | +0.6 | +0.1 | -0.7 | -0.6 | +0.4 |
| SENA | +1.0 | +1.1 | -0.2 | +1.1 | -2.2 | -1.6 | -1.4 |
| Subcontinent | +0.9 | -0.1 | -1.0 | -0.4 | +0.4 | +0.7 | +1.6 |
| West Indies | +1.6 | +0.6 | +0.8 | -0.8 | +0.0 | -1.4 | -1.0 |

### By region, T20 women (edge per 100 balls)

| region | RA fast | RA fast-medium | RA medium | LA pace | off-spin | wrist-spin | LA orthodox |
|---|---|---|---|---|---|---|---|
| Africa (other) | – | -3.4 | +0.8 | +0.4 | +2.6 | +1.5 | +0.8 |
| East Asia | – | -2.4 | -2.6 | -0.4 | +3.0 | +3.1 | +2.2 |
| Europe (other) | – | +0.6 | -0.0 | -0.4 | +0.6 | +1.1 | +2.2 |
| SENA | +1.2 | -0.4 | -0.5 | +0.7 | +0.8 | +0.1 | +0.2 |
| Subcontinent | – | +0.6 | -1.1 | +1.2 | -0.8 | +0.3 | +1.7 |

### At this ground, pick X; avoid Y

`*` = edge more than 2 SE from zero. 'Others' lists the remaining types best to worst.

**IPL grounds (T20 men, all T20 at the ground)**

| ground | pick | avoid | others |
|---|---|---|---|
| Wankhede Stadium | LA orthodox +1.9 ±2.7 | RA fast-medium -1.8 ±2.4 | RA fast +1.0, LA pace +0.4, off-spin +0.3, RA medium -0.4, wrist-spin -0.4 |
| M Chinnaswamy Stadium | LA orthodox +3.7 ±3.2 | off-spin -4.3 ±3.4 | RA fast-medium +2.5, RA fast +1.1, wrist-spin +0.7, RA medium +0.6, LA pace -1.7 |
| MA Chidambaram Stadium (Chepauk) | wrist-spin +5.8 ±3.1 | RA medium -1.5 ±2.9 | RA fast +3.3, LA orthodox +2.3, RA fast-medium +0.5, off-spin -0.1, LA pace -1.1 |
| Eden Gardens | off-spin +1.3 ±2.7 | RA medium -1.9 ±2.8 | RA fast-medium +1.2, wrist-spin +0.8, LA orthodox +0.4, RA fast -1.2, LA pace -1.6 |
| Arun Jaitley Stadium (Feroz Shah Kotla) | LA orthodox +5.9 ±2.7 * | RA medium -5.2 ±2.7 | wrist-spin +3.0, RA fast-medium +3.0, off-spin -2.3, RA fast -2.4, LA pace -3.2 |
| Rajiv Gandhi International Stadium | RA medium +4.6 ±2.9 | wrist-spin -4.4 ±3.0 | LA pace +1.9, RA fast +1.0, RA fast-medium +0.5, LA orthodox -2.4, off-spin -3.5 |
| Sawai Mansingh Stadium | LA pace +1.2 ±3.4 | RA fast -2.3 ±3.3 | wrist-spin +0.2, off-spin +0.2, LA orthodox +0.1, RA fast-medium -0.1, RA medium -1.7 |
| Punjab Cricket Association IS Bindra Stadium | RA medium +2.4 ±3.2 | LA pace -2.9 ±3.4 | RA fast +1.9, RA fast-medium +1.4, LA orthodox -0.6, off-spin -0.9, wrist-spin -2.8 |
| Narendra Modi Stadium (Motera) | RA fast +5.0 ±3.4 | wrist-spin -5.6 ±3.2 | RA medium +3.2, RA fast-medium +2.3, LA pace -0.2, LA orthodox -1.5 |
| Maharashtra Cricket Association Stadium | RA fast-medium +2.7 ±3.2 | LA pace -1.0 ±3.7 | RA medium +1.2, RA fast -0.7 |
| Dubai International Cricket Stadium | RA fast +4.7 ±2.5 | RA medium -4.0 ±2.6 | wrist-spin +2.7, LA orthodox +0.7, off-spin +0.5, LA pace -0.2, RA fast-medium -2.9 |
| Sheikh Zayed Stadium | RA fast-medium +3.9 ±2.1 | LA orthodox -3.7 ±2.6 | wrist-spin +2.4, RA fast +0.9, RA medium -0.4, LA pace -0.5, off-spin -2.6 |
| Sharjah Cricket Stadium | RA medium +3.6 ±3.4 | off-spin -4.4 ±3.0 | wrist-spin +2.6, RA fast +1.2, RA fast-medium +1.1, LA pace -0.7, LA orthodox -0.7 |

**Test grounds (Tests + other first-class at the ground, men)**

| ground | pick | avoid | others |
|---|---|---|---|
| Lord's | RA fast-medium +1.9 ±1.0 | RA medium -2.1 ±2.0 | wrist-spin +0.4, LA pace +0.4, RA fast -0.4, LA orthodox -0.8, off-spin -2.0 |
| The Oval | RA medium +1.3 ±2.2 | RA fast -1.1 ±1.9 | RA fast-medium +0.6, LA pace +0.2, LA orthodox +0.1, off-spin -0.4, wrist-spin -0.5 |
| Old Trafford | wrist-spin +2.7 ±2.2 | off-spin -3.3 ±1.8 | LA orthodox +1.7, RA fast-medium +0.8, RA medium +0.7, RA fast +0.1, LA pace -1.1 |
| Headingley | LA pace +3.1 ±2.6 | RA fast -1.6 ±2.2 | wrist-spin +1.3, RA medium +0.5, RA fast-medium +0.3, off-spin -0.7, LA orthodox -1.2 |
| Edgbaston | RA fast +2.1 ±2.5 | RA medium -2.6 ±2.1 | LA pace +1.7, RA fast-medium +0.3, off-spin -0.0, wrist-spin -0.2, LA orthodox -2.1 |
| Trent Bridge | RA fast-medium +1.9 ±1.1 | LA orthodox -3.2 ±1.6 | RA medium -0.3, LA pace -0.6, RA fast -1.0, wrist-spin -1.2, off-spin -2.0 |
| The Rose Bowl | LA orthodox +1.4 ±1.7 | RA medium -1.9 ±1.9 | off-spin +0.2, wrist-spin +0.1, RA fast-medium -0.1, LA pace -0.2, RA fast -0.3 |
| Melbourne Cricket Ground | RA fast-medium +3.1 ±1.6 | LA orthodox -3.3 ±1.9 | LA pace +0.9, RA fast +0.6, wrist-spin -1.1, off-spin -2.4 |
| Sydney Cricket Ground | RA fast-medium +2.8 ±1.7 | LA pace -2.2 ±2.3 | RA medium +0.8, LA orthodox +0.5, RA fast -1.3, wrist-spin -1.3, off-spin -1.6 |
| Adelaide Oval | LA pace +3.4 ±2.5 | wrist-spin -2.4 ±2.2 | RA fast +1.5, RA fast-medium +0.9, RA medium +0.6, off-spin -1.4, LA orthodox -2.3 |
| The Gabba | RA fast +3.0 ±2.6 | wrist-spin -1.7 ±2.2 | RA fast-medium +1.0, LA pace +0.9, RA medium -0.8, off-spin -1.1 |
| WACA Ground | LA pace +1.7 ±2.4 | off-spin -1.9 ±2.1 | RA fast +1.3, RA fast-medium +1.0, RA medium -0.6, LA orthodox -0.7 |
| Bellerive Oval | LA pace +2.1 ±2.6 | RA medium -0.9 ±2.5 | RA fast +1.0, off-spin -0.0, RA fast-medium -0.1 |
| Newlands | RA fast +0.9 ±2.2 | RA fast-medium -1.2 ±1.9 | LA pace +0.1, off-spin -0.2, LA orthodox -0.2 |
| Wanderers Stadium | RA fast +2.4 ±2.6 | LA pace -0.2 ±2.8 | RA fast-medium +2.0 |
| Kingsmead | RA fast +0.5 ±2.4 | RA fast-medium -1.4 ±2.2 | LA orthodox -0.3, off-spin -0.7 |
| SuperSport Park | RA fast +3.0 ±2.7 | RA fast-medium -0.4 ±2.2 | LA pace +0.3 |
| St George's Park | LA orthodox +0.5 ±2.6 | RA fast -0.7 ±2.7 | RA fast-medium -0.3 |
| Basin Reserve | RA medium +2.8 ±2.3 | LA pace -2.3 ±2.1 | RA fast-medium +2.6, LA orthodox +0.5, wrist-spin +0.3, off-spin -0.9, RA fast -2.2 |
| Hagley Oval | RA fast-medium +1.7 ±1.6 | off-spin -1.9 ±2.0 | RA medium +1.2, RA fast -0.4, LA pace -1.3, LA orthodox -1.4, wrist-spin -1.7 |
| Seddon Park | RA fast +2.0 ±2.7 | off-spin -2.7 ±2.1 | RA medium +1.3, RA fast-medium +1.3, LA pace +0.4, LA orthodox +0.3, wrist-spin -1.7 |
| Bay Oval | LA pace +1.5 ±2.7 | RA medium -1.2 ±2.5 | LA orthodox +1.1, RA fast-medium +0.2, off-spin +0.1 |
| Galle International Stadium | LA pace +1.7 ±2.6 | wrist-spin -0.9 ±2.5 | LA orthodox +1.7, off-spin +0.4, RA fast-medium -0.2, RA fast -0.5 |
| Sinhalese Sports Club Ground | LA orthodox +1.6 ±2.1 | RA fast-medium -1.7 ±2.0 | off-spin -0.8, LA pace -1.2 |
| Pallekele International Stadium | LA orthodox +1.0 ±2.7 | off-spin -0.9 ±2.2 | RA fast-medium +0.0 |
| Shere Bangla National Stadium | off-spin +0.9 ±2.1 | RA fast-medium -0.0 ±2.0 | LA orthodox +0.3, RA fast +0.2 |
| Zahur Ahmed Chowdhury Stadium | off-spin +0.7 ±2.0 | LA orthodox -0.7 ±1.9 | RA fast-medium -0.1 |
| Rawalpindi Cricket Stadium | RA fast-medium +1.9 ±2.5 | off-spin -0.8 ±2.4 | LA orthodox +0.9 |
| Kensington Oval | RA fast-medium +2.9 ±2.4 | LA orthodox -0.4 ±2.2 | RA fast +1.6, off-spin -0.0 |
| Queen's Park Oval | off-spin +0.6 ±2.3 | RA fast-medium -1.4 ±2.3 | LA orthodox +0.4, RA fast +0.3 |
| Sabina Park | RA fast +3.0 ±2.7 | off-spin -1.1 ±2.5 | RA fast-medium +2.9 |
| Harare Sports Club | RA fast-medium +1.2 ±2.0 | off-spin -1.1 ±2.5 | LA pace +1.0, LA orthodox -0.9 |
| Queens Sports Club | LA orthodox +2.8 ±2.4 | off-spin -2.2 ±2.1 | RA fast-medium +0.1, wrist-spin -1.9 |
| Dubai International Cricket Stadium | wrist-spin +2.0 ±2.5 | RA fast-medium -0.9 ±2.1 | LA pace +0.1, off-spin +0.0, LA orthodox -0.1 |
| Sheikh Zayed Stadium | LA orthodox +1.2 ±2.3 | off-spin -1.3 ±1.9 | LA pace +0.5, wrist-spin +0.2, RA fast-medium -0.3 |

**ODI grounds (List A men)**

| ground | pick | avoid | others |
|---|---|---|---|
| Lord's | LA pace +2.6 ±2.9 | wrist-spin -2.4 ±2.8 | RA fast +2.6, off-spin +1.5, LA orthodox -0.6, RA fast-medium -0.7, RA medium -1.3 |
| The Oval | LA pace +2.3 ±2.9 | LA orthodox -2.7 ±2.5 | off-spin +2.0, RA fast-medium -0.0, RA fast -0.3, wrist-spin -1.1, RA medium -1.8 |
| Old Trafford | off-spin +2.7 ±2.6 | RA fast -1.0 ±3.1 | wrist-spin +2.0, LA pace +1.3, LA orthodox +0.5, RA fast-medium -0.8 |
| Headingley | off-spin +1.8 ±2.6 | RA fast-medium -3.4 ±2.3 | wrist-spin -0.4, RA fast -2.2 |
| Edgbaston | RA fast-medium +2.4 ±2.1 | LA pace -3.7 ±2.9 | RA fast +0.8, off-spin +0.2, RA medium +0.2, wrist-spin -0.2, LA orthodox -1.4 |
| Trent Bridge | RA fast-medium +3.0 ±2.2 | off-spin -1.1 ±2.8 | RA medium +1.0, RA fast +0.8, LA orthodox -0.9 |
| The Rose Bowl | RA fast +3.5 ±3.1 | RA medium -2.5 ±2.5 | wrist-spin +2.3, LA pace +0.2, RA fast-medium -0.2, off-spin -0.6, LA orthodox -1.7 |
| Melbourne Cricket Ground | LA pace +3.8 ±2.9 | off-spin -2.0 ±2.4 | RA fast-medium +0.8, RA fast -0.8 |
| Sydney Cricket Ground | RA fast-medium +0.8 ±2.5 | LA pace -2.1 ±2.8 | RA fast +0.4, off-spin -0.4 |
| Adelaide Oval | RA fast +1.8 ±2.9 | off-spin -1.7 ±2.3 | LA pace +1.1, RA fast-medium +1.1 |
| WACA Ground | RA fast +3.6 ±3.0 | off-spin -2.4 ±2.9 | LA pace +1.4, RA fast-medium +1.0, RA medium +1.0 |
| Wanderers Stadium | RA fast-medium +2.8 ±2.6 | RA fast -2.9 ±2.9 | LA pace +1.7, off-spin +0.2 |
| SuperSport Park | RA fast +3.0 ±2.9 | LA pace -2.2 ±3.1 | RA fast-medium +0.8, off-spin -1.4 |
| Narendra Modi Stadium (Motera) | RA fast-medium +0.4 ±2.9 | RA fast -1.2 ±3.1 | off-spin -0.7 |
| R Premadasa Stadium | LA orthodox +3.5 ±2.4 | off-spin -2.1 ±1.9 | wrist-spin +2.5, RA medium +0.5, RA fast-medium -0.0, RA fast -0.7, LA pace -1.1 |
| Pallekele International Stadium | off-spin +4.7 ±2.4 | RA fast-medium -1.2 ±2.7 | LA orthodox +0.6, RA fast -0.4 |
| Shere Bangla National Stadium | LA pace +1.5 ±2.5 | wrist-spin -1.9 ±2.6 | RA fast +1.5, LA orthodox +0.2, RA fast-medium +0.2, off-spin -0.3, RA medium -1.2 |
| Zahur Ahmed Chowdhury Stadium | LA orthodox +2.8 ±2.9 | RA fast-medium -0.8 ±2.7 | off-spin +0.5 |
| Kensington Oval | RA fast-medium +2.5 ±2.7 | RA fast -3.1 ±3.0 | LA orthodox +0.2 |
| Providence Stadium | LA orthodox +2.8 ±2.8 | off-spin -0.7 ±2.6 | RA fast-medium +0.5 |
| Harare Sports Club | LA pace +2.3 ±2.5 | wrist-spin -2.5 ±2.6 | RA fast +1.3, RA fast-medium +0.3, off-spin +0.1, RA medium -0.4, LA orthodox -1.7 |
| Queens Sports Club | wrist-spin +3.6 ±3.1 | LA orthodox -2.4 ±2.3 | RA medium +1.1, off-spin +0.1, RA fast-medium -0.0, LA pace -0.7 |
| Dubai International Cricket Stadium | RA fast +2.3 ±3.0 | RA medium -2.3 ±2.6 | LA orthodox +1.4, wrist-spin +0.8, RA fast-medium -0.0, off-spin -0.0, LA pace -0.2 |
| Sheikh Zayed Stadium | off-spin +2.7 ±2.2 | wrist-spin -1.7 ±2.5 | LA pace +1.7, LA orthodox -0.4, RA fast-medium -0.7 |
| Sharjah Cricket Stadium | off-spin +1.5 ±2.7 | LA pace -2.2 ±2.9 | RA fast-medium +0.8, LA orthodox -1.8 |

### Phase splits: which types gain where, by phase (country level, men)

**T20**: biggest gains: LA pace in ENG, powerplay (1-6) (+5.3 ±1.2); LA pace in IND, powerplay (1-6) (+4.1 ±1.2); LA pace in PAK, powerplay (1-6) (+3.7 ±1.8); RA fast-medium in AUS, powerplay (1-6) (+3.7 ±1.3); LA pace in AUS, powerplay (1-6) (+3.6 ±1.6); LA orthodox in IND, middle (7-15) (+3.4 ±0.9)
; biggest losses: RA fast-medium in IND, death (16-20) (-3.9 ±1.5); RA fast-medium in RSA, death (16-20) (-4.3 ±1.8); RA fast-medium in AUS, death (16-20) (-4.8 ±1.6); RA fast-medium in UAE, death (16-20) (-4.9 ±1.9); RA fast-medium in BDESH, death (16-20) (-4.9 ±1.9); RA medium in IND, death (16-20) (-6.2 ±1.5)

**ListA**: biggest gains: LA pace in IND, overs 1-10 (+3.0 ±1.6); RA fast-medium in ENG, overs 11-40 (+2.2 ±0.7); RA fast-medium in SL, overs 1-10 (+2.2 ±1.4); RA fast-medium in NZ, overs 1-10 (+2.1 ±1.5); RA medium in AUS, overs 11-40 (+2.0 ±1.4); RA fast-medium in AUS, overs 1-10 (+1.9 ±1.3)
; biggest losses: LA orthodox in ZIM, overs 11-40 (-1.0 ±1.2); LA pace in ENG, overs 41-50 (-1.2 ±2.0); off-spin in RSA, overs 11-40 (-1.5 ±1.2); RA fast-medium in AUS, overs 41-50 (-1.6 ±2.0); off-spin in AUS, overs 11-40 (-1.8 ±1.1); RA fast-medium in ENG, overs 41-50 (-5.2 ±1.5)

**FC**: biggest gains: RA fast-medium in ENG, middle (21-80) (+2.5 ±0.4); RA fast-medium in AUS, middle (21-80) (+2.4 ±0.8); LA pace in AUS, middle (21-80) (+2.3 ±1.2); RA fast-medium in NZ, middle (21-80) (+2.2 ±0.8); RA fast in RSA, middle (21-80) (+2.1 ±1.4); RA fast in AUS, middle (21-80) (+2.0 ±1.2)
; biggest losses: LA orthodox in ENG, old/2nd new ball (81+) (-1.7 ±1.1); off-spin in AUS, middle (21-80) (-1.8 ±0.9); RA fast-medium in NZ, old/2nd new ball (81+) (-2.0 ±1.2); wrist-spin in AUS, middle (21-80) (-2.3 ±1.1); RA fast-medium in ENG, old/2nd new ball (81+) (-2.4 ±0.7); off-spin in ENG, old/2nd new ball (81+) (-3.4 ±1.1)

### Matchups: bowler type vs batter hand

Overall (after batter and bowler quality), edge per 100 balls for the bowler:

| format | type | vs RHB | vs LHB | LHB minus RHB |
|---|---|---|---|---|
| T20 | RA fast | -0.3 | +1.9 | +2.1 |
| T20 | RA fast-medium | +0.1 | -1.6 | -1.7 |
| T20 | RA medium | -1.5 | -4.3 | -2.9 |
| T20 | LA pace | -0.5 | +2.2 | +2.7 |
| T20 | off-spin | -3.2 | +5.9 | +9.1 |
| T20 | wrist-spin | +1.6 | -2.0 | -3.5 |
| T20 | LA orthodox | +5.1 | -10.8 | -15.9 |
| ListA | RA fast | +2.1 | -0.5 | -2.7 |
| ListA | RA fast-medium | +1.2 | -2.0 | -3.2 |
| ListA | RA medium | -0.8 | -2.5 | -1.7 |
| ListA | LA pace | +0.7 | +2.4 | +1.7 |
| ListA | off-spin | -3.8 | +3.7 | +7.4 |
| ListA | wrist-spin | -0.2 | -2.0 | -1.8 |
| ListA | LA orthodox | +2.1 | -5.8 | -7.9 |
| FC | RA fast | +1.8 | -0.3 | -2.1 |
| FC | RA fast-medium | +2.5 | -2.6 | -5.2 |
| FC | RA medium | -0.1 | -1.5 | -1.5 |
| FC | LA pace | -0.6 | +1.5 | +2.1 |
| FC | off-spin | -5.3 | +4.1 | +9.4 |
| FC | wrist-spin | -0.9 | -3.0 | -2.1 |
| FC | LA orthodox | +1.3 | -5.0 | -6.3 |

Strongest ground-specific matchups (largest edge relative to its SE, men):

| format | ground | type | vs | edge/100 | SE | balls |
|---|---|---|---|---|---|---|
| T20 | Shere Bangla National Stadium | LA orthodox | RHB | +6.0 | 1.7 | 9207 |
| T20 | Shere Bangla National Stadium | LA orthodox | LHB | -8.4 | 2.5 | 3499 |
| FC | County Ground, Taunton | RA fast-medium | LHB | -3.8 | 1.4 | 21273 |
| FC | County Ground, Taunton | LA orthodox | RHB | +4.0 | 1.6 | 15788 |
| FC | Lord's | RA fast-medium | RHB | +3.0 | 1.2 | 65282 |
| T20 | Arun Jaitley Stadium (Feroz Shah Kotla) | LA orthodox | RHB | +5.8 | 2.3 | 2805 |
| T20 | Al Amerat Cricket Ground | LA orthodox | RHB | +4.8 | 2.0 | 5650 |
| ListA | Shere Bangla National Stadium | off-spin | RHB | -3.7 | 1.6 | 6812 |
| T20 | Wanderers Stadium | LA orthodox | RHB | +5.4 | 2.5 | 2110 |
| ListA | Shere Bangla National Stadium | off-spin | LHB | +3.8 | 1.7 | 5775 |
| FC | County Ground, Hove | RA fast-medium | LHB | -3.0 | 1.4 | 20473 |
| T20 | R Premadasa Stadium | LA orthodox | RHB | +5.2 | 2.5 | 2210 |
| FC | New Road | RA fast-medium | RHB | +2.8 | 1.3 | 45478 |
| T20 | Sylhet Stadium | off-spin | RHB | -5.1 | 2.6 | 2152 |
| FC | Galle International Stadium | LA orthodox | RHB | +2.9 | 1.5 | 16501 |

## 7. Phase profiles

### IPL grounds, T20 men (runs per 100 balls vs average, by phase)

| ground | balls | run factor | six factor | powerplay (1-6) | middle (7-15) | death (16-20) |
|---|---|---|---|---|---|---|
| Brabourne Stadium | 6766 | 104.4 | 97.0 | +7.2 | +5.3 | +8.0 |
| Punjab Cricket Association IS Bindra Stadium | 17624 | 103.4 | 91.0 | +4.3 | +4.4 | +6.0 |
| Wankhede Stadium | 43013 | 103.0 | 107.6 | -0.5 | +3.5 | +11.2 |
| M Chinnaswamy Stadium | 27528 | 102.7 | 120.1 | -2.9 | +4.5 | +11.3 |
| HPCA Stadium | 6455 | 102.4 | 109.7 | -2.1 | +2.9 | +12.5 |
| Eden Gardens | 34860 | 101.7 | 103.7 | -1.0 | +2.6 | +6.7 |
| Arun Jaitley Stadium (Feroz Shah Kotla) | 34152 | 101.0 | 106.6 | +0.8 | +0.1 | +4.7 |
| Narendra Modi Stadium (Motera) | 17387 | 100.6 | 102.6 | -2.9 | +2.5 | +3.3 |
| Dubai International Cricket Stadium | 61816 | 99.9 | 94.4 | -1.4 | -1.0 | +3.5 |
| Sharjah Cricket Stadium | 29382 | 99.2 | 105.3 | -2.8 | -0.6 | +0.7 |
| Sheikh Zayed Stadium | 41920 | 98.8 | 83.6 | -4.0 | -1.0 | +0.9 |
| Rajiv Gandhi International Stadium | 22410 | 98.8 | 95.3 | -1.6 | -3.3 | +1.3 |
| Barsapara Cricket Stadium | 5109 | 98.5 | 90.5 | -1.9 | -4.1 | -0.0 |
| Maharaja Yadavindra Singh Stadium | 4300 | 98.1 | 98.9 | -2.2 | -5.0 | -2.0 |
| Sawai Mansingh Stadium | 21290 | 97.6 | 81.6 | -5.6 | -3.0 | -0.5 |
| DY Patil Stadium | 8898 | 97.4 | 100.8 | -5.0 | -3.6 | -2.1 |
| Maharashtra Cricket Association Stadium | 13433 | 97.4 | 101.7 | -6.8 | -4.7 | +2.1 |
| MA Chidambaram Stadium (Chepauk) | 25744 | 96.6 | 89.9 | -2.4 | -7.0 | -3.4 |
| Ekana Cricket Stadium | 9523 | 94.2 | 81.5 | -12.6 | -7.5 | -7.3 |

### ODI grounds, List A men (runs per 100 balls vs average; overs 1-10 / 11-40 / 41-50)

| ground | balls | run factor | six factor | overs 1-10 | overs 11-40 | overs 41-50 |
|---|---|---|---|---|---|---|
| M Chinnaswamy Stadium | 8976 | 107.1 | 126.0 | +8.2 | +7.6 | +7.0 |
| Sinhalese Sports Club Ground | 7986 | 105.0 | 116.0 | +4.5 | +3.7 | +6.0 |
| Wankhede Stadium | 7669 | 104.1 | 120.2 | -1.6 | +5.2 | +9.4 |
| Trent Bridge | 28477 | 104.1 | 121.0 | +2.7 | +3.7 | +7.4 |
| Bellerive Oval | 15601 | 103.7 | 108.8 | +4.0 | +3.9 | +2.8 |
| SuperSport Park | 19478 | 103.1 | 115.1 | +1.1 | +3.5 | +4.0 |
| Sydney Cricket Ground | 21935 | 102.5 | 102.4 | +1.8 | +1.2 | +6.5 |
| Wanderers Stadium | 17011 | 101.9 | 110.3 | -0.1 | +1.6 | +6.1 |
| Seddon Park | 14995 | 101.4 | 105.4 | +0.6 | +1.7 | +1.6 |
| Gaddafi Stadium | 16107 | 101.3 | 100.2 | -1.2 | +2.2 | +2.4 |
| The Oval | 40560 | 101.2 | 108.3 | -1.4 | +1.8 | +3.0 |
| Queens Sports Club | 26026 | 100.9 | 94.8 | +0.8 | +0.1 | +2.8 |
| National Stadium, Karachi | 10663 | 100.8 | 108.8 | -0.7 | +0.8 | +3.0 |
| Queen's Park Oval | 13494 | 100.5 | 101.8 | -1.6 | +0.7 | +2.5 |
| The Rose Bowl | 38272 | 100.3 | 83.1 | -0.5 | +0.7 | -0.1 |
| Edgbaston | 32982 | 100.3 | 105.3 | +0.9 | -0.2 | +0.9 |
| Harare Sports Club | 57636 | 100.1 | 95.9 | -2.3 | +0.9 | +0.9 |
| Pallekele International Stadium | 19243 | 100.1 | 100.3 | -0.5 | +0.0 | +1.0 |
| Bay Oval | 7287 | 100.0 | 98.0 | -1.8 | +1.0 | +0.1 |
| Headingley | 20550 | 99.9 | 101.6 | +1.5 | -1.2 | +1.3 |
| Kensington Oval | 15903 | 99.8 | 93.2 | -1.9 | +1.0 | -1.1 |
| Shere Bangla National Stadium | 61741 | 99.7 | 98.1 | -2.1 | -0.2 | +2.2 |
| R Premadasa Stadium | 44002 | 99.1 | 93.4 | -2.7 | -0.4 | +0.7 |
| Sheikh Zayed Stadium | 26984 | 99.1 | 78.3 | -2.6 | -0.1 | -0.5 |
| Eden Park | 14309 | 99.1 | 115.3 | -3.2 | -1.1 | +2.6 |
| The Gabba | 15899 | 98.7 | 82.4 | -3.4 | -1.4 | +2.0 |
| Old Trafford | 26150 | 98.7 | 92.6 | -1.2 | -1.8 | +0.5 |
| Narendra Modi Stadium (Motera) | 11534 | 98.6 | 87.8 | -3.7 | -0.6 | -0.1 |
| Hagley Oval | 8758 | 98.6 | 88.6 | -1.1 | -1.6 | -1.8 |
| Multan Cricket Stadium | 4852 | 98.5 | 102.3 | -3.3 | -1.1 | +0.2 |
| Dubai International Cricket Stadium | 33769 | 98.5 | 86.2 | -2.4 | -1.6 | +1.6 |
| Zahur Ahmed Chowdhury Stadium | 10655 | 98.4 | 96.6 | -3.2 | -0.5 | -1.8 |
| Rawalpindi Cricket Stadium | 8804 | 98.1 | 99.4 | -1.8 | -2.0 | -1.8 |
| Kingsmead | 11342 | 97.7 | 85.2 | -1.5 | -3.0 | -1.1 |
| Sabina Park | 12872 | 97.2 | 100.8 | -4.5 | -2.1 | -1.3 |
| WACA Ground | 24595 | 97.1 | 99.9 | -5.5 | -2.3 | -0.0 |
| Newlands | 11284 | 96.7 | 92.8 | -4.2 | -3.8 | -0.7 |
| Melbourne Cricket Ground | 20059 | 96.5 | 72.4 | -5.3 | -1.7 | -4.8 |
| Arun Jaitley Stadium (Feroz Shah Kotla) | 8730 | 96.5 | 102.2 | -3.9 | -3.1 | -3.5 |
| Providence Stadium | 14777 | 96.4 | 80.5 | -4.0 | -2.6 | -3.1 |
| Adelaide Oval | 22979 | 96.3 | 89.0 | -4.5 | -2.8 | -3.8 |
| Eden Gardens | 8464 | 96.0 | 87.6 | -3.9 | -5.4 | -2.3 |
| MA Chidambaram Stadium (Chepauk) | 9171 | 95.8 | 95.3 | -5.1 | -3.1 | -5.6 |
| St George's Park | 11393 | 95.3 | 84.6 | -7.0 | -3.6 | -3.1 |
| Lord's | 32605 | 94.9 | 89.6 | -6.2 | -5.0 | -2.5 |

### Test and first-class matches day by day (approximate days, 90 overs each; men)

Runs and wickets per 100 balls vs the innings-phase expectation, after batter and bowler quality. Later days are a selected sample (only matches still going), which is why domestic day 4 looks flat: those are mostly drifting draws.

| scope | day | balls | runs/100 vs expected | wkts/100 vs expected |
|---|---|---|---|---|
| Test | 1 | 467128 | -0.97 | +0.014 |
| Test | 2 | 461075 | +0.24 | +0.013 |
| Test | 3 | 400928 | -0.10 | +0.009 |
| Test | 4 | 247870 | +0.65 | +0.023 |
| Test | 5 | 71022 | -0.14 | +0.028 |
| domestic | 1 | 1216636 | -0.17 | +0.029 |
| domestic | 2 | 1181683 | +0.53 | +0.016 |
| domestic | 3 | 959305 | +0.43 | +0.002 |
| domestic | 4 | 437800 | -1.22 | -0.124 |
| domestic | 5 | 17382 | +0.24 | -0.022 |

Per-ground day profile (runs/100 vs average on days 1, 4, 5; most deteriorating first):

| ground | balls | day 1 | day 4 | day 5 | day 4 - day 1 runs | day 4 - day 1 wkts |
|---|---|---|---|---|---|---|
| The Rose Bowl | 150647 | +0.0 | -3.2 | +0.2 | -3.3 | +0.01 |
| Headingley | 137039 | +2.3 | +0.2 | +2.3 | -2.1 | +0.01 |
| Trent Bridge | 188171 | +3.6 | +1.9 | +3.5 | -1.7 | -0.05 |
| Bay Oval | 42571 | +0.4 | -0.3 | -0.4 | -0.7 | -0.06 |
| Old Trafford | 147284 | -1.4 | -2.0 | -2.2 | -0.6 | -0.01 |
| Newlands | 49278 | +0.8 | +0.2 | +0.2 | -0.6 | -0.02 |
| Adelaide Oval | 93196 | -0.4 | -0.8 | -0.6 | -0.5 | +0.00 |
| Pallekele International Stadium | 20849 | +1.1 | +0.6 | +0.9 | -0.5 | -0.04 |
| SuperSport Park | 33213 | +1.7 | +1.4 | +1.3 | -0.4 | +0.08 |
| Bellerive Oval | 72939 | +2.6 | +2.2 | +3.5 | -0.3 | -0.05 |
| Queens Sports Club | 28707 | +0.3 | +0.1 | +0.2 | -0.2 | -0.00 |
| Dubai International Cricket Stadium | 31264 | -0.3 | -0.5 | -0.4 | -0.2 | -0.03 |
| Hagley Oval | 82640 | +0.6 | +0.5 | +0.5 | -0.1 | -0.10 |
| Kensington Oval | 27348 | +1.3 | +1.4 | +1.8 | +0.0 | -0.05 |
| Sinhalese Sports Club Ground | 46804 | +1.3 | +1.3 | +1.7 | +0.0 | -0.04 |
| Edgbaston | 178687 | +1.7 | +1.7 | +2.2 | +0.0 | -0.17 |
| Sheikh Zayed Stadium | 29893 | +2.3 | +2.3 | +1.8 | +0.0 | -0.00 |
| Lord's | 199017 | +0.5 | +0.6 | +0.0 | +0.1 | -0.02 |
| Sabina Park | 26145 | -0.8 | -0.6 | -0.1 | +0.2 | +0.08 |
| Shere Bangla National Stadium | 51195 | +0.6 | +0.8 | +1.5 | +0.2 | +0.02 |
| Zahur Ahmed Chowdhury Stadium | 37870 | +0.5 | +0.9 | +0.5 | +0.4 | +0.02 |
| Seddon Park | 78401 | +1.5 | +2.0 | +1.3 | +0.5 | -0.02 |
| Kingsmead | 27821 | -0.2 | +0.4 | +0.7 | +0.6 | -0.02 |
| The Gabba | 78660 | -0.1 | +0.5 | +0.9 | +0.6 | -0.00 |
| Harare Sports Club | 30661 | +0.3 | +0.9 | +0.4 | +0.6 | +0.01 |

## 8. Bat first or chase? The toss

Chase advantage = P(chasing side wins) - 50% for two equal teams at a neutral ground. Toss value = P(toss winner wins) - 50% after strength.

| format | gender | scope | era | matches | chase advantage | toss value | captains choose to field |
|---|---|---|---|---|---|---|---|
| T20 | male | all | all | 16830 | +2.3% ±0.4 | +1.0% | 57% |
| T20 | male | all | 2000-07 | 710 | +1.7% ±1.9 | +3.1% | 43% |
| T20 | male | all | 2008-13 | 2970 | +0.1% ±0.9 | +0.0% | 45% |
| T20 | male | all | 2014-19 | 4293 | +3.3% ±0.8 | +1.2% | 61% |
| T20 | male | all | 2020-23 | 4349 | +1.8% ±0.8 | +0.0% | 59% |
| T20 | male | all | 2024-26 | 4508 | +3.5% ±0.8 | +2.1% | 63% |
| T20 | male | T20I | all | 4072 | +1.5% ±0.9 | +0.5% | 53% |
| T20 | male | T20I | 2008-13 | 288 | -2.4% ±3.1 | +0.2% | 43% |
| T20 | male | T20I | 2014-19 | 648 | +0.4% ±2.1 | -0.1% | 55% |
| T20 | male | T20I | 2020-23 | 1349 | +2.9% ±1.5 | -0.2% | 52% |
| T20 | male | T20I | 2024-26 | 1740 | +1.8% ±1.4 | +0.8% | 55% |
| T20 | male | domestic | all | 12758 | +2.5% ±0.4 | +1.1% | 59% |
| T20 | male | domestic | 2000-07 | 663 | +1.5% ±2.0 | +2.6% | 42% |
| T20 | male | domestic | 2008-13 | 2682 | +0.2% ±1.0 | -0.0% | 45% |
| T20 | male | domestic | 2014-19 | 3645 | +3.7% ±0.8 | +1.4% | 62% |
| T20 | male | domestic | 2020-23 | 3000 | +1.5% ±0.9 | +0.1% | 62% |
| T20 | male | domestic | 2024-26 | 2768 | +4.5% ±1.0 | +2.6% | 68% |
| T20 | female | all | all | 9367 | +2.3% ±0.6 | +0.3% | 48% |
| T20 | female | all | 2008-13 | 1261 | +1.5% ±1.6 | -1.7% | 37% |
| T20 | female | all | 2014-19 | 2693 | +3.5% ±1.0 | +0.3% | 46% |
| T20 | female | all | 2020-23 | 2395 | +2.6% ±1.1 | +0.6% | 53% |
| T20 | female | all | 2024-26 | 2992 | +1.4% ±1.0 | +0.8% | 52% |
| T20 | female | T20I | all | 2979 | +2.5% ±1.1 | +1.2% | 50% |
| T20 | female | T20I | 2008-13 | 206 | +0.9% ±3.7 | +3.4% | 38% |
| T20 | female | T20I | 2014-19 | 590 | +3.9% ±2.3 | +2.3% | 51% |
| T20 | female | T20I | 2020-23 | 879 | +4.9% ±2.1 | -0.2% | 54% |
| T20 | female | T20I | 2024-26 | 1295 | +1.2% ±1.7 | +1.0% | 49% |
| T20 | female | domestic | all | 6388 | +2.3% ±0.7 | -0.2% | 48% |
| T20 | female | domestic | 2008-13 | 1055 | +1.8% ±1.8 | -3.0% | 37% |
| T20 | female | domestic | 2014-19 | 2103 | +3.4% ±1.2 | -0.4% | 45% |
| T20 | female | domestic | 2020-23 | 1516 | +1.7% ±1.4 | +1.1% | 52% |
| T20 | female | domestic | 2024-26 | 1697 | +1.7% ±1.3 | +0.4% | 55% |
| ListA | male | all | all | 19434 | +3.6% ±0.4 | +1.1% | 55% |
| ListA | male | all | 2000-07 | 5844 | +3.1% ±0.7 | +1.7% | 45% |
| ListA | male | all | 2008-13 | 4229 | +5.1% ±0.8 | +1.6% | 52% |
| ListA | male | all | 2014-19 | 4470 | +2.3% ±0.8 | +0.3% | 57% |
| ListA | male | all | 2020-23 | 2729 | +3.7% ±1.0 | +0.7% | 64% |
| ListA | male | all | 2024-26 | 2162 | +4.7% ±1.1 | +0.5% | 68% |
| ListA | male | ODI | all | 3363 | +2.6% ±1.0 | +0.9% | 48% |
| ListA | male | ODI | 2000-07 | 1084 | +1.9% ±1.7 | +1.6% | 40% |
| ListA | male | ODI | 2008-13 | 747 | +6.9% ±2.0 | +1.2% | 47% |
| ListA | male | ODI | 2014-19 | 739 | +0.5% ±2.1 | -2.0% | 49% |
| ListA | male | ODI | 2020-23 | 471 | +2.6% ±2.6 | +2.5% | 58% |
| ListA | male | ODI | 2024-26 | 322 | +0.5% ±2.9 | +1.5% | 63% |
| ListA | male | domestic | all | 16071 | +3.8% ±0.4 | +1.1% | 56% |
| ListA | male | domestic | 2000-07 | 4760 | +3.3% ±0.8 | +1.7% | 46% |
| ListA | male | domestic | 2008-13 | 3482 | +4.7% ±0.9 | +1.7% | 53% |
| ListA | male | domestic | 2014-19 | 3731 | +2.6% ±0.8 | +0.7% | 59% |
| ListA | male | domestic | 2020-23 | 2258 | +3.9% ±1.1 | +0.4% | 65% |
| ListA | male | domestic | 2024-26 | 1840 | +5.6% ±1.2 | +0.2% | 70% |
| ListA | female | all | all | 9529 | +2.0% ±0.6 | +0.2% | 47% |
| ListA | female | all | 2000-07 | 1558 | +0.5% ±1.4 | -0.0% | 42% |
| ListA | female | all | 2008-13 | 2485 | +0.7% ±1.2 | -1.1% | 41% |
| ListA | female | all | 2014-19 | 2398 | +2.8% ±1.2 | -0.2% | 49% |
| ListA | female | all | 2020-23 | 1387 | +1.8% ±1.5 | +0.1% | 53% |
| ListA | female | all | 2024-26 | 1701 | +3.9% ±1.4 | +2.2% | 52% |
| ListA | female | ODI | all | 1216 | +2.8% ±1.7 | -1.4% | 46% |
| ListA | female | ODI | 2000-07 | 305 | -3.3% ±3.3 | +1.6% | 42% |
| ListA | female | ODI | 2008-13 | 262 | +3.2% ±3.5 | -2.1% | 44% |
| ListA | female | ODI | 2014-19 | 276 | +6.2% ±3.8 | +1.8% | 37% |
| ListA | female | ODI | 2020-23 | 168 | +7.8% ±4.8 | -6.0% | 61% |
| ListA | female | ODI | 2024-26 | 205 | +3.3% ±4.4 | -6.9% | 55% |
| ListA | female | domestic | all | 8313 | +1.8% ±0.6 | +0.3% | 47% |
| ListA | female | domestic | 2000-07 | 1253 | +1.0% ±1.6 | -1.0% | 43% |
| ListA | female | domestic | 2008-13 | 2223 | +0.2% ±1.3 | -1.1% | 41% |
| ListA | female | domestic | 2014-19 | 2122 | +2.5% ±1.2 | -0.3% | 50% |
| ListA | female | domestic | 2020-23 | 1219 | +1.1% ±1.6 | +0.8% | 52% |
| ListA | female | domestic | 2024-26 | 1496 | +3.9% ±1.5 | +3.2% | 52% |

**T20 men by year**: 2008 +3% (field 46%), 2009 -1% (field 42%), 2010 -1% (field 44%), 2011 -2% (field 47%), 2012 +0% (field 39%), 2013 +1% (field 50%), 2014 +2% (field 60%), 2015 +1% (field 55%), 2016 +8% (field 66%), 2017 +2% (field 63%), 2018 +2% (field 62%), 2019 +4% (field 61%), 2020 +3% (field 57%), 2021 +2% (field 56%), 2022 +0% (field 59%), 2023 +3% (field 61%), 2024 +2% (field 62%), 2025 +4% (field 63%), 2026 +4% (field 64%)

**IPL by era**: 2008-13 +3.3% ±2.7 (n=363), 2014-19 +8.2% ±2.8 (n=350), 2020-23 +2.6% ±3.1 (n=262), 2024-26 +5.6% ±3.5 (n=213)

**Day vs day/night**: T20 male day +2.8% (n=12243); T20 male day/night +0.9% (n=4587); ListA female day +2.0% (n=9329); ListA female day/night +2.2% (n=200); T20 female day +2.4% (n=8920); T20 female day/night -0.1% (n=447); ListA male day +4.6% (n=16245); ListA male day/night -1.2% (n=3189)

**Were captains right?** Decision 'aligned' = chose to field where earlier seasons at that ground/competition favoured chasing, or to bat where they favoured batting first.

| format | gender | era | matches | share aligned | win-prob effect of aligning |
|---|---|---|---|---|---|
| ListA | female | 2000-07 | 1534 | 46% | -2.7% ±2.9 |
| ListA | female | 2008-13 | 2453 | 46% | +1.2% ±2.4 |
| ListA | female | 2014-19 | 2357 | 49% | +4.8% ±2.3 |
| ListA | female | 2020-23 | 1387 | 51% | +4.3% ±3.0 |
| ListA | female | 2024-26 | 1700 | 50% | +8.8% ±2.8 |
| ListA | female | all | 9431 | 48% | +3.5% ±1.2 |
| ListA | male | 2000-07 | 5840 | 51% | +5.3% ±1.4 |
| ListA | male | 2008-13 | 4228 | 52% | +7.5% ±1.6 |
| ListA | male | 2014-19 | 4464 | 56% | +2.7% ±1.6 |
| ListA | male | 2020-23 | 2729 | 63% | +5.1% ±2.1 |
| ListA | male | 2024-26 | 2079 | 66% | +8.2% ±2.4 |
| ListA | male | all | 19340 | 56% | +5.3% ±0.8 |
| T20 | female | 2008-13 | 1247 | 44% | -0.8% ±3.2 |
| T20 | female | 2014-19 | 2652 | 48% | +5.2% ±2.1 |
| T20 | female | 2020-23 | 2390 | 52% | +4.9% ±2.3 |
| T20 | female | 2024-26 | 2954 | 52% | +5.6% ±2.1 |
| T20 | female | all | 9268 | 50% | +4.4% ±1.1 |
| T20 | male | 2000-07 | 710 | 51% | +1.9% ±3.9 |
| T20 | male | 2008-13 | 2970 | 52% | +1.5% ±1.9 |
| T20 | male | 2014-19 | 4292 | 58% | +4.7% ±1.6 |
| T20 | male | 2020-23 | 4344 | 55% | +4.6% ±1.6 |
| T20 | male | 2024-26 | 4505 | 57% | +6.4% ±1.6 |
| T20 | male | all | 16821 | 55% | +4.4% ±0.8 |

**Grounds where batting first wins most (T20 men, >= 40 results)**: Lord's -7%, County Ground, Northampton -6%, Headingley -6%, Central Broward Regional Park -6%, Edgbaston -4%, Harare Sports Club -4%, Pallekele International Stadium -4%, Adelaide Oval -4%

**Grounds where chasing wins most**: Holkar Cricket Stadium +11%, Udayana Cricket Ground +10%, Saurashtra Cricket Association Stadium +9%, Daren Sammy Stadium +9%, Sylhet Stadium +9%, Al Amerat Cricket Ground +9%, County Ground, Bristol +8%, Sawai Mansingh Stadium +8%

### Tests and first-class: toss, bat first or bowl first, draws

Toss-winner outcomes are for two equal teams at a neutral ground (W/D/L %, from logistic fits on the strength gap).

| scope | gender | era | matches | draw rate | toss winners field | toss winner bats: W/D/L | toss winner fields: W/D/L | side batting first wins (of results) |
|---|---|---|---|---|---|---|---|---|
| Test | male | all | 1154 | 19% | 33% | W 41 / D 20 / L 39 (n=769) | W 42 / D 18 / L 40 (n=385) | 52% |
| Test | male | 2000-07 | 374 | 23% | 35% | W 31 / D 25 / L 44 (n=243) | W 45 / D 20 / L 36 (n=131) | 44% |
| Test | male | 2008-13 | 254 | 27% | 33% | W 37 / D 24 / L 39 (n=171) | W 30 / D 33 / L 36 (n=83) | 49% |
| Test | male | 2014-19 | 263 | 14% | 30% | W 58 / D 15 / L 27 (n=185) | W 37 / D 12 / L 51 (n=78) | 67% |
| Test | male | 2020-23 | 143 | 16% | 32% | W 29 / D 19 / L 52 (n=97) | W 61 / D 7 / L 32 (n=46) | 37% |
| Test | male | 2024-26 | 120 | 8% | 39% | W 51 / D 7 / L 41 (n=73) | W 46 / D 6 / L 48 (n=47) | 56% |
| Test | female | all | 43 | 42% | 42% | W 37 / D 38 / L 25 (n=25) | – | – |
| all | male | all | 18300 | 39% | 50% | W 28 / D 40 / L 32 (n=9163) | W 33 / D 38 / L 29 (n=9137) | 47% |
| all | male | 2000-07 | 5280 | 40% | 44% | W 27 / D 41 / L 32 (n=2982) | W 33 / D 39 / L 28 (n=2298) | 46% |
| all | male | 2008-13 | 4704 | 41% | 53% | W 26 / D 43 / L 31 (n=2200) | W 32 / D 39 / L 28 (n=2504) | 46% |
| all | male | 2014-19 | 4370 | 38% | 51% | W 30 / D 38 / L 31 (n=2150) | W 32 / D 38 / L 30 (n=2220) | 49% |
| all | male | 2020-23 | 1980 | 38% | 51% | W 27 / D 39 / L 34 (n=972) | W 35 / D 37 / L 27 (n=1008) | 44% |
| all | male | 2024-26 | 1966 | 35% | 56% | W 31 / D 35 / L 34 (n=859) | W 33 / D 34 / L 33 (n=1107) | 49% |
| all | female | all | 257 | 61% | 40% | W 18 / D 60 / L 22 (n=153) | W 22 / D 64 / L 14 (n=104) | 42% |
| all | female | 2008-13 | 143 | 66% | 46% | W 12 / D 64 / L 24 (n=77) | W 17 / D 67 / L 16 (n=66) | 35% |
| all | female | 2014-19 | 46 | 67% | 30% | W 15 / D 70 / L 15 (n=32) | – | – |

## 9. Geography

Home advantage = win-probability gain for the home side over an equal team on neutral ground (results only; FC draws excluded). Domestic 'home' = the team's home ground(s) that season.

| format | gender | scope | era | matches | home advantage |
|---|---|---|---|---|---|
| T20 | male | international | all | 2231 | +8.4% ±1.1 |
| T20 | male | international | 2008-13 | 150 | +2.7% ±4.3 |
| T20 | male | international | 2014-19 | 379 | +1.0% ±2.7 |
| T20 | male | international | 2020-23 | 714 | +12.1% ±2.0 |
| T20 | male | international | 2024-26 | 962 | +9.5% ±1.8 |
| T20 | male | domestic | all | 6148 | +2.5% ±0.7 |
| T20 | male | domestic | 2000-07 | 361 | +10.6% ±2.7 |
| T20 | male | domestic | 2008-13 | 1438 | +2.7% ±1.3 |
| T20 | male | domestic | 2014-19 | 1814 | +1.9% ±1.2 |
| T20 | male | domestic | 2020-23 | 1202 | +1.4% ±1.5 |
| T20 | male | domestic | 2024-26 | 1333 | +1.9% ±1.4 |
| T20 | female | international | all | 1658 | +5.3% ±1.4 |
| T20 | female | international | 2008-13 | 150 | +3.5% ±4.2 |
| T20 | female | international | 2014-19 | 335 | +1.5% ±3.0 |
| T20 | female | international | 2020-23 | 454 | +6.6% ±2.6 |
| T20 | female | international | 2024-26 | 711 | +7.7% ±2.2 |
| T20 | female | domestic | all | 2030 | -1.9% ±1.2 |
| T20 | female | domestic | 2008-13 | 286 | +7.3% ±3.5 |
| T20 | female | domestic | 2014-19 | 553 | -7.2% ±2.4 |
| T20 | female | domestic | 2020-23 | 522 | +0.2% ±2.4 |
| T20 | female | domestic | 2024-26 | 660 | -2.9% ±2.1 |
| ListA | male | international | all | 2461 | +9.9% ±1.1 |
| ListA | male | international | 2000-07 | 755 | +8.9% ±2.1 |
| ListA | male | international | 2008-13 | 590 | +6.3% ±2.2 |
| ListA | male | international | 2014-19 | 529 | +11.2% ±2.4 |
| ListA | male | international | 2020-23 | 339 | +13.6% ±3.1 |
| ListA | male | international | 2024-26 | 248 | +13.0% ±3.4 |
| ListA | male | domestic | all | 8779 | +3.2% ±0.5 |
| ListA | male | domestic | 2000-07 | 2904 | +4.1% ±1.0 |
| ListA | male | domestic | 2008-13 | 2091 | +4.6% ±1.1 |
| ListA | male | domestic | 2014-19 | 1820 | +0.7% ±1.2 |
| ListA | male | domestic | 2020-23 | 1169 | +3.7% ±1.5 |
| ListA | male | domestic | 2024-26 | 795 | +0.7% ±1.8 |
| ListA | female | international | all | 940 | +11.2% ±1.9 |
| ListA | female | international | 2000-07 | 229 | +14.8% ±4.0 |
| ListA | female | international | 2008-13 | 180 | +9.4% ±4.1 |
| ListA | female | international | 2014-19 | 219 | +13.4% ±4.3 |
| ListA | female | international | 2020-23 | 140 | +3.4% ±5.0 |
| ListA | female | international | 2024-26 | 172 | +10.7% ±4.7 |
| ListA | female | domestic | all | 3284 | +0.8% ±1.0 |
| ListA | female | domestic | 2000-07 | 425 | +2.1% ±2.8 |
| ListA | female | domestic | 2008-13 | 916 | +0.9% ±2.1 |
| ListA | female | domestic | 2014-19 | 856 | +1.2% ±1.9 |
| ListA | female | domestic | 2020-23 | 466 | -4.2% ±2.6 |
| ListA | female | domestic | 2024-26 | 621 | +3.0% ±2.2 |
| FC | male | international | all | 892 | +12.0% ±2.0 |
| FC | male | international | 2000-07 | 283 | +14.0% ±3.8 |
| FC | male | international | 2008-13 | 178 | +14.1% ±4.6 |
| FC | male | international | 2014-19 | 206 | +14.4% ±4.1 |
| FC | male | international | 2020-23 | 116 | +11.8% ±5.5 |
| FC | male | international | 2024-26 | 109 | +1.8% ±5.4 |
| FC | male | domestic | all | 6903 | +4.2% ±0.6 |
| FC | male | domestic | 2000-07 | 1914 | +5.8% ±1.2 |
| FC | male | domestic | 2008-13 | 1789 | +5.0% ±1.3 |
| FC | male | domestic | 2014-19 | 1666 | +1.4% ±1.3 |
| FC | male | domestic | 2020-23 | 779 | +6.6% ±1.9 |
| FC | male | domestic | 2024-26 | 755 | +2.2% ±1.9 |

**Home advantage by host country (internationals, men; hosts with at least 80 results)**

| format | host countries, strongest first |
|---|---|
| T20 | IND +12% ±10 (n=115), MAL +12% ±6 (n=80), NZ +11% ±5 (n=107), RSA +3% ±6 (n=86), ZIM +1% ±8 (n=88), BDESH +0% ±6 (n=86), WI -2% ±5 (n=104) |
| ListA | NZ +24% ±5 (n=203), AUS +20% ±6 (n=220), SL +17% ±4 (n=222), IND +15% ±4 (n=235), RSA +11% ±4 (n=219), PAK +11% ±6 (n=111), BDESH +9% ±4 (n=194), ENG +9% ±4 (n=225), ZIM +3% ±5 (n=216), WI +3% ±4 (n=202) |
| FC | IND +26% ±7 (n=95), AUS +22% ±9 (n=124), SL +20% ±7 (n=98), ENG +15% ±5 (n=147), RSA +12% ±6 (n=109), WI +2% ±7 (n=82) |

**Travel: subcontinent sides in SENA and vice versa** (full-member internationals; extra win-probability shift on top of normal home advantage; negative = they do worse than an ordinary away side)

| format | gender | era | matches | subcontinent team in SENA | SENA team in subcontinent |
|---|---|---|---|---|---|
| T20 | male | all | 1169 | -5.1% ±4.2 | +0.7% ±4.3 |
| T20 | male | 2000-13 | 247 | +6.7% ±7.6 | +3.4% ±10.2 |
| T20 | male | 2014-26 | 922 | -10.0% ±5.0 | -1.0% ±4.8 |
| T20 | female | all | 868 | +0.7% ±5.3 | +6.1% ±6.7 |
| T20 | female | 2000-13 | 189 | -26.4% ±14.4 | +22.8% ±14.0 |
| T20 | female | 2014-26 | 679 | +8.6% ±6.0 | +0.9% ±7.7 |
| ListA | male | all | 2521 | +0.7% ±2.9 | -6.9% ±3.1 |
| ListA | male | 2000-13 | 1509 | -1.1% ±3.8 | -12.2% ±4.1 |
| ListA | male | 2014-26 | 1012 | +4.2% ±4.5 | +1.4% ±4.8 |
| ListA | female | all | 1028 | -5.2% ±5.1 | -6.4% ±5.2 |
| ListA | female | 2000-13 | 452 | -14.2% ±7.5 | -14.4% ±7.8 |
| ListA | female | 2014-26 | 576 | +4.2% ±7.1 | +0.8% ±7.1 |
| FC | male | all | 929 | -7.1% ±5.4 | -12.8% ±5.5 |
| FC | male | 2000-13 | 473 | -6.5% ±8.0 | -14.4% ±8.0 |
| FC | male | 2014-26 | 456 | -8.7% ±7.3 | -12.0% ±7.5 |

**Regional conditions (men; runs and wickets per 100 balls vs average, after the teams)**

| format | region | runs/100 | wkts/100 |
|---|---|---|---|
| T20 | Subcontinent | +1.94 | -0.103 |
| T20 | Europe (other) | +0.72 | +0.232 |
| T20 | Pacific | +0.70 | +0.023 |
| T20 | East Asia | -1.00 | +0.007 |
| T20 | Africa (other) | -1.20 | -0.048 |
| T20 | SENA | -1.20 | +0.168 |
| T20 | Americas | -1.22 | -0.139 |
| T20 | Gulf | -1.83 | -0.104 |
| T20 | West Indies | -3.54 | +0.103 |
| ListA | Subcontinent | +1.09 | -0.039 |
| ListA | SENA | -0.08 | +0.056 |
| ListA | Americas | -0.24 | +0.019 |
| ListA | Pacific | -0.38 | -0.002 |
| ListA | Europe (other) | -0.71 | +0.045 |
| ListA | Africa (other) | -0.85 | +0.015 |
| ListA | East Asia | -0.90 | +0.059 |
| ListA | Gulf | -1.65 | -0.005 |
| ListA | West Indies | -2.67 | +0.011 |
| FC | Africa (other) | +1.74 | -0.098 |
| FC | Subcontinent | +1.01 | -0.007 |
| FC | East Asia | +0.37 | -0.003 |
| FC | SENA | +0.31 | +0.014 |
| FC | Pacific | -0.07 | -0.007 |
| FC | Europe (other) | -0.13 | +0.032 |
| FC | Americas | -0.32 | +0.018 |
| FC | Gulf | -0.39 | -0.019 |
| FC | West Indies | -3.10 | +0.051 |

### Players who adapt well or badly away from home

Per 100 balls vs the player's own home-region level (home region = where he plays his domestic cricket; shrunk with 800 balls of prior in T20, 3,000 in FC; runs for batters, value = runs saved + wicket value x wickets for bowlers). Minimum 1,500 balls abroad and at home (FC), 400 (T20). Bracket = home region.

**FC batters**: travel best: Tagenarine Chanderpaul (West Indies) +10.0, Ben Compton (SENA) +9.7, Sarel Burger (Africa (other)) +7.8, Nick Compton (SENA) +7.0, Bilal Shafayat (SENA) +6.5, William Porterfield (SENA) +6.2, Mohammad Kaif (Subcontinent) +5.7, Khaled Mashud (Subcontinent) +5.7
; travel worst: Niroshan Dickwella (Subcontinent) -15.3, Darren Lehmann (SENA) -14.8, Adam Gilchrist (SENA) -14.4, Andrew Flintoff (SENA) -13.9, Brad Haddin (SENA) -12.6, Rohit Sharma (Subcontinent) -12.6, Sean Williams (Africa (other)) -12.5, David Warner (SENA) -12.3

**T20 batters**: travel best: Delray Rawlins (SENA) +14.9, Abdul Waheed (Gulf) +11.2, George Munsey (SENA) +10.2, Anshy Rath (Subcontinent) +9.8, Soumya Sarkar (Subcontinent) +9.6, James Faulkner (SENA) +8.9, Benny Howell (SENA) +8.8, Shikhar Dhawan (Subcontinent) +8.8
; travel worst: Andrew Symonds (SENA) -24.3, Abhishek Sharma (Subcontinent) -17.4, Colin de Grandhomme (SENA) -16.6, Tissara Perera (Subcontinent) -13.8, Sunil Narine (Subcontinent) -12.8, Donovan Ferreira (SENA) -12.3, Matthew Wade (SENA) -12.0, Mark Adair (Europe (other)) -12.0

**FC bowlers (value per 100 balls)**: travel best: Yuzvendra Chahal (Subcontinent) +14.9, Shoaib Bashir (SENA) +13.0, Piyush Chawla (Subcontinent) +12.2, Joe Root (SENA) +10.8, Gareth Breese (SENA) +9.0, Rubel Hossain (Subcontinent) +8.6, Chaminda Vaas (SENA) +8.5, Moeen Ali (SENA) +7.8
; travel worst: Ravi Jadeja (Subcontinent) -16.9, Vernon Philander (SENA) -14.9, Ryan Sidebottom (SENA) -14.1, Lakshmipathy Balaji (Subcontinent) -13.8, Sachithra Senanayake (Subcontinent) -12.7, Shahid Afridi (Subcontinent) -12.5, Munaf Patel (Subcontinent) -11.9, Mir Hamza (Subcontinent) -11.0

**T20 bowlers (value per 100 balls)**: travel best: Jacob Oram (SENA) +22.5, Rudra Singh (Subcontinent) +17.7, Muttiah Muralitharan (Subcontinent) +15.7, Samiullah Shenwari (Subcontinent) +14.6, Rishad Hossain (Subcontinent) +14.6, Corbin Bosch (SENA) +13.9, Shivam Dubey (Subcontinent) +13.8, Gareth Berg (SENA) +13.7
; travel worst: Lockie Ferguson (SENA) -15.6, Shaheen Shah Afridi (Subcontinent) -14.9, Ali Dawood (East Asia) -14.6, Benny Howell (SENA) -13.8, Rahul Chahar (Subcontinent) -13.8, Matheesha Pathirana (Subcontinent) -13.6, Krishmar Santokie (West Indies) -13.4, Usman Qadir (Subcontinent) -12.8

## 10. Caveats

- Ground effects are relative to the teams that played there, so a ground isn't 'flat' just because strong batting sides play at home. But conditions and home-team selection are partly entangled (teams pick for their pitch).
- Single-venue tournaments (e.g. UAE-hosted IPL/PSL seasons) put competition-season level and ground in the same matches; the shrinkage splits them, so those grounds' factors lean on other competitions held there.
- Bowler types come from ESPNcricinfo styles, falling back to CricketArchive (first listed); 1-13% of balls (by format) have no type and are left out of type tables. Matchup edges are partly selection: captains bowl a type at the batters it suits, which flatters the bowler side of each matchup.
- Player 'travel' splits are vs the player's own home level, so a player picked abroad only when in form looks better than he is (and vice versa); treat single names as anecdotes, not ratings.
- Test days are approximate (90 overs per day of cumulative play); Cricsheet has no day stamps.
- Caught-behind is matched by the keeper's name on the card; substitutes and keeper changes are missed.
- Sixes are missing on many first-class cards, so FC six factors are thin or absent.
- Day/night comes from CricketArchive's '(day/night)' tag; it's missing for some matches, so 'day' includes some unlabelled night games.
- 'Were captains right?' uses each ground's chase record from earlier seasons, which is itself noisy at thin grounds.

## 11. Where this would plug into the engine (not wired in)

The engine's venue model is hand-set per team in `packages/engine/src/team.ts` (`stadiumBowlingRating`, `pitchType` flat/seaming/turning/balanced, `boundarySize`, `dewFactor`), read by `getVenueContext` in `match.ts`. `getPitchModifier` in `matchups.ts` turns pitchType + dew into wicket / boundary multipliers for pace and spin, and `decideTossChoice` picks bat or bowl from dew and pitch type. `data-export/venue-conditions.json` has what would replace them: run / wicket / six factors per ground (-> stadiumBowlingRating, boundarySize), per-type edges (-> pitch modifiers by bowler type and phase), 2nd-innings change and the ground's chase advantage (-> dewFactor and the toss decision).
