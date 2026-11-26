/**
 * Scheduled work. Cloudflare cron fires every 15 minutes (UTC); jobs that belong to a time
 * of day run on the first tick at or after that time in Africa/Cairo, once per Cairo day.
 * Every job is idempotent. Each run is recorded in cron_runs (shown in the admin status line).
 */
import { PILOT, PLANS, TIMINGS } from "@garrab/shared/plans";
import { accountFacts, billingRun, ensurePlanInvoice, monthlyPrice, payUrl, prepaidInvoice, reconcileAccount } from "./billing/ledger.js";
import { pingPendingClaims } from "./billing/instapay.js";
import { emails } from "./emails.js";
import type { Env } from "./env.js";
import type { Job } from "./jobs-types.js";
import { ulid } from "./lib/crypto.js";
import { sendOnce } from "./lib/email.js";
import { log } from "./lib/log.js";
import { alert, transitionStatus } from "./lib/ops.js";
import { cairoClock, cairoDay, nowIso } from "./lib/time.js";
import { buildReport } from "./lib/report.js";
import { reportEmail } from "./reportEmail.js";
import { importForAccount } from "./onboarding/import.js";
import { STEP_LABEL, advance, checkInstall, portalUrl, type Step } from "./onboarding/machine.js";
import { retryBusyProducts, testProduct } from "./onboarding/tests.js";
import { sendDigest } from "./ops/digest.js";
import { checkGoogleBalance } from "./lib/googleBalance.js";
import { tryOnProvider } from "./providers/tryon.js";

type JobFn = (env: Env, now: Date) => Promise<void>;

// ---------------------------------------------------------------------------- every tick

const retryPendingDeletes: JobFn = async (env) => {
  const rows = await env.DB.prepare("SELECT provider_ref FROM pending_deletes ORDER BY created_at LIMIT 50").all<{ provider_ref: string }>();
  const provider = tryOnProvider(env);
  for (const r of rows.results) {
    if (await provider.deleteUserData(r.provider_ref)) {
      await env.DB.prepare("DELETE FROM pending_deletes WHERE provider_ref = ?").bind(r.provider_ref).run();
    } else {
      await env.DB.prepare("UPDATE pending_deletes SET attempts = attempts + 1 WHERE provider_ref = ?").bind(r.provider_ref).run();
    }
  }
};

/** Re-drive every onboarding account: a lost queue message can never stall a brand. */
const onboardingSweep: JobFn = async (env) => {
  const rows = await env.DB.prepare("SELECT id FROM accounts WHERE status = 'onboarding' ORDER BY onboarding_step_at LIMIT 50").all<{ id: string }>();
  for (const r of rows.results) await env.JOBS.send({ t: "advance", a: r.id });
};

// ---------------------------------------------------------------------------- daily (Cairo time)

async function counters(env: Env, accountId: string, fromDay: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare("SELECT metric, SUM(count) AS n FROM daily_counters WHERE account_id = ? AND day >= ? GROUP BY metric")
    .bind(accountId, fromDay)
    .all<{ metric: string; n: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.metric, r.n]));
}

/** Pilot clock (brief §6.7–6.8): day 7 / 12 / 14 emails, then expiry after the grace period. */
export const pilotClock: JobFn = async (env, now) => {
  const rows = await env.DB.prepare(
    "SELECT id, name, slug, status, pilot_started_at, pilot_ends_at, target_plan_id, cycle_start FROM accounts WHERE status = 'pilot' AND pilot_started_at IS NOT NULL",
  ).all<{ id: string; name: string; slug: string; status: string; pilot_started_at: string; pilot_ends_at: string; target_plan_id: "starter" | "growth" | null; cycle_start: string }>();
  for (const a of rows.results) {
    const day = Math.floor((Date.parse(cairoDay(now)) - Date.parse(cairoDay(new Date(a.pilot_started_at)))) / 86_400_000) + 1;
    const user = await env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(a.id).first<{ email: string }>();
    if (!user) continue;
    // The first month's invoice exists from day 12; its pay link goes in the day-12 and day-14 emails.
    const facts = day >= PILOT.emailDays.endingSoon ? await accountFacts(env, a.id) : null;
    const prepaid = await prepaidInvoice(env, a.id); // already paid for the months after the pilot
    const payLink = facts && !prepaid ? payUrl(env, (await ensurePlanInvoice(env, facts, now)).pay_token) : portalUrl(env, "/billing");
    const c = await counters(env, a.id, cairoDay(new Date(a.pilot_started_at)));
    const used = (await env.DB.prepare("SELECT used FROM cycle_usage WHERE account_id = ? AND cycle_start = ?").bind(a.id, a.cycle_start).first<{ used: number }>())?.used ?? 0;
    const plan = a.target_plan_id ?? "starter";

    if (day >= PILOT.emailDays.checkIn)
      await sendOnce(env, { accountId: a.id, template: "pilot_day_7", dedupeKey: `pilot_day_7:${a.id}`, msg: emails.pilotDay7(user.email, used, c.button_view ?? 0, portalUrl(env)) });
    // Day 10: the branded pilot report (results so far). Skipped when catching up past day 14: the final one covers it.
    if (day >= PILOT.emailDays.report && day < PILOT.emailDays.results) {
      const r = await buildReport(env, a.id, cairoDay(new Date(a.pilot_started_at)), cairoDay(now));
      if (r)
        await sendOnce(env, {
          accountId: a.id,
          template: "pilot_report",
          dedupeKey: `pilot_report:${a.id}`,
          msg: reportEmail(user.email, r, {
            kind: "midway",
            dayNumber: Math.min(day, PILOT.days),
            cta: { label: "See full results", url: portalUrl(env, "/results") },
            endsOn: a.pilot_ends_at ? cairoDay(new Date(a.pilot_ends_at)) : null,
            planLine: null,
          }),
        });
    }
    if (day >= PILOT.emailDays.endingSoon && !prepaid)
      await sendOnce(env, { accountId: a.id, template: "pilot_day_12", dedupeKey: `pilot_day_12:${a.id}`, msg: emails.pilotDay12(user.email, plan, payLink, monthlyPrice(facts ?? {}, plan)) });
    // Day 14: the final results, same branded report, with the pay link.
    if (day >= PILOT.emailDays.results) {
      const r = await buildReport(env, a.id, cairoDay(new Date(a.pilot_started_at)), cairoDay(now));
      if (r)
        await sendOnce(env, {
          accountId: a.id,
          template: "pilot_day_14",
          dedupeKey: `pilot_day_14:${a.id}`,
          msg: reportEmail(user.email, r, {
            kind: "final",
            dayNumber: PILOT.days,
            cta: prepaid ? { label: "See full results", url: portalUrl(env, "/results") } : { label: "Continue my plan", url: payLink },
            endsOn: null,
            planLine: prepaid
              ? `You've already paid: your ${PLANS[prepaid.plan_id ?? plan].name} plan starts on ${prepaid.period_start} and runs until ${prepaid.period_end}. Thank you!`
              : `To keep try-on running, the ${PLANS[plan].name} plan is ${(monthlyPrice(facts ?? {}, plan) / 100).toLocaleString("en-US")} EGP a month, paid before each month. No minimum term.`,
          }),
        });
    }

    // Not paid by pilot end + grace → expired (kill switch on, data kept, pay link reactivates).
    await reconcileAccount(env, a.id, now);
  }
};

/** Stuck detector (brief §6.9): >48 h in one onboarding step → digest alert; install reminder after 48 h. */
export const stuckDetector: JobFn = async (env, now) => {
  const cutoff = new Date(now.getTime() - TIMINGS.stuckAfterHours * 3_600_000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, name, onboarding_step, onboarding_step_at, approved_at, installed_at FROM accounts WHERE status = 'onboarding' AND onboarding_step_at < ?",
  )
    .bind(cutoff)
    .all<{ id: string; name: string; onboarding_step: Step; onboarding_step_at: string; approved_at: string | null; installed_at: string | null }>();
  for (const a of rows.results) {
    const hours = Math.round((now.getTime() - Date.parse(a.onboarding_step_at)) / 3_600_000);
    const dedupe = `alert:stuck:${a.id}:${cairoDay(now)}`;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO notifications (id, account_id, template, channel, dedupe_key, status) VALUES (?, ?, 'stuck', 'alert', ?, 'sent')")
      .bind(ulid(), a.id, dedupe)
      .run();
    if (claim.meta.changes === 1) await alert(env, "stuck", a.id, `${a.name}: stuck ${hours} h at "${STEP_LABEL[a.onboarding_step]}". Send a reminder from admin.`);
    if (a.onboarding_step === "products_approved") {
      const user = await env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(a.id).first<{ email: string }>();
      if (user) await sendOnce(env, { accountId: a.id, template: "install_reminder", dedupeKey: `install_reminder:${a.id}`, msg: emails.installReminder(user.email, portalUrl(env, "/install")) });
    }
  }
};

/** Nightly product re-sync for live brands (prices, images, new products). Selection is kept. */
const productResync: JobFn = async (env) => {
  const rows = await env.DB.prepare("SELECT id FROM accounts WHERE status IN ('pilot','active','past_due') AND website IS NOT NULL LIMIT 200").all<{ id: string }>();
  for (const r of rows.results) await env.JOBS.send({ t: "import", a: r.id });
};

/** Daily install crawler for live brands: keeps install status current in the admin. */
const installCrawler: JobFn = async (env) => {
  const rows = await env.DB.prepare("SELECT id FROM accounts WHERE status IN ('pilot','active','past_due') AND website IS NOT NULL LIMIT 200").all<{ id: string }>();
  for (const r of rows.results) await checkInstall(env, r.id);
};

/** Product tests stopped by a temporary AI error: retry due ones, repair old failures (all brands). */
export const retryBusyTests: JobFn = async (env) => {
  await retryBusyProducts(env);
};

/**
 * Older code paused a brand when it hit the daily AI cap (our own product tests counted too), taking all of its
 * products offline. Put any account still paused that way back where it belongs, as the admin's Restore does.
 */
export const restoreCapPaused: JobFn = async (env) => {
  const rows = await env.DB.prepare(
    `SELECT a.id FROM accounts a
      WHERE a.status = 'paused' AND a.manual_hold = 0
        AND (SELECT l.reason FROM audit_log l WHERE l.account_id = a.id AND l.action = 'status' ORDER BY l.created_at DESC, l.id DESC LIMIT 1)
            LIKE 'Daily AI call cap exceeded%'
      LIMIT 50`,
  ).all<{ id: string }>();
  for (const r of rows.results) {
    const a = await accountFacts(env, r.id);
    if (!a || a.status !== "paused") continue;
    if (!a.paid_through && !a.pilot_started_at) await transitionStatus(env, a, "onboarding", "system", "Restore: paused by the old daily cap");
    // Today's count still includes our own test calls: recount it from shoppers' calls only.
    await env.DB.prepare(
      `UPDATE daily_counters SET count = (SELECT COUNT(*) FROM usage_events WHERE account_id = ?1 AND kind IN ('tryon','room','size','fit_read')
                                            AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours'))
        WHERE account_id = ?1 AND day = ?2 AND metric = 'ai_calls'`,
    )
      .bind(r.id, cairoDay())
      .run();
    const status = await reconcileAccount(env, r.id, new Date(), "system");
    log("cap_pause_restored", { account: r.id, status: status ?? "" });
  }
};

const EVERY_TICK: Record<string, JobFn> = {
  retry_busy_tests: retryBusyTests,
  restore_cap_paused: restoreCapPaused,
  google_balance: (env, now) => checkGoogleBalance(env, now),
  retry_pending_deletes: retryPendingDeletes,
  onboarding_sweep: onboardingSweep,
  payment_claims: (env, now) => pingPendingClaims(env, now),
};
export const DAILY: Record<string, { at: [number, number]; fn: JobFn }> = {
  product_resync: { at: [2, 0], fn: productResync },
  install_crawler: { at: [3, 0], fn: installCrawler },
  billing_run: { at: [5, 0], fn: billingRun },
  stuck_detector: { at: [6, 0], fn: stuckDetector },
  digest: { at: [8, 30], fn: (env, now) => sendDigest(env, now) },
  pilot_clock: { at: [9, 0], fn: pilotClock },
};

/** Admin "run now" for a daily job (records a cron_runs row like the schedule does). */
export async function runJobNow(env: Env, name: string, now = new Date()): Promise<boolean> {
  const job = DAILY[name];
  if (!job) return false;
  await run(env, name, job.fn, now);
  return true;
}

async function ranToday(env: Env, job: string, now: Date): Promise<boolean> {
  const r = await env.DB.prepare("SELECT started_at FROM cron_runs WHERE job = ? AND ok = 1 ORDER BY started_at DESC LIMIT 1").bind(job).first<{ started_at: string }>();
  return !!r && cairoDay(new Date(r.started_at)) === cairoDay(now);
}

async function run(env: Env, name: string, fn: JobFn, now: Date): Promise<void> {
  // Keyed by the scheduled time, so "already ran today" is judged on the Cairo day of the tick.
  const started = now.toISOString();
  let ok = true;
  let error: string | null = null;
  try {
    await fn(env, now);
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message.slice(0, 200) : "error";
  }
  await env.DB.prepare("INSERT OR REPLACE INTO cron_runs (job, started_at, finished_at, ok, error) VALUES (?, ?, ?, ?, ?)")
    .bind(name, started, nowIso(), ok ? 1 : 0, error)
    .run();
  log("cron", { job: name, ok });
}

export async function runScheduled(env: Env, now: Date): Promise<void> {
  for (const [name, fn] of Object.entries(EVERY_TICK)) await run(env, name, fn, now);
  const { hour, minute } = cairoClock(now);
  for (const [name, job] of Object.entries(DAILY)) {
    const due = hour > job.at[0] || (hour === job.at[0] && minute >= job.at[1]);
    if (due && !(await ranToday(env, name, now))) await run(env, name, job.fn, now);
  }
}

// ---------------------------------------------------------------------------- queue consumer

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.t) {
    case "advance":
      await advance(env, job.a);
      return;
    case "import":
      await importForAccount(env, job.a);
      return;
    case "test":
      await testProduct(env, job.a, job.p);
      await env.JOBS.send({ t: "advance", a: job.a });
      return;
  }
}

export async function handleQueue(batch: MessageBatch<Job>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    try {
      await runJob(env, m.body);
      m.ack();
    } catch {
      log("job_failed", { kind: m.body.t, account: m.body.a });
      m.retry({ delaySeconds: 60 });
    }
  }
}
