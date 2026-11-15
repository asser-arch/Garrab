# What's left on your side (updated 15 Nov 2026)

**Done:** domain, Cloudflare, staging, Telegram, Genlook (key, credits, written approval, delete check **PASS**, you replied about the startup program), Google AI (paid tier), Resend (verified), Turnstile, admin login, privacy line **on**, brand files, logo, Arabic wording, prices (5,000 / 8,500 EGP), admin redesign, delete-invitation, AI note on the upload screen.

Staging: `app-staging.garrabb.com` · `api-staging.garrabb.com` · `admin-staging.garrabb.com`

---

## 1. Test with your friend (today, 30 minutes)

1. Admin → **Onboarding** → **Invite a brand** with your friend's email → **Create and get sign-in link**.
2. The welcome email from `hello@garrabb.com` should arrive within a minute (check spam the first time). If it doesn't: the reason shows under **Alerts** and in Telegram; send the link with **Send on WhatsApp** meanwhile.
3. Your friend signs in, adds 1–3 products, approves them, and tries a preview (website: install the code; no website: use the product link / QR code).
4. Staging uses Genlook's free test mode: the "preview" is the uploaded photo returned unchanged. Tell Claude before you start if you want real try-ons (one deploy, about 0.04 USD each).
5. Send Claude screenshots of anything confusing or broken.

## 2. Score the bake-off and choose the try-on model (30 minutes)

1. Open each run, scroll to **Artifacts** → **bakeoff** to download:
   - Google (flash-image and nano-banana): https://github.com/asser-arch/Garrab/actions/runs/43711464354
   - Genlook: https://github.com/asser-arch/Garrab/actions/runs/43712878638
2. Unzip, open `index.html`, score every result **1–5** (garment right, person unchanged incl. hijab, no glitches, believable fit).
3. Press **Download my scores (CSV)** on each page and send both files to Claude.
4. Then choose with Claude: Genlook, nano-banana, or nano-banana for some product types. If Google becomes the main model, the privacy line changes to *"We don't save it on our systems"* (Google keeps requests for a limited time to check abuse), and Genlook stays as automatic backup.

## 3. Arabic check by a native speaker (10 minutes of their time)

The main try-on wording is from your Pitch Kit. These 8 lines aren't, so Claude wrote them in the same style:

| Where | Arabic |
|---|---|
| Before upload: AI note | تُنشأ المعاينة بالذكاء الاصطناعي لمساعدتك على تخيّل الشكل. هي دليل قريب وليست صورة مطابقة تمامًا، لذا من الطبيعي وجود اختلافات بسيطة عن المنتج الحقيقي. |
| Room photo prompt | ارفع صورة لغرفتك |
| Close button | إغلاق |
| "Not now" button | ليس الآن |
| Temporarily unavailable | غير متاح مؤقتًا |
| Buy button | اشترِ الآن |
| Instagram caption | شاهده عليك قبل الشراء ✨ جرّب "[product]" على نفسك مع المعاينة بالذكاء الاصطناعي: [link] |
| WhatsApp caption | تريد أن ترى "[product]" عليك أولًا؟ ارفع صورة هنا واحصل على معاينة سريعة: [link] |

Send Claude corrections, or "Arabic OK".

## 4. Genlook follow-up (when it happens)

1. Forward Thibault's startup-program reply to Claude (free credits, free first month).
2. When you buy a Genlook plan, tell Claude which one, so cost tracking uses the real price (now 0.04 USD per preview; Scale is about 0.015).

## 5. Before the first real brand

1. **Lawyer** (Egypt's Personal Data Protection Law, Law 151 of 2020). Send them:
   - https://app-staging.garrabb.com/privacy and https://app-staging.garrabb.com/terms
   - the Pilot Proposal (`docs/brand/Garrab_Pilot-Proposal.docx`)
   - Genlook's terms (genlook.app/terms, section 6) and data agreement (genlook.app/dpa); Google's Gemini API terms if Google becomes the main model

   Ask: is the wording right, does Garrab need to register with the Data Protection Center, and does each brand need a data processing agreement with Garrab. Send Claude their changes.
2. **Uptime monitor** (5 minutes): uptimerobot.com → free account → **New monitor** → HTTP(s) → `https://api-staging.garrabb.com/healthz` → every 5 minutes → alerts by app or email.
3. **Optional, better:** two photos of real people who sign the consent text (`docs/SETUP-CHECKLIST.md`, step 36) to replace the stock photos used for product tests.

## 6. Going live

When 1, 2, 3 and 5 are done, tell Claude **"go live"**. Claude deploys `app.garrabb.com`, `api.garrabb.com`, `admin.garrabb.com` and `cdn.garrabb.com`, moves the Telegram bot to live and runs the same checks. Then:
- keep `admin` + `garrabb.com` in the Cloudflare Access app (it protects the live admin);
- add `https://api.garrabb.com/healthz` to the uptime monitor.

## 7. Phase 4

On hold until you say **"start phase 4"**.
