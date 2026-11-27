import { ContactRequest, HEARD_FROM_LABEL, LeadForm } from "@garrab/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { createAccount } from "../lib/accounts.js";
import { ulid } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { sendMetaLead } from "../lib/meta.js";
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
  const foundVia = describeSource(f, referrer?.name ?? null);
  await c.env.DB.prepare(
    "INSERT INTO leads (id, brand_name, contact_name, email, whatsapp, website, instagram, platform, niche, plan, account_id, referred_by, heard_from, tracking_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(ulid(), f.brandName, f.contactName, f.email, f.whatsapp, f.website ?? null, f.instagram ?? null, f.platform, f.niche, f.plan, accountId, referrer?.slug ?? null, f.heardFrom ?? null, f.tracking ? JSON.stringify(f.tracking) : null)
    .run();
  if (created) {
    await c.env.DB.prepare("UPDATE accounts SET found_via = ? WHERE id = ?").bind(foundVia, accountId).run();
    // A brand signed up on its own: tell Asser at once, with how to reach them and where they came from.
    await alert(
      c.env,
      "new_signup",
      accountId,
      `🎉 New sign-up: ${f.brandName} (${f.contactName}). WhatsApp ${f.whatsapp} · ${f.email}${f.website ? ` · ${f.website}` : ""}${f.instagram ? ` · Instagram ${f.instagram}` : ""}. Found us via: ${foundVia}.`,
    );
  }
  if (created && referrer) {
    await c.env.DB.prepare("UPDATE accounts SET referred_by = ? WHERE id = ?").bind(referrer.slug, accountId).run();
    await alert(c.env, "referral", accountId, `New lead via ${referrer.name}: ${f.brandName} signed up from ${referrer.name}'s try-on page.`);
  }
  if (created) await c.env.JOBS.send({ t: "advance", a: accountId });
  // Meta Conversions API (server half of the sign-up "Lead"; the page fires the browser half with the same ID).
  const raw = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
  const eventId = str(raw.eventId, /^[A-Za-z0-9-]{8,64}$/);
  if (created && eventId) {
    const work = sendMetaLead(c.env, {
      eventId,
      email: f.email,
      phone: f.whatsapp,
      sourceUrl: `${c.env.APP_ORIGIN}/start`,
      ip: c.req.header("cf-connecting-ip") ?? null,
      userAgent: c.req.header("user-agent")?.slice(0, 400) ?? null,
      fbp: str(raw.fbp, /^fb\.\d\.\d+\.\d+$/),
      fbc: str(raw.fbc, /^fb\.\d\.\d+\.[A-Za-z0-9_-]{1,500}$/),
    });
    if (c.env.ENVIRONMENT === "test") await work;
    else c.executionCtx.waitUntil(work);
  }
  log("lead", { account: accountId, ok: created });
  // Same answer whether or not the email already had an account (no account probing).
  return c.json({ ok: true });
});

/** One line for the admin: what they told us, then what the browser showed. */
export function describeSource(f: Pick<LeadForm, "heardFrom" | "tracking">, referrerBrand: string | null): string {
  const said = f.heardFrom ? `said "${HEARD_FROM_LABEL[f.heardFrom]}"` : "didn't say";
  const t = f.tracking ?? {};
  const seen = [
    referrerBrand ? `${referrerBrand}'s try-on page` : null,
    t.metaAd ? "a Meta ad click" : null,
    t.utmSource ? `campaign ${[t.utmSource, t.utmMedium, t.utmCampaign].filter(Boolean).join(" / ")}` : null,
    t.referrer ? `from ${t.referrer}` : null,
    t.viaLanding ? "through garrabb.com" : null,
  ].filter(Boolean);
  return seen.length ? `${said}; browser: ${seen.join(", ")}` : `${said}; browser: came directly (typed the address or a link without a source)`;
}

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
