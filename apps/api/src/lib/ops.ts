import type { AccountStatus } from "@garrab/shared";
import type { Env } from "../env.js";
import { ulid } from "./crypto.js";
import { type AccountRow, invalidateStatus } from "./db.js";
import { log } from "./log.js";
import { canTransition } from "../billing/status.js";

/**
 * The only way to change an account's status. Refuses transitions the status machine doesn't
 * allow, writes audit_log, bumps status_version (clears caches) and alerts Asser when an account
 * is switched off. Returns false if the move isn't allowed.
 */
export async function transitionStatus(
  env: Env,
  account: Pick<AccountRow, "id" | "status">,
  to: AccountStatus,
  actor: string,
  reason: string,
): Promise<boolean> {
  if (account.status === to) return true;
  if (!canTransition(account.status, to)) {
    log("status_refused", { account: account.id, status: to });
    return false;
  }
  const r = await env.DB.prepare(
    `UPDATE accounts SET status = ?, status_version = status_version + 1, status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = ?`,
  )
    .bind(to, account.id, account.status)
    .run();
  if (r.meta.changes !== 1) return false; // someone else changed it first
  await env.DB.prepare(
    "INSERT INTO audit_log (id, account_id, actor, action, from_status, to_status, reason) VALUES (?, ?, ?, 'status', ?, ?, ?)",
  )
    .bind(ulid(), account.id, actor, account.status, to, reason)
    .run();
  invalidateStatus(account.id);
  log("status_changed", { account: account.id, status: to });
  if (to === "suspended") {
    const name = await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(account.id).first<{ name: string }>();
    await alert(env, "kill_switch", account.id, `Kill switch: ${name?.name ?? account.id} is now ${to}. Reason: ${reason}`);
  }
  account.status = to;
  return true;
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
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${env.ENVIRONMENT === "prod" ? "" : "[Staging] "}⚠️ ${message}` }),
    });
  } catch {
    // Alert is in the DB and the digest; Telegram is best effort.
  }
}
