import { test, expect } from "@playwright/test";
import { freshGame, pickTeam, simulateSeason } from "./helpers";

test.describe("Custom League", () => {
  test.beforeEach(async ({ page }) => {
    await freshGame(page);
  });

  test("Custom button is visible on setup page", async ({ page }) => {
    await expect(page.getByText("Custom")).toBeVisible();
  });

  test("clicking Custom shows the custom league panel", async ({ page }) => {
    await page.getByText("Custom").click();

    await expect(page.getByPlaceholder("My League")).toBeVisible();
    await expect(page.getByText("Apply Custom Rules")).toBeVisible();
    await expect(page.getByText("Real Players")).toBeVisible();
    await expect(page.getByText("CPU Generated")).toBeVisible();
  });

  test("can configure and apply custom rules", async ({ page }) => {
    await page.getByText("Custom").click();

    await page.getByPlaceholder("My League").fill("Test League");

    await page.getByText("Apply Custom Rules").click();

    await expect(page.getByText("Test League").first()).toBeVisible();
  });

  test("can select playoff format: simple bracket", async ({ page }) => {
    await page.getByText("Custom").click();

    await page.getByText("Simple Bracket").click();

    await page.getByText("Apply Custom Rules").click();

    await expect(page.getByText(/simple/i).first()).toBeVisible();
  });

  test("can select no playoffs", async ({ page }) => {
    await page.getByText("Custom").click();

    await page.getByText("No Playoffs").click();

    await page.getByText("Apply Custom Rules").click();

    await expect(page.getByText("None").first()).toBeVisible();
  });

  test("can toggle CPU generated players", async ({ page }) => {
    await page.getByText("Custom").click();

    await expect(page.getByText("Real Players")).toBeVisible();
    await expect(page.getByText("CPU Generated")).toBeVisible();

    await page.getByText("CPU Generated").click();

    await page.getByText("Apply Custom Rules").click();
  });

  test("can select gender options", async ({ page }) => {
    await page.getByText("Custom").click();

    await expect(page.getByText("Combined")).toBeVisible();
    await expect(page.getByText("Real Players")).toBeVisible();
    await expect(page.getByText("CPU Generated")).toBeVisible();
  });

  test("custom league plays through a full season", async ({ page }) => {
    test.setTimeout(300_000);

    await page.getByText("Custom").click();

    await page.locator('input[placeholder="My League"]').fill("MyLeague");

    await page.getByText("Simple Bracket").click();

    await page.getByText("Apply Custom Rules").click();

    await pickTeam(page);

    await expect(page.getByText("Season 1").first()).toBeVisible();

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });

  test("no-playoffs league crowns table topper", async ({ page }) => {
    test.setTimeout(300_000);

    await page.getByText("Custom").click();
    await page.getByText("No Playoffs").click();
    await page.getByText("Apply Custom Rules").click();

    await pickTeam(page);

    await simulateSeason(page);
    await expect(page.getByText("Season 1 Champions")).toBeVisible({ timeout: 10000 });
  });
});
