import { defineConfig } from "@playwright/test";

const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };

export default defineConfig({
  testDir: "./tests",
  workers: 1, // tests share one local D1 database
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: { trace: "off", viewport: { width: 420, height: 860 } },
  webServer: [
    {
      command:
        "pnpm exec wrangler d1 migrations apply DB --local && pnpm exec wrangler d1 execute DB --local --file scripts/seed-dev.sql && pnpm exec wrangler dev --port 8787 --ip 127.0.0.1",
      cwd: "../apps/api",
      url: "http://localhost:8787/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
      env,
    },
    {
      command: "pnpm run build && pnpm exec wrangler dev --port 8788 --ip 127.0.0.1",
      cwd: "../apps/site",
      url: "http://localhost:8788/w.js",
      reuseExistingServer: false,
      timeout: 120_000,
      env,
    },
    { command: "node shop-server.mjs", url: "http://localhost:8790/products/red-dress", reuseExistingServer: false, env },
  ],
});
