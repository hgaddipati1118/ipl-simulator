import { test, expect, type Page } from "@playwright/test";
import { freshGame, pickTeam, openUserLiveMatch } from "./helpers";
import { startLiveMatch } from "./live-helpers";

/**
 * Concussion substitutes in the live match (docs/RULES-MATCH.md section 13.9): with the rate raised through the engine's test
 * hook (setRuleOverrides on the engine module the page itself loaded), a concussion on the user's side asks "Concussion
 * Substitute", lists like-for-like replacements, and the pick comes on ("... comes on as a like-for-like concussion substitute").
 */
async function raiseConcussionRate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map(e => e.name).find(n => /engine\/dist\/index\.js/.test(n));
    if (!url) throw new Error("engine module not found");
    const engine = await import(/* @vite-ignore */ url);
    engine.setRuleOverrides({ concussionPerBall: 0.08 });
  });
}

test("the user picks a concussion substitute in a live match", async ({ page }) => {
  test.setTimeout(180000);
  await freshGame(page);
  await pickTeam(page);
  await openUserLiveMatch(page);
  await startLiveMatch(page);
  await raiseConcussionRate(page);

  const modal = page.getByText("Concussion Substitute", { exact: true });
  const step = page.getByRole("button", { name: "Step", exact: true });
  let picked: string | null = null;
  for (let i = 0; i < 400 && !picked; i++) {
    if (await modal.isVisible().catch(() => false)) {
      const options = page.getByTestId("concussion-sub-options").getByRole("button");
      expect(await options.count()).toBeGreaterThan(1);
      const choice = options.nth(1);
      picked = (await choice.locator("span.font-display").first().textContent())?.trim() ?? null;
      await choice.click();
      break;
    }
    // another decision (toss, bowler, batter, review): answer it one click at a time, so a concussion prompt that lands
    // meanwhile is seen by the check above rather than answered blind with its first option
    if ((await page.locator("div.fixed.inset-0 button:visible").count()) > 0) {
      await page.waitForTimeout(400);
      if (await modal.isVisible().catch(() => false)) continue;
      const batFirst = page.getByText("Bat First", { exact: true }).first();
      if (await batFirst.isVisible().catch(() => false)) await batFirst.click();
      else await page.locator("div.fixed.inset-0 button:visible").first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    if (await step.isEnabled().catch(() => false)) await step.click();
    await page.waitForTimeout(120);
  }
  expect(picked, "a concussion on the user's side").not.toBeNull();
  await expect(modal).toBeHidden({ timeout: 5000 });
  await expect(page.getByText(new RegExp(`${picked} comes on as a like-for-like concussion substitute`)).first()).toBeVisible({ timeout: 10000 });
});
