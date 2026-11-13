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
