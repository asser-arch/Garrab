# Garrab: build plan

Status: **draft for approval** (Phase 0). Nothing in Phase 1 starts until Asser approves this file.
Date of research: 13 November 2026. Every external fact below was checked in the provider's current docs that day; sources are in `DECISIONS.md`.

---

## 1. The short version

- **Everything in the brief can be built.** No provider blocks it. There are a few changes, each with a reason (section 3).
- **Genlook reselling looks allowed but needs written confirmation.** Their terms say you must not "resell, sublicense, or provide the Service to third parties except as intended (e.g. offering the widget to your shoppers, or building on the API within your plan)". Garrab builds a product on the API, which is the allowed case. But a done-for-you service for other brands is close enough to the line that you should email Genlook (their startup program contact is `thibault@genlook.app`) and get a yes in writing before the first paying brand. I will keep building; the provider sits behind an interface, so we can swap it if they say no.
- **Your numbers mostly check out.** Gemini 3.1 Flash Image is `gemini-3.1-flash-image` at **0.067 USD** per 1K image. One correction: Gemini 2.5 Flash Image is *deprecated* (shutdown 15 March 2027), not retired yet. We don't use it anyway.
- **Biggest design changes:**
  1. The photo upload step runs in an **iframe on our own domain**, opened by the Shadow-DOM button. Turnstile only allows 10 hostnames per site key, so it cannot run on 150 brand domains. The iframe also means the brand's page scripts can never read the shopper's photo.
  2. The kill-switch status is **not cached in KV**. KV takes up to 60 seconds to spread worldwide and cannot be "purged instantly". Status comes from D1 with a 15-second in-memory cache. Worst case for the button to disappear is about 45 seconds.
  3. **Payment links point to our own `/pay/{token}` page**, which creates a fresh Paymob payment when clicked. The link never expires and always shows the current amount.

---

## 2. Verification report (brief section 14)

| # | Item | Result |
|---|---|---|
| 1 | **Genlook Try-On API** | Base `https://api.genlook.app/tryon/v1`, header `x-api-key`. `POST /try-on/sync` returns the result in one call (about 10 s, waits up to 90 s). Photo can go in the same multipart request (`fileKey`), so nothing is stored on our side. **Delete:** `DELETE /customers/{externalUserId}` removes every photo and result for that ID (returns 204). We send a random single-use `externalUserId` per try-on and delete it right after. **Retention:** `keepForDays` 1, 3 or 7 (we use 1, plus the delete call). **Failed try-ons are refunded** (confirmed). **Limits:** 429 on too many requests or more than 20 try-ons running at once; 10 MB per image; JPEG, PNG, WebP, HEIC. **Training:** "We do not use uploaded photos or generated results to train AI models." **Price:** 0.04 USD pay-as-you-go, from 0.015 USD on a plan. `mock: true` gives free test calls. **Reseller:** see section 1. |
| 2 | **Gemini** | Room preview: `gemini-3.1-flash-image`, 0.067 USD per 1K output image (input 0.50 USD per 1M tokens). A cheaper option exists: `gemini-nano-banana-2.1` at 0.034 USD; I'll compare both in Phase 4 (model name is config). Size finder and product reading: **`gemini-3.5-flash-lite`**, 0.30 USD in / 2.50 USD out per 1M tokens, about **0.001 USD per size answer**. (`gemini-3.1-flash-lite` is a little cheaper but older.) **Data use, paid tier:** "Google doesn't use your prompts … or responses to improve our products." But Google **logs prompts and responses for a limited time** to detect abuse. The privacy page must say this honestly for room photos. |
| 3 | **Paymob** | Create payment: `POST /v1/intention/` (header `Authorization: Token <secret key>`), amount in piastres, `special_reference` = our invoice ID, `notification_url`, `redirection_url`. Customer pays at `https://eg.checkout.paymob.com/?publicKey=…&clientSecret=…`. Callbacks only fire on **success or decline**. **HMAC:** SHA-512 over 20 fixed fields from `obj`, concatenated with no separator, keyed with the HMAC secret, compared with the `?hmac=` query parameter. QuickLink payment links exist too (`POST /api/ecommerce/payment-links`). **Reconciliation:** transaction inquiry by `merchant_order_id`. **Subscriptions:** cancel and webhook-registration endpoints *are* now documented (the brief said they were not), but plans still need the account manager. Not worth it for v1. |
| 4 | **Kashier** | Create payment: `POST /v3/payment/sessions` returns a `sessionUrl`. **Webhook:** HMAC-SHA256 over `data.signatureKeys` sorted alphabetically, values URL-encoded, pairs joined with `&`, keyed with the **Payment API Key**, compared with `x-kashier-signature`. Branch on `data.status` (SUCCESS / FAILURE / PENDING), never on `event`. Kashier treats 200 **and 409** as acknowledged and retries up to 10 times. **No subscriptions API** (confirmed). Card-on-file: save the token with `interactionSource: RECURRING`, then charge it with `CONTAUTH` through Pay with Token. `GET` list-payment-sessions exists, which makes reconciliation easy. |
| 5 | **Product import on real Egyptian stores** | Tested 11 live stores (read-only, 1 product each). **Shopify `products.json`: 8 of 8 worked.** **WooCommerce Store API: 3 of 3 worked.** Some stores use local platforms (e.g. ososs), so the sitemap and JSON-LD fallback is still needed. |
| 6 | **Cloudflare at 150 brands** | Workers Paid: 128 MB memory, CPU up to 5 min (default 30 s), unlimited wall-clock for HTTP, 15 min for cron, 10,000 subrequests per request, 250 cron triggers per account, 100 MB request bodies. D1: 10 GB per database, 1,000 queries per invocation, **Time Travel 30 days**. **Turnstile: 10 hostnames per site key** (forces the iframe design). **KV: changes take up to 60 s to spread worldwide** (forces the D1 status design). Rough load at 150 brands: about 300k config calls per day and about 3k AI calls per day. That is far below every limit. |

---

## 3. Changes to the brief (each also in `DECISIONS.md`)

1. **Iframe for the try-on flow.** `w.js` (Shadow DOM, under 30 KB) detects the product, draws the button and opens a modal holding an iframe from `app.<domain>/frame`. The iframe runs the consent → upload → result flow, Turnstile and the size finder. The hosted link `/t/{brand}/{product}` uses **the same flow code**. One implementation, Turnstile works everywhere, the photo never touches the host page, and host CSP problems shrink to one `frame-src` line. Cost: a few KB more and an extra page load when the shopper clicks (we preload it on hover or touch).
2. **Kill-switch status from D1, not KV.** D1 is the source; each Worker instance caches status for 15 s; the widget keeps config in memory for 30 s. Every AI call reads status from D1 with no cache. KV is still used for the config payload (products list, button text), but never for status.
3. **Our own payment-link page.** `pay.<domain>/i/{invoiceToken}` shows the invoice and a Pay button. The button creates the provider's payment (Paymob intention or Kashier session) at that moment. Both the emailed link and the portal "Pay now" use the same page, so both paths feed the same ledger.
4. **R2 is added**, only for **stock-model test results** (the approval gallery) and invoice PDFs. Never for shopper photos. The privacy test checks this.
5. **HEIC and EXIF are handled in the browser.** The iframe decodes the photo (iOS Safari decodes HEIC), resizes it to at most 1600 px and re-encodes it as JPEG through a canvas. That strips EXIF. The server also removes JPEG metadata segments and rejects files over 8 MB or with the wrong type (magic-byte check, not just the header).
6. **Cron runs every 15 minutes in UTC** and dispatches jobs by **Cairo local time** (`Intl`, `Africa/Cairo`). Egypt uses summer time again since 2023 (UTC+3), so fixed UTC crons would drift by an hour.
7. **Extra preview packs are prepaid.** Buying a pack creates its own invoice; the 100 previews unlock when it is paid. The monthly invoice is the plan price only. This keeps "no credit is ever extended" literally true.
8. **`paid_through` rule:** a payment extends one month from the previous `paid_through`, as the brief says. **Exception:** when reactivating an `expired`, `suspended` past 30 days, or `archived` account, the month starts on the payment date. Otherwise a brand coming back after 3 months would pay and still be 2 months behind.
9. **Invoices are English only.** Arabic shaping in a Worker-generated PDF is fragile. The invoice email can be bilingual.
10. **Admin login:** Cloudflare Access (email one-time PIN, free for up to 50 users). The Worker also checks the Access JWT. Passkey can come in Phase 5.

---

## 4. Architecture

```
 Brand product page                     Our domains (Cloudflare)
 ┌──────────────────────┐
 │ <script w.js>        │─GET /v1/config?key──▶ api.<d>  Worker "api" (Hono)
 │  Shadow-DOM button   │◀─enabled, products,─┤   /v1/config  /v1/tryon  /v1/room
 │  modal ┌──────────┐  │   signed ctx token  │   /v1/size  /v1/events  /healthz
 │        │ iframe   │──┼─POST /v1/tryon─────▶│   /webhooks/paymob|kashier
 │        │ app.<d>/ │  │  (ctx + Turnstile   │   /portal-api/*  /admin-api/*
 │        │ frame    │◀─┼── + photo) image ───┤   cron (*/15) → job dispatcher
 │        └──────────┘  │                     │   queue consumer (imports, tests, email)
 └──────────────────────┘                     │
                                              ├─▶ D1  (ledger, accounts, products, counters)
 Instagram / WhatsApp shopper                 ├─▶ KV  (config payload cache only)
   app.<d>/t/{brand}/{product} (same flow) ───┤─▶ R2  (stock test results, invoice PDFs)
                                              ├─▶ Queues (import, product tests, emails)
 Brand: app.<d>/portal  (React, magic link)   ├─▶ Genlook (clothing, accessories)
 Asser: admin.<d> (React, Cloudflare Access)  ├─▶ Gemini (room preview, size, scoring)
 Public: www.<d> /start /privacy /terms       ├─▶ Paymob / Kashier (payments)
 Pay page: app.<d>/pay/i/{token}              └─▶ Resend (email), Telegram (alerts)
```

**Monorepo:** `apps/{api,widget,frame,portal,admin,site}`, `packages/shared` (plans, Zod schemas, strings, tokens), `packages/providers` (interfaces plus Genlook, Gemini, Paymob, Kashier, Manual, Resend and Telegram, each with a mock). `apps/frame` is new: it holds the try-on flow shared by the widget iframe and the hosted link.

**Deployables (3 Workers per environment):** `api` (all `/v1/*`, webhooks, cron, queues); `site` (one Worker with static assets serving www, `app.<d>` for the frame, hosted links, portal and pay page, and `cdn.<d>/w.js`); `admin` (static assets behind Cloudflare Access). Environments: `dev` (local wrangler with mock providers), `staging` (own D1, KV, R2; Paymob test keys; Genlook real with a low cap), `prod`.

### 4.1 One try-on, step by step

1. `w.js` → `GET /v1/config?key=gk_live_…`. The server checks the key, checks `Origin` against the brand's domains, checks status (D1, 15 s cache) and the global switch. It returns `enabled:false`, or the product list and a **ctx token**: HMAC-signed `{acct, key, origin, exp: now+10 min}`.
2. The shopper clicks → modal → iframe `app.<d>/frame#ctx=…&p=…&lang=ar`. The fragment never reaches server logs.
3. Iframe: consent → photo picked → decode, resize, re-encode (EXIF gone) → Turnstile → `POST /v1/tryon` (multipart: ctx, turnstile, productId, photo).
4. Server, in order: verify ctx signature and expiry → Turnstile → **status from D1 (no cache)** → global switch → previews left this cycle → daily caps → product enabled and approved → rate limit (key and IP, in memory only).
5. Call Genlook `/try-on/sync`, with the photo as a multipart `fileKey`, `externalUserId = random UUID`, `keepForDays: 1`, `aiLabel: false` (we draw our own chip). Fetch the result image into memory and return its bytes.
6. `ctx.waitUntil(DELETE /customers/{uuid})`, retried 3 times. A failed delete raises a Telegram alert.
7. Write a `usage_events` row (account, kind, provider, ok, cost_usd, time) and add to `daily_counters`. **No bytes, no inputs, no IP, no UUID.**
8. The iframe shows a blob URL with the "AI preview" chip and the disclaimer. On close: revoke the blob, clear the state, show "Your photo has been deleted."

### 4.2 Kill switch in every layer
`/v1/config` → `enabled:false` → `w.js` removes itself. AI calls re-check D1 every time. Ctx tokens last 10 min. Hosted pages show "Temporarily unavailable". Domain lock (Origin plus the token's origin claim). Fail closed on any D1 error. Admin Kill / Restore and a global switch. Caps auto-suspend. Status changes write `audit_log` and bump a `status_version` that invalidates the 15 s cache in that Worker instance right away.

**Worst case after a kill:** about 15 s (Worker cache) + 30 s (widget memory) = **about 45 s** for the button to vanish. **0 s** for AI calls to stop.

---

## 5. Data model (D1)

All tables have `id` (ULID text), `created_at`, `updated_at` (UTC ISO). Money is integer **piastres** (EGP × 100). Costs are integer **micro-USD**.

| Table | Key columns | Notes |
|---|---|---|
| `accounts` | slug, name, niche, platform, plan_id, status, status_version, paid_through (date), pilot_started_at, pilot_ends_at, cancel_at_period_end, preview_selector, whatsapp, buy_url_template | `status` ∈ onboarding, pilot, active, past_due, suspended, archived, paused, cancelled, expired |
| `users` | account_id, email, role (owner) | brand people |
| `magic_links` | user_id, email, token_hash, expires_at, used_at | single use, 15 min, hash only |
| `sessions` | user_id, token_hash, expires_at | HttpOnly cookie, 14 days sliding |
| `api_keys` | account_id, prefix, key_hash, revoked_at | shown once; rotatable |
| `domains` | account_id, host, verified_at, install_status, last_checked_at | Origin allow-list and install crawler |
| `leads` | the `/start` form fields, converted_account_id | before an account exists |
| `products` | account_id, external_ref, source (shopify/woo/jsonld/manual), title, url, images_json, description, sizes_json, category, kind (clothing/accessory/decor), content_hash, enabled, approved, needs_review, disabled_reason | |
| `product_fit_profiles` | product_id, content_hash, profile_json, model, created_at | re-made when the hash changes |
| `product_tests` | product_id, fixture_id, r2_key, score, rubric_json, cost_micro_usd | stock models only |
| `onboarding_steps` | account_id, step, state (pending/done/skipped/overridden), entered_at, done_at, actor | resumable state machine |
| `usage_events` | account_id, kind (tryon/room/size/fit_read/test/score), provider, ok, cost_micro_usd, created_at | **no PII by schema** |
| `daily_counters` | account_id, day (Cairo date), metric, count | button_view, try_on_started, … and spend |
| `cycle_usage` | account_id, cycle_start, included, extra, used | the previews meter |
| `invoices` | account_id, number (GRB-2026-0001), kind (plan/pack/setup), period_start, period_end, subtotal, vat_rate_bp, vat, total, status, due_date, pay_token_hash, pdf_r2_key | |
| `invoice_counter` | year, last | gapless numbers |
| `payments` | invoice_id, account_id, provider, provider_txn_id **UNIQUE**, amount, method, status, note, actor | idempotent |
| `webhook_events` | provider, raw_body, headers_json (no auth headers), signature_ok, processed_at, error | stored before processing; can be replayed |
| `notifications` | account_id, channel, template, status, provider_id, sent_at | |
| `audit_log` | account_id, actor (system/admin/brand/cron), action, from_status, to_status, reason, meta_json | |
| `settings` | key, value_json | global switch, caps, FX rate, VAT, privacy-claim flag |
| `cron_runs` | job, started_at, finished_at, ok, error | admin status line |
| `alerts` | kind, account_id, message, resolved_at | |

Indexes on `account_id` everywhere, and on `(account_id, day)`, `(status)`, `(due_date)`, `(provider, provider_txn_id)`. D1 Time Travel gives 30 days of restore. A weekly export to R2 covers older backups.

---

## 6. State machines and schedules

**Onboarding:** `invited → account_created → products_imported → products_tested → products_approved → installed → pilot_live → converted | expired`. Each step is an idempotent function `advance(account)`. It runs from the queue and from the 15-minute cron, so a lost message never stalls a brand. Every step has an admin override.

**Billing status:** `onboarding → pilot → active → past_due → suspended → archived`, plus `paused` (admin) and `cancelled` (brand, takes effect at period end). One function, `transition(account, to, reason, actor)`, checks the move is allowed, writes `audit_log`, bumps `status_version`, and queues the matching email or alert.

**Scheduled jobs** (dispatcher every 15 min; times are Cairo):

| Time | Job |
|---|---|
| every 15 min | onboarding `advance` sweep, retry failed provider deletes, alert checks |
| 02:00 | product re-sync (prices, images, new products), fit-profile refresh |
| 03:00 | install crawler (looks for the script tag on one product page per domain) |
| 04:00 | payment reconciliation (Paymob inquiry for open invoices, Kashier session list) |
| 05:00 | billing run: T-7 invoices, T and T+1/3/5 reminders, `past_due`, `suspended`, `archived`, pilot clock emails (day 1, 7, 12, 14), pilot expiry |
| 06:00 | stuck detector (more than 48 h in an onboarding step) |
| 08:30 | daily digest (email and Telegram) |

---

## 7. Phases

Each phase ends with passing tests, a `demo/phase-N.md` script you can run, and a short note in this file.

**Phase 0: Foundation** *(now)*
pnpm monorepo, TypeScript strict, ESLint, Vitest, CI (typecheck, lint, test, widget size check, `pnpm audit`), `packages/shared` (plans, tokens, strings, Zod schemas), `.env.example`, this plan, `DECISIONS.md`. *Done when you approve this plan.*

**Phase 1: Try-on core**
D1 schema and migrations; `/v1/config`, `/v1/tryon`, `/healthz`; ctx tokens; domain lock; caps and metering; the Genlook provider (real and mock); `w.js` (detection for Shopify, Woo, JSON-LD and data attribute; Shadow DOM; under 30 KB); the iframe flow (EN and AR, accessibility); hosted link page; anonymous events. **Privacy tests:** an automated sentinel test (sentinel bytes and inputs pushed through the whole stack, then every D1 table, KV key, R2 object, queue message and log line is scanned for them) and `scripts/verify-genlook-delete.ts` (real upload → try-on → delete → confirm the image URL is gone). The "not saved on our systems" text only shows when the `privacy_claim_verified` setting is on, and the admin can only turn that on after a recorded delete test passes. *Demo:* a staging test page with a seeded account → "Try it on" → preview.

**Phase 2: Onboarding automation**
`/start` form and admin "Invite brand"; accounts, users, magic links; Resend; importers (Shopify, Woo, sitemap and JSON-LD with `robots.txt`, CSV and form); auto-ranking; product tests with 2 fixtures and Gemini scoring (≥4 on, 3 review, below 3 off) under a budget cap; approval gallery; install steps and copy snippet; install checker and crawler; pilot clock emails; stuck detector; funnel. *Demo:* invite a test brand → it reaches `pilot_live` with no admin clicks.

**Phase 3: Billing and kill switch**
Ledger; invoices and PDFs; pay page; Paymob provider (intention and HMAC); Manual provider; webhooks (store first, then process idempotently, replay button); the status machine; every kill-switch layer; reconciliation; admin console (dashboard, client page, Kill / Restore / Pause, manual payment, resend email, read-only portal view); Telegram alerts; 08:30 digest; Kashier provider. *Demo:* a test brand goes unpaid → suspended → the widget disappears in under 60 s (Playwright measures it) → pay through the link → restored; repeat with portal Pay now.

**Phase 4: Growth features**
Size finder (fit profile, one call, code rules, fallback, Growth only, English only); 30-case evaluation harness and pilot checklist; room preview with Gemini (and the model comparison); aggregate analytics and the pilot results report. *Demo:* the harness passes; a Starter account never shows "Find my size".

**Phase 5: Hardening**
Load test (k6 against staging); security review; cross-account isolation tests on every portal and admin route; `RUNBOOK.md`; backup and restore drill; WordPress plugin; error budget and SLO alerts. *Done when:* 50 brands this week is realistic for one person.

---

## 8. Cost per brand (AI only, at list prices)

| | Starter (250) | Growth (600) | Growth decor (600) |
|---|---|---|---|
| Previews | Genlook 0.04 → **10 USD** | **24 USD** | Gemini 0.067+ → **about 42 USD** |
| Size finder | — | about 0.001 × calls → under 1 USD | — |
| Onboarding tests (once) | about 0.9 USD | about 0.9 USD | about 1.5 USD |

On a Genlook plan, try-ons can drop to 0.015 USD. Cloudflare is about 5 USD per month in total. The EGP/USD rate is a setting you keep up to date; the admin margin view uses it. **Watch-out:** decor on Growth costs about 4 times as much as clothing on Starter for twice the price. Worth checking once real usage is known.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Genlook says no to resale | Written confirmation first; `TryOnProvider` interface; Gemini or another API as fallback |
| Genlook delete call fails silently | Delete after every try-on, retry queue, alert; `keepForDays: 1` as a backstop; manual verify script |
| Quality varies by garment | Automatic tests with scoring; brand approval; "AI preview" chip and disclaimer always shown |
| Host page breaks or blocks us | Fail silent; iframe isolation; no globals; size budget in CI; CSP note in install docs |
| Payment webhooks missed | Store-first webhooks, daily reconciliation, Manual provider, pay page re-checks with the provider |
| Abuse or cost spike | Turnstile, rate limits, per-account and global daily caps → auto-pause and alert |
| Egypt PDPL (Law 151/2020) | Collect no shopper data; plain privacy page; **lawyer review before launch** (your action) |
| Gemini abuse-monitoring retention | Disclosed on `/privacy`; room photos go to Google only |
| Model or price changes | Model names and prices in config; cost logged on every call; monthly review in the runbook |

---

## 10. Accounts and keys you need to create

| What | Where | Used for | Secret name |
|---|---|---|---|
| Cloudflare account, Workers Paid (5 USD) and your domain on Cloudflare | dash.cloudflare.com | everything | `CLOUDFLARE_API_TOKEN` (CI only) |
| Cloudflare Zero Trust (free) | dash → Zero Trust | admin login | — |
| Turnstile site key (hostname `app.<domain>`) | dash → Turnstile | bot check | `TURNSTILE_SECRET` |
| Genlook account and API key, **plus the resale email** | platform.genlook.app | try-on | `GENLOOK_API_KEY` |
| Google AI Studio, **billing enabled** (paid tier) | aistudio.google.com | room, size, scoring | `GEMINI_API_KEY` |
| Paymob merchant (test and live): secret key, public key, HMAC secret, integration IDs (card, wallet) | accept.paymob.com | payments | `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_IDS` |
| Kashier (later): MID, secret key, Payment API key | merchant.kashier.io | payments | `KASHIER_MID`, `KASHIER_SECRET_KEY`, `KASHIER_PAYMENT_API_KEY` |
| Resend: verify your sending domain (SPF, DKIM) | resend.com | email | `RESEND_API_KEY` |
| Telegram bot (@BotFather) and your chat ID | Telegram | alerts | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Free uptime monitor (e.g. UptimeRobot) on `/healthz` | — | uptime | — |
| GitHub Actions secrets for deploys | repo settings | CI deploy | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

Generated by us (no account needed): `CTX_SIGNING_KEY`, `SESSION_SIGNING_KEY`, `PAY_TOKEN_KEY`.

## 11. Missing inputs (I'll use mocks until they arrive)

- `docs/Garrab_Pitch-Kit.docx`: **needed for the Arabic UI strings.** Until then the Arabic strings are marked `DRAFT`, and a test stops a production build from shipping them.
- `docs/Garrab_Pilot-Proposal.docx` (for email wording and terms).
- 2 or more consented stock test photos for `/fixtures`.
- Logo files (SVG). I can draw the mark from the guideline for now.
- Cairo font files (or use Google Fonts; the widget loads the font only inside the iframe).
- Your domain name.

## 12. Questions for you (I'll use the default if you don't answer)

1. **Product limits on paid plans?** The brief only gives the pilot (10). Default: Starter **30**, Growth **100**.
2. **Do failed try-ons count toward the brand's previews?** Default: **no**. Only finished previews count (Genlook refunds us too).
3. **Hosted links: is the domain lock relaxed?** The hosted page runs on our domain, so it works for every active brand. Default: **yes**.
4. **Can one brand have both clothing and home decor?** Default: **yes**, decided per product.
