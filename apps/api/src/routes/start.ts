import { ContactRequest, LeadForm } from "@garrab/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { createAccount } from "../lib/accounts.js";
import { ulid } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { alert } from "../lib/ops.js";
import { verifyTurnstile } from "../lib/turnstile.js";

export const start = new Hono<{ Bindings: Env }>();

/**
 * POST /v1/start — the public lead form (brief §6.1a). Creates the lead AND the account
 * straight away, then hands it to the onboarding machine. Zero manual steps.
 */
start.post("/start", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("origin") !== c.env.APP_ORIGIN) return c.json({ error: "forbidden_origin" }, 403);
  c.header("Access-Control-Allow-Origin", c.env.APP_ORIGIN);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown"; // in-memory rate-limit key only
  if (c.env.RL_CONFIG_IP && !(await c.env.RL_CONFIG_IP.limit({ key: `start:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = LeadForm.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid", fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  const f = parsed.data;
  if (!(await verifyTurnstile(c.env, f.turnstileToken))) return c.json({ error: "bot_check" }, 403);

  const { accountId, created } = await createAccount(c.env, {
    brandName: f.brandName,
    email: f.email,
    plan: f.plan,
    contactName: f.contactName,
    whatsapp: f.whatsapp,
    website: f.website,
    instagram: f.instagram,
    platform: f.platform,
    niche: f.niche,
  });
  const referrer = await referringBrand(c.env, f.ref);
  await c.env.DB.prepare(
    "INSERT INTO leads (id, brand_name, contact_name, email, whatsapp, website, instagram, platform, niche, plan, account_id, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(ulid(), f.brandName, f.contactName, f.email, f.whatsapp, f.website ?? null, f.instagram ?? null, f.platform, f.niche, f.plan, accountId, referrer?.slug ?? null)
    .run();
  if (created && referrer) {
    await c.env.DB.prepare("UPDATE accounts SET referred_by = ? WHERE id = ?").bind(referrer.slug, accountId).run();
    await alert(c.env, "referral", accountId, `New lead via ${referrer.name}: ${f.brandName} signed up from ${referrer.name}'s try-on page.`);
  }
  if (created) await c.env.JOBS.send({ t: "advance", a: accountId });
  log("lead", { account: accountId, ok: created });
  // Same answer whether or not the email already had an account (no account probing).
  return c.json({ ok: true });
});

/** The brand whose try-on page sent this visitor (only real brands count). */
async function referringBrand(env: Env, ref: string | undefined): Promise<{ slug: string; name: string } | null> {
  if (!ref) return null;
  return env.DB.prepare("SELECT slug, name FROM accounts WHERE slug = ?").bind(ref).first<{ slug: string; name: string }>();
}

/**
 * POST /v1/contact — "Leave your number and we'll call you" on /start. Lands in the admin
 * (Onboarding → Call-back requests) and on Telegram.
 */
start.post("/contact", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("origin") !== c.env.APP_ORIGIN) return c.json({ error: "forbidden_origin" }, 403);
  c.header("Access-Control-Allow-Origin", c.env.APP_ORIGIN);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.RL_CONFIG_IP && !(await c.env.RL_CONFIG_IP.limit({ key: `contact:${ip}` })).success) return c.json({ error: "rate_limited" }, 429);
  const parsed = ContactRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", fields: parsed.error.issues.map((i) => ({ path: i.path.join(".") })) }, 400);
  const f = parsed.data;
  if (!(await verifyTurnstile(c.env, f.turnstileToken))) return c.json({ error: "bot_check" }, 403);
  const referrer = await referringBrand(c.env, f.ref);
  await c.env.DB.prepare("INSERT INTO contact_requests (id, name, whatsapp, brand, referred_by) VALUES (?, ?, ?, ?, ?)")
    .bind(ulid(), f.name, f.whatsapp, f.brand ?? null, referrer?.slug ?? null)
    .run();
  await alert(
    c.env,
    "contact_request",
    null,
    `Call-back request: ${f.name}${f.brand ? ` (${f.brand})` : ""}, WhatsApp ${f.whatsapp}${referrer ? `, via ${referrer.name}` : ""}.`,
  );
  return c.json({ ok: true });
});
