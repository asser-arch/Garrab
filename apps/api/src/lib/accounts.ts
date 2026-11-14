import type { Env } from "../env.js";
import { randomToken, sha256Hex, ulid } from "./crypto.js";
import { originHost } from "./db.js";

export interface NewAccount {
  brandName: string;
  email: string;
  plan: "starter" | "growth";
  contactName?: string | undefined;
  whatsapp?: string | undefined;
  website?: string | undefined;
  instagram?: string | undefined;
  platform?: "shopify" | "woocommerce" | "other_website" | "social_only" | undefined;
  niche?: string | undefined;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "brand";
}

export function newWidgetKey(env: Env): string {
  return `gk_${env.ENVIRONMENT === "prod" ? "live" : "test"}_${randomToken(28)}`;
}

/**
 * Create account + owner user + widget key + domain, in one batch. Idempotent per email:
 * if the email already has an account, that account is returned.
 * Starts on the founding pilot plan; `target_plan_id` is what they convert to.
 */
export async function createAccount(env: Env, a: NewAccount): Promise<{ accountId: string; userId: string; created: boolean }> {
  const email = a.email.trim().toLowerCase();
  const existing = await env.DB.prepare("SELECT id, account_id FROM users WHERE email = ?").bind(email).first<{ id: string; account_id: string }>();
  if (existing) return { accountId: existing.account_id, userId: existing.id, created: false };

  const accountId = ulid();
  const userId = ulid();
  let slug = slugify(a.brandName);
  if (await env.DB.prepare("SELECT 1 FROM accounts WHERE slug = ?").bind(slug).first()) slug = `${slug}-${accountId.slice(-4).toLowerCase()}`;
  const key = newWidgetKey(env);
  const siteUrl = a.website ? (/^https?:\/\//i.test(a.website) ? a.website : `https://${a.website}`) : null;
  const host = siteUrl ? originHost(siteUrl) : null;
  // Keep the scheme the brand gave us (https unless they typed http://).
  const siteOrigin = siteUrl && host ? new URL(siteUrl).origin : null;
  const platform = a.platform ?? (host ? "other_website" : "social_only");
  const now = new Date().toISOString();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO accounts (id, slug, name, plan_id, target_plan_id, status, platform, contact_name, email, whatsapp, website, instagram, niche,
                             onboarding_step, onboarding_step_at, buy_url)
       VALUES (?, ?, ?, 'pilot', ?, 'onboarding', ?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?)`,
    ).bind(
      accountId,
      slug,
      a.brandName.trim(),
      a.plan,
      platform,
      a.contactName ?? null,
      email,
      a.whatsapp ?? null,
      siteOrigin,
      a.instagram ?? null,
      a.niche ?? null,
      now,
      siteOrigin ?? (a.whatsapp ? `https://wa.me/${a.whatsapp.replace(/\D/g, "")}` : null),
    ),
    env.DB.prepare("INSERT INTO users (id, account_id, email, name) VALUES (?, ?, ?, ?)").bind(userId, accountId, email, a.contactName ?? null),
    env.DB.prepare("INSERT INTO api_keys (id, account_id, prefix, key_hash, key_public) VALUES (?, ?, ?, ?, ?)").bind(
      ulid(),
      accountId,
      key.slice(0, 12),
      await sha256Hex(key),
      key,
    ),
    env.DB.prepare("INSERT INTO onboarding_steps (account_id, step, state, entered_at) VALUES (?, 'invited', 'active', ?)").bind(accountId, now),
    env.DB.prepare("INSERT INTO audit_log (id, account_id, actor, action, to_status, reason) VALUES (?, ?, 'system', 'account_created', 'onboarding', ?)").bind(
      ulid(),
      accountId,
      `plan ${a.plan}`,
    ),
  ];
  if (host) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO domains (id, account_id, host) VALUES (?, ?, ?)").bind(ulid(), accountId, host));
  await env.DB.batch(stmts);
  return { accountId, userId, created: true };
}

export async function widgetKey(env: Env, accountId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT key_public FROM api_keys WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(accountId)
    .first<{ key_public: string | null }>();
  return r?.key_public ?? null;
}
