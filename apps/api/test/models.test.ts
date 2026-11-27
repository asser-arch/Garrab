import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../src/lib/accounts.js";
import { listFixtures, testProduct } from "../src/onboarding/tests.js";
import { MockScorer } from "../src/providers/scoring.js";
import type { TryOnProvider } from "../src/providers/tryon.js";
import { fakeJpeg } from "./helpers.js";

const ADMIN = { authorization: "Bearer test-admin-token-123456", "content-type": "application/json" };
const post = (path: string, body: unknown) => exports.default.fetch(`https://api.test/admin-api${path}`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

beforeEach(async () => {
  for (const k of ["model-a", "model-b", "model-c", "man-a", "man-b"]) await env.FILES.put(`fixtures/${k}.jpg`, fakeJpeg(k.toUpperCase()));
});

/** Records which stock photo each try-on used. */
function recorder(): TryOnProvider & { used: string[] } {
  const p = {
    name: "rec",
    used: [] as string[],
    async tryOn(req: { photo: Uint8Array }) {
      p.used.push(new TextDecoder().decode(req.photo).match(/MODEL-[ABC]|MAN-[AB]/)![0]);
      return { ok: true as const, image: fakeJpeg("R"), contentType: "image/jpeg", costMicroUsd: 1, productSynced: false };
    },
    async deleteUserData() {
      return true;
    },
  };
  return p;
}

async function brandWith(title: string, models?: "women" | "men" | "both") {
  const { accountId } = await createAccount(env, { brandName: `Models ${uniq()}`, email: `m-${uniq()}@brand.example`, plan: "starter", instagram: "@m" });
  if (models) await env.DB.prepare("UPDATE accounts SET test_models = ? WHERE id = ?").bind(models, accountId).run();
  const pid = `p${uniq()}`;
  await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, ?, ?, '["https://cdn.shop.example/x.jpg"]', 'clothing', 1, 'manual')`)
    .bind(pid, accountId, `manual:${pid}`, title)
    .run();
  return { accountId, pid };
}

describe("stock models: women, men, and the veiled model", () => {
  it("lists women (A veiled), men and rooms", async () => {
    expect(await listFixtures(env, "person")).toEqual(["fixtures/model-a.jpg", "fixtures/model-b.jpg"]);
    expect(await listFixtures(env, "person", "women", { noVeil: true })).toEqual(["fixtures/model-b.jpg", "fixtures/model-c.jpg"]);
    expect(await listFixtures(env, "person", "men")).toEqual(["fixtures/man-a.jpg", "fixtures/man-b.jpg"]);
    expect(await listFixtures(env, "person", "both", { noVeil: true })).toEqual(["fixtures/model-b.jpg", "fixtures/man-a.jpg"]);
  });

  it("a modest product is tested on the veiled model; one that shows skin never is", async () => {
    const modest = await brandWith("Long abaya");
    const t1 = recorder();
    await testProduct(env, modest.accountId, modest.pid, { tryon: t1, scorer: new MockScorer() });
    expect(t1.used).toEqual(["MODEL-A", "MODEL-B"]);
    const skin = await brandWith("Sleeveless mini dress [skin]");
    const t2 = recorder();
    await testProduct(env, skin.accountId, skin.pid, { tryon: t2, scorer: new MockScorer() });
    expect(t2.used).toEqual(["MODEL-B", "MODEL-C"]);
    expect(await env.DB.prepare("SELECT reveals_skin FROM products WHERE id = ?").bind(skin.pid).first()).toEqual({ reveals_skin: 1 });
  });

  it("a menswear brand is tested on the men", async () => {
    const b = await brandWith("Linen shirt", "men");
    const t = recorder();
    await testProduct(env, b.accountId, b.pid, { tryon: t, scorer: new MockScorer() });
    expect(t.used).toEqual(["MAN-A", "MAN-B"]);
  });

  it("admin: switch a brand to men, re-test all its products, and fix its name", async () => {
    const b = await brandWith("Linen shirt");
    await env.DB.prepare("UPDATE products SET test_score = 5, enabled = 1, brand_decision = 'approved', approved = 1 WHERE id = ?").bind(b.pid).run();
    expect((await post(`/accounts/${b.accountId}/test-models`, { models: "men" })).status).toBe(200);
    const r = (await (await post(`/accounts/${b.accountId}/retest-all`, {})).json()) as { count: number };
    expect(r.count).toBe(1);
    expect(await env.DB.prepare("SELECT test_score, enabled, approved FROM products WHERE id = ?").bind(b.pid).first()).toEqual({ test_score: null, enabled: 0, approved: 1 });
    expect(await env.DB.prepare("SELECT test_models FROM accounts WHERE id = ?").bind(b.accountId).first()).toEqual({ test_models: "men" });
    expect((await post(`/accounts/${b.accountId}/name`, { name: "  Cloud  " })).status).toBe(200);
    expect(await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(b.accountId).first()).toEqual({ name: "Cloud" });
    expect((await post(`/accounts/${b.accountId}/name`, { name: "x" })).status).toBe(400);
  });
});
