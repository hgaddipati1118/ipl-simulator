# Mods: personal versions of the game

Status: design, 2026-10-31. Phases 1-2 are being built first; later phases need a hosting decision
(see "Open decisions").

## Goal

Every player runs the same **base app**. On top of it they can have their **own version**, made by
typing what they want ("spinners should matter more in Chennai", "add a 10-over Super Sixes
format with a leaderboard"). A coding agent turns the prompt into a change. A daily sweep reads the
changes everyone made, finds the common ones, and proposes folding them into the base app, so
personal versions shrink back toward the base over time instead of drifting apart.

## Two ways to change your version

| | SDK mods (default) | Personal code branches |
|---|---|---|
| What changes | Data, rules, engine hooks, UI slots, theme, commentary | Anything in the codebase |
| Written by | Coding agent (or by hand) against the Mod SDK types | Coding agent on a branch of the base repo |
| Where it runs | Inside the base app: engine hooks in a Web Worker, UI in sandboxed iframes | A separate build on the user's own preview URL |
| Survives base updates | Yes, it targets a versioned SDK, not internals | Rebased by the agent daily; falls back to last good build if the rebase fails |
| Cost per change | ~1-5 cents (small model, a few calls) | ~$0.50-5 (agent edits, builds, tests) |
| Safety | Can't touch saves, network, or DOM outside its slot | Separate origin, no secrets in the build |

The agent always tries an SDK mod first and only falls back to a code branch when the SDK has no
hook for what was asked. Every such fallback is a signal the sweep uses to grow the SDK.

## Mod SDK

A mod is an ES module plus a manifest:

```ts
// manifest.json
{ "id": "spin-friendly-chennai", "name": "Spin-friendly Chepauk", "version": "1.0.0",
  "sdk": "1", "hooks": ["engine.ballProbabilities"], "description": "..." }

// mod.js
export default defineMod({
  engine: {
    ballProbabilities(ctx, probs) {
      if (ctx.venue.id !== "chepauk" || !ctx.bowler.isSpin) return probs;
      return { ...probs, wicket: probs.wicket * 1.15, dot: probs.dot * 1.08 };
    },
  },
});
```

### Hooks (SDK v1)

Data and rules (applied once when a save loads or a season starts):
- `data.players(players) => players` edit ratings, roles, ages, add or remove players
- `data.teams(teams) => teams` rename, recolour, add teams, change squads
- `rules(ruleSet) => ruleSet` any `RuleSet` field (impact player, overseas limits, scoring multiplier, ...)

Engine (pure, synchronous, deterministic; called every ball, both in `match.ts` and `live-match.ts`):
- `engine.ballProbabilities(ctx, probs) => probs` after the base adjustments, before sampling.
  `ctx` = batter, bowler (ratings, style, hand), over, innings, score, target, wickets, venue
  (pitch, boundary, dew), phase, plus a seeded `rng` so multiplayer peers stay in sync
- `engine.onBall(ctx, event)` read-only observer (for stats and achievement mods)
- `engine.matchFormat(format) => format` overs per innings, powerplay length, super-over rules

Presentation:
- `ui.theme` colours and fonts as CSS variables
- `ui.screens[]` a new route rendered in a sandboxed iframe slot, given read-only game state
- `ui.panels[]` a widget inside an existing screen at a named slot (`team.sidebar`, `match.summary`, ...)
- `commentary.line(event, ctx) => string | null` and `news.item(event) => NewsItem | null`

Hooks compose in install order. A hook that throws, returns an invalid shape, or takes longer than
its time budget is skipped for that call and the mod is flagged; three strikes disables it.

### Runtime

- Mods are stored in IndexedDB (`mods` store), loaded at app start, and listed on a Mods screen
  (enable, disable, update, remove, share).
- Engine hooks run inside the Web Worker that runs the simulation (the hooks are data-in, data-out).
  Probabilities are re-validated after every hook: finite, non-negative, normalised.
- UI hooks render in `<iframe sandbox="allow-scripts">` slots and talk to the app with
  `postMessage`. They get read-only state and a narrow action API (navigate, show toast).
- Saves record the set of mods (id + content hash) they were played with. Multiplayer lobbies
  compare hashes and refuse to start a match with mismatched engine mods.

## Coding agent

1. The user types a prompt on the Mods screen.
2. The backend calls Claude with the SDK `.d.ts`, the example mods, the user's installed mods, and
   the prompt. Claude returns a manifest + module.
3. Automatic checks: type-check against the SDK, then a headless test (simulate 20 seeded matches
   with and without the mod; must not crash, must keep scores within sane bounds, must actually
   change something). Failures go back to Claude to fix, up to 3 rounds.
4. The user sees a summary of what changed (and the before/after test numbers), previews it, then
   installs it. Follow-up prompts edit the same mod.
5. If no SDK hook can express the request, the agent says so and offers a personal code branch.

## Personal code branches

- Branch `users/<userId>/<n>` of the base repo, edited by a sandboxed coding agent that runs the
  repo's type-check and tests before pushing.
- Built and deployed to a per-user preview URL on its own origin (Cloudflare Pages branch deploys).
  Builds never receive secrets.
- Daily: rebase every branch on the new base. The agent resolves conflicts; if tests fail, the user
  keeps the last good build and gets a notice.
- Nothing from a personal branch reaches `main` except through a reviewed PR.

## Daily sweep

A scheduled Claude run (same setup as the existing cloud routines):

1. Read the last day's prompts, mods, and branch diffs from users who opted in.
2. Cluster them by intent ("pitch effects are too weak") and rank by how many users and how much use.
3. For each cluster, propose one of: fix a base bug or balance issue; add the feature to the base as
   a built-in option; add an SDK hook so the change becomes a cheap mod.
4. Open PRs with the evidence (user count, example prompts, test results). A human reviews and merges.
5. After a merge, find every user whose mod or branch does the same thing and migrate them to the
   built-in version (their mod is disabled and they get a note).
6. Send a digest: top requests, what was proposed, what's trending.

## Data model (our own database)

Cloudflare D1 for rows, R2 for blobs.

| Table | Columns |
|---|---|
| `users` | id, created_at, consent_store (needed for the feature), consent_sweep (cross-user analysis), quota_used |
| `prompts` | id, user_id, text (scrubbed of personal details), created_at, result_kind (mod/branch/none), result_id |
| `mods` | id, author_id, manifest (json), sdk_version, bundle_key (R2), hash, created_at, parent_mod_id |
| `mod_installs` | user_id, mod_id, version, enabled, installed_at, last_used_at |
| `code_changes` | id, user_id, branch, diff_key (R2), base_sha, build_status, preview_url, created_at |
| `intent_clusters` | id, summary, member_ids (json), user_count, first_seen, last_seen, status |
| `upstream_proposals` | id, cluster_id, kind (bug/feature/sdk-hook), pr_url, status, migrated_user_count |

Privacy: two separate consents. Storing a user's own mods and branches is required for the feature
to work; letting the sweep read them across users is optional. Prompts are scrubbed before storage,
users can export and delete their data, and the privacy policy says what is kept.

## Backend

A Cloudflare Worker (the project already uses Cloudflare R2 for data backups):

- `POST /mods/generate` prompt in, mod out (holds the Anthropic key, enforces per-user quota)
- `GET/POST /mods` registry: publish, fetch, list a user's mods
- `POST /branches` start a personal code change (queues an agent job)
- `POST /events` opt-in usage events for the sweep
- Auth: anonymous device id first, optional account later so versions follow a user across devices.

## Phases

1. **SDK + engine hooks**: `packages/mods` with types, `defineMod`, hook runner and validation;
   hooks wired into `match.ts`, `live-match.ts`, rules and data loading; existing tests stay green.
2. **Loader + Mods screen**: IndexedDB storage, enable/disable, install from file, save/lobby hash
   check, two built-in example mods (a venue spin mod and a theme) proving the hooks.
3. **Backend**: Worker + D1 + R2 locally (`wrangler dev`), registry and quota.
4. **Agent loop**: generate, check, retry, preview, install.
5. **Personal code branches**: sandboxed agent jobs, preview deploys, daily rebase.
6. **Daily sweep**: clustering, PRs, migration, digest.

## Implementation notes (2026-10-31)

- **Phase 3 backend is built** in `packages/server` (branch `mods-backend`): Worker routes from the
  "Backend" section, the D1 schema above in `migrations/0001_init.sql`, R2 for bundles. Tested locally
  with `wrangler dev` (local D1/R2) and unit tests; not deployed.
- **Checks are split.** Workers can't evaluate code, so the Worker only runs static checks (manifest,
  declared hooks, size, banned APIs such as `fetch`, storage, `Math.random`, the clock). The app runs
  the SDK type-check and the seeded headless test, and sends failures back to `/mods/generate` as
  `previous.errors`; such retries don't use quota.
- **Generator.** One Claude call per attempt (`claude-opus-5-5`, configurable through `MODEL`):
  structured JSON output, server-side refusal fallbacks, the instructions + SDK types + examples
  in a cached system block (they're identical across calls), up to 3 attempts on the server.
  `scripts/build-sdk-context.mjs` regenerates that context from `packages/mods`.
- **Dedupe is per author**: the same mod published by two players gets two rows, because one
  copy may be private.
- **Personal code branches (phase 5) will run as Claude Managed Agents sessions**: Anthropic hosts
  the sandbox, the repo is cloned into it, the GitHub token is a vault credential (never visible to
  the agent's code), and the session's outcome is "type-check and tests pass on the branch". The
  Worker queues a `code_changes` row and starts the session; a webhook updates `build_status`.
- **The sweep (phase 6)** is a scheduled routine that reads the last day's opted-in rows (see
  `packages/server/sweep/ROUTINE.md`).

## Open decisions

- Hosting the backend on Harsha's Cloudflare account, and the Anthropic API key it uses (or let
  users bring their own key for the agent).
- Whether personal code branches are for everyone or a paid tier, given their cost.
