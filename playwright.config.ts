import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://localhost:3107",
    headless: true,
    channel: process.platform === "win32" ? "chrome" : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER
    ? undefined
    : {
        command:
          "node node_modules/next/dist/bin/next dev --webpack --port 3107 -H 127.0.0.1",
        url: "http://localhost:3107",
        reuseExistingServer: false,
        timeout: 90_000,
        env: {
          BETTER_AUTH_URL: "http://localhost:3107",
          DATABASE_URL: "",
          PGHOST: "",
          LOCAL_DATABASE_PATH: ".data/e2e-postgres",
          NEXT_DIST_DIR: ".next-e2e",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
});
