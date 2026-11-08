import { defineConfig, devices } from "@playwright/test";

/** E2E_PORT runs the app on another port (several checkouts on one machine); default 3850 */
const port = Number(process.env.E2E_PORT ?? 3850);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: port === 3850 ? "npm run dev" : `npm run dev --workspace=packages/app -- --port ${port} --strictPort`,
    port,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
