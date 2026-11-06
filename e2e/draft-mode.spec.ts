import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function waitForAppReady(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("nav", { timeout: 15000 });
}

test.describe("Draft modes", () => {
  test("Draft Match vs CPU: toss → draft → lineup → live match → result", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.getByTestId("draft-match-quick").click();
    await expect(page).toHaveURL(/\/draft-match/);
    await page.getByTestId("draft-match-start").click();
    await page.getByTestId("draft-match-begin").click();

    // Make one pick by hand when it's our turn, then auto-draft the rest
    await expect(page.getByTestId("draft-pool")).toBeVisible();
    const pickBtn = page.getByTestId("draft-pick-button").first();
    await expect(pickBtn).toBeEnabled({ timeout: 15000 });
    await pickBtn.click();
    await page.getByTestId("draft-autodraft").check();

    // Lineup
    await expect(page.getByTestId("lineup-editor")).toBeVisible({ timeout: 60000 });
    await page.getByTestId("lineup-confirm").click();

    // Live match page (existing) → sim to the end
    // Either the pre-match buildup ("Start Match") or, if we won the toss, the bat/bowl choice.
    // Retry briefly: the page can re-render right after mounting.
    const startBtn = page.getByRole("button", { name: "Start Match" }).first();
    const batFirst = page.getByText("Bat First", { exact: true }).first();
    await expect(startBtn.or(batFirst)).toBeVisible({ timeout: 15000 });
    for (let i = 0; i < 6; i++) {
      if (await batFirst.isVisible()) await batFirst.click().catch(() => {});
      else if (await startBtn.isVisible()) await startBtn.click().catch(() => {});
      await page.waitForTimeout(700);
      if (!(await startBtn.isVisible()) && !(await batFirst.isVisible())) break;
    }
    await page.getByText("Sim Rest").first().click({ timeout: 15000 });
    await page.getByTestId("draft-match-continue").click({ timeout: 30000 });

    const result = page.getByTestId("draft-match-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Player of the match");
    await expect(page.getByTestId("draft-match-rematch")).toBeVisible();
  });

  test("Season draft: setup → draft board → auto-draft → season", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.getByTestId("squad-building").getByText("Draft", { exact: true }).click();
    await page.waitForTimeout(500);
    // Pick the first franchise
    await page.locator("button", { hasText: "PWR" }).first().click();
    await expect(page).toHaveURL(/\/draft$/, { timeout: 15000 });
    await expect(page.getByTestId("draft-pool")).toBeVisible();
    await expect(page.getByTestId("draft-my-squad")).toBeVisible();
    await page.getByTestId("draft-sim-remaining").click();
    await page.getByTestId("draft-finish").click({ timeout: 30000 });
    await expect(page).toHaveURL(/\/(season|lineup)/, { timeout: 15000 });
  });

  test("Multiplayer lobby offers auction, season draft and Draft Match rooms", async ({ page }) => {
    await page.goto("/multiplayer");
    await waitForAppReady(page);
    const modes = page.getByTestId("room-mode");
    await expect(modes).toContainText("Auction");
    await expect(modes).toContainText("Season Draft");
    await expect(modes).toContainText("Draft Match");
  });
});
