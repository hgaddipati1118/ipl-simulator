import { test, expect, type Page } from "@playwright/test";

async function waitForAppReady(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("nav", { timeout: 15000 });
}

/** Answer whatever the live page asks the user (toss, bowler, batter, review) with its first option, or bowl one ball */
async function stepLive(page: Page, balls: number) {
  for (let i = 0; i < balls * 4 && balls > 0; i++) {
    // a decision modal (toss, bowler, batter, review) has buttons; an overlay without one (a DRS verdict) clears itself
    const choice = page.locator("div.fixed.inset-0 button:visible").first();
    if (await choice.count() > 0) {
      const batFirst = page.getByText("Bat First", { exact: true }).first();
      if (await batFirst.isVisible().catch(() => false)) await batFirst.click();
      else await choice.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    const step = page.getByRole("button", { name: "Step", exact: true });
    if (await step.isEnabled().catch(() => false)) {
      await step.click();
      balls--;
    }
    await page.waitForTimeout(150);
  }
}

test.describe("International series and ODIs in the app", () => {
  test.beforeEach(async ({ page }) => {
    // Seeded Math.random: the series / draft seeds, tosses and CPU picks are the same every run
    await page.addInitScript(() => {
      let s = 20261107;
      Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("ipl-sim-intl-series-v1"));
    await page.reload();
    await waitForAppReady(page);
  });

  test("ODI series: start, simulate a match, play live balls, open the scorecard", async ({ page }) => {
    await page.getByTestId("international-quick").click();
    await expect(page).toHaveURL(/\/international/);
    await expect(page.getByTestId("series-setup")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("series-format-odi").click();
    await page.getByTestId("series-length-3").click();
    await page.getByTestId("series-role-a").click();
    await page.getByTestId("series-start").click();

    // Hub: simulate the 1st ODI
    await expect(page.getByTestId("series-hub")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("series-match-0")).toContainText("1st ODI");
    await page.getByTestId("series-sim-match").click();
    await expect(page.getByTestId("series-scorecard-0")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("series-score")).toHaveText(/lead 1-0|level 0-0|level/);
    await expect(page.getByTestId("series-pots")).toBeVisible();

    // The user's XI: edit and save
    await page.getByTestId("series-edit-xi").click();
    await expect(page.getByTestId("series-lineup")).toBeVisible();
    await page.getByTestId("lineup-confirm").click();
    await expect(page.getByTestId("series-user-xi")).not.toContainText("(auto)");

    // Play the 2nd ODI live: a few balls, 50-over display and the powerplay
    await page.getByTestId("series-play-live").click();
    const startBtn = page.getByRole("button", { name: "Start Match" }).first();
    const batFirst = page.getByText("Bat First", { exact: true }).first();
    await expect(startBtn.or(batFirst)).toBeVisible({ timeout: 15000 });
    for (let i = 0; i < 6; i++) {
      if (await batFirst.isVisible()) await batFirst.click().catch(() => {});
      else if (await startBtn.isVisible()) await startBtn.click().catch(() => {});
      await page.waitForTimeout(600);
      if (!(await startBtn.isVisible()) && !(await batFirst.isVisible())) break;
    }
    await stepLive(page, 8);
    // 50 overs a side (fewer when rain cut the match before the start)
    await expect(page.getByText(/Inn [12]: \d+\.\d \/ (50|[1-4]\d)$/)).toBeVisible();
    await expect(page.getByTestId("odi-powerplay")).toContainText(/P[123]/);

    // Back to the series: the live match can be resumed
    await page.getByRole("button", { name: "← Series" }).click();
    await expect(page.getByTestId("series-resume-live")).toBeVisible();

    // The 1st ODI's scorecard
    await page.getByTestId("series-scorecard-0").click();
    await expect(page.getByTestId("series-scorecard")).toBeVisible();
    await expect(page.getByTestId("series-scorecard-result")).toHaveText(/won by|tied|No result/);
    await expect(page.getByText("Fall of wickets").first()).toBeVisible();
    await page.getByTestId("series-innings-tab-1").click();
    await expect(page.getByText("Run Worm")).toBeVisible();

    // The series survives a reload (its own storage key) and the live match resumes
    await page.reload();
    await waitForAppReady(page);
    await expect(page.getByText(/Inn [12]: \d+\.\d \/ (50|[1-4]\d)$/)).toBeVisible({ timeout: 20000 });
  });

  test("Draft Match ODI: the pool on ODI ratings, a 50-over match", async ({ page }) => {
    await page.getByTestId("draft-match-quick").click();
    await expect(page).toHaveURL(/\/draft-match/);
    await page.getByTestId("draft-match-format-odi").click();
    await page.getByTestId("draft-match-start").click();
    await expect(page.getByTestId("draft-match-begin")).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/ODI ratings/)).toBeVisible();
    await page.getByTestId("draft-match-begin").click();
    await expect(page.getByTestId("draft-pool")).toBeVisible();
    await page.getByTestId("draft-autodraft").check();
    await expect(page.getByTestId("lineup-editor")).toBeVisible({ timeout: 60000 });
    await page.getByTestId("lineup-confirm").click();

    const startBtn = page.getByRole("button", { name: "Start Match" }).first();
    const batFirst = page.getByText("Bat First", { exact: true }).first();
    await expect(startBtn.or(batFirst)).toBeVisible({ timeout: 15000 });
    // the pre-match screen (when the CPU won the toss) names the format
    if (await startBtn.isVisible()) await expect(page.getByText("50 overs a side")).toBeVisible();
    for (let i = 0; i < 6; i++) {
      if (await batFirst.isVisible()) await batFirst.click().catch(() => {});
      else if (await startBtn.isVisible()) await startBtn.click().catch(() => {});
      await page.waitForTimeout(600);
      if (!(await startBtn.isVisible()) && !(await batFirst.isVisible())) break;
    }
    await stepLive(page, 3);
    await expect(page.getByText(/\/ 50$/)).toBeVisible();
    await page.getByText("Sim Rest").first().click({ timeout: 15000 });
    await page.getByTestId("draft-match-continue").click({ timeout: 30000 });
    const result = page.getByTestId("draft-match-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Player of the match");
  });
});
