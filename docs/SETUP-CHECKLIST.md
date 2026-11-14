# What Asser needs to do (setup checklist)

Only **A1** blocks Phase 3. Everything else can run in parallel; it's needed for staging and launch.
Never paste keys in chat. When a key is ready, tell Claude and it sends a secure form (or you set it with `wrangler secret put`).

## A. Decisions (10 minutes)

- [ ] **A1. InstaPay, direct or through Kashier?** Direct: brands pay your InstaPay address, tap "I've paid", you confirm with one tap in Telegram. Through Kashier: confirmed automatically, small fee per payment. Default: start direct, switch later. Send: your **InstaPay address** (e.g. `name@instapay`) and the **account name** brands will see.
- [ ] **A2. Product limits on paid plans.** Default Starter 30, Growth 100. Confirm or change.
- [ ] **A3. VAT.** Ask your accountant. Default 0 (not shown on invoices).
- [ ] **A4. Domain name** you want to use (e.g. `garrab.app`).

## B. Accounts and keys

### Cloudflare (needed to deploy anything)
- [ ] **B1.** Add your domain to Cloudflare (change nameservers at your registrar) and subscribe to **Workers Paid** (5 USD/month).
- [ ] **B2.** Create an **API token** with the "Edit Cloudflare Workers" template, plus permissions for D1, R2 and Queues. Note your **Account ID** (dashboard sidebar). Both go into GitHub → repo Settings → Secrets → Actions as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- [ ] **B3. Turnstile:** add a widget for hostname `app.<your-domain>` → copy the **site key** and **secret key**.
- [ ] **B4. Admin login (Zero Trust → Access):** create a free team, add a self-hosted application for `admin.<your-domain>`, allow only your email (one-time PIN). Send the **team domain** (`<team>.cloudflareaccess.com`) and the application's **AUD tag**.

### AI providers
- [ ] **B5. Genlook:** sign up at platform.genlook.app, create an **API key**, top up a few dollars. In account settings set **customer image retention to 1 day**.
- [ ] **B6. Genlook email (important):** write to the address on their startup-program page (`thibault@genlook.app`): you're building a done-for-you try-on service for Egyptian brands on their API; ask them to confirm in writing that this is allowed under their terms (§6), and ask about the startup program. Forward me the reply.
- [ ] **B7. Google AI Studio:** create a project, **enable billing** (paid tier: data not used to improve their products), create an **API key**.
- [ ] **B8. (Optional, for the bake-off) Google Cloud:** a project with the **Vertex AI API** enabled and billing on. Send the **project ID**.

### Email, alerts, payments
- [ ] **B9. Resend:** sign up, add a sending domain such as `mail.<your-domain>`, add the DNS records it shows (in Cloudflare DNS), wait for **Verified**, create an **API key**. Decide the sender, e.g. `Garrab <hello@mail.your-domain>`.
- [ ] **B10. Telegram:** in Telegram open **@BotFather** → `/newbot` → copy the **bot token**. Send your new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id":…}` → your **chat ID**.
- [ ] **B11. Kashier (only if A1 = Kashier, or later):** merchant account at merchant.kashier.io; ask Kashier support to **enable InstaPay collection (QR / request-to-pay)**. Send: **MID**, **Secret key**, **Payment API key** (test first, then live).

## C. Files

- [ ] **C1.** `Garrab_Pitch-Kit.docx` (the Arabic strings in section 05 replace my drafts), `Garrab_Pilot-Proposal.docx`, `Garrab_Brand-Guidelines.pptx`. Upload them here or commit to `docs/`.
- [ ] **C2. Two consented stock photos** for automatic product tests (and the bake-off):
  - real adults who signed a consent allowing AI try-on testing (keep the signed forms);
  - full body, facing the camera, arms slightly away from the body, plain background, good light;
  - JPEG, at least 1600 px on the long side, no filters;
  - ideally one model wearing a hijab and one not, matching your customers.
- [ ] **C3. Logo** as SVG (mark and wordmark), if you have it. Otherwise I draw it from the guideline.

## D. Checks to run once keys exist (I can run them for you)

- [ ] **D1. Provider bake-off:** pick one target brand's Shopify store → `pnpm --filter @garrab/api bakeoff -- --photos ../../fixtures --shop https://<brand> --count 10` (about 4 USD). Score the grid, send me the CSV. Decides Genlook vs Google.
- [ ] **D2. Genlook delete check:** `GENLOOK_API_KEY=… pnpm --filter @garrab/api verify:genlook-delete -- ../../fixtures/<photo>.jpg` must say **PASS**. Only then does "We don't save it" appear to shoppers.

## E. Before the first real brand (not before Phase 3)

- [ ] **E1.** A lawyer reviews `/privacy` and `/terms` against Egypt's PDPL (Law 151 of 2020).
- [ ] **E2.** A free uptime monitor (e.g. UptimeRobot) on `https://api.<your-domain>/healthz`, alerting your phone.
