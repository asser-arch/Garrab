import type { Env } from "../env.js";

/** Verify a Turnstile token. "pass" mock is only possible outside prod and staging. */
export async function verifyTurnstile(env: Env, token: string | null): Promise<boolean> {
  if (env.MOCK_TURNSTILE === "pass" && (env.ENVIRONMENT === "dev" || env.ENVIRONMENT === "test")) return true;
  if (!token || !env.TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
