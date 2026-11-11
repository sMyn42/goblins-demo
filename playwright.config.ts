import { defineConfig, devices } from "@playwright/test";
import "./src/server/env";

const production = process.env.E2E_PRODUCTION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Set TEST_DATABASE_URL to a dedicated, migrated PostgreSQL database before running browser tests.");
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [{
    command: production ? "npm start -- --port 3100" : "npm run dev -- --port 3100",
    url: "http://localhost:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { APP_MODE: "test", OCR_PROVIDER: "mock", GRADING_PROVIDER: "mock", DATABASE_URL: databaseUrl, APP_ORIGIN: "http://localhost:3100", NEXT_TELEMETRY_DISABLED: "1", STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: ".data/e2e-images" },
  }, {
    command: production ? "node dist/worker.mjs" : "npm run worker",
    url: "http://localhost:3120/ready", reuseExistingServer: false, timeout: 60000,
    env: { APP_MODE: "test", DATABASE_URL: databaseUrl, PORT: "3120", OCR_PROVIDER: "mock", GRADING_PROVIDER: "mock", MOCK_LATENCY_MS: "0", MOCK_FAILURE_RATE: "0", STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: ".data/e2e-images", WORKER_POLL_MS: "100" },
  }],
});
