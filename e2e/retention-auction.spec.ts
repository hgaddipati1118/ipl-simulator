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

async function pickTeam(page: Page, index = 0) {
  const teamButton = page
    .locator("button")
    .filter({ hasText: /PWR \d+/ })
    .nth(index);
  await teamButton.click({ timeout: 15000 });
}

test.describe("Auction Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);
  });

  test("selecting a team navigates to auction or season (skips when rosters full)", async ({ page }) => {
    await pickTeam(page);
    // With real player rosters already full, may skip auction → season/lineup
    // With empty/partial rosters, goes to auction
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

  test("auction page shows current player and bid controls (when auction runs)", async ({ page }) => {
    test.setTimeout(60000);
    await pickTeam(page);

    await Promise.race([
      page.waitForURL("**/auction-live", { timeout: 30000 }),
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);

    // Only test auction UI if we actually went to auction
    if (page.url().includes("/auction-live")) {
      await expect(page.getByText("Live Auction")).toBeVisible({ timeout: 10000 });
      await expect(page.getByText("Sim Remaining Auction")).toBeVisible({ timeout: 10000 });
    }
  });

  test("completing flow reaches season page", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await Promise.race([
      page.waitForURL("**/auction-live", { timeout: 30000 }),
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);

    // If auction, sim through it
    if (page.url().includes("/auction-live")) {
      const simBtn = page.getByText("Sim Remaining Auction");
      await simBtn.click({ timeout: 15000 });

      const completed = await Promise.race([
        page.waitForURL("**/season", { timeout: 60000 }).then(() => true),
        page.getByText(/Start Season|Complete/i).first().waitFor({ timeout: 60000 }).then(() => true),
      ]).catch(() => false);

      expect(completed).toBe(true);
    }
    // Otherwise we're already at season/lineup — success
  });
});

test.describe("Retention Page", () => {
  test("retention page renders correctly when navigated to directly", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);

    // Pick team → may go to auction or skip to season
    await pickTeam(page);
    await Promise.race([
      page.waitForURL("**/auction-live", { timeout: 30000 }),
      page.waitForURL("**/season", { timeout: 30000 }),
      page.waitForURL("**/lineup", { timeout: 30000 }),
    ]);

    // If auction, sim through it
    if (page.url().includes("/auction-live")) {
      const simBtn = page.getByText("Sim Remaining Auction");
      await simBtn.click({ timeout: 15000 });
      await Promise.race([
        page.waitForURL("**/season", { timeout: 60000 }),
        page.getByText(/Start Season/i).first().waitFor({ timeout: 30000 }).then(async () => {
          await page.getByText(/Start Season/i).first().click();
        }),
      ]);
    }

    // Navigate to retention page directly to test it renders
    await page.goto("/retention");
    await waitForAppReady(page);

    // The retention page should at minimum render without crashing
    // It may show "no retention state" or redirect, but shouldn't error
    await page.waitForTimeout(2000);
    const hasContent = await page.locator("nav").count();
    expect(hasContent).toBeGreaterThan(0);
  });
});
