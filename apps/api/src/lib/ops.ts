import type { AccountStatus } from "@garrab/shared";
import type { Env } from "../env.js";
import { ulid } from "./crypto.js";
import { type AccountRow, invalidateStatus } from "./db.js";
import { log } from "./log.js";

/**
 * The only way to change an account's status. Writes audit_log, bumps status_version,
 * and clears this isolate's status cache. (Phase 3 adds the full allowed-transition table.)
 */
export async function transitionStatus(
  env: Env,
  account: Pick<AccountRow, "id" | "status">,
  to: AccountStatus,
  actor: "system" | "cron" | "admin" | "brand",
  reason: string,
): Promise<void> {
  if (account.status === to) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET status = ?, status_version = status_version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).bind(to, account.id),
    env.DB.prepare(
      "INSERT INTO audit_log (id, account_id, actor, action, from_status, to_status, reason) VALUES (?, ?, ?, 'status', ?, ?, ?)",
    ).bind(ulid(), account.id, actor, account.status, to, reason),
  ]);
  invalidateStatus(account.id);
  log("status_changed", { account: account.id, status: to });
}

/** Record an alert and push it to Telegram right away (best effort). */
export async function alert(env: Env, kind: string, accountId: string | null, message: string): Promise<void> {
  await env.DB.prepare("INSERT INTO alerts (id, kind, account_id, message) VALUES (?, ?, ?, ?)")
    .bind(ulid(), kind, accountId, message)
    .run();
  log("alert", { kind, account: accountId });
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `⚠️ ${message}` }),
    });
  } catch {
    // Alert is in the DB and the digest; Telegram is best effort.
  }
}
