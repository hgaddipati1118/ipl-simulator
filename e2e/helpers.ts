import { expect, type Page } from "@playwright/test";
import { finishLiveMatch, startLiveMatch } from "./live-helpers";

export { finishLiveMatch, startLiveMatch };

/**
 * Shared steps for the career-flow specs: a fresh game, picking a franchise, playing a season out and the off-season
 * (trade window, retention, auction). Every step reads where the app actually went instead of assuming one route,
 * so a squad that skips the auction, a first match that needs a lineup, a toss the user wins or loses and a stalled
 * sim button are all handled.
 */

const DEFAULT_SEED = 20261107;

/**
 * Seed Math.random on every page load (the same LCG as international.spec.ts), so tosses, match results, auctions and
 * CPU decisions repeat run to run. The helpers still handle every branch; the seed only keeps a failure reproducible.
 */
export async function seedRandom(page: Page, seed = DEFAULT_SEED): Promise<void> {
  await page.addInitScript((s0: number) => {
    let s = s0 >>> 0;
    Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  }, seed);
}

export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("nav", { timeout: 15000 });
}

export async function clearGameState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.clear();
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
}

/** A seeded browser on the setup page with no saved games */
export async function freshGame(page: Page, { seed = DEFAULT_SEED }: { seed?: number | null } = {}): Promise<void> {
  if (seed !== null) await seedRandom(page, seed);
  await page.goto("/");
  await clearGameState(page);
  await page.reload();
  await waitForAppReady(page);
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

/** Wait until the app is on one of these paths (exact, or a prefix when it ends in "/") */
async function waitForPath(page: Page, paths: string[], timeout = 30000): Promise<string> {
  const matches = (p: string) => paths.some(x => (x.endsWith("/") ? p.startsWith(x) : p === x));
  await page.waitForURL(url => matches(url.pathname), { timeout });
  return pathOf(page);
}

export const teamButtons = (page: Page) => page.locator("button").filter({ hasText: /PWR \d+/ });

/**
 * Pick a franchise on the setup page and get to the season page. Real squads skip the auction; empty ones (CPU
 * generated players) go through it; draft mode drafts. A first match that needs a lineup is left for later
 * (the lineup page's Cancel), so the season page is showing when this returns.
 */
export async function pickTeam(page: Page, index = 0): Promise<void> {
  await teamButtons(page).nth(index).click({ timeout: 15000 });
  await waitForPath(page, ["/auction-live", "/draft", "/season", "/lineup"]);
  await buildSquadAndStartSeason(page);
}

/** From the auction or draft page (or straight from setup): finish building squads and land on the season page */
export async function buildSquadAndStartSeason(page: Page): Promise<void> {
  let path = pathOf(page);
  if (path === "/auction-live") {
    await page.getByRole("button", { name: "Sim Remaining Auction" }).click({ timeout: 15000 });
    await expect(page.getByText("Auction Complete")).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Start Season" }).click();
    path = await waitForPath(page, ["/season", "/lineup"]);
  } else if (path === "/draft") {
    await page.getByTestId("draft-sim-remaining").click({ timeout: 15000 });
    await page.getByTestId("draft-finish").click({ timeout: 30000 });
    path = await waitForPath(page, ["/season", "/lineup"]);
  }
  if (path === "/lineup") {
    await page.getByRole("button", { name: "Cancel" }).click();
    await waitForPath(page, ["/season"]);
  }
  await expect(page.getByText("Points Table")).toBeVisible({ timeout: 15000 });
}

/** On the lineup page: lock in the XI it shows, or the auto-picked one when that XI isn't valid, and play the match */
export async function confirmLineup(page: Page): Promise<void> {
  const lockIn = page.getByRole("button", { name: "Lock In Lineup" });
  await lockIn.waitFor({ timeout: 15000 });
  if (await lockIn.isEnabled()) await lockIn.click();
  else await page.getByRole("button", { name: "Quick Start" }).click();
  // The live viewer, or the season page for a format the quick simulator plays (The Hundred)
  const path = await waitForPath(page, ["/live-match/", "/season", "/lineup"]);
  if (path.startsWith("/live-match/")) await finishLiveMatch(page);
}

const SEASON_ACTIONS = /^(View Results|Simulate Season|Play Next Match|Sim to Playoffs|Sim All Matches|Sim Next 5)$/;

async function matchesPlayed(page: Page): Promise<string | null> {
  const line = page.getByText(/\d+ \/ \d+ matches played/).first();
  return (await line.textContent({ timeout: 2000 }).catch(() => null))?.match(/(\d+) \/ \d+/)?.[1] ?? null;
}

/** Wait (briefly) for a batch sim to do something: a match played, or the app moving to the lineup page */
async function waitForProgress(page: Page, before: string | null): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (pathOf(page) !== "/season") return true;
    if ((await matchesPlayed(page)) !== before) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** One step on the season page: results when the season is done, otherwise batch-sim CPU matches or play the next one */
async function seasonStep(page: Page): Promise<void> {
  const action = page.getByRole("button", { name: SEASON_ACTIONS }).first();
  await action.waitFor({ timeout: 15000 });

  const viewResults = page.getByRole("button", { name: "View Results" });
  if (await viewResults.isVisible()) {
    await viewResults.click();
    await waitForPath(page, ["/results"]);
    return;
  }
  const simSeason = page.getByRole("button", { name: "Simulate Season" });
  if (await simSeason.isVisible()) {
    await simSeason.click();
    await waitForPath(page, ["/results"], 120000);
    return;
  }

  const playNext = page.getByRole("button", { name: "Play Next Match" });
  const batch = page.getByRole("button", { name: /^(Sim to Playoffs|Sim All Matches)$/ });
  if (await batch.isVisible()) {
    const before = await matchesPlayed(page);
    await batch.click();
    // The batch stops before the user's match and opens its lineup; if it neither played nor moved, play that match
    if (await waitForProgress(page, before)) return;
  }
  if (await playNext.isVisible()) {
    await playNext.click();
    await waitForPath(page, ["/live-match/", "/lineup", "/season"]);
    if (pathOf(page).startsWith("/live-match/")) await finishLiveMatch(page);
  }
}

/** Play the current season out to the results page (CPU matches in batches, the user's matches live via Sim Rest) */
export async function simulateSeason(page: Page, maxSteps = 250): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    const path = pathOf(page);
    if (path === "/results") {
      await expect(page.getByText(/Season \d+ Champions/)).toBeVisible({ timeout: 15000 });
      return;
    }
    if (path.startsWith("/live-match/")) await finishLiveMatch(page);
    else if (path === "/lineup") await confirmLineup(page);
    else if (path === "/season") await seasonStep(page);
    else {
      await page.goto("/season");
      await waitForAppReady(page);
    }
    // a live match's Continue (or a lineup) navigates; let the route settle before reading it again
    await page.waitForLoadState("domcontentloaded");
  }
  throw new Error(`season did not finish in ${maxSteps} steps (at ${page.url()})`);
}

/**
 * From the season page: sim the CPU matches up to the user's next one, lock in its lineup and open it live
 * (left at its pre-match screens: the toss question or the buildup).
 */
export async function openUserLiveMatch(page: Page): Promise<void> {
  await page.getByRole("button", { name: SEASON_ACTIONS }).first().waitFor({ timeout: 15000 });
  // "Sim to My Match" stops before the user's match and opens its lineup; with that match next it isn't offered
  const simToMine = page.getByRole("button", { name: "Sim to My Match" });
  if (await simToMine.isVisible()) {
    await simToMine.click();
    await waitForPath(page, ["/lineup"]);
  } else {
    await page.locator("nav").getByRole("button", { name: "Lineup", exact: true }).click();
    await waitForPath(page, ["/lineup"]);
  }
  const lockIn = page.getByRole("button", { name: "Lock In Lineup" });
  await lockIn.waitFor({ timeout: 15000 });
  if (await lockIn.isEnabled()) await lockIn.click();
  else await page.getByRole("button", { name: "Quick Start" }).click();
  await waitForPath(page, ["/live-match/"]);
}

/** From the results page: "Next Season" opens the trade window */
export async function goToNextSeason(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Next Season" }).click();
  await waitForPath(page, ["/trade"]);
  await expect(page.getByText("Trade Window")).toBeVisible({ timeout: 15000 });
}

/** Expired contracts lock the trade market ("Resolve Contracts First"); release them so offers and trades open */
export async function releaseExpiredContracts(page: Page): Promise<void> {
  const finishTrades = page.getByRole("button", { name: /^(Finish Trades & Start Auction|Resolve Contracts First)$/ });
  await finishTrades.waitFor({ timeout: 15000 });
  const releaseExpired = page.getByRole("button", { name: "Release All Expired" });
  if (await releaseExpired.isVisible()) await releaseExpired.click();
  await expect(page.getByRole("button", { name: "Finish Trades & Start Auction" })).toBeEnabled({ timeout: 15000 });
}

/** Reject every pending trade offer on the trade page */
export async function rejectPendingOffers(page: Page): Promise<void> {
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  for (let i = 0; i < 20 && (await reject.count()) > 0; i++) {
    const n = await reject.count();
    await reject.first().click();
    await expect(reject).toHaveCount(n - 1);
  }
}

/**
 * The off-season from the trade window to the next season: release expired contracts (they lock the trade market),
 * reject the remaining offers, finish trades, let the CPU retain, finish retention, then the auction (or draft).
 */
export async function finishOffseason(page: Page): Promise<void> {
  await releaseExpiredContracts(page);
  await rejectPendingOffers(page);
  await page.getByRole("button", { name: "Finish Trades & Start Auction" }).click();

  await waitForPath(page, ["/retention"]);
  await page.getByRole("button", { name: "Sim CPU Retentions" }).click({ timeout: 15000 });
  const finishRetention = page.getByRole("button", { name: "Finish Retentions & Start Auction" });
  await expect(finishRetention).toBeEnabled({ timeout: 15000 });
  await finishRetention.click();

  await waitForPath(page, ["/auction-live", "/draft"]);
  await buildSquadAndStartSeason(page);
}
