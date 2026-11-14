/**
 * Inbound webhooks. Every event is stored in webhook_events BEFORE processing (replayable),
 * processed idempotently, and a bad signature raises an alert.
 */
import { Hono } from "hono";
import type { Env } from "../env.js";
import { ulid } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { alert } from "../lib/ops.js";
import { verifyCallback } from "../lib/telegram.js";
import { handleClaimButton } from "../billing/instapay.js";
import { applyPayment } from "../billing/ledger.js";
import { verifyKashierSignature } from "../billing/kashier.js";

export const webhooks = new Hono<{ Bindings: Env }>();

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function store(env: Env, provider: string, key: string | null, ok: boolean, raw: string): Promise<{ id: string; duplicate: boolean }> {
  const id = ulid();
  const r = await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, provider, event_key, signature_ok, raw_body) VALUES (?, ?, ?, ?, ?)")
    .bind(id, provider, key, ok ? 1 : 0, raw.slice(0, 20_000))
    .run();
  return { id, duplicate: r.meta.changes !== 1 };
}

async function done(env: Env, id: string, error: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE webhook_events SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = ? WHERE id = ?").bind(error, id).run();
}

async function signatureFailure(env: Env, provider: string): Promise<void> {
  await alert(env, "webhook_signature", null, `Webhook signature failure from ${provider}. Someone may be probing the endpoint.`);
}

/** Telegram: only the Confirm / Not received buttons, only from Asser's chat, only signed ones. */
webhooks.post("/telegram", async (c) => {
  const raw = await c.req.text();
  const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  if (!c.env.TELEGRAM_WEBHOOK_SECRET || !same(secret, c.env.TELEGRAM_WEBHOOK_SECRET)) {
    await store(c.env, "telegram", null, false, "");
    await signatureFailure(c.env, "telegram");
    return c.body(null, 401);
  }
  let u: { update_id?: number; callback_query?: { id: string; data?: string; from?: { id: number }; message?: { message_id: number; chat: { id: number }; text?: string } } };
  try {
    u = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  const ev = await store(c.env, "telegram", u.update_id !== undefined ? String(u.update_id) : null, true, raw);
  if (ev.duplicate) return c.body(null, 200);
  const q = u.callback_query;
  if (!q?.data) return (await done(c.env, ev.id, "ignored"), c.body(null, 200));
  const fromAsser = String(q.from?.id ?? "") === c.env.TELEGRAM_CHAT_ID && (!q.message || String(q.message.chat.id) === c.env.TELEGRAM_CHAT_ID);
  const cb = await verifyCallback(c.env, q.data);
  if (!fromAsser || !cb || cb.kind !== "pc" || (cb.action !== "a" && cb.action !== "r")) {
    await done(c.env, ev.id, "rejected");
    await signatureFailure(c.env, "telegram button");
    return c.body(null, 200);
  }
  await handleClaimButton(c.env, q, cb.id, cb.action);
  await done(c.env, ev.id);
  log("webhook", { provider: "telegram", ok: true });
  return c.body(null, 200);
});

/** Kashier (ready for later): signed per its docs; merchantOrderId = our invoice id. */
webhooks.post("/kashier", async (c) => {
  const raw = await c.req.text();
  let body: { event?: string; data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  const data = body.data ?? {};
  const ok = await verifyKashierSignature(data, c.req.header("x-kashier-signature"), c.env.KASHIER_PAYMENT_API_KEY ?? "");
  const key = typeof data.transactionId === "string" ? `${data.transactionId}:${data.status ?? ""}` : null;
  const ev = await store(c.env, "kashier", key, ok, raw);
  if (!ok) {
    await signatureFailure(c.env, "kashier");
    return c.body(null, 401);
  }
  if (ev.duplicate) return c.body(null, 409); // Kashier treats 409 as acknowledged
  if (body.event === "pay" && data.status === "SUCCESS" && typeof data.merchantOrderId === "string") {
    const amount = Math.round(Number(data.amount) * 100);
    const r = await applyPayment(c.env, {
      invoiceId: data.merchantOrderId,
      provider: "kashier",
      txnId: String(data.transactionId),
      amount,
      method: String(data.method ?? "card"),
      actor: "kashier",
    });
    await done(c.env, ev.id, r.applied ? null : (r.reason ?? "not_applied"));
  } else {
    if (data.status === "FAILURE") await alert(c.env, "payment_failed", null, `Kashier payment failed for order ${String(data.merchantOrderId ?? "?")}.`);
    await done(c.env, ev.id, "ignored");
  }
  return c.body(null, 200);
});
