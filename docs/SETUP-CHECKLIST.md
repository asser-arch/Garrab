# Setup checklist for Asser (step by step)

Do them in this order: each part unblocks the next. Dashboard menus move around; if a name differs slightly, look for the closest match or send Claude a screenshot.

**Never paste a key or token into the chat.** Put it in GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**, then tell Claude the secret's name. Every deploy carries it into the Worker.

**Status (15 Nov 2026):** staging is live at `app-staging.garrabb.com` / `api-staging.garrabb.com` / `admin-staging.garrabb.com`. Every push to `main` that passes all checks deploys there.

| Done ✅ | Still open ⏳ |
|---|---|
| Decisions (prices 5,000 / 8,500 EGP), domain, Cloudflare, R2, staging | Score the bake-off (38) |
| Telegram bot connected | Reply to Genlook with your account email (21b) |
| Genlook key, credits, retention, **written approval** | Try logging into admin-staging |
| Google AI key (both models available) | Native Arabic review of 5 extra strings (DECISIONS.md) |
| Resend verified, key and operator email | Switch on the privacy line in admin-staging; provider comparison (38) |
| Turnstile site key, admin login, brand files, logo, stock photos, uptime monitor | (lawyer set aside;40–41) |

GitHub secrets in place: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GENLOOK_API_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `OPERATOR_EMAIL`, `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECERET_KEY` (spelled this way; the deploy reads it as the Turnstile secret).

---

## Part 1: Decisions (reply in the chat, 5 minutes)

1. ✅ **InstaPay account name**: Asser Rostom.
2. ✅ **Product limits**: none on paid plans (previews are the limit); a per-brand limit can be set in the admin. Pilot: 10.
3. ✅ **VAT**: none for now (0, not shown on invoices).
4. ✅ **Free 14-day pilot**: for every brand.
5. ✅ **`main` branch**: created and set as the default (14 Nov). Deploys will run from `main`.

## Part 2: Domain and Cloudflare (30 minutes, then up to 24 h waiting)

6. ✅ **Get a domain**: `garrabb.com`.
7. ✅ **Add it to Cloudflare** (skip if bought in Cloudflare):
   1. Dashboard → **Add a domain** → type the domain → choose the **Free** plan.
   2. Cloudflare shows **two nameservers**. Log in to where you bought the domain → DNS / Nameservers → replace theirs with Cloudflare's two → save.
   3. Wait until Cloudflare emails you that the domain is **Active** (usually under an hour, up to 24 h).
8. ✅ **Workers Paid (5 USD/month)**: dashboard → **Workers & Pages** → **Plans** (or "Upgrade") → **Workers Paid** → pay. Needed for queues, cron and higher limits.
8b. ✅ **Switch on R2 (file storage)**: dashboard → **R2 Object Storage** → **Get started** → accept (free up to 10 GB; no charge at our size). Tell Claude **"R2 is on"**.
9. ✅ Tell Claude: **"Domain is active: <domain>"**. Claude then wires up staging (creates the database, storage and queue, and deploys).

## Part 3: Telegram bot (10 minutes)

10. ✅ In Telegram, search **@BotFather** (blue tick) → **Start** → send `/newbot`.
11. ✅ Name: `Garrab Ops` → username: something ending in `bot`, e.g. `garrab_ops_asser_bot`.
12. ✅ BotFather replies with a **token** like `123456789:AA…`. Keep it private.
13. ✅ Open your new bot (link in BotFather's message) → **Start** → send it any message, e.g. `hi`.
14. ✅ (Easiest: Telegram Web → ☰ → Saved Messages; the number after `#` in the address bar.) Or in a browser open `https://api.telegram.org/bot<TOKEN>/getUpdates` (put your token in place of `<TOKEN>`). Find `"chat":{"id":123456789` → that number is your **chat ID**.
15. ✅ Tell Claude **"Telegram ready"**.
15b. ✅ Add both to GitHub (same place as the Cloudflare secrets): repo **Settings → Secrets and variables → Actions → New repository secret**:
   - Name `TELEGRAM_BOT_TOKEN`, value: the token from BotFather.
   - Name `TELEGRAM_CHAT_ID`, value: the chat ID number.
   The next deploy connects the bot and it sends you "✅ Garrab staging is connected".

## Part 4: Genlook (15 minutes + their reply)

16. ✅ Go to **platform.genlook.app** → sign up (use a business email if you have one).
17. ✅ **API keys** → **Create key** → copy it (starts with `gk_`).
18. ✅ **Billing / Credits** → add about 10 USD (pay as you go is 0.04 USD per preview; failures are refunded).
19. ✅ **Settings** → **customer image retention** → **1 day**.
20. ✅ Send this email to **thibault@genlook.app** (edit freely):

    > Subject: Reselling Genlook try-on as part of a done-for-you service in Egypt
    >
    > Hi Thibault,
    >
    > I'm building Garrab, a done-for-you AI try-on service for small Egyptian fashion and accessory brands. We build on the Genlook Try-On API: our widget and hosted links call the API from our own backend, under our Genlook account, and we bill the brands a monthly fee for the managed service.
    >
    > Your terms (§6) allow building on the API within our plan. Could you confirm in writing that this use, offering a managed try-on service to many brands under one Genlook account, is allowed? We delete every shopper photo right after each preview using DELETE /customers/{externalUserId} and set retention to 1 day.
    >
    > I'd also love to hear about your startup program, and whether a plan suits ~150 brands at a few hundred previews each per month.
    >
    > Thanks,
    > Asser

21. ✅ Forward Genlook's reply to Claude (paste the text). *(Key: ✅ in GitHub as `GENLOOK_API_KEY`, accepted on staging 15 Nov. Approval received 15 Nov, saved in `docs/vendors/genlook-approval.md`.)*
21b. Reply to Thibault with your **Genlook account email** to get the startup program: free test credits now, and a free first month on a plan at launch.

## Part 5: Google AI (15 minutes)

22. ✅ Go to **aistudio.google.com** → sign in → **Get API key** → **Create API key** → in a new project named `garrab`.
23. ✅ Turn on billing for that project: in AI Studio, open the key's project → **Set up billing** (or console.cloud.google.com → **Billing** → link a billing account with your card).
24. ✅ Check AI Studio shows the project on the **paid tier**. This matters: on the paid tier Google doesn't use your data to improve its products.
25. ✅ Key in GitHub as `GEMINI_API_KEY`; accepted on staging 15 Nov, both models available.
26. *(Optional, for the provider comparison only)* console.cloud.google.com → same project → **APIs & Services → Enable APIs** → enable **Vertex AI API**. Send Claude the **project ID**.

## Part 6: Resend email (20 minutes, after Part 2)

27. ✅ Sign up at **resend.com**.
28. ✅ **Domains → Add domain** → `garrabb.com` → region **Ireland (eu-west-1)** (closest to Egypt).
29. ✅ Resend shows DNS records (MX, TXT/SPF, DKIM). If it offers **"Sign in to Cloudflare"**, use it (adds them automatically). Otherwise: Cloudflare → your domain → **DNS → Add record** → copy each one exactly (set Proxy to **DNS only** / grey cloud).
30. ✅ Back in Resend → **Verify**. Wait until it says **Verified** (minutes to an hour).
31. ✅ **API Keys → Create** → permission **Sending access** → domain `garrabb.com`.
32. ✅ Sending domain is `garrabb.com` (DNS records added); sender `Garrab <hello@garrabb.com>`. Add GitHub secrets `RESEND_API_KEY` and `OPERATOR_EMAIL` (where the daily summary goes), then tell Claude **"Resend secrets added"**.

## Part 7: Bot check and admin login (20 minutes, after Part 2)

33. ✅ **Turnstile**: Cloudflare dashboard → **Turnstile** → **Add widget** → name `Garrab app` → hostnames `app.garrabb.com` and `app-staging.garrabb.com` → mode **Managed** → create. Site key and secret are in GitHub as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`.
34. ✅ **Admin login (Cloudflare Access)**:
    1. Dashboard → **Zero Trust** → pick a team name (e.g. `garrab`) → **Free** plan (it may ask for a card; free up to 50 users).
    2. **Access → Applications → Add an application → Self-hosted**.
    3. Name `Garrab admin`. Under **Destinations**, remove the empty Private IP row and click **+ Add public hostname** twice: subdomain `admin-staging` + domain `garrabb.com`, and subdomain `admin` + domain `garrabb.com` (path empty).
    4. Policy: name `Asser only`, action **Allow**, include **Emails** → your email.
    5. Login methods: **One-time PIN**. Save.
    6. Open the application → copy the **Application Audience (AUD) tag**. Your **team domain** is `<team>.cloudflareaccess.com`. Add both as GitHub secrets `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` (just `<team>.cloudflareaccess.com`, no https://), then tell Claude **"Access secrets added"**.

## Part 8: Files (send in the chat or commit to `docs/`)

35. ✅ **Pitch Kit** (`Garrab_Pitch-Kit.docx`: section 05 has the Arabic UI wording), **Pilot Proposal**, **Brand Guidelines (.pptx)**.
36. ✅ **Two stock photos for automatic product tests**:
    - adults who signed consent (template below); one wearing a hijab, one not, if possible;
    - full body, facing the camera, standing straight, arms slightly away from the body;
    - plain light background, daylight or soft light, fitted plain clothes (no logos);
    - JPEG, at least 1600 px on the long side, no filters or beauty mode.
    - Consent template: *"I agree that Garrab may use these photos of me, privately, to test AI try-on of clothing products, and to show the test results to brands deciding whether to use Garrab. They won't be used in advertising without asking me again. I can withdraw this at any time by telling Garrab. Name, date, signature."*
37. ✅ **Logo** as SVG (mark and wordmark), if you have it.

## Part 9: Checks (Claude runs them once keys are in)

38. **Provider comparison**: ran 15 Nov on nesaaonline.com, 8 products × 2 photos. Google (2 models): 32/32, 1.76 USD. Genlook: 16/16 after a fix, 0.64 USD, about 5 s each. **Score them**: download the two `bakeoff` zips from GitHub → Actions → Checks (runs 2 and 3), open `index.html`, score 1–5, send Claude the CSV. You get a grid of results to score 1–5.
39. ✅ **Genlook delete check**: **PASS** on 15 Nov (photo and result both 404 within seconds of DELETE; `docs/privacy/genlook-delete-2026-11-15.json`). Then Claude switches on "We don't save it" for shoppers.

## Part 10: Before the first real brand

40. ⏸ **Lawyer** (set aside for now by Asser, 15 Nov): send them `/privacy` and `/terms` (Claude can export them) and ask for a review against Egypt's Personal Data Protection Law (Law 151 of 2020), plus whether you need to register with the Data Protection Center.
41. ✅ **Uptime monitor** (staging done 15 Nov; add the live URL at go-live) (after staging is live): uptimerobot.com → free account → **New monitor** → HTTP(s) → `https://api-staging.garrabb.com/healthz` now (add `https://api.garrabb.com/healthz` when live) → every 5 minutes → alerts to your phone (app or email).
