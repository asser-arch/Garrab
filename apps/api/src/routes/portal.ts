/**
 * Brand portal API (served same-origin under app.<domain>/portal-api via the site Worker).
 * Every query is scoped to the session's account: a brand only ever sees its own data.
 */
import { EXTRA_PACK, PLANS, productLimit, type PlanId } from "@garrab/shared/plans";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { emails } from "../emails.js";
import { cdnOrigin, type Env } from "../env.js";
import { widgetKey } from "../lib/accounts.js";
import {
  SESSION_COOKIE,
  consumeMagicLink,
  consumeSignInCode,
  createSession,
  createSignIn,
  renewSession,
  sameOriginWrite,
  sessionCookie,
  sessionUser,
  type SessionUser,
} from "../lib/auth.js";
import { ulid } from "../lib/crypto.js";
import { sniffImage, stripJpegMetadata } from "../lib/photo.js";
import { productPhotoUrl } from "../lib/products.js";
import { sendOnce } from "../lib/email.js";
import { saveProducts, guessKind } from "../onboarding/import.js";
import { accountFacts, billingPlan, createInvoice, ensurePlanInvoice, payUrl, pdfUrl } from "../billing/ledger.js";
import { cycleStartOf } from "../lib/metering.js";
import { cairoDay } from "../lib/time.js";
import { STEPS, STEP_LABEL, advance, checkInstall, confirmApproval, decideProduct, type Step } from "../onboarding/machine.js";

type Vars = { user: SessionUser };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const portal = new Hono<{ Bindings: Env; Variables: Vars }>();

portal.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!sameOriginWrite(c)) return c.json({ error: "forbidden_origin" }, 403);
  await next();
});

// ---------------------------------------------------------------- auth (no session needed)

portal.post("/auth/request", async (c) => {
  const body = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.RL_CONFIG_IP && !(await c.env.RL_CONFIG_IP.limit({ key: `login:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);
  const u = await c.env.DB.prepare("SELECT id, account_id FROM users WHERE email = ?").bind(body.data.email).first<{ id: string; account_id: string }>();
  if (u) {
    const { link, code } = await createSignIn(c.env, u.id, body.data.email);
    await sendOnce(c.env, { accountId: u.account_id, template: "login", dedupeKey: `login:${ulid()}`, msg: emails.login(body.data.email, link, code) });
  }
  return c.json({ ok: true }); // same answer either way: no account probing
});

portal.post("/auth/verify", async (c) => {
  const body = z.object({ token: z.string().max(100) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const link = await consumeMagicLink(c.env, body.data.token);
  if (!link) return c.json({ error: "link_invalid" }, 401);
  const token = await createSession(c.env, link.userId, link.readonly);
  c.header("Set-Cookie", sessionCookie(token, link.readonly ? 3600 : undefined));
  return c.json({ ok: true });
});

/** Sign in with the 6-digit code from the email (works on any device; scanners can't use it up). */
portal.post("/auth/code", async (c) => {
  const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), code: z.string().trim().max(12) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.RL_CONFIG_IP && !(await c.env.RL_CONFIG_IP.limit({ key: `code:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);
  const r = await consumeSignInCode(c.env, body.data.email, body.data.code.replace(/\s/g, ""));
  if (!r) return c.json({ error: "code_invalid" }, 401);
  const token = await createSession(c.env, r.userId);
  c.header("Set-Cookie", sessionCookie(token));
  return c.json({ ok: true });
});

portal.post("/auth/logout", async (c) => {
  const u = await sessionUser(c.env, c.req.header("cookie"));
  if (u) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(u.sessionHash).run();
  c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- everything below needs a session

portal.use("*", async (c, next) => {
  const u = await sessionUser(c.env, c.req.header("cookie"));
  if (!u) return c.json({ error: "signed_out" }, 401);
  // Admin read-only view: reads only.
  if (u.readonly && c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "read_only" }, 403);
  c.set("user", u);
  // Active brands stay signed in: the 60-day session restarts (at most once a day).
  const renewed = await renewSession(c.env, u, c.req.header("cookie"));
  await next();
  if (renewed) c.header("Set-Cookie", sessionCookie(renewed));
});

const acct = (c: C): string => c.get("user").accountId;

portal.get("/me", async (c) => {
  const id = acct(c);
  // Brands approved before links went live on approval were left waiting for the website script.
  if (!c.get("user").readonly) {
    const step = await c.env.DB.prepare("SELECT onboarding_step FROM accounts WHERE id = ?").bind(id).first<{ onboarding_step: string }>();
    if (step?.onboarding_step === "products_approved") await advance(c.env, id);
  }
  const a = await c.env.DB.prepare(
    `SELECT name, slug, status, platform, website, target_plan_id, plan_id, onboarding_step, pilot_started_at, pilot_ends_at, cycle_start
       FROM accounts WHERE id = ?`,
  )
    .bind(id)
    .first<{
      name: string;
      slug: string;
      status: string;
      platform: string | null;
      website: string | null;
      target_plan_id: PlanId | null;
      plan_id: PlanId;
      onboarding_step: Step;
      pilot_started_at: string | null;
      pilot_ends_at: string | null;
      cycle_start: string | null;
    }>();
  if (!a) return c.json({ error: "not_found" }, 404);
  const steps = await c.env.DB.prepare("SELECT step, state FROM onboarding_steps WHERE account_id = ?").bind(id).all<{ step: Step; state: string }>();
  const key = await widgetKey(c.env, id);
  const live = await c.env.DB.prepare("SELECT id, title, images_json FROM products WHERE account_id = ? AND enabled = 1 AND approved = 1 ORDER BY title")
    .bind(id)
    .all<{ id: string; title: string; images_json: string }>();
  // The meter row appears with the first preview; until then show 0 of the plan's allowance.
  const usage = a.cycle_start
    ? ((await c.env.DB.prepare("SELECT used, included, extra FROM cycle_usage WHERE account_id = ? AND cycle_start = ?").bind(id, a.cycle_start).first()) ?? {
        used: 0,
        included: PLANS[a.plan_id].includedPreviews,
        extra: 0,
      })
    : null;
  const install = await c.env.DB.prepare("SELECT install_status, last_checked_at FROM domains WHERE account_id = ? LIMIT 1").bind(id).first();
  return c.json({
    readonly: c.get("user").readonly,
    account: {
      name: a.name,
      status: a.status,
      platform: a.platform,
      website: a.website,
      plan: PLANS[a.target_plan_id ?? a.plan_id].name,
      pilotStartedAt: a.pilot_started_at,
      pilotEndsAt: a.pilot_ends_at,
    },
    step: a.onboarding_step,
    steps: STEPS.filter((s) => s !== "expired" && s !== "converted").map((s) => ({
      step: s,
      label: STEP_LABEL[s],
      state: steps.results.find((r) => r.step === s)?.state ?? "pending",
    })),
    snippet: key ? `<script src="${cdnOrigin(c.env)}/w.js" data-key="${key}" async></script>` : null,
    install,
    usage,
    brandLink: live.results.length > 0 ? { url: `${c.env.APP_ORIGIN}/t/${a.slug}`, urlAr: `${c.env.APP_ORIGIN}/t/${a.slug}?lang=ar` } : null,
    hostedLinks: live.results.map((p) => ({
      productId: p.id,
      title: p.title,
      image: (JSON.parse(p.images_json) as string[])[0] ?? null,
      url: `${c.env.APP_ORIGIN}/t/${a.slug}/${p.id}`,
      urlAr: `${c.env.APP_ORIGIN}/t/${a.slug}/${p.id}?lang=ar`,
    })),
  });
});

portal.get("/products", async (c) => {
  const id = acct(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, title, images_json, kind, selected, test_score, enabled, needs_review, disabled_reason, brand_decision, product_url
       FROM products WHERE account_id = ? ORDER BY selected DESC, title LIMIT 500`,
  )
    .bind(id)
    .all<{
      id: string;
      title: string;
      images_json: string;
      kind: string;
      selected: number;
      test_score: number | null;
      enabled: number;
      needs_review: number;
      disabled_reason: string | null;
      brand_decision: string | null;
      product_url: string | null;
    }>();
  const tests = await c.env.DB.prepare("SELECT id, product_id FROM product_tests WHERE account_id = ? AND r2_key IS NOT NULL ORDER BY created_at")
    .bind(id)
    .all<{ id: string; product_id: string }>();
  const a = await c.env.DB.prepare("SELECT plan_id, max_products FROM accounts WHERE id = ?").bind(id).first<{ plan_id: PlanId; max_products: number | null }>();
  return c.json({
    maxProducts: productLimit(a?.plan_id ?? "pilot", a?.max_products),
    products: rows.results.map((p) => ({
      id: p.id,
      title: p.title,
      image: (JSON.parse(p.images_json) as string[])[0] ?? null,
      kind: p.kind,
      url: p.product_url,
      selected: p.selected === 1,
      tested: p.test_score !== null,
      result: p.test_score === null ? "pending" : p.enabled ? "passed" : p.needs_review ? "review" : "failed",
      reason: p.disabled_reason,
      decision: p.brand_decision,
      tests: tests.results.filter((t) => t.product_id === p.id).map((t) => `/portal-api/test-image/${t.id}`),
    })),
  });
});

portal.get("/test-image/:id", async (c) => {
  const t = await c.env.DB.prepare("SELECT r2_key FROM product_tests WHERE id = ? AND account_id = ?").bind(c.req.param("id"), acct(c)).first<{ r2_key: string | null }>();
  if (!t?.r2_key) return c.json({ error: "not_found" }, 404);
  const obj = await c.env.FILES.get(t.r2_key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/jpeg", "cache-control": "private, max-age=3600" } });
});

portal.post("/products/select", async (c) => {
  const id = acct(c);
  const body = z.object({ ids: z.array(z.string().max(40)).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const a = await c.env.DB.prepare("SELECT plan_id, max_products FROM accounts WHERE id = ?").bind(id).first<{ plan_id: PlanId; max_products: number | null }>();
  const max = productLimit(a?.plan_id ?? "pilot", a?.max_products);
  const ids = [...new Set(body.data.ids)].slice(0, max ?? undefined);
  // Tested products keep their place; untested ones not chosen are unselected.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE products SET selected = 0 WHERE account_id = ? AND test_score IS NULL").bind(id),
    ...ids.map((pid) => c.env.DB.prepare("UPDATE products SET selected = 1 WHERE account_id = ? AND id = ?").bind(id, pid)),
  ]);
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(id).first<{ c: number }>();
  if (max !== null && (total?.c ?? 0) > max) return c.json({ error: "too_many", max }, 400);
  await c.env.JOBS.send({ t: "advance", a: id });
  return c.json({ ok: true, selected: total?.c ?? 0 });
});

const ManualProduct = z.object({
  title: z.string().trim().min(2).max(200),
  imageUrl: z.string().trim().url().startsWith("https://").max(1000),
  productUrl: z.string().trim().url().max(1000).optional(),
  description: z.string().trim().max(2000).optional(),
});

async function addManual(env: Env, accountId: string, items: z.infer<typeof ManualProduct>[]): Promise<number> {
  const a = await env.DB.prepare("SELECT plan_id, max_products FROM accounts WHERE id = ?").bind(accountId).first<{ plan_id: PlanId; max_products: number | null }>();
  const max = productLimit(a?.plan_id ?? "pilot", a?.max_products);
  const have = (await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(accountId).first<{ c: number }>())?.c ?? 0;
  const room = max === null ? items.length : Math.max(0, max - have);
  const take = items.slice(0, room);
  const refs = take.map(() => `manual:${ulid()}`);
  await saveProducts(
    env,
    accountId,
    take.map((p, i) => ({
      externalRef: refs[i]!,
      title: p.title,
      description: p.description ?? "",
      images: [p.imageUrl],
      sizes: [],
      kind: guessKind(p.title),
      productUrl: p.productUrl ?? null,
      urlPath: p.productUrl ? new URL(p.productUrl).pathname : null,
      pricePiastres: null,
      source: "manual",
    })),
  );
  if (refs.length) {
    await env.DB.batch(refs.map((r) => env.DB.prepare("UPDATE products SET selected = 1 WHERE account_id = ? AND external_ref = ?").bind(accountId, r)));
  }
  return take.length;
}

portal.post("/products", async (c) => {
  const body = ManualProduct.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid", fields: body.error.issues.map((i) => i.path.join(".")) }, 400);
  const added = await addManual(c.env, acct(c), [body.data]);
  if (!added) return c.json({ error: "limit_reached" }, 400);
  await c.env.JOBS.send({ t: "advance", a: acct(c) });
  return c.json({ ok: true });
});

/** Brands upload product photos as files (JPG, PNG or WEBP). Product photos, never shopper photos. */
export const PRODUCT_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Add a product with an uploaded photo. The photo is stored in R2 under products/<account>/ and
 * served from a public, unguessable address on our own site (the AI providers fetch it by URL).
 * JPEG metadata (camera, GPS) is removed first.
 */
portal.post("/products/upload", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("photo");
  const title = String(form?.get("title") ?? "").trim();
  const productUrl = String(form?.get("productUrl") ?? "").trim() || undefined;
  if (!form || !(file instanceof File) || title.length < 2 || title.length > 200) return c.json({ error: "invalid" }, 400);
  if (file.size > PRODUCT_PHOTO_MAX_BYTES) return c.json({ error: "too_large" }, 413);
  if (productUrl && !z.string().url().max(1000).safeParse(productUrl).success) return c.json({ error: "invalid", fields: ["productUrl"] }, 400);
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return c.json({ error: "not_an_image" }, 415);
  if (type === "image/jpeg") bytes = stripJpegMetadata(bytes);
  const id = acct(c);
  const name = `${ulid().toLowerCase()}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`;
  await c.env.FILES.put(`products/${id}/${name}`, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  const imageUrl = productPhotoUrl(c.env, id, name);
  const added = await addManual(c.env, id, [{ title, imageUrl, productUrl }]);
  if (!added) {
    await c.env.FILES.delete(`products/${id}/${name}`);
    return c.json({ error: "limit_reached" }, 400);
  }
  await c.env.JOBS.send({ t: "advance", a: id });
  return c.json({ ok: true, imageUrl });
});

/** CSV: name,image_url,product_url,description (header row optional). */
portal.post("/products/csv", async (c) => {
  const text = (await c.req.text()).slice(0, 100_000);
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.split(",").map((x) => x.trim().replace(/^"|"$/g, "")))
    .filter((r) => r.length >= 2 && r[0] && !/^name$/i.test(r[0]));
  const items = rows
    .map((r) => ManualProduct.safeParse({ title: r[0], imageUrl: r[1], productUrl: r[2] || undefined, description: r.slice(3).join(", ") || undefined }))
    .filter((r) => r.success)
    .map((r) => r.data);
  const added = await addManual(c.env, acct(c), items);
  await c.env.JOBS.send({ t: "advance", a: acct(c) });
  return c.json({ ok: true, added, skipped: rows.length - added });
});

portal.post("/products/:id/decision", async (c) => {
  const body = z.object({ decision: z.enum(["approved", "hidden"]) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const ok = await decideProduct(c.env, acct(c), c.req.param("id"), body.data.decision);
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

portal.post("/approve/confirm", async (c) => {
  if (!(await confirmApproval(c.env, acct(c)))) return c.json({ error: "approve_one_first" }, 400);
  const step = await advance(c.env, acct(c));
  return c.json({ ok: true, step });
});

portal.post("/install/check", async (c) => {
  const installed = await checkInstall(c.env, acct(c));
  if (installed) await c.env.DB.prepare("UPDATE accounts SET installed_at = COALESCE(installed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?").bind(acct(c)).run();
  const step = await advance(c.env, acct(c));
  return c.json({ installed, step });
});

// ---------------------------------------------------------------- billing (brief §7: the portal "Pay now" path)

async function billingFacts(env: Env, id: string) {
  const a = (await accountFacts(env, id))!;
  return a;
}

portal.get("/billing", async (c) => {
  const id = acct(c);
  const a = await billingFacts(c.env, id);
  const plan = PLANS[billingPlan(a)];
  const invoices = await c.env.DB.prepare(
    "SELECT number, kind, total, status, due_date, period_start, period_end, pay_token, created_at FROM invoices WHERE account_id = ? AND status != 'void' ORDER BY created_at DESC LIMIT 50",
  )
    .bind(id)
    .all<{ number: string; kind: string; total: number; status: string; due_date: string; period_start: string | null; period_end: string | null; pay_token: string; created_at: string }>();
  const claim = await c.env.DB.prepare("SELECT c.status, c.created_at, i.number FROM payment_claims c JOIN invoices i ON i.id = c.invoice_id WHERE c.account_id = ? AND c.status = 'pending' LIMIT 1")
    .bind(id)
    .first();
  const cycle = cycleStartOf(a);
  const usage = await c.env.DB.prepare("SELECT used, included, extra FROM cycle_usage WHERE account_id = ? AND cycle_start = ?").bind(id, cycle).first<{ used: number; included: number; extra: number }>();
  return c.json({
    status: a.status,
    plan: { name: plan.name, price: plan.monthlyPrice, previews: plan.includedPreviews },
    paidThrough: a.paid_through,
    pilotEndsAt: a.pilot_ends_at,
    cancelAtPeriodEnd: a.cancel_at_period_end === 1,
    usage: usage ?? { used: 0, included: PLANS[a.plan_id].includedPreviews, extra: 0 },
    canBuyPack: PLANS[a.plan_id].extraPacks && (a.status === "active" || a.status === "past_due"),
    pack: { previews: EXTRA_PACK.previews, price: EXTRA_PACK.price },
    pendingClaim: claim,
    invoices: invoices.results.map((i) => ({
      number: i.number,
      kind: i.kind,
      total: i.total,
      status: i.status,
      dueDate: i.due_date,
      period: i.period_start ? `${i.period_start} to ${i.period_end}` : null,
      payUrl: payUrl(c.env, i.pay_token),
      pdfUrl: pdfUrl(c.env, i.pay_token),
    })),
  });
});

/** Pay now: the open plan invoice (creating it if needed): first month, renewal, or reactivation. */
portal.post("/billing/pay-now", async (c) => {
  const a = await billingFacts(c.env, acct(c));
  if (a.status === "onboarding") return c.json({ error: "not_live_yet" }, 400);
  const inv = await ensurePlanInvoice(c.env, a, new Date());
  return c.json({ ok: true, payUrl: payUrl(c.env, inv.pay_token) });
});

/** Extra preview pack: prepaid, its own invoice; previews unlock when paid (never on credit). */
portal.post("/billing/pack", async (c) => {
  const a = await billingFacts(c.env, acct(c));
  if (!PLANS[a.plan_id].extraPacks || (a.status !== "active" && a.status !== "past_due")) return c.json({ error: "not_available" }, 400);
  const open = await c.env.DB.prepare("SELECT pay_token FROM invoices WHERE account_id = ? AND kind = 'pack' AND status = 'open' LIMIT 1").bind(a.id).first<{ pay_token: string }>();
  const token = open?.pay_token ?? (await createInvoice(c.env, a, { kind: "pack", periodStart: null, dueDate: cairoDay() })).pay_token;
  return c.json({ ok: true, payUrl: payUrl(c.env, token) });
});

/** Month to month: cancel takes effect at the end of the paid period. */
portal.post("/billing/cancel", async (c) => {
  const id = acct(c);
  const a = await billingFacts(c.env, id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE accounts SET cancel_at_period_end = 1 WHERE id = ?").bind(id),
    c.env.DB.prepare("UPDATE invoices SET status = 'void' WHERE account_id = ? AND kind = 'plan' AND status = 'open'").bind(id),
    c.env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason) VALUES (?, ?, 'brand', 'cancel', 'cancel at period end')").bind(ulid(), id),
  ]);
  await sendOnce(c.env, { accountId: id, template: "cancelled", dedupeKey: `cancel:${id}:${a.paid_through ?? "pilot"}`, msg: emails.cancelled(c.get("user").email, a.paid_through) });
  return c.json({ ok: true, until: a.paid_through ?? a.pilot_ends_at });
});

portal.post("/billing/resume", async (c) => {
  const id = acct(c);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE accounts SET cancel_at_period_end = 0 WHERE id = ?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason) VALUES (?, ?, 'brand', 'resume', 'cancellation withdrawn')").bind(ulid(), id),
  ]);
  return c.json({ ok: true });
});
