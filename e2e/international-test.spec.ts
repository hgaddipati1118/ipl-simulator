/**
 * A Test series on the International page (international.ts, test-match/test-series.ts): start a two-Test series captaining
 * India, simulate the 1st Test (score line, series score, Test stats), play the 2nd live (a few balls, leave and resume it from
 * its IndexedDB save, survive a reload), play it to the end so the series records it, and open both scorecards. Math.random
 * is seeded so the run repeats.
 */
import { test, expect, type Page } from "@playwright/test";

/** Wait for the live Test to settle, answering any decision with the captain's call, until the controls are live again */
async function answerDecisions(page: Page) {
  const modal = page.getByTestId("test-decision");
  const ready = page.locator('[data-testid="test-skip-ball"]:enabled');
  const complete = page.getByTestId("test-complete");
  for (let i = 0; i < 30; i++) {
    await expect(modal.or(ready).or(complete).first()).toBeVisible({ timeout: 30_000 });
    if (!(await modal.count())) return;
    await page.getByTestId("test-choice-cpu").click();
  }
}

test.describe("International Test series", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      let s = 20261108;
      Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("ipl-sim-intl-series-v1"));
    await page.reload();
    await page.waitForSelector("nav", { timeout: 15_000 });
  });

  test("simulate a Test, play one live, resume it, finish it, open the scorecards", async ({ page }) => {
    test.setTimeout(120_000);
    await page.getByTestId("international-quick").click();
    await expect(page.getByTestId("series-setup")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("series-format-test").click();
    await expect(page.getByTestId("series-format-test")).toContainText("Test ratings");
    await page.getByTestId("series-length-2").click();
    await page.getByTestId("series-role-a").click();
    await page.getByTestId("series-start").click();

    // Hub: a two-Test series; simulate the 1st Test
    await expect(page.getByTestId("series-hub")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("series-hub")).toContainText("2-match Test series");
    await expect(page.getByTestId("series-match-0")).toContainText("1st Test");
    await expect(page.getByTestId("series-user-xi")).toContainText("XI (auto)");
    await page.getByTestId("series-sim-match").click();
    await expect(page.getByTestId("series-scorecard-0")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("series-match-0")).toContainText(/won by|drawn|tied/);
    await expect(page.getByTestId("series-match-0")).toContainText(/[A-Z]{2,3} \d+/);
    await expect(page.getByTestId("series-score")).toHaveText(/lead 1-0|level 0-0/);
    await expect(page.getByText("5w", { exact: true })).toBeVisible();
    await expect(page.getByText("NO", { exact: true })).toBeVisible();

    // The 1st Test's scorecard: the Test scorecard from the saved state
    await page.getByTestId("series-scorecard-0").click();
    await expect(page.getByTestId("test-scorecard")).toBeVisible();
    await expect(page.getByTestId("test-result")).toBeVisible();
    await page.getByTestId("test-scorecard-tab-1").click();
    await expect(page.getByTestId("test-fow")).toBeVisible();
    await page.getByText("← Back to the series").click();

    // Play the 2nd Test live: a few balls
    await page.getByTestId("series-play-live").click();
    await expect(page.getByTestId("live-test-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("live-test-page")).toContainText("2nd Test");
    await answerDecisions(page);
    for (let i = 0; i < 4; i++) {
      await page.getByTestId("test-skip-ball").click();
      await answerDecisions(page);
    }
    expect(await page.getByTestId("test-ball").count()).toBeGreaterThanOrEqual(4);
    const score = await page.getByTestId("test-score").innerText();

    // Back to the series and resume: the same match from its save
    await page.getByRole("button", { name: "← Series" }).click();
    await expect(page.getByTestId("series-resume-live")).toBeVisible();
    await page.getByTestId("series-resume-live").click();
    await expect(page.getByTestId("test-score")).toHaveText(score);

    // A reload resumes it too
    await page.reload();
    await expect(page.getByTestId("test-score")).toHaveText(score, { timeout: 20_000 });

    // To the end: the series records the result
    await page.getByTestId("test-auto-decide").check();
    await answerDecisions(page);
    await page.getByTestId("test-skip-match").click();
    await expect(page.getByTestId("test-complete")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("test-continue").click();
    await expect(page.getByTestId("series-hub")).toBeVisible();
    await expect(page.getByTestId("series-scorecard-1")).toBeVisible();
    await expect(page.getByTestId("series-match-1")).toContainText("played live");
    await expect(page.getByTestId("series-score")).toHaveText(/win the series|Series drawn/);

    await page.getByTestId("series-scorecard-1").click();
    await expect(page.getByTestId("test-result")).toBeVisible();
    await expect(page.getByTestId("test-innings-card")).toBeVisible();
  });
});
