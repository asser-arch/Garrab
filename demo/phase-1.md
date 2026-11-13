# Phase 1 demo: try-on core

Everything runs on your laptop with mock AI and no accounts needed. About 5 minutes.

## 1. Run the automated proof (2 minutes)

```bash
corepack enable && pnpm install
pnpm build && pnpm typecheck && pnpm test     # unit, API and privacy tests
pnpm e2e                                      # real browser: widget, iframe, hosted link, kill switch
```

What it proves:

| Test | Shows |
|---|---|
| `apps/api/test/privacy.test.ts` | A photo carrying sentinel bytes (in pixels and in EXIF), sent from a known IP, leaves **no trace** in any D1 table, KV key or log line. EXIF is stripped. The provider's one-time id is not stored. Same for failed and rejected uploads. No table has a column for photos, body measurements or IPs. |
| `apps/api/test/api.test.ts` | Domain lock, revoked keys, every status (only pilot / active / past_due serve), global switch, a valid token stops working the moment an account is suspended, cross-account product access refused, 8 MB limit, real-type check, previews stop at 100 % with no overshoot, failures don't count, daily cap auto-pauses and alerts, rate limit, hosted link, anonymous events. |
| `e2e/tests/tryon.spec.ts` | On a fake Shopify page: button appears → dialog → upload → "AI preview" result with disclaimer and Download → Close → "Your photo has been deleted." Escape closes. Arabic page is right-to-left. Nothing renders (and nothing is logged on the shop's console) for a disabled product or a wrong key. Hosted link with Buy, and the result is unreachable after closing. **Kill switch: the button vanishes from an open page about 30 s after suspension**, the hosted link shows "Temporarily unavailable", and restore brings it back. |

## 2. Click through it yourself (3 minutes)

```bash
# terminal 1 – API on :8787 with the demo brand
cd apps/api
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler d1 execute DB --local --file scripts/seed-dev.sql
pnpm exec wrangler dev --port 8787

# terminal 2 – site (w.js, frame, hosted links) on :8788
cd apps/site && pnpm run build && pnpm exec wrangler dev --port 8788

# terminal 3 – a fake brand shop on :8790
node e2e/shop-server.mjs
```

1. Open http://localhost:8790/products/red-dress → click **Try it on** → upload any photo. (Mock AI returns your photo unchanged.)
2. Open http://localhost:8790/products/red-dress-ar for Arabic.
3. Open http://localhost:8788/t/demo-brand/prodRedDress01 for the hosted (Instagram / WhatsApp) link.
4. Kill it: `pnpm exec wrangler d1 execute DB --local --command "UPDATE accounts SET status='suspended' WHERE id='acc_demo'"` (in `apps/api`). Watch the button disappear from the open shop tab within about 30 s. Set it back to `active` to restore.

## 3. When your Genlook key arrives (staging)

1. Put the key in `apps/api/.dev.vars` as `GENLOOK_API_KEY=gk_...` and set `GENLOOK_MOCK=false` to see real previews locally.
2. Run the **manual delete check** with a consented stock photo:
   `GENLOOK_API_KEY=gk_... pnpm --filter @garrab/api verify:genlook-delete -- ../../fixtures/model-a.jpg`
   It uploads, runs one try-on (about 0.04 USD), calls the delete, and confirms both images stop loading. It writes `docs/privacy/genlook-delete-<date>.json`. Commit that file.
3. Only when that report says **PASS** (and CI is green), turn on the privacy wording:
   `wrangler d1 execute DB --env <staging|prod> --remote --command "UPDATE settings SET value_json='true' WHERE key='privacy_claim_verified'"`
   (Phase 3 moves this to an admin button that refuses unless a PASS report exists.)
