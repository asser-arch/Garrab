#!/usr/bin/env bash
# Deploy one environment: provision → migrate → API → generated secrets → site → admin → smoke test.
# Usage: scripts/deploy.sh staging|prod   (needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; run after `pnpm build`)
set -euo pipefail
ENV="${1:?usage: deploy.sh staging|prod}"
cd "$(dirname "$0")/.."
W() { (cd "apps/$1" && shift && pnpm exec wrangler "$@"); }

node scripts/cf-provision.mjs "$ENV"
W api d1 migrations apply DB --env "$ENV" --remote
W api deploy --env "$ENV"

# Secrets nobody needs to know: generated once, never overwritten (rotating them would log everyone out).
have=$(W api secret list --env "$ENV" --format json 2>/dev/null || echo '[]')
node - "$ENV" "$have" > "$RUNNER_TEMP/secrets.json" <<'JS'
const [env, have] = process.argv.slice(2);
const names = new Set(JSON.parse(have).map((s) => s.name));
const rand = () => require("node:crypto").randomBytes(48).toString("base64url");
const want = { CTX_SIGNING_KEY: rand, TELEGRAM_CALLBACK_KEY: rand, TELEGRAM_WEBHOOK_SECRET: rand };
// Cloudflare's public Turnstile test secret (always passes) until the real widget is set: staging only.
if (env === "staging") want.TURNSTILE_SECRET = () => "1x0000000000000000000000000000000AA";
const out = {};
for (const [k, f] of Object.entries(want)) if (!names.has(k)) out[k] = f();
console.log(JSON.stringify(out));
console.error(`secrets to add: ${Object.keys(out).join(", ") || "none"}`);
JS
if [ "$(cat "$RUNNER_TEMP/secrets.json")" != "{}" ]; then W api secret bulk "$RUNNER_TEMP/secrets.json" --env "$ENV"; fi
rm -f "$RUNNER_TEMP/secrets.json"

# Provider keys kept as GitHub secrets: synced to the Worker on every deploy (so replacing one in GitHub
# is all it takes to rotate it). Unset ones are skipped and the app keeps using its mock or fallback.
node -e '
const names = ["GENLOOK_API_KEY", "GEMINI_API_KEY", "RESEND_API_KEY", "OPERATOR_EMAIL", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"];
const out = {};
for (const n of names) if (process.env[n]) out[n] = process.env[n];
console.error(`provider keys to sync: ${Object.keys(out).join(", ") || "none"}`);
console.log(JSON.stringify(out));
' > "$RUNNER_TEMP/keys.json"
if [ "$(cat "$RUNNER_TEMP/keys.json")" != "{}" ]; then W api secret bulk "$RUNNER_TEMP/keys.json" --env "$ENV"; fi
rm -f "$RUNNER_TEMP/keys.json"
node scripts/check-keys.mjs

# Telegram (GitHub secrets TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID): token and chat id are always synced;
# the webhook secret is replaced together with the webhook itself, so the two always match.
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  # Never blocks the deploy: a Telegram problem is reported as a warning.
  if node scripts/telegram-connect.mjs plan "$ENV" "$RUNNER_TEMP/tg.json"; then
    W api secret bulk "$RUNNER_TEMP/tg.json" --env "$ENV"
    node scripts/telegram-connect.mjs hook "$ENV" "$RUNNER_TEMP/tg.json" || echo "::warning::Telegram webhook step failed"
  fi
  rm -f "$RUNNER_TEMP/tg.json" "$RUNNER_TEMP/tg.json.meta"
else
  echo "Telegram not configured (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID GitHub secrets): skipping"
fi

W site deploy --env "$ENV"
W admin deploy --env "$ENV"

node scripts/smoke.mjs "$ENV"
