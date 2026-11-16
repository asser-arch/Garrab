# What's left on your side (updated 15 Nov 2026)

**Done:** domain, Cloudflare, staging, Telegram, Genlook (key, credits, written approval, delete check **PASS**, you replied about the startup program), Google AI (paid tier), nano-banana chosen, Resend (verified), Turnstile, admin login, privacy line **on**, brand files, logo, Arabic wording, prices (5,000 / 8,500 EGP), admin redesign, delete-invitation, AI note on the upload screen, setup fee wording, **uptime monitor (staging)**.

Staging: `app-staging.garrabb.com` · `api-staging.garrabb.com` · `admin-staging.garrabb.com`

---

## 1. Test with your friend (continue)

1. Your friend opens `app-staging.garrabb.com/portal`, types her email, and enters the **6-digit code** from the email (or taps the email's button, then **Sign in**). She then stays signed in for 60 days on that phone.
2. **Products** → **Test again** on her products (now made with nano-banana).
3. **Approve**, then **Install & links** → **Your try-on link**: this one link goes in her Instagram bio and lists every approved product. Open it on a phone and try one on.
4. Send Claude screenshots of anything confusing or broken.

## 2. ✅ Bake-off scored and model chosen (15 Nov): nano-banana, with Gemini flash-image as backup

## 3. ✅ Arabic check (done 15 Nov: "Arabic OK")

## 4. Genlook follow-up (when it happens)

1. Forward Thibault's startup-program reply to Claude (free credits, free first month).
2. When you buy a Genlook plan, tell Claude which one, so cost tracking uses the real price (now 0.04 USD per preview; Scale is about 0.015).

## 5. Before the first real brand

1. ✅ **Lawyer review**: set aside for now by Asser (15 Nov). Revisit before scaling past the first pilots.
2. ✅ **Uptime monitor**: UptimeRobot watches `https://api-staging.garrabb.com/healthz` every 5 minutes, alerts by email (done 15 Nov).
3. **Optional, better:** two photos of real people who sign the consent text (`docs/SETUP-CHECKLIST.md`, step 36) to replace the stock photos used for product tests.

## 6. Going live

When 1 is done, tell Claude **"go live"**. Claude deploys `app.garrabb.com`, `api.garrabb.com`, `admin.garrabb.com` and `cdn.garrabb.com`, moves the Telegram bot to live and runs the same checks. Then:
- keep `admin` + `garrabb.com` in the Cloudflare Access app (it protects the live admin);
- add `https://api.garrabb.com/healthz` to the uptime monitor.

## 7. ✅ Phase 4 built (16 Nov), on staging

- **Results** page in the portal, and the branded **pilot report** email on day 10 (final results with the pay link on day 14).
- **Type of brand** when inviting: Fashion (try-on on a person) or Home décor (room preview). A brand only ever gets one.
- **Size finder** ("Find my size") for Growth brands, English and Arabic, on clothing that comes in 2+ sizes. Brands without a website can type "Sizes you sell" when adding a product.
- **Room preview** ("See it in your room") for home décor brands.

Your side:
1. Invite a test **home décor** brand (Type of brand → Home décor), add a rug or cushion, and try "See it in your room" on your phone.
2. To see the size finder, invite a test brand with **Plan after pilot → Growth**, and type sizes (e.g. S, M, L, XL) when adding a product.
3. Ask an Arabic speaker to read the new size-finder wording (the "Find my size" form and answers), like you did for the try-on wording.
