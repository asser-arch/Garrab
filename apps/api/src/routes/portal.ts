/**
 * Brand portal API (served same-origin under app.<domain>/portal-api via the site Worker).
 * Every query is scoped to the session's account: a brand only ever sees its own data.
 */
import { accountFresh, invalidateStatus } from "../lib/db.js";
import { brandUnread, brandWrites, markBrandSeen, messages } from "../lib/support.js";
import { buildReport, defaultPeriod, readPeriod } from "../lib/report.js";
import { EXTRA_PACK, PLANS, SUPPORT, productLimit, type PlanId } from "@garrab/shared/plans";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { httpUrl } from "@garrab/shared";
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
import { clearProductTests, productPhotoUrl, removeProduct } from "../lib/products.js";
import { sendOnce } from "../lib/email.js";
import { saveProducts, guessKind } from "../onboarding/import.js";
import { CONTENT_RULES_REASON, FAILED_REASON, retryBusyProducts } from "../onboarding/tests.js";
import { accountFacts, billingPlan, createInvoice, ensurePlanInvoice, monthlyPrice, payUrl, pdfUrl } from "../billing/ledger.js";
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

const SIGN_IN_EMAILS_PER_HOUR = 5;

portal.post("/auth/request", async (c) => {
  const body = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.RL_CONFIG_IP && !(await c.env.RL_CONFIG_IP.limit({ key: `login:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);
  const u = await c.env.DB.prepare("SELECT id, account_id FROM users WHERE email = ?").bind(body.data.email).first<{ id: string; account_id: string }>();
  // At most SIGN_IN_EMAILS_PER_HOUR codes per address: no flooding a brand's inbox from many networks, and
  // no collecting fresh codes to get more guesses. The answer stays the same either way (no account probing).
  const recent = u
    ? await c.env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND created_at > ?")
        .bind(body.data.email, new Date(Date.now() - 3_600_000).toISOString())
        .first<{ n: number }>()
    : null;
  if (u && (recent?.n ?? 0) < SIGN_IN_EMAILS_PER_HOUR) {
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
    // Brands that approved products but never tapped the old "Done" button.
    if (step?.onboarding_step === "products_tested" && (await confirmApproval(c.env, id))) await advance(c.env, id);
    // Products stopped by a temporary Google error: re-test now rather than at the next 15-minute run.
    await retryBusyProducts(c.env, id);
  }
  const a = await c.env.DB.prepare(
    `SELECT name, slug, status, platform, website, target_plan_id, plan_id, onboarding_step, pilot_started_at, pilot_ends_at, cycle_start, category, brand_color, brand_logo, brand_text_color
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
      category: "fashion" | "home";
      brand_color: string | null;
      brand_logo: string | null;
      brand_text_color: string | null;
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
      category: a.category,
    },
    look: { color: a.brand_color, textColor: a.brand_text_color, logo: a.brand_logo ? `${c.env.APP_ORIGIN}/bl/${id}/${a.brand_logo}` : null },
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
    `SELECT id, title, images_json, kind, selected, test_score, enabled, needs_review, disabled_reason, brand_decision, product_url, source, brand_retests
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
      source: string;
      brand_retests: number;
    }>();
  const tests = await c.env.DB.prepare("SELECT id, product_id, fixture FROM product_tests WHERE account_id = ? AND r2_key IS NOT NULL ORDER BY created_at")
    .bind(id)
    .all<{ id: string; product_id: string; fixture: string }>();
  // One preview per test model: the newest (after "Test again", older runs are not shown).
  const latest = new Map<string, { id: string; product_id: string; fixture: string }>();
  for (const t of tests.results) latest.set(`${t.product_id}|${t.fixture}`, t);
  const shown = [...latest.values()].sort((x, y) => x.fixture.localeCompare(y.fixture));
  const a = await c.env.DB.prepare("SELECT plan_id, max_products FROM accounts WHERE id = ?").bind(id).first<{ plan_id: PlanId; max_products: number | null }>();
  return c.json({
    maxProducts: productLimit(a?.plan_id ?? "pilot", a?.max_products),
    products: rows.results.map((p) => ({
      id: p.id,
      title: p.title,
      image: (JSON.parse(p.images_json) as string[])[0] ?? null,
      kind: p.kind,
      url: p.product_url,
      manual: p.source === "manual",
      selected: p.selected === 1,
      tested: p.test_score !== null,
      result: p.test_score === null ? "pending" : p.enabled ? "passed" : p.needs_review ? "review" : "failed",
      // Plain words only: the AI checker's own notes stay in the admin.
      reason: p.disabled_reason === CONTENT_RULES_REASON ? CONTENT_RULES_REASON : p.disabled_reason ? FAILED_REASON : null,
      decision: p.brand_decision,
      retestsLeft: Math.max(0, BRAND_RETESTS - p.brand_retests),
      tests: shown.filter((t) => t.product_id === p.id).map((t) => `/portal-api/test-image/${t.id}`),
    })),
  });
});

/** Results: anonymous counts for the pilot so far (pilot brands) or the last 30 days. */
portal.get("/results", async (c) => {
  // Filter: ?from=&to= (Cairo days); otherwise the pilot so far, or the last 30 days.
  const { from, to } = readPeriod(c.req.query("from"), c.req.query("to")) ?? (await defaultPeriod(c.env, acct(c)));
  const r = await buildReport(c.env, acct(c), from, to);
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
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
  const ids = [...new Set(body.data.ids)];
  // Tested products keep their place; untested ones not chosen are unselected. Check the plan's limit on the
  // result BEFORE saving anything, so an over-limit choice is refused and nothing changes.
  const kept = await c.env.DB.prepare("SELECT id FROM products WHERE account_id = ? AND selected = 1 AND test_score IS NOT NULL").bind(id).all<{ id: string }>();
  const after = new Set([...kept.results.map((r) => r.id), ...ids]);
  if (max !== null && after.size > max) return c.json({ error: "too_many", max }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE products SET selected = 0 WHERE account_id = ? AND test_score IS NULL").bind(id),
    ...ids.map((pid) => c.env.DB.prepare("UPDATE products SET selected = 1 WHERE account_id = ? AND id = ?").bind(id, pid)),
  ]);
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(id).first<{ c: number }>();
  await c.env.JOBS.send({ t: "advance", a: id });
  return c.json({ ok: true, selected: total?.c ?? 0 });
});

const ManualProduct = z.object({
  title: z.string().trim().min(2).max(200),
  imageUrl: httpUrl(1000).refine((v) => v.startsWith("https://"), { message: "Use an https:// photo address" }),
  productUrl: httpUrl(1000).optional(),
  description: z.string().trim().max(2000).optional(),
  /** Sizes the brand sells, e.g. "S, M, L, XL" (turns on the size finder on Growth). */
  sizes: z.string().trim().max(120).optional(),
});

/** "S, M / L ،XL" or "S M L XL" → ["S", "M", "L", "XL"]. "One size" stays one size. */
export function parseSizes(s: string | undefined): string[] {
  if (!s) return [];
  let parts = s.split(/[,/،;|]+/).map((x) => x.trim()).filter(Boolean);
  // Space-separated short labels ("S M L", "38 40 42"); longer phrases like "One size" stay whole.
  if (parts.length === 1 && !/size|سايز|مقاس/i.test(parts[0]!) && parts[0]!.split(/\s+/).every((x) => x.length <= 4) && /\s/.test(parts[0]!)) parts = parts[0]!.split(/\s+/);
  return [...new Set(parts.filter((x) => x.length <= 10))].slice(0, 15);
}

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
      sizes: parseSizes(p.sizes),
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
/** Save one uploaded product photo for an account (brand portal, or Garrab support in the admin). */
export async function uploadProduct(env: Env, id: string, form: FormData | null): Promise<{ status: 200 | 400 | 413 | 415; body: Record<string, unknown> }> {
  const file = form?.get("photo");
  const title = String(form?.get("title") ?? "").trim();
  const productUrl = String(form?.get("productUrl") ?? "").trim() || undefined;
  const sizes = String(form?.get("sizes") ?? "").trim().slice(0, 120) || undefined;
  if (!form || !(file instanceof File) || title.length < 2 || title.length > 200) return { status: 400, body: { error: "invalid" } };
  if (file.size > PRODUCT_PHOTO_MAX_BYTES) return { status: 413, body: { error: "too_large" } };
  if (productUrl && !httpUrl(1000).safeParse(productUrl).success) return { status: 400, body: { error: "invalid", fields: ["productUrl"] } };
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type || type === "image/heic") return { status: 415, body: { error: "not_an_image" } };
  if (type === "image/jpeg") bytes = stripJpegMetadata(bytes);
  const name = `${ulid().toLowerCase()}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`;
  await env.FILES.put(`products/${id}/${name}`, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  const imageUrl = productPhotoUrl(env, id, name);
  const added = await addManual(env, id, [{ title, imageUrl, productUrl, sizes }]);
  if (!added) {
    await env.FILES.delete(`products/${id}/${name}`);
    return { status: 400, body: { error: "limit_reached" } };
  }
  await env.JOBS.send({ t: "advance", a: id });
  return { status: 200, body: { ok: true, imageUrl } };
}

portal.post("/products/upload", async (c) => {
  const r = await uploadProduct(c.env, acct(c), await c.req.formData().catch(() => null));
  return c.json(r.body, r.status);
});

/**
 * The brand's look on its try-on pages and website button: main colour and logo.
 * multipart: color ("#rrggbb" or "" to reset), logo (PNG/JPG/WEBP, max 2 MB), removeLogo ("1").
 */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
portal.post("/brand", async (c) => {
  const id = acct(c);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "invalid" }, 400);
  const cur = await c.env.DB.prepare("SELECT brand_logo FROM accounts WHERE id = ?").bind(id).first<{ brand_logo: string | null }>();
  // "" = back to automatic; absent = unchanged.
  const readColor = (v: unknown): string | null | undefined | false =>
    typeof v !== "string" ? undefined : v === "" ? null : /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : false;
  const color = readColor(form.get("color"));
  const textColor = readColor(form.get("textColor"));
  if (color === false || textColor === false) return c.json({ error: "bad_color" }, 400);
  let logo: string | null | undefined;
  const file = form.get("logo");
  if (file instanceof File && file.size > 0) {
    if (file.size > LOGO_MAX_BYTES) return c.json({ error: "too_large" }, 413);
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type || type === "image/heic") return c.json({ error: "not_an_image" }, 415);
    if (type === "image/jpeg") bytes = stripJpegMetadata(bytes);
    logo = `${ulid().toLowerCase()}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`;
    await c.env.FILES.put(`brand/${id}/${logo}`, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  } else if (form.get("removeLogo") === "1") {
    logo = null;
  }
  if (logo !== undefined && cur?.brand_logo) await c.env.FILES.delete(`brand/${id}/${cur.brand_logo}`);
  await c.env.DB.prepare(
    `UPDATE accounts SET brand_color = CASE WHEN ?1 THEN ?2 ELSE brand_color END, brand_logo = CASE WHEN ?3 THEN ?4 ELSE brand_logo END,
            brand_text_color = CASE WHEN ?6 THEN ?7 ELSE brand_text_color END WHERE id = ?5`,
  )
    .bind(color !== undefined ? 1 : 0, color ?? null, logo !== undefined ? 1 : 0, logo ?? null, id, textColor !== undefined ? 1 : 0, textColor ?? null)
    .run();
  invalidateStatus(id);
  return c.json({ ok: true });
});

/** The brand removes one of its products: added by hand → deleted; read from its website → hidden. */
portal.post("/products/:id/delete", async (c) => {
  const id = acct(c);
  const pid = c.req.param("id");
  const own = await c.env.DB.prepare("SELECT title FROM products WHERE id = ? AND account_id = ?").bind(pid, id).first<{ title: string }>();
  if (!own) return c.json({ error: "not_found" }, 404);
  const hidden = await removeProduct(c.env, id, pid);
  return c.json({ ok: true, hidden });
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

/** The brand renames a product (e.g. photos uploaded with camera or app file names). */
portal.post("/products/:id/rename", async (c) => {
  const body = z.object({ title: z.string().trim().min(2).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const r = await c.env.DB.prepare("UPDATE products SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND account_id = ?")
    .bind(body.data.title, c.req.param("id"), acct(c))
    .run();
  if (r.meta.changes !== 1) return c.json({ error: "not_found" }, 404);
  invalidateStatus(acct(c));
  return c.json({ ok: true });
});

/** The brand asks for new test previews of a product that failed or that our check wasn't sure about. */
const BRAND_RETESTS = 2;
portal.post("/products/:id/retest", async (c) => {
  const id = acct(c);
  const pid = c.req.param("id");
  const p = await c.env.DB.prepare("SELECT enabled, test_score, brand_retests, disabled_reason FROM products WHERE id = ? AND account_id = ? AND selected = 1")
    .bind(pid, id)
    .first<{ enabled: number; test_score: number | null; brand_retests: number; disabled_reason: string | null }>();
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.enabled === 1 || p.test_score === null || p.disabled_reason === CONTENT_RULES_REASON) return c.json({ error: "not_allowed" }, 400);
  if (p.brand_retests >= BRAND_RETESTS) return c.json({ error: "limit_reached" }, 429);
  await clearProductTests(c.env, id, pid);
  await c.env.DB.prepare(
    `UPDATE products SET test_score = NULL, test_started_at = NULL, test_retry_at = NULL, test_busy_count = 0, enabled = 0, needs_review = 0,
            disabled_reason = NULL, brand_decision = NULL, approved = 0, brand_retests = brand_retests + 1 WHERE id = ?`,
  )
    .bind(pid)
    .run();
  await c.env.JOBS.send({ t: "test", a: id, p: pid });
  return c.json({ ok: true });
});

portal.post("/products/:id/decision", async (c) => {
  const body = z.object({ decision: z.enum(["approved", "hidden"]) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const ok = await decideProduct(c.env, acct(c), c.req.param("id"), body.data.decision);
  if (!ok) return c.json({ error: "not_found" }, 404);
  // Approving a product is the go-ahead: the brand goes live straight away (no separate "Done" step to miss).
  if (body.data.decision === "approved" && (await confirmApproval(c.env, acct(c)))) {
    const step = await advance(c.env, acct(c));
    return c.json({ ok: true, step });
  }
  return c.json({ ok: true });
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
    plan: { name: plan.name, price: monthlyPrice(a, billingPlan(a)), previews: plan.includedPreviews },
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

// ---------------------------------------------------------------- support chat

const chatView = (m: { id: string; sender: string; body: string; created_at: string }) => ({
  id: m.id,
  from: m.sender === "brand" ? "you" : m.sender === "bot" ? "auto" : "support",
  body: m.body,
  at: m.created_at,
});

/** Unread count only (the chat button's badge; cheap enough to poll). */
portal.get("/support/unread", async (c) => c.json({ unread: await brandUnread(c.env, acct(c)) }));

/** The conversation. Opening it marks Garrab's replies as seen (not in the admin's read-only view). */
portal.get("/support", async (c) => {
  const id = acct(c);
  const list = await messages(c.env, id);
  if (!c.get("user").readonly) await markBrandSeen(c.env, id);
  return c.json({ messages: list.map(chatView) });
});

portal.post("/support", async (c) => {
  const body = z.object({ body: z.string().trim().min(1).max(SUPPORT.maxMessageChars) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const id = acct(c);
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE account_id = ? AND sender = 'brand' AND created_at > ?")
    .bind(id, new Date(Date.now() - 3_600_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= SUPPORT.brandMessagesPerHour) return c.json({ error: "rate_limited" }, 429);
  const account = await accountFresh(c.env, id);
  if (!account) return c.json({ error: "not_found" }, 404);
  const added = await brandWrites(c.env, account, body.data.body);
  await markBrandSeen(c.env, id);
  return c.json({ messages: added.map(chatView) });
});
