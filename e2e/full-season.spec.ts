import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clearGameState(page: Page) {
  await page.evaluate(async () => {
    localStorage.clear();
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
}

async function waitForAppReady(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("nav", { timeout: 15000 });
}

async function handleLiveMatch(page: Page) {
  if (!page.url().includes("/live-match")) return;
  await page.getByText("Sim Rest").click({ timeout: 10000 });
  await page.getByText("Back to Season").waitFor({ timeout: 30000 });
  await page.getByText("Back to Season").click();
  await page.waitForTimeout(500);
}

async function handleLineup(page: Page) {
  if (!page.url().includes("/lineup")) return;

  const lockBtn = page.getByText("Lock In Lineup");
  const isEnabled = await lockBtn.isEnabled({ timeout: 3000 }).catch(() => false);

  if (isEnabled) {
    await lockBtn.click();
    await page.waitForURL("**/live-match/**", { timeout: 15000 });
    await handleLiveMatch(page);
  } else {
    // Cancel and go back to season — Play Next Match will bypass lineup
    await page.getByText("Cancel").click();
    await page.waitForURL("**/season", { timeout: 10000 });
  }
}

/** Pick a team and complete the auction to get to the season page. */
async function pickTeam(page: Page, teamIndex = 0) {
  const teamButton = page
    .locator("button")
    .filter({ hasText: /PWR \d+/ })
    .nth(teamIndex);
  await teamButton.click({ timeout: 15000 });

  await page.waitForURL("**/auction-live", { timeout: 30000 });

  await page.getByText("Sim Remaining Auction").click({ timeout: 15000 });

  await page.getByText(/Start Season/i).first().waitFor({ timeout: 60000 });
  await page.getByText(/Start Season/i).first().click();

  await Promise.race([
    page.waitForURL("**/season", { timeout: 30000 }),
    page.waitForURL("**/lineup", { timeout: 30000 }),
  ]);

  if (page.url().includes("/lineup")) {
    await handleLineup(page);
  }
}

/** Simulate a full season via match-by-match buttons until results page. */
async function simulateSeason(page: Page) {
  let needsPlayNextMatch = false;
  const maxIterations = 200;

  for (let i = 0; i < maxIterations; i++) {
    const url = page.url();

    if (url.includes("/results")) return;

    if (url.includes("/live-match")) {
      await handleLiveMatch(page);
      needsPlayNextMatch = false;
      continue;
    }

    if (url.includes("/lineup")) {
      const lockBtn = page.getByText("Lock In Lineup");
      const isEnabled = await lockBtn.isEnabled({ timeout: 3000 }).catch(() => false);
      if (isEnabled) {
        await lockBtn.click();
        await page.waitForURL("**/live-match/**", { timeout: 15000 });
        await handleLiveMatch(page);
        needsPlayNextMatch = false;
      } else {
        await page.getByText("Cancel").click();
        await page.waitForURL("**/season", { timeout: 10000 });
        needsPlayNextMatch = true;
      }
      continue;
    }

    if (!url.includes("/season")) {
      await page.goto("/season");
      await waitForAppReady(page);
    }

    const viewResultsBtn = page.getByText("View Results");
    if (await viewResultsBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await viewResultsBtn.click();
      await page.waitForURL("**/results", { timeout: 30000 });
      return;
    }

    const simSeasonBtn = page.getByText("Simulate Season");
    if (await simSeasonBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await simSeasonBtn.click();
      await page.waitForURL("**/results", { timeout: 120000 });
      return;
    }

    if (needsPlayNextMatch) {
      const playBtn = page.getByText("Play Next Match");
      if (await playBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await playBtn.click();
        await page.waitForURL("**/live-match/**", { timeout: 15000 });
        await handleLiveMatch(page);
        needsPlayNextMatch = false;
        continue;
      }
    }

    const simToPlayoffsBtn = page.getByText("Sim to Playoffs");
    if (await simToPlayoffsBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await simToPlayoffsBtn.click();
      await page.waitForTimeout(300);
      continue;
    }

    const simNext5Btn = page.getByText("Sim Next 5");
    if (await simNext5Btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await simNext5Btn.click();
      await page.waitForTimeout(300);
      continue;
    }

    const playNextMatchBtn = page.getByText("Play Next Match");
    if (await playNextMatchBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await playNextMatchBtn.click();
      await page.waitForURL("**/live-match/**", { timeout: 15000 });
      await handleLiveMatch(page);
      continue;
    }

    await page.waitForTimeout(500);
  }
}

/** Click "Next Season" and wait for the trade window. */
async function goToNextSeason(page: Page) {
  await page.getByText("Next Season").click();
  await page.waitForURL("**/trade", { timeout: 30000 });
}

/** Handle the trade window, retention, auction, and return to season page. */
async function finishTrades(page: Page) {
  // Reject all pending trade offers
  const rejectBtns = page.locator("button").filter({ hasText: "Reject" });
  const count = await rejectBtns.count();
  for (let i = 0; i < count; i++) {
    await page.locator("button").filter({ hasText: "Reject" }).first().click();
  }

  await page.getByText("Finish Trades & Start Auction").click();
  await page.waitForURL("**/retention", { timeout: 15000 });

  await page.getByText("Sim CPU Retentions").waitFor({ timeout: 10000 });
  await page.getByText("Sim CPU Retentions").click();
  await expect(page.getByText("Finish Retentions & Start Auction")).toBeEnabled({ timeout: 10000 });
  await page.getByText("Finish Retentions & Start Auction").click();

  await page.waitForURL("**/auction-live", { timeout: 30000 });

  await page.getByText("Sim Remaining Auction").click({ timeout: 15000 });

  await page.getByText(/Start Season/i).first().waitFor({ timeout: 60000 });
  await page.getByText(/Start Season/i).first().click();

  await Promise.race([
    page.waitForURL("**/season", { timeout: 30000 }),
    page.waitForURL("**/lineup", { timeout: 30000 }),
  ]);
  if (page.url().includes("/lineup")) {
    await handleLineup(page);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Full season play-through", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);
  });

  test("play through a complete season 1", async ({ page }) => {
    test.setTimeout(300_000);

    await expect(page.getByText("Choose your franchise to begin")).toBeVisible();
    const teamButtons = page.locator("button").filter({ hasText: /PWR \d+/ });
    await expect(teamButtons).toHaveCount(10);

    await pickTeam(page);

    await expect(page.getByText("Season 1").first()).toBeVisible();
    await expect(page.getByText("Points Table")).toBeVisible();
    await expect(page.getByText("Your Squad")).toBeVisible();

    const standingsRows = page.locator("table tbody tr");
    await expect(standingsRows).toHaveCount(10);

    await expect(page.getByText("YOU", { exact: true })).toBeVisible();

    await simulateSeason(page);

    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Orange Cap")).toBeVisible();
    await expect(page.getByText("Purple Cap")).toBeVisible();
    await expect(page.getByText("Top Run Scorers")).toBeVisible();
    await expect(page.getByText("Top Wicket Takers")).toBeVisible();
    await expect(page.getByText("Final Standings")).toBeVisible();

    const scorersList = page
      .locator("h3")
      .filter({ hasText: "Top Run Scorers" })
      .locator("..")
      .locator("..")
      .locator("[class*='divide'] > div");
    await expect(scorersList).toHaveCount(10);

    const wicketList = page
      .locator("h3")
      .filter({ hasText: "Top Wicket Takers" })
      .locator("..")
      .locator("..")
      .locator("[class*='divide'] > div");
    await expect(wicketList).toHaveCount(10);

    const finalStandings = page
      .locator("h3")
      .filter({ hasText: "Final Standings" })
      .locator("..")
      .locator("..")
      .locator("table tbody tr");
    await expect(finalStandings).toHaveCount(10);

    await expect(page.getByText("Next Season")).toBeVisible();
  });

  test("play through 3 full seasons with trades", async ({ page }) => {
    test.setTimeout(900_000);

    // ===================== SEASON 1 =====================
    await pickTeam(page);
    await expect(page.getByText("Season 1").first()).toBeVisible();
    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });

    const historySection = page.locator("text=History").locator("..").locator("..");
    await expect(historySection).toBeVisible();
    await expect(historySection.getByText("S1", { exact: true })).toBeVisible();

    // ===================== TRADE WINDOW (before S2) =====================
    await goToNextSeason(page);
    await expect(page.getByText("Trade Window")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Season 2", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Incoming Trade Offers")).toBeVisible();
    await expect(page.getByText("Propose a Trade")).toBeVisible();

    await expect(page.getByText("Stadium Settings")).toBeVisible();
    await expect(page.locator('input[type="range"]')).toBeVisible();

    const pendingOffers = page.locator("button").filter({ hasText: "Reject" });
    const offerCount = await pendingOffers.count();
    for (let i = 0; i < offerCount; i++) {
      await page.locator("button").filter({ hasText: "Reject" }).first().click();
    }

    await finishTrades(page);

    // ===================== SEASON 2 =====================
    await expect(page.getByText("Season 2").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Points Table")).toBeVisible();
    await simulateSeason(page);
    await expect(page.getByText("Season 2 Champions")).toBeVisible({ timeout: 10000 });

    const historyS2 = page.locator("text=History").locator("..").locator("..");
    await expect(historyS2.getByText("S1", { exact: true })).toBeVisible();
    await expect(historyS2.getByText("S2", { exact: true })).toBeVisible();

    // ===================== TRADE WINDOW (before S3) =====================
    await goToNextSeason(page);
    await expect(page.getByText("Trade Window")).toBeVisible({ timeout: 10000 });

    const acceptBtn = page.locator("button").filter({ hasText: "Accept" }).first();
    if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await acceptBtn.click();
      await expect(page.getByText("Accepted").first()).toBeVisible({ timeout: 5000 });
    }

    const remaining = page.locator("button").filter({ hasText: "Reject" });
    const remainCount = await remaining.count();
    for (let i = 0; i < remainCount; i++) {
      await page.locator("button").filter({ hasText: "Reject" }).first().click();
    }

    await finishTrades(page);

    // ===================== SEASON 3 =====================
    await expect(page.getByText("Season 3").first()).toBeVisible({ timeout: 10000 });
    await simulateSeason(page);
    await expect(page.getByText("Season 3 Champions")).toBeVisible({ timeout: 10000 });

    const historyS3 = page.locator("text=History").locator("..").locator("..");
    await expect(historyS3.getByText("S1", { exact: true })).toBeVisible();
    await expect(historyS3.getByText("S2", { exact: true })).toBeVisible();
    await expect(historyS3.getByText("S3", { exact: true })).toBeVisible();
  });

  test("season state persists through reload at each phase", async ({ page }) => {
    test.setTimeout(300_000);

    await pickTeam(page);
    await page.reload();
    await waitForAppReady(page);
    await expect(page.getByText("Points Table")).toBeVisible({ timeout: 10000 });

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
    await page.reload();
    await waitForAppReady(page);
    await page.goto("/results");
    await waitForAppReady(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });

    await goToNextSeason(page);
    await expect(page.getByText("Trade Window")).toBeVisible({ timeout: 10000 });
    await page.reload();
    await waitForAppReady(page);
    await page.goto("/trade");
    await waitForAppReady(page);
    await expect(page.getByText("Trade Window")).toBeVisible({ timeout: 10000 });
  });

  test("navigate to team view and ratings mid-season", async ({ page }) => {
    test.setTimeout(300_000);

    await pickTeam(page);

    const firstRow = page.locator("table tbody tr").first();
    await firstRow.click();
    await expect(page).toHaveURL(/\/team\//, { timeout: 10000 });
    await page.waitForLoadState("networkidle");

    await page.locator("nav").getByText("Season", { exact: true }).click();
    await page.waitForURL("**/season");

    await page.locator("nav").getByText("Ratings").click();
    await page.waitForURL("**/ratings");
    await page.waitForSelector("table", { timeout: 10000 });

    await page.locator("nav").getByText("Season", { exact: true }).click();
    await page.waitForURL("**/season");
    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });

  test("WPL league toggle and full season", async ({ page }) => {
    test.setTimeout(300_000);

    await page.getByText("WPL (Women's)").click();
    await expect(page.getByText("Simulator")).toBeVisible();
    await expect(page.getByText("WPL", { exact: true }).first()).toBeVisible();

    const teamButtons = page.locator("button").filter({ hasText: /PWR \d+/ });
    await expect(teamButtons).toHaveCount(5);

    await pickTeam(page);
    await expect(page.getByText("Season 1").first()).toBeVisible();
    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });

    await expect(page.locator("nav").getByText("Sim", { exact: true })).toBeVisible();
  });

  test("IPL classic era toggle and full season", async ({ page }) => {
    test.setTimeout(300_000);

    await page.getByText("Classic (Pre-2023)").click();
    await expect(page.getByText("OFF", { exact: true })).toBeVisible();

    await pickTeam(page);
    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });

  test("new game resets mid-season", async ({ page }) => {
    test.setTimeout(300_000);

    await pickTeam(page);
    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });

    await page.locator("nav").getByText("New Game").click();
    await page.waitForURL("/", { timeout: 15000 });
    await expect(page.getByText("Choose your franchise to begin")).toBeVisible({ timeout: 10000 });

    const teamButtons = page.locator("button").filter({ hasText: /PWR \d+/ });
    await expect(teamButtons).toHaveCount(10);
  });
});
