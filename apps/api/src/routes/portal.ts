/**
 * Brand portal API (served same-origin under app.<domain>/portal-api via the site Worker).
 * Every query is scoped to the session's account: a brand only ever sees its own data.
 */
import { PLANS, type PlanId } from "@garrab/shared/plans";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { emails } from "../emails.js";
import { cdnOrigin, type Env } from "../env.js";
import { widgetKey } from "../lib/accounts.js";
import {
  SESSION_COOKIE,
  consumeMagicLink,
  createMagicLink,
  createSession,
  sameOriginWrite,
  sessionCookie,
  sessionUser,
  type SessionUser,
} from "../lib/auth.js";
import { ulid } from "../lib/crypto.js";
import { sendOnce } from "../lib/email.js";
import { saveProducts, guessKind } from "../onboarding/import.js";
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
    const link = await createMagicLink(c.env, u.id, body.data.email);
    await sendOnce(c.env, { accountId: u.account_id, template: "login", dedupeKey: `login:${ulid()}`, msg: emails.login(body.data.email, link) });
  }
  return c.json({ ok: true }); // same answer either way: no account probing
});

portal.post("/auth/verify", async (c) => {
  const body = z.object({ token: z.string().max(100) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const userId = await consumeMagicLink(c.env, body.data.token);
  if (!userId) return c.json({ error: "link_invalid" }, 401);
  const token = await createSession(c.env, userId);
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
  c.set("user", u);
  await next();
});

const acct = (c: C): string => c.get("user").accountId;

portal.get("/me", async (c) => {
  const id = acct(c);
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
  const usage = a.cycle_start
    ? await c.env.DB.prepare("SELECT used, included, extra FROM cycle_usage WHERE account_id = ? AND cycle_start = ?").bind(id, a.cycle_start).first()
    : null;
  const install = await c.env.DB.prepare("SELECT install_status, last_checked_at FROM domains WHERE account_id = ? LIMIT 1").bind(id).first();
  return c.json({
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
  const a = await c.env.DB.prepare("SELECT plan_id FROM accounts WHERE id = ?").bind(id).first<{ plan_id: PlanId }>();
  return c.json({
    maxProducts: PLANS[a?.plan_id ?? "pilot"].maxProducts,
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
  const a = await c.env.DB.prepare("SELECT plan_id, onboarding_step FROM accounts WHERE id = ?").bind(id).first<{ plan_id: PlanId; onboarding_step: Step }>();
  const max = PLANS[a?.plan_id ?? "pilot"].maxProducts;
  const ids = [...new Set(body.data.ids)].slice(0, max);
  // Tested products keep their place; untested ones not chosen are unselected.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE products SET selected = 0 WHERE account_id = ? AND test_score IS NULL").bind(id),
    ...ids.map((pid) => c.env.DB.prepare("UPDATE products SET selected = 1 WHERE account_id = ? AND id = ?").bind(id, pid)),
  ]);
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(id).first<{ c: number }>();
  if ((total?.c ?? 0) > max) return c.json({ error: "too_many", max }, 400);
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
  const a = await env.DB.prepare("SELECT plan_id FROM accounts WHERE id = ?").bind(accountId).first<{ plan_id: PlanId }>();
  const max = PLANS[a?.plan_id ?? "pilot"].maxProducts;
  const have = (await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(accountId).first<{ c: number }>())?.c ?? 0;
  const room = Math.max(0, max - have);
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
