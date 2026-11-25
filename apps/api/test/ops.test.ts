import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountFacts, applyPayment, ensurePlanInvoice } from "../src/billing/ledger.js";
import { createAccount } from "../src/lib/accounts.js";
import { invalidateStatus } from "../src/lib/db.js";
import { cairoDay } from "../src/lib/time.js";

const APP = "https://app.test";
const ADMIN = { authorization: "Bearer test-admin-token-123456", "content-type": "application/json" };
let n = 0;
const uniq = (): string => `${Date.now().toString(36)}${n++}`;
const post = (path: string, body: unknown) => exports.default.fetch(`https://api.test/admin-api${path}`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });

beforeEach(async () => {
  await env.DB.prepare("UPDATE settings SET value_json = 'true' WHERE key = 'founding_pilots_open'").run();
  await env.DB.prepare("UPDATE settings SET value_json = 'false' WHERE key = 'global_kill'").run();
  invalidateStatus();
});

async function liveBrand(): Promise<{ id: string; email: string; host: string; key: string }> {
  const email = `o-${uniq()}@brand.example`;
  const host = `ops-${uniq()}.example`;
  const { accountId } = await createAccount(env, { brandName: `Ops ${uniq()}`, email, plan: "starter", website: `https://${host}` });
  await env.DB.prepare("UPDATE accounts SET status = 'active', plan_id = 'starter', paid_through = '2099-01-01' WHERE id = ?").bind(accountId).run();
  await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, enabled, approved, selected) VALUES (?, ?, ?, 'Dress', '["https://x.example/a.jpg"]', 1, 1, 1)`)
    .bind(`p${uniq()}`, accountId, `r${uniq()}`)
    .run();
  const key = (await env.DB.prepare("SELECT key_public FROM api_keys WHERE account_id = ?").bind(accountId).first<{ key_public: string }>())!.key_public;
  return { id: accountId, email, host, key };
}

async function enabled(key: string, host: string): Promise<boolean> {
  invalidateStatus();
  const r = await exports.default.fetch(`https://api.test/v1/config?key=${key}`, { headers: { origin: `https://${host}` } });
  return ((await r.json()) as { enabled: boolean }).enabled;
}

describe("admin: open the brand portal read-only", () => {
  it("sees everything, changes nothing, for one hour", async () => {
    const b = await liveBrand();
    const { link } = (await (await post(`/accounts/${b.id}/view-portal`, {})).json()) as { link: string };
    const token = /#t=([A-Za-z0-9]{40})$/.exec(link)![1];
    const v = await exports.default.fetch("https://api.test/portal-api/auth/verify", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const setCookie = v.headers.get("set-cookie")!;
    expect(setCookie).toContain("Max-Age=3600");
    const cookie = setCookie.split(";")[0]!;
    const me = (await (await exports.default.fetch("https://api.test/portal-api/me", { headers: { cookie } })).json()) as { readonly: boolean };
    expect(me.readonly).toBe(true);
    const write = await exports.default.fetch("https://api.test/portal-api/billing/cancel", { method: "POST", headers: { cookie, origin: APP, "content-type": "application/json" }, body: "{}" });
    expect(write.status).toBe(403);
    const acc = await env.DB.prepare("SELECT cancel_at_period_end FROM accounts WHERE id = ?").bind(b.id).first<{ cancel_at_period_end: number }>();
    expect(acc!.cancel_at_period_end).toBe(0);
    const u = await env.DB.prepare("SELECT last_login_at FROM users WHERE email = ?").bind(b.email).first<{ last_login_at: string | null }>();
    expect(u!.last_login_at).toBeNull(); // an admin view isn't a brand login
  });
});

describe("admin: widget keys and domains", () => {
  it("rotating the key stops the old one at once and returns the new install line", async () => {
    const b = await liveBrand();
    expect((await post(`/accounts/${b.id}/rotate-key`, { reason: "" })).status).toBe(400);
    const r = (await (await post(`/accounts/${b.id}/rotate-key`, { reason: "key leaked" })).json()) as { snippet: string };
    const newKey = /data-key="([^"]+)"/.exec(r.snippet)![1]!;
    expect(await enabled(b.key, b.host)).toBe(false);
    expect(await enabled(newKey, b.host)).toBe(true);
  });

  it("adds and removes domains; a domain can belong to one brand only", async () => {
    const a = await liveBrand();
    const other = await liveBrand();
    const extra = `shop2-${uniq()}.example`;
    expect(await enabled(a.key, extra)).toBe(false);
    expect((await post(`/accounts/${a.id}/domains`, { host: `https://www.${extra}/products` })).status).toBe(200);
    expect(await enabled(a.key, extra)).toBe(true);
    expect((await post(`/accounts/${other.id}/domains`, { host: extra })).status).toBe(409);
    const list = (await (await exports.default.fetch(`https://api.test/admin-api/accounts/${a.id}/domains`, { headers: ADMIN })).json()) as { domains: { id: string; host: string }[] };
    const d = list.domains.find((x) => x.host === extra)!;
    await post(`/accounts/${a.id}/domains/${d.id}/remove`, {});
    expect(await enabled(a.key, extra)).toBe(false);
  });
});

describe("cost view and setup fee", () => {
  it("daily AI cost per brand in USD and EGP", async () => {
    const b = await liveBrand();
    await post("/settings", { egpPerUsd: 50 });
    await env.DB.prepare("INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, 'spend_micro_usd', 1230000), (?, ?, 'ai_calls', 31)")
      .bind(b.id, cairoDay(), b.id, cairoDay())
      .run();
    const r = (await (await exports.default.fetch(`https://api.test/admin-api/accounts/${b.id}/costs`, { headers: ADMIN })).json()) as { days: { day: string; calls: number; usd: number; egp: number }[] };
    expect(r.days[0]).toEqual({ day: cairoDay(), calls: 31, usd: 1.23, egp: 61.5 });
  });

  it("founding pilots pay no setup fee; once closed, the first invoice adds it", async () => {
    const founding = await createAccount(env, { brandName: "Founding", email: `f-${uniq()}@x.example`, plan: "starter" });
    await post("/founding-pilots", { open: false });
    const later = await createAccount(env, { brandName: "Later", email: `l-${uniq()}@x.example`, plan: "starter" });
    for (const id of [founding.accountId, later.accountId]) await env.DB.prepare("UPDATE accounts SET status = 'pilot' WHERE id = ?").bind(id).run();
    const i1 = await ensurePlanInvoice(env, (await accountFacts(env, founding.accountId))!, new Date());
    const i2 = await ensurePlanInvoice(env, (await accountFacts(env, later.accountId))!, new Date());
    expect(i1.total).toBe(500_000);
    expect(i2.total).toBe(650_000); // 5,000 + 1,500 setup (plans.ts)
    expect(JSON.parse(i2.lines_json)).toEqual([expect.objectContaining({ amount: 500_000 }), { label: "One-off setup", amount: 150_000 }]);
  });
});

describe("request size limits", () => {
  it("refuses oversized bodies on JSON endpoints", async () => {
    const big = JSON.stringify({ brandName: "x".repeat(70 * 1024) });
    const r = await exports.default.fetch("https://api.test/v1/start", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: big });
    expect(r.status).toBe(413);
  });
});

describe("Asser's answers (14 Nov): product limits, account name, test budget", () => {
  async function portalCookie(email: string): Promise<string> {
    const { sha256Hex, ulid } = await import("../src/lib/crypto.js");
    const u = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!;
    const token = ("T" + uniq()).padEnd(40, "x").slice(0, 40).replace(/[^A-Za-z0-9]/g, "x");
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, '2099-01-01T00:00:00Z')").bind(ulid(), u.id, await sha256Hex(token)).run();
    return `__Host-garrab_s=${token}`;
  }
  const add = (cookie: string, i: number) =>
    exports.default.fetch("https://api.test/portal-api/products", {
      method: "POST",
      headers: { cookie, origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ title: `Product ${i}`, imageUrl: `https://cdn.example/${i}.jpg` }),
    });

  it("no product limit on any plan, the pilot included; a per-brand limit can still be set", async () => {
    const b = await liveBrand(); // starter, active
    await env.DB.prepare("UPDATE accounts SET plan_id = 'pilot', status = 'pilot' WHERE id = ?").bind(b.id).run();
    const cookie = await portalCookie(b.email);
    for (let i = 0; i < 14; i++) expect((await add(cookie, i)).status).toBe(200); // more than the old pilot limit of 10
    const list = (await (await exports.default.fetch("https://api.test/portal-api/products", { headers: { cookie } })).json()) as { maxProducts: number | null };
    expect(list.maxProducts).toBeNull();

    await env.DB.prepare("UPDATE accounts SET plan_id = 'starter', status = 'active' WHERE id = ?").bind(b.id).run();
    // 1 seeded + 14 added = 15 products. A per-brand limit of 15 stops the next one.
    await post(`/accounts/${b.id}/product-limit`, { limit: 15 });
    expect((await add(cookie, 100)).status).toBe(400);
    const selected = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE account_id = ? AND selected = 1").bind(b.id).first<{ n: number }>();
    expect(selected!.n).toBe(15);
    await post(`/accounts/${b.id}/product-limit`, { limit: null }); // back to the plan default: unlimited
    expect((await add(cookie, 101)).status).toBe(200);

    const pilot = await createAccount(env, { brandName: "Pilot", email: `p-${uniq()}@x.example`, plan: "starter" });
    const pc = await portalCookie((await env.DB.prepare("SELECT email FROM users WHERE account_id = ?").bind(pilot.accountId).first<{ email: string }>())!.email);
    for (let i = 0; i < 10; i++) await add(pc, i);
    expect((await add(pc, 10)).status).toBe(200); // a new pilot brand is no longer stopped at 10 (18 Nov)
  });

  it("the pay page shows the InstaPay account name", async () => {
    const b = await liveBrand();
    await env.DB.prepare("UPDATE accounts SET paid_through = ? WHERE id = ?").bind(cairoDay(), b.id).run();
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    const page = (await (await exports.default.fetch(`https://api.test/v1/pay/${inv.pay_token}`)).json()) as { instapay: { address: string; accountName: string } };
    expect(page.instapay).toMatchObject({ address: "01009110001", accountName: "Asser Rostom" });
  });

  it("the product test budget is per rolling 30 days, so old tests don't block new products", async () => {
    const { testProduct } = await import("../src/onboarding/tests.js");
    const { ulid } = await import("../src/lib/crypto.js");
    const b = await liveBrand();
    await env.FILES.put("fixtures/model-a.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]));
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, selected) VALUES (?, ?, ?, 'Dress', '["https://x.example/a.jpg"]', 1)`).bind(pid, b.id, `r${uniq()}`).run();
    // 5 USD spent 40 days ago: outside the window.
    await env.DB.prepare("INSERT INTO usage_events (id, account_id, kind, provider, ok, cost_micro_usd, created_at) VALUES (?, ?, 'test', 'mock', 1, 5000000, ?)")
      .bind(ulid(), b.id, new Date(Date.now() - 40 * 86_400_000).toISOString())
      .run();
    expect(await testProduct(env, b.id, pid)).not.toBe("skipped_budget");
  });
});

import { ResendProvider, cleanError, sendOnce } from "../src/lib/email.js";
describe("email failures", () => {
  it("keeps Resend's reason (without addresses) and raises an alert", async () => {
    const fake = (async () => Response.json({ statusCode: 403, name: "validation_error", message: "The garrab.com domain is not verified for x@y.com" }, { status: 403 })) as typeof fetch;
    const r = await new ResendProvider("re_test", "Garrab <hello@garrabb.com>", fake).send({ to: "a@b.example", subject: "s", html: "h", text: "t" }, "k");
    expect(r).toEqual({ ok: false, id: null, error: "HTTP 403 validation_error: The garrab.com domain is not verified for [email]" });
    expect(cleanError("to friend@mail.example failed")).toBe("to [email] failed");
  });

  it("an email that fails is recorded with its reason and shows up as an alert", async () => {
    const key = `test-fail:${uniq()}`;
    const badEnv = { ...env, RESEND_API_KEY: "re_bad", EMAIL_FROM: "Garrab <hello@garrabb.com>" } as typeof env;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: RequestInfo | URL, i?: RequestInit) =>
      String(u).startsWith("https://api.resend.com")
        ? Response.json({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 })
        : orig(u, i)) as typeof fetch;
    try {
      expect(await sendOnce(badEnv, { accountId: null, template: "welcome", dedupeKey: key, msg: { to: "a@b.example", subject: "s", html: "h", text: "t" } })).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
    const row = await env.DB.prepare("SELECT status, error FROM notifications WHERE dedupe_key = ?").bind(key).first<{ status: string; error: string }>();
    expect(row).toEqual({ status: "failed", error: "HTTP 401 restricted_api_key: This API key is restricted to only send emails" });
    const a = await env.DB.prepare("SELECT message FROM alerts WHERE kind = 'email_failed' ORDER BY created_at DESC LIMIT 1").first<{ message: string }>();
    expect(a?.message).toContain('Email "welcome" was not sent: HTTP 401 restricted_api_key');
  });
});

describe("invite again and delete an invitation", () => {
  it("inviting the same email twice makes no duplicate and says what happened to the welcome email", async () => {
    const email = `again-${uniq()}@brand.example`;
    const first = (await (await post("/invite", { brandName: `Again ${uniq()}`, email, plan: "starter" })).json()) as { accountId: string; created: boolean };
    expect(first.created).toBe(true);
    const second = (await (await post("/invite", { brandName: "Typo name", email, plan: "starter" })).json()) as {
      accountId: string;
      created: boolean;
      link: string;
      existing: { welcome: string };
    };
    expect(second).toMatchObject({ accountId: first.accountId, created: false });
    expect(second.link).toContain("/portal/login#t=");
    expect(["sent_now", "already_sent"]).toContain(second.existing.welcome);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("deletes an onboarding brand only with its exact name, then the email can be invited fresh", async () => {
    const email = `del-${uniq()}@brand.example`;
    const name = `Delete Me ${uniq()}`;
    const { accountId } = (await (await post("/invite", { brandName: name, email, plan: "starter" })).json()) as { accountId: string };
    expect((await post(`/accounts/${accountId}/delete`, { confirmName: "wrong", reason: "test" })).status).toBe(400);
    const ok = await post(`/accounts/${accountId}/delete`, { confirmName: name.toLowerCase(), reason: "wrong email" });
    expect(ok.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(accountId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()).toBeNull();
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE account_id = ? AND action = 'delete_brand'").bind(accountId).first();
    expect(audit).not.toBeNull();
    const again = (await (await post("/invite", { brandName: name, email, plan: "starter" })).json()) as { created: boolean };
    expect(again.created).toBe(true);
  });

  it("deletes a live pilot brand that never paid completely, unpaid invoice included", async () => {
    const b = await liveBrand();
    await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    await env.DB.prepare("INSERT INTO usage_events (id, account_id, kind, provider, ok, cost_micro_usd) VALUES (?, ?, 'tryon', 'mock', 1, 40000)").bind(`u${uniq()}`, b.id).run();
    const name = (await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(b.id).first<{ name: string }>())!.name;
    const r = await post(`/accounts/${b.id}/delete`, { confirmName: name, reason: "test brand" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { kept: string | null }).kept).toBeNull();
    for (const t of ["accounts WHERE id", "invoices WHERE account_id", "products WHERE account_id", "users WHERE account_id", "usage_events WHERE account_id", "api_keys WHERE account_id"])
      expect(await env.DB.prepare(`SELECT 1 FROM ${t} = ?`).bind(b.id).first(), t).toBeNull();
  });

  it("a brand that paid: invoices and payments stay, everything else goes, switched off for good", async () => {
    const b = await liveBrand();
    const inv = await ensurePlanInvoice(env, (await accountFacts(env, b.id))!, new Date());
    await applyPayment(env, { invoiceId: inv.id, provider: "manual", txnId: `m-${uniq()}`, amount: inv.total, method: "cash", actor: "admin:test" });
    const name = (await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(b.id).first<{ name: string }>())!.name;
    const r = await post(`/accounts/${b.id}/delete`, { confirmName: name, reason: "closed shop" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { kept: string }).kept).toBe("invoices");
    expect(await env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(b.id).first()).toEqual({ status: "archived" });
    expect(await env.DB.prepare("SELECT 1 FROM payments WHERE account_id = ?").bind(b.id).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM invoices WHERE account_id = ?").bind(b.id).first()).not.toBeNull();
    for (const t of ["products", "users", "api_keys", "domains"]) expect(await env.DB.prepare(`SELECT 1 FROM ${t} WHERE account_id = ?`).bind(b.id).first(), t).toBeNull();
  });
});

describe("brand deletes its own products", () => {
  it("a product added by hand is deleted; one read from the website is hidden; another brand's product is untouchable", async () => {
    const { sha256Hex, ulid } = await import("../src/lib/crypto.js");
    const b = await liveBrand();
    const other = await liveBrand();
    const u = (await env.DB.prepare("SELECT id FROM users WHERE account_id = ?").bind(b.id).first<{ id: string }>())!;
    const token = "D".repeat(20) + uniq().padEnd(20, "E").slice(0, 20);
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, '2099-01-01T00:00:00Z')").bind(ulid(), u.id, await sha256Hex(token)).run();
    const cookie = `__Host-garrab_s=${token}`;
    const del = (pid: string) => exports.default.fetch(`https://api.test/portal-api/products/${pid}/delete`, { method: "POST", headers: { cookie, origin: APP, "content-type": "application/json" }, body: "{}" });
    const manual = `pm${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, selected, source) VALUES (?, ?, ?, 'Hand added', '["https://cdn.example/h.jpg"]', 1, 'manual')`).bind(manual, b.id, `manual:${manual}`).run();
    const imported = `pi${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, selected, enabled, approved, source) VALUES (?, ?, ?, 'From the shop', '["https://cdn.example/s.jpg"]', 1, 1, 1, 'shopify')`).bind(imported, b.id, `shop:${imported}`).run();
    const theirs = (await env.DB.prepare("SELECT id FROM products WHERE account_id = ? LIMIT 1").bind(other.id).first<{ id: string }>())!.id;

    expect(await (await del(manual)).json()).toEqual({ ok: true, hidden: false });
    expect(await env.DB.prepare("SELECT 1 FROM products WHERE id = ?").bind(manual).first()).toBeNull();
    expect(await (await del(imported)).json()).toEqual({ ok: true, hidden: true });
    expect(await env.DB.prepare("SELECT selected, approved, brand_decision FROM products WHERE id = ?").bind(imported).first()).toEqual({ selected: 0, approved: 0, brand_decision: "hidden" });
    expect((await del(theirs)).status).toBe(404);
    expect(await env.DB.prepare("SELECT 1 FROM products WHERE id = ?").bind(theirs).first()).not.toBeNull();
  });
});

describe("brand renames, re-tests and decides its own products", () => {
  it("rename any time; 'Test again' twice for failed products; approve one our check wasn't sure about", async () => {
    const { sha256Hex, ulid } = await import("../src/lib/crypto.js");
    const b = await liveBrand();
    const other = await liveBrand();
    const u = (await env.DB.prepare("SELECT id FROM users WHERE account_id = ?").bind(b.id).first<{ id: string }>())!;
    const token = "R".repeat(20) + uniq().padEnd(20, "N").slice(0, 20);
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, '2099-01-01T00:00:00Z')").bind(ulid(), u.id, await sha256Hex(token)).run();
    const cookie = `__Host-garrab_s=${token}`;
    const call = (path: string, body: unknown) =>
      exports.default.fetch(`https://api.test/portal-api${path}`, { method: "POST", headers: { cookie, origin: APP, "content-type": "application/json" }, body: JSON.stringify(body) });
    const add = async (title: string, cols: string) => {
      const id = `pr${uniq()}`;
      await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, selected, source, ${cols.split("=")[0]}) VALUES (?, ?, ?, ?, '["https://cdn.example/x.jpg"]', 1, 'manual', ?)`)
        .bind(id, b.id, `manual:${id}`, title, cols.split("=")[1])
        .run();
      return id;
    };

    // Rename
    const junk = await add("ChatGPT Image Nov 25, 2026, 12 33 09 PM 2", "test_score=5");
    expect((await call(`/products/${junk}/rename`, { title: "  Beige fringed suit " })).status).toBe(200);
    expect(await env.DB.prepare("SELECT title FROM products WHERE id = ?").bind(junk).first()).toEqual({ title: "Beige fringed suit" });
    expect((await call(`/products/${junk}/rename`, { title: "x" })).status).toBe(400);
    const theirs = (await env.DB.prepare("SELECT id FROM products WHERE account_id = ? LIMIT 1").bind(other.id).first<{ id: string }>())!.id;
    expect((await call(`/products/${theirs}/rename`, { title: "Mine now" })).status).toBe(404);

    // Test again: failed product, twice, then the limit
    const failed = await add("Kaftan set", "test_score=2");
    await env.DB.prepare("UPDATE products SET disabled_reason = 'Our AI couldn''t make a good preview from this photo.' WHERE id = ?").bind(failed).run();
    const list = async () =>
      ((await (await exports.default.fetch("https://api.test/portal-api/products", { headers: { cookie } })).json()) as { products: { id: string; result: string; retestsLeft: number; reason: string | null }[] }).products;
    expect((await list()).find((p) => p.id === failed)).toMatchObject({ result: "failed", retestsLeft: 2, reason: "Our AI couldn't make a good preview from this photo." });
    expect((await call(`/products/${failed}/retest`, {})).status).toBe(200);
    expect((await list()).find((p) => p.id === failed)).toMatchObject({ result: "pending", retestsLeft: 1 });
    await env.DB.prepare("UPDATE products SET test_score = 2 WHERE id = ?").bind(failed).run();
    expect((await call(`/products/${failed}/retest`, {})).status).toBe(200);
    await env.DB.prepare("UPDATE products SET test_score = 2 WHERE id = ?").bind(failed).run();
    expect((await call(`/products/${failed}/retest`, {})).status).toBe(429);
    // A live product can't be re-tested by the brand.
    await env.DB.prepare("UPDATE products SET enabled = 1 WHERE id = ?").bind(junk).run();
    expect((await call(`/products/${junk}/retest`, {})).status).toBe(400);

    // Checker's raw words never reach the brand.
    const raw = await add("Hoodie", "test_score=1");
    await env.DB.prepare("UPDATE products SET disabled_reason = 'The entire outfit has been completely changed' WHERE id = ?").bind(raw).run();
    expect((await list()).find((p) => p.id === raw)!.reason).toBe("Our AI couldn't make a good preview from this photo.");

    // "Needs review" with previews: the brand approves it and it goes live; a failed one can't be approved.
    const unsure = await add("Beaded kaftan", "test_score=3");
    await env.DB.prepare("UPDATE products SET needs_review = 1, enabled = 0 WHERE id = ?").bind(unsure).run();
    await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score) VALUES (?, ?, ?, 'fixtures/model-a.jpg', 'tests/x.jpg', 3)").bind(`t${uniq()}`, b.id, unsure).run();
    expect((await call(`/products/${unsure}/decision`, { decision: "approved" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled, approved, needs_review FROM products WHERE id = ?").bind(unsure).first()).toEqual({ enabled: 1, approved: 1, needs_review: 0 });
    expect((await call(`/products/${raw}/decision`, { decision: "approved" })).status).toBe(404);
    expect(await env.DB.prepare("SELECT approved FROM products WHERE id = ?").bind(raw).first()).toEqual({ approved: 0 });
    // A flagged (low score) product that has previews: the brand has the final say.
    await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score) VALUES (?, ?, ?, 'fixtures/model-b.jpg', 'tests/y.jpg', 2)").bind(`t${uniq()}`, b.id, raw).run();
    expect((await call(`/products/${raw}/decision`, { decision: "approved" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled, approved FROM products WHERE id = ?").bind(raw).first()).toEqual({ enabled: 1, approved: 1 });
    // Blocked by content rules: never.
    const rules = await add("Swimwear", "test_score=1");
    await env.DB.prepare("UPDATE products SET disabled_reason = 'This product can''t be shown in try-on (content rules).' WHERE id = ?").bind(rules).run();
    await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score) VALUES (?, ?, ?, 'fixtures/model-a.jpg', 'tests/z.jpg', 1)").bind(`t${uniq()}`, b.id, rules).run();
    expect((await call(`/products/${rules}/decision`, { decision: "approved" })).status).toBe(404);
  });
});

describe("product re-test", () => {
  it("clears the old result and sends the product back to testing", async () => {
    const b = await liveBrand();
    const p = await env.DB.prepare("SELECT id FROM products WHERE account_id = ?").bind(b.id).first<{ id: string }>();
    await env.DB.prepare("UPDATE products SET test_score = 1, enabled = 0, disabled_reason = 'bad' WHERE id = ?").bind(p!.id).run();
    await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, score, reason) VALUES (?, ?, ?, 'fixtures/model-a.jpg', 1, 'old')").bind(`t${uniq()}`, b.id, p!.id).run();
    expect((await post(`/products/${p!.id}/retest`, {})).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM product_tests WHERE product_id = ?").bind(p!.id).first()).toBeNull();
    const row = await env.DB.prepare("SELECT test_score, enabled, needs_review, disabled_reason, selected FROM products WHERE id = ?").bind(p!.id).first();
    expect(row).toEqual({ test_score: null, enabled: 0, needs_review: 0, disabled_reason: null, selected: 1 });
    expect((await env.DB.prepare("SELECT action FROM audit_log WHERE account_id = ? AND action = 'product_retest'").bind(b.id).first())).not.toBeNull();
  });
});

describe("remove a product", () => {
  const photo = (): string => `${uniq()}${"0".repeat(26)}`.toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 26) + ".jpg";
  const addProduct = async (accountId: string, source: string, images: string[]): Promise<string> => {
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, source, title, images_json, selected) VALUES (?, ?, ?, ?, 'Dup', ?, 1)`)
      .bind(pid, accountId, `${source}:${pid}`, source, JSON.stringify(images))
      .run();
    return pid;
  };

  it("deletes a hand-added product, its tests and test images, and its unused photo", async () => {
    const b = await liveBrand();
    const file = photo();
    await env.FILES.put(`products/${b.id}/${file}`, new Uint8Array([1]));
    const pid = await addProduct(b.id, "manual", [`https://app.test/pi/${b.id}/${file}`]);
    await env.FILES.put(`tests/${b.id}/${pid}/t1.jpg`, new Uint8Array([1]));
    await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score) VALUES (?, ?, ?, 'f', ?, 3)").bind(`t${uniq()}`, b.id, pid, `tests/${b.id}/${pid}/t1.jpg`).run();
    const r = (await (await post(`/products/${pid}/delete`, {})).json()) as { hidden: boolean };
    expect(r.hidden).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM products WHERE id = ?").bind(pid).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM product_tests WHERE product_id = ?").bind(pid).first()).toBeNull();
    expect(await env.FILES.get(`products/${b.id}/${file}`)).toBeNull();
    expect(await env.FILES.get(`tests/${b.id}/${pid}/t1.jpg`)).toBeNull();
    const a = await env.DB.prepare("SELECT meta_json FROM audit_log WHERE account_id = ? AND action = 'product_delete'").bind(b.id).first<{ meta_json: string }>();
    expect(JSON.parse(a!.meta_json)).toMatchObject({ product: pid, title: "Dup" });
  });

  it("keeps a photo that another product still uses", async () => {
    const b = await liveBrand();
    const file = photo();
    await env.FILES.put(`products/${b.id}/${file}`, new Uint8Array([1]));
    const url = `https://app.test/pi/${b.id}/${file}`;
    const dup = await addProduct(b.id, "manual", [url]);
    await addProduct(b.id, "manual", [url]);
    await post(`/products/${dup}/delete`, {});
    expect(await env.FILES.get(`products/${b.id}/${file}`)).not.toBeNull();
  });

  it("hides an imported product instead of deleting it, so the nightly sync can't bring it back", async () => {
    const b = await liveBrand();
    const pid = await addProduct(b.id, "shopify", ["https://shop.example/a.jpg"]);
    const r = (await (await post(`/products/${pid}/delete`, {})).json()) as { hidden: boolean };
    expect(r.hidden).toBe(true);
    const row = await env.DB.prepare("SELECT selected, enabled, brand_decision FROM products WHERE id = ?").bind(pid).first();
    expect(row).toEqual({ selected: 0, enabled: 0, brand_decision: "hidden" });
  });
});

import { appFetch } from "../src/lib/products.js";
describe("uploaded photos for the AI providers", () => {
  it("are read straight from storage, not fetched through the public site", async () => {
    const acct = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    const file = "01aaaaaaaaaaaaaaaaaaaaaaaa.png";
    await env.FILES.put(`products/${acct}/${file}`, new Uint8Array([9, 9, 9]), { httpMetadata: { contentType: "image/png" } });
    const r = await appFetch(env)(`https://app.test/pi/${acct}/${file}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([9, 9, 9]);
    expect((await appFetch(env)(`https://app.test/pi/${acct}/01bbbbbbbbbbbbbbbbbbbbbbbb.png`)).status).toBe(404);
  });
});

describe("admin: billing by hand (invoice or payment)", () => {
  async function pilotBrand(daysLeft: number) {
    const { accountId } = await createAccount(env, { brandName: `Early ${uniq()}`, email: `e-${uniq()}@brand.example`, plan: "starter", website: `https://early-${uniq()}.example` });
    const start = new Date(Date.now() - (14 - daysLeft) * 86_400_000);
    await env.DB.prepare("UPDATE accounts SET status = 'pilot', plan_id = 'pilot', target_plan_id = 'starter', pilot_started_at = ?, pilot_ends_at = ?, onboarding_step = 'pilot_live', setup_fee_due = 1 WHERE id = ?")
      .bind(start.toISOString(), new Date(start.getTime() + 14 * 86_400_000).toISOString(), accountId)
      .run();
    return accountId;
  }
  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it("paid during the pilot: the pilot keeps running, the paid months start the day after it ends", async () => {
    const id = await pilotBrand(5);
    const pilotEnd = cairoDay(new Date((await accountFacts(env, id))!.pilot_ends_at!));
    const r = await post(`/accounts/${id}/record`, { plan: "growth", months: 3, amountEgp: 22000, setupFee: false, paid: true, start: "after_pilot", method: "bank_transfer", reference: "TRX-9", key: `k-${uniq()}` });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { status: string; periodStart: string; periodEnd: string; number: string };
    expect(j.status).toBe("paid");
    expect(j.periodStart).toBe(addDays(pilotEnd, 1));
    const a = (await accountFacts(env, id))!;
    expect(a).toMatchObject({ status: "pilot", plan_id: "pilot", paid_through: null, target_plan_id: "growth", setup_fee_due: 0 });
    const inv = await env.DB.prepare("SELECT total, months, lines_json FROM invoices WHERE number = ?").bind(j.number).first<{ total: number; months: number; lines_json: string }>();
    expect(inv).toMatchObject({ total: 2_200_000, months: 3 });
    expect(JSON.parse(inv!.lines_json)[0].label).toBe("Growth plan, 3 months");
    // Nothing more to pay: no new invoice near the pilot's end.
    expect((await ensurePlanInvoice(env, a, new Date())).number).toBe(j.number);
    // The day the paid months start, the brand becomes a paying Growth customer until the end of month 3.
    const { reconcileAccount } = await import("../src/billing/ledger.js");
    await reconcileAccount(env, id, new Date(Date.parse(`${j.periodStart}T10:00:00Z`)));
    expect(await accountFacts(env, id)).toMatchObject({ status: "active", plan_id: "growth", paid_through: j.periodEnd, onboarding_step: "converted" });
  });

  it("'start today' and a setup fee line; or an open invoice to send, which replaces the old open one", async () => {
    const id = await pilotBrand(8);
    const old = await ensurePlanInvoice(env, (await accountFacts(env, id))!, new Date());
    const open = (await (await post(`/accounts/${id}/record`, { plan: "starter", months: 1, amountEgp: 6500, setupFee: true, paid: false, start: "after_pilot", key: `k-${uniq()}` })).json()) as { status: string; payUrl: string; number: string };
    expect(open.status).toBe("open");
    expect(open.payUrl).toMatch(/\/pay\//);
    expect(await env.DB.prepare("SELECT status FROM invoices WHERE id = ?").bind(old.id).first()).toEqual({ status: "void" });
    const lines = JSON.parse((await env.DB.prepare("SELECT lines_json FROM invoices WHERE number = ?").bind(open.number).first<{ lines_json: string }>())!.lines_json);
    expect(lines).toEqual([{ label: "Starter plan, one month", amount: 500_000 }, { label: "One-off setup", amount: 150_000 }]);

    // In the pilot the start must be chosen.
    expect((await post(`/accounts/${id}/record`, { plan: "starter", months: 1, amountEgp: 4000, setupFee: false, paid: true, method: "cash", key: `k-${uniq()}` })).status).toBe(400);
    const paid = (await (await post(`/accounts/${id}/record`, { plan: "starter", months: 1, amountEgp: 4000, setupFee: false, paid: true, start: "now", method: "cash", key: `k-${uniq()}` })).json()) as { periodStart: string };
    expect(paid.periodStart).toBe(cairoDay());
    expect(await accountFacts(env, id)).toMatchObject({ status: "active", plan_id: "starter" });
    expect((await post(`/accounts/${id}/record`, { plan: "starter", months: 13, amountEgp: 1, setupFee: false, paid: true, start: "now", key: `k-${uniq()}` })).status).toBe(400);
  });

  it("an open invoice set to 'start now', paid later by the brand, starts counting the day it's paid", async () => {
    const id = await pilotBrand(6);
    const open = (await (await post(`/accounts/${id}/record`, { plan: "starter", months: 2, amountEgp: 10000, setupFee: false, paid: false, start: "now", key: `k-${uniq()}` })).json()) as { number: string };
    const inv = (await env.DB.prepare("SELECT id, total FROM invoices WHERE number = ?").bind(open.number).first<{ id: string; total: number }>())!;
    await applyPayment(env, { invoiceId: inv.id, provider: "instapay_direct", txnId: `t-${uniq()}`, amount: inv.total, method: "instapay", actor: "telegram" });
    expect(await accountFacts(env, id)).toMatchObject({ status: "active", plan_id: "starter" });
    expect(await env.DB.prepare("SELECT period_start FROM invoices WHERE id = ?").bind(inv.id).first()).toEqual({ period_start: cairoDay() });
  });
});
