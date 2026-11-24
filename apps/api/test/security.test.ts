import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadForm, httpUrl, isHttpUrl } from "@garrab/shared";
import { createAccount } from "../src/lib/accounts.js";
import { verifyTurnstile } from "../src/lib/turnstile.js";

const APP = "https://app.test";
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const outbox = async (to: string) => (await env.DB.prepare("SELECT subject FROM dev_outbox WHERE to_addr = ?").bind(to).all<{ subject: string }>()).results;
const request = (email: string) =>
  exports.default.fetch("https://api.test/portal-api/auth/request", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email }) });

afterEach(() => vi.restoreAllMocks());

describe("security review fixes", () => {
  it("web addresses: only http(s); javascript: and data: are refused everywhere", () => {
    for (const bad of ["javascript:alert(1)", "JavaScript:alert(document.domain)//https://x.com", "data:text/html,<b>hi</b>", "vbscript:x", "ftp://x.example/a"]) {
      expect(isHttpUrl(bad), bad).toBe(false);
      expect(httpUrl().safeParse(bad).success, bad).toBe(false);
    }
    expect(isHttpUrl("https://shop.example/p/1")).toBe(true);
    const lead = { brandName: "Evil", contactName: "Evil", email: "e@x.example", whatsapp: "01001234567", website: "javascript:alert(1)", platform: "other_website", niche: "fashion", plan: "starter", turnstileToken: "x" };
    expect(LeadForm.safeParse(lead).success).toBe(false);
  });

  it("a brand can't save a javascript: product link (it would become the shopper's Buy button)", async () => {
    const email = `sec-${uniq()}@brand.example`;
    await createAccount(env, { brandName: `Sec ${uniq()}`, email, plan: "starter" });
    await request(email);
    const token = /#t=([A-Za-z0-9]{40})/.exec(
      (await env.DB.prepare("SELECT html FROM dev_outbox WHERE to_addr = ? ORDER BY created_at DESC LIMIT 1").bind(email).first<{ html: string }>())!.html,
    )![1]!;
    const v = await exports.default.fetch("https://api.test/portal-api/auth/verify", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const cookie = v.headers.get("set-cookie")!.split(";")[0]!;
    const r = await exports.default.fetch("https://api.test/portal-api/products", {
      method: "POST",
      headers: { cookie, origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ title: "Dress", imageUrl: "https://cdn.example/d.jpg", productUrl: "javascript:alert(document.cookie)" }),
    });
    expect(r.status).toBe(400);
  });

  it("sign-in emails: at most 5 an hour per address (no inbox flooding, no farming codes)", async () => {
    const email = `flood-${uniq()}@brand.example`;
    await createAccount(env, { brandName: `Flood ${uniq()}`, email, plan: "starter" });
    const before = (await outbox(email)).length; // the welcome email
    for (let i = 0; i < 8; i++) expect((await request(email)).status).toBe(200); // same answer every time
    const signIns = (await outbox(email)).length - before;
    expect(signIns).toBeLessThanOrEqual(5);
    expect(signIns).toBeGreaterThan(0);
  });

  it("fake Kashier webhooks: refused, not stored, and at most one alert an hour", async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'webhook_signature' AND message LIKE '%kashier.%'").first<{ n: number }>())!.n;
    for (let i = 0; i < 3; i++) {
      const r = await exports.default.fetch("https://api.test/webhooks/kashier", {
        method: "POST",
        headers: { "content-type": "application/json", "x-kashier-signature": "00".repeat(32) },
        body: JSON.stringify({ event: "pay", data: { status: "SUCCESS", merchantOrderId: "inv_x", amount: 5000, transactionId: `t${i}`, junk: "x".repeat(5000) } }),
      });
      expect(r.status).toBe(401);
    }
    const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'webhook_signature' AND message LIKE '%kashier.%'").first<{ n: number }>())!.n;
    expect(after - before).toBeLessThanOrEqual(1);
    const kept = await env.DB.prepare("SELECT raw_body FROM webhook_events WHERE provider = 'kashier' AND signature_ok = 0 ORDER BY received_at DESC LIMIT 1").first<{ raw_body: string }>();
    expect(kept?.raw_body ?? "").toBe("");
  });

  it("the bot check must have been solved on our own site", async () => {
    const real = { ...env, ENVIRONMENT: "prod", MOCK_TURNSTILE: undefined, TURNSTILE_SECRET: "secret", APP_ORIGIN: "https://app.garrabb.com" } as typeof env;
    const answer = (hostname: string) => vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ success: true, hostname }));
    answer("app.garrabb.com");
    expect(await verifyTurnstile(real, "tok")).toBe(true);
    answer("evil.example");
    expect(await verifyTurnstile(real, "tok")).toBe(false);
  });
});
