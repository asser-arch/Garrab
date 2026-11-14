# Decisions

One line per decision: **what** — *why* — source if verified. Newest at the bottom of each section.

## Verified facts (brief section 14 and every VERIFY)

- **Genlook API:** base `https://api.genlook.app/tryon/v1`, auth header `x-api-key` — docs.genlook.app/docs/tryon-api/introduction (13 Nov 2026).
- **Genlook sync try-on:** `POST /try-on/sync`, waits up to 90 s, 200 with `resultImageUrl` (a temporary signed URL), or 202 to poll `GET /generations/:id` — docs …/endpoints/create-try-on-sync.
- **Genlook photo in the request:** `person.image.source.fileKey` with multipart bytes, so no public URL or prior upload is needed — docs …/endpoints/create-try-on.
- **Genlook delete:** `DELETE /customers/{externalUserId}` deletes every photo and result for that ID, returns 204; only data sent with an `externalUserId` can be targeted — docs …/endpoints/delete-customer.
- **Genlook retention:** `keepForDays` 1, 3 or 7, account default 7; terms say shopper photos are deleted "within the configured retention window (7 days or less)" — docs and genlook.app/terms §5.
- **Genlook refunds:** failed generations are refunded; 1 credit per try-on, +1 at 2K, 2 for multi-product — docs …/errors and …/introduction.
- **Genlook limits:** 429 `RATE_LIMITED` (and more than 20 concurrent try-ons); 10 MB; JPEG, PNG, WebP, HEIC; 402 `INSUFFICIENT_CREDITS` — docs …/introduction.
- **Genlook training:** "We do not use uploaded photos or generated results to train AI models." — genlook.app/terms §5.
- **Genlook price:** 0.04 USD pay-as-you-go, from 0.015 USD on a plan, 10 free credits, `mock: true` is free — docs …/introduction and …/startup-program.
- **Genlook resale:** terms §6 forbid "resell, sublicense, or provide the Service to third parties except as intended (e.g. … building on the API within your plan)". Garrab = building on the API → **appears allowed; get written confirmation from Genlook before the first paying brand** (contact in their startup-program page).
- **Genlook non-wearables:** a non-wearable product returns the person photo unchanged and costs no credit — docs …/create-try-on. Home decor therefore must go to Gemini, not Genlook.
- **Gemini room model:** `gemini-3.1-flash-image`, 0.067 USD per 1K output image, input 0.50 USD per 1M — ai.google.dev/gemini-api/docs/pricing (13 Nov 2026).
- **Gemini 2.5 Flash Image** is deprecated, shutdown 15 March 2027 (the brief said "retired") — same page.
- **Cheaper image option:** `gemini-nano-banana-2.1` at 0.0336 USD per 1K; compare in Phase 4 — same page.
- **Gemini text model:** `gemini-3.5-flash-lite`, 0.30 USD in / 2.50 USD out per 1M (paid) — same page.
- **Gemini paid-tier data:** "Google doesn't use your prompts … or responses to improve our products"; prompts and responses are logged "for a limited period of time" for abuse detection — ai.google.dev/gemini-api/terms.
- **Paymob create payment:** `POST /v1/intention/`, `Authorization: Token <secret>`, `amount` in cents, `currency`, `payment_methods` (integration IDs), `special_reference`, `notification_url`, `redirection_url`, `expiration` — developers.paymob.com …/intention-apis/create-intention (updated 15 Oct 2026).
- **Paymob checkout:** `https://eg.checkout.paymob.com/?publicKey=…&clientSecret=…` — …/checkout-experiences/unified-checkout-redirection.
- **Paymob callback HMAC:** SHA-512, HMAC secret; concatenate `amount_cents, created_at, currency, error_occured, has_parent_transaction, id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded, is_standalone_payment, is_voided, order.id, owner, pending, source_data.pan, source_data.sub_type, source_data.type, success` from `obj`, no separator; compare with the `hmac` query parameter — …/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback.
- **Paymob callbacks** fire only on success or decline; never update state from the browser redirect — …/transaction-callbacks.
- **Paymob reconciliation:** `POST /api/ecommerce/orders/transaction_inquiry` by `merchant_order_id` (= our `special_reference`) — …/transaction-inquiry.
- **Paymob subscriptions:** cancel (`POST /api/acceptance/subscriptions/{id}/cancel`) and register-webhook are now documented; plans still need the account manager → not used in v1.
- **Kashier sessions:** `POST /v3/payment/sessions` with `Authorization: <secret>`, returns `sessionUrl`; `serverWebhook` per request — kashier.io/developers and developers.kashier.io.
- **Kashier webhook signature:** sort `data.signatureKeys`, URL-encode values only, join `k=v` with `&`, HMAC-SHA256 with the **Payment API Key**, compare with `x-kashier-signature`; branch on `data.status` — developers.kashier.io/docs/webhooks.
- **Kashier acknowledgement:** 200 or 409 count as acknowledged; up to 10 retries over about 1.5 days; 30 s timeout — same page.
- **Kashier has no subscriptions API**; save the card with `interactionSource: RECURRING`, charge it with `CONTAUTH` through Pay with Token — developers.kashier.io/docs/accept-payments/recurring.
- **Kashier reconciliation:** `GET` list payment sessions exists — developers.kashier.io/llms.txt (API reference).
- **Shopify `products.json`:** reachable on 8 of 8 tested Egyptian stores (hawaaclothing, hayal-eg, hejabiegypt, hijab-boutique, hbshop.co, kiabi.eg, twentyseven-eg, rebelcairo) — live GET, 13 Nov 2026.
- **WooCommerce Store API `/wp-json/wc/store/v1/products`:** reachable on 3 of 3 (splitstores, abayajudi, alamalshop) — live GET, 13 Nov 2026.
- **Cloudflare Workers Paid:** 128 MB, CPU up to 5 min, cron 15 min wall time, 10,000 subrequests, 250 crons per account, 100 MB bodies — developers.cloudflare.com/workers/platform/limits.
- **D1:** 10 GB per database, 1,000 queries per invocation, 100 bound params, Time Travel 30 days — developers.cloudflare.com/d1/platform/limits.
- **Turnstile:** 10 hostnames per site key (Enterprise 200), no wildcard option — developers.cloudflare.com/turnstile/…/hostname-management.

## Architecture

- **Try-on flow runs in an iframe on `app.<domain>`**, opened by the Shadow-DOM button — *Turnstile can't cover 150 brand hostnames, and the iframe keeps the photo away from host-page scripts.*
- **Widget iframe and hosted link share one flow app (`apps/frame`)** — *one implementation, one set of tests.*
- **Kill-switch status read from D1 with a 15 s per-instance cache; KV not used for status** — *KV changes take up to 60 s to spread and can't be purged instantly; D1 reads are cheap at our volume.*
- **Every AI call reads status from D1 uncached** — *never trust the widget or a cache on a paid call.*
- **Widget config TTL 30 s in memory** — *15 + 30 = about 45 s worst case, inside the 60 s target.*
- **KV only caches the config payload (products, labels)** — *the hot path stays fast without touching status.*
- **Ctx token = HMAC-SHA256 over `{acct,key,origin,exp}`, 10 min, sent in the URL fragment** — *signed, short-lived, never in server logs.*
- **Our own pay page creates the provider payment on click** — *links never expire; both payment paths use one code path.*
- **R2 added, only for stock-model test results and invoice PDFs** — *the approval gallery needs stored images; shopper images never go there (privacy test enforces it).*
- **Genlook: one random `externalUserId` per try-on, then `DELETE /customers/{id}`; `keepForDays: 1` as a backstop** — *the only documented way to delete on demand.*
- **Genlook: we fetch the result into memory and return the bytes; we never send the signed URL to the browser** — *the shopper never sees a provider URL, and we can delete straight after.*
- **Genlook `aiLabel: false`, `watermark: false`; we draw our own "AI preview" chip** — *brand look and feel.*
- **Genlook product `externalId` = `{accountId}_{productId}`, sent inline the first time and as a reference afterwards; resend inline on `PRODUCT_NOT_FOUND`** — *faster try-ons, per the docs.*
- **Home decor uses Gemini; clothing and accessories use Genlook** — *Genlook returns non-wearables unchanged.*
- **Photo decoded, resized (1600 px max) and re-encoded to JPEG in the browser; server strips JPEG APP segments and checks magic bytes** — *EXIF removal and HEIC support with no image library in the Worker.*
- **Cron every 15 min (UTC) → dispatcher by Cairo local time via `Intl`** — *Egypt has had summer time again since 2023.*
- **Queues for imports, product tests and emails; the 15-min sweep re-drives anything stuck** — *nothing can silently stall.*
- **Money in integer piastres, AI cost in integer micro-USD** — *no float rounding in the ledger.*
- **IDs are ULIDs** — *sortable, no counters to collide.*
- **Invoice numbers `GRB-YYYY-NNNN` from a counter row updated in the same D1 batch** — *sequential and gapless.*
- **Invoice PDFs: English only, made with `pdf-lib`** — *works in Workers; Arabic shaping in PDF is fragile.*
- **Admin behind Cloudflare Access (email OTP) + Access JWT check in the Worker** — *free, nothing to build, strong enough; passkey later.*
- **Rate limits use the Workers Rate Limiting binding (IP and key are in-memory keys, never stored)** — *meets "no IP in any log or table".*
- **Workers Logs with a JSON logger that refuses unknown fields** — *PII can't leak in by accident.*
- **Tests: Vitest with `@cloudflare/vitest-pool-workers` (real D1, KV, R2 and Queues in Miniflare); Playwright against `wrangler dev` with mock providers** — *tests run against the real runtime.*

## Product and billing rules

- **Extra preview packs are prepaid, on their own invoice; previews unlock when paid** — *"no credit is ever extended"; resolves the brief's "invoice includes packs used".*
- **`paid_through` moves +1 month from the previous `paid_through`; on reactivation from expired, archived or long-suspended it starts on the payment date** — *otherwise a returning brand pays and is still behind.*
- **Usage cycle = billing period (`paid_through − 1 month` → `paid_through`); pilot cycle = the 14 days** — *one meter, one reset rule.*
- **Only finished previews count toward the allowance (default; question 2 in PLAN)** — *the provider refunds failures too.*
- **"Not saved on our systems" is shown only when the `privacy_claim_verified` setting is on, and it can only be turned on after a recorded passing delete test** — *the brief's gate, made mechanical.*
- **Arabic strings are marked DRAFT until the Pitch Kit arrives; a test blocks a production build that contains DRAFT strings** — *the brief requires the Pitch Kit wording.*
- **Product limits on paid plans default to Starter 30 and Growth 100 (question 1 in PLAN)** — *the brief doesn't say; the values live in `plans.ts`.*
- **VAT rate is a setting, default 0, shown only if above 0** — *per the brief.*

## Change: InstaPay replaces Paymob (approved 13 Nov 2026)

- **Paymob is dropped; brands pay over InstaPay** — *Asser's decision when approving the plan.* The Paymob facts above stay as research history only.
- **InstaPay has no merchant API or webhook of its own** — instapay.eg (an app with an Instant Payment Address, IPA); checked 13 Nov 2026.
- **Kashier can collect InstaPay:** `POST /v3/orders` with `paymentMethod.type: "instapay"` and `apiOperation` `GENERATE_QR` or `INITIATE_R2P` (`payerAddress`, required `validity`), signed with `Kashier-Hash`; success comes on the standard webhook as `status: SUCCESS`, code `00`; no tokenization or recurring on this rail — developers.kashier.io/docs/accept-payments/instapay.
- **Two InstaPay providers behind `BillingProvider`: `instapay_direct` (Asser's IPA + "I've paid" + one-tap Telegram confirm) and `kashier_instapay` (QR or request-to-pay, confirmed by webhook)** — *direct works on day one with no fees; Kashier removes the tap once Kashier enables the rail.*
- **Default provider: `instapay_direct`; switch with the `billing_provider` setting** — *no rebuild to move to the automatic path.*
- **An "I've paid" claim holds suspension for at most 48 h; reminders to Asser every 12 h; "Not received" removes the hold** — *a false claim can't buy more than 2 days.*
- **Telegram confirm buttons use a callback with a single-use signed token, checked against `TELEGRAM_CHAT_ID`** — *only Asser's chat can confirm a payment.*
- **Card-on-file auto-charge (later phase) goes through Kashier `CONTAUTH`** — *InstaPay has no recurring.*

## Phase 1 build

- **Tests run in the real Workers runtime with `@cloudflare/vitest-plugin` 1.4.11** — *`@cloudflare/vitest-pool-workers` is deprecated and renamed; the plugin needs Vitest 4.1+, so the repo moved to Vitest 4.1.12.*
- **Dependencies pinned to versions at least two weeks old** (hono 4.13.14, wrangler 4.156.0, zod 4.6.7, esbuild 0.28.2, workers-types 5.20261030.1, @playwright/test 1.63.0 to match the pre-installed browser) — *avoid fresh, unproven releases.*
- **Providers live in `apps/api/src/providers` for now, not a separate package** — *one consumer; split when the admin needs them.*
- **Genlook `person.keepHeadCovering: true` unless the product is sold with headwear (`products.includes_headwear`)** — *hijab-wearing shoppers keep their own head covering; placement in the body is per the docs and is checked by the manual verify script.*
- **One-time Genlook id is stored only if the delete fails (`pending_deletes`), retried every 15 min, alert raised** — *a failed delete can't be forgotten; the id is random and never linked to a person.*
- **Preview allowance is reserved with one conditional UPDATE (`used < included + extra`) before the AI call and released on failure** — *no overshoot under concurrent requests; failures never count.*
- **Per-account daily cap → status `paused` + alert; global spend cap → `global_kill` + alert** — *the brief's "auto-pauses and alerts"; restore is a deliberate act.*
- **`/v1/config` sends CORS even on refusals (body is just `{enabled:false}`)** — *otherwise the browser prints a CORS error on the brand's page ("no console noise"); a refusal leaks nothing.*
- **Widget re-checks config every 30 s while the tab is visible** — *the kill switch removes the button from pages left open; measured about 30 s in e2e.*
- **Widget skips home-decor products until Phase 4 (room preview)** — *the API returns `not_supported` for decor until then.*
- **Widget does not load the Cairo font on brand pages; the iframe does** — *keeps w.js at about 4 KB and looks native to each shop; the font file is only fetched when the dialog opens.*
- **Frame focuses the heading on each screen, not the main button** — *screen readers announce the step; no heavy focus ring on open; Tab reaches the button next.*
- **Hosted pages may not be framed (`frame-ancestors 'none'`); `/frame` may be framed by any site** — *the widget needs to embed `/frame` on every brand domain; the domain lock is enforced by the API token, not by framing rules.*
- **Ctx token passed in the URL fragment and removed from history on load** — *never sent to servers, never left in the address bar.*

## Provider choice and bake-off (14 Nov 2026)

- **Google has a dedicated try-on model, `virtual-try-on-001` on Vertex AI, 0.06 USD per image** — cloud.google.com/model-garden/pricing; request `instances[].personImage` + `productImages`, response `predictions[].bytesBase64Encoded`.
- **Gemini image models now use the Interactions API (`POST /v1beta/interactions`, header `Api-Revision: 2026-05-20`) and store requests by default; `store: false` opts out** — ai.google.dev/gemini-api/docs/interactions. *Every Gemini call that carries a shopper or room photo sends `store: false`; a unit test pins it.*
- **Genlook stays the default for clothing and accessories; Gemini for home decor; Vertex as fallback** — *Genlook is cheapest, refunds failures, has a delete call and a hijab setting; quality is to be confirmed by the bake-off.*
- **Gemini and Vertex try-on providers built behind `TryOnProvider`** — *the bake-off uses the production code paths, and a switch is a config change.*
- **Bake-off script (`pnpm bakeoff`) with a dry-run cost estimate and a hard USD cap; output git-ignored** — *Asser judges quality on real target-brand products before the first pilot.*
- **Scripts run with `node --experimental-transform-types`** — *strip-only mode can't parse constructor parameter properties used by the providers.*

## Phase 2 build (14 Nov 2026)

- **`/start` creates the account immediately (status `onboarding`, plan `pilot`, `target_plan_id` = chosen plan)** — *zero manual steps; the target plan is what the pilot converts to.*
- **Same answer for a new or existing email on `/start` and on sign-in requests** — *no account probing.*
- **Magic link token in the URL fragment (`/portal/login#t=…`), redeemed by a POST** — *email security scanners pre-fetch links; a GET token would be burned before the brand clicks.*
- **Session cookie `__Host-garrab_s` (HttpOnly, Secure, SameSite=Lax, 14 days); writes require `Origin` = app origin** — *standard CSRF defence for cookie auth.*
- **Portal and `/start` reach the API through the site Worker's service binding (same origin)** — *first-party cookies, no CORS preflights, no third-party cookie problems.*
- **Widget keys are stored in plain text too (`key_public`)** — *they are publishable (in the brand's HTML) and the portal must show the install line; lookups still use the hash.*
- **Products are auto-selected (top 10 by photos, sizes and price; decor excluded until Phase 4) and tested right away** — *"brand picks or we auto-rank" without ever waiting; the brand can swap products before approving, and new picks are re-tested.*
- **A product's test score is its lowest score across the 2 stock models; scorer outage → 3 (manual review), never auto-enable** — *conservative quality gate.*
- **Score 3 products go to Asser's review in admin; they don't block the brand** — *the brand approves the passing ones; a brand with nothing passing raises one alert.*
- **The pilot starts at install (or at approval for Instagram/WhatsApp-only brands)** — *"first approved product live".*
- **Expiry at pilot end + 5 grace days moves status to `expired` (kill switch on, data kept)** — *brief §6.8; payment and reactivation arrive in Phase 3.*
- **Day 12 and 14 emails link to the portal billing page for now** — *the InstaPay pay page is Phase 3.*
- **Emails are sent once per dedupe key (`notifications.dedupe_key` UNIQUE + Resend Idempotency-Key)** — *cron and queue retries never double-send.*
- **Local dev/test emails go to a `dev_outbox` table; production refuses to start without Resend** — *clickable links locally, no silent loss in prod.*
- **Importer respects robots.txt for every path it fetches, identifies itself as GarrabBot, and re-tries at most every 6 hours** — *polite crawling of brands that signed up.*
- **Websites keep the scheme the brand gave (default https)** — *found by the e2e test: we had forced https.*
- **Local e2e starts the Workers in order (API → site → admin) and without an outbound proxy** — *parallel `wrangler dev` processes race for the service-binding socket; workerd ignores NO_PROXY.*
- **Admin console is a small React app behind Cloudflare Access with invite, funnel, brand list, stuck flags, reminders, overrides and product review; the full dashboard comes in Phase 3** — *enough to run onboarding alone.*
- **Gemini Interactions API has no temperature; scoring uses a fixed seed** — *the size finder (Phase 4) needs temperature 0, to be solved then (classic API or deterministic post-checks).*
