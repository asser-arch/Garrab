import { SERVING_STATUSES, TIMINGS, type PlanId } from "@garrab/shared/plans";
import type { AccountStatus } from "@garrab/shared";
import type { Env } from "../env.js";
import { sha256Hex } from "./crypto.js";

export interface AccountRow {
  id: string;
  slug: string;
  name: string;
  plan_id: PlanId;
  status: AccountStatus;
  status_version: number;
  cycle_start: string | null;
  button_selector: string | null;
  buy_url: string | null;
  paid_through: string | null;
}

export interface ProductRow {
  id: string;
  account_id: string;
  external_ref: string | null;
  url_path: string | null;
  title: string;
  description: string | null;
  images_json: string;
  kind: "clothing" | "accessory" | "decor";
  sizes_json: string;
  includes_headwear: number;
  provider_synced_at: string | null;
}

const ACCOUNT_COLS = "id, slug, name, plan_id, status, status_version, cycle_start, button_selector, buy_url, paid_through";

export function isServing(status: AccountStatus): boolean {
  return (SERVING_STATUSES as readonly string[]).includes(status);
}

/** Normalise an Origin header to the stored host form: lowercase host[:port], no leading www. */
export function originHost(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function accountByKey(env: Env, key: string): Promise<AccountRow | null> {
  if (!/^gk_(live|test)_[A-Za-z0-9]{16,64}$/.test(key)) return null;
  const hash = await sha256Hex(key);
  return env.DB.prepare(
    `SELECT ${ACCOUNT_COLS.split(", ").map((c) => `a.${c}`).join(", ")}
       FROM api_keys k JOIN accounts a ON a.id = k.account_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
  )
    .bind(hash)
    .first<AccountRow>();
}

export async function accountBySlug(env: Env, slug: string): Promise<AccountRow | null> {
  return env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE slug = ?`).bind(slug).first<AccountRow>();
}

export async function domainAllowed(env: Env, accountId: string, host: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM domains WHERE account_id = ? AND host = ?")
    .bind(accountId, host)
    .first<{ ok: number }>();
  return row !== null;
}

// ---------------------------------------------------------------------------
// Account status. D1 is the only source of truth (KV is never used for status).

interface CachedStatus {
  account: AccountRow;
  at: number;
}
const statusCache = new Map<string, CachedStatus>();

/** Clears this isolate's cache. Called after any status change made by this isolate. */
export function invalidateStatus(accountId?: string): void {
  if (accountId) statusCache.delete(accountId);
  else statusCache.clear();
}

/** Fresh read from D1. Used by every AI call. Throws on DB error (caller fails closed). */
export async function accountFresh(env: Env, accountId: string): Promise<AccountRow | null> {
  const row = await env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(accountId).first<AccountRow>();
  if (row) statusCache.set(accountId, { account: row, at: Date.now() });
  return row;
}

/** Cached up to TIMINGS.statusCacheSeconds. Used only by /v1/config. */
export async function accountCached(env: Env, accountId: string): Promise<AccountRow | null> {
  const hit = statusCache.get(accountId);
  if (hit && Date.now() - hit.at < TIMINGS.statusCacheSeconds * 1000) return hit.account;
  return accountFresh(env, accountId);
}

// ---------------------------------------------------------------------------
// Settings

export async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  )
    .bind(key, JSON.stringify(value))
    .run();
}

// ---------------------------------------------------------------------------
// Products

export async function servableProducts(env: Env, accountId: string): Promise<ProductRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, account_id, external_ref, url_path, title, description, images_json, kind, sizes_json, includes_headwear, provider_synced_at
       FROM products WHERE account_id = ? AND enabled = 1 AND approved = 1 ORDER BY created_at`,
  )
    .bind(accountId)
    .all<ProductRow>();
  return r.results;
}

export async function servableProduct(env: Env, accountId: string, productId: string): Promise<ProductRow | null> {
  return env.DB.prepare(
    `SELECT id, account_id, external_ref, url_path, title, description, images_json, kind, sizes_json, includes_headwear, provider_synced_at
       FROM products WHERE account_id = ? AND id = ? AND enabled = 1 AND approved = 1`,
  )
    .bind(accountId, productId)
    .first<ProductRow>();
}
