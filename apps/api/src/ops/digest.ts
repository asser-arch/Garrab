/**
 * The 08:30 (Cairo) daily digest for Asser, by email and Telegram (brief §8):
 * new leads, stuck onboarding (with one-click reminders), payments due in 3 days, past due,
 * switched off today, payments waiting for confirmation, cost anomalies, errors.
 * A 2-minute read. Sections with nothing in them are left out.
 */
import { CAPS } from "@garrab/shared/plans";
import type { Env } from "../env.js";
import { getSetting } from "../lib/db.js";
import { sendOnce, type EmailMessage } from "../lib/email.js";
import { sendTelegram } from "../lib/telegram.js";
import { cairoDay } from "../lib/time.js";
import { addDays } from "../billing/dates.js";
import { STEP_LABEL, type Step } from "../onboarding/machine.js";

interface Section {
  title: string;
  lines: { text: string; href?: string | undefined }[];
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function buildDigest(env: Env, now: Date): Promise<{ sections: Section[]; quiet: boolean }> {
  const today = cairoDay(now);
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const admin = env.ADMIN_ORIGIN ?? "";
  const sections: Section[] = [];
  const add = (title: string, lines: Section["lines"]): void => {
    if (lines.length) sections.push({ title, lines });
  };

  const leads = await env.DB.prepare("SELECT brand_name, platform, plan FROM leads WHERE created_at >= ? ORDER BY created_at").bind(since).all<{ brand_name: string; platform: string; plan: string }>();
  add("New leads", leads.results.map((l) => ({ text: `${l.brand_name} (${l.platform}, ${l.plan})` })));

  const stuck = await env.DB.prepare(
    "SELECT id, name, onboarding_step, onboarding_step_at FROM accounts WHERE status = 'onboarding' AND onboarding_step_at < ? ORDER BY onboarding_step_at",
  )
    .bind(new Date(now.getTime() - 48 * 3_600_000).toISOString())
    .all<{ id: string; name: string; onboarding_step: Step; onboarding_step_at: string }>();
  add(
    "Stuck in onboarding (tap to open and send a reminder)",
    stuck.results.map((a) => ({
      text: `${a.name}: ${STEP_LABEL[a.onboarding_step]} for ${Math.round((now.getTime() - Date.parse(a.onboarding_step_at)) / 3_600_000)} h`,
      href: `${admin}/#account=${a.id}`,
    })),
  );

  const claims = await env.DB.prepare(
    `SELECT a.name, i.number, i.total, c.reference FROM payment_claims c JOIN invoices i ON i.id = c.invoice_id JOIN accounts a ON a.id = c.account_id
      WHERE c.status = 'pending' ORDER BY c.created_at`,
  ).all<{ name: string; number: string; total: number; reference: string }>();
  add("Payments waiting for your confirmation (buttons are in Telegram)", claims.results.map((c) => ({ text: `${c.name}: ${c.total / 100} EGP, ${c.number}, ref ${c.reference}` })));

  const due = await env.DB.prepare(
    `SELECT a.name, i.number, i.total, i.due_date FROM invoices i JOIN accounts a ON a.id = i.account_id
      WHERE i.status = 'open' AND i.due_date BETWEEN ? AND ? ORDER BY i.due_date`,
  )
    .bind(today, addDays(today, 3))
    .all<{ name: string; number: string; total: number; due_date: string }>();
  add("Payments due in the next 3 days", due.results.map((d) => ({ text: `${d.name}: ${d.total / 100} EGP due ${d.due_date} (${d.number})` })));

  const pastDue = await env.DB.prepare("SELECT name, paid_through FROM accounts WHERE status = 'past_due' ORDER BY paid_through").all<{ name: string; paid_through: string | null }>();
  add("Past due (still running, in grace)", pastDue.results.map((a) => ({ text: `${a.name}: was due ${a.paid_through ?? "?"}` })));

  const off = await env.DB.prepare(
    `SELECT a.name, l.to_status, l.reason FROM audit_log l JOIN accounts a ON a.id = l.account_id
      WHERE l.action = 'status' AND l.to_status IN ('suspended','expired','archived','paused') AND l.created_at >= ? ORDER BY l.created_at`,
  )
    .bind(since)
    .all<{ name: string; to_status: string; reason: string | null }>();
  add("Switched off in the last 24 h", off.results.map((o) => ({ text: `${o.name}: ${o.to_status} (${o.reason ?? ""})` })));

  // Cost anomalies: global spend near the cap, or an account spending 3× its 7-day average.
  const cap = await getSetting<number>(env, "global_daily_cap_usd", CAPS.globalDailyUsd);
  const yesterday = addDays(today, -1);
  const spend = await env.DB.prepare("SELECT count FROM daily_counters WHERE account_id = '*' AND day = ? AND metric = 'spend_micro_usd'").bind(yesterday).first<{ count: number }>();
  const anomalies: Section["lines"] = [];
  if ((spend?.count ?? 0) >= cap * 0.8 * 1e6) anomalies.push({ text: `AI spend yesterday ${((spend?.count ?? 0) / 1e6).toFixed(2)} USD, over 80% of the ${cap} USD cap` });
  const spikes = await env.DB.prepare(
    `SELECT a.name, d.count AS y, (SELECT AVG(count) FROM daily_counters x WHERE x.account_id = d.account_id AND x.metric = 'spend_micro_usd' AND x.day < ? AND x.day >= ?) AS avg7
       FROM daily_counters d JOIN accounts a ON a.id = d.account_id WHERE d.day = ? AND d.metric = 'spend_micro_usd'`,
  )
    .bind(yesterday, addDays(today, -8), yesterday)
    .all<{ name: string; y: number; avg7: number | null }>();
  for (const s of spikes.results) if (s.avg7 && s.y > 3 * s.avg7 && s.y > 1_000_000) anomalies.push({ text: `${s.name}: ${(s.y / 1e6).toFixed(2)} USD yesterday vs ${(s.avg7 / 1e6).toFixed(2)} USD average` });
  add("Cost anomalies", anomalies);

  const errors: Section["lines"] = [];
  const failedJobs = await env.DB.prepare("SELECT job, error FROM cron_runs WHERE ok = 0 AND started_at >= ?").bind(since).all<{ job: string; error: string | null }>();
  for (const j of failedJobs.results) errors.push({ text: `Job ${j.job} failed: ${j.error ?? ""}` });
  const prov = await env.DB.prepare("SELECT provider, SUM(ok) AS ok, COUNT(*) AS n FROM usage_events WHERE created_at >= ? GROUP BY provider").bind(since).all<{ provider: string; ok: number; n: number }>();
  for (const p of prov.results) if (p.n >= 10 && p.ok / p.n < 0.8) errors.push({ text: `${p.provider}: ${p.n - p.ok} of ${p.n} AI calls failed` });
  const openAlerts = await env.DB.prepare("SELECT COUNT(*) AS c FROM alerts WHERE resolved_at IS NULL AND created_at >= ?").bind(since).first<{ c: number }>();
  if ((openAlerts?.c ?? 0) > 0) errors.push({ text: `${openAlerts?.c} alerts in the last 24 h`, href: admin ? `${admin}/` : undefined });
  add("Errors", errors);

  return { sections, quiet: sections.length === 0 };
}

export function renderDigest(day: string, d: { sections: Section[]; quiet: boolean }, to: string): EmailMessage {
  const html = `<!doctype html><html><body style="font-family:Cairo,Arial,sans-serif;background:#F4F2EB;color:#0F1A13;margin:0">
<div style="max-width:560px;margin:0 auto;padding:24px"><h1 style="font-weight:400;font-size:22px">Garrab digest <span style="color:#8A8B84">${esc(day)}</span></h1>
${d.quiet ? "<p>All quiet. Nothing needs you today.</p>" : d.sections
    .map(
      (s) => `<div style="background:#FCFBF8;border:1px solid #DDD6C9;border-radius:20px;padding:16px 20px;margin-bottom:12px"><h2 style="font-size:15px;margin:0 0 8px">${esc(s.title)}</h2><ul style="margin:0;padding-left:18px">${s.lines
        .map((l) => `<li>${l.href ? `<a href="${esc(l.href)}">${esc(l.text)}</a>` : esc(l.text)}</li>`)
        .join("")}</ul></div>`,
    )
    .join("")}</div></body></html>`;
  const text = [`Garrab digest ${day}`, ...(d.quiet ? ["All quiet."] : d.sections.flatMap((s) => ["", s.title, ...s.lines.map((l) => `- ${l.text}`)]))].join("\n");
  return { to, subject: d.quiet ? `Garrab ${day}: all quiet` : `Garrab ${day}: ${d.sections.map((s) => s.title.split(" (")[0]).join(", ")}`, html, text };
}

export async function sendDigest(env: Env, now: Date): Promise<void> {
  // One digest a day, from live only: staging's test brands would be noise (its alerts still arrive, labelled).
  if (env.ENVIRONMENT === "staging") return;
  const day = cairoDay(now);
  const d = await buildDigest(env, now);
  if (env.OPERATOR_EMAIL) await sendOnce(env, { accountId: null, template: "digest", dedupeKey: `digest:${day}`, msg: renderDigest(day, d, env.OPERATOR_EMAIL) });
  const tg = d.quiet ? `☀️ Garrab ${day}: all quiet.` : [`☀️ Garrab ${day}`, ...d.sections.map((s) => `• ${s.title.split(" (")[0]}: ${s.lines.length}`)].join("\n");
  await sendTelegram(env, tg);
}
