# Injury likelihood by player type and age

_Generated 2026-11-06T11:56:04 by `src/analysis/injury-risk.py` + `injury-risk-report.py` from CricketArchive senior scorecards (1998+)._

**Short version.** Pace bowlers miss time about 1.7-1.8x as often as batters, spinners about 1.2-1.3x, and wicketkeepers
and all-rounders the least. A previous injury in the last two years adds 11-22%. The data can't see a workload effect (heavy
recent bowling *lowers* measured risk, which is selection: only fit bowlers get heavy loads). Age is ambiguous: confirmed
in-match injuries rise with age, but absence-based 'likely' injuries are highest for players 22 and under, which mostly
reflects young fringe players being rotated or dropped. The model ranks risk modestly (held-out AUC 0.60); use it for relative risk by type, not to predict individuals.

## 1. What counts as an injury

There's no injury register, so every absence of a regular is classified by evidence:

| Class | Rule | Spells |
|---|---|---|
| confirmed | 'retired hurt' / 'absent hurt' / 'retired ill' / 'absent ill' on the card, or named as replaced by a concussion/injury substitute; then missed the next match | 650 |
| confirmed, no time missed | same in-match evidence, but played the next match | 392 |
| likely | regular (played >= 2 of the team's previous 3 that season), missed >= 2 straight team matches, played nowhere else in the gap, came back to the same team (same season or a later one, within 3 years), form going in not poor | 10,968 |
| unknown | any other absence of a regular: single-match misses (rest/rotation), absences after poor form, never back with that team, career exit | 43,981 |
| elsewhere (excluded) | played any other match (international duty, another league) during the gap | 16,405 |

Exposure = one appearance by a regular whose team plays again that season (597,520 exposures). Main results use confirmed + likely; **low** = confirmed only, **high** = + every unknown absence.

Breakdown of reasons: single-match miss 31,696, played elsewhere 16,405, poor form before 6,739, missed>=2, back with team (in season) 5,699, long layoff, back with team later 5,269, never back with this team 3,574, career exit 1,972, in-match hurt 981, substitute 33, in-match substitute 14, in-match ill 13, IPL replacement 1.

Substitute notes on cards: Impact Player (tactical) 994, concussion 263, injury / medical 67, international / squad call-up 49, other (covid, family, misc) 12; 289 injury/concussion substitutions were linked to the replaced player.
IPL/WPL replacement signings: 231 name the replaced player, but only 29 give an injury reason and almost all happen before the season (the player never becomes an in-season regular), so they are used as a separate check in section 4 rather than as evidence.

## 2. Risk by player type (men, all formats)

Model relative risk vs batters (Poisson on exposure cells, adjusted for format, gender, age, era, workload, schedule density, previous injury), with 95% CI; raw rates per 100 regular appearances.

| Type | Relative risk | Main /100 | Low (confirmed) /100 | High (+unknown) /100 | Appearances |
|---|---|---|---|---|---|
| express/fast | 1.82 (1.59-2.09) | 3.24 | 0.08 | 13.9 | 8,651 |
| fast-medium | 1.83 (1.69-1.99) | 3.21 | 0.12 | 13.4 | 80,226 |
| medium | 1.71 (1.56-1.88) | 3.46 | 0.09 | 14.7 | 22,267 |
| wrist spin | 1.31 (1.16-1.48) | 2.54 | 0.05 | 11.3 | 12,916 |
| finger spin | 1.22 (1.11-1.34) | 2.12 | 0.08 | 10.1 | 47,094 |
| batter | 1 (ref) | 1.82 | 0.15 | 9.1 | 151,624 |
| bowling all-rounder | 0.86 (0.78-0.95) | 1.56 | 0.15 | 7.4 | 44,279 |
| batting all-rounder | 0.83 (0.76-0.90) | 1.54 | 0.15 | 7.2 | 49,487 |
| wicketkeeper | 0.79 (0.73-0.85) | 1.41 | 0.10 | 6.9 | 54,176 |

Confirmed in-match injuries are batter-heavy (retired hurt is mostly being hit), so the 'low' column ranks types differently from the main one; absences after the match are where bowlers dominate.

## 3. Age

| Age | Model RR (all types) | Pace main /100 | Spin main /100 | Bat/WK/AR main /100 | Bat/WK/AR confirmed /100 |
|---|---|---|---|---|---|
| <=22 | 1.38 (1.31-1.45) | 4.31 | 2.81 | 2.10 | 0.092 |
| 23-26 | 1.12 (1.07-1.18) | 3.51 | 2.36 | 1.62 | 0.117 |
| 27-30 | 1 (ref) | 2.84 | 2.11 | 1.51 | 0.135 |
| 31-33 | 0.98 (0.91-1.04) | 2.76 | 1.87 | 1.54 | 0.208 |
| 34+ | 0.91 (0.84-0.98) | 2.61 | 1.56 | 1.51 | 0.207 |

Read this carefully. Absence-based risk falls with age for every type, but young players are the ones most often rested or left out while still in form, which the 'likely' rule can't fully separate from injury. Confirmed in-match injuries for batters go the other way, roughly doubling from the early 20s to 31+. For pace bowlers the honest answer is that the data shows no clear rise with age once they're regulars (survivors: quicks who break down early stop being regulars and leave the at-risk pool).

Examples (model, T20 men, 2018+, same workload/schedule):

- express/fast aged 31-33 vs finger spin aged 23-26: **1.3x** (3.8% vs 2.9% per match)
- fast-medium aged <=22 vs batter aged 27-30: **2.5x** (5.3% vs 2.1% per match)
- wrist spin aged 27-30 vs finger spin aged 27-30: **1.1x** (2.8% vs 2.6% per match)
- medium aged 34+ vs wicketkeeper aged 27-30: **1.9x** (3.3% vs 1.7% per match)

## 4. Independent check: who gets replaced in the IPL

192 replaced players were matched to CricketArchive. Share of IPL squad-seasons (players who played that season) that ended with the player being replaced:

| Type | Replaced | Squad-seasons | % |
|---|---|---|---|
| express/fast | 26 | 125 | 20.8% |
| fast-medium | 55 | 718 | 7.7% |
| bowling all-rounder | 15 | 239 | 6.3% |
| wrist spin | 10 | 226 | 4.4% |
| batting all-rounder | 18 | 421 | 4.3% |
| wicketkeeper | 15 | 360 | 4.2% |
| batter | 38 | 928 | 4.1% |
| medium | 11 | 269 | 4.1% |
| finger spin | 4 | 347 | 1.2% |

This uses a completely different signal (replacement signings, mostly injuries) and agrees on the ordering: express quicks are replaced far more often than anyone, finger spinners least.

## 5. Workload, schedule and previous injury

| Factor | Level | Relative risk (95% CI) |
|---|---|---|
| wl30 | 0 | 1 (ref) |
| wl30 | 1-150 | 1.03 (0.96-1.10) |
| wl30 | 151-400 | 0.93 (0.85-1.02) |
| wl30 | 401-800 | 0.81 (0.73-0.90) |
| wl30 | 800+ | 0.55 (0.47-0.65) |
| acwr | low/none | 0.96 (0.88-1.05) |
| acwr | <0.8 | 1.07 (0.99-1.16) |
| acwr | 0.8-1.3 | 1 (ref) |
| acwr | 1.3-1.6 | 0.99 (0.91-1.07) |
| acwr | >1.6 | 1.00 (0.94-1.06) |
| density14 | 1-2 | 1 (ref) |
| density14 | 3-4 | 0.84 (0.80-0.88) |
| density14 | 5+ | 0.66 (0.62-0.71) |
| prior | 0 | 1 (ref) |
| prior | 1 | 1.11 (1.06-1.17) |
| prior | 2+ | 1.22 (1.12-1.33) |
| format | T20 | 1 (ref) |
| format | LA | 0.95 (0.90-1.00) |
| format | FC | 1.26 (1.18-1.35) |
| gender | male | 1 (ref) |
| gender | female | 0.58 (0.54-0.61) |
| era | 1998-2009 | 0.78 (0.74-0.82) |
| era | 2010-2017 | 0.87 (0.83-0.91) |
| era | 2018-2026 | 1 (ref) |

- **Previous injury** is the one workload-type signal that behaves as expected: one injury absence in the last two years raises risk ~11%, two or more ~22%.
- **Balls bowled in the last 30 days** and **matches in the last 14 days** both come out *protective*. That's selection, not physiology: bowlers who are carrying a niggle get managed down before they break, and the ones bowling 800+ balls a month are the fit ones. The acute:chronic ratio (last 7 days vs the 28-day average) shows no effect at all.
  Scorecards can't measure training load, so treat workload as **not measurable here** rather than 'safe'.
- Women's absences are ~40% rarer per appearance, and first-class cricket ~25% more injury-prone than T20 per appearance (multi-day matches = more exposure each).
- The modern era (2018+) shows more absences, which is mostly more rotation and workload management being counted as 'likely'.

## 6. Validation

Fit on seasons up to 2018, predict 2019-2026 player-seasons (did the player have an injury absence that season?).

| Model | AUC | Player-seasons | With an injury |
|---|---|---|---|
| format+gender | 0.567 | 55,192 | 4,283 |
| + archetype + age | 0.588 | 55,192 | 4,283 |
| + workload + density | 0.594 | 55,192 | 4,283 |
| full (+ prior injury, era) | 0.599 | 55,192 | 4,283 |

Calibration (full model, deciles of predicted risk; predicted vs observed injury absences per player-season): 0.013/0.051, 0.021/0.054, 0.028/0.061, 0.036/0.066, 0.046/0.063, 0.059/0.075, 0.076/0.077, 0.102/0.091, 0.147/0.091, 0.297/0.174.
The ordering is right (observed rises with predicted) but the model is overconfident at both ends, so predicted risks should be shrunk toward the mean (roughly halve the distance) before use. AUC ~0.6 means type, age, history and schedule explain only a small part of who gets injured.

## 7. Named players (observed injury absences vs what their type/age/schedule predicts)

| Player | Type (T20) | Regular appearances | Likely | Confirmed | Unknown | Expected | Obs/Exp |
|---|---|---|---|---|---|---|---|
| Jofra Archer | express/fast | 161 | 2 | 0 | 14 | 5.52 | 0.36 |
| Jasprit Bumrah | fast-medium | 251 | 8 | 0 | 18 | 9.12 | 0.88 |
| Mitchell Starc | fast-medium | 165 | 4 | 0 | 11 | 5.37 | 0.74 |
| Mark Wood | express/fast | 58 | 6 | 0 | 10 | 1.86 | 3.23 |
| Anrich Nortje | express/fast | 111 | 4 | 0 | 4 | 3.7 | 1.08 |
| Pat Cummins | express/fast | 139 | 4 | 0 | 10 | 4.71 | 0.85 |
| Josh Hazlewood | fast-medium | 130 | 6 | 0 | 11 | 4.47 | 1.34 |
| James Anderson | fast-medium | 213 | 5 | 1 | 14 | 6.19 | 0.97 |
| Trent Boult | fast-medium | 258 | 4 | 0 | 20 | 7.77 | 0.51 |
| Tim Southee | fast-medium | 213 | 5 | 1 | 16 | 6.7 | 0.9 |
| Ravichandran Ashwin | finger spin | 312 | 5 | 0 | 22 | 5.75 | 0.87 |
| Nathan Lyon | finger spin | 87 | 0 | 0 | 5 | 1.81 | 0.0 |
| Rashid Khan | wrist spin | 364 | 3 | 0 | 9 | 9.59 | 0.31 |
| Virat Kohli | batter | 470 | 4 | 0 | 8 | 8.22 | 0.49 |
| Joe Root | batting all-rounder | 216 | 1 | 0 | 7 | 3.67 | 0.27 |

Mark Wood (3.2x), Josh Hazlewood (1.3x) and Anrich Nortje (1.1x) come out above their type; durable players (Rashid Khan 0.3x, Joe Root 0.3x, Kohli 0.5x, Boult 0.5x, Nathan Lyon 0) below. Jofra Archer (0.4x) and Bumrah (0.9x) are under-counted: their big layoffs started at the end of a season or a series and lasted more than a year, and players are only counted at risk while their team still has matches that season. Following players across the season break was tried and dropped: it pulled in so much squad turnover that held-out AUC fell from 0.60 to 0.53.

## 8. Time missed (injury absences)

| Format | Group | 1-2 matches | 3-5 | 6+ |
|---|---|---|---|---|
| FC | other | 57% | 38% | 6% |
| FC | pace | 57% | 36% | 7% |
| FC | spin | 61% | 35% | 4% |
| LA | other | 55% | 39% | 6% |
| LA | pace | 55% | 36% | 10% |
| LA | spin | 59% | 34% | 7% |
| T20 | other | 51% | 39% | 10% |
| T20 | pace | 49% | 41% | 11% |
| T20 | spin | 49% | 41% | 10% |

Matches missed within the season only (long layoffs that run into the next season count their in-season part), so 6+ is understated.

## 9. Engine

`packages/engine/src/injury.ts` already has an injury roll after each match: a flat base chance by role (batsman 1.5%, bowler 4%, all-rounder 3%, wicket-keeper 2%), +2 points over age 34, a fatigue term above 55, and a 60/30/10 minor/moderate/severe split for 1-2 / 3-5 / 6-10 matches out. `data-export/injury-risk.json` is shaped to replace `BASE_INJURY_CHANCE` with a per-type, per-age table (T20 men 2018+), add the previous-injury multiplier, and replace `SEVERITY_DISTRIBUTION` with the observed split for pace / spin / other. It isn't wired in. Two things to decide before using it: (1) these rates include some rest/rotation, so scale toward the 'low' column if the game should only injure players who are really hurt; (2) the data gives no support for a workload-driven injury curve, so keep the existing fatigue term as a game-design choice rather than something this data backs.

## 10. Caveats

- Absence is a proxy. 'Likely' still includes some rest, rotation, personal leave and paternity breaks; 'unknown' still includes some real injuries.
- Only senior cricket since 1998 is used, so injuries in minor cricket or while not a regular are invisible.
- Gender, format and era effects partly reflect how often teams rotate, not how often players get hurt.
- Pace bands come from CricketArchive bowling styles ('fast' vs 'fast-medium'), which lag a player's actual pace and don't separate genuinely express bowlers well; express/fast and fast-medium come out the same.
- Workload uses balls bowled in senior matches only; nets, training and franchise practice aren't visible.
