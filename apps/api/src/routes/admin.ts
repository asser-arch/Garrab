/**
 * Operator API (Asser only). Behind Cloudflare Access; every write is audit-logged.
 * Phase 2 scope: invite a brand, funnel, onboarding list and detail, step overrides,
 * one-click reminders, review "needs review" products.
 */
import { InviteBrand, OnboardingStep } from "@garrab/shared";
import { Hono } from "hono";
import { z } from "zod";
import { emails } from "../emails.js";
import type { Env } from "../env.js";
import { createAccount } from "../lib/accounts.js";
import { adminIdentity, createMagicLink } from "../lib/auth.js";
import { ulid } from "../lib/crypto.js";
import { sendOnce } from "../lib/email.js";
import { cairoDay } from "../lib/time.js";
import { STEP_LABEL, advance, overrideStep, portalUrl, type Step } from "../onboarding/machine.js";

type Vars = { admin: string };
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

admin.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const who = await adminIdentity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
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
    website: z.string().trim().url().max(300).optional(),
    whatsapp: z.string().trim().max(20).optional(),
    platform: z.enum(["shopify", "woocommerce", "other_website", "social_only"]).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid", fields: body.error.issues.map((i) => i.path.join(".")) }, 400);
  const { accountId, userId, created } = await createAccount(c.env, body.data);
  const link = await createMagicLink(c.env, userId, body.data.email);
  await audit(c.env, accountId, c.get("admin"), "invite", created ? "new account" : "existing account");
  if (created) await c.env.JOBS.send({ t: "advance", a: accountId });
  return c.json({ ok: true, accountId, created, link });
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
      "SELECT id, title, kind, selected, test_score, enabled, needs_review, disabled_reason, brand_decision, approved FROM products WHERE account_id = ? ORDER BY selected DESC, title LIMIT 300",
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
