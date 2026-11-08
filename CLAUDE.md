# IPL Simulator

A full-stack IPL (Indian Premier League) T20 cricket simulator built as a TypeScript monorepo.

## Project Structure

```
packages/
  engine/    - Core simulation engine (ball-by-ball match sim, auction, season, player system)
  ratings/   - Player rating calculator, real player database (80 players), snapshot system
  app/       - React 19 + Vite frontend (team selection, auction, season sim, results)
```

Match rules (every dismissal kind, extras, free hits, strike after a wicket, retirements, super overs) are fitted from Cricsheet and documented in
`docs/RULES-MATCH.md` section 12 (`delivery-rules.ts`, `match-rules-data.ts`, built by `packages/ratings/src/analysis/match-rules.py`); rain / DLS / no result, DRS, fielding errors (drops, misfields), short runs, beamers, the over-rate restriction and the other rare plays in section 13 (`dls.ts`, `drs.ts`, `special-plays.ts`, `match-rules-extra-data.ts` from `match-rules-extra.py`).

Formats: T20, The Hundred and the ODI (`format.ts`; `odiRules()` starts an ODI in `simulateMatch` or `createMatchState`). An ODI ball comes
from its own model fitted on Cricsheet ODIs, in both engines (`odi-model.ts`; generated `odi-model-data.ts` / `odi-venue-data.ts` from
`packages/ratings/src/analysis/odi-ball-model.py`; players on their ODI ratings via `Player.forFormat("odi")`); rules, model, validation
(`__tests__/benchmark-odi.ts`) and refitting: `docs/FORMATS.md`. `__tests__/fingerprint-matches.ts` shows an engine change leaves T20 / Hundred play unchanged.
In the app, `/international` plays international series (ODI, T20I; men and women; `packages/app/src/international.ts`, a pluggable
`SERIES_FORMATS` list a Test entry joins) and Draft Match has a T20 / ODI option (docs/FORMATS.md, "In the app").
Test cricket has its own engine (`test-match.ts`: rules, ball model and captains' policies fitted on Cricsheet Tests, generated
`test-model-data.ts` from `packages/ratings/src/analysis/test-match-model.py`; live driver `test-live.ts`; validation
`__tests__/benchmark-test.ts`; docs/FORMATS.md, "Test"). In the app a Test is a format of the International series
(`packages/app/src/test-match/test-series.ts`), played live on `LiveTestPage` or instantly, with `TestScorecard`.
The live engine plays the instant engine's ball (`ballProbabilities` in `match.ts`; the user's batting approach and field on top) and CPU captaincy, so
both play at the same level (RULES-MATCH.md 12.4; `packages/app/src/__tests__/live-parity.test.ts`). A series' T20Is play at a T20I level fitted on real
T20Is between full members (`RuleSet.scoringContext: "t20i"`, `scoring-context.ts`; docs/FORMATS.md, "T20I level"); the women's leagues have contexts
fitted on their own matches (RULES-MATCH.md 12.7); men's leagues carry none. Every T20 / Hundred match draws its own conditions (a run multiplier
for the day, `match-conditions.ts`, spread fitted from real innings totals; RULES-MATCH.md 12.8).

Live-match commentary comes from a model built from real ESPNcricinfo ball-by-ball text (scraper, templates, engine API: `docs/COMMENTARY.md`;
generated file `packages/app/public/data/commentary-model.json`, built-in lines remain the fallback).

Besides the IPL and WPL the game plays BBL, WBBL, PSL, SA20, The Hundred (men and women), CPL, ILT20, MLC, BPL and LPL
with real teams, squads, home grounds and rules; see `docs/LEAGUES.md` (registry: `packages/engine/src/leagues.ts`). Multiplayer rooms
(auction, season draft, Draft Match pools) offer every league (`packages/app/src/multiplayer/leagues.ts`).

## Quick Start

```bash
npm install
npm run build          # Build engine → ratings → app (order matters)
npm run dev            # Start Vite dev server on port 3850
npm run engine:test    # Run engine tests
```

## Build Order

Engine must build before ratings (ratings depends on engine). Both must build before app.

```bash
npm run build --workspace=packages/engine
npm run build --workspace=packages/ratings
npm run build --workspace=packages/app
```

## Key Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start app dev server (port 3850) |
| `npm run build` | Build all packages in correct order |
| `npm run engine:test` | Run engine test suite |
| `npm run ratings:generate` | Generate player ratings from stats |
| `npm run ratings:snapshot` | Create rating snapshot |

## Tech Stack

- **Runtime:** Node.js with ES modules (`"type": "module"`)
- **Language:** TypeScript 5.4+ (strict mode, ES2022 target, bundler module resolution)
- **Frontend:** React 19, React Router 7, Vite 6, Tailwind CSS 3.4
- **Testing:** Direct `node --loader ts-node/esm` (no test framework)
- **Monorepo:** npm workspaces

## Package Details

### @ipl-sim/engine
Core simulation logic:
- **Match simulation** (`match.ts`): Ball-by-ball with multi-layer probability system (phase multipliers, chase context, pressure/clutch factors)
- **Player system** (`player.ts`): 8 attributes (battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch) on 0-99 scale, plus optional `fielding` / `keeping` (50 = average; absent = default; `fielding.ts`, docs/RULES-MATCH.md section 11). Fielding / keeping are priced into market value, trades, CPU retention and the draft AI as points of overall (`Player.valueOverall`, docs/RULES-AUCTION.md section 9) and weigh auto-picked XIs and the keeper choice (`xiSelectionValue`, docs/RULES-SQUAD.md section 5), age in `Player.progress()` (`fielding-progression.ts`, docs/RULES-SEASON.md section 7), and are drawn for generated players
- **Auction** (`auction.ts`): CPU bidding AI with position needs, age preference, domestic bias
- **Season** (`schedule.ts`): 70 group matches + 4-team playoff (Qualifier 1, Eliminator, Qualifier 2, Final)
- **Team** (`team.ts`): Roster management, playing XI selection, stadium ratings, NRR tracking

### @ipl-sim/ratings
- **Calculator** (`calculator.ts`): Converts raw player stats → 8-attribute ratings (clamped 15-99)
- **Real players** (`real-players.ts`): 80 hand-tuned IPL 2025 players across 10 teams
- **Snapshots** (`snapshot.ts`): Save/load/compare player ratings over time, stored in `data/snapshots/`

### @ipl-sim/app
- **Pages:** SetupPage (team select) → SeasonPage (standings) → ResultsPage (champion/stats) + TeamView + PlayerRatingsPage
- **State:** `GameState` in `game-state.ts`, persisted to localStorage
- **Styling:** Dark theme (gray-950 base), custom IPL colors (blue #004BA0, orange #FF822A, gold #D1AB3E), team-colored accents
- **Game flow:** Setup → Auction → Season → Results → Next Season (loop)

## Conventions

- All packages use ES modules with `"type": "module"`
- Ratings use `clamp()` utility from engine to enforce 15-99 range
- Player overall rating formula: `stronger + (100 - stronger) * (weaker/100)^4` (specialist-favoring)
- Role inference: >15 point gap between batting/bowling overall = specialist; ≤15 = all-rounder
- 10 IPL teams with config (primaryColor, secondaryColor, stadiumRating)
- No component libraries — pure React + Tailwind utility classes
