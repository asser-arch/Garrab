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

## Phase 3 build (14 Nov 2026)

- **Direct InstaPay is the live payment path, to `asserrostom@instapay`** — *Asser's choice: no fees, no paperwork, works today; Kashier stays ready behind the same interface (webhook signature implemented and tested against Kashier's worked example).*
- **Kashier: no setup or monthly fee; cards 2.75% + 3 EGP + 14% VAT on the fee; InstaPay/wallet rates are "contact sales"** — kashier.io/pricing, 14 Nov 2026.
- **Telegram Bot API 10.4: webhook secret in `X-Telegram-Bot-Api-Secret-Token`; `callback_data` 1–64 bytes** — core.telegram.org/bots/api. *Buttons carry `pc:<claim>:<a|r>:<12-char HMAC>`; only Asser's chat id is accepted; failures raise an alert.*
- **`naturalStatus()` derives the status from the ledger; the daily run, payments and Restore all move accounts there** — *one rule set, no drift; admin Kill/Pause set `manual_hold`, which nothing automatic lifts.*
- **`paid_through` is the last day covered (inclusive); the due date T = paid_through; past_due from T+1; suspended from T+6; archived from T+36** — *matches "due before each month starts" and the 5-day grace.*
- **Allowed status transitions are enforced in one place (`transitionStatus`)** — *a refused move is logged, never silently applied.*
- **Invoices are numbered in the same D1 transaction that bumps the year counter** — *sequential and gapless; found and fixed a bug where a numeric bind printed `2031.0`.*
- **Invoice PDFs are generated on demand from the stored invoice (pdf-lib, Helvetica, English)** — *nothing extra to store or keep in sync.*
- **Pay links are capability URLs (`/pay/<32-char token>`) that show one invoice and accept an "I've paid" notice, nothing else** — *like a hosted invoice link; no login needed to pay.*
- **The first paid month starts on the payment date; renewals start the day after the previous paid_through** — *the brief's rule plus the reactivation exception.*
- **A payment short of the invoice total is recorded but not applied, and alerts Asser; a second payment for a paid invoice alerts too** — *never guess with money.*
- **The daily-cap auto-pause (Phase 1) is lifted by the next morning's billing run unless Asser killed the account** — *a cost spike pauses for the day; abuse needs an explicit Kill.*
- **Digest at 08:30 Cairo by email and Telegram; empty sections are left out; a quiet day says "all quiet"** — *a 2-minute read.*
- **Immediate Telegram alerts: payment received, payment to confirm, kill switch (suspended), spend cap, 5+ provider failures in an hour, webhook signature failure, short or duplicate payments** — *brief §8.*
- **v1 WhatsApp = a ready `wa.me` message per open invoice in the admin** — *no WhatsApp API yet (brief §2).*
- **Local dev: the site and admin Workers reach the API over HTTP (`API_DEV_URL`, dev only); staging/prod use service bindings** — *service bindings between separate local `wrangler dev` processes were intermittently "Network connection lost".*
- **Magic-link page also reacts to `hashchange`** — *found by the e2e test: a link opened in a tab already on the sign-in page did nothing.*
- **Known test noise: a full `vitest` run can print one "uncaught exception" from a queued background job that outlives its test file's storage; every file is clean on its own and no result changes** — *harness artifact, not a product bug.*

## Gaps closed before Phase 4 (14 Nov 2026)

- **Setup fee (1,500 EGP, plans.ts) is charged on a brand's first invoice when `setup_fee_due`; new brands get it when the `founding_pilots_open` setting is off (default on), or per brand at invite** — *the brief's setup fee existed only on paper; founding pilots still pay none.* Open question for Asser: should non-founding brands still get the free 14-day pilot?
- **Admin "open portal read-only" = a one-time link to a 1-hour session flagged read-only; every non-GET is refused; it doesn't count as a brand login** — *brief §8; the operator sees exactly what the brand sees and can't change anything by accident.*
- **Widget keys can be rotated from the admin (old key revoked immediately, new install line returned); domains can be added and removed; a domain belongs to one brand** — *brief §7.6 "keys are rotatable", "bind to the brand's domain(s)".*
- **Cost view per brand per Cairo day in USD and EGP (from daily counters, EGP via the admin-set rate)** — *brief §12.*
- **Request size limits: 64 KB on JSON endpoints, 256 KB on the portal (CSV upload), 8 MB photo on /v1/tryon** — *brief §10.*
- **ESLint (flat config, typescript-eslint) in CI, with `no-console` enforced in the widget, the frame and the API (only `lib/log.ts` may log)** — *planned in Phase 0, added now; enforces "no console noise" and "no PII in logs" mechanically.*
- **KV is not used for the config payload; D1 serves it directly** — *the plan allowed a KV cache, but D1 reads are cheap at this scale and one less cache means one less thing that can serve a stale kill switch.*
- **In tests, post-response work (provider delete, usage warnings) runs inline, and the queue consumer is off** — *tests stay deterministic; production unchanged. A rare "uncaught exception" line in a full `vitest` run remains (needs three particular files together, every file is clean alone, all results pass): test-runner noise, recorded and left.*
- **`RUNBOOK.md` written** — *brief §0.4 quality bar.*

## Asser's answers (14 Nov 2026)

- **InstaPay account name: "Asser Rostom"** (shown on the pay page with asserrostom@instapay).
- **No product limit on paid plans; previews are the limit. A per-brand limit can be set in the admin (`accounts.max_products`). The pilot keeps 10 (brief §1).** — *Asser.* The first automatic pick still selects at most 10 products to test, so a large catalogue doesn't burn the test budget on day one.
- **Product test budget is now 3 USD per brand per rolling 30 days** (was 3 USD per brand, ever) — *with no product limit, brands keep adding products over months.*
- **No VAT for now** — *Asser; stays a config value (0, hidden).*
- **Free 14-day pilot for every brand** — *Asser.* The setup fee rule is unchanged: none while "founding pilots" is on.

## Domain and deploys (14 Nov 2026)

- **Domain: garrabb.com.** Prod: `app.` (frame, portal, start, pay), `api.`, `admin.`, `cdn.` (w.js only); the apex and `www.` redirect to `app.`. Staging: `app-staging.`, `api-staging.`, `admin-staging.`.
- **Staging hosts are one level deep (`app-staging`, not `app.staging`)** — *Cloudflare's free certificate covers `*.garrabb.com` only, not `*.staging.garrabb.com`.*
- **Cloudflare resources are created by `scripts/cf-provision.mjs`, found by name every deploy, and their IDs are filled into the config in the CI workspace only** — *idempotent; no IDs to copy by hand.* Storage location hint: Eastern Europe (closest to Egypt).
- **Every push to main that passes CI deploys to staging; prod is a manual "Deploy" run** — *nothing reaches brands by accident.*
- **Signing keys (ctx tokens, Telegram webhook and buttons) are generated in CI on first deploy and never overwritten** — *no one ever sees them; rotating would break live sessions.*
- **Until the real Turnstile widget and Genlook key arrive, staging uses Cloudflare's public always-pass Turnstile test keys and Genlook's free mock.** Prod is not deployed until both are real.
- Removed unused `SESSION_SIGNING_KEY` and `PAY_TOKEN_KEY` from `.env.example`.
- **Telegram: bot token and chat ID live as GitHub secrets; every deploy syncs them to the Worker and points the bot's webhook at that environment (prod always wins; staging only while prod doesn't hold it). The webhook secret is regenerated in the same step, so it never needs to be known by anyone.** Replaces running `telegram:webhook` by hand.
- **Provider keys (Genlook, Google AI, Resend) live as GitHub secrets and are synced to the Worker on every deploy.** Rotating = replace the GitHub secret and re-deploy. Never paste keys in chat.
- **Staging keeps `GENLOOK_MOCK=true` even with the real key: calls go to Genlook with `mock: true` (free) so the key and flow are proven without spending credits.** Real generations on staging start with the bake-off, after Genlook's approval email.

## Genlook approval (15 Nov 2026)

- **Thibault (Genlook) confirmed in writing that a managed try-on service for many brands under one Genlook account, billed with our own monthly fee, is allowed; now explicit in their Terms §6 ("Building on and reselling the Try-On API").** Limits: never share or resell API keys; never resell raw API access as a pass-through API. Our setup (own backend, widget, brand) is the intended case. Reply kept in `docs/vendors/genlook-approval.md`.
- **Data roles: brands are controllers, Garrab is their processor, Genlook is our subprocessor under its DPA (genlook.app/dpa).** Privacy page updated; lawyer to confirm.
- **Genlook pricing for planning: Scale = 300 USD/month for 20,000 credits, then 0.015 USD per try-on (≈ 675 USD/month at 45k try-ons). Start on pay-as-you-go/Starter/Growth and move up as brands join.** Cost tracking stays at 0.04 USD/credit (pay-as-you-go) until a plan is bought; change `GENLOOK_USD_PER_CREDIT` then.
- **Startup program offered: free credits to test quality on brands' catalogues and a free first month on a plan at launch.** Asser to send his Genlook account email to Thibault.
- **Turnstile: real site key and secret live as GitHub secrets (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`); every deploy uses them in place of Cloudflare's test keys.**

## Brand files, Arabic wording, logo, test photos (15 Nov 2026)

- **Pitch Kit, Pilot Proposal, Pitch Deck (pptx + pdf) and Brand Guidelines are kept in `docs/brand/`.**
- **Arabic try-on wording now comes exactly from Pitch Kit §05; `AR_IS_DRAFT` is false.** The Pitch Kit uses Modern Standard Arabic, not gendered (the earlier drafts were Egyptian colloquial, feminine). Five strings the Pitch Kit doesn't cover were written in the same register and need the native-speaker review the Pitch Kit asks for: `uploadRoom` ارفع صورة لغرفتك · `close` إغلاق · `notNow` ليس الآن · `unavailable` غير متاح مؤقتًا · `buy` اشترِ الآن · plus the two Arabic link captions.
- **Logo: built exactly to Brand Guidelines p.3 (Forest tile, Paper Cairo Bold "G", Peach dot; dark version Paper tile, Forest G, Orange dot; wordmark in Cairo Bold).** The G and wordmark are real Cairo Bold outlines (Google Fonts, OFL), converted to SVG paths so they render the same everywhere. Files in `docs/brand/logo/`; the mark is the favicon of the site, portal and admin.
- **Test photos: two free Pexels stock photos (one with hijab, one without; full body, plain background), listed in `scripts/fixtures.json` and loaded into R2 `fixtures/` by the manual Checks workflow; not committed to the repo.** — *Asser: "get any 2 free stock photos and test with".* Private testing only, never marketing (Brand Guidelines p.9). Stock sites don't guarantee model releases for this use, so prefer photos of consenting models before launch.
- **Prices: Starter 5,000 EGP / month (250 previews), Growth 8,500 EGP / month (600 previews), as in the Pitch Deck and Pilot Proposal** — *Asser, 15 Nov* (replaces the brief's 3,000 / 6,000). Setup 1,500 and extra previews 800 per 100 unchanged.
- **Genlook delete check: PASS (15 Nov 2026).** Upload 201, try-on 201 (keepHeadCovering accepted), both URLs 200 before; DELETE /customers/{id} 204; both URLs 404 after, within seconds. Report: `docs/privacy/genlook-delete-2026-11-15.json`. With the automated privacy test also passing, the "We don't save it" line may now be switched on (`privacy_claim_verified`, admin → settings).
- **Bug found by the bake-off and fixed (15 Nov): Genlook returns 201 Created for a successful try-on; the provider only accepted 200, so every real Genlook preview was reported as an error** (hidden on staging by the free mock). Now 200 and 201 are success, with a test; failures carry a `detail` (HTTP status and provider code only) for logs and checks.
- **Admin login: the API learns the Cloudflare Access team from the login token's issuer (only `*.cloudflareaccess.com`), then checks the signature against that team's published keys and requires our application's AUD tag.** `CF_ACCESS_TEAM_DOMAIN` is now only a fallback. — *the saved team domain didn't match the real team (`proud-wind-8150`), which left the admin stuck; the AUD tag is what ties a login to our application.*
- **A failed email is never silent (15 Nov): Resend's reason (status, error name and message, addresses removed) is stored on the notification and raised as an alert on the dashboard and in Telegram.** — *the first staging invite didn't arrive and there was no way to tell why.*
- **Inviting an email that already exists never makes a duplicate; it returns a fresh sign-in link and re-sends the welcome email only if it never went out** (sent once is never sent twice).
- **Admin can delete an invitation only while the brand is in onboarding and has no invoice, payment or payment claim; the brand name must be typed to confirm.** Removes the account, users, sign-in links, sessions, products, test results (D1 and R2), domains and keys; keeps AI usage rows (cost totals) and the audit record. Paying brands are switched off with Kill or Pause, never deleted.
- **Bug found on staging (15 Nov): classes stored the global `fetch` and called it as `this.fetcher(...)`; the Workers runtime refuses that ("Illegal invocation"), so every email and every real Genlook/Gemini call from the Worker failed.** Node (tests, bake-off) allows it, which hid the bug. Fixed with `lib/http.ts` `workerFetch` (an unbound wrapper) as the default in every provider, plus a test with a fetch that refuses a foreign `this`.
- **Upload screen now also tells shoppers, before they upload, that the preview is made by AI and small differences are normal** (`expectation`, EN + AR) — *Asser, 15 Nov: set expectations early, calmly.* The Pitch Kit disclaimer stays under every result. The Arabic line joins the native-review list.
- **Setup fee wording in the admin (15 Nov):** the invite form offers "Current offer: no fee / 1,500 EGP", "No fee for this brand" or "Charge 1,500 EGP for this brand", explains when it's charged (first invoice after the pilot, only if the brand continues), and shows the founding-brands offer with an on/off link. Behaviour is unchanged.
- **Lawyer review set aside for now** — *Asser, 15 Nov: "consider it done".* Not a go-live blocker. Worth revisiting (Law 151 of 2020, Data Protection Center registration, brand DPAs) before scaling past the first pilots.
- **Arabic wording approved** — *Asser, 15 Nov: "Arabic OK"* (the 8 lines not in the Pitch Kit: upload AI note, room prompt, Close, Not now, Unavailable, Buy, and the two captions).
- **Brands upload product photos as files (JPG, PNG or WEBP, up to 10 MB) instead of pasting links** — *Asser, 15 Nov: brands have image files, not links.* Stored in R2 `products/<account>/` with JPEG metadata removed, served at `app.<domain>/pi/<account>/<random>.jpg` (public: brand product pictures; the AI providers fetch them by URL). The link field stays as a fallback; deleting an invitation removes the photos too.
- **Staging now uses real Genlook try-ons (`GENLOOK_MOCK=false`)** — *the first real staging test showed every product "not eligible": the free mock returns the model without the product, and the real quality check rightly scores that low.* About 0.09 USD per product test; the 3 USD per brand per 30 days cap still applies.
- **In Genlook's free test mode a product is never auto-rejected; it goes to "needs your review".**
- **Admin can re-test any product ("Test again") and enable a rejected product by hand ("Enable anyway"); the reason a product was disabled is shown.**
- **Bug found on staging (15 Nov): Genlook rejects an empty product description (HTTP 400 VALIDATION_FAILED); products added by hand had none, so every test failed.** The provider now sends the product name when there's no description; test added. Failed product tests now show the provider's code in the admin.
- **Admin can remove any product (duplicates, mistakes)** — *Asser, 15 Nov.* Added by hand: deleted with its test results and images, and its uploaded photo unless another product still uses it. Imported from a shop: hidden instead, because the nightly re-sync would re-create a deleted row. Rows are deleted before R2 objects; the whole `tests/<account>/<product>/` prefix is swept. Recorded in the brand's history with the product id. Photo-address and clean-up logic live in `lib/products.ts` (found by code review).
- **Frontend quality pass (15 Nov), using Vercel's Web Interface Guidelines, Anthropic frontend-design and Impeccable as references; the brand guidelines win wherever they differ.** Phone tap tuning, hover/active states (no shadows), balanced headings, tabular numbers, long-text wrapping, browser theme colour, autofill/spellcheck/inputmode on every field; portal menu is one swipeable row on phones; Approve is the primary action and a made choice reads as done (mint), not disabled; product pictures are captioned "Your photo / On model A / On model B".
- **Accessibility audit (WCAG 2.1 AA, 15 Nov), with the Anthropic Design plugin's accessibility-review and axe-core.** Fixed: links are Forest and underlined (Teal is 4.1:1, which the brand guide limits to large text and icons); small hint and footer text uses Muted instead of Grey (3.3:1); "Approved" is Forest on Mint (was Teal, 3.2:1); input borders are Grey (Sand was 1.4:1, and a field's edge needs 3:1); the try-on's hidden upload input has a name and is out of the tab order. A permanent axe-core test (`e2e/tests/a11y.spec.ts`) scans the start, privacy, terms, portal sign-in, hosted try-on (EN and AR) and admin screens on every change.

## Try-on provider after the bake-off (15 Nov 2026)

- **Scores (Asser, 48 results: 8 Nesaa products × 2 stock models, 1–5):** Gemini nano-banana-2.1 **3.6** (10/16 scored 4–5; hijab model 3.5), Gemini 3.1 flash-image **3.3** (9/16; hijab 2.5), Genlook **1.9** (2/16; hijab 2.1, good only on trousers).
- **Decision (Asser): nano-banana is the try-on model for every shopper preview and product test; Gemini flash-image is the automatic backup when nano-banana is busy, errors or times out. Genlook is switched off (`TRYON_PROVIDER=gemini`; `genlook` stays selectable for a later re-test).** A content refusal or an unusable photo is never retried on the backup.
- **Privacy line changed to the Pitch Kit's own variant for a provider that keeps images for a period: "Your photo is used only to create this preview. We don't save it on our systems."** (Arabic: "…لا نحتفظ بها على أنظمتنا."). Google keeps requests for a limited time for abuse checks and has no delete call; we send `store: false`, never store the photo, and the paid tier does not train on it. The privacy page says this plainly.
- **Uploaded product photos are read straight from R2 for Google calls (`appFetch`)**, because a Worker can't reliably fetch another Worker on the same zone through its public address.
- Speed: nano-banana took about 16 s per preview in the bake-off (Genlook about 5 s). Watch it in the pilot.

## 2026-11-15 — Brand sign-in: 6-digit code, tap-to-confirm link, 60-day renewing sessions
A pilot brand couldn't sign in again: her link had expired, and each new link said "already used". Cause: Outlook/Hotmail Safe Links opens every link in a hidden browser that runs JavaScript, and our login page used the token automatically, so the scanner burned it before she tapped. Fix: (1) every sign-in email also carries a 6-digit code (hashed, 15 minutes, single use, locked after 5 wrong tries, rate-limited per IP); the login page asks for email then code, so it works on any device and scanners can't use it up; (2) the link still works but only after a tap on "Sign in" (a POST), never on page load; (3) sessions last 60 days and restart (at most once a day) whenever the brand uses the portal, so an active brand rarely signs in at all.

## 2026-11-15 — One bio link per brand; QR moved to "for print"
Brands without a website share one link in their Instagram/TikTok bio, which allows a single link. New brand page `/t/<brand>` lists every live product; each opens the existing product try-on page. The portal shows this link first with Copy and Share on WhatsApp; per-product links (for posts, stories, replies) follow. QR codes are kept only behind "QR code for print (flyers, shop counter, packaging)".

## 2026-11-15 — Approved products go live straight away; the website line is optional
A pilot brand approved her products and her bio link said "Temporarily unavailable": brands with a website stayed in onboarding until the script was found on their shop, so their links stayed off. Now approval puts the brand live (pilot clock starts, links work); the website line can be added any time and the widget works the moment it's pasted. Brands already waiting are moved on the next time they open the portal.

## 2026-11-16 — InstaPay by mobile number; live brands keep adding products; hosted Close → all products
- **InstaPay:** brands now pay to the mobile number **01009110001** (Asser Rostom), since payment addresses no longer accept transfers from others. The pay page says "Send money → Mobile number" with a Copy button; the PDF says "InstaPay to mobile number …".
- **Live/pilot brands** can add, swap and approve products at any time. New products are tested automatically (same test budget cap) and go live only after the brand approves them.
- **Hosted product page:** the bottom button is "See all products" (EN/AR) and returns to the brand page. Escape only closes the widget overlay.
- **Admin:** an account's History is collapsed until opened.

## 2026-11-16 — Phase 4 scope (Asser's answers; build starts on "start phase 4")
1. **Room preview: build it** (décor products; Google image model, compared in Phase 4).
2. **Size finder: English and Arabic** (Arabic wording for Asser's review, as with the try-on strings).
3. **Size finder: Growth plan only** (Starter never shows "Find my size").
4. **Pilot report: day 10 of 14, by email**, fully branded and organised (clean, professional): also in the portal and admin, with a PDF; includes the payment link so the brand can convert before day 14.
Build order: results + pilot report → size finder → room preview, each piece tested and deployed before the next.

## 2026-11-16 — Phase 4.1: Results page and branded pilot report
- **Per-product counts:** widget/frame events carry the product id (only counted per product when it belongs to the brand); hosted links count `link_view`; previews are counted on the server (`preview`), so they can't be faked from a page. All counts stay anonymous daily totals.
- **Portal → Results:** views, try-ons, previews, Buy taps, two rates (capped at 100%), previews per day (single-series bar chart, hover/focus values, table view) and a products table. "Save as PDF" prints just the report.
- **Pilot report email on day 10** (Asser, 16 Nov), branded (Forest header, KPI tiles, rates, daily bars, top 5 products, next steps), email-safe tables, no images needed. **Day 14** sends the same report as the final results with the plan price and pay link (replaces the old plain day-14 email). If the job catches up past day 14, only the final one goes. Sample: `docs/brand/pilot-report-sample.png`.

## 2026-11-16 — Phase 4.2: brand category (fashion or home décor)
Asser: "home decor customers will have no access to clothes preview and vice versa". Each account has `category` (`fashion` | `home`), chosen at invite ("Type of brand") or from the /start "What do you sell?" answer. Product kind follows the category at save time (`kindFor`): home → every product is décor (room preview); fashion → never décor (keywords only split clothing from accessories). The try-on route already refuses décor; the room route (4.4) will refuse anything else. Admin shows the category on the brand page.

## 2026-11-16 — Phase 4.3: size finder (Growth, English and Arabic)
- **Where:** a "Find my size" button in the try-on window (website pop-up and try-on links), only when the plan is Growth (a pilot counts as the plan it converts to: Asser, Growth only), the product is clothing, and it comes in two or more sizes. Brands without a website can now type "Sizes you sell" when adding a product.
- **How:** the shopper gives height, weight (optional), usual size, body shape and fit preference. ONE AI call (`gemini-3.5-flash-lite`, ~0.001 USD) reads the product and the answers. **Code rules** check the answer: a size the brand sells, at most two sizes from the usual one, the alternative must be a neighbour, confidence never "high", two reasons. Anything else → a plain **rule** answer (usual size, plus the size up for a loose fit or curvy/broad shape).
- **Privacy:** answers live only in that request: not stored, not logged (tested), the error never echoes them. Counted as an anonymous `size_completed`.
- **Quality:** a fixed 30-case harness (`apps/api/test/size.test.ts`) pins what shoppers see whatever the model says. `Checks → size-live` runs three real AI answers (EN/AR) to confirm Google accepts the request.
- **Wording:** "Estimated size" stays as the brief's exact English label; Arabic strings are drafts for native review, like the rest.

## 2026-11-16 — Phase 4.4: room preview for home décor brands
- **Flow:** same try-on window and links; for a home décor brand every product shows "See it in your room", the shopper uploads a room photo, and the item is placed in it. Same Turnstile, limits, kill switch, quota and "AI preview" chip; usage is recorded as `room`.
- **Model:** Google nano-banana with flash-image as backup (the bake-off winner for people; both now take a room prompt). Genlook can't place objects in rooms, so rooms always use Google. The live model comparison for rooms can run once a home décor brand has products (bake-off script).
- **Product tests:** home décor products are tested in two stock rooms (`fixtures/room-a.jpg`, `room-b.jpg`, Pexels 29298710 and 19889132; sofa against a plain wall, and a full living room with floor). Fashion products never use the rooms and home products never use the models. The scorer judges the item's look and a believable size and place in the room.
- **Size finder (4.3 follow-up):** the live check gave valid sizes but broken Arabic reasons from the small model, so Arabic answers use our fixed, reviewable sentences; the AI still picks the size.
- **Asser:** run Checks → `fixtures-only` once so staging gets the two room photos.

## 2026-11-17 — Delete any brand; approving a product puts the brand live
- **Delete brand** (admin, any status, type the name + a reason). Never paid → removed completely, unpaid invoices included. Paid at least once → invoices and payments are kept for the accounts, open invoices voided, everything else removed, account archived (switched off for good, no sign-in). The history keeps who deleted it and why.
- The home décor test brand stayed "Temporarily unavailable" because its products were approved one by one but the separate "Done: go live next" button was never tapped. That step is gone: the first approval puts the brand live. Brands stuck before this go live the next time they open the portal.
