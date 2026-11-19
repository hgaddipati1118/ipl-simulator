import { test, expect } from "@playwright/test";
import { seedRandom, waitForAppReady } from "./helpers";
import { startLiveMatch, stepLive } from "./live-helpers";

test.describe("International series and ODIs in the app", () => {
  test.beforeEach(async ({ page }) => {
    // Seeded Math.random: the series / draft seeds, tosses and CPU picks are the same every run
    await seedRandom(page);
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
    await startLiveMatch(page);
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

  test("watching: set both sides' XIs, the realistic option is on by default for a T20I", async ({ page }) => {
    await page.getByTestId("international-quick").click();
    await expect(page.getByTestId("series-setup")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("series-format-t20i").click();
    await page.getByTestId("series-length-1").click();
    await page.getByTestId("series-role-watch").click();
    await expect(page.getByTestId("series-realistic").locator("input")).toBeChecked();
    await page.getByTestId("series-start").click();
    await expect(page.getByTestId("series-hub")).toBeVisible({ timeout: 30000 });
    // set the second side's XI: it is kept, shown, and can be cleared
    await page.getByTestId("series-edit-xi-1").click();
    await expect(page.getByTestId("series-lineup")).toBeVisible();
    await page.getByTestId("lineup-confirm").click();
    await expect(page.getByTestId("series-set-xi")).toContainText("(set by you)");
    await page.getByTestId("series-edit-xi-1").click();
    await page.getByTestId("series-clear-xi").click();
    await expect(page.getByTestId("series-set-xi")).toHaveCount(0);
    // a side's set XI plays
    await page.getByTestId("series-edit-xi-0").click();
    await page.getByTestId("lineup-confirm").click();
    await page.getByTestId("series-sim-match").click();
    await expect(page.getByTestId("series-scorecard-0")).toBeVisible({ timeout: 30000 });
  });

  test("tactics: a bowling plan and the match conditions are set, kept and played (T20I), light and pitch for an ODI", async ({ page }) => {
    await page.getByTestId("international-quick").click();
    await expect(page.getByTestId("series-setup")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("series-format-t20i").click();
    await page.getByTestId("series-length-1").click();
    await page.getByTestId("series-role-a").click();
    await page.getByTestId("series-start").click();
    await expect(page.getByTestId("series-hub")).toBeVisible({ timeout: 30000 });

    // the bowling plan: the default shows over by over, a phase list and a fixed over are kept
    await page.getByTestId("series-edit-xi").click();
    await expect(page.getByTestId("series-lineup")).toBeVisible();
    await expect(page.getByTestId("bowling-plan")).toBeVisible();
    await expect(page.getByTestId("bowling-plan-default")).toContainText("1 ");
    await expect(page.getByTestId("bowling-plan-reset")).toBeDisabled();
    await page.locator('[data-testid^="plan-powerplay-"]').first().click();
    await expect(page.getByTestId("bowling-plan-reset")).toBeEnabled();
    await page.getByTestId("bowling-plan-overs").locator("summary").click();
    await page.getByTestId("bowling-plan-from-default").click();
    await expect(page.getByTestId("plan-over-0")).not.toHaveValue("");
    await page.getByTestId("lineup-confirm").click();
    await expect(page.getByTestId("series-hub")).toBeVisible();

    // the plan survives opening the lineup again
    await page.getByTestId("series-edit-xi").click();
    await expect(page.getByTestId("plan-over-0")).not.toHaveValue("");
    await page.getByTestId("lineup-confirm").click();

    // conditions: a pitch for a T20I (no light select: the T20 day / night gap is inside its noise)
    await expect(page.getByTestId("series-conditions")).toBeVisible();
    await expect(page.getByTestId("series-light")).toHaveCount(0);
    await page.getByTestId("series-pitch").selectOption("turning");
    await expect(page.getByTestId("series-pitch")).toHaveValue("turning");
    await page.getByTestId("series-sim-match").click();
    await expect(page.getByTestId("series-scorecard-0")).toBeVisible({ timeout: 30000 });
  });

  test("tactics: an ODI series offers light and the pitch, kept across a reload", async ({ page }) => {
    await page.getByTestId("international-quick").click();
    await expect(page.getByTestId("series-setup")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("series-format-odi").click();
    await page.getByTestId("series-length-3").click();
    await page.getByTestId("series-role-a").click();
    await page.getByTestId("series-start").click();
    await expect(page.getByTestId("series-hub")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("series-light").selectOption("night");
    await page.getByTestId("series-pitch").selectOption("flat");
    await page.reload();
    await waitForAppReady(page);
    await expect(page.getByTestId("series-light")).toHaveValue("night", { timeout: 20000 });
    await expect(page.getByTestId("series-pitch")).toHaveValue("flat");
    await page.getByTestId("series-sim-match").click();
    await expect(page.getByTestId("series-scorecard-0")).toBeVisible({ timeout: 30000 });
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
    await startLiveMatch(page);
    await stepLive(page, 3);
    await expect(page.getByText(/\/ 50$/)).toBeVisible();
    await page.getByText("Sim Rest").first().click({ timeout: 15000 });
    await page.getByTestId("draft-match-continue").click({ timeout: 30000 });
    const result = page.getByTestId("draft-match-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Player of the match");
  });
});
