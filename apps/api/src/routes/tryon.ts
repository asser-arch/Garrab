import { PHOTO } from "@garrab/shared/plans";
import { Hono, type Context } from "hono";
import { ctxKey, type Env } from "../env.js";
import { verifyCtx } from "../lib/crypto.js";
import { accountFresh, domainAllowed, getSetting, isServing, servableProduct } from "../lib/db.js";
import { log } from "../lib/log.js";
import { bumpCounter, checkCaps, recordUsage, releasePreview, reservePreview, usageWarnings } from "../lib/metering.js";
import { alert } from "../lib/ops.js";
import { readPhoto } from "../lib/photo.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { tryOnProvider, type TryOnProvider } from "../providers/tryon.js";

type C = Context<{ Bindings: Env }>;

/** Error codes the frame maps to friendly strings. Never contains internal detail. */
export type TryOnApiError =
  | "forbidden_origin"
  | "too_large"
  | "bad_request"
  | "session_expired"
  | "rate_limited"
  | "bot_check"
  | "photo_missing"
  | "photo_too_large"
  | "photo_type"
  | "unavailable"
  | "product_unavailable"
  | "not_supported"
  | "quota"
  | "busy"
  | "content_policy"
  | "bad_photo"
  | "failed";

function fail(c: C, status: 400 | 401 | 402 | 403 | 404 | 413 | 415 | 422 | 429 | 503, error: TryOnApiError): Response {
  log("tryon_rejected", { route: "tryon", status, code: error });
  return c.json({ error }, status);
}

/** Delete the shopper's data at the provider, with retries; queue it if it still fails. */
export async function deleteAtProvider(env: Env, provider: TryOnProvider, oneTimeUserId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await provider.deleteUserData(oneTimeUserId)) return;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  await env.DB.prepare("INSERT OR IGNORE INTO pending_deletes (provider_ref, provider) VALUES (?, ?)")
    .bind(oneTimeUserId, provider.name)
    .run();
  await alert(env, "provider_delete_failed", null, `${provider.name}: delete call failed 3 times; queued for retry.`);
}

/** Alert right away when a provider fails 5+ times in an hour (once per hour). */
async function providerErrorBurst(env: Env, provider: string): Promise<void> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE provider = ? AND ok = 0 AND created_at >= ?").bind(provider, since).first<{ n: number }>();
  if ((r?.n ?? 0) < 5) return;
  const hour = new Date().toISOString().slice(0, 13);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO notifications (id, template, channel, dedupe_key, status) VALUES (?, 'provider_errors', 'alert', ?, 'sent')")
    .bind(crypto.randomUUID(), `alert:provider:${provider}:${hour}`)
    .run();
  if (claim.meta.changes === 1) await alert(env, "provider_errors", null, `${provider}: ${r?.n} failed AI calls in the last hour.`);
}

/**
 * Run work after the response. In tests it runs inline instead, so it can't outlive the test
 * file's storage (production behaviour is unchanged).
 */
async function afterResponse(c: C, work: Promise<unknown>): Promise<void> {
  if (c.env.ENVIRONMENT === "test") await work;
  else c.executionCtx.waitUntil(work);
}

export const tryon = new Hono<{ Bindings: Env }>();

/**
 * POST /v1/tryon  multipart: ctx, turnstile, product, photo
 * The photo lives only in this request's memory. It is never written to D1, KV, R2, logs or analytics.
 */
tryon.post("/tryon", async (c) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("origin") ?? "";
  if (origin !== c.env.APP_ORIGIN) return fail(c, 403, "forbidden_origin");
  c.header("Access-Control-Allow-Origin", c.env.APP_ORIGIN);
  c.header("Vary", "Origin");

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > PHOTO.maxBytes + 64 * 1024) return fail(c, 413, "too_large");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, 400, "bad_request");
  }
  const ctxToken = form.get("ctx");
  const productId = form.get("product");
  if (typeof ctxToken !== "string" || typeof productId !== "string" || productId.length > 40)
    return fail(c, 400, "bad_request");

  const claims = await verifyCtx(ctxKey(c.env), ctxToken);
  if (!claims) return fail(c, 401, "session_expired");

  const ip = c.req.header("cf-connecting-ip") ?? "unknown"; // in-memory rate-limit key only
  if (c.env.RL_TRYON_IP && !(await c.env.RL_TRYON_IP.limit({ key: ip })).success) return fail(c, 429, "rate_limited");
  if (c.env.RL_TRYON_KEY && !(await c.env.RL_TRYON_KEY.limit({ key: claims.a })).success)
    return fail(c, 429, "rate_limited");

  const turnstile = form.get("turnstile");
  if (!(await verifyTurnstile(c.env, typeof turnstile === "string" ? turnstile : null))) return fail(c, 403, "bot_check");

  const photo = await readPhoto(form.get("photo"));
  if (!photo.ok) return fail(c, photo.code === "photo_too_large" ? 413 : photo.code === "photo_type" ? 415 : 400, photo.code);

  // Kill switch, re-checked on the server for every AI call. Fail closed on any error.
  let account;
  try {
    if (await getSetting(c.env, "global_kill", false)) return fail(c, 503, "unavailable");
    account = await accountFresh(c.env, claims.a);
    if (!account || !isServing(account.status)) return fail(c, 403, "unavailable");
    if (claims.o !== "hosted" && !(await domainAllowed(c.env, account.id, claims.o))) return fail(c, 403, "unavailable");
  } catch {
    return fail(c, 503, "unavailable");
  }

  const product = await servableProduct(c.env, account.id, productId);
  if (!product) return fail(c, 404, "product_unavailable");
  const room = product.kind === "decor"; // home décor brands: the item placed in the shopper's room

  const caps = await checkCaps(c.env, account);
  if (caps !== "ok") return fail(c, 503, "unavailable");
  if ((await reservePreview(c.env, account)) === "quota") return fail(c, 402, "quota");

  const provider = tryOnProvider(c.env, room ? "room" : "person");
  const oneTimeUserId = crypto.randomUUID();
  const started = Date.now();
  let result;
  try {
    result = await provider.tryOn({
      product: {
        externalId: `${account.id}_${product.id}`,
        title: product.title,
        description: product.description ?? "",
        imageUrls: JSON.parse(product.images_json) as string[],
        includesHeadwear: product.includes_headwear === 1,
        synced: product.provider_synced_at !== null,
      },
      photo: photo.bytes,
      photoType: photo.type,
      oneTimeUserId,
    });
  } finally {
    // Always delete at the provider, whatever happened.
    await afterResponse(c, deleteAtProvider(c.env, provider, oneTimeUserId));
  }

  if (!result.ok) {
    await releasePreview(c.env, account);
    await recordUsage(c.env, account.id, room ? "room" : "tryon", provider.name, false, 0, `${result.code}${result.detail ? `: ${result.detail}` : ""}`.slice(0, 400));
    log("tryon_failed", { route: "tryon", account: account.id, provider: provider.name, code: result.code, detail: result.detail ?? "", ms: Date.now() - started });
    if (result.code === "provider_credits") await alert(c.env, "provider_credits", null, `${provider.name}: out of credits.`);
    await afterResponse(c, providerErrorBurst(c.env, provider.name));
    if (result.code === "content_policy") return fail(c, 422, "content_policy");
    if (result.code === "bad_photo") return fail(c, 422, "bad_photo");
    if (result.code === "provider_busy") return fail(c, 503, "busy");
    return fail(c, 422, "failed");
  }

  await recordUsage(c.env, account.id, room ? "room" : "tryon", provider.name, true, result.costMicroUsd);
  // Counted on the server (the shopper's page can't fake it): total and per product, for the results report.
  await bumpCounter(c.env, account.id, "preview");
  await bumpCounter(c.env, account.id, `preview@${product.id}`);
  await afterResponse(c, usageWarnings(c.env, account, `${c.env.APP_ORIGIN}/portal/billing`));
  if (!product.provider_synced_at) {
    await c.env.DB.prepare("UPDATE products SET provider_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(product.id)
      .run();
  }
  log("tryon_ok", { route: "tryon", account: account.id, provider: provider.name, ms: Date.now() - started });
  return new Response(result.image, {
    status: 200,
    headers: {
      "content-type": result.contentType,
      "cache-control": "no-store",
      "access-control-allow-origin": c.env.APP_ORIGIN,
      vary: "Origin",
      "x-content-type-options": "nosniff",
    },
  });
});
