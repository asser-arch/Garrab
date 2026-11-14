import type { Job } from "./jobs-types.js";

export interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  /** Stock-model test results and (Phase 3) invoice PDFs. Never shopper photos. */
  FILES: R2Bucket;
  JOBS: Queue<Job>;
  RL_TRYON_IP?: RateLimit;
  RL_TRYON_KEY?: RateLimit;
  RL_CONFIG_IP?: RateLimit;

  ENVIRONMENT: "dev" | "test" | "staging" | "prod";
  /** Origin of the frame, hosted pages and portal (our own site Worker). */
  APP_ORIGIN: string;
  /** Where w.js is served from, for the install snippet. */
  CDN_ORIGIN?: string;

  CTX_SIGNING_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** "pass" skips Turnstile. Refused in prod. */
  MOCK_TURNSTILE?: string;

  GENLOOK_API_KEY?: string;
  GENLOOK_MOCK?: string;
  GENLOOK_USD_PER_CREDIT?: string;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;

  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  OPERATOR_EMAIL?: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;

  /** Admin auth: Cloudflare Access. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** Dev/test only: bearer token accepted instead of Access. Refused in staging/prod. */
  ADMIN_DEV_TOKEN?: string;
}

export function isProd(env: Env): boolean {
  return env.ENVIRONMENT === "prod";
}

export function isLocal(env: Env): boolean {
  return env.ENVIRONMENT === "dev" || env.ENVIRONMENT === "test";
}

/** Signing key for ctx tokens. A fixed dev key is allowed only outside staging/prod. */
export function ctxKey(env: Env): string {
  if (env.CTX_SIGNING_KEY && env.CTX_SIGNING_KEY.length >= 32) return env.CTX_SIGNING_KEY;
  if (isLocal(env)) return "dev-only-ctx-signing-key-not-for-production";
  throw new Error("CTX_SIGNING_KEY missing");
}

export function cdnOrigin(env: Env): string {
  return env.CDN_ORIGIN ?? env.APP_ORIGIN;
}
