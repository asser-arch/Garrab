# Security review — 24 Nov 2026

Scope: everything a stranger, a brand or a shopper can reach — the website script (w.js) and try-on
frame, /v1 (config, try-on, hosted pages, events, size, sign-up, contact, pay), the brand portal API,
the admin API, the Telegram and Kashier webhooks, file serving, product import, emails, support chat,
privacy promises. Method: code review of every route and its checks, plus new automated tests
(apps/api/test/security.test.ts).

## Fixed in this review
| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | Web addresses were checked as "any URL", so `javascript:` / `data:` addresses were accepted (product link, website). Not exploitable today (account creation already rebuilt the website as an https origin; product links became same-site paths), but one future screen away from a script-injection bug on app.garrabb.com or the admin. | Low today, high if reopened | Shared `httpUrl` check (http/https only) on every address a brand or visitor types; the shopper's Buy button only links to http(s). |
| 2 | No limit on sign-in emails per address: inbox flooding from many networks, and fresh codes to get more guesses at the 6-digit code. | Medium | At most 5 sign-in emails per address per hour (same answer either way, so no account probing). |
| 3 | The bot check (Turnstile) didn't confirm it was solved on our own site. | Low | Token must come from APP_ORIGIN's host. |
| 4 | Every forged webhook call raised a Telegram alert (alert flooding) and fake Kashier calls were stored in full. | Low | Signature-failure alerts at most once an hour per source; unsigned Kashier bodies not stored. |

## Checked and sound
- Admin: Cloudflare Access token required on every call (RS256 signature, audience, expiry, issuer); dev token only when ENVIRONMENT is dev/test.
- Brand sign-in: single-use links (token in the URL fragment), 6-digit codes with 5 tries each, IP rate limits, session tokens random and stored hashed, `__Host-` HttpOnly Secure SameSite=Lax cookie, Origin check on every write, admin view-as is read-only.
- Isolation: every portal query is scoped to the signed-in brand; cross-brand access tests exist.
- Try-on: signed 10-minute passes bound to brand + website, product must belong to that brand, status re-checked on every preview (kill switch), bot check, per-IP and per-brand limits, monthly allowance never on credit, per-brand daily cap, global daily spend cap.
- Uploads: real image type checked from the bytes (no SVG), size limits, JPEG metadata removed, HEIC metadata blanked server-side, unguessable file names.
- Payments: pay links are 32-character secrets; payments idempotent; short amounts refused; an invoice can only be paid once; Telegram buttons signed, Asser's chat only, secret header; Kashier refuses everything while its key is empty.
- No HTML injection: brand text is always inserted as text (React, textContent); emails escape every brand value.
- SQL: all queries parameterised.
- Pages: strict Content-Security-Policy, frame-ancestors none except the widget frame, nosniff, no-referrer.
- No secrets in the repository.
- The website script runs in a sealed Shadow DOM and opens try-on in a sandboxed frame on our domain; it reads no cookies, forms or customer data, and fails silently.

## Accepted / for later
- Anyone can send fake view/click events for a brand (inflates its Results). Low impact; could add per-brand event sanity limits.
- Admin Access: the token issuer is taken from the token when it is a *.cloudflareaccess.com team; safe because the audience tag is unique to our application, but pinning to CF_ACCESS_TEAM_DOMAIN would be stricter once that setting is confirmed correct.
- Product titles/descriptions go into AI prompts; a brand could only influence its own previews.

## Outside the code (Asser)
1. Turn on two-step login (2FA) for Cloudflare, GitHub, Google, Resend and Telegram — whoever controls these controls the script on every brand's site.
2. Set the global daily AI cap (Dashboard → AI spending) to what you're willing to lose in a day.
3. Lawyer review of privacy and terms; add "no photos of other people without consent, no minors".
4. Before big-brand deals: an independent penetration test.
