# Phase 2 demo: onboarding automation

**Done when:** you invite a test brand and it reaches `pilot_live` without you touching anything. Proven by `e2e/tests/onboarding.spec.ts` (about 26 seconds with mock AI).

## 1. Automated proof

```bash
pnpm install && pnpm build && pnpm typecheck
pnpm test   # 76 API tests incl. importers, robots.txt, magic links, cross-account isolation, pilot clock, stuck detector
pnpm e2e    # 11 browser tests (+1 screenshot run, skipped unless SCREENSHOTS=1)
```

The onboarding browser test does exactly this:

1. **Admin** (only admin action): Invite brand → sign-in link appears instantly (copy, or send on WhatsApp).
2. **Brand** opens the link → signed in, no password.
3. **Automatic:** products imported from the shop's `products.json`, top 10 picked, each tried on 2 stock models, scored. A low-quality product is disabled with a plain reason.
4. **Brand** approves one product, hides another, taps **Done**.
5. **Brand** copies the install line into the shop → **Check installation** → Installed ✓.
6. **Automatic:** pilot starts (status `pilot`, 14-day clock, 300 previews), the button appears on the approved product only.
7. Emails sent at each step: welcome, previews ready, install, pilot started. The audit log shows one admin action: the invite.

## 2. Click through it yourself

Start the local servers **in this order** (parallel `wrangler dev` processes race for the same service-binding socket):

```bash
cd apps/api && pnpm exec wrangler d1 migrations apply DB --local \
  && pnpm exec wrangler d1 execute DB --local --file scripts/seed-dev.sql \
  && pnpm exec wrangler r2 object put garrab-files-dev/fixtures/model-a.png --file ../../e2e/fixtures/synthetic-photo.png --local \
  && pnpm exec wrangler r2 object put garrab-files-dev/fixtures/model-b.png --file ../../e2e/fixtures/synthetic-photo.png --local \
  && pnpm exec wrangler dev --port 8787                     # terminal 1: API
cd apps/site && pnpm run build && pnpm exec wrangler dev --port 8788    # terminal 2: site + portal
cd apps/admin && pnpm run build && pnpm exec wrangler dev --port 8789   # terminal 3: admin
node e2e/shop-server.mjs                                                 # terminal 4: fake shop
```

- Admin: http://localhost:8789 → invite with website `http://127.0.0.1:8790`.
- Open the sign-in link it shows. Emails are captured locally: `pnpm exec wrangler d1 execute DB --local --command "SELECT to_addr, subject FROM dev_outbox"` (in `apps/api`).
- Public form: http://localhost:8788/start
- Portal: http://localhost:8788/portal

## 3. With real keys (staging)

- `RESEND_API_KEY` + a verified sending domain → real emails.
- `GEMINI_API_KEY` → real scoring of test results (`gemini-3.5-flash-lite`, about 0.001 USD each).
- `GENLOOK_API_KEY` → real test try-ons (2 per product, about 0.08 USD per product; capped at 3 USD per brand).
- Upload your 2 consented stock photos: `wrangler r2 object put garrab-files-staging/fixtures/model-a.jpg --file fixtures/model-a.jpg --remote` (and model-b).
- Admin login: put `admin.<domain>` behind Cloudflare Access and set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` on the API.
