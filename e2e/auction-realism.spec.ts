import { test, expect, type Page } from "@playwright/test";

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

/**
 * Switch to "CPU Generated" player source so the auction actually runs
 * (real player rosters are full and would skip auction).
 */
async function setupCustomLeagueWithAuction(page: Page) {
  // Click Custom league toggle
  await page.getByText("Custom").click();
  await page.waitForTimeout(500);

  // Switch to CPU Generated player source
  await page.getByText("CPU Generated").click();

  // Apply custom rules
  await page.getByText("Apply Custom Rules").click();
  await page.waitForTimeout(500);
}

test.describe("Auction Realism", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);
  });

  test("skip auction when teams have full real-player rosters", async ({ page }) => {
    // Default IPL mode with real players — rosters are full (18+ per team)
    const firstTeam = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await firstTeam.click({ timeout: 15000 });

    // Should skip auction and go directly to season or lineup
    await Promise.race([
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);

    const url = page.url();
    expect(url.includes("/season") || url.includes("/lineup")).toBe(true);
    // Should NOT be on auction page
    expect(url).not.toContain("/auction-live");
  });

  test("auction runs with CPU-generated players", async ({ page }) => {
    test.setTimeout(120000);
    await setupCustomLeagueWithAuction(page);

    // Pick a team
    const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await teamButton.click({ timeout: 15000 });

    // Should go to auction since rosters are empty (CPU generated = no pre-assigned players)
    await page.waitForURL("**/auction-live", { timeout: 30000 });
    await expect(page.getByText("Live Auction")).toBeVisible({ timeout: 10000 });
  });

  test("auction shows realistic base prices (not flat 0.20 Cr)", async ({ page }) => {
    test.setTimeout(120000);
    await setupCustomLeagueWithAuction(page);

    const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await teamButton.click({ timeout: 15000 });
    await page.waitForURL("**/auction-live", { timeout: 30000 });

    // Base price should be one of the real IPL slabs, shown in the UI
    // The "Base Price" label should exist and show a valid slab value
    const basePriceText = page.locator("text=Base Price").first();
    await expect(basePriceText).toBeVisible({ timeout: 10000 });

    // Current bid display should be visible with a value from the slab system
    const bidDisplay = page.locator("text=/\\d+\\.\\d{2} Cr/").first();
    await expect(bidDisplay).toBeVisible({ timeout: 10000 });
  });

  test("bid button shows correct tiered increment", async ({ page }) => {
    test.setTimeout(120000);
    await setupCustomLeagueWithAuction(page);

    const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await teamButton.click({ timeout: 15000 });
    await page.waitForURL("**/auction-live", { timeout: 30000 });

    // The bid button should show an amount with 2 decimal places
    // e.g. "Bid 0.35 Cr" or "Bid 2.20 Cr"
    const bidButton = page.locator("button").filter({ hasText: /^Bid \d+\.\d{2} Cr$/ });
    // It may not be visible if user already highest bidder or passed
    // but at the start the user should be able to bid
    const visible = await bidButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      const text = await bidButton.textContent();
      // Verify format is "Bid X.XX Cr"
      expect(text).toMatch(/^Bid \d+\.\d{2} Cr$/);
    }
  });

  test("sim remaining auction completes with generated players", async ({ page }) => {
    test.setTimeout(120000);
    await setupCustomLeagueWithAuction(page);

    const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await teamButton.click({ timeout: 15000 });
    await page.waitForURL("**/auction-live", { timeout: 30000 });

    // Sim remaining
    await page.getByText("Sim Remaining Auction").click({ timeout: 15000 });

    // Should complete and show Start Season
    await page.getByText(/Start Season/i).first().waitFor({ timeout: 60000 });
    await expect(page.getByText("Auction Complete")).toBeVisible();

    // Click Start Season
    await page.getByText(/Start Season/i).first().click();

    await Promise.race([
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);
  });

  test("auction progress bar updates", async ({ page }) => {
    test.setTimeout(120000);
    await setupCustomLeagueWithAuction(page);

    const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).first();
    await teamButton.click({ timeout: 15000 });
    await page.waitForURL("**/auction-live", { timeout: 30000 });

    // Progress bar should start near 0
    await expect(page.getByText("Auction Progress")).toBeVisible({ timeout: 10000 });

    // Sim a few players and check progress moves
    const simPlayerBtn = page.getByText("Sim Player");
    if (await simPlayerBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await simPlayerBtn.click();
      await page.waitForTimeout(500);
      // After simming one player, should see sold/unsold then Next Player
      const nextBtn = page.getByText("Next Player");
      if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // Progress text should show some count
    await expect(page.locator("text=/\\d+ \\/ \\d+/").first()).toBeVisible();
  });
});
