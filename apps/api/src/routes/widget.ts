import { PLANS, TIMINGS } from "@garrab/shared/plans";
import { WidgetEvent } from "@garrab/shared";
import { Hono, type Context } from "hono";
import { ctxKey, type Env } from "../env.js";
import { signCtx, verifyCtx } from "../lib/crypto.js";
import { PHOTO_FILE_RE } from "../lib/products.js";
import {
  accountByKey,
  accountBySlug,
  accountCached,
  domainAllowed,
  getSetting,
  isServing,
  originHost,
  servableProduct,
  servableProducts,
} from "../lib/db.js";
import { bumpCounter } from "../lib/metering.js";

type C = Context<{ Bindings: Env }>;

const DISABLED = { enabled: false } as const;

function corsFor(c: C, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
}

function clientIp(c: C): string {
  // Used only as an in-memory rate-limit key. Never logged or stored.
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

async function limited(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  const { success } = await rl.limit({ key });
  return !success;
}

async function issueCtx(env: Env, accountId: string, origin: string, version: number): Promise<{ ctx: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + TIMINGS.ctxTokenMinutes * 60;
  return { ctx: await signCtx(ctxKey(env), { a: accountId, o: origin, e: exp, v: version }), exp };
}

export const widget = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/config?key=gk_live_…  (called by w.js on every page load)
 * Fails closed: any doubt → { enabled: false }.
 */
/** Product photos uploaded by brands (public: they are the brand's own product pictures). */
widget.get("/product-image/:acct/:file", async (c) => {
  const { acct, file } = c.req.param();
  if (!/^[A-Z0-9]{26}$/.test(acct) || !PHOTO_FILE_RE.test(file)) return c.text("Not found", 404);
  const obj = await c.env.FILES.get(`products/${acct}/${file}`);
  if (!obj) return c.text("Not found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
});

widget.get("/config", async (c) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("origin") ?? "";
  const host = originHost(origin);
  if (await limited(c.env.RL_CONFIG_IP, clientIp(c))) return c.json(DISABLED, 429);
  // CORS is sent even for refusals, so the browser reads { enabled: false } quietly instead of
  // printing a CORS error on the brand's page. A refusal carries no data.
  if (host) corsFor(c, origin);
  try {
    if (!host) return c.json(DISABLED);
    const keyed = await accountByKey(c.env, c.req.query("key") ?? "");
    if (!keyed) return c.json(DISABLED);
    // Domain lock: the key only works from the brand's registered domains.
    if (!(await domainAllowed(c.env, keyed.id, host))) return c.json(DISABLED);
    if (await getSetting(c.env, "global_kill", false)) return c.json(DISABLED);
    const account = await accountCached(c.env, keyed.id);
    if (!account || !isServing(account.status)) return c.json(DISABLED);

    const products = await servableProducts(c.env, account.id);
    if (products.length === 0) return c.json(DISABLED);
    const { ctx, exp } = await issueCtx(c.env, account.id, host, account.status_version);
    return c.json({
      enabled: true,
      ttl: TIMINGS.widgetConfigTtlSeconds,
      ctx,
      exp,
      frame: `${c.env.APP_ORIGIN}/frame`,
      selector: account.button_selector,
      sizeFinder: PLANS[account.plan_id].sizeFinder,
      products: products.map((p) => ({ id: p.id, ref: p.external_ref, path: p.url_path, kind: p.kind })),
    });
  } catch {
    return c.json(DISABLED); // fail closed
  }
});

/** GET /v1/hosted/:slug/:productId  (our hosted try-on page for Instagram / WhatsApp brands) */
widget.get("/hosted/:slug/:productId", async (c) => {
  c.header("Cache-Control", "no-store");
  corsFor(c, c.env.APP_ORIGIN);
  try {
    if (await getSetting(c.env, "global_kill", false)) return c.json(DISABLED);
    const bySlug = await accountBySlug(c.env, c.req.param("slug"));
    if (!bySlug) return c.json(DISABLED);
    const account = await accountCached(c.env, bySlug.id);
    if (!account || !isServing(account.status)) return c.json(DISABLED);
    const p = await servableProduct(c.env, account.id, c.req.param("productId"));
    if (!p) return c.json(DISABLED);
    const images = JSON.parse(p.images_json) as string[];
    const { ctx, exp } = await issueCtx(c.env, account.id, "hosted", account.status_version);
    return c.json({
      enabled: true,
      ctx,
      exp,
      brand: { name: account.name },
      product: { id: p.id, title: p.title, image: images[0] ?? null, kind: p.kind },
      buyUrl: p.url_path && account.buy_url ? new URL(p.url_path, account.buy_url).toString() : account.buy_url,
      privacyClaim: await getSetting(c.env, "privacy_claim_verified", false),
    });
  } catch {
    return c.json(DISABLED);
  }
});

/** GET /v1/frame-info?ctx=… (the iframe asks whether to show the privacy claim) */
widget.get("/frame-info", async (c) => {
  c.header("Cache-Control", "no-store");
  corsFor(c, c.env.APP_ORIGIN);
  const claims = await verifyCtx(ctxKey(c.env), c.req.query("ctx") ?? "");
  if (!claims) return c.json(DISABLED);
  return c.json({ enabled: true, privacyClaim: await getSetting(c.env, "privacy_claim_verified", false) });
});

/** POST /v1/events  body (text/plain JSON): { ctx, e }  — anonymous daily counts only. */
widget.post("/events", async (c) => {
  const origin = c.req.header("origin") ?? "";
  if (await limited(c.env.RL_CONFIG_IP, clientIp(c))) return c.body(null, 429);
  let body: { ctx?: unknown; e?: unknown };
  try {
    const text = await c.req.text();
    if (text.length > 2048) return c.body(null, 413);
    body = JSON.parse(text) as typeof body;
  } catch {
    return c.body(null, 400);
  }
  const ev = WidgetEvent.safeParse(body.e);
  const claims = typeof body.ctx === "string" ? await verifyCtx(ctxKey(c.env), body.ctx) : null;
  if (!ev.success || !claims) return c.body(null, 400);
  // Events come from the brand page (button_view) or our frame (the rest).
  const fromBrand = claims.o !== "hosted" && originHost(origin) === claims.o;
  const fromApp = origin === c.env.APP_ORIGIN;
  if (!fromBrand && !fromApp) return c.body(null, 403);
  corsFor(c, origin);
  await bumpCounter(c.env, claims.a, ev.data);
  return c.body(null, 204);
});
