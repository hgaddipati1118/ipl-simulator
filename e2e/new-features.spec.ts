import { test, expect, type Page } from "@playwright/test";
import { freshGame, pickTeam, openUserLiveMatch } from "./helpers";
import { answerDecisions, startLiveMatch, stepLive, type TossChoice } from "./live-helpers";

/**
 * Open the user's next match live and get it under way: the toss answered with `toss` when the user's side wins it,
 * the buildup's Start Match, one ball bowled and any decision it raised answered. Returns whether the user won the toss.
 */
async function startUserMatch(page: Page, toss: TossChoice = "Bat First"): Promise<boolean> {
  await openUserLiveMatch(page);
  const wonToss = await startLiveMatch(page, toss);
  await stepLive(page, 1);
  await answerDecisions(page);
  return wonToss;
}

test.describe("New Features – Live Match UI", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
    await pickTeam(page);
  });

  test("win probability bar is visible during live match", async ({ page }) => {
    test.setTimeout(120000);
    await startUserMatch(page);

    const bar = page.getByTestId("win-probability");
    await expect(bar).toBeVisible({ timeout: 10000 });
    await expect(bar).toContainText(/\d+%/);
  });

  test("aggression slider is visible during live match when user is batting", async ({ page }) => {
    test.setTimeout(120000);
    // Winning the toss means batting first; losing it, the CPU's choice decides which control the user has
    await startUserMatch(page, "Bat First");
    await expect(page.getByText(/\d+\/\d+/).first()).toBeVisible({ timeout: 10000 }); // the score, e.g. "4/0"

    const aggression = page.getByTestId("batting-aggression");
    const field = page.getByTestId("field-setting");
    await expect(aggression.or(field)).toBeVisible({ timeout: 10000 });
    if (await aggression.isVisible()) {
      // Batting: defend / balance / attack, and a pick takes effect; no field controls
      await expect(field).toBeHidden();
      for (const intent of ["ATK", "DEF"]) {
        const button = aggression.getByRole("button", { name: intent, exact: true });
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
      }
    } else {
      // The CPU won the toss and batted: no batting controls while the user's side is in the field
      await expect(aggression).toBeHidden();
    }
  });

  test("field setting selector is visible on live match page when user is bowling", async ({ page }) => {
    test.setTimeout(120000);
    // Winning the toss means bowling first; losing it, the CPU's choice decides which control the user has
    await startUserMatch(page, "Bowl First");
    await expect(page.getByText(/\d+\/\d+/).first()).toBeVisible({ timeout: 10000 });

    const aggression = page.getByTestId("batting-aggression");
    const field = page.getByTestId("field-setting");
    await expect(aggression.or(field)).toBeVisible({ timeout: 10000 });
    if (await field.isVisible()) {
      // Bowling: the five field settings, and a pick takes effect; no batting controls
      await expect(aggression).toBeHidden();
      for (const setting of ["SPN", "BDY"]) {
        const button = field.getByRole("button", { name: setting, exact: true });
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
      }
    } else {
      // The CPU won the toss and bowled: no field controls while the user's side bats
      await expect(field).toBeHidden();
    }
  });
});

test.describe("New Features – Player Page", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
  });

  test("radar chart SVG is visible on player page", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    // Ratings page → a player's page
    await page.locator("nav").getByText("Ratings").click();
    await page.waitForURL("**/ratings", { timeout: 10000 });
    await page.waitForSelector("table", { timeout: 10000 });
    await page.locator("a[href*='/player/']").first().click();
    await page.waitForURL("**/player/**", { timeout: 10000 });

    // Batting and bowling radars
    await expect(page.getByTestId("radar-chart")).toHaveCount(2, { timeout: 10000 });
    await expect(page.getByTestId("radar-chart").first()).toBeVisible();
  });
});

test.describe("New Features – Bowling Style Badges", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
  });

  test("bowling style info visible on team view page", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);

    await page.locator("nav").getByText("My Team").click();
    await expect(page).toHaveURL(/\/team\//, { timeout: 10000 });

    // The roster table: a full playing squad, with bowling style abbreviations (RF = right-arm fast, OB = off break...)
    const table = page.locator("table");
    await expect(table.locator("tbody tr").nth(10)).toBeVisible({ timeout: 10000 });
    await expect(table.getByRole("cell", { name: /^(RF|RFM|RMF|RM|LF|LFM|LMF|LM|OB|LB|SLA|SLC)$/ }).first()).toBeVisible();
  });
});

test.describe("New Features – Toss Decision", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
  });

  test("toss decision modal appears when applicable in live match", async ({ page }) => {
    test.setTimeout(120000);
    await pickTeam(page);
    await openUserLiveMatch(page);

    // In the user's match: the toss question when the user's side wins it, otherwise the buildup with the CPU's call
    const tossModal = page.getByText("You Won the Toss!");
    const startMatch = page.getByRole("button", { name: "Start Match" });
    await expect(tossModal.or(startMatch)).toBeVisible({ timeout: 15000 });
    if (await tossModal.isVisible()) {
      await expect(page.getByText("Bowl First", { exact: true })).toBeVisible();
      await page.getByText("Bat First", { exact: true }).click();
      await expect(page.getByText(/won the toss and chose to bat first/)).toBeVisible({ timeout: 10000 });
    } else {
      await expect(page.getByText(/won the toss and chose to (bat|bowl) first/)).toBeVisible();
    }

    await startLiveMatch(page);
    await expect(page.getByRole("button", { name: "Sim Rest" })).toBeVisible();
    await expect(page.getByText(/\d+\/\d+/).first()).toBeVisible({ timeout: 10000 });
  });
});
