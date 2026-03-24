import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/engine/src/__tests__/**/*.test.ts",
      "packages/ratings/src/__tests__/**/*.test.ts",
      "integration/**/*.test.ts",
    ],
  },
});
