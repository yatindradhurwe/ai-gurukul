import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration suites share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/gurukul_test",
      RATE_LIMIT_DISABLED: "true",
      PAYMENT_WEBHOOK_SECRET: "test-webhook-secret",
      AI_PROVIDER: "mock",
    },
  },
});
