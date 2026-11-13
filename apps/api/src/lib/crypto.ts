const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return b64url(sig);
}

/** Constant-time verify (crypto.subtle.verify is constant-time). */
export async function hmacVerify(secret: string, data: string, sigB64: string): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(data));
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time + 80-bit randomness, Crockford base32. Sortable. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[(rnd[i] ?? 0) % 32];
  return time + r;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function randomToken(len = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += B62[b % 62];
  return s;
}

// ---------------------------------------------------------------------------
// ctx tokens: short-lived proof that /v1/config approved this account + origin.

export interface CtxClaims {
  /** account id */
  a: string;
  /** brand origin the token was issued for, or "hosted" for our hosted pages */
  o: string;
  /** expiry, unix seconds */
  e: number;
  /** account status_version at issue time (informational; status is re-checked anyway) */
  v: number;
}

export async function signCtx(secret: string, claims: CtxClaims): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  return `${body}.${await hmacSign(secret, body)}`;
}

export async function verifyCtx(secret: string, token: string, nowSec = Math.floor(Date.now() / 1000)): Promise<CtxClaims | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || token.length > 1024) return null;
  if (!(await hmacVerify(secret, body, sig))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Partial<CtxClaims>;
    if (typeof c.a !== "string" || typeof c.o !== "string" || typeof c.e !== "number" || typeof c.v !== "number") return null;
    if (c.e < nowSec) return null;
    return c as CtxClaims;
  } catch {
    return null;
  }
}
