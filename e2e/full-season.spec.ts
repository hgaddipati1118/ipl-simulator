import { test, expect } from "@playwright/test";
import {
  freshGame,
  waitForAppReady,
  pickTeam,
  simulateSeason,
  goToNextSeason,
  releaseExpiredContracts,
  rejectPendingOffers,
  finishOffseason,
  teamButtons,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Full season play-through", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
  });

  test("play through a complete season 1", async ({ page }) => {
    test.setTimeout(300_000);

    await expect(page.getByText("Choose your franchise to begin")).toBeVisible();
    await expect(teamButtons(page)).toHaveCount(10);

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

    // Expired contracts lock the market until released; then reject every offer and go through retention and auction
    await finishOffseason(page);

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
    await releaseExpiredContracts(page);

    // Accept the first incoming offer when the CPU made one (it shows in the trade history), reject the rest
    const acceptBtn = page.getByRole("button", { name: "Accept", exact: true }).first();
    if (await acceptBtn.isVisible()) {
      await acceptBtn.click();
      await expect(page.getByText("Accepted").first()).toBeVisible({ timeout: 5000 });
    }
    await rejectPendingOffers(page);
    await finishOffseason(page);

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

    await expect(teamButtons(page)).toHaveCount(5);

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

    await expect(teamButtons(page)).toHaveCount(10);
  });
});
