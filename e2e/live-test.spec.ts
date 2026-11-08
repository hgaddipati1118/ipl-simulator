/**
 * Smoke test for the live Test screen on its dev route (/live-test: unlinked, kept for this seeded test; the game reaches Tests
 * through the International series, e2e/international-test.spec.ts), pages/LiveTestPage.tsx: a seeded India v England Test with the
 * user captaining India. The toss call, ball by ball and skipping ahead, the user's decisions, the captain panel, the
 * scorecard tab, saving and resuming, playing to a result; and an instant Test's scorecard.
 */
import { test, expect, type Page } from "@playwright/test";

const LIVE = "/live-test?home=India&away=England&user=home&seed=1&start=live";

/**
 * Wait for the match to settle after an action (long skips run a moment later), answering any decision it stops on with the
 * captain's call, until the controls are live again or the match is over.
 */
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

test.describe("Live Test", () => {
  test("play, skip, decide, save and resume, finish", async ({ page }) => {
    await page.goto(LIVE);
    await expect(page.getByTestId("live-test-page")).toBeVisible({ timeout: 30_000 });

    // seed 1: India win the toss and the user calls it
    await expect(page.getByTestId("test-decision")).toBeVisible();
    await page.getByTestId("test-choice-bat").click();
    await expect(page.getByTestId("test-decision")).toHaveCount(0);
    await expect(page.getByTestId("test-status")).toContainText("India batting first");

    // ball by ball, then an over
    await page.getByTestId("test-skip-ball").click();
    await expect(page.getByTestId("test-ball")).toHaveCount(1);
    await page.getByTestId("test-skip-over").click();
    await answerDecisions(page);
    expect(await page.getByTestId("test-ball").count()).toBeGreaterThan(1);

    // the captain panel while batting: approach and declare are there
    await expect(page.getByTestId("test-captain")).toContainText("India batting");
    await page.getByTestId("test-approach-attack").click();
    await expect(page.getByTestId("test-approach-attack")).toHaveClass(/border-orange-500/);
    await expect(page.getByTestId("test-declare")).toBeVisible();

    // a session moves the clock (a decision on the way stops the skip there: answer it and skip on)
    const before = await page.getByTestId("test-session").innerText();
    for (let i = 0; i < 8 && (await page.getByTestId("test-session").innerText()) === before; i++) {
      await page.getByTestId("test-skip-session").click();
      await answerDecisions(page);
    }
    await expect(page.getByTestId("test-session")).not.toHaveText(before);

    // the scorecard tab
    await page.getByTestId("test-tab-scorecard").click();
    await expect(page.getByTestId("test-scorecard")).toBeVisible();
    await expect(page.getByTestId("test-innings-card")).toBeVisible();
    await page.getByTestId("test-tab-commentary").click();

    // saved automatically (at once on leaving): leave, resume from the setup screen, same score
    const score = await page.getByTestId("test-score").innerText();
    await page.getByRole("button", { name: "Leave" }).click();
    await expect(page.getByTestId("live-test-resume")).toBeVisible();
    await page.getByTestId("live-test-resume").click();
    await expect(page.getByTestId("test-score")).toHaveText(score);

    // to the end with the captain answering the decisions
    await page.getByTestId("test-auto-decide").check();
    await answerDecisions(page);
    await page.getByTestId("test-skip-match").click();
    await expect(page.getByTestId("test-complete")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("test-view-scorecard").click();
    await expect(page.getByTestId("test-result")).toBeVisible();
  });

  test("an instant Test shows its scorecard", async ({ page }) => {
    await page.goto("/live-test?home=Australia&away=South%20Africa&seed=4&start=instant");
    await expect(page.getByTestId("test-scorecard")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("test-result")).toBeVisible();
    await expect(page.getByTestId("test-fow")).toBeVisible();
  });
});
