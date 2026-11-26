/**
 * Operator API (Asser only). Behind Cloudflare Access; every write is audit-logged.
 * Phase 2 scope: invite a brand, funnel, onboarding list and detail, step overrides,
 * one-click reminders, review "needs review" products.
 */
import { InviteBrand, OnboardingStep, httpUrl } from "@garrab/shared";
import { CAPS, PLANS, SETUP_FEE, SUPPORT, type PlanId } from "@garrab/shared/plans";
import { Hono } from "hono";
import { z } from "zod";
import { emails } from "../emails.js";
import { cdnOrigin, type Env } from "../env.js";
import { createAccount, newWidgetKey } from "../lib/accounts.js";
import { adminIdentity, checkAccessJwt, createMagicLink, createSignIn } from "../lib/auth.js";
import { sha256Hex, ulid } from "../lib/crypto.js";
import { sendOnce } from "../lib/email.js";
import { cairoDay } from "../lib/time.js";
import { getSetting, invalidateStatus, originHost, setSetting } from "../lib/db.js";
import { alert, transitionStatus } from "../lib/ops.js";
import { removeProduct, clearProductTests, deletePrefix } from "../lib/products.js";
import { log } from "../lib/log.js";
import { readPeriod } from "../lib/report.js";
import { uploadProduct } from "./portal.js";
import { adminWrites, messages as supportMessages, threads as supportThreads } from "../lib/support.js";
import { cycleStartOf } from "../lib/metering.js";
import { addDays } from "../billing/dates.js";
import { accountFacts, applyPayment, createInvoice, monthlyPrice, ensurePlanInvoice, openPlanInvoice, payUrl, pdfUrl, reconcileAccount } from "../billing/ledger.js";
import { decideClaim } from "../billing/instapay.js";
import { runJobNow } from "../jobs.js";
import { imageFromLink, outreachPreview } from "../lib/outreach.js";
import { listFixtures } from "../onboarding/tests.js";
import { sniffImage } from "../lib/photo.js";
import { toBase64 } from "../providers/google.js";
import { buildDigest } from "../ops/digest.js";
import { STEP_LABEL, advance, overrideStep, portalUrl, type Step } from "../onboarding/machine.js";

/** Private notes on a brand: up to about five thousand characters. */
const NOTES_MAX_CHARS = 5 * 1024;

type Vars = { admin: string };
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

admin.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const who = await adminIdentity(c);
  if (!who) {
    const jwt = c.req.header("cf-access-jwt-assertion");
    const reason = jwt ? ((await checkAccessJwt(c.env, jwt)) as { reason?: string }).reason : "not_logged_in";
    log("admin_auth", { code: reason ?? "unknown" });
    return c.json({ error: "unauthorized", reason }, 401);
  }
  c.set("admin", who);
  await next();
});

async function audit(env: Env, accountId: string | null, actor: string, action: string, reason: string | null, meta: unknown = null): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason, meta_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ulid(), accountId, `admin:${actor}`, action, reason, meta ? JSON.stringify(meta) : null)
    .run();
}

/** Invite a brand in 10 seconds: returns a sign-in link to hand over in person. */
admin.post("/invite", async (c) => {
  const body = InviteBrand.extend({
    website: httpUrl(300).optional(),
    whatsapp: z.string().trim().max(20).optional(),
    platform: z.enum(["shopify", "woocommerce", "other_website", "social_only"]).optional(),
    setupFee: z.boolean().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid", fields: body.error.issues.map((i) => i.path.join(".")) }, 400);
  const { accountId, userId, created } = await createAccount(c.env, body.data);
  const link = await createMagicLink(c.env, userId, body.data.email);
  await audit(c.env, accountId, c.get("admin"), "invite", created ? "new account" : "existing account");
  if (created) {
    await c.env.JOBS.send({ t: "advance", a: accountId });
    return c.json({ ok: true, accountId, created, link });
  }
  // Same email again: no duplicate account. Re-send the welcome only if it never went out
  // (sendOnce retries a failed send and skips one that succeeded), so nothing is sent twice.
  const acc = await c.env.DB.prepare("SELECT name, status FROM accounts WHERE id = ?").bind(accountId).first<{ name: string; status: string }>();
  let welcome: "sent_now" | "already_sent" | "failed" | "not_applicable" = "not_applicable";
  if (acc?.status === "onboarding") {
    const prev = await c.env.DB.prepare("SELECT status FROM notifications WHERE dedupe_key = ?").bind(`welcome:${accountId}`).first<{ status: string }>();
    if (prev?.status === "sent") welcome = "already_sent";
    else {
      const ok = await sendOnce(c.env, { accountId, template: "welcome", dedupeKey: `welcome:${accountId}`, msg: emails.welcome(body.data.email, acc.name, link) });
      welcome = ok ? "sent_now" : "failed";
    }
  }
  const reason =
    welcome === "failed"
      ? ((await c.env.DB.prepare("SELECT error FROM notifications WHERE dedupe_key = ?").bind(`welcome:${accountId}`).first<{ error: string | null }>())?.error ?? null)
      : null;
  return c.json({ ok: true, accountId, created, link, existing: { name: acc?.name ?? null, status: acc?.status ?? null, welcome, reason } });
});

/** Selling through customers: call-back requests and new brands per referring brand. */
admin.get("/leads", async (c) => {
  const [requests, referrals] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.name, r.whatsapp, r.brand, r.created_at, a.name AS via FROM contact_requests r LEFT JOIN accounts a ON a.slug = r.referred_by
        WHERE r.handled_at IS NULL ORDER BY r.created_at DESC LIMIT 100`,
    ).all(),
    c.env.DB.prepare(
      `SELECT a.name AS via, COUNT(*) AS leads FROM leads l JOIN accounts a ON a.slug = l.referred_by
        WHERE l.created_at >= datetime('now', '-90 days') GROUP BY l.referred_by ORDER BY leads DESC LIMIT 20`,
    ).all(),
  ]);
  return c.json({ requests: requests.results, referrals: referrals.results });
});

admin.post("/contact-requests/:id/done", async (c) => {
  await c.env.DB.prepare("UPDATE contact_requests SET handled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(c.req.param("id")).run();
  await audit(c.env, null, c.get("admin"), "contact_request_done", c.req.param("id"));
  return c.json({ ok: true });
});

admin.get("/funnel", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS invited,
            SUM(CASE WHEN onboarding_step IN ('installed','pilot_live','converted','expired') THEN 1 ELSE 0 END) AS installed,
            SUM(CASE WHEN onboarding_step IN ('pilot_live','converted','expired') THEN 1 ELSE 0 END) AS pilot_live,
            SUM(CASE WHEN status IN ('active','past_due') THEN 1 ELSE 0 END) AS paying,
            SUM(CASE WHEN status IN ('cancelled','expired','archived') THEN 1 ELSE 0 END) AS churned
       FROM accounts`,
  ).first<Record<string, number | null>>();
  const n = (k: string): number => r?.[k] ?? 0;
  const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 100) : null);
  return c.json({
    stages: [
      { stage: "invited", count: n("invited"), conversion: null },
      { stage: "installed", count: n("installed"), conversion: pct(n("installed"), n("invited")) },
      { stage: "pilot_live", count: n("pilot_live"), conversion: pct(n("pilot_live"), n("installed")) },
      { stage: "paying", count: n("paying"), conversion: pct(n("paying"), n("pilot_live")) },
      { stage: "churned", count: n("churned"), conversion: null },
    ],
  });
});

admin.get("/accounts", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, slug, status, plan_id, target_plan_id, platform, onboarding_step, onboarding_step_at, pilot_ends_at, email
       FROM accounts ORDER BY created_at DESC LIMIT 500`,
  ).all<{ onboarding_step: Step; onboarding_step_at: string | null } & Record<string, unknown>>();
  const now = Date.now();
  return c.json({
    accounts: rows.results.map((a) => ({
      ...a,
      stepLabel: STEP_LABEL[a.onboarding_step],
      hoursInStep: a.onboarding_step_at ? Math.round((now - Date.parse(a.onboarding_step_at)) / 3_600_000) : null,
    })),
  });
});

admin.get("/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
  if (!account) return c.json({ error: "not_found" }, 404);
  const [steps, products, tests, audit_log] = await Promise.all([
    c.env.DB.prepare("SELECT step, state, entered_at, done_at, actor, note FROM onboarding_steps WHERE account_id = ? ORDER BY entered_at").bind(id).all(),
    c.env.DB.prepare(
      "SELECT id, title, kind, images_json, selected, test_score, enabled, needs_review, disabled_reason, brand_decision, approved FROM products WHERE account_id = ? ORDER BY selected DESC, title LIMIT 300",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare("SELECT id, product_id, fixture, score, reason, rubric_json FROM product_tests WHERE account_id = ? ORDER BY created_at").bind(id).all(),
    c.env.DB.prepare("SELECT actor, action, from_status, to_status, reason, meta_json, created_at FROM audit_log WHERE account_id = ? ORDER BY created_at DESC LIMIT 100").bind(id).all(),
  ]);
  return c.json({ account, steps: steps.results, products: products.results, tests: tests.results, audit: audit_log.results });
});

admin.post("/accounts/:id/step", async (c) => {
  const body = z.object({ to: OnboardingStep, reason: z.string().trim().min(3).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const ok = await overrideStep(c.env, c.req.param("id"), body.data.to, body.data.reason, c.get("admin"));
  return ok ? c.json({ ok: true }) : c.json({ error: "conflict" }, 409);
});

admin.post("/accounts/:id/advance", async (c) => {
  const step = await advance(c.env, c.req.param("id"));
  return c.json({ ok: true, step });
});

/** One-click reminder from the stuck list (once per account per day). */
admin.post("/accounts/:id/remind", async (c) => {
  const id = c.req.param("id");
  const a = await c.env.DB.prepare("SELECT onboarding_step FROM accounts WHERE id = ?").bind(id).first<{ onboarding_step: Step }>();
  const u = await c.env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(id).first<{ email: string }>();
  if (!a || !u) return c.json({ error: "not_found" }, 404);
  const sent = await sendOnce(c.env, {
    accountId: id,
    template: "step_reminder",
    dedupeKey: `reminder:${id}:${cairoDay()}`,
    msg: emails.stepReminder(u.email, STEP_LABEL[a.onboarding_step], portalUrl(c.env)),
  });
  await audit(c.env, id, c.get("admin"), "reminder", STEP_LABEL[a.onboarding_step]);
  return c.json({ ok: true, sent });
});

/**
 * Remove a product (duplicates, mistakes). Products added by hand are deleted with their tests and
 * any uploaded photo no other product uses. Imported products (Shopify, Woo, website) are hidden
 * instead: deleting them would only bring them back at the next nightly re-sync.
 */
admin.post("/products/:id/delete", async (c) => {
  const pid = c.req.param("id");
  const p = await c.env.DB.prepare("SELECT account_id, title, source, images_json FROM products WHERE id = ?")
    .bind(pid)
    .first<{ account_id: string; title: string; source: string; images_json: string }>();
  if (!p) return c.json({ error: "not_found" }, 404);
  const hidden = await removeProduct(c.env, p.account_id, pid);
  await audit(c.env, p.account_id, c.get("admin"), hidden ? "product_hide" : "product_delete", p.title, { product: pid, title: p.title, source: p.source });
  return c.json({ ok: true, hidden });
});

/** Clear a product's test so it runs again (e.g. after switching from test mode to real try-ons). */
admin.post("/products/:id/retest", async (c) => {
  const p = await c.env.DB.prepare("SELECT account_id FROM products WHERE id = ?").bind(c.req.param("id")).first<{ account_id: string }>();
  if (!p) return c.json({ error: "not_found" }, 404);
  // Old results go, so the card only ever shows the latest run (one result per stock model).
  await clearProductTests(c.env, p.account_id, c.req.param("id"));
  await c.env.DB.prepare("UPDATE products SET test_score = NULL, test_started_at = NULL, test_retry_at = NULL, test_busy_count = 0, enabled = 0, needs_review = 0, disabled_reason = NULL, selected = 1 WHERE id = ?")
    .bind(c.req.param("id"))
    .run();
  await audit(c.env, p.account_id, c.get("admin"), "product_retest", null, { product: c.req.param("id") });
  await c.env.JOBS.send({ t: "advance", a: p.account_id });
  return c.json({ ok: true });
});

/** Decide a "needs review" product (score 3): enable it for the brand to approve, or disable it. */
admin.post("/products/:id/review", async (c) => {
  const body = z.object({ enable: z.boolean(), reason: z.string().trim().min(3).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const p = await c.env.DB.prepare("SELECT account_id FROM products WHERE id = ?").bind(c.req.param("id")).first<{ account_id: string }>();
  if (!p) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("UPDATE products SET enabled = ?, needs_review = 0, disabled_reason = ? WHERE id = ?")
    .bind(body.data.enable ? 1 : 0, body.data.enable ? null : body.data.reason, c.req.param("id"))
    .run();
  await audit(c.env, p.account_id, c.get("admin"), "product_review", body.data.reason, { product: c.req.param("id"), enable: body.data.enable });
  await c.env.JOBS.send({ t: "advance", a: p.account_id });
  return c.json({ ok: true });
});

admin.get("/test-image/:id", async (c) => {
  const t = await c.env.DB.prepare("SELECT r2_key FROM product_tests WHERE id = ?").bind(c.req.param("id")).first<{ r2_key: string | null }>();
  const obj = t?.r2_key ? await c.env.FILES.get(t.r2_key) : null;
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/jpeg", "cache-control": "private, max-age=3600" } });
});

admin.get("/status", async (c) => {
  const crons = await c.env.DB.prepare(
    "SELECT job, MAX(started_at) AS last_run, (SELECT ok FROM cron_runs r2 WHERE r2.job = r.job ORDER BY started_at DESC LIMIT 1) AS last_ok FROM cron_runs r GROUP BY job",
  ).all();
  const alerts = await c.env.DB.prepare("SELECT id, kind, account_id, message, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50").all();
  return c.json({ crons: crons.results, alerts: alerts.results });
});

// ---------------------------------------------------------------- Phase 3: money, kill switch, operations

const Reason = z.string().trim().min(3).max(300);

admin.get("/dashboard", async (c) => {
  const env = c.env;
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const fx = await getSetting<number | null>(env, "egp_per_usd", null);
  const [counts, accounts, revenue, cost, alertsOpen, claims, due, crons, globalKill] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM accounts GROUP BY status").all<{ status: string; n: number }>(),
    env.DB.prepare(
      "SELECT id, name, status, plan_id, target_plan_id, paid_through, cycle_start, manual_hold, monthly_price FROM accounts WHERE status IN ('pilot','active','past_due','suspended') ORDER BY name",
    ).all<{ id: string; name: string; status: string; plan_id: PlanId; target_plan_id: PlanId | null; paid_through: string | null; cycle_start: string | null; manual_hold: number; monthly_price: number | null }>(),
    env.DB.prepare("SELECT account_id, SUM(amount) AS s FROM payments WHERE created_at >= ? GROUP BY account_id").bind(since30).all<{ account_id: string; s: number }>(),
    env.DB.prepare("SELECT account_id, SUM(cost_micro_usd) AS s FROM usage_events WHERE created_at >= ? GROUP BY account_id").bind(since30).all<{ account_id: string; s: number }>(),
    env.DB.prepare("SELECT id, kind, account_id, message, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 30").all(),
    env.DB.prepare(
      `SELECT c.id, a.name, i.number, i.total, c.reference, c.created_at FROM payment_claims c JOIN invoices i ON i.id = c.invoice_id JOIN accounts a ON a.id = c.account_id
        WHERE c.status = 'pending' ORDER BY c.created_at`,
    ).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'open' AND due_date <= ?").bind(addDays(cairoDay(), 3)).first<{ n: number }>(),
    env.DB.prepare("SELECT job, MAX(started_at) AS last_run, MIN(ok) AS ok FROM (SELECT job, started_at, ok FROM cron_runs ORDER BY started_at DESC LIMIT 200) GROUP BY job").all(),
    getSetting<boolean>(env, "global_kill", false),
  ]);
  const rev = new Map(revenue.results.map((r) => [r.account_id, r.s]));
  const cst = new Map(cost.results.map((r) => [r.account_id, r.s]));
  const rows = [];
  let mrr = 0;
  for (const a of accounts.results) {
    // MRR is the money brands actually pay each month: their own price (early bird, deals) or the list price.
    if (a.status === "active" || a.status === "past_due") mrr += monthlyPrice(a, a.plan_id);
    const usage = await env.DB.prepare("SELECT used, included, extra FROM cycle_usage WHERE account_id = ? AND cycle_start = ?")
      .bind(a.id, cycleStartOf(a))
      .first<{ used: number; included: number; extra: number }>();
    const revenue30 = rev.get(a.id) ?? 0;
    const costUsd = (cst.get(a.id) ?? 0) / 1e6;
    rows.push({
      id: a.id,
      name: a.name,
      status: a.status,
      plan: a.monthly_price !== null ? `${PLANS[a.plan_id].name} (${(a.monthly_price / 100).toLocaleString("en-US")} EGP/mo)` : PLANS[a.plan_id].name,
      paidThrough: a.paid_through,
      manualHold: a.manual_hold === 1,
      previews: usage ? `${usage.used} / ${usage.included + usage.extra}` : `0 / ${PLANS[a.plan_id].includedPreviews}`,
      revenue30,
      costUsd30: Math.round(costUsd * 100) / 100,
      margin30: fx ? revenue30 - Math.round(costUsd * fx * 100) : null,
    });
  }
  // This calendar month (Cairo): money received minus every AI cost (previews, room previews, size answers,
  // product tests and scoring), converted at the EGP/USD rate you set.
  const month = cairoDay().slice(0, 7);
  const monthStart = new Date(Date.parse(`${month}-01T00:00:00Z`) - 3 * 3_600_000).toISOString(); // Cairo midnight (UTC+2/+3), safe side
  const [mRev, mCost] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE created_at >= ?").bind(monthStart).first<{ s: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM usage_events WHERE created_at >= ?").bind(monthStart).first<{ s: number }>(),
  ]);
  const monthRevenue = mRev?.s ?? 0;
  const monthCostUsd = Math.round((mCost?.s ?? 0) / 1e4) / 100;
  const monthCostEgp = fx ? Math.round(((mCost?.s ?? 0) / 1e6) * fx * 100) : null;
  return c.json({
    statusCounts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
    mrr,
    month: { label: month, revenue: monthRevenue, aiCostUsd: monthCostUsd, aiCostEgp: monthCostEgp, margin: monthCostEgp === null ? null : monthRevenue - monthCostEgp },
    egpPerUsd: fx,
    dailyCapUsd: await getSetting<number>(env, "global_daily_cap_usd", CAPS.globalDailyUsd),
    globalKill,
    privacyClaim: await getSetting(env, "privacy_claim_verified", false),
    clients: rows,
    alerts: alertsOpen.results,
    pendingClaims: claims.results,
    dueSoon: due?.n ?? 0,
    crons: crons.results,
  });
});

admin.get("/search", async (c) => {
  const q = `%${(c.req.query("q") ?? "").trim().slice(0, 60)}%`;
  const rows = await c.env.DB.prepare("SELECT id, name, status, email FROM accounts WHERE name LIKE ? OR email LIKE ? OR slug LIKE ? OR website LIKE ? LIMIT 20").bind(q, q, q, q).all();
  return c.json({ results: rows.results });
});

admin.get("/accounts/:id/billing", async (c) => {
  const id = c.req.param("id");
  const [invoices, payments, claims] = await Promise.all([
    c.env.DB.prepare("SELECT id, number, kind, total, status, due_date, period_start, period_end, pay_token, paid_at FROM invoices WHERE account_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all<{ pay_token: string } & Record<string, unknown>>(),
    c.env.DB.prepare("SELECT provider, provider_txn_id, amount, method, reference, note, actor, created_at FROM payments WHERE account_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all(),
    c.env.DB.prepare("SELECT id, invoice_id, reference, payer_name, status, created_at, decided_by FROM payment_claims WHERE account_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all(),
  ]);
  const wa = await c.env.DB.prepare("SELECT whatsapp FROM accounts WHERE id = ?").bind(id).first<{ whatsapp: string | null }>();
  return c.json({
    invoices: invoices.results.map((i) => ({
      ...i,
      payUrl: payUrl(c.env, i.pay_token),
      pdfUrl: pdfUrl(c.env, i.pay_token),
      // v1 WhatsApp: a ready message the operator sends from their own WhatsApp.
      whatsapp: wa?.whatsapp && i.status === "open" ? `https://wa.me/${wa.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(`Hi! Your Garrab invoice ${String(i.number)} (${Number(i.total) / 100} EGP, due ${String(i.due_date)}) is ready. Pay by InstaPay here: ${payUrl(c.env, i.pay_token)}`)}` : null,
    })),
    payments: payments.results,
    claims: claims.results,
  });
});

/** Kill: switch the account off now (reason required). Nothing automatic lifts it; only Restore. */
admin.post("/accounts/:id/kill", async (c) => {
  const body = z.object({ reason: Reason }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "reason_required" }, 400);
  const a = await accountFacts(c.env, c.req.param("id"));
  if (!a) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("UPDATE accounts SET manual_hold = 1 WHERE id = ?").bind(a.id).run();
  const to = ["pilot", "active", "past_due"].includes(a.status) ? "suspended" : "paused";
  await transitionStatus(c.env, a, to, `admin:${c.get("admin")}`, `Kill: ${body.data.reason}`);
  return c.json({ ok: true, status: to });
});

admin.post("/accounts/:id/pause", async (c) => {
  const body = z.object({ reason: Reason }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "reason_required" }, 400);
  const a = await accountFacts(c.env, c.req.param("id"));
  if (!a) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("UPDATE accounts SET manual_hold = 1 WHERE id = ?").bind(a.id).run();
  const ok = await transitionStatus(c.env, a, "paused", `admin:${c.get("admin")}`, `Pause: ${body.data.reason}`);
  return ok ? c.json({ ok: true, status: "paused" }) : c.json({ error: "not_allowed" }, 409);
});

/** Restore: lift the hold and put the account where the ledger says it should be. */
admin.post("/accounts/:id/restore", async (c) => {
  const body = z.object({ reason: Reason }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "reason_required" }, 400);
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE accounts SET manual_hold = 0 WHERE id = ?").bind(id).run();
  await audit(c.env, id, c.get("admin"), "restore", body.data.reason);
  const a = await accountFacts(c.env, id);
  // A paused onboarding account goes back to onboarding; everything else follows the ledger.
  if (a?.status === "paused" && !a.paid_through && !a.pilot_started_at) await transitionStatus(c.env, a, "onboarding", `admin:${c.get("admin")}`, `Restore: ${body.data.reason}`);
  const status = await reconcileAccount(c.env, id, new Date(), `admin:${c.get("admin")}`);
  return c.json({ ok: true, status });
});

/** The global emergency switch: disables every preview everywhere within a minute. */
admin.post("/global-kill", async (c) => {
  const body = z.object({ on: z.boolean(), reason: Reason }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "reason_required" }, 400);
  await setSetting(c.env, "global_kill", body.data.on);
  await audit(c.env, null, c.get("admin"), body.data.on ? "global_kill_on" : "global_kill_off", body.data.reason);
  await alert(c.env, "global_kill", null, `Global emergency switch ${body.data.on ? "ON: all previews disabled" : "OFF: previews back"}. ${body.data.reason}`);
  return c.json({ ok: true, on: body.data.on });
});

/**
 * "Not saved on our systems" may only appear after the provider delete check passes (brief §3).
 * Turning it on requires the PASS report from scripts/verify-genlook-delete.ts, less than 90 days old.
 */
admin.post("/privacy-claim", async (c) => {
  const body = z
    .object({
      on: z.boolean(),
      report: z.object({ result: z.literal("PASS"), finishedAt: z.string(), deleteStatus: z.literal(204), urlsChecked: z.literal(2), after: z.array(z.number()) }).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_report" }, 400);
  if (body.data.on) {
    const r = body.data.report;
    if (!r || Date.now() - Date.parse(r.finishedAt) > 90 * 86_400_000 || !r.after.every((s) => s >= 400)) return c.json({ error: "needs_recent_pass_report" }, 400);
    await setSetting(c.env, "privacy_delete_report", r);
  }
  await setSetting(c.env, "privacy_claim_verified", body.data.on);
  await audit(c.env, null, c.get("admin"), "privacy_claim", body.data.on ? "on (delete check PASS)" : "off");
  return c.json({ ok: true, on: body.data.on });
});

/** Manual provider: bank transfer, InstaPay seen in the app, cash. Idempotent per `key`. */
admin.post("/invoices/:id/mark-paid", async (c) => {
  const body = z
    .object({ method: z.enum(["instapay", "bank_transfer", "cash", "other"]), reference: z.string().trim().max(80).optional(), note: z.string().trim().max(300).optional(), key: z.string().min(8).max(64) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const inv = await c.env.DB.prepare("SELECT id, total FROM invoices WHERE id = ?").bind(c.req.param("id")).first<{ id: string; total: number }>();
  if (!inv) return c.json({ error: "not_found" }, 404);
  const r = await applyPayment(c.env, {
    invoiceId: inv.id,
    provider: "manual",
    txnId: `manual:${body.data.key}`,
    amount: inv.total,
    method: body.data.method,
    reference: body.data.reference ?? null,
    note: body.data.note ?? null,
    actor: `admin:${c.get("admin")}`,
  });
  return r.applied || r.reason === "duplicate" ? c.json({ ok: true, ...r }) : c.json({ error: r.reason }, 409);
});

admin.post("/claims/:id/decide", async (c) => {
  const body = z.object({ confirm: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const r = await decideClaim(c.env, c.req.param("id"), body.data.confirm ? "a" : "r", `admin:${c.get("admin")}`);
  return c.json({ ok: r === "confirmed" || r === "rejected", result: r });
});

admin.post("/accounts/:id/invoice", async (c) => {
  const a = await accountFacts(c.env, c.req.param("id"));
  if (!a || a.status === "onboarding") return c.json({ error: "not_billable" }, 400);
  const inv = await ensurePlanInvoice(c.env, a, new Date());
  await audit(c.env, a.id, c.get("admin"), "invoice", inv.number);
  return c.json({ ok: true, number: inv.number, payUrl: payUrl(c.env, inv.pay_token) });
});

/**
 * Billing by hand: make an invoice for a plan (any number of months, any price: discounts, custom deals) and
 * either record that it's already paid (InstaPay seen in the app, bank transfer, cash) or leave it open and
 * send the brand its pay link. Brand in its pilot: Garrab chooses whether the paid months start counting now
 * or the day after the pilot ends (keeping the remaining pilot days); the choice is kept on the invoice, so it
 * also applies when the brand pays an open one. Any other open plan invoice is voided.
 */
admin.post("/accounts/:id/record", async (c) => {
  const body = z
    .object({
      plan: z.enum(["starter", "growth"]),
      months: z.number().int().min(1).max(12),
      /** Total in EGP (whole or with piastres), setup fee included when `setupFee` is on. */
      amountEgp: z.number().min(0).max(1_000_000),
      setupFee: z.boolean(),
      paid: z.boolean(),
      /** Brand in its pilot: start counting the paid months now, or after the pilot ends. Required then. */
      start: z.enum(["now", "after_pilot"]).optional(),
      method: z.enum(["instapay", "bank_transfer", "cash", "other"]).default("instapay"),
      reference: z.string().trim().max(80).optional(),
      note: z.string().trim().max(300).optional(),
      key: z.string().min(8).max(64),
      /** Save this invoice's monthly amount as the brand's own price, for renewals and MRR. */
      keepPrice: z.boolean().default(false),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const d = body.data;
  const a = await accountFacts(c.env, c.req.param("id"));
  if (!a || a.status === "onboarding") return c.json({ error: "not_billable", reason: "The brand isn't live yet: approve a product first." }, 400);
  if (a.status === "pilot" && !a.paid_through && !d.start) return c.json({ error: "choose_start", reason: "Choose when the paid months start: now, or after the pilot." }, 400);
  const startNow = d.start !== "after_pilot";
  const total = Math.round(d.amountEgp * 100);
  const setup = d.setupFee ? Math.min(SETUP_FEE, total) : 0;
  const today = cairoDay();
  const lines = [
    { label: `${PLANS[d.plan].name} plan, ${d.months === 1 ? "one month" : `${d.months} months`}`, amount: total - setup },
    ...(setup ? [{ label: "One-off setup", amount: setup }] : []),
  ];
  if (d.keepPrice) {
    const perMonth = Math.round((total - setup) / d.months);
    await c.env.DB.prepare("UPDATE accounts SET monthly_price = ? WHERE id = ?").bind(perMonth === PLANS[d.plan].monthlyPrice ? null : perMonth, a.id).run();
    await audit(c.env, a.id, c.get("admin"), "price", `${perMonth / 100} EGP a month`);
  }
  // Only one plan invoice is open at a time: the new one replaces any other.
  await c.env.DB.prepare("UPDATE invoices SET status = 'void' WHERE account_id = ? AND kind = 'plan' AND status = 'open'").bind(a.id).run();
  const due = a.status === "pilot" && a.pilot_ends_at && !d.paid ? cairoDay(new Date(a.pilot_ends_at)) : today;
  const inv = await createInvoice(c.env, a, { kind: "plan", periodStart: null, dueDate: due < today ? today : due, plan: d.plan, months: d.months, lines, startNow });
  await audit(c.env, a.id, c.get("admin"), d.paid ? "record_payment" : "invoice", inv.number, { total, months: d.months, plan: d.plan });
  if (d.paid) {
    const r = await applyPayment(c.env, {
      invoiceId: inv.id,
      provider: "manual",
      txnId: `manual:${d.key}`,
      amount: inv.total,
      method: d.method,
      reference: d.reference ?? null,
      note: d.note ?? null,
      actor: `admin:${c.get("admin")}`,
      startToday: startNow,
    });
    if (!r.applied && r.reason !== "duplicate") return c.json({ error: r.reason }, 409);
  }
  const fresh = (await c.env.DB.prepare("SELECT number, status, period_start, period_end, pay_token FROM invoices WHERE id = ?").bind(inv.id).first<{ number: string; status: string; period_start: string | null; period_end: string | null; pay_token: string }>())!;
  return c.json({ ok: true, number: fresh.number, status: fresh.status, periodStart: fresh.period_start, periodEnd: fresh.period_end, payUrl: payUrl(c.env, fresh.pay_token) });
});

/** The brand's own monthly price (EGP), e.g. early bird; null = back to the list price. Renewals and MRR use it. */
admin.post("/accounts/:id/price", async (c) => {
  const body = z.object({ priceEgp: z.number().min(0).max(1_000_000).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const v = body.data.priceEgp === null ? null : Math.round(body.data.priceEgp * 100);
  const r = await c.env.DB.prepare("UPDATE accounts SET monthly_price = ? WHERE id = ?").bind(v, c.req.param("id")).run();
  if (r.meta.changes !== 1) return c.json({ error: "not_found" }, 404);
  await audit(c.env, c.req.param("id"), c.get("admin"), "price", v === null ? "list price" : `${v / 100} EGP a month`);
  return c.json({ ok: true });
});

/**
 * Outreach preview: one try-on (or room preview) of a prospect's product, to send them before they sign up.
 * multipart: photo (file) or link (image, product page or post), title, mode (person|room), fixture (0|1).
 */
admin.post("/outreach/preview", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "invalid" }, 400);
  const mode = form.get("mode") === "room" ? "room" : "person";
  const title = String(form.get("title") ?? "").trim().slice(0, 120) || (mode === "room" ? "Home décor piece" : "Outfit");
  const fixture = Number(form.get("fixture") ?? 0) === 1 ? 1 : 0;
  const file = form.get("photo");
  const link = String(form.get("link") ?? "").trim();
  let product;
  if (file instanceof File && file.size > 0) {
    if (file.size > 10 * 1024 * 1024) return c.json({ error: "too_large", reason: "Photo too big (max 10 MB)." }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type || type === "image/heic") return c.json({ error: "not_an_image", reason: "Use a JPG, PNG or WEBP photo." }, 415);
    product = { bytes, type };
  } else if (link) {
    if (!httpUrl(1000).safeParse(link).success) return c.json({ error: "invalid", reason: "That link doesn't look right." }, 400);
    const got = await imageFromLink(link);
    if ("error" in got) return c.json({ error: "no_image", reason: got.error }, 422);
    product = got;
  } else return c.json({ error: "invalid", reason: "Add a photo or a link." }, 400);
  const r = await outreachPreview(c.env, { product, title, mode, fixture });
  await audit(c.env, null, c.get("admin"), "outreach_preview", r.ok ? "made" : r.error, { title, mode });
  return r.ok ? c.json(r) : c.json({ error: "failed", reason: r.error }, 502);
});

/** The stock models / rooms to choose from (small previews for the admin). */
admin.get("/outreach/fixtures", async (c) => {
  const out: Record<string, string[]> = {};
  for (const mode of ["person", "room"] as const) {
    out[mode] = [];
    for (const key of await listFixtures(c.env, mode)) {
      const o = await c.env.FILES.get(key);
      if (!o) continue;
      const b = new Uint8Array(await o.arrayBuffer());
      out[mode].push(`data:${sniffImage(b) ?? "image/jpeg"};base64,${toBase64(b)}`);
    }
  }
  return c.json(out);
});

admin.post("/accounts/:id/notes", async (c) => {
  const body = z.object({ notes: z.string().max(NOTES_MAX_CHARS) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare("UPDATE accounts SET notes = ? WHERE id = ?").bind(body.data.notes, c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Resend an email: a fresh sign-in link, or the open invoice. */
/**
 * Delete an invitation (typo, test brand, wrong email). Only before any money exists: a brand
 * that has an invoice, payment or payment claim is never deleted (use Kill or Pause instead).
 * The brand's name must be typed to confirm. AI usage rows are kept for cost totals; the
 * audit log keeps a record of the deletion.
 */
/**
 * Delete a brand (any status). Type the brand name to confirm.
 * - Never paid → removed completely (account, logins, products, photos, tests, usage, unpaid invoices).
 * - Has payments → the invoices and payments stay (your accounting record); everything else is removed,
 *   open invoices are voided, and the account is archived: switched off for good, nobody can sign in.
 * The history (audit log) keeps a line saying who deleted it and why.
 */
admin.post("/accounts/:id/delete", async (c) => {
  const body = z.object({ confirmName: z.string(), reason: z.string().trim().min(3).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid", reason: "Type the brand name and a reason." }, 400);
  const id = c.req.param("id");
  const acc = await c.env.DB.prepare("SELECT id, name, status FROM accounts WHERE id = ?").bind(id).first<{ id: string; name: string; status: string }>();
  if (!acc) return c.json({ error: "not_found" }, 404);
  if (body.data.confirmName.trim().toLowerCase() !== acc.name.trim().toLowerCase()) return c.json({ error: "name_mismatch", reason: "The name you typed doesn't match." }, 400);
  const paid = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE account_id = ?").bind(id).first<{ n: number }>();
  const keepMoney = (paid?.n ?? 0) > 0;

  const users = "(SELECT id FROM users WHERE account_id = ?1)";
  const common = [
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id IN ${users}`).bind(id),
    c.env.DB.prepare(`DELETE FROM magic_links WHERE user_id IN ${users}`).bind(id),
    c.env.DB.prepare("DELETE FROM product_tests WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM products WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM onboarding_steps WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM domains WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM notifications WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM daily_counters WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM cycle_usage WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM support_messages WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM support_seen WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("UPDATE leads SET account_id = NULL WHERE account_id = ?1").bind(id),
    c.env.DB.prepare("UPDATE alerts SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id = ?1 AND resolved_at IS NULL").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE account_id = ?1").bind(id),
  ];
  if (keepMoney) {
    await c.env.DB.batch([
      ...common,
      c.env.DB.prepare("UPDATE invoices SET status = 'void' WHERE account_id = ?1 AND status = 'open'").bind(id),
      c.env.DB.prepare("UPDATE payment_claims SET status = 'rejected' WHERE account_id = ?1 AND status = 'pending'").bind(id),
      c.env.DB.prepare(
        "UPDATE accounts SET status = 'archived', status_version = status_version + 1, manual_hold = 0, buy_url = NULL, button_selector = NULL WHERE id = ?1",
      ).bind(id),
    ]);
  } else {
    await c.env.DB.batch([
      ...common,
      c.env.DB.prepare("DELETE FROM payment_claims WHERE account_id = ?1").bind(id),
      c.env.DB.prepare("DELETE FROM invoices WHERE account_id = ?1").bind(id),
      c.env.DB.prepare("DELETE FROM usage_events WHERE account_id = ?1").bind(id),
      c.env.DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(id),
    ]);
  }
  // Test result images and uploaded product photos in R2.
  for (const prefix of [`tests/${id}/`, `products/${id}/`]) await deletePrefix(c.env, prefix);
  invalidateStatus(id);
  await audit(c.env, id, c.get("admin"), keepMoney ? "delete_brand_keep_invoices" : "delete_brand", `${acc.name} (was ${acc.status}): ${body.data.reason}`);
  return c.json({
    ok: true,
    kept: keepMoney ? "invoices" : null,
    message: keepMoney
      ? `${acc.name} was deleted. Its invoices and payments are kept for your records; try-on is off for good and nobody can sign in.`
      : `${acc.name} was deleted completely.`,
  });
});

admin.post("/accounts/:id/resend", async (c) => {
  const body = z.object({ template: z.enum(["login", "invoice"]) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const id = c.req.param("id");
  const u = await c.env.DB.prepare("SELECT id, email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(id).first<{ id: string; email: string }>();
  if (!u) return c.json({ error: "no_user" }, 404);
  let sent = false;
  if (body.data.template === "login") {
    const { link, code } = await createSignIn(c.env, u.id, u.email);
    sent = await sendOnce(c.env, { accountId: id, template: "login", dedupeKey: `login:${ulid()}`, msg: emails.login(u.email, link, code) });
  } else {
    const inv = await openPlanInvoice(c.env, id);
    if (!inv) return c.json({ error: "no_open_invoice" }, 404);
    const label = (JSON.parse(inv.lines_json) as { label: string }[])[0]!.label;
    sent = await sendOnce(c.env, { accountId: id, template: "invoice", dedupeKey: `invoice-resend:${ulid()}`, msg: emails.invoice(u.email, { ...inv, due: inv.due_date, label }, payUrl(c.env, inv.pay_token)) });
  }
  await audit(c.env, id, c.get("admin"), "resend", body.data.template);
  if (!sent) {
    const last = await c.env.DB.prepare("SELECT error FROM notifications WHERE account_id = ? AND template = ? ORDER BY created_at DESC LIMIT 1")
      .bind(id, body.data.template)
      .first<{ error: string | null }>();
    return c.json({ error: "email_not_sent", reason: last?.error ?? "unknown" }, 502);
  }
  return c.json({ ok: true, sent });
});

admin.post("/alerts/:id/resolve", async (c) => {
  await c.env.DB.prepare("UPDATE alerts SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

admin.post("/settings", async (c) => {
  const body = z
    .object({ egpPerUsd: z.number().positive().max(1000).nullable().optional(), globalDailyCapUsd: z.number().positive().max(10_000).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  if (body.data.egpPerUsd !== undefined) await setSetting(c.env, "egp_per_usd", body.data.egpPerUsd);
  if (body.data.globalDailyCapUsd !== undefined) await setSetting(c.env, "global_daily_cap_usd", body.data.globalDailyCapUsd);
  await audit(c.env, null, c.get("admin"), "settings", JSON.stringify(body.data));
  return c.json({ ok: true });
});

admin.post("/jobs/:name/run", async (c) => {
  const ok = await runJobNow(c.env, c.req.param("name"));
  await audit(c.env, null, c.get("admin"), "run_job", c.req.param("name"));
  return ok ? c.json({ ok: true }) : c.json({ error: "unknown_job" }, 404);
});

admin.get("/digest/preview", async (c) => {
  const d = await buildDigest(c.env, new Date());
  return c.json(d);
});

// ---------------------------------------------------------------- gaps closed before Phase 4

/** "Open the brand portal read-only" (brief §8): a one-time link to a 1-hour, read-only session. */
admin.post("/accounts/:id/view-portal", async (c) => {
  const u = await c.env.DB.prepare("SELECT id, email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(c.req.param("id")).first<{ id: string; email: string }>();
  if (!u) return c.json({ error: "no_user" }, 404);
  const link = await createMagicLink(c.env, u.id, u.email, true);
  await audit(c.env, c.req.param("id"), c.get("admin"), "view_portal", "read-only");
  return c.json({ ok: true, link });
});

/** Rotate the widget key (brief §7.6). The old key stops at once; the brand gets the new line. */
admin.post("/accounts/:id/rotate-key", async (c) => {
  const body = z.object({ reason: Reason }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "reason_required" }, 400);
  const id = c.req.param("id");
  const key = newWidgetKey(c.env);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id = ? AND revoked_at IS NULL").bind(id),
    c.env.DB.prepare("INSERT INTO api_keys (id, account_id, prefix, key_hash, key_public) VALUES (?, ?, ?, ?, ?)").bind(ulid(), id, key.slice(0, 12), await sha256Hex(key), key),
  ]);
  await audit(c.env, id, c.get("admin"), "rotate_key", body.data.reason);
  return c.json({ ok: true, snippet: `<script src="${cdnOrigin(c.env)}/w.js" data-key="${key}" async></script>` });
});

/** A brand's domains (the widget only works from these). */
admin.get("/accounts/:id/domains", async (c) => {
  const r = await c.env.DB.prepare("SELECT id, host, install_status, last_checked_at FROM domains WHERE account_id = ? ORDER BY host").bind(c.req.param("id")).all();
  const key = await c.env.DB.prepare("SELECT key_public FROM api_keys WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(c.req.param("id"))
    .first<{ key_public: string | null }>();
  // The brand's install line, to paste on their website (the same line their portal shows).
  const snippet = key?.key_public ? `<script src="${cdnOrigin(c.env)}/w.js" data-key="${key.key_public}" async></script>` : null;
  return c.json({ domains: r.results, snippet });
});

admin.post("/accounts/:id/domains", async (c) => {
  const body = z.object({ host: z.string().trim().min(3).max(253) }).safeParse(await c.req.json().catch(() => null));
  const host = body.success ? originHost(body.data.host.includes("://") ? body.data.host : `https://${body.data.host}`) : null;
  if (!host) return c.json({ error: "invalid_host" }, 400);
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO domains (id, account_id, host) VALUES (?, ?, ?)").bind(ulid(), c.req.param("id"), host).run();
  if (r.meta.changes !== 1) return c.json({ error: "domain_taken" }, 409);
  await audit(c.env, c.req.param("id"), c.get("admin"), "domain_add", host);
  return c.json({ ok: true, host });
});

admin.post("/accounts/:id/domains/:domainId/remove", async (c) => {
  const d = await c.env.DB.prepare("SELECT host FROM domains WHERE id = ? AND account_id = ?").bind(c.req.param("domainId"), c.req.param("id")).first<{ host: string }>();
  if (!d) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(c.req.param("domainId")).run();
  await audit(c.env, c.req.param("id"), c.get("admin"), "domain_remove", d.host);
  return c.json({ ok: true });
});

/** Cost view (brief §12): AI spend per Cairo day for one brand, in USD and EGP, last 30 days. */
admin.get("/accounts/:id/costs", async (c) => {
  const fx = await getSetting<number | null>(c.env, "egp_per_usd", null);
  const from = addDays(cairoDay(), -29);
  const r = await c.env.DB.prepare(
    "SELECT day, metric, count FROM daily_counters WHERE account_id = ? AND day >= ? AND metric IN ('spend_micro_usd','ai_calls') ORDER BY day DESC",
  )
    .bind(c.req.param("id"), from)
    .all<{ day: string; metric: string; count: number }>();
  const byDay = new Map<string, { day: string; calls: number; usd: number; egp: number | null }>();
  for (const row of r.results) {
    const d = byDay.get(row.day) ?? { day: row.day, calls: 0, usd: 0, egp: null };
    if (row.metric === "ai_calls") d.calls = row.count;
    else {
      d.usd = Math.round(row.count / 10_000) / 100;
      d.egp = fx ? Math.round((row.count / 1e6) * fx * 100) / 100 : null;
    }
    byDay.set(row.day, d);
  }
  return c.json({ egpPerUsd: fx, days: [...byDay.values()] });
});

/** The setup-fee offer as the invite form shows it. */
admin.get("/offer", async (c) => {
  const open = await getSetting<boolean>(c.env, "founding_pilots_open", true);
  return c.json({ foundingOfferOn: open, setupFee: SETUP_FEE });
});

admin.post("/founding-pilots", async (c) => {
  const body = z.object({ open: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  await setSetting(c.env, "founding_pilots_open", body.data.open);
  await audit(c.env, null, c.get("admin"), "founding_pilots", body.data.open ? "open (no setup fee)" : "closed (setup fee charged)");
  return c.json({ ok: true, open: body.data.open });
});

/** Per-brand product limit (Asser, 14 Nov: no plan-wide limit; set one per brand if needed). null = plan default. */
admin.post("/accounts/:id/product-limit", async (c) => {
  const body = z.object({ limit: z.number().int().min(1).max(10_000).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare("UPDATE accounts SET max_products = ? WHERE id = ?").bind(body.data.limit, c.req.param("id")).run();
  await audit(c.env, c.req.param("id"), c.get("admin"), "product_limit", body.data.limit === null ? "plan default" : String(body.data.limit));
  return c.json({ ok: true, limit: body.data.limit });
});

// ---------------------------------------------------------------- support chat

/** All conversations, newest first; `waiting` = the brand wrote after Garrab support last replied. */
admin.get("/support", async (c) => {
  const list = await supportThreads(c.env);
  return c.json({ threads: list, waiting: list.filter((t) => t.waiting).length });
});

admin.get("/support/:accountId", async (c) => {
  const id = c.req.param("accountId");
  const a = await c.env.DB.prepare("SELECT id, name, status, onboarding_step, plan_id FROM accounts WHERE id = ?").bind(id).first();
  if (!a) return c.json({ error: "not_found" }, 404);
  return c.json({ account: a, messages: await supportMessages(c.env, id) });
});

/** Reply as Garrab support. The bot stops answering this brand for a while; the brand gets an email (at most one per half hour). */
admin.post("/support/:accountId", async (c) => {
  const body = z.object({ body: z.string().trim().min(1).max(SUPPORT.maxMessageChars) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const id = c.req.param("accountId");
  const a = await c.env.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(id).first();
  if (!a) return c.json({ error: "not_found" }, 404);
  const m = await adminWrites(c.env, id, body.data.body);
  const to = (await c.env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(id).first<{ email: string }>())?.email;
  if (to) {
    const bucket = Math.floor(Date.now() / (SUPPORT.replyEmailEveryMinutes * 60_000));
    await sendOnce(c.env, { accountId: id, template: "support_reply", dedupeKey: `support_reply:${id}:${bucket}`, msg: emails.supportReply(to, body.data.body, portalUrl(c.env, "?chat=1")) });
  }
  await audit(c.env, id, c.get("admin"), "support_reply", null);
  return c.json({ message: m });
});

/** Garrab support adds a product photo for a brand (e.g. photos the brand sent on WhatsApp). */
admin.post("/accounts/:id/products/upload", async (c) => {
  const id = c.req.param("id");
  const a = await c.env.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(id).first();
  if (!a) return c.json({ error: "not_found" }, 404);
  const r = await uploadProduct(c.env, id, await c.req.formData().catch(() => null));
  if (r.status === 200) await audit(c.env, id, c.get("admin"), "add_product_photo", null);
  return c.json(r.body, r.status);
});

/**
 * Usage per brand for a period (?from=&to=, Cairo days; default the last 30 days): shoppers, views,
 * try-ons started, previews, Buy taps; approval previews (Garrab's product tests); AI cost split between
 * shoppers and Garrab's own tests. Status and name filters are applied in the admin.
 */
admin.get("/usage", async (c) => {
  const today = cairoDay();
  const p = readPeriod(c.req.query("from"), c.req.query("to")) ?? {
    from: new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10),
    to: today,
  };
  const accounts = await c.env.DB.prepare(
    "SELECT id, name, status, plan_id, target_plan_id, category FROM accounts WHERE status != 'archived' ORDER BY name",
  ).all<{ id: string; name: string; status: string; plan_id: string; target_plan_id: string | null; category: string }>();
  const counts = await c.env.DB.prepare(
    `SELECT account_id, metric, SUM(count) AS n FROM daily_counters
      WHERE day >= ? AND day <= ? AND account_id != '*'
        AND metric IN ('shopper','button_view','link_view','try_on_started','preview','buy_click')
      GROUP BY account_id, metric`,
  )
    .bind(p.from, p.to)
    .all<{ account_id: string; metric: string; n: number }>();
  // AI cost by Cairo day (usage_events are stamped in UTC; Cairo is UTC+2).
  // Split: shopper previews (try-on, room, size finder) vs Garrab's own work for the brand (product tests
  // for approval, their quality scores, support chat replies).
  const cost = await c.env.DB.prepare(
    `SELECT account_id,
            SUM(CASE WHEN kind IN ('tryon','room','size','fit_read') THEN cost_micro_usd ELSE 0 END) AS shopper_micro,
            SUM(CASE WHEN kind IN ('tryon','room','size','fit_read') THEN 0 ELSE cost_micro_usd END) AS test_micro,
            SUM(CASE WHEN kind = 'test' AND ok = 1 THEN 1 ELSE 0 END) AS test_previews
       FROM usage_events
      WHERE substr(datetime(created_at, '+2 hours'), 1, 10) BETWEEN ? AND ? GROUP BY account_id`,
  )
    .bind(p.from, p.to)
    .all<{ account_id: string; shopper_micro: number; test_micro: number; test_previews: number }>();
  const m = new Map<string, Record<string, number>>();
  for (const r of counts.results) {
    const x = m.get(r.account_id) ?? {};
    x[r.metric] = r.n;
    m.set(r.account_id, x);
  }
  const ai = new Map(cost.results.map((r) => [r.account_id, r]));
  const usd = (micro: number | undefined): number => Math.round((micro ?? 0) / 10_000) / 100;
  const rows = accounts.results.map((a) => {
    const x = m.get(a.id) ?? {};
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      plan: PLANS[(a.plan_id === "pilot" ? (a.target_plan_id ?? "starter") : a.plan_id) as PlanId].name,
      category: a.category,
      shoppers: x.shopper ?? 0,
      views: (x.button_view ?? 0) + (x.link_view ?? 0),
      started: x.try_on_started ?? 0,
      previews: x.preview ?? 0,
      buys: x.buy_click ?? 0,
      testPreviews: ai.get(a.id)?.test_previews ?? 0,
      shopperUsd: usd(ai.get(a.id)?.shopper_micro),
      testUsd: usd(ai.get(a.id)?.test_micro),
    };
  });
  return c.json({ from: p.from, to: p.to, rows });
});
