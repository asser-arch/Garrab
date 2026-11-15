/**
 * Automatic quality test (brief §6.4): each selected product is tried on 2 consented stock
 * models (R2 `fixtures/`), each result is scored, and the product is
 *   ≥ 4 → enabled (brand still has to approve)   3 → needs review (Asser)   < 3 → disabled, with a plain reason.
 * The product's score is its LOWEST fixture score (conservative).
 * Tests have their own budget per account (CAPS.onboardingTestBudgetUsd).
 */
import { CAPS } from "@garrab/shared/plans";
import type { Env } from "../env.js";
import { ulid } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { recordUsage } from "../lib/metering.js";
import { sniffImage } from "../lib/photo.js";
import { scoringProvider, type ScoringProvider } from "../providers/scoring.js";
import { tryOnProvider, type TryOnProvider } from "../providers/tryon.js";

export const FIXTURE_PREFIX = "fixtures/";

export async function listFixtures(env: Env): Promise<string[]> {
  const l = await env.FILES.list({ prefix: FIXTURE_PREFIX });
  return l.objects.map((o) => o.key).filter((k) => /\.(jpe?g|png|webp)$/i.test(k)).sort().slice(0, 2);
}

async function testSpendMicroUsd(env: Env, accountId: string): Promise<number> {
  // Rolling 30 days: brands with no product limit can keep adding products month after month.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM usage_events WHERE account_id = ? AND kind IN ('test','score') AND created_at >= ?",
  )
    .bind(accountId, since)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

export type TestOutcome = "enabled" | "needs_review" | "disabled" | "skipped_budget" | "no_fixtures" | "already_tested";

export async function testProduct(
  env: Env,
  accountId: string,
  productId: string,
  deps: { tryon?: TryOnProvider; scorer?: ScoringProvider } = {},
): Promise<TestOutcome> {
  const product = await env.DB.prepare(
    "SELECT id, title, description, images_json, includes_headwear, test_score FROM products WHERE id = ? AND account_id = ? AND selected = 1",
  )
    .bind(productId, accountId)
    .first<{ id: string; title: string; description: string | null; images_json: string; includes_headwear: number; test_score: number | null }>();
  if (!product) return "already_tested";
  if (product.test_score !== null) return "already_tested"; // idempotent

  const fixtures = await listFixtures(env);
  if (fixtures.length === 0) return "no_fixtures";
  const tryon = deps.tryon ?? tryOnProvider(env);
  const scorer = deps.scorer ?? scoringProvider(env);
  const images = JSON.parse(product.images_json) as string[];
  const scores: number[] = [];
  let lastReason = "";

  for (const fixture of fixtures) {
    if ((await testSpendMicroUsd(env, accountId)) >= CAPS.onboardingTestBudgetUsd * 1_000_000) {
      // test_score 0 = "not tested"; stops the product being queued again.
      await env.DB.prepare("UPDATE products SET needs_review = 1, test_score = 0, disabled_reason = ? WHERE id = ?")
        .bind("Test budget reached; waiting for a manual check.", productId)
        .run();
      return "skipped_budget";
    }
    const obj = await env.FILES.get(fixture);
    if (!obj) continue;
    const photo = new Uint8Array(await obj.arrayBuffer());
    const photoType = sniffImage(photo);
    if (!photoType) continue;
    const oneTimeUserId = crypto.randomUUID();
    const r = await tryon.tryOn({
      product: {
        externalId: `${accountId}_${productId}`,
        title: product.title,
        description: product.description ?? "",
        imageUrls: images,
        includesHeadwear: product.includes_headwear === 1,
        synced: false,
      },
      photo,
      photoType,
      oneTimeUserId,
    });
    await tryon.deleteUserData(oneTimeUserId);
    await recordUsage(env, accountId, "test", tryon.name, r.ok, r.ok ? r.costMicroUsd : 0, r.ok ? null : r.code);
    const testId = ulid();
    if (!r.ok) {
      scores.push(1);
      lastReason =
        r.code === "content_policy"
          ? "This product can't be shown in try-on (content rules)."
          : `The try-on failed for this product (${r.code}${r.detail ? `, ${r.detail}` : ""}).`;
      await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, score, reason) VALUES (?, ?, ?, ?, 1, ?)")
        .bind(testId, accountId, productId, fixture, lastReason)
        .run();
      continue;
    }
    const key = `tests/${accountId}/${productId}/${testId}.${r.contentType.includes("png") ? "png" : "jpg"}`;
    await env.FILES.put(key, r.image, { httpMetadata: { contentType: r.contentType } });
    if (env.GENLOOK_API_KEY && env.GENLOOK_MOCK === "true" && !deps.tryon) {
      // Genlook's free test mode returns the model photo without the product, so a real score
      // would always reject it. Send it to a person instead of rejecting it.
      lastReason = "Test mode: the try-on is simulated, so check this product by hand.";
      scores.push(3);
      await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score, reason, cost_micro_usd) VALUES (?, ?, ?, ?, ?, 3, ?, 0)")
        .bind(testId, accountId, productId, fixture, key, lastReason)
        .run();
      continue;
    }
    const s = await scorer.score({ title: product.title, productImageUrl: images[0] ?? "", result: r.image, resultType: r.contentType });
    await recordUsage(env, accountId, "score", scorer.name, s.score !== null, s.costMicroUsd);
    const overall = s.score?.overall ?? 3; // scorer down → human review, never auto-enable
    lastReason = s.score?.reason ?? "Automatic check unavailable; needs a manual look.";
    scores.push(overall);
    await env.DB.prepare(
      "INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score, rubric_json, reason, cost_micro_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(testId, accountId, productId, fixture, key, overall, s.score ? JSON.stringify(s.score) : null, lastReason, r.costMicroUsd + s.costMicroUsd)
      .run();
  }
  if (scores.length === 0) return "no_fixtures";

  const final = Math.min(...scores);
  const outcome: TestOutcome = final >= 4 ? "enabled" : final === 3 ? "needs_review" : "disabled";
  await env.DB.prepare("UPDATE products SET test_score = ?, enabled = ?, needs_review = ?, disabled_reason = ? WHERE id = ?")
    .bind(final, outcome === "enabled" ? 1 : 0, outcome === "needs_review" ? 1 : 0, outcome === "disabled" ? lastReason : null, productId)
    .run();
  log("product_test", { account: accountId, code: outcome, count: final });
  return outcome;
}
