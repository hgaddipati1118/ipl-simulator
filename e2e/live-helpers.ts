import type { Page } from "@playwright/test";

export type TossChoice = "Bat First" | "Bowl First";

/**
 * Get a live match past its pre-match screens: the buildup's "Start Match" or, when the user's side wins the toss,
 * the bat / bowl choice (which covers the page, so "Sim Rest" can't be clicked until it is answered).
 * Retries briefly because the page can re-render right after mounting; a match already under way passes straight through.
 * Returns whether the toss question was asked (the user's side won the toss and chose `toss`).
 */
export async function startLiveMatch(page: Page, toss: TossChoice = "Bat First"): Promise<boolean> {
  const startBtn = page.getByRole("button", { name: "Start Match" }).first();
  const tossBtn = page.getByText(toss, { exact: true }).first();
  await startBtn.or(tossBtn).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  let wonToss = false;
  for (let i = 0; i < 6; i++) {
    if (await tossBtn.isVisible()) {
      await tossBtn.click().catch(() => {});
      wonToss = true;
    } else if (await startBtn.isVisible()) await startBtn.click().catch(() => {});
    await page.waitForTimeout(700);
    if (!(await startBtn.isVisible()) && !(await tossBtn.isVisible())) break;
  }
  return wonToss;
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
  // Continue is a client-side navigation: wait for it, so a caller reading page.url() doesn't still see the match
  await page.waitForURL(url => !url.pathname.startsWith("/live-match/"), { timeout: 15000 });
}

/** A decision modal (toss, bowler, batter, review) is a full-screen overlay with buttons; a DRS verdict has none */
const decisionChoices = (page: Page) => page.locator("div.fixed.inset-0 button:visible");

/** Answer every decision the live page is asking the user with its first option (Bat First for a toss) */
export async function answerDecisions(page: Page): Promise<void> {
  for (let i = 0; i < 10 && (await decisionChoices(page).count()) > 0; i++) {
    const batFirst = page.getByText("Bat First", { exact: true }).first();
    if (await batFirst.isVisible().catch(() => false)) await batFirst.click();
    else await decisionChoices(page).first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

/** Bowl `balls` balls one at a time with "Step", answering any decision on the way */
export async function stepLive(page: Page, balls: number): Promise<void> {
  for (let i = 0; i < balls * 4 && balls > 0; i++) {
    if ((await decisionChoices(page).count()) > 0) {
      await answerDecisions(page);
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
