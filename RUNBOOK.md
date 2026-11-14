# Garrab runbook

How to run Garrab alone in about 10 minutes a day. Everything routine is automatic; this page covers what is left for you and what to do when something goes wrong.

Where things are:

| What | Where |
|---|---|
| Admin console | `https://admin.<your-domain>` (Cloudflare Access login with your email) |
| Brand portal | `https://app.<your-domain>/portal` |
| Public form | `https://app.<your-domain>/start` |
| Telegram | your Garrab bot: alerts, payment confirmations, the 08:30 digest |
| Email | the 08:30 digest goes to `OPERATOR_EMAIL` |
| Prices and limits | `packages/shared/src/plans.ts` (the only place they live) |

---

## Every day (10 minutes)

**08:30 Cairo: read the digest** (Telegram summary, full version by email). It only lists sections that need you:

1. **Payments waiting for your confirmation.** Open your InstaPay or bank app, find the transfer (amount and the invoice number in the note), then tap **✅ Confirm** in Telegram. If you can't find it, tap **❌ Not received**: the brand is told and the switch-off hold ends. Also in the admin dashboard if Telegram is down.
2. **Stuck in onboarding.** Tap the brand → **Send reminder** (or read why it's stuck: no products found, nothing passed the test, not installed).
3. **New leads.** Nothing to do: their account already exists and import has started. Optionally send a WhatsApp hello.
4. **Due in 3 days / past due.** Nothing to do: invoices and reminders go out automatically. For a brand you know, send the ready WhatsApp message from their client page (Invoices → WhatsApp).
5. **Switched off in the last 24 h.** Nothing to do unless you want to call them.
6. **Cost anomalies / errors.** See "When something goes wrong" below.

**During the day:** Telegram pings you for payments to confirm (with buttons) and alerts. Most alerts need no action; the client page shows the timeline.

**Products that need a manual look** (test score 3): Admin → Onboarding → brand → Selected products → look at the two test images → **Enable** or **Disable**.

## Every week (15 minutes)

- Admin → Dashboard → **Clients**: margin per client. A brand near its preview limit every month is a Growth upsell; a brand with low margin may be overusing room previews.
- Admin → **Jobs**: every job shows ✓ and ran in the last day.
- Dismiss resolved alerts.

## Every month

- **Update the EGP/USD rate** (Dashboard → Clients → Set rate) so margins are right.
- Check AI prices haven't changed (Genlook, Gemini). If they have, update `GENLOOK_USD_PER_CREDIT` / `GOOGLE_PRICES` and redeploy.
- Rotate nothing unless there's a reason. Calendar: the Cloudflare deploy token expires **14 Nov 2027**.

---

## Common tasks

| Task | How |
|---|---|
| Onboard a brand in person | Admin → Onboarding → **Invite a brand** → hand them the sign-in link (Copy, or **Send on WhatsApp**). It works once, for 15 minutes; the welcome email has another. |
| See what the brand sees | Client page → **Open portal (read-only)**. One hour, can't change anything. |
| A brand paid by bank transfer or cash | Client page → Invoices → **Mark paid** → reference. Recorded once even if you click twice. |
| A brand wants extra previews | They buy them in the portal (Billing → Add 100 previews). Or create it for them: they pay, you confirm. |
| Cancel for a brand | They do it in the portal (Billing → Cancel plan); it ends at the end of the paid month. |
| Switch a brand off now (abuse, dispute) | Client page → **Kill** with a reason. Nothing automatic turns it back on. **Restore** puts it back to what the ledger says. |
| Pause a brand (holiday, their request) | Client page → **Pause** with a reason. **Restore** when ready. |
| A brand has a second domain | Client page → **Add domain**. The widget only works on listed domains. |
| A brand's key leaked / was copied to another site | Client page → **Rotate widget key** → send them the new line. The old one stops immediately. |
| Charge the setup fee to new brands | Founding pilots pay none. To charge new brands: `POST /admin-api/founding-pilots {"open": false}` (or per brand in the invite form). |
| Delete a brand's data on request | Kill with reason "deletion request", then in D1: delete the account's rows (products, product_tests, domains, api_keys, users, sessions, magic_links). Keep invoices and payments (accounting). Remove `tests/<accountId>/` from R2. |

## When something goes wrong

| Symptom | What to do |
|---|---|
| **Telegram: "Kill switch: … suspended"** | Normal for a late payer. Nothing to do. |
| **"Global daily AI spend cap reached. All previews paused."** | Dashboard → Clients: who spent it? Kill that brand if it's abuse. Then **Emergency switch → Turn previews back on**. Raise the cap only if usage is real (`POST /admin-api/settings {"globalDailyCapUsd": N}`). |
| **"… daily cap hit, account paused"** | Usually a viral day or a bot. Check the client's cost per day. It lifts automatically at the next morning's billing run; **Restore** now if it's genuine. |
| **"genlook: N failed AI calls in the last hour"** | Check Genlook's status/credits (platform.genlook.app). If out of credits, top up. If they are down for long, **Emergency switch** on (shoppers see nothing rather than errors). |
| **"genlook: delete call failed 3 times"** | It retries every 15 minutes automatically. If it keeps failing for a day, email Genlook support; the photo also expires on its own after 1 day. |
| **"Webhook signature failure"** | Someone is poking the Telegram/Kashier endpoint, or a secret was changed. If you didn't change anything, ignore one-offs; if repeated, rotate `TELEGRAM_WEBHOOK_SECRET` and run `telegram:webhook` again. |
| **Payment of X is less than invoice** | Ask the brand for the difference; mark paid once it's all in. |
| **A second payment arrived for a paid invoice** | Refund it from your InstaPay/bank, or tell the brand it's credited to next month and mark next month's invoice paid manually. |
| **Telegram buttons do nothing** | Check the bot token and webhook: `pnpm --filter @garrab/api telegram:webhook -- https://api.<domain>`. Meanwhile confirm in the admin dashboard. |
| **Emails not arriving** | Resend dashboard → logs. Check the sending domain is still verified. |
| **Button missing on a brand's shop** | Client page → install status. Ask them to check the line is still in their theme (theme updates sometimes remove it). Check their status is pilot/active/past_due. |
| **Everything is broken** | **Emergency switch** on (shoppers see nothing, shops keep working). Then look at the Jobs panel and Cloudflare Workers logs. |

## Deploy, roll back, back up

*(Deploy wiring lands once your domain is on Cloudflare; these are the steps it will use.)*

- **Deploy:** push to the main branch; CI runs lint, typecheck, tests and the browser tests, then deploys staging. Production deploy is a manual approval in GitHub Actions.
- **Database changes** are D1 migrations in `apps/api/migrations`, applied before the new code starts: `wrangler d1 migrations apply DB --env prod --remote`.
- **Roll back code:** Cloudflare dashboard → Workers → garrab-api → Deployments → roll back to the previous version (seconds).
- **Roll back data:** D1 Time Travel keeps 30 days: `wrangler d1 time-travel restore garrab-prod --timestamp <ISO time before the problem>`. Restore to staging first if you're unsure.
- **Secrets:** `wrangler secret put NAME --env prod`. The full list is in `.env.example`.

## Privacy rules you must keep

- Never ask a shopper to send a photo by WhatsApp or email "to test". Use the stock photos in `fixtures/` only.
- "Not saved on our systems" only appears after the Genlook delete check passes (`verify:genlook-delete`, then Admin → privacy claim with the PASS report). Re-run the check every 90 days.
- Marketing images must come from real pilots with the brand's written permission.
