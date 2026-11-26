/**
 * Google balance (admin, for Asser's information). The Gemini API key can't read the Google billing account,
 * so Asser types the balance Google shows (when topping up or checking) and Garrab subtracts every Google AI
 * call it has recorded since then (our cost estimate per call, from Google's list prices). An alert goes out
 * once per balance when the estimate drops under 10 USD or under 3 days of spending.
 */
import type { Env } from "../env.js";
import { getSetting, setSetting } from "./db.js";
import { alert } from "./ops.js";

export interface GoogleBalance {
  /** Balance Asser entered, USD, and when. */
  setUsd: number;
  at: string;
  /** Google AI spend we recorded since then (estimate). */
  spentUsd: number;
  leftUsd: number;
  /** Average Google AI spend per day over the last 7 days, and how many days the rest lasts at that pace. */
  perDayUsd: number;
  daysLeft: number | null;
}

const GOOGLE = "(provider LIKE 'gemini:%' OR provider LIKE 'vertex:%')";

export async function googleBalance(env: Env, now = new Date()): Promise<GoogleBalance | null> {
  const b = await getSetting<{ usd: number; at: string } | null>(env, "google_balance", null);
  if (!b) return null;
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [since, last7] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM usage_events WHERE ${GOOGLE} AND created_at >= ?`).bind(b.at).first<{ s: number }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM usage_events WHERE ${GOOGLE} AND created_at >= ?`).bind(week).first<{ s: number }>(),
  ]);
  const spentUsd = (since?.s ?? 0) / 1e6;
  const leftUsd = b.usd - spentUsd;
  const perDayUsd = (last7?.s ?? 0) / 1e6 / 7;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { setUsd: b.usd, at: b.at, spentUsd: r2(spentUsd), leftUsd: r2(leftUsd), perDayUsd: r2(perDayUsd), daysLeft: perDayUsd > 0 ? Math.max(0, Math.floor(leftUsd / perDayUsd)) : null };
}

export async function setGoogleBalance(env: Env, usd: number, now = new Date()): Promise<void> {
  await setSetting(env, "google_balance", { usd, at: now.toISOString() });
  await setSetting(env, "google_balance_warned", false);
}

/** Every 15 minutes: one alert per balance entry when it's running low. */
export async function checkGoogleBalance(env: Env, now = new Date()): Promise<void> {
  const g = await googleBalance(env, now);
  if (!g || (await getSetting(env, "google_balance_warned", false))) return;
  if (g.leftUsd < 10 || (g.daysLeft !== null && g.daysLeft < 3)) {
    await setSetting(env, "google_balance_warned", true);
    await alert(
      env,
      "google_balance",
      null,
      `Google balance is running low: about ${g.leftUsd.toFixed(2)} USD left${g.daysLeft !== null ? ` (~${g.daysLeft} days at ${g.perDayUsd.toFixed(2)} USD a day)` : ""}. Top up in Google AI Studio / Cloud Billing, then update the balance in the admin.`,
    );
  }
}
