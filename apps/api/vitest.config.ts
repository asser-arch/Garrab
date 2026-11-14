import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            APP_ORIGIN: "https://app.test",
            MOCK_TURNSTILE: "pass",
            GENLOOK_API_KEY: "",
            GEMINI_API_KEY: "",
            ADMIN_DEV_TOKEN: "test-admin-token-123456",
            TELEGRAM_WEBHOOK_SECRET: "test-telegram-secret-abcdef",
            TELEGRAM_CHAT_ID: "424242",
            TELEGRAM_BOT_TOKEN: "",
            INSTAPAY_IPA: "asserrostom@instapay",
            OPERATOR_EMAIL: "ops@garrab.example",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
