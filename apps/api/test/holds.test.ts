import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAccount } from "../src/lib/accounts.js";
import { sha256Hex, ulid } from "../src/lib/crypto.js";
import { advance } from "../src/onboarding/machine.js";

const APP = "https://app.test";
const ADMIN = { authorization: "Bearer test-admin-token-123456", "content-type": "application/json" };
const post = (path: string, body: unknown) => exports.default.fetch(`https://api.test/admin-api${path}`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const status = async (id: string) => (await env.DB.prepare("SELECT status, manual_hold FROM accounts WHERE id = ?").bind(id).first())!;

describe("admin holds always win", () => {
  it("a brand paused while setting up doesn't go live when it approves; Restore starts its pilot", async () => {
    const { accountId } = await createAccount(env, { brandName: `Held ${uniq()}`, email: `h-${uniq()}@brand.example`, plan: "starter", instagram: "@held" });
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, test_score, enabled, approved, brand_decision, source) VALUES (?, ?, ?, 'Dress', '["https://x.example/a.jpg"]', 'clothing', 1, 5, 1, 1, 'approved', 'manual')`)
      .bind(pid, accountId, `manual:${pid}`)
      .run();
    await env.DB.prepare("UPDATE accounts SET onboarding_step = 'products_tested', approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(accountId).run();
    expect((await post(`/accounts/${accountId}/pause`, { reason: "waiting for contract" })).status).toBe(200);
    await advance(env, accountId);
    expect(await status(accountId)).toEqual({ status: "paused", manual_hold: 1 });
    const al = await env.DB.prepare("SELECT message FROM alerts WHERE account_id = ? AND kind = 'needs_review' ORDER BY created_at DESC LIMIT 1").bind(accountId).first<{ message: string }>();
    expect(al!.message).toContain("Press Restore");
    // Restore: back to setting up, then onboarding carries on and the pilot starts.
    expect((await post(`/accounts/${accountId}/restore`, { reason: "contract signed" })).status).toBe(200);
    await advance(env, accountId);
    expect(await status(accountId)).toEqual({ status: "pilot", manual_hold: 0 });
  });

  it("Kill or Pause that isn't allowed changes nothing (no stuck 'held' flag)", async () => {
    const { accountId } = await createAccount(env, { brandName: `Arch ${uniq()}`, email: `a-${uniq()}@brand.example`, plan: "starter", instagram: "@arch" });
    await env.DB.prepare("UPDATE accounts SET status = 'archived', manual_hold = 0 WHERE id = ?").bind(accountId).run();
    expect((await post(`/accounts/${accountId}/pause`, { reason: "test pause" })).status).toBe(409);
    expect((await post(`/accounts/${accountId}/kill`, { reason: "test kill" })).status).toBe(409);
    expect(await status(accountId)).toEqual({ status: "archived", manual_hold: 0 });
  });
});

describe("product limit", () => {
  it("an over-limit choice is refused before anything is saved", async () => {
    const { accountId } = await createAccount(env, { brandName: `Lim ${uniq()}`, email: `l-${uniq()}@brand.example`, plan: "starter", instagram: "@lim" });
    await env.DB.prepare("UPDATE accounts SET max_products = 2 WHERE id = ?").bind(accountId).run();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const pid = `p${uniq()}`;
      ids.push(pid);
      await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, test_score, source) VALUES (?, ?, ?, ?, '["https://x.example/a.jpg"]', 'clothing', ?, ?, 'manual')`)
        .bind(pid, accountId, `manual:${pid}`, `P${i}`, i === 0 ? 1 : 0, i === 0 ? 5 : null)
        .run();
    }
    const u = (await env.DB.prepare("SELECT id FROM users WHERE account_id = ?").bind(accountId).first<{ id: string }>())!;
    const token = "L".repeat(20) + uniq().padEnd(20, "M").slice(0, 20);
    await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, '2099-01-01T00:00:00Z')").bind(ulid(), u.id, await sha256Hex(token)).run();
    const pick = (chosen: string[]) =>
      exports.default.fetch("https://api.test/portal-api/products/select", { method: "POST", headers: { cookie: `__Host-garrab_s=${token}`, origin: APP, "content-type": "application/json" }, body: JSON.stringify({ ids: chosen }) });
    // P0 is tested and stays chosen; adding P1 and P2 makes 3 > 2.
    const r = await pick([ids[1]!, ids[2]!]);
    expect(r.status).toBe(400);
    const sel = await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(accountId).first<{ c: number }>();
    expect(sel!.c).toBe(1); // nothing changed
    expect((await pick([ids[1]!])).status).toBe(200);
  });
});
