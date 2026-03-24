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
    await page.getByText("Cancel").click();
    await page.waitForURL("**/season", { timeout: 10000 });
  }
}

async function pickTeam(page: Page, index = 0) {
  const teamButton = page
    .locator("button")
    .filter({ hasText: /PWR \d+/ })
    .nth(index);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Saves page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);
  });

  test("saves page is accessible from nav", async ({ page }) => {
    test.setTimeout(120_000);
    await pickTeam(page);

    await page.locator("nav").getByText("Saves").click();
    await page.waitForURL("**/saves");
    await expect(page.getByText("Saves & Data")).toBeVisible();
  });

  test("shows empty saves message when no saves exist", async ({ page }) => {
    await page.goto("/saves");
    await waitForAppReady(page);
    await expect(page.getByText("No saved games yet")).toBeVisible();
  });

  test("auto-creates a save slot when team is selected", async ({ page }) => {
    test.setTimeout(120_000);
    await pickTeam(page);

    await page.goto("/saves");
    await waitForAppReady(page);

    await expect(page.getByText("Saved Games")).toBeVisible();
    await expect(page.getByText("Season 1", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("(Active)")).toBeVisible();
  });

  test("multiple save slots from different games", async ({ page }) => {
    test.setTimeout(600_000);

    await pickTeam(page, 0);
    await simulateSeason(page);

    await page.locator("nav").getByText("New Game").click();
    await page.waitForURL("/", { timeout: 15000 });
    await pickTeam(page, 1);

    await page.goto("/saves");
    await waitForAppReady(page);

    await expect(page.getByText("(Active)")).toBeVisible();
    await expect(page.getByText("Load").first()).toBeVisible();
  });

  test("can switch between saves via load button", async ({ page }) => {
    test.setTimeout(300_000);

    await pickTeam(page, 0);

    await page.locator("nav").getByText("New Game").click();
    await page.waitForURL("/", { timeout: 15000 });
    await pickTeam(page, 2);

    await page.goto("/saves");
    await waitForAppReady(page);
    await page.getByText("Load").first().click();

    await page.waitForURL("**/season", { timeout: 15000 });
    await expect(page.getByText("Season 1").first()).toBeVisible();
  });

  test("can delete a save slot", async ({ page }) => {
    test.setTimeout(120_000);

    await pickTeam(page);

    await page.goto("/saves");
    await waitForAppReady(page);

    await expect(page.getByText("(Active)")).toBeVisible();

    await page.getByText("Delete").first().click();
    await page.getByText("Confirm").click();

    await page.waitForURL("/", { timeout: 10000 });
    await expect(page.getByText("Choose your franchise to begin")).toBeVisible({ timeout: 5000 });
  });

  test("export button is present on saves page", async ({ page }) => {
    test.setTimeout(120_000);
    await pickTeam(page);

    await page.goto("/saves");
    await waitForAppReady(page);

    await expect(page.getByText("Export Save")).toBeVisible();
  });

  test("import button is present on saves page", async ({ page }) => {
    await page.goto("/saves");
    await waitForAppReady(page);

    await expect(page.getByText("Import File")).toBeVisible();
    await expect(page.getByText("Full Save", { exact: true })).toBeVisible();
    await expect(page.getByText("Player Ratings", { exact: true })).toBeVisible();
    await expect(page.getByText("Team Roster", { exact: true })).toBeVisible();
  });
});

test.describe("Setup page saved games", () => {
  test("shows saved games on setup page for quick-load", async ({ page }) => {
    test.setTimeout(600_000);

    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);

    await pickTeam(page);
    await simulateSeason(page);

    await page.locator("nav").getByText("New Game").click();
    await page.waitForURL("/", { timeout: 15000 });

    await expect(page.getByText("Continue a Saved Game")).toBeVisible();
  });
});

test.describe("Import custom players", () => {
  test("import player ratings file adds players to pool", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await clearGameState(page);
    await page.reload();
    await waitForAppReady(page);

    await pickTeam(page);

    const playerRatingsJson = JSON.stringify({
      type: "player-ratings",
      version: 1,
      players: [
        {
          name: "Test Player One",
          age: 25,
          country: "India",
          role: "batsman",
          battingIQ: 85,
          timing: 80,
          power: 75,
          running: 70,
          wicketTaking: 20,
          economy: 25,
          accuracy: 30,
          clutch: 80,
        },
        {
          name: "Test Player Two",
          age: 28,
          country: "Australia",
          role: "bowler",
          battingIQ: 30,
          timing: 25,
          power: 20,
          running: 35,
          wicketTaking: 85,
          economy: 80,
          accuracy: 82,
          clutch: 75,
        },
      ],
    });

    await page.goto("/saves");
    await waitForAppReady(page);

    const fileInput = page.locator('input[type="file"]');

    await fileInput.setInputFiles({
      name: "custom-players.json",
      mimeType: "application/json",
      buffer: Buffer.from(playerRatingsJson),
    });

    page.once("dialog", async dialog => {
      expect(dialog.message()).toContain("Imported 2 players");
      await dialog.accept();
    });

    await page.waitForTimeout(1000);
  });
});
