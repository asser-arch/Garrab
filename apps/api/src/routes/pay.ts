/**
 * Public pay page API. The invoice's pay_token is a capability (like a hosted invoice link):
 * it shows that one invoice and lets the payer send an "I've paid" notice. Nothing else.
 * Reached same-origin through the site Worker (/pay-api/* → /v1/pay/*).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env.js";
import { type InvoiceRow, pdfUrl } from "../billing/ledger.js";
import { createClaim } from "../billing/instapay.js";
import { invoicePdf } from "../billing/pdf.js";

export const pay = new Hono<{ Bindings: Env }>();

async function byToken(env: Env, token: string): Promise<(InvoiceRow & { brand: string; brand_email: string | null }) | null> {
  if (!/^[A-Za-z0-9]{32}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT i.*, a.name AS brand, (SELECT email FROM users u WHERE u.account_id = a.id ORDER BY created_at LIMIT 1) AS brand_email
       FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE i.pay_token = ?`,
  )
    .bind(token)
    .first();
}

pay.get("/pay/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  const inv = await byToken(c.env, c.req.param("token"));
  if (!inv) return c.json({ error: "not_found" }, 404);
  const claim = await c.env.DB.prepare("SELECT status, created_at FROM payment_claims WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(inv.id)
    .first<{ status: string; created_at: string }>();
  return c.json({
    brand: inv.brand,
    number: inv.number,
    kind: inv.kind,
    lines: JSON.parse(inv.lines_json),
    vatRateBp: inv.vat_rate_bp,
    vat: inv.vat,
    total: inv.total,
    status: inv.status,
    dueDate: inv.due_date,
    paidAt: inv.paid_at,
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    claim,
    pdf: pdfUrl(c.env, inv.pay_token),
    instapay: inv.status === "open" ? { address: c.env.INSTAPAY_IPA ?? null, accountName: c.env.INSTAPAY_ACCOUNT_NAME ?? null, link: c.env.INSTAPAY_LINK ?? null } : null,
  });
});

pay.post("/pay/:token/claim", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("origin") !== c.env.APP_ORIGIN) return c.json({ error: "forbidden_origin" }, 403);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown"; // in-memory rate-limit key only
  if (c.env.RL_CONFIG_IP && !(await c.env.RL_CONFIG_IP.limit({ key: `claim:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);
  const body = z
    .object({ reference: z.string().trim().min(4).max(64), payerName: z.string().trim().max(80).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  const inv = await byToken(c.env, c.req.param("token"));
  if (!inv) return c.json({ error: "not_found" }, 404);
  if (inv.status !== "open") return c.json({ error: "not_open", status: inv.status }, 409);
  const r = await createClaim(c.env, inv, body.data.reference, body.data.payerName ?? null);
  return c.json({ ok: true, created: r.created });
});

pay.get("/pay/:token/pdf", async (c) => {
  const inv = await byToken(c.env, c.req.param("token"));
  if (!inv) return c.json({ error: "not_found" }, 404);
  const bytes = await invoicePdf(inv, { name: inv.brand, email: inv.brand_email }, {
    name: "Garrab",
    contact: c.env.BILLING_CONTACT ?? "",
    instapay: c.env.INSTAPAY_IPA ?? null,
  });
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${inv.number}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
});
