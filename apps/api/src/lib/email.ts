/**
 * EmailProvider: Resend (resend.com/docs/api-reference/emails/send-email, checked 14 Nov 2026)
 * POST https://api.resend.com/emails, Authorization: Bearer, Idempotency-Key header (24 h).
 * Swap providers by implementing EmailProvider.
 */
import { workerFetch } from "./http.js";
import { isLocal, type Env } from "../env.js";
import { ulid } from "./crypto.js";
import { log } from "./log.js";
import { alert } from "./ops.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage, idempotencyKey: string): Promise<{ ok: boolean; id: string | null; error?: string }>;
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = workerFetch,
  ) {}
  async send(msg: EmailMessage, idempotencyKey: string): Promise<{ ok: boolean; id: string | null; error?: string }> {
    try {
      const r = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      });
      const j = (await r.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
      if (r.ok) return { ok: true, id: j.id ?? null };
      return { ok: false, id: null, error: cleanError(`HTTP ${r.status} ${j.name ?? ""}: ${j.message ?? ""}`) };
    } catch (e) {
      return { ok: false, id: null, error: cleanError(`network: ${e instanceof Error ? e.message : String(e)}`) };
    }
  }
}

/** Provider error text without email addresses, capped. */
export function cleanError(s: string): string {
  return s.replace(/[^\s@<>"]+@[^\s@<>"]+/g, "[email]").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Dev/test: captures emails in the dev_outbox table so links can be clicked locally. */
export class OutboxProvider implements EmailProvider {
  readonly name = "outbox";
  constructor(private readonly db: D1Database) {}
  async send(msg: EmailMessage): Promise<{ ok: boolean; id: string | null }> {
    const id = ulid();
    await this.db.prepare("INSERT INTO dev_outbox (id, to_addr, subject, html) VALUES (?, ?, ?, ?)").bind(id, msg.to, msg.subject, msg.html).run();
    return { ok: true, id };
  }
}

export function emailProvider(env: Env): EmailProvider {
  if (env.RESEND_API_KEY) return new ResendProvider(env.RESEND_API_KEY, env.EMAIL_FROM ?? "Garrab <hello@garrab.example>");
  if (isLocal(env)) return new OutboxProvider(env.DB);
  throw new Error("RESEND_API_KEY missing");
}

/**
 * Send once per dedupe key. Records the attempt in `notifications` (template name only, no body).
 * Returns false if it was already sent or the send failed.
 */
export async function sendOnce(
  env: Env,
  opts: { accountId: string | null; template: string; dedupeKey: string; msg: EmailMessage },
): Promise<boolean> {
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO notifications (id, account_id, template, dedupe_key, status) VALUES (?, ?, ?, ?, 'sending')",
  )
    .bind(ulid(), opts.accountId, opts.template, opts.dedupeKey)
    .run();
  if (claim.meta.changes !== 1) {
    // Already claimed. Retry only if the earlier attempt failed.
    const prev = await env.DB.prepare("SELECT status FROM notifications WHERE dedupe_key = ?").bind(opts.dedupeKey).first<{ status: string }>();
    if (prev?.status !== "failed") return false;
  }
  const r = await emailProvider(env).send(opts.msg, opts.dedupeKey);
  await env.DB.prepare("UPDATE notifications SET status = ?, provider_id = ?, error = ? WHERE dedupe_key = ?")
    .bind(r.ok ? "sent" : "failed", r.id, r.ok ? null : (r.error ?? "unknown"), opts.dedupeKey)
    .run();
  log("email", { kind: opts.template, ok: r.ok, account: opts.accountId, code: r.ok ? null : (r.error ?? "unknown") });
  // A brand that never gets its email is stuck: tell Asser at once (dashboard + Telegram), with the reason.
  if (!r.ok) await alert(env, "email_failed", opts.accountId, `Email "${opts.template}" was not sent: ${r.error ?? "unknown error"}`);
  return r.ok;
}
