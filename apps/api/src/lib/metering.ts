import { CAPS, PLANS, dailyCap } from "@garrab/shared/plans";
import type { Env } from "../env.js";
import { ulid } from "./crypto.js";
import type { AccountRow } from "./db.js";
import { getSetting, setSetting } from "./db.js";
import { alert, transitionStatus } from "./ops.js";
import { cairoDay } from "./time.js";

export type UsageKind = "tryon" | "room" | "size" | "fit_read" | "test" | "score";

/** Cycle start for the preview meter. Billing (Phase 3) keeps accounts.cycle_start current. */
export function cycleStartOf(account: AccountRow): string {
  return account.cycle_start ?? cairoDay().slice(0, 8) + "01";
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
  const calls = await counter(env, account.id, "ai_calls", day);
  if (calls >= dailyCap(PLANS[account.plan_id])) {
    await transitionStatus(env, account, "paused", "system", "Daily AI call cap exceeded (possible abuse or cost spike)");
    await alert(env, "account_cap", account.id, `${account.name}: daily cap hit, account paused. Restore from admin if expected.`);
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
      [accountId, "ai_calls", 1],
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
