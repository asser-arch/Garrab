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
    const j = (await r.json()) as { success?: boolean; hostname?: string };
    if (j.success !== true) return false;
    // Solved on our own site only (the try-on frame, sign-up and pages all live on APP_ORIGIN's host).
    let ours: string | null = null;
    try {
      ours = new URL(env.APP_ORIGIN).hostname;
    } catch {
      /* no APP_ORIGIN: skip the host check */
    }
    return !ours || !j.hostname || j.hostname === ours;
  } catch {
    return false;
  }
}
