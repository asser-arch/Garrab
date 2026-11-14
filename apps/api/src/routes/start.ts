import { LeadForm } from "@garrab/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { createAccount } from "../lib/accounts.js";
import { ulid } from "../lib/crypto.js";
import { log } from "../lib/log.js";
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
  await c.env.DB.prepare(
    "INSERT INTO leads (id, brand_name, contact_name, email, whatsapp, website, instagram, platform, niche, plan, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(ulid(), f.brandName, f.contactName, f.email, f.whatsapp, f.website ?? null, f.instagram ?? null, f.platform, f.niche, f.plan, accountId)
    .run();
  if (created) await c.env.JOBS.send({ t: "advance", a: accountId });
  log("lead", { account: accountId, ok: created });
  // Same answer whether or not the email already had an account (no account probing).
  return c.json({ ok: true });
});
