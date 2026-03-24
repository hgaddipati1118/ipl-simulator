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
    await page.getByText("Cancel").click();
    await page.waitForURL("**/season", { timeout: 10000 });
  }
}

async function pickTeamAndAuction(page: Page, teamIndex = 0) {
  const teamButton = page.locator("button").filter({ hasText: /PWR \d+/ }).nth(teamIndex);
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

test.describe("Custom League", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);
  });

  test("Custom button is visible on setup page", async ({ page }) => {
    await expect(page.getByText("Custom")).toBeVisible();
  });

  test("clicking Custom shows the custom league panel", async ({ page }) => {
    await page.getByText("Custom").click();

    await expect(page.getByPlaceholder("My League")).toBeVisible();
    await expect(page.getByText("Apply Custom Rules")).toBeVisible();
    await expect(page.getByText("Real Players")).toBeVisible();
    await expect(page.getByText("CPU Generated")).toBeVisible();
  });

  test("can configure and apply custom rules", async ({ page }) => {
    await page.getByText("Custom").click();

    await page.getByPlaceholder("My League").fill("Test League");

    await page.getByText("Apply Custom Rules").click();

    await expect(page.getByText("Test League").first()).toBeVisible();
  });

  test("can select playoff format: simple bracket", async ({ page }) => {
    await page.getByText("Custom").click();

    await page.getByText("Simple Bracket").click();

    await page.getByText("Apply Custom Rules").click();

    await expect(page.getByText(/simple/i).first()).toBeVisible();
  });

  test("can select no playoffs", async ({ page }) => {
    await page.getByText("Custom").click();

    await page.getByText("No Playoffs").click();

    await page.getByText("Apply Custom Rules").click();

    await expect(page.getByText("None").first()).toBeVisible();
  });

  test("can toggle CPU generated players", async ({ page }) => {
    await page.getByText("Custom").click();

    await expect(page.getByText("Real Players")).toBeVisible();
    await expect(page.getByText("CPU Generated")).toBeVisible();

    await page.getByText("CPU Generated").click();

    await page.getByText("Apply Custom Rules").click();
  });

  test("can select gender options", async ({ page }) => {
    await page.getByText("Custom").click();

    await expect(page.getByText("Combined")).toBeVisible();
    await expect(page.getByText("Real Players")).toBeVisible();
    await expect(page.getByText("CPU Generated")).toBeVisible();
  });

  test("custom league plays through a full season", async ({ page }) => {
    test.setTimeout(300_000);

    await page.getByText("Custom").click();

    await page.locator('input[placeholder="My League"]').fill("MyLeague");

    await page.getByText("Simple Bracket").click();

    await page.getByText("Apply Custom Rules").click();

    await pickTeamAndAuction(page);

    await expect(page.getByText("Season 1").first()).toBeVisible();

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });

  test("no-playoffs league crowns table topper", async ({ page }) => {
    test.setTimeout(300_000);

    await page.getByText("Custom").click();
    await page.getByText("No Playoffs").click();
    await page.getByText("Apply Custom Rules").click();

    await pickTeamAndAuction(page);

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });
});
