/**
 * The ledger (brief §7): `accounts.paid_through` + `accounts.status` decide everything.
 * Providers (direct InstaPay confirmed in Telegram, Manual, later Kashier) only CONFIRM payments,
 * through `applyPayment()`, which is idempotent per (provider, provider_txn_id).
 */
import { BILLING, EXTRA_PACK, PLANS, type PlanId } from "@garrab/shared/plans";
import type { AccountStatus } from "@garrab/shared";
import { emails } from "../emails.js";
import type { Env } from "../env.js";
import { randomToken, ulid } from "../lib/crypto.js";
import { invalidateStatus } from "../lib/db.js";
import { sendOnce } from "../lib/email.js";
import { log } from "../lib/log.js";
import { alert, transitionStatus } from "../lib/ops.js";
import { cairoDay } from "../lib/time.js";
import { cycleStartOf } from "../lib/metering.js";
import { addDays, daysBetween, periodFrom } from "./dates.js";
import { canTransition, naturalStatus } from "./status.js";

export const payUrl = (env: Env, token: string): string => `${env.APP_ORIGIN}/pay/${token}`;
export const pdfUrl = (env: Env, token: string): string => `${env.APP_ORIGIN}/pay/${token}/invoice.pdf`;

export interface InvoiceRow {
  id: string;
  account_id: string;
  number: string;
  kind: "plan" | "pack";
  plan_id: PlanId | null;
  period_start: string | null;
  period_end: string | null;
  pack_previews: number | null;
  lines_json: string;
  subtotal: number;
  vat_rate_bp: number;
  vat: number;
  total: number;
  status: "open" | "paid" | "void";
  due_date: string;
  pay_token: string;
  paid_at: string | null;
  created_at: string;
}

interface AccFacts {
  id: string;
  name: string;
  status: AccountStatus;
  plan_id: PlanId;
  target_plan_id: PlanId | null;
  paid_through: string | null;
  pilot_started_at: string | null;
  pilot_ends_at: string | null;
  cancel_at_period_end: number;
  manual_hold: number;
  setup_fee_due: number;
  onboarding_step: string;
  cycle_start: string | null;
}

export async function accountFacts(env: Env, id: string): Promise<AccFacts | null> {
  return env.DB.prepare(
    `SELECT id, name, status, plan_id, target_plan_id, paid_through, pilot_started_at, pilot_ends_at, cancel_at_period_end,
            manual_hold, setup_fee_due, onboarding_step, cycle_start FROM accounts WHERE id = ?`,
  )
    .bind(id)
    .first<AccFacts>();
}

async function ownerEmail(env: Env, accountId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(accountId).first<{ email: string }>())?.email ?? null;
}

/** The plan a renewal is billed at: the target plan for pilots, otherwise the current paid plan. */
export function billingPlan(a: Pick<AccFacts, "plan_id" | "target_plan_id">): Exclude<PlanId, "pilot"> {
  const p = a.plan_id;
  if (p === "starter" || p === "growth") return p;
  return a.target_plan_id === "growth" ? "growth" : "starter";
}

// ---------------------------------------------------------------------------- invoices

export async function createInvoice(
  env: Env,
  a: AccFacts,
  opts: { kind: "plan" | "pack"; periodStart: string | null; dueDate: string },
): Promise<InvoiceRow> {
  const id = ulid();
  const plan = billingPlan(a);
  const lines: { label: string; amount: number }[] = [];
  if (opts.kind === "plan") {
    const period = opts.periodStart ? periodFrom(opts.periodStart) : null;
    lines.push({ label: `${PLANS[plan].name} plan, one month${period ? ` (${period.start} to ${period.end})` : ""}`, amount: PLANS[plan].monthlyPrice });
  } else {
    lines.push({ label: `Extra previews (${EXTRA_PACK.previews})`, amount: EXTRA_PACK.price });
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const vat = Math.round((subtotal * BILLING.vatRateBp) / 10_000);
  const year = Number(opts.dueDate.slice(0, 4));
  const period = opts.kind === "plan" && opts.periodStart ? periodFrom(opts.periodStart) : null;
  // One transaction: bump the year's counter and use it, so numbers are sequential with no gaps.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO invoice_counter (year, last) VALUES (?, 1) ON CONFLICT(year) DO UPDATE SET last = last + 1").bind(year),
    env.DB.prepare(
      `INSERT INTO invoices (id, account_id, number, kind, plan_id, period_start, period_end, pack_previews, lines_json, subtotal, vat_rate_bp, vat, total, due_date, pay_token)
       VALUES (?, ?, (SELECT ? || '-' || ? || '-' || printf('%04d', last) FROM invoice_counter WHERE year = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      a.id,
      BILLING.invoicePrefix,
      String(year), // text, so the number reads GRB-2026-0001 (a numeric bind would print 2026.0)
      year,
      opts.kind,
      opts.kind === "plan" ? plan : null,
      period?.start ?? null,
      period?.end ?? null,
      opts.kind === "pack" ? EXTRA_PACK.previews : null,
      JSON.stringify(lines),
      subtotal,
      BILLING.vatRateBp,
      vat,
      subtotal + vat,
      opts.dueDate,
      randomToken(32),
    ),
  ]);
  const inv = (await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first<InvoiceRow>())!;
  log("invoice_created", { account: a.id, kind: opts.kind });
  return inv;
}

export async function openPlanInvoice(env: Env, accountId: string): Promise<InvoiceRow | null> {
  return env.DB.prepare("SELECT * FROM invoices WHERE account_id = ? AND kind = 'plan' AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .bind(accountId)
    .first<InvoiceRow>();
}

/**
 * The invoice for the next month: renewal (period after paid_through, due on paid_through) or,
 * for pilots and lapsed accounts, the first month (period set when paid, due at pilot end / today).
 * Idempotent: returns the open plan invoice if there is one.
 */
export async function ensurePlanInvoice(env: Env, a: AccFacts, now: Date): Promise<InvoiceRow> {
  const open = await openPlanInvoice(env, a.id);
  if (open) return open;
  const today = cairoDay(now);
  const renewal = a.paid_through && !["expired", "archived"].includes(a.status);
  const due = renewal ? a.paid_through! : a.pilot_ends_at && a.status === "pilot" ? cairoDay(new Date(a.pilot_ends_at)) : today;
  return createInvoice(env, a, { kind: "plan", periodStart: renewal ? addDays(a.paid_through!, 1) : null, dueDate: due });
}

// ---------------------------------------------------------------------------- status

/** Move the account to where the ledger says it should be. Sends the matching notice once. */
export async function reconcileAccount(env: Env, accountId: string, now: Date, actor = "cron"): Promise<AccountStatus | null> {
  const a = await accountFacts(env, accountId);
  if (!a) return null;
  if (a.manual_hold || a.status === "onboarding") return a.status;
  const hold = await env.DB.prepare("SELECT 1 AS x FROM payment_claims WHERE account_id = ? AND status = 'pending' AND hold_until > ? LIMIT 1")
    .bind(a.id, now.toISOString())
    .first();
  const target = naturalStatus({ ...a, claimHold: !!hold }, cairoDay(now), now);
  if (target === a.status) return a.status;

  const from = a.status;
  const reason =
    target === "active"
      ? "Paid"
      : target === "past_due"
        ? "Payment due date passed"
        : target === "suspended"
          ? `Unpaid ${BILLING.graceDays}+ days after the due date`
          : target === "expired"
            ? "Pilot ended without payment"
            : target === "archived"
              ? `Switched off for ${BILLING.archiveAfterDays}+ days`
              : target === "cancelled"
                ? "Cancelled at period end"
                : "Ledger";
  // Long gaps (e.g. after an outage) may need two steps: active → suspended → archived.
  if (!canTransition(from, target) && canTransition(from, "suspended")) await transitionStatus(env, a, "suspended", actor, reason);
  await transitionStatus(env, a, target, actor, reason);

  const to = await ownerEmail(env, a.id);
  if (target === "suspended" && to) {
    const inv = await ensurePlanInvoice(env, a, now);
    await sendOnce(env, { accountId: a.id, template: "suspended", dedupeKey: `suspended:${a.id}:${a.paid_through}`, msg: emails.suspended(to, payUrl(env, inv.pay_token)) });
  }
  if (target === "expired") {
    await env.DB.prepare("UPDATE accounts SET onboarding_step = 'expired', onboarding_step_at = ? WHERE id = ?").bind(now.toISOString(), a.id).run();
    if (to) {
      const inv = await ensurePlanInvoice(env, { ...a, status: "expired" }, now);
      await sendOnce(env, { accountId: a.id, template: "expired", dedupeKey: `expired:${a.id}`, msg: emails.expired(to, payUrl(env, inv.pay_token)) });
    }
  }
  return target;
}

// ---------------------------------------------------------------------------- payments

export interface PaymentInput {
  invoiceId: string;
  provider: "instapay_direct" | "manual" | "kashier";
  txnId: string;
  amount: number;
  method: string;
  reference?: string | null;
  note?: string | null;
  actor: string;
}

/**
 * Record a confirmed payment and apply it. Idempotent per (provider, txnId): a replayed webhook
 * or a double tap in Telegram changes nothing the second time.
 *   plan → paid_through + 1 month from the previous paid_through (from today when converting a
 *          pilot or reactivating an expired/archived account), status back to where the ledger says.
 *   pack → +100 previews in the current cycle.
 */
export async function applyPayment(env: Env, p: PaymentInput, now = new Date()): Promise<{ applied: boolean; reason?: string }> {
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(p.invoiceId).first<InvoiceRow>();
  if (!inv) return { applied: false, reason: "no_invoice" };
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO payments (id, invoice_id, account_id, provider, provider_txn_id, amount, method, reference, note, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(ulid(), inv.id, inv.account_id, p.provider, p.txnId, p.amount, p.method, p.reference ?? null, p.note ?? null, p.actor)
    .run();
  if (ins.meta.changes !== 1) return { applied: false, reason: "duplicate" };

  if (p.amount < inv.total) {
    await alert(env, "payment_mismatch", inv.account_id, `Payment of ${p.amount / 100} EGP is less than invoice ${inv.number} (${inv.total / 100} EGP). Not applied; check it.`);
    return { applied: false, reason: "amount_short" };
  }
  const paidAt = now.toISOString();
  const cas = await env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'open'").bind(paidAt, inv.id).run();
  if (cas.meta.changes !== 1) {
    await alert(env, "payment_duplicate", inv.account_id, `A second payment arrived for invoice ${inv.number}, which is already ${inv.status}. Refund or credit it by hand.`);
    return { applied: false, reason: "invoice_not_open" };
  }

  const a = (await accountFacts(env, inv.account_id))!;
  const today = cairoDay(now);
  let paidThrough: string | null = null;

  if (inv.kind === "plan") {
    const fresh = !a.paid_through || a.status === "expired" || a.status === "archived";
    const start = fresh ? today : addDays(a.paid_through!, 1);
    const period = periodFrom(start);
    paidThrough = period.end;
    const plan = inv.plan_id ?? billingPlan(a);
    const stmts = [
      env.DB.prepare("UPDATE invoices SET period_start = ?, period_end = ? WHERE id = ?").bind(period.start, period.end, inv.id),
      env.DB.prepare(
        "UPDATE accounts SET paid_through = ?, plan_id = ?, setup_fee_due = 0, cancel_at_period_end = 0, status_version = status_version + 1 WHERE id = ?",
      ).bind(paidThrough, plan, a.id),
    ];
    if (a.onboarding_step === "pilot_live" || a.onboarding_step === "expired") {
      stmts.push(
        env.DB.prepare("UPDATE accounts SET onboarding_step = 'converted', onboarding_step_at = ? WHERE id = ?").bind(paidAt, a.id),
        env.DB.prepare(
          `INSERT INTO onboarding_steps (account_id, step, state, entered_at, done_at, actor) VALUES (?, 'converted', 'done', ?, ?, ?)
           ON CONFLICT(account_id, step) DO UPDATE SET state = 'done', done_at = excluded.done_at`,
        ).bind(a.id, paidAt, paidAt, p.actor),
      );
    }
    await env.DB.batch(stmts);
  } else {
    const cycle = cycleStartOf(a, today);
    const included = PLANS[a.plan_id].includedPreviews;
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO cycle_usage (account_id, cycle_start, included) VALUES (?, ?, ?)").bind(a.id, cycle, included),
      env.DB.prepare("UPDATE cycle_usage SET extra = extra + ?, warned_100 = 0 WHERE account_id = ? AND cycle_start = ?").bind(inv.pack_previews ?? EXTRA_PACK.previews, a.id, cycle),
    ]);
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE payment_claims SET status = 'confirmed', decided_at = ?, decided_by = ? WHERE invoice_id = ? AND status = 'pending'").bind(paidAt, p.actor, inv.id),
    env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, reason, meta_json) VALUES (?, ?, ?, 'payment', ?, ?)").bind(
      ulid(),
      a.id,
      p.actor,
      `${inv.number} paid via ${p.provider}`,
      JSON.stringify({ invoice: inv.number, amount: p.amount, method: p.method, paidThrough }),
    ),
  ]);
  invalidateStatus(a.id);
  await reconcileAccount(env, a.id, now, p.actor);

  const to = await ownerEmail(env, a.id);
  if (to) await sendOnce(env, { accountId: a.id, template: "payment_received", dedupeKey: `paid:${inv.id}`, msg: emails.paymentReceived(to, inv, paidThrough, pdfUrl(env, inv.pay_token)) });
  await alert(env, "payment", a.id, `💰 ${a.name} paid ${inv.number} (${inv.total / 100} EGP via ${p.provider}).${paidThrough ? ` Paid until ${paidThrough}.` : ""}`);
  return { applied: true };
}

// ---------------------------------------------------------------------------- the daily billing run

/** Brief §7 billing cycle: T−7 invoice, reminders at T, T+1, T+3, T+5, status moves, pilot first invoice. */
export async function billingRun(env: Env, now: Date): Promise<void> {
  const today = cairoDay(now);
  const rows = await env.DB.prepare("SELECT id FROM accounts WHERE status != 'onboarding' AND manual_hold = 0 ORDER BY id LIMIT 1000").all<{ id: string }>();
  for (const { id } of rows.results) {
    await reconcileAccount(env, id, now);
    const a = await accountFacts(env, id);
    if (!a) continue;
    const to = await ownerEmail(env, id);

    // New invoice 7 days before the due date (renewals), or 2 days before the pilot ends.
    if ((a.status === "active" || a.status === "past_due") && a.paid_through && !a.cancel_at_period_end && today >= addDays(a.paid_through, -BILLING.invoiceLeadDays)) {
      const inv = await ensurePlanInvoice(env, a, now);
      if (to) await sendOnce(env, { accountId: id, template: "invoice", dedupeKey: `invoice:${inv.id}`, msg: emails.invoice(to, { ...inv, due: inv.due_date, label: (JSON.parse(inv.lines_json) as { label: string }[])[0]!.label }, payUrl(env, inv.pay_token)) });
    }
    if (a.status === "pilot" && !a.cancel_at_period_end && a.pilot_ends_at && now.getTime() >= Date.parse(a.pilot_ends_at) - 2 * 86_400_000) {
      await ensurePlanInvoice(env, a, now); // its link goes out in the day-12 and day-14 pilot emails
    }

    // Reminders on the due date and after it, unless a payment claim is waiting for confirmation.
    const open = await openPlanInvoice(env, id);
    if (open && to && (a.status === "active" || a.status === "past_due")) {
      const late = daysBetween(open.due_date, today);
      const claim = await env.DB.prepare("SELECT 1 AS x FROM payment_claims WHERE invoice_id = ? AND status = 'pending'").bind(open.id).first();
      if (!claim && (BILLING.reminderOffsetsDays as readonly number[]).includes(late)) {
        await sendOnce(env, { accountId: id, template: "reminder", dedupeKey: `reminder:${open.id}:${late}`, msg: emails.reminder(to, { ...open, due: open.due_date }, late, payUrl(env, open.pay_token)) });
      }
    }
  }
}
