import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, addMonths, periodFrom } from "../src/billing/dates.js";
import { kashierSignaturePayload, verifyKashierSignature } from "../src/billing/kashier.js";
import { accountFacts, applyPayment, billingRun, createInvoice, ensurePlanInvoice, reconcileAccount } from "../src/billing/ledger.js";
import { naturalStatus } from "../src/billing/status.js";
import { createAccount } from "../src/lib/accounts.js";
import { sha256Hex, ulid } from "../src/lib/crypto.js";
import { invalidateStatus } from "../src/lib/db.js";
import { signCallback } from "../src/lib/telegram.js";
import { cairoDay } from "../src/lib/time.js";
import { buildDigest } from "../src/ops/digest.js";
import { fakeJpeg } from "./helpers.js";

const APP = "https://app.test";
const ADMIN = { authorization: "Bearer test-admin-token-123456", "content-type": "application/json" };
let n = 0;
const uniq = (): string => `${Date.now().toString(36)}${n++}`;
const today = cairoDay();

beforeEach(async () => {
  await env.DB.prepare("UPDATE settings SET value_json = 'false' WHERE key IN ('global_kill','privacy_claim_verified')").run();
  invalidateStatus();
});

/** A live brand with a domain, a key and one approved product. */
async function brand(opts: { status: string; paidThrough?: string | null; plan?: "pilot" | "starter" | "growth"; pilotDaysAgo?: number; target?: "starter" | "growth" }) {
  const email = `b-${uniq()}@brand.example`;
  const host = `shop-${uniq()}.example`;
  const { accountId } = await createAccount(env, { brandName: `Brand ${uniq()}`, email, plan: opts.target ?? "starter", website: `https://${host}` });
  const start = opts.pilotDaysAgo !== undefined ? new Date(Date.now() - opts.pilotDaysAgo * 86_400_000) : null;
  await env.DB.prepare(
    `UPDATE accounts SET status = ?, plan_id = ?, paid_through = ?, onboarding_step = ?, pilot_started_at = ?, pilot_ends_at = ?, cycle_start = ? WHERE id = ?`,
  )
    .bind(
      opts.status,
      opts.plan ?? (opts.status === "pilot" ? "pilot" : "starter"),
      opts.paidThrough ?? null,
      opts.status === "pilot" ? "pilot_live" : "converted",
      start?.toISOString() ?? null,
      start ? new Date(start.getTime() + 14 * 86_400_000).toISOString() : null,
      start ? cairoDay(start) : today,
      accountId,
    )
    .run();
  const productId = `p${uniq()}`;
  await env.DB.prepare(
    `INSERT INTO products (id, account_id, external_ref, url_path, title, images_json, enabled, approved, selected) VALUES (?, ?, ?, '/products/x', 'Dress', '["https://cdn.example/x.jpg"]', 1, 1, 1)`,
  )
    .bind(productId, accountId, `r${uniq()}`)
    .run();
  const key = (await env.DB.prepare("SELECT key_public FROM api_keys WHERE account_id = ?").bind(accountId).first<{ key_public: string }>())!.key_public;
  invalidateStatus();
  return { id: accountId, email, origin: `https://${host}`, key, productId };
}

async function status(id: string): Promise<string> {
  return (await env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(id).first<{ status: string }>())!.status;
}
async function enabled(b: { key: string; origin: string }): Promise<boolean> {
  invalidateStatus();
  const r = await exports.default.fetch(`https://api.test/v1/config?key=${b.key}`, { headers: { origin: b.origin } });
  return ((await r.json()) as { enabled: boolean }).enabled;
}
async function outbox(to: string): Promise<string[]> {
  return (await env.DB.prepare("SELECT subject FROM dev_outbox WHERE to_addr = ? ORDER BY created_at, id").bind(to).all<{ subject: string }>()).results.map((r) => r.subject);
}
async function telegramPress(claimId: string, action: "a" | "r", opts: { secret?: string; from?: number; data?: string; updateId?: number } = {}): Promise<Response> {
  const data = opts.data ?? (await signCallback(env, "pc", claimId, action));
  return exports.default.fetch("https://api.test/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": opts.secret ?? "test-telegram-secret-abcdef" },
    body: JSON.stringify({
      update_id: opts.updateId ?? Math.floor(Math.random() * 1e9),
      callback_query: { id: "cq1", data, from: { id: opts.from ?? 424242 }, message: { message_id: 7, chat: { id: opts.from ?? 424242 }, text: "Payment to confirm" } },
    }),
  });
}
async function claim(token: string, reference = "IPN-123456"): Promise<Response> {
  return exports.default.fetch(`https://api.test/v1/pay/${token}/claim`, {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json" },
    body: JSON.stringify({ reference, payerName: "Mona" }),
  });
}

// ---------------------------------------------------------------- pure rules

describe("dates and status rules", () => {
  it("months clamp to the month's last day; periods are one month inclusive", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(periodFrom("2026-11-15")).toEqual({ start: "2026-11-15", end: "2026-12-14" });
    expect(periodFrom("2026-01-31")).toEqual({ start: "2026-01-31", end: "2026-02-27" });
  });

  it("derives the status from the ledger", () => {
    const base = { status: "active" as const, pilot_started_at: null, pilot_ends_at: null, cancel_at_period_end: 0, claimHold: false };
    const now = new Date();
    const t = "2026-11-20";
    expect(naturalStatus({ ...base, paid_through: "2026-11-20" }, t, now)).toBe("active");
    expect(naturalStatus({ ...base, paid_through: "2026-11-15" }, t, now)).toBe("past_due"); // T+5: still in grace
    expect(naturalStatus({ ...base, paid_through: "2026-11-14" }, t, now)).toBe("suspended"); // T+6: kill
    expect(naturalStatus({ ...base, paid_through: "2026-11-14", claimHold: true }, t, now)).toBe("past_due");
    expect(naturalStatus({ ...base, paid_through: "2026-10-14" }, t, now)).toBe("archived");
    expect(naturalStatus({ ...base, paid_through: "2026-11-19", cancel_at_period_end: 1 }, t, now)).toBe("cancelled");
  });
});

// ---------------------------------------------------------------- invoices

describe("invoices", () => {
  it("numbers are sequential with no gaps, per year", async () => {
    const a = await brand({ status: "active", paidThrough: addDays(today, 3) });
    const facts = (await accountFacts(env, a.id))!;
    const i1 = await createInvoice(env, facts, { kind: "pack", periodStart: null, dueDate: "2031-05-01" });
    const i2 = await createInvoice(env, facts, { kind: "pack", periodStart: null, dueDate: "2031-06-01" });
    const i3 = await createInvoice(env, facts, { kind: "pack", periodStart: null, dueDate: "2032-01-01" });
    expect([i1.number, i2.number, i3.number]).toEqual(["GRB-2031-0001", "GRB-2031-0002", "GRB-2032-0001"]);
    expect(i1.total).toBe(80_000); // 800 EGP, from plans.ts
  });

  it("PDF renders, and the pay page shows only that invoice", async () => {
    const a = await brand({ status: "active", paidThrough: addDays(today, 3) });
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, a.id))!, new Date());
    const pdf = await exports.default.fetch(`https://api.test/v1/pay/${inv.pay_token}/pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const page = (await (await exports.default.fetch(`https://api.test/v1/pay/${inv.pay_token}`)).json()) as { number: string; total: number; instapay: { address: string } };
    expect(page).toMatchObject({ number: inv.number, total: 500_000, instapay: { address: "asserrostom@instapay" } });
    expect((await exports.default.fetch(`https://api.test/v1/pay/${"x".repeat(32)}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- the money flows

describe("pilot → paid, through the InstaPay claim and Telegram", () => {
  it("day 12 invoice, claim, Asser taps Confirm, account active on the target plan", async () => {
    const b = await brand({ status: "pilot", pilotDaysAgo: 12, target: "growth" });
    await billingRun(env, new Date());
    const inv = (await env.DB.prepare("SELECT * FROM invoices WHERE account_id = ? AND kind = 'plan'").bind(b.id).first<{ id: string; pay_token: string; total: number; due_date: string; status: string }>())!;
    expect(inv.total).toBe(850_000); // Growth, 8,500 EGP
    expect(inv.due_date).toBe(cairoDay(new Date(Date.now() + 2 * 86_400_000)));

    expect((await claim(inv.pay_token)).status).toBe(200);
    expect((await (await claim(inv.pay_token)).json()) as { created: boolean }).toMatchObject({ created: false }); // one claim per invoice
    const c = (await env.DB.prepare("SELECT id FROM payment_claims WHERE invoice_id = ?").bind(inv.id).first<{ id: string }>())!;
    expect((await outbox(b.email))).toContain(`We're confirming your payment for ${(await env.DB.prepare("SELECT number FROM invoices WHERE id = ?").bind(inv.id).first<{ number: string }>())!.number}`);

    expect((await telegramPress(c.id, "a", { updateId: 1001 })).status).toBe(200);
    expect((await telegramPress(c.id, "a", { updateId: 1001 })).status).toBe(200); // replayed update: ignored
    expect((await telegramPress(c.id, "a")).status).toBe(200); // second tap: already decided

    const acc = await env.DB.prepare("SELECT status, plan_id, paid_through, onboarding_step FROM accounts WHERE id = ?").bind(b.id).first();
    expect(acc).toEqual({ status: "active", plan_id: "growth", paid_through: addDays(addMonths(today, 1), -1), onboarding_step: "converted" });
    const pays = await env.DB.prepare("SELECT provider, amount, method, reference FROM payments WHERE account_id = ?").bind(b.id).all();
    expect(pays.results).toEqual([{ provider: "instapay_direct", amount: 850_000, method: "instapay", reference: "IPN-123456" }]);
    expect(await enabled(b)).toBe(true);
    // Growth previews from now on.
    const me = (await accountFacts(env, b.id))!;
    expect(me.plan_id).toBe("growth");
  });

  it("not paid by pilot end + 5 days → expired, switched off; paying reactivates from today", async () => {
    const b = await brand({ status: "pilot", pilotDaysAgo: 20 });
    await billingRun(env, new Date());
    expect(await status(b.id)).toBe("expired");
    expect(await enabled(b)).toBe(false);
    expect(await outbox(b.email)).toContain("Your Garrab pilot has ended");
    const inv = (await env.DB.prepare("SELECT id, total FROM invoices WHERE account_id = ? AND status = 'open'").bind(b.id).first<{ id: string; total: number }>())!;
    await applyPayment(env, { invoiceId: inv.id, provider: "manual", txnId: `m-${uniq()}`, amount: inv.total, method: "bank_transfer", actor: "admin:test" });
    expect(await status(b.id)).toBe("active");
    expect((await accountFacts(env, b.id))!.paid_through).toBe(addDays(addMonths(today, 1), -1));
  });
});

describe("renewals, lateness and the kill switch", () => {
  it("T−7: renewal invoice for the next month, emailed once", async () => {
    const pt = addDays(today, 7);
    const b = await brand({ status: "active", paidThrough: pt });
    await billingRun(env, new Date());
    await billingRun(env, new Date());
    const invs = await env.DB.prepare("SELECT period_start, period_end, due_date FROM invoices WHERE account_id = ?").bind(b.id).all();
    expect(invs.results).toEqual([{ period_start: addDays(pt, 1), period_end: addDays(addMonths(addDays(pt, 1), 1), -1), due_date: pt }]);
    expect((await outbox(b.email)).filter((s) => s.startsWith("Invoice "))).toHaveLength(1);
  });

  it("T+1 past due (still on, reminder); T+6 suspended (off, alert); paying moves paid_through from the OLD date", async () => {
    const b = await brand({ status: "active", paidThrough: addDays(today, -1) });
    await billingRun(env, new Date());
    expect(await status(b.id)).toBe("past_due");
    expect(await enabled(b)).toBe(true);
    expect((await outbox(b.email)).some((s) => /is 1 day late/.test(s))).toBe(true);

    const oldPt = addDays(today, -6);
    await env.DB.prepare("UPDATE accounts SET paid_through = ? WHERE id = ?").bind(oldPt, b.id).run();
    await billingRun(env, new Date());
    expect(await status(b.id)).toBe("suspended");
    expect(await enabled(b)).toBe(false);
    expect(await outbox(b.email)).toContain("Garrab try-on is switched off");
    const al = await env.DB.prepare("SELECT kind FROM alerts WHERE account_id = ? AND kind = 'kill_switch'").bind(b.id).first();
    expect(al).toEqual({ kind: "kill_switch" });

    // Every layer refuses: config off, and a ctx token issued earlier no longer works for AI calls.
    const inv = (await env.DB.prepare("SELECT id, total FROM invoices WHERE account_id = ? AND status = 'open' AND kind = 'plan'").bind(b.id).first<{ id: string; total: number }>())!;
    await applyPayment(env, { invoiceId: inv.id, provider: "manual", txnId: `m-${uniq()}`, amount: inv.total, method: "instapay", actor: "admin:test" });
    expect(await status(b.id)).toBe("active");
    expect(await enabled(b)).toBe(true);
    expect((await accountFacts(env, b.id))!.paid_through).toBe(addDays(addMonths(addDays(oldPt, 1), 1), -1)); // from the old date, not today
  });

  it("30+ days switched off → archived", async () => {
    const b = await brand({ status: "suspended", paidThrough: addDays(today, -40) });
    await billingRun(env, new Date());
    expect(await status(b.id)).toBe("archived");
  });

  it("an 'I've paid' claim holds the switch-off for 48 h; 'Not received' ends the hold", async () => {
    const b = await brand({ status: "past_due", paidThrough: addDays(today, -6) });
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    await claim(inv.pay_token);
    await billingRun(env, new Date());
    expect(await status(b.id)).toBe("past_due"); // held
    await billingRun(env, new Date(Date.now() + 49 * 3_600_000));
    expect(await status(b.id)).toBe("suspended"); // the hold ran out

    const b2 = await brand({ status: "past_due", paidThrough: addDays(today, -6) });
    const inv2 = await ensurePlanInvoice(env, (await accountFacts(env, b2.id))!, new Date());
    await claim(inv2.pay_token);
    const c2 = (await env.DB.prepare("SELECT id FROM payment_claims WHERE invoice_id = ?").bind(inv2.id).first<{ id: string }>())!;
    await telegramPress(c2.id, "r");
    expect(await status(b2.id)).toBe("suspended");
    expect((await outbox(b2.email)).some((s) => s.startsWith("We couldn't find your transfer"))).toBe(true);
  });

  it("Telegram webhook: wrong secret, wrong chat or forged button does nothing", async () => {
    const b = await brand({ status: "past_due", paidThrough: addDays(today, -2) });
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    await claim(inv.pay_token);
    const c = (await env.DB.prepare("SELECT id FROM payment_claims WHERE invoice_id = ?").bind(inv.id).first<{ id: string }>())!;
    expect((await telegramPress(c.id, "a", { secret: "wrong" })).status).toBe(401);
    await telegramPress(c.id, "a", { from: 999 });
    await telegramPress(c.id, "a", { data: `pc:${c.id}:a:AAAAAAAAAAAA` });
    expect((await env.DB.prepare("SELECT status FROM payment_claims WHERE id = ?").bind(c.id).first<{ status: string }>())!.status).toBe("pending");
    const sig = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'webhook_signature'").first<{ n: number }>();
    expect(sig!.n).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- admin

describe("admin: kill, restore, manual payments, global switch, privacy gate", () => {
  const post = (path: string, body: unknown) => exports.default.fetch(`https://api.test/admin-api${path}`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });

  it("Kill needs a reason, switches off now, and nothing automatic lifts it; Restore follows the ledger", async () => {
    const b = await brand({ status: "active", paidThrough: addDays(today, 20) });
    expect((await post(`/accounts/${b.id}/kill`, { reason: "" })).status).toBe(400);
    expect((await post(`/accounts/${b.id}/kill`, { reason: "chargeback dispute" })).status).toBe(200);
    expect(await status(b.id)).toBe("suspended");
    expect(await enabled(b)).toBe(false);
    await billingRun(env, new Date());
    expect(await status(b.id)).toBe("suspended"); // the billing run leaves a kill alone
    expect((await post(`/accounts/${b.id}/restore`, { reason: "resolved" })).status).toBe(200);
    expect(await status(b.id)).toBe("active");
    const audit = await env.DB.prepare("SELECT reason FROM audit_log WHERE account_id = ? AND action IN ('status','restore') ORDER BY created_at").bind(b.id).all<{ reason: string }>();
    expect(audit.results.map((r) => r.reason)).toEqual(expect.arrayContaining(["Kill: chargeback dispute", "resolved"]));
  });

  it("manual payment is idempotent per key", async () => {
    const b = await brand({ status: "past_due", paidThrough: addDays(today, -2) });
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    const key = `k-${uniq()}`;
    expect((await post(`/invoices/${inv.id}/mark-paid`, { method: "bank_transfer", reference: "CIB 9981", key })).status).toBe(200);
    expect((await post(`/invoices/${inv.id}/mark-paid`, { method: "bank_transfer", reference: "CIB 9981", key })).status).toBe(200);
    const n2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE account_id = ?").bind(b.id).first<{ n: number }>();
    expect(n2!.n).toBe(1);
    expect(await status(b.id)).toBe("active");
  });

  it("global emergency switch turns every brand off and on", async () => {
    const b = await brand({ status: "active", paidThrough: addDays(today, 20) });
    await post("/global-kill", { on: true, reason: "provider incident" });
    expect(await enabled(b)).toBe(false);
    await post("/global-kill", { on: false, reason: "resolved" });
    expect(await enabled(b)).toBe(true);
  });

  it("'not saved on our systems' needs a recent PASS delete report", async () => {
    expect((await post("/privacy-claim", { on: true })).status).toBe(400);
    expect((await post("/privacy-claim", { on: true, report: { result: "FAIL", finishedAt: new Date().toISOString(), deleteStatus: 204, urlsChecked: 2, after: [404, 404] } })).status).toBe(400);
    expect((await post("/privacy-claim", { on: true, report: { result: "PASS", finishedAt: "2020-01-01T00:00:00Z", deleteStatus: 204, urlsChecked: 2, after: [404, 404] } })).status).toBe(400);
    expect((await post("/privacy-claim", { on: true, report: { result: "PASS", finishedAt: new Date().toISOString(), deleteStatus: 204, urlsChecked: 2, after: [404, 403] } })).status).toBe(200);
    const s = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'privacy_claim_verified'").first<{ value_json: string }>();
    expect(s!.value_json).toBe("true");
  });

  it("dashboard reports MRR and per-client margin once the FX rate is set", async () => {
    await post("/settings", { egpPerUsd: 50 });
    const b = await brand({ status: "active", paidThrough: addDays(today, 20) });
    const inv = await createInvoice(env, (await accountFacts(env, b.id))!, { kind: "pack", periodStart: null, dueDate: today });
    await applyPayment(env, { invoiceId: inv.id, provider: "manual", txnId: `m-${uniq()}`, amount: inv.total, method: "cash", actor: "admin:test" });
    await env.DB.prepare("INSERT INTO usage_events (id, account_id, kind, provider, ok, cost_micro_usd) VALUES (?, ?, 'tryon', 'genlook', 1, 2000000)").bind(ulid(), b.id).run();
    const d = (await (await exports.default.fetch("https://api.test/admin-api/dashboard", { headers: ADMIN })).json()) as { mrr: number; clients: { id: string; revenue30: number; costUsd30: number; margin30: number }[] };
    expect(d.mrr).toBeGreaterThanOrEqual(500_000);
    const row = d.clients.find((x) => x.id === b.id)!;
    expect(row).toMatchObject({ revenue30: 80_000, costUsd30: 2, margin30: 80_000 - 2 * 50 * 100 });
  });
});

// ---------------------------------------------------------------- portal billing

describe("portal billing: packs, cancel, usage warnings", () => {
  async function login(email: string): Promise<string> {
    const u = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!;
    const token = "A".repeat(20) + uniq().padEnd(20, "B").slice(0, 20);
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").bind(ulid(), u.id, await sha256Hex(token), "2099-01-01T00:00:00Z").run();
    return `__Host-garrab_s=${token}`;
  }
  const portal = (path: string, cookie: string, body?: unknown) =>
    exports.default.fetch(`https://api.test/portal-api${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, origin: APP, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("at 100% previews pause; an extra pack, once paid, adds 100 and they resume (never on credit)", async () => {
    const b = await brand({ status: "active", paidThrough: addDays(today, 20) });
    const cycle = addMonths(addDays(addDays(today, 20), 1), -1);
    await env.DB.prepare("INSERT INTO cycle_usage (account_id, cycle_start, included, used) VALUES (?, ?, 250, 250)").bind(b.id, cycle).run();
    const cookie = await login(b.email);
    const packRes = (await (await portal("/billing/pack", cookie, {})).json()) as { payUrl: string };
    const token = packRes.payUrl.split("/pay/")[1]!;
    const inv = (await env.DB.prepare("SELECT id, total, kind FROM invoices WHERE pay_token = ?").bind(token).first<{ id: string; total: number; kind: string }>())!;
    expect(inv.kind).toBe("pack");
    const u0 = await env.DB.prepare("SELECT extra FROM cycle_usage WHERE account_id = ?").bind(b.id).first<{ extra: number }>();
    expect(u0!.extra).toBe(0); // nothing until paid
    await applyPayment(env, { invoiceId: inv.id, provider: "manual", txnId: `m-${uniq()}`, amount: inv.total, method: "instapay", actor: "admin:test" });
    const u1 = await env.DB.prepare("SELECT extra FROM cycle_usage WHERE account_id = ? AND cycle_start = ?").bind(b.id, cycle).first<{ extra: number }>();
    expect(u1!.extra).toBe(100);
  });

  it("cancel at period end: open renewal voided; switched off after the paid month", async () => {
    const pt = addDays(today, 5);
    const b = await brand({ status: "active", paidThrough: pt });
    await billingRun(env, new Date()); // renewal invoice (T−7)
    const cookie = await login(b.email);
    expect((await (await portal("/billing/cancel", cookie, {})).json()) as { until: string }).toMatchObject({ until: pt });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE account_id = ? AND status = 'open'").bind(b.id).first<{ n: number }>())!.n).toBe(0);
    await billingRun(env, new Date(Date.now() + 6 * 86_400_000));
    expect(await status(b.id)).toBe("cancelled");
    expect(await enabled(b)).toBe(false);
  });

  it("warns at 80% and 100%, once each", async () => {
    const b = await brand({ status: "active", paidThrough: addDays(today, 20) });
    const cycle = addMonths(addDays(addDays(today, 20), 1), -1);
    await env.DB.prepare("INSERT INTO cycle_usage (account_id, cycle_start, included, used) VALUES (?, ?, 250, 198)").bind(b.id, cycle).run();
    const ctx = ((await (await exports.default.fetch(`https://api.test/v1/config?key=${b.key}`, { headers: { origin: b.origin } })).json()) as { ctx: string }).ctx;
    const tryOn = async () => {
      const form = new FormData();
      form.set("ctx", ctx);
      form.set("product", b.productId);
      form.set("turnstile", "x");
      form.set("photo", new Blob([fakeJpeg()], { type: "image/jpeg" }), "p.jpg");
      const r = await exports.default.fetch("https://api.test/v1/tryon", { method: "POST", body: form, headers: { origin: APP, "cf-connecting-ip": `10.9.${n % 250}.${n++ % 250}` } });
      await r.arrayBuffer();
      await new Promise((x) => setTimeout(x, 30));
      return r.status;
    };
    expect(await tryOn()).toBe(200); // 199
    expect(await tryOn()).toBe(200); // 200 = 80%
    expect(await tryOn()).toBe(200);
    await env.DB.prepare("UPDATE cycle_usage SET used = 249 WHERE account_id = ?").bind(b.id).run();
    expect(await tryOn()).toBe(200); // 250 = 100%
    expect(await tryOn()).toBe(402); // paused, no credit
    const mails = await outbox(b.email);
    expect(mails.filter((s) => s.startsWith("You've used 80%"))).toHaveLength(1);
    expect(mails.filter((s) => s.startsWith("Previews paused"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- Kashier (ready for later) and the digest

describe("Kashier webhook signature", () => {
  it("matches the worked example in Kashier's docs", async () => {
    const data = {
      amount: 1,
      channel: "online | e-commerce",
      currency: "EGP",
      kashierOrderId: "9ad06b17-755b-4e21-9774-aff3e2726ac9",
      merchantOrderId: "1653481557813",
      method: "card",
      orderReference: "TEST-ORD-38855",
      status: "SUCCESS",
      transactionId: "TX-249893963",
      transactionResponseCode: "00",
      signatureKeys: ["amount", "channel", "currency", "kashierOrderId", "merchantOrderId", "method", "orderReference", "status", "transactionId", "transactionResponseCode"],
    };
    expect(kashierSignaturePayload(data)).toBe(
      "amount=1&channel=online%20%7C%20e-commerce&currency=EGP&kashierOrderId=9ad06b17-755b-4e21-9774-aff3e2726ac9&merchantOrderId=1653481557813&method=card&orderReference=TEST-ORD-38855&status=SUCCESS&transactionId=TX-249893963&transactionResponseCode=00",
    );
    expect(await verifyKashierSignature(data, "9610477b2255b2a8ef84fd89adfaa5f1305ff9c20324205851890f1ea03109f4", "11111")).toBe(true);
    expect(await verifyKashierSignature({ ...data, amount: 2 }, "9610477b2255b2a8ef84fd89adfaa5f1305ff9c20324205851890f1ea03109f4", "11111")).toBe(false);
  });
});

describe("daily digest", () => {
  it("lists claims waiting, due soon, past due and switch-offs; quiet days say so", async () => {
    const b = await brand({ status: "past_due", paidThrough: addDays(today, -2) });
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    await claim(inv.pay_token, "IPN-DIGEST");
    await reconcileAccount(env, b.id, new Date());
    const d = await buildDigest(env, new Date());
    const titles = d.sections.map((s) => s.title.split(" (")[0]);
    expect(titles).toEqual(expect.arrayContaining(["Payments waiting for your confirmation", "Past due"]));
    expect(d.sections.flatMap((s) => s.lines.map((l) => l.text)).some((t) => t.includes("IPN-DIGEST"))).toBe(true);
  });
});
