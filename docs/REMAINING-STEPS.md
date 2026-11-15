# What's left on your side (15 Nov 2026)

Everything else is done: domain, Cloudflare, staging, Telegram, Genlook (key, credits, written approval, delete check **PASS**), Google AI (paid tier), Resend (verified), Turnstile, admin login, brand files, logo, Arabic wording, prices (5,000 / 8,500 EGP).

Staging: `app-staging.garrabb.com` · `api-staging.garrabb.com` · `admin-staging.garrabb.com`

---

## 1. ✅ Log into the admin (done 15 Nov)

1. Open **https://admin-staging.garrabb.com**.
2. Enter your email → type the 6-digit code Cloudflare emails you.
3. You should see the Garrab admin (empty: no brands yet).
4. Tell Claude **"admin works"**, or send a screenshot of any error.

## 2. ✅ Switch on the privacy line (done 15 Nov)

Shoppers then see: *"Your photo is used only to create this preview. We don't save it. It's deleted when you close this page."*

1. In the admin, find the **Privacy line** card → **Turn on with report**.
2. Paste this exactly and confirm:

```json
{"startedAt":"2026-11-15T11:29:22.176Z","externalUserId":"verify-426bad16-51c0-482d-981e-3b7e5db8bc7d","photo":"model-a.jpg","upload":{"status":201,"code":null},"tryOn":{"status":201,"code":null,"keepHeadCoveringAccepted":true},"before":[200,200],"deleteStatus":204,"after":[404,404],"urlsChecked":2,"result":"PASS","finishedAt":"2026-11-15T11:29:30.852Z"}
```

3. The card should now say **ON**. The report expires after 90 days; Claude reruns the check before then (GitHub → Actions → Checks).

## 3. Score the bake-off (20–30 minutes)

1. Open each run page and scroll to the bottom, to **Artifacts** → click **bakeoff** to download the zip:
   - Google: https://github.com/asser-arch/Garrab/actions/runs/43711464354
   - Genlook: https://github.com/asser-arch/Garrab/actions/runs/43712878638
2. Unzip each, open `index.html` in your browser.
3. For every result pick **1–5**: 5 = I'd show this to a shopper; 1 = unusable. Look at: the garment is right (colour, shape, details), the person is unchanged (face, hijab, body), no glitches, the fit looks believable.
4. Press **Download my scores (CSV)** on each page and send both CSV files to Claude.

Claude then recommends the main provider and whether to keep a backup.

## 4. First real test on staging (15 minutes, after step 1)

1. Admin → **Onboarding** → **Invite** a test brand using a second email address of yours.
2. Open that inbox: a sign-in email from `hello@garrabb.com` should arrive (check spam the first time).
3. Follow it, sign in to the portal, add 1–2 products (e.g. from nesaaonline.com).
4. Watch the products get tested on the stock photos, approve them, and try the preview yourself.
5. Tell Claude what worked and what felt confusing.

## 5. Arabic check by a native speaker (10 minutes of their time)

The main try-on wording is copied from your Pitch Kit. These 8 lines aren't in the Pitch Kit, so Claude wrote them in the same style. Ask a native speaker if they read naturally:

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

Send Claude any corrections (or "Arabic OK").

## 6. Genlook follow-up (5 minutes)

1. When Thibault replies about the startup program, forward it to Claude (free credits, free first month).
2. When you buy a Genlook plan, tell Claude which one, so cost tracking uses the real price per preview (now 0.04 USD; Scale works out to 0.015).

## 7. Before the first real brand

1. **Lawyer** (Egypt's Personal Data Protection Law, Law 151 of 2020). Send them:
   - the privacy page: https://app-staging.garrabb.com/privacy
   - the terms page: https://app-staging.garrabb.com/terms
   - the Pilot Proposal (`docs/brand/Garrab_Pilot-Proposal.docx`)
   - Genlook's terms (genlook.app/terms, section 6) and data agreement (genlook.app/dpa)

   Ask: is the wording right, does Garrab need to register with the Data Protection Center, and does each brand need a data processing agreement with Garrab. Send Claude their changes.
2. **Uptime monitor** (5 minutes): uptimerobot.com → free account → **New monitor** → HTTP(s) → `https://api-staging.garrabb.com/healthz` → every 5 minutes → alerts by app or email. Add `https://api.garrabb.com/healthz` when the live site is up.
3. **Optional, better:** two photos of real people who sign the consent text (in `docs/SETUP-CHECKLIST.md`, step 36), to replace the stock photos used for product tests.

## 8. Going live

When steps 1–5 and 7 are done, tell Claude **"go live"**. Claude deploys `app.garrabb.com`, `api.garrabb.com`, `admin.garrabb.com` and `cdn.garrabb.com`, moves the Telegram bot to live, and runs the same checks. You then add the live uptime monitor.

## 9. Phase 4

On hold until you say **"start phase 4"**.
