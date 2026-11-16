# Phase 3 demo: billing and the kill switch

**Done when:** an unpaid brand is suspended and the widget disappears within 60 seconds, and paying restores it, through both the emailed link and the portal "Pay now" page. Proven by `e2e/tests/billing.spec.ts`.

## 1. Automated proof

```bash
pnpm install && pnpm build && pnpm typecheck
pnpm test   # 97 API tests: ledger, status machine, invoices, claims, Telegram webhook security, kill/restore, packs, cancel, digest, Kashier signature
pnpm e2e    # browser tests incl. the two payment paths and admin Kill/Restore
```

What the browser test does:

1. The demo brand is 6 days late. The billing job runs → status `suspended` → the button vanishes from the open shop page (**about 30 s**).
2. **Path 1, emailed link:** the "switched off" email has the pay link → the pay page shows **5,000 EGP to asserrostom@instapay, note GRB-…** → the brand taps **I've paid** with the InstaPay reference → Asser taps **✅ Confirm** in Telegram → status `active`, `paid_through` +1 month from the old date → button back, invoice shows **Paid ✓** with a PDF.
3. **Path 2, portal:** the brand signs in → Billing → **Pay and switch back on** → same pay page → Asser confirms from the admin dashboard → button back.
4. Admin **Kill** switches a paying brand off at once; **Restore** brings it back.

## 2. How money works (one page)

| Day | What happens automatically |
|---|---|
| Pilot day 12 | First invoice (target plan), pay link in the day-12 and day-14 emails |
| T−7 | Renewal invoice emailed (`GRB-YYYY-NNNN`, PDF) |
| T (due) | Reminder |
| T+1, T+3, T+5 | Reminders; status `past_due`; try-on keeps working |
| T+6 | `suspended`: kill switch on, brand emailed, Telegram alert |
| T+36 | `archived` |
| Brand taps "I've paid" | Telegram: Confirm / Not received. Switch-off is held up to 48 h; reminders every 12 h |
| Confirm (Telegram or admin) | Payment recorded once, `paid_through` +1 month from the previous date, status back to `active` |

Extra preview packs (100 for 800 EGP) are prepaid on their own invoice and unlock when paid. Cancel takes effect at the end of the paid month. Everything above reads its numbers from `packages/shared/src/plans.ts`.

## 3. Going live with your keys

```bash
# Worker secrets (staging first: add --env staging)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET     # openssl rand -hex 24
wrangler secret put TELEGRAM_CALLBACK_KEY       # openssl rand -base64 48
wrangler secret put RESEND_API_KEY
# then point your bot at the API (one time):
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… pnpm --filter @garrab/api telegram:webhook -- https://api.<your-domain>
```

`INSTAPAY_IPA` is set to the mobile number `01009110001` (changed 16 Nov: InstaPay payment addresses no longer accept transfers to others) in `apps/api/wrangler.jsonc`. Set `INSTAPAY_ACCOUNT_NAME` (the name brands see when paying) and, optionally, `INSTAPAY_LINK`.

## 4. Admin

Dashboard: MRR, clients by status, previews used vs included, revenue and AI cost per client for 30 days, margin (after you set the EGP/USD rate), payments to confirm, alerts, job status, **Run billing now**, the **emergency switch**. Client panel: Kill / Pause / Restore (reason required), invoices with pay page, PDF and a ready WhatsApp message, Mark paid (bank transfer, cash, InstaPay seen in your app), payments, claims, notes, resend emails.
