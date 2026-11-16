import { defineConfig } from "@playwright/test";

// The local servers need no internet (all providers are mocked). Strip any outbound proxy so
// workerd reaches the fake shop on 127.0.0.1 directly (workerd ignores NO_PROXY).
const env: Record<string, string> = { ...(process.env as Record<string, string>), WRANGLER_SEND_METRICS: "false", CI: "1" };
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];

export default defineConfig({
  testDir: "./tests",
  workers: 1, // tests share one local D1 database
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  reporter: [["list"]],
  use: { trace: "off", viewport: { width: 420, height: 860 } },
  webServer: [
    {
      command:
        "pnpm exec wrangler d1 migrations apply DB --local && pnpm exec wrangler d1 execute DB --local --file scripts/seed-dev.sql && pnpm exec wrangler r2 object put garrab-files-dev/fixtures/model-a.png --file ../../e2e/fixtures/synthetic-photo.png --local && pnpm exec wrangler r2 object put garrab-files-dev/fixtures/model-b.png --file ../../e2e/fixtures/synthetic-photo.png --local && pnpm exec wrangler r2 object put garrab-files-dev/fixtures/room-a.png --file ../../e2e/fixtures/synthetic-photo.png --local && pnpm exec wrangler r2 object put garrab-files-dev/fixtures/room-b.png --file ../../e2e/fixtures/synthetic-photo.png --local && pnpm exec wrangler dev --port 8787 --ip 127.0.0.1",
      cwd: "../apps/api",
      url: "http://localhost:8787/healthz",
      reuseExistingServer: false,
      timeout: 240_000,
      env,
    },
    {
      command: "pnpm run build && node ../../e2e/wait-for.mjs http://127.0.0.1:8787/healthz && pnpm exec wrangler dev --port 8788 --ip 127.0.0.1",
      cwd: "../apps/site",
      url: "http://localhost:8788/w.js",
      reuseExistingServer: false,
      timeout: 240_000,
      env,
    },
    {
      command: "pnpm run build && node ../../e2e/wait-for.mjs http://127.0.0.1:8788/w.js && pnpm exec wrangler dev --port 8789 --ip 127.0.0.1",
      cwd: "../apps/admin",
      url: "http://localhost:8789/",
      reuseExistingServer: false,
      timeout: 240_000,
      env,
    },
    { command: "node shop-server.mjs", url: "http://localhost:8790/products/red-dress", reuseExistingServer: false, env },
  ],
});
