import { test, expect } from "@playwright/test";
import {
  freshGame,
  waitForAppReady,
  pickTeam,
  simulateSeason,
  goToNextSeason,
  releaseExpiredContracts,
  rejectPendingOffers,
  buildSquadAndStartSeason,
  teamButtons,
} from "./helpers";

test.describe("IPL Simulator E2E", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
  });

  test("setup page loads with all 10 teams", async ({ page }) => {
    await expect(page.getByText("Simulator").first()).toBeVisible();
    await expect(page.getByText("Choose your franchise to begin")).toBeVisible();
    await expect(teamButtons(page)).toHaveCount(10);
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
    await teamButtons(page).first().click({ timeout: 15000 });
    // Full real-player rosters skip the auction (season, or the lineup for a first match); empty rosters go to it
    await page.waitForURL(/\/(auction-live|season|lineup)$/, { timeout: 30000 });
  });

  test("completing auction navigates to season page", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await expect(page.getByText("Season 1").first()).toBeVisible();
    await expect(page.getByText("Points Table")).toBeVisible();
  });

  test("season page shows standings table with correct columns", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await expect(page.locator("th").getByText("Team")).toBeVisible();
    await expect(page.locator("th").getByText("Pts")).toBeVisible();
    await expect(page.locator("th").getByText("NRR")).toBeVisible();
  });

  test("season page shows user squad summary", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await expect(page.getByText("Your Squad")).toBeVisible();
    await expect(page.getByText("Players", { exact: true })).toBeVisible();
    await expect(page.getByText("Overseas", { exact: true })).toBeVisible();
    await expect(page.getByText("Power", { exact: true })).toBeVisible();
  });

  test("simulating a season navigates to results", async ({ page }) => {
    test.setTimeout(300000);
    await pickTeam(page);

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });

  test("results page shows champion, caps, and standings", async ({ page }) => {
    test.setTimeout(300000);
    await pickTeam(page);
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
    await pickTeam(page);
    await simulateSeason(page);

    // Trade window: expired contracts lock the market until they are renewed or released
    await goToNextSeason(page);
    await releaseExpiredContracts(page);
    await rejectPendingOffers(page);
    await page.getByRole("button", { name: "Finish Trades & Start Auction" }).click();
    await page.waitForURL("**/retention", { timeout: 15000 });

    // Season 2 is a mini auction year: the squad is kept on its contracts, releases are the user's choice
    await expect(page.getByTestId("retention-mode")).toContainText("Mini auction year");
    await expect(page.getByTestId("mini-retention-note")).toBeVisible();
    await expect(page.getByRole("button", { name: "Release" }).first()).toBeVisible();
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/retention-mini.png`, fullPage: false });

    // Retention: the CPU teams retain, then the auction opens
    await page.getByRole("button", { name: "Sim CPU Retentions" }).click({ timeout: 10000 });
    const finishRetention = page.getByRole("button", { name: "Finish Retentions & Start Auction" });
    await expect(finishRetention).toBeEnabled({ timeout: 10000 });
    await finishRetention.click();
    await page.waitForURL("**/auction-live", { timeout: 30000 });

    // Auction → season 2
    await buildSquadAndStartSeason(page);
    await expect(page.getByText("Season 2").first()).toBeVisible({ timeout: 10000 });
  });

  test("nav links work after selecting team", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await page.locator("nav").getByText("Ratings").click();
    await page.waitForURL("**/ratings");

    await page.locator("nav").getByText("Season", { exact: true }).click();
    await page.waitForURL("**/season");

    await page.locator("nav").getByText("My Team").click();
    await expect(page).toHaveURL(/\/team\//);
  });

  test("new game resets state", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await page.locator("nav").getByText("New Game").click();
    await page.waitForURL("/", { timeout: 15000 });
    await expect(page.getByText("Choose your franchise to begin")).toBeVisible({ timeout: 10000 });
  });

  test("state persists across page reload", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await page.reload();
    await waitForAppReady(page);

    await expect(page.getByText("Points Table")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Player Ratings Page", () => {
  test("shows player data", async ({ page }) => {
    test.setTimeout(120000);
    await freshGame(page);

    await pickTeam(page);
    await page.locator("nav").getByText("Ratings").click();
    await page.waitForURL("**/ratings");

    await page.waitForSelector("table, [class*='divide']", { timeout: 10000 });
  });
});

test.describe("Team View Page", () => {
  test("shows team roster when clicking team in standings", async ({ page }) => {
    test.setTimeout(120000);
    await freshGame(page);

    await pickTeam(page);

    const teamRow = page.locator("table tbody tr").first();
    await teamRow.click();
    await expect(page).toHaveURL(/\/team\//, { timeout: 10000 });
  });
});
