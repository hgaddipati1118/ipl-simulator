import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

// Helper: wait for the app to fully render after state initialization
async function waitForAppReady(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("nav", { timeout: 15000 });
}

// Helper: handle a live match page by simming it and going back to season
async function handleLiveMatch(page: Page) {
  if (!page.url().includes("/live-match")) return;
  const simRestBtn = page.getByText("Sim Rest");
  await simRestBtn.click({ timeout: 10000 });
  await page.getByText("Back to Season").waitFor({ timeout: 30000 });
  await page.getByText("Back to Season").click();
  await page.waitForTimeout(500);
}

// Helper: handle lineup page — try to confirm, or cancel and fallback to Play Next Match
async function handleLineup(page: Page) {
  if (!page.url().includes("/lineup")) return;

  const lockBtn = page.getByText("Lock In Lineup");
  const isEnabled = await lockBtn.isEnabled({ timeout: 3000 }).catch(() => false);

  if (isEnabled) {
    await lockBtn.click();
    await page.waitForURL("**/live-match/**", { timeout: 15000 });
    await handleLiveMatch(page);
  } else {
    // Lineup invalid (no WK available etc.) — cancel and let the sim loop handle it
    await page.getByText("Cancel").click();
    await page.waitForURL("**/season", { timeout: 10000 });
  }
}

// Helper: pick team and get to season page (may skip auction if rosters are full)
async function pickTeamAndAuction(page: Page, teamIndex = 0) {
  const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).nth(teamIndex);
  await teamButton.click({ timeout: 15000 });

  // With real players loaded, may skip auction and go directly to season/lineup
  // With generated players or empty rosters, goes to auction first
  await Promise.race([
    page.waitForURL("**/auction-live", { timeout: 30000 }),
    page.waitForURL("**/season", { timeout: 30000 }),
    page.waitForURL("**/lineup", { timeout: 30000 }),
  ]);

  // If auction page, complete it
  if (page.url().includes("/auction-live")) {
    await page.getByText("Sim Remaining Auction").click({ timeout: 15000 });
    await page.getByText(/Start Season/i).first().waitFor({ timeout: 60000 });
    await page.getByText(/Start Season/i).first().click();

    await Promise.race([
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);
  }

  // If on lineup page, handle it
  if (page.url().includes("/lineup")) {
    await handleLineup(page);
  }
}

/**
 * Simulate a full season from the season page through match-by-match to results.
 * Uses batch sim buttons for non-user matches and "Play Next Match" for user matches
 * (which bypasses the lineup page).
 */
async function simulateSeason(page: Page) {
  let needsPlayNextMatch = false; // true when lineup was cancelled (user match pending)
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

    // View Results takes priority
    const viewResultsBtn = page.getByText("View Results");
    if (await viewResultsBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await viewResultsBtn.click();
      await page.waitForURL("**/results", { timeout: 30000 });
      return;
    }

    // "Simulate Season" button (available when schedule is empty, e.g. after reload)
    const simSeasonBtn = page.getByText("Simulate Season");
    if (await simSeasonBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await simSeasonBtn.click();
      await page.waitForURL("**/results", { timeout: 120000 });
      return;
    }

    // If user match is pending (needsPlayNextMatch), skip batch buttons and go straight to Play Next Match
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

    // Try batch sim buttons
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

    // Fallback: Play Next Match
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

test.describe("IPL Simulator E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      localStorage.clear();
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    });
    await page.reload();
    await waitForAppReady(page);
  });

  test("setup page loads with all 10 teams", async ({ page }) => {
    await expect(page.getByText("Simulator").first()).toBeVisible();
    await expect(page.getByText("Choose your franchise to begin")).toBeVisible();

    const teamButtons = page.locator("button").filter({ hasText: /PWR \d+/ });
    await expect(teamButtons).toHaveCount(10);
  });

  test("shows team names on setup page", async ({ page }) => {
    for (const name of ["Sunrisers Hyderabad", "Delhi Capitals", "Royal Challengers Bengaluru", "Kolkata Knight Riders", "Rajasthan Royals"]) {
      await expect(page.getByText(name).first()).toBeVisible();
    }
  });

  test("nav bar shows title and controls", async ({ page }) => {
    const nav = page.locator("nav");
    await expect(nav.getByText("IPL", { exact: true })).toBeVisible();
    await expect(nav.getByText("Sim", { exact: true })).toBeVisible();
    await expect(nav.getByText(/S\d+/)).toBeVisible();
    await expect(nav.getByText("New Game")).toBeVisible();
  });

  test("selecting a team navigates to auction or season", async ({ page }) => {
    const firstTeamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await firstTeamButton.click({ timeout: 15000 });

    // With full real-player rosters, skips auction → goes to season/lineup
    // With empty rosters, goes to auction
    await Promise.race([
      page.waitForURL("**/auction-live", { timeout: 30000 }),
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);

    const url = page.url();
    expect(
      url.includes("/auction-live") || url.includes("/season") || url.includes("/lineup")
    ).toBe(true);
  });

  test("completing auction navigates to season page", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeamAndAuction(page);

    await expect(page.getByText("Season 1").first()).toBeVisible();
    await expect(page.getByText("Points Table")).toBeVisible();
  });

  test("season page shows standings table with correct columns", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeamAndAuction(page);

    await expect(page.locator("th").getByText("Team")).toBeVisible();
    await expect(page.locator("th").getByText("Pts")).toBeVisible();
    await expect(page.locator("th").getByText("NRR")).toBeVisible();
  });

  test("season page shows user squad summary", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeamAndAuction(page);

    await expect(page.getByText("Your Squad")).toBeVisible();
    await expect(page.getByText("Players", { exact: true })).toBeVisible();
    await expect(page.getByText("Overseas", { exact: true })).toBeVisible();
    await expect(page.getByText("Power", { exact: true })).toBeVisible();
  });

  test("simulating a season navigates to results", async ({ page }) => {
    test.setTimeout(300000);
    await pickTeamAndAuction(page);

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });

  test("results page shows champion, caps, and standings", async ({ page }) => {
    test.setTimeout(300000);
    await pickTeamAndAuction(page);
    await simulateSeason(page);

    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Orange Cap")).toBeVisible();
    await expect(page.getByText("Purple Cap")).toBeVisible();
    await expect(page.getByText("Top Run Scorers")).toBeVisible();
    await expect(page.getByText("Top Wicket Takers")).toBeVisible();
    await expect(page.getByText("Final Standings")).toBeVisible();
    await expect(page.getByText("Next Season")).toBeVisible();
  });

  test("next season goes to trade window then retention then auction then season", async ({ page }) => {
    test.setTimeout(600000);
    await pickTeamAndAuction(page);
    await simulateSeason(page);

    await page.getByText("Next Season").click();
    await page.waitForURL("**/trade", { timeout: 15000 });
    await expect(page.getByText("Trade Window")).toBeVisible({ timeout: 10000 });

    // Reject all pending trade offers
    const rejectBtns = page.locator("button").filter({ hasText: "Reject" });
    const count = await rejectBtns.count();
    for (let i = 0; i < count; i++) {
      await page.locator("button").filter({ hasText: "Reject" }).first().click();
    }

    // Finish trades -> goes to retention
    await page.getByText("Finish Trades & Start Auction").click();
    await page.waitForURL("**/retention", { timeout: 15000 });

    // Run CPU retentions then finish
    await page.getByText("Sim CPU Retentions").waitFor({ timeout: 10000 });
    await page.getByText("Sim CPU Retentions").click();
    // Wait for "Finish Retentions & Start Auction" to become enabled
    await page.getByText("Finish Retentions & Start Auction").waitFor({ timeout: 10000 });
    await expect(page.getByText("Finish Retentions & Start Auction")).toBeEnabled({ timeout: 10000 });
    await page.getByText("Finish Retentions & Start Auction").click();

    // Should go to auction
    await page.waitForURL("**/auction-live", { timeout: 30000 });

    // Sim remaining auction
    await page.getByText("Sim Remaining Auction").click({ timeout: 15000 });

    // Wait for "Start Season" button
    await page.getByText(/Start Season/i).first().waitFor({ timeout: 60000 });
    await page.getByText(/Start Season/i).first().click();

    // May go to season or lineup
    await Promise.race([
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);
    if (page.url().includes("/lineup")) {
      await handleLineup(page);
    }

    await expect(page.getByText("Season 2").first()).toBeVisible({ timeout: 10000 });
  });

  test("nav links work after selecting team", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeamAndAuction(page);

    await page.locator("nav").getByText("Ratings").click();
    await page.waitForURL("**/ratings");

    await page.locator("nav").getByText("Season", { exact: true }).click();
    await page.waitForURL("**/season");

    await page.locator("nav").getByText("My Team").click();
    await expect(page).toHaveURL(/\/team\//);
  });

  test("new game resets state", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeamAndAuction(page);

    await page.locator("nav").getByText("New Game").click();
    await page.waitForURL("/", { timeout: 15000 });
    await expect(page.getByText("Choose your franchise to begin")).toBeVisible({ timeout: 10000 });
  });

  test("state persists across page reload", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeamAndAuction(page);

    await page.reload();
    await waitForAppReady(page);

    await expect(page.getByText("Points Table")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Player Ratings Page", () => {
  test("shows player data", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/");
    await page.evaluate(async () => {
      localStorage.clear();
      const dbs = await indexedDB.databases();
      for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
    });
    await page.reload();
    await waitForAppReady(page);

    await pickTeamAndAuction(page);
    await page.locator("nav").getByText("Ratings").click();
    await page.waitForURL("**/ratings");

    await page.waitForSelector("table, [class*='divide']", { timeout: 10000 });
  });
});

test.describe("Team View Page", () => {
  test("shows team roster when clicking team in standings", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/");
    await page.evaluate(async () => {
      localStorage.clear();
      const dbs = await indexedDB.databases();
      for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
    });
    await page.reload();
    await waitForAppReady(page);

    await pickTeamAndAuction(page);

    const teamRow = page.locator("table tbody tr").first();
    await teamRow.click();
    await expect(page).toHaveURL(/\/team\//, { timeout: 10000 });
  });
});
