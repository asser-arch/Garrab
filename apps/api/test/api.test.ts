import { cairoDay } from "../src/lib/time.js";
import { buildReport } from "../src/lib/report.js";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { invalidateStatus } from "../src/lib/db.js";
import { MockTryOnProvider } from "../src/providers/tryon.js";
import { APP, fakeJpeg, getConfig, postTryOn, seedAccount, setStatus } from "./helpers.js";

beforeEach(async () => {
  MockTryOnProvider.deleted = [];
  MockTryOnProvider.failNext = null;
  await env.DB.prepare("UPDATE settings SET value_json = 'false' WHERE key = 'global_kill'").run();
  invalidateStatus();
});

describe("/healthz", () => {
  it("is ok", async () => {
    const r = await exports.default.fetch("https://api.test/healthz");
    expect(await r.json()).toEqual({ ok: true, env: "test" });
  });
});

describe("/v1/config", () => {
  it("serves an active account from its own domain", async () => {
    const s = await seedAccount();
    const r = await getConfig(s);
    expect(r.acao).toBe(s.origin);
    expect(r.body.enabled).toBe(true);
    expect(r.body.products).toEqual([{ id: s.productId, ref: "1001", path: "/products/red-dress", kind: "clothing" }]);
    expect(r.body.frame).toBe(`${APP}/frame`);
    expect(typeof r.body.ctx).toBe("string");
  });

  it("www. and bare host are the same domain", async () => {
    const s = await seedAccount();
    const r = await getConfig(s, s.origin.replace("https://", "https://www."));
    expect(r.body.enabled).toBe(true);
  });

  it("domain lock: unknown origin gets enabled:false and no token", async () => {
    const s = await seedAccount();
    const r = await getConfig(s, "https://evil.example");
    expect(r.body).toEqual({ enabled: false });
  });

  it("unknown or revoked key is disabled", async () => {
    const s = await seedAccount();
    const r = await getConfig({ ...s, key: "gk_live_doesnotexist000000" });
    expect(r.body).toEqual({ enabled: false });
    await env.DB.prepare("UPDATE api_keys SET revoked_at = 'now' WHERE account_id = ?").bind(s.accountId).run();
    expect((await getConfig(s)).body).toEqual({ enabled: false });
  });

  for (const status of ["onboarding", "suspended", "archived", "paused", "cancelled", "expired"]) {
    it(`is disabled when status is ${status}`, async () => {
      const s = await seedAccount({ status });
      expect((await getConfig(s)).body).toEqual({ enabled: false });
    });
  }

  for (const status of ["pilot", "active", "past_due"]) {
    it(`serves when status is ${status}`, async () => {
      const s = await seedAccount({ status });
      expect((await getConfig(s)).body.enabled).toBe(true);
    });
  }

  it("global emergency switch disables everyone", async () => {
    const s = await seedAccount();
    await env.DB.prepare("UPDATE settings SET value_json = 'true' WHERE key = 'global_kill'").run();
    expect((await getConfig(s)).body).toEqual({ enabled: false });
  });

  it("size finder flag follows the plan", async () => {
    expect((await getConfig(await seedAccount({ plan: "starter" }))).body.sizeFinder).toBe(false);
    expect((await getConfig(await seedAccount({ plan: "growth" }))).body.sizeFinder).toBe(true);
  });
});

describe("/v1/tryon", () => {
  async function ctxFor(s: Awaited<ReturnType<typeof seedAccount>>): Promise<string> {
    return (await getConfig(s)).body.ctx as string;
  }

  it("returns the preview, meters it and deletes at the provider", async () => {
    const s = await seedAccount();
    const r = await postTryOn({ ctx: await ctxFor(s), product: s.productId, photo: fakeJpeg() });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe(APP);
    await r.arrayBuffer();
    const used = await env.DB.prepare("SELECT used FROM cycle_usage WHERE account_id = ?").bind(s.accountId).first<{ used: number }>();
    expect(used?.used).toBe(1);
    const ev = await env.DB.prepare("SELECT kind, provider, ok, cost_micro_usd FROM usage_events WHERE account_id = ?")
      .bind(s.accountId)
      .all();
    expect(ev.results).toEqual([{ kind: "tryon", provider: "mock", ok: 1, cost_micro_usd: 40000 }]);
    // waitUntil work has run by the time the test resumes in the same context; poll briefly.
    for (let i = 0; i < 20 && MockTryOnProvider.deleted.length === 0; i++) await new Promise((x) => setTimeout(x, 10));
    expect(MockTryOnProvider.deleted).toHaveLength(1);
    expect(MockTryOnProvider.deleted[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("only accepts calls from our own frame origin", async () => {
    const s = await seedAccount();
    const r = await postTryOn({ ctx: await ctxFor(s), product: s.productId, photo: fakeJpeg(), origin: s.origin });
    expect(r.status).toBe(403);
  });

  it("no token, no AI call", async () => {
    const s = await seedAccount();
    const r = await postTryOn({ ctx: "nope", product: s.productId, photo: fakeJpeg() });
    expect(r.status).toBe(401);
  });

  it("kill switch: a valid token stops working the moment the account is suspended", async () => {
    const s = await seedAccount();
    const ctx = await ctxFor(s);
    await setStatus(s.accountId, "suspended");
    const r = await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "unavailable" });
  });

  it("kill switch: global switch stops AI calls", async () => {
    const s = await seedAccount();
    const ctx = await ctxFor(s);
    await env.DB.prepare("UPDATE settings SET value_json = 'true' WHERE key = 'global_kill'").run();
    expect((await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() })).status).toBe(503);
  });

  it("domain removed after the token was issued → refused", async () => {
    const s = await seedAccount();
    const ctx = await ctxFor(s);
    await env.DB.prepare("DELETE FROM domains WHERE account_id = ?").bind(s.accountId).run();
    expect((await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() })).status).toBe(403);
  });

  it("cross-account: a token for brand A cannot use brand B's product", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const r = await postTryOn({ ctx: await ctxFor(a), product: b.productId, photo: fakeJpeg() });
    expect(r.status).toBe(404);
  });

  it("rejects non-images and missing photos", async () => {
    const s = await seedAccount();
    const ctx = await ctxFor(s);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>");
    expect((await postTryOn({ ctx, product: s.productId, photo: svg })).status).toBe(415);
    expect((await postTryOn({ ctx, product: s.productId })).status).toBe(400);
  });

  it("rejects photos over 8 MB", async () => {
    const s = await seedAccount();
    const big = new Uint8Array(8 * 1024 * 1024 + 10);
    big.set(fakeJpeg());
    expect((await postTryOn({ ctx: await ctxFor(s), product: s.productId, photo: big })).status).toBe(413);
  });

  it("allowance: pauses at 100% with no credit, never overshoots", async () => {
    const s = await seedAccount({ plan: "starter" });
    const ctx = await ctxFor(s);
    await env.DB.prepare("INSERT INTO cycle_usage (account_id, cycle_start, included, used) VALUES (?, '2026-11-01', 250, 249)")
      .bind(s.accountId)
      .run();
    expect((await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() })).status).toBe(200);
    const r = await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() });
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "quota" });
    const u = await env.DB.prepare("SELECT used FROM cycle_usage WHERE account_id = ?").bind(s.accountId).first<{ used: number }>();
    expect(u?.used).toBe(250);
  });

  it("failed generations don't count, are logged as failed, and still trigger the delete", async () => {
    const s = await seedAccount();
    MockTryOnProvider.failNext = "provider_error";
    const r = await postTryOn({ ctx: await ctxFor(s), product: s.productId, photo: fakeJpeg() });
    expect(r.status).toBe(422);
    const u = await env.DB.prepare("SELECT used FROM cycle_usage WHERE account_id = ?").bind(s.accountId).first<{ used: number }>();
    expect(u?.used).toBe(0);
    const ev = await env.DB.prepare("SELECT ok, cost_micro_usd FROM usage_events WHERE account_id = ?").bind(s.accountId).first();
    expect(ev).toEqual({ ok: 0, cost_micro_usd: 0 });
    for (let i = 0; i < 20 && MockTryOnProvider.deleted.length === 0; i++) await new Promise((x) => setTimeout(x, 10));
    expect(MockTryOnProvider.deleted).toHaveLength(1);
  });

  it("per-account daily cap auto-pauses the account and alerts", async () => {
    const s = await seedAccount({ plan: "starter" });
    const ctx = await ctxFor(s);
    const { cairoDay } = await import("../src/lib/time.js");
    await env.DB.prepare("INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, 'ai_calls', 1000)")
      .bind(s.accountId, cairoDay())
      .run();
    expect((await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() })).status).toBe(503);
    const a = await env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(s.accountId).first<{ status: string }>();
    expect(a?.status).toBe("paused");
    const al = await env.DB.prepare("SELECT kind FROM alerts WHERE account_id = ?").bind(s.accountId).first<{ kind: string }>();
    expect(al?.kind).toBe("account_cap");
    const audit = await env.DB.prepare("SELECT to_status, actor FROM audit_log WHERE account_id = ?").bind(s.accountId).first();
    expect(audit).toEqual({ to_status: "paused", actor: "system" });
  });
});

describe("rate limits", () => {
  it("limits try-ons per IP (in-memory key, never stored)", async () => {
    const s = await seedAccount();
    const ctx = (await getConfig(s)).body.ctx as string;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await postTryOn({ ctx, product: s.productId, photo: fakeJpeg(), ip: "192.0.2.200" })).status);
    expect(statuses.slice(0, 6).every((x) => x === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe("/v1/hosted and /v1/events", () => {
  it("hosted link serves an active brand and hides a suspended one", async () => {
    const s = await seedAccount();
    const r = await exports.default.fetch(`https://api.test/v1/hosted/${s.slug}/${s.productId}`);
    const body = (await r.json()) as { enabled: boolean; product: { title: string } };
    expect(body.enabled).toBe(true);
    expect(body.product.title).toBe("Red dress");
    await setStatus(s.accountId, "suspended");
    invalidateStatus();
    const r2 = await exports.default.fetch(`https://api.test/v1/hosted/${s.slug}/${s.productId}`);
    expect(await r2.json()).toEqual({ enabled: false });
  });

  it("brand page (bio link) lists live products and hides a suspended brand", async () => {
    const s = await seedAccount();
    const r = await exports.default.fetch(`https://api.test/v1/hosted/${s.slug}`);
    const body = (await r.json()) as { enabled: boolean; brand: { name: string }; products: { id: string; title: string }[] };
    expect(body.enabled).toBe(true);
    expect(body.products.map((p) => p.id)).toContain(s.productId);
    expect(JSON.stringify(body)).not.toMatch(/ctx|external_ref|description/);
    await setStatus(s.accountId, "suspended");
    invalidateStatus();
    expect(await (await exports.default.fetch(`https://api.test/v1/hosted/${s.slug}`)).json()).toEqual({ enabled: false });
  });

  it("counts anonymous events per account per day", async () => {
    const s = await seedAccount();
    const ctx = (await getConfig(s)).body.ctx as string;
    const send = (e: string, origin: string) =>
      exports.default.fetch("https://api.test/v1/events", {
        method: "POST",
        headers: { origin, "content-type": "text/plain" },
        body: JSON.stringify({ ctx, e }),
      });
    expect((await send("button_view", s.origin)).status).toBe(204);
    expect((await send("try_on_started", APP)).status).toBe(204);
    expect((await send("button_view", "https://evil.example")).status).toBe(403);
    expect((await send("made_up_event", s.origin)).status).toBe(400);
    const rows = await env.DB.prepare("SELECT metric, count FROM daily_counters WHERE account_id = ? ORDER BY metric")
      .bind(s.accountId)
      .all();
    expect(rows.results).toEqual([
      { metric: "button_view", count: 1 },
      { metric: "try_on_started", count: 1 },
    ]);
  });

  it("counts per product (own products only) and the server counts each preview, for the results report", async () => {
    const s = await seedAccount();
    const ctx = (await getConfig(s)).body.ctx as string;
    const send = (e: string, p: string) =>
      exports.default.fetch("https://api.test/v1/events", { method: "POST", headers: { origin: APP, "content-type": "text/plain" }, body: JSON.stringify({ ctx, e, p }) });
    expect((await send("link_view", s.productId)).status).toBe(204);
    expect((await send("buy_click", s.productId)).status).toBe(204);
    expect((await send("buy_click", "someoneElsesProduct1")).status).toBe(204); // counted in total only
    expect((await postTryOn({ ctx, product: s.productId, photo: fakeJpeg() })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT metric, count FROM daily_counters WHERE account_id = ? ORDER BY metric").bind(s.accountId).all<{ metric: string; count: number }>();
    const m = Object.fromEntries(rows.results.map((r) => [r.metric, r.count]));
    expect(m).toMatchObject({ link_view: 1, [`link_view@${s.productId}`]: 1, buy_click: 2, [`buy_click@${s.productId}`]: 1, preview: 1, [`preview@${s.productId}`]: 1 });
    expect(m["buy_click@someoneElsesProduct1"]).toBeUndefined();

    const r = await buildReport(env, s.accountId, cairoDay(), cairoDay());
    expect(r!.totals).toEqual({ views: 1, started: 0, previews: 1, buys: 2 });
    expect(r!.products).toEqual([expect.objectContaining({ id: s.productId, title: "Red dress", views: 1, previews: 1, buys: 1 })]);
    expect(r!.byDay).toEqual([{ day: cairoDay(), previews: 1, views: 1 }]);
    expect(r!.rates).toEqual({ tryRate: 0, buyRate: 100 }); // capped: a report never shows over 100%
  });
});
