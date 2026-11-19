import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../src/lib/accounts.js";
import { retryBusyTests } from "../src/jobs.js";
import { BUSY_RETRY_SECONDS, testProduct } from "../src/onboarding/tests.js";
import { FallbackTryOnProvider, isTemporary, type TryOnProvider, type TryOnResult } from "../src/providers/tryon.js";
import type { ScoringProvider } from "../src/providers/scoring.js";
import { fakeJpeg } from "./helpers.js";

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const BUSY: TryOnResult = { ok: false, code: "provider_error", costMicroUsd: 0, retryable: true, detail: "HTTP 503 gemini-nano-banana-2.1 is currently experiencing high demand" };
const OK: TryOnResult = { ok: true, image: fakeJpeg("RESULT"), contentType: "image/jpeg", costMicroUsd: 39_000, productSynced: false };

/** A try-on provider that answers from a script: one result per call (the last one repeats). */
function scripted(results: TryOnResult[]): TryOnProvider & { calls: number } {
  const p = {
    name: "scripted",
    calls: 0,
    async tryOn() {
      return results[Math.min(p.calls++, results.length - 1)]!;
    },
    async deleteUserData() {
      return true;
    },
  };
  return p;
}
const scorer: ScoringProvider = {
  name: "score",
  score: async () => ({
    score: { overall: 5, garment_preserved: 5, person_preserved: 5, realism: 5, reason: "Looks right." } as never,
    costMicroUsd: 0,
  }),
};

async function product(): Promise<{ accountId: string; pid: string }> {
  const { accountId } = await createAccount(env, { brandName: `Busy ${uniq()}`, email: `busy-${uniq()}@brand.example`, plan: "starter", instagram: "@busy" });
  const pid = `p${uniq()}`;
  await env.DB.prepare(
    `INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, ?, 'Kaftan', '["https://cdn.shop.example/k.jpg"]', 'clothing', 1, 'manual')`,
  )
    .bind(pid, accountId, `manual:${pid}`)
    .run();
  return { accountId, pid };
}
const row = (pid: string) =>
  env.DB.prepare("SELECT test_score, enabled, disabled_reason, test_retry_at, test_busy_count, test_started_at FROM products WHERE id = ?")
    .bind(pid)
    .first<{ test_score: number | null; enabled: number; disabled_reason: string | null; test_retry_at: string | null; test_busy_count: number; test_started_at: string | null }>();
const dueNow = (pid: string) => env.DB.prepare("UPDATE products SET test_retry_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(pid).run();

beforeEach(async () => {
  await env.FILES.put("fixtures/model-a.jpg", fakeJpeg("MODEL-A"));
  await env.FILES.put("fixtures/model-b.jpg", fakeJpeg("MODEL-B"));
});

describe("Google overloaded during product tests", () => {
  it("a temporary error doesn't fail the product: it waits and retries, keeping previews that worked", async () => {
    const { accountId, pid } = await product();
    // Model A works, model B hits "high demand".
    const first = scripted([OK, BUSY]);
    expect(await testProduct(env, accountId, pid, { tryon: first, scorer })).toBe("busy");
    let r = await row(pid);
    expect(r).toMatchObject({ test_score: null, enabled: 0, test_busy_count: 1, test_started_at: null });
    expect(Date.parse(r!.test_retry_at!)).toBeGreaterThan(Date.now() + (BUSY_RETRY_SECONDS[0]! - 20) * 1000);
    // No failed test is recorded for the busy attempt; the good preview is kept.
    const tests = await env.DB.prepare("SELECT fixture, r2_key FROM product_tests WHERE product_id = ?").bind(pid).all<{ fixture: string; r2_key: string | null }>();
    expect(tests.results).toHaveLength(1);
    expect(tests.results[0]!.r2_key).not.toBeNull();

    // Before the wait is over: nothing runs.
    const early = scripted([OK]);
    expect(await testProduct(env, accountId, pid, { tryon: early, scorer })).toBe("already_tested");
    expect(early.calls).toBe(0);

    // After it: only model B is tried again (no repeat spend on A), and the product passes.
    await dueNow(pid);
    const second = scripted([OK]);
    expect(await testProduct(env, accountId, pid, { tryon: second, scorer })).toBe("enabled");
    expect(second.calls).toBe(1);
    r = await row(pid);
    expect(r).toMatchObject({ test_score: 5, enabled: 1, test_retry_at: null, test_busy_count: 0 });
  });

  it("after many hours of retries, a person checks it instead of retrying forever", async () => {
    const { accountId, pid } = await product();
    for (let i = 0; i < BUSY_RETRY_SECONDS.length; i++) {
      expect(await testProduct(env, accountId, pid, { tryon: scripted([BUSY]), scorer })).toBe("busy");
      await dueNow(pid);
    }
    expect(await testProduct(env, accountId, pid, { tryon: scripted([BUSY]), scorer })).toBe("needs_review");
    expect(await row(pid)).toMatchObject({ test_score: 0, test_retry_at: null });
  });

  it("a real product problem still fails, with a plain sentence for the brand", async () => {
    const { accountId, pid } = await product();
    const broken: TryOnResult = { ok: false, code: "provider_error", costMicroUsd: 0, retryable: false, detail: "product photos could not be fetched" };
    expect(await testProduct(env, accountId, pid, { tryon: scripted([broken]), scorer })).toBe("disabled");
    const r = await row(pid);
    expect(r!.disabled_reason).toBe("Our AI couldn't make a good preview of this product. Garrab support can take a look.");
    const t = await env.DB.prepare("SELECT reason FROM product_tests WHERE product_id = ? LIMIT 1").bind(pid).first<{ reason: string }>();
    expect(t!.reason).toContain("product photos could not be fetched"); // the detail stays for the admin
  });

  it("products already switched off by a 503 are repaired and tested again", async () => {
    const { accountId, pid } = await product();
    const old =
      "The try-on failed for this product (provider_error, gemini:gemini-nano-banana-2.1:room: provider_error HTTP 503 gemini-nano-banana-2.1 is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.).";
    await env.DB.batch([
      env.DB.prepare("UPDATE products SET test_score = 1, enabled = 0, disabled_reason = ? WHERE id = ?").bind(old, pid),
      env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, score, reason) VALUES (?, ?, ?, 'fixtures/model-a.jpg', 1, ?)").bind(`t${uniq()}`, accountId, pid, old),
    ]);
    // A product the brand hid on purpose is left alone.
    const hidden = await product();
    await env.DB.prepare("UPDATE products SET test_score = 1, enabled = 0, disabled_reason = ?, brand_decision = 'hidden' WHERE id = ?").bind(old, hidden.pid).run();
    await retryBusyTests(env, new Date());
    expect(await row(pid)).toMatchObject({ test_score: null, disabled_reason: null, test_busy_count: 0 });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM product_tests WHERE product_id = ?").bind(pid).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect((await row(hidden.pid))!.test_score).toBe(1);
    // And the re-test now works.
    expect(await testProduct(env, accountId, pid, { tryon: scripted([OK]), scorer })).toBe("enabled");
  });
});

describe("shopper try-on when Google is overloaded", () => {
  it("both models busy → waits a moment and tries once more", async () => {
    const primary = scripted([BUSY, OK]);
    const backup = scripted([BUSY]);
    const f = new FallbackTryOnProvider(primary, backup);
    f.retryWaitMs = 0;
    const r = await f.tryOn({} as never);
    expect(r.ok).toBe(true);
    expect([primary.calls, backup.calls]).toEqual([2, 1]);
  });

  it("refusals and bad photos are final (no extra calls)", async () => {
    const refused: TryOnResult = { ok: false, code: "content_policy", costMicroUsd: 0, retryable: false };
    const primary = scripted([refused]);
    const backup = scripted([OK]);
    expect((await new FallbackTryOnProvider(primary, backup).tryOn({} as never)).ok).toBe(false);
    expect(backup.calls).toBe(0);
    expect(isTemporary(BUSY)).toBe(true);
    expect(isTemporary(refused)).toBe(false);
  });
});
