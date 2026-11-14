/**
 * Direct InstaPay (Asser's choice, 14 Nov 2026). InstaPay has no merchant API or webhook, so:
 *  1. the pay page shows the amount, Asser's InstaPay address and the invoice number for the note;
 *  2. the brand pays in their InstaPay app and taps "I've paid" with the transfer reference;
 *  3. Asser gets a Telegram message with Confirm / Not received buttons (signed, his chat only);
 *  4. Confirm → applyPayment(); Not received → the brand is told and the suspension hold ends.
 * A claim holds suspension for at most 48 hours; Asser is reminded every 12 hours.
 */
import { emails } from "../emails.js";
import type { Env } from "../env.js";
import { ulid } from "../lib/crypto.js";
import { sendOnce } from "../lib/email.js";
import { reconcileAccount, applyPayment, payUrl, type InvoiceRow } from "./ledger.js";
import { answerCallback, editMessage, sendTelegram, signCallback } from "../lib/telegram.js";

export const CLAIM_HOLD_HOURS = 48;
export const CLAIM_PING_HOURS = 12;

async function owner(env: Env, accountId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(accountId).first<{ email: string }>())?.email ?? null;
}

async function notifyAsser(env: Env, claimId: string, prefix = "💸 Payment to confirm"): Promise<void> {
  const c = await env.DB.prepare(
    `SELECT c.id, c.reference, c.payer_name, c.created_at, i.number, i.total, a.name
       FROM payment_claims c JOIN invoices i ON i.id = c.invoice_id JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`,
  )
    .bind(claimId)
    .first<{ id: string; reference: string; payer_name: string | null; created_at: string; number: string; total: number; name: string }>();
  if (!c) return;
  const text = [
    `${prefix}`,
    `${c.name}: ${c.total / 100} EGP for ${c.number}`,
    `InstaPay reference: ${c.reference}`,
    c.payer_name ? `Sent by: ${c.payer_name}` : null,
    "Check your InstaPay or bank app, then tap one:",
  ]
    .filter(Boolean)
    .join("\n");
  await sendTelegram(env, text, [
    [
      { text: "✅ Confirm", callback_data: await signCallback(env, "pc", c.id, "a") },
      { text: "❌ Not received", callback_data: await signCallback(env, "pc", c.id, "r") },
    ],
  ]);
  await env.DB.prepare("UPDATE payment_claims SET last_ping_at = ? WHERE id = ?").bind(new Date().toISOString(), c.id).run();
}

/** The brand says "I've paid". One pending claim per invoice (idempotent). */
export async function createClaim(env: Env, inv: InvoiceRow, reference: string, payerName: string | null, now = new Date()): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare("SELECT id FROM payment_claims WHERE invoice_id = ? AND status = 'pending'").bind(inv.id).first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };
  const id = ulid();
  const hold = new Date(now.getTime() + CLAIM_HOLD_HOURS * 3_600_000).toISOString();
  await env.DB.prepare("INSERT INTO payment_claims (id, invoice_id, account_id, reference, payer_name, hold_until) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, inv.id, inv.account_id, reference, payerName, hold)
    .run();
  await env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason) VALUES (?, ?, 'brand', 'payment_claim', ?)")
    .bind(ulid(), inv.account_id, `${inv.number}: InstaPay reference ${reference}`)
    .run();
  await notifyAsser(env, id);
  const to = await owner(env, inv.account_id);
  if (to) await sendOnce(env, { accountId: inv.account_id, template: "claim_received", dedupeKey: `claim:${id}`, msg: emails.claimReceived(to, inv) });
  // A held account that was suspended comes back on while Asser checks (brief: no false-claim abuse past 48 h).
  await reconcileAccount(env, inv.account_id, now, "brand");
  return { id, created: true };
}

/** Confirm (`a`) or reject (`r`) a claim. Used by the Telegram buttons and the admin console. */
export async function decideClaim(env: Env, claimId: string, action: "a" | "r", actor: string, now = new Date()): Promise<"confirmed" | "rejected" | "already" | "missing"> {
  const c = await env.DB.prepare("SELECT * FROM payment_claims WHERE id = ?").bind(claimId).first<{ id: string; invoice_id: string; account_id: string; reference: string; status: string }>();
  if (!c) return "missing";
  if (c.status !== "pending") return "already";
  const inv = (await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(c.invoice_id).first<InvoiceRow>())!;
  if (action === "a") {
    await applyPayment(env, { invoiceId: inv.id, provider: "instapay_direct", txnId: `claim:${c.id}`, amount: inv.total, method: "instapay", reference: c.reference, actor }, now);
    return "confirmed";
  }
  await env.DB.prepare("UPDATE payment_claims SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").bind(now.toISOString(), actor, c.id).run();
  await env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason) VALUES (?, ?, ?, 'payment_claim_rejected', ?)").bind(ulid(), c.account_id, actor, inv.number).run();
  const to = await owner(env, c.account_id);
  if (to) await sendOnce(env, { accountId: c.account_id, template: "claim_rejected", dedupeKey: `claim_rejected:${c.id}`, msg: emails.claimRejected(to, inv, payUrl(env, inv.pay_token)) });
  await reconcileAccount(env, c.account_id, now, actor); // the hold ends now
  return "rejected";
}

/** Telegram callback (already authenticated by the webhook route). */
export async function handleClaimButton(
  env: Env,
  q: { id: string; message?: { message_id: number; chat: { id: number }; text?: string } },
  claimId: string,
  action: "a" | "r",
): Promise<void> {
  const result = await decideClaim(env, claimId, action, "admin:telegram");
  const label = result === "confirmed" ? "✅ Confirmed: payment applied" : result === "rejected" ? "❌ Marked not received: brand told" : result === "already" ? "Already decided" : "Unknown claim";
  await answerCallback(env, q.id, label);
  if (q.message) await editMessage(env, q.message.chat.id, q.message.message_id, `${q.message.text ?? ""}\n\n${label}`);
}

/** Every 15 minutes: remind Asser about claims still waiting (every 12 h). */
export async function pingPendingClaims(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CLAIM_PING_HOURS * 3_600_000).toISOString();
  const rows = await env.DB.prepare("SELECT id FROM payment_claims WHERE status = 'pending' AND (last_ping_at IS NULL OR last_ping_at < ?) LIMIT 20").bind(cutoff).all<{ id: string }>();
  for (const r of rows.results) await notifyAsser(env, r.id, "⏰ Still waiting for your confirmation");
}
