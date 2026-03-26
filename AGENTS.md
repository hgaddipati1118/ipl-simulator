# IPL Simulator

A full-stack IPL (Indian Premier League) T20 cricket simulator built as a TypeScript monorepo.

## Project Structure

```
packages/
  engine/    - Core simulation engine (ball-by-ball match sim, auction, season, player system)
  ratings/   - Player rating calculator, real player database (80 players), snapshot system
  app/       - React 19 + Vite frontend (team selection, auction, season sim, results)
```

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
- **Player system** (`player.ts`): 8 attributes (battingIQ, timing, power, running, wicketTaking, economy, accuracy, clutch) on 0-99 scale
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

## Workflow

- Work directly on the `main` branch unless explicitly told otherwise
- Commit changes to `main` as they are made when the user asks for commits
