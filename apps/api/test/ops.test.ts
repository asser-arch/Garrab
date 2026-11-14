import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountFacts, ensurePlanInvoice } from "../src/billing/ledger.js";
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
    expect(i1.total).toBe(300_000);
    expect(i2.total).toBe(450_000); // 3,000 + 1,500 setup (plans.ts)
    expect(JSON.parse(i2.lines_json)).toEqual([expect.objectContaining({ amount: 300_000 }), { label: "One-off setup", amount: 150_000 }]);
  });
});

describe("request size limits", () => {
  it("refuses oversized bodies on JSON endpoints", async () => {
    const big = JSON.stringify({ brandName: "x".repeat(70 * 1024) });
    const r = await exports.default.fetch("https://api.test/v1/start", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: big });
    expect(r.status).toBe(413);
  });
});
