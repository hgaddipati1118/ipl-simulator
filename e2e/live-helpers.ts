import type { Page } from "@playwright/test";

/**
 * Get a live match past its pre-match screens: the buildup's "Start Match" or, when the user's side wins the toss,
 * the bat / bowl choice (which covers the page, so "Sim Rest" can't be clicked until it is answered).
 * Retries briefly because the page can re-render right after mounting; a match already under way passes straight through.
 */
export async function startLiveMatch(page: Page): Promise<void> {
  const startBtn = page.getByRole("button", { name: "Start Match" }).first();
  const batFirst = page.getByText("Bat First", { exact: true }).first();
  await startBtn.or(batFirst).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    if (await batFirst.isVisible()) await batFirst.click().catch(() => {});
    else if (await startBtn.isVisible()) await startBtn.click().catch(() => {});
    await page.waitForTimeout(700);
    if (!(await startBtn.isVisible()) && !(await batFirst.isVisible())) break;
  }
}

/**
 * Play a live match out from wherever it is: past the pre-match screens, "Sim Rest", then the result panel's way back
 * ("Continue" in a career match; older builds said "Back to Season").
 */
export async function finishLiveMatch(page: Page): Promise<void> {
  await startLiveMatch(page);
  await page.getByText("Sim Rest").first().click({ timeout: 10000 });
  const done = page.getByRole("button", { name: /^(Continue|Back to Season)$/ }).first();
  await done.waitFor({ timeout: 30000 });
  await done.click();
}
