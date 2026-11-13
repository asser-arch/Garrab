export interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  RL_TRYON_IP?: RateLimit;
  RL_TRYON_KEY?: RateLimit;
  RL_CONFIG_IP?: RateLimit;

  ENVIRONMENT: "dev" | "test" | "staging" | "prod";
  /** Origin of the frame / hosted pages (our own site Worker). */
  APP_ORIGIN: string;

  CTX_SIGNING_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** "pass" skips Turnstile. Refused in prod. */
  MOCK_TURNSTILE?: string;

  GENLOOK_API_KEY?: string;
  GENLOOK_MOCK?: string;
  GENLOOK_USD_PER_CREDIT?: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export function isProd(env: Env): boolean {
  return env.ENVIRONMENT === "prod";
}

/** Signing key for ctx tokens. A fixed dev key is allowed only outside staging/prod. */
export function ctxKey(env: Env): string {
  if (env.CTX_SIGNING_KEY && env.CTX_SIGNING_KEY.length >= 32) return env.CTX_SIGNING_KEY;
  if (env.ENVIRONMENT === "dev" || env.ENVIRONMENT === "test") return "dev-only-ctx-signing-key-not-for-production";
  throw new Error("CTX_SIGNING_KEY missing");
}
