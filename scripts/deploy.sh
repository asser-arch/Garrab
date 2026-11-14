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

W site deploy --env "$ENV"
W admin deploy --env "$ENV"

node scripts/smoke.mjs "$ENV"
