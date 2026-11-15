import { TIMINGS } from "@garrab/shared/plans";
import { isLocal, type Env } from "../env.js";
import { b64urlDecode, randomToken, sha256Hex, ulid } from "./crypto.js";

// ---------------------------------------------------------------------------
// Magic links: single use, 15 minutes, bound to the email they were sent to.
// The link carries the token in the URL fragment (/portal/login#t=…) so email scanners
// that pre-fetch links can't burn it; the portal POSTs it to /portal-api/auth/verify.

export async function createMagicLink(env: Env, userId: string, email: string, readonly = false): Promise<string> {
  const token = randomToken(40);
  const expires = new Date(Date.now() + TIMINGS.magicLinkMinutes * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO magic_links (id, user_id, email, token_hash, expires_at, readonly) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ulid(), userId, email.toLowerCase(), await sha256Hex(token), expires, readonly ? 1 : 0)
    .run();
  return `${env.APP_ORIGIN}/portal/login#t=${token}`;
}

/** Consume a magic link. Returns the user id, or null if unknown, used, expired or the email changed. */
export async function consumeMagicLink(env: Env, token: string): Promise<{ userId: string; readonly: boolean } | null> {
  if (!/^[A-Za-z0-9]{40}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const now = new Date().toISOString();
  // Atomic single use: only one request can flip used_at.
  const r = await env.DB.prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, hash, now)
    .run();
  if (r.meta.changes !== 1) return null;
  const row = await env.DB.prepare(
    "SELECT m.user_id, m.readonly FROM magic_links m JOIN users u ON u.id = m.user_id WHERE m.token_hash = ? AND u.email = m.email",
  )
    .bind(hash)
    .first<{ user_id: string; readonly: number }>();
  return row ? { userId: row.user_id, readonly: row.readonly === 1 } : null;
}

// ---------------------------------------------------------------------------
// Sessions: random token in an HttpOnly cookie; only its hash is stored.

export const SESSION_COOKIE = "__Host-garrab_s";

/** Brand sessions last 14 days; admin read-only views last 1 hour and don't count as a brand login. */
export async function createSession(env: Env, userId: string, readonly = false): Promise<string> {
  const token = randomToken(40);
  const ttl = readonly ? 3_600_000 : TIMINGS.portalSessionDays * 86_400_000;
  const expires = new Date(Date.now() + ttl).toISOString();
  const stmts = [
    env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, readonly) VALUES (?, ?, ?, ?, ?)").bind(ulid(), userId, await sha256Hex(token), expires, readonly ? 1 : 0),
  ];
  if (!readonly) stmts.push(env.DB.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(userId));
  await env.DB.batch(stmts);
  return token;
}

export function sessionCookie(token: string, maxAgeSec = TIMINGS.portalSessionDays * 86_400): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export interface SessionUser {
  userId: string;
  accountId: string;
  email: string;
  sessionHash: string;
  /** Admin "view as brand": may read everything, change nothing. */
  readonly: boolean;
}

export async function sessionUser(env: Env, cookieHeader: string | undefined): Promise<SessionUser | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9]{40}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, u.account_id, u.email, s.readonly FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, new Date().toISOString())
    .first<{ user_id: string; account_id: string; email: string; readonly: number }>();
  return row ? { userId: row.user_id, accountId: row.account_id, email: row.email, sessionHash: hash, readonly: row.readonly === 1 } : null;
}

/**
 * CSRF guard for cookie-authenticated writes: same-origin requests only, JSON bodies only.
 * (SameSite=Lax already blocks most cross-site POSTs; this closes the rest.)
 */
/** The parts of a Hono context the auth helpers read. */
interface ReqCtx {
  env: Env;
  req: { method: string; header(name: string): string | undefined };
}

export function sameOriginWrite(c: ReqCtx): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  const origin = c.req.header("origin");
  return origin === c.env.APP_ORIGIN;
}

// ---------------------------------------------------------------------------
// Admin: Cloudflare Access JWT (RS256), checked against the team's public keys and audience.

let jwksCache: { at: number; team: string; keys: JsonWebKey[] } | null = null;

/**
 * Accepts "team.cloudflareaccess.com", "team" on its own, with or without https://,
 * a path or a trailing slash.
 */
export function accessTeamHost(env: Env): string | null {
  const t = env.CF_ACCESS_TEAM_DOMAIN?.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]?.replace(/\.+$/, "");
  if (!t) return null;
  return t.includes(".") ? t : `${t}.cloudflareaccess.com`;
}

async function accessKeys(team: string): Promise<JsonWebKey[]> {
  if (jwksCache && jwksCache.team === team && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { keys: JsonWebKey[] };
  jwksCache = { at: Date.now(), team, keys: j.keys };
  return j.keys;
}

/** Why an Access login was refused: short codes, safe to show to the admin. */
export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

const ACCESS_HOST = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

/**
 * The team that signs our logins. The token's own issuer is used when it is a Cloudflare Access
 * team (*.cloudflareaccess.com): safe because the signature is then checked against that team's
 * published keys and the audience must equal our application's unique AUD tag, which no other
 * team's application can carry. CF_ACCESS_TEAM_DOMAIN is only a fallback (and a custom domain).
 */
function signingTeam(env: Env, issuer: string | undefined): string | null {
  const fromToken = issuer?.toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "").replace(/\.+$/, "");
  if (fromToken && ACCESS_HOST.test(fromToken)) return fromToken;
  return accessTeamHost(env);
}

export async function checkAccessJwt(env: Env, jwt: string): Promise<AccessResult> {
  const aud = env.CF_ACCESS_AUD?.trim();
  if (!aud) return { ok: false, reason: "access_not_configured" };
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return { ok: false, reason: "malformed_token" };
  let team: string | null;
  try {
    team = signingTeam(env, (JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { iss?: string }).iss);
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
  if (!team) return { ok: false, reason: "access_not_configured" };
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as { kid?: string; alg?: string };
    if (header.alg !== "RS256") return { ok: false, reason: "bad_algorithm" };
    let keys: JsonWebKey[];
    try {
      keys = await accessKeys(team);
    } catch (e) {
      return { ok: false, reason: `team_domain_unreachable (${team}: ${e instanceof Error ? e.message.slice(0, 60) : "error"})` };
    }
    const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!jwk) return { ok: false, reason: `unknown_signing_key (${team})` };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return { ok: false, reason: "bad_signature" };
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { aud?: string | string[]; exp?: number; email?: string; iss?: string };
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) return { ok: false, reason: "wrong_audience (check CF_ACCESS_AUD)" };
    if (!claims.exp || claims.exp * 1000 < Date.now()) return { ok: false, reason: "expired" };
    if ((claims.iss ?? "").toLowerCase().replace(/\/+$/, "") !== `https://${team}`) return { ok: false, reason: `wrong_issuer (${team})` };
    return { ok: true, email: claims.email ?? "admin" };
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
}

export async function verifyAccessJwt(env: Env, jwt: string): Promise<string | null> {
  const r = await checkAccessJwt(env, jwt);
  return r.ok ? r.email : null;
}

/** Returns the admin's identity, or null. Dev token only works locally. */
export async function adminIdentity(c: ReqCtx): Promise<string | null> {
  const jwt = c.req.header("cf-access-jwt-assertion");
  if (jwt) return verifyAccessJwt(c.env, jwt);
  const auth = c.req.header("authorization");
  if (isLocal(c.env) && c.env.ADMIN_DEV_TOKEN && c.env.ADMIN_DEV_TOKEN.length >= 16 && auth === `Bearer ${c.env.ADMIN_DEV_TOKEN}`) return "dev-admin";
  return null;
}
