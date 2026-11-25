import { CAPS, PLANS, dailyCap } from "@garrab/shared/plans";
import type { Env } from "../env.js";
import { ulid } from "./crypto.js";
import type { AccountRow } from "./db.js";
import { getSetting, setSetting } from "./db.js";
import { alert } from "./ops.js";
import { cairoDay } from "./time.js";
import { sendOnce } from "./email.js";
import { emails } from "../emails.js";
import { addDays, addMonths } from "../billing/dates.js";

export type UsageKind = "tryon" | "room" | "size" | "fit_read" | "test" | "score" | "support";
/** AI calls made for shoppers: the only ones that count toward a brand's daily cap. */
const SHOPPER_KINDS: ReadonlySet<UsageKind> = new Set(["tryon", "room", "size", "fit_read"]);
const bumpCap = (env: Env, accountId: string, day: string) =>
  env.DB.prepare(
    `INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, 'cap_alert', 1)
     ON CONFLICT(account_id, day, metric) DO UPDATE SET count = count + 1`,
  )
    .bind(accountId, day)
    .run();

/**
 * Start of the current usage cycle. Paid accounts: the billing month that contains today
 * (paid in advance, so it may be followed by later paid months). Pilot: the pilot start day.
 */
export function cycleStartOf(account: Pick<AccountRow, "cycle_start" | "paid_through">, today = cairoDay()): string {
  if (account.paid_through) {
    let start = addMonths(addDays(account.paid_through, 1), -1);
    while (start > today) start = addMonths(start, -1);
    return start;
  }
  return account.cycle_start ?? today.slice(0, 8) + "01";
}

/**
 * Reserve one preview from the cycle allowance. Atomic: the UPDATE only succeeds while
 * used < included + extra, so concurrent requests can never overshoot (no credit, ever).
 */
export async function reservePreview(env: Env, account: AccountRow): Promise<"ok" | "quota"> {
  const cycle = cycleStartOf(account);
  const included = PLANS[account.plan_id].includedPreviews;
  await env.DB.prepare("INSERT OR IGNORE INTO cycle_usage (account_id, cycle_start, included) VALUES (?, ?, ?)")
    .bind(account.id, cycle, included)
    .run();
  const r = await env.DB.prepare(
    "UPDATE cycle_usage SET used = used + 1 WHERE account_id = ? AND cycle_start = ? AND used < included + extra",
  )
    .bind(account.id, cycle)
    .run();
  return r.meta.changes === 1 ? "ok" : "quota";
}

/** Give a reserved preview back (the AI call failed; failures never count). */
export async function releasePreview(env: Env, account: AccountRow): Promise<void> {
  await env.DB.prepare("UPDATE cycle_usage SET used = MAX(used - 1, 0) WHERE account_id = ? AND cycle_start = ?")
    .bind(account.id, cycleStartOf(account))
    .run();
}

export async function bumpCounter(env: Env, accountId: string, metric: string, by = 1, day = cairoDay()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, day, metric) DO UPDATE SET count = count + excluded.count`,
  )
    .bind(accountId, day, metric, by)
    .run();
}

async function counter(env: Env, accountId: string, metric: string, day = cairoDay()): Promise<number> {
  const r = await env.DB.prepare("SELECT count FROM daily_counters WHERE account_id = ? AND day = ? AND metric = ?")
    .bind(accountId, day, metric)
    .first<{ count: number }>();
  return r?.count ?? 0;
}

/**
 * Daily caps (brief §3). Exceeding either auto-pauses and alerts:
 * - per-account: AI calls today > 3x the average daily allowance → account `paused`
 * - global: AI spend today >= cap → global_kill on
 */
export async function checkCaps(env: Env, account: AccountRow): Promise<"ok" | "account_cap" | "global_cap"> {
  const day = cairoDay();
  const capUsd = await getSetting<number>(env, "global_daily_cap_usd", CAPS.globalDailyUsd);
  const spent = await counter(env, "*", "spend_micro_usd", day);
  if (spent >= capUsd * 1_000_000) {
    await setSetting(env, "global_kill", true);
    await alert(env, "global_cap", null, `Global daily AI spend cap (${capUsd} USD) reached. All previews paused.`);
    return "global_cap";
  }
  // Shoppers' AI calls only (Garrab's own product tests, checks and support replies don't count). Hitting the
  // cap stops previews for the rest of the Cairo day; it never pauses the account (that took brands offline).
  const calls = await counter(env, account.id, "ai_calls", day);
  if (calls >= dailyCap(PLANS[account.plan_id])) {
    if ((await counter(env, account.id, "cap_alert", day)) === 0) {
      await bumpCap(env, account.id, day);
      await alert(env, "account_cap", account.id, `${account.name}: daily shopper preview cap reached; previews stop until midnight Cairo time. Raise it from the admin if this is real traffic.`);
    }
    return "account_cap";
  }
  return "ok";
}

/** One usage_events row per AI call. Holds no image, input, IP or provider user id. */
export async function recordUsage(
  env: Env,
  accountId: string,
  kind: UsageKind,
  provider: string,
  ok: boolean,
  costMicroUsd: number,
  errorCode: string | null = null,
): Promise<void> {
  const day = cairoDay();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO usage_events (id, account_id, kind, provider, ok, error_code, cost_micro_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(ulid(), accountId, kind, provider, ok ? 1 : 0, errorCode, costMicroUsd),
    ...[
      ...(SHOPPER_KINDS.has(kind) ? [[accountId, "ai_calls", 1]] : []),
      [accountId, "spend_micro_usd", costMicroUsd],
      ["*", "spend_micro_usd", costMicroUsd],
    ].map(([a, m, n]) =>
      env.DB.prepare(
        `INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, day, metric) DO UPDATE SET count = count + excluded.count`,
      ).bind(a, day, m, n),
    ),
  ]);
}

/** Usage warnings at 80% and 100% of the cycle's previews (brief §1). Each sent once per cycle. */
export async function usageWarnings(env: Env, account: AccountRow, portalUrl: string): Promise<void> {
  const cycle = cycleStartOf(account);
  const u = await env.DB.prepare("SELECT used, included, extra, warned_80, warned_100 FROM cycle_usage WHERE account_id = ? AND cycle_start = ?")
    .bind(account.id, cycle)
    .first<{ used: number; included: number; extra: number; warned_80: number; warned_100: number }>();
  if (!u) return;
  const total = u.included + u.extra;
  const to = (await env.DB.prepare("SELECT email FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1").bind(account.id).first<{ email: string }>())?.email;
  for (const pct of [100, 80] as const) {
    const flag = pct === 100 ? "warned_100" : "warned_80";
    if (u.used < Math.ceil((total * pct) / 100) || u[flag]) continue;
    const claim = await env.DB.prepare(`UPDATE cycle_usage SET ${flag} = 1 WHERE account_id = ? AND cycle_start = ? AND ${flag} = 0`).bind(account.id, cycle).run();
    if (claim.meta.changes === 1 && to) {
      await sendOnce(env, { accountId: account.id, template: `usage_${pct}`, dedupeKey: `usage_${pct}:${account.id}:${cycle}:${total}`, msg: emails.usageWarning(to, pct, u.used, total, portalUrl) });
    }
    break; // at 100% don't also send the 80% email
  }
}
