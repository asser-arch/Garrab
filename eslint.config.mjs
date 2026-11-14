// Lint rules. Beyond the recommended sets, two privacy/UX rules from the brief:
//  - the widget never writes to the console (no console noise on brand pages);
//  - the API never uses console directly: only lib/log.ts, which allow-lists fields (no PII).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/public/**", "**/.wrangler/**", "e2e/test-results/**", "e2e/screens/**", "docs/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  { files: ["apps/widget/src/**", "apps/frame/src/**"], rules: { "no-console": "error" } },
  { files: ["apps/api/src/**"], ignores: ["apps/api/src/lib/log.ts"], rules: { "no-console": "error" } },
  {
    files: ["**/test/**", "e2e/**", "**/scripts/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
