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
import { isTemporary, tryOnProvider, type TryOnProvider } from "../providers/tryon.js";

export const FIXTURE_PREFIX = "fixtures/";

/**
 * Test photos: two stock models (`fixtures/model-*`) for fashion, two stock rooms (`fixtures/room-*`)
 * for home décor. Anything else in `fixtures/` (older uploads) counts as a model photo.
 */
export async function listFixtures(env: Env, kind: "person" | "room" = "person"): Promise<string[]> {
  const l = await env.FILES.list({ prefix: FIXTURE_PREFIX });
  return l.objects
    .map((o) => o.key)
    .filter((k) => /\.(jpe?g|png|webp)$/i.test(k))
    .filter((k) => (kind === "room" ? k.startsWith(`${FIXTURE_PREFIX}room-`) : !k.startsWith(`${FIXTURE_PREFIX}room-`)))
    .sort()
    .slice(0, 2);
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

/** What the brand reads when a product can't be offered (the AI checker's own words stay on the test record for the admin). */
export const FAILED_REASON = "Our AI couldn't make a good preview from this photo.";
export const CONTENT_RULES_REASON = "This product can't be shown in try-on (content rules).";
export const brandReason = (r: string): string => (r === CONTENT_RULES_REASON ? r : FAILED_REASON);

export type TestOutcome = "enabled" | "needs_review" | "disabled" | "skipped_budget" | "no_fixtures" | "already_tested" | "busy";

/** Temporary AI errors (overloaded, rate limited, timeout) retry after these waits; then a person checks. */
export const BUSY_RETRY_SECONDS = [60, 120, 300, 600, 900, 1800, 3600, 3600, 3600, 7200, 7200, 7200];


export async function testProduct(
  env: Env,
  accountId: string,
  productId: string,
  deps: { tryon?: TryOnProvider; scorer?: ScoringProvider } = {},
): Promise<TestOutcome> {
  const product = await env.DB.prepare(
    "SELECT id, title, description, images_json, includes_headwear, test_score, kind FROM products WHERE id = ? AND account_id = ? AND selected = 1",
  )
    .bind(productId, accountId)
    .first<{ id: string; title: string; description: string | null; images_json: string; includes_headwear: number; test_score: number | null; kind: string }>();
  if (!product) return "already_tested";
  if (product.test_score !== null) return "already_tested"; // idempotent
  // Claim the product before any paid call: only one test runs per product (a stale claim, e.g. a
  // crashed worker, expires after 15 minutes). Duplicate queue messages stop here at no cost.
  const claim = await env.DB.prepare(
    `UPDATE products SET test_started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND account_id = ? AND test_score IS NULL
        AND (test_retry_at IS NULL OR test_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND (test_started_at IS NULL OR test_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes'))`,
  )
    .bind(productId, accountId)
    .run();
  if (claim.meta.changes !== 1) return "already_tested";

  const mode = product.kind === "decor" ? "room" : "person";
  const all = await listFixtures(env, mode);
  if (all.length === 0) return "no_fixtures";
  // Big catalogues: one test preview per product (half the cost). Products alternate between the test
  // models/rooms, so the brand still sees both across its catalogue.
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN test_score IS NOT NULL THEN 1 ELSE 0 END) AS tested FROM products WHERE account_id = ? AND selected = 1",
  )
    .bind(accountId)
    .first<{ n: number; tested: number | null }>();
  const fixtures = (count?.n ?? 0) > CAPS.singleTestPreviewAbove ? [all[(count?.tested ?? 0) % all.length]!] : all;
  const tryon = deps.tryon ?? tryOnProvider(env, mode);
  const scorer = deps.scorer ?? scoringProvider(env);
  const images = JSON.parse(product.images_json) as string[];
  const scores: number[] = [];
  let lastReason = "";
  // Previews that already worked (an earlier attempt stopped by a temporary error) are kept: no repeat spend.
  const done = new Map(
    (await env.DB.prepare("SELECT fixture, score, reason FROM product_tests WHERE product_id = ? AND r2_key IS NOT NULL").bind(productId).all<{ fixture: string; score: number; reason: string | null }>()).results.map(
      (t) => [t.fixture, t],
    ),
  );

  for (const fixture of fixtures) {
    const prev = done.get(fixture);
    if (prev) {
      scores.push(prev.score);
      lastReason = prev.reason ?? lastReason;
      continue;
    }
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
    // AI previews vary from one try to the next: when the check scores a preview low (e.g. the outfit came
    // out wrong), make one more and keep the better of the two. The brand never sees the weaker one.
    let best: { key: string; score: number; rubric: string | null; reason: string; cost: number } | null = null;
    let spent = 0;
    let failed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && (await testSpendMicroUsd(env, accountId)) >= CAPS.onboardingTestBudgetUsd * 1_000_000) break;
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
      if (!r.ok && isTemporary(r)) {
        if (best) break; // keep the preview we already have
        // The AI service is busy, not the product: try again later instead of failing the product.
        const row = await env.DB.prepare("SELECT test_busy_count FROM products WHERE id = ?").bind(productId).first<{ test_busy_count: number }>();
        const n = (row?.test_busy_count ?? 0) + 1;
        const wait = BUSY_RETRY_SECONDS[n - 1];
        if (wait === undefined) {
          // Busy for many hours: hand it to a person (Retest in the admin) rather than retry forever.
          await env.DB.prepare(
            "UPDATE products SET test_score = 0, needs_review = 1, test_started_at = NULL, test_retry_at = NULL, test_busy_count = ?, disabled_reason = ? WHERE id = ?",
          )
            .bind(n, "The AI service was busy for hours; retest it from the admin.", productId)
            .run();
          log("product_test", { account: accountId, code: "busy_gave_up", count: n });
          return "needs_review";
        }
        await env.DB.prepare("UPDATE products SET test_started_at = NULL, test_retry_at = ?, test_busy_count = ?, disabled_reason = ? WHERE id = ?")
          .bind(new Date(Date.now() + (wait - 10) * 1000).toISOString(), n, "Google's AI is busy right now; we'll test this again in a few minutes.", productId)
          .run();
        if (!deps.tryon) await env.JOBS.send({ t: "test", a: accountId, p: productId }, { delaySeconds: wait });
        log("product_test", { account: accountId, code: "busy", count: n });
        return "busy";
      }
      if (!r.ok) {
        if (best) break;
        scores.push(1);
        // The brand sees a plain sentence; the technical detail stays on the test record (admin).
        const detail = `The try-on failed for this product (${r.code}${r.detail ? `, ${r.detail}` : ""}).`;
        lastReason = r.code === "content_policy" ? CONTENT_RULES_REASON : FAILED_REASON;
        await env.DB.prepare("INSERT INTO product_tests (id, account_id, product_id, fixture, score, reason) VALUES (?, ?, ?, ?, 1, ?)")
          .bind(ulid(), accountId, productId, fixture, detail)
          .run();
        failed = true;
        break;
      }
      const testId = ulid();
      const key = `tests/${accountId}/${productId}/${testId}.${r.contentType.includes("png") ? "png" : "jpg"}`;
      await env.FILES.put(key, r.image, { httpMetadata: { contentType: r.contentType } });
      if (env.GENLOOK_API_KEY && env.GENLOOK_MOCK === "true" && !deps.tryon) {
        // Genlook's free test mode returns the model photo without the product, so a real score
        // would always reject it. Send it to a person instead of rejecting it.
        best = { key, score: 3, rubric: null, reason: "Test mode: the try-on is simulated, so check this product by hand.", cost: 0 };
        break;
      }
      const sc = await scorer.score({ title: product.title, productImageUrl: images[0] ?? "", result: r.image, resultType: r.contentType, room: mode === "room" });
      await recordUsage(env, accountId, "score", scorer.name, sc.score !== null, sc.costMicroUsd);
      spent += r.costMicroUsd + sc.costMicroUsd;
      const overall = sc.score?.overall ?? 3; // scorer down → human review, never auto-enable
      const cand = { key, score: overall, rubric: sc.score ? JSON.stringify(sc.score) : null, reason: sc.score?.reason ?? "Automatic check unavailable; needs a manual look.", cost: 0 };
      if (!best || cand.score > best.score) {
        if (best) await env.FILES.delete(best.key);
        best = cand;
      } else await env.FILES.delete(key);
      if (best.score >= 4 || sc.score === null) break;
    }
    if (failed || !best) continue;
    scores.push(best.score);
    lastReason = best.reason;
    await env.DB.prepare(
      "INSERT INTO product_tests (id, account_id, product_id, fixture, r2_key, score, rubric_json, reason, cost_micro_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(ulid(), accountId, productId, fixture, best.key, best.score, best.rubric, best.reason, spent)
      .run();
  }
  if (scores.length === 0) return "no_fixtures";

  const final = Math.min(...scores);
  const outcome: TestOutcome = final >= 4 ? "enabled" : final === 3 ? "needs_review" : "disabled";
  await env.DB.prepare("UPDATE products SET test_score = ?, enabled = ?, needs_review = ?, disabled_reason = ?, test_retry_at = NULL, test_busy_count = 0 WHERE id = ?")
    .bind(final, outcome === "enabled" ? 1 : 0, outcome === "needs_review" ? 1 : 0, outcome === "disabled" ? brandReason(lastReason) : null, productId)
    .run();
  log("product_test", { account: accountId, code: outcome, count: final });
  return outcome;
}

/**
 * Product tests stopped by a temporary AI error (Google overloaded, rate limit, timeout):
 * - repair products that older code switched off for such an error, so they're tested again;
 * - retry the ones whose wait is over.
 * Runs every 15 minutes for all brands, and for one brand whenever it opens its portal (so a refresh
 * fixes things at once). Returns how many products were sent for testing.
 */
export async function retryBusyProducts(env: Env, accountId?: string): Promise<number> {
  const only = accountId ? " AND account_id = ?" : "";
  const bind = (q: D1PreparedStatement, ...v: unknown[]) => q.bind(...v, ...(accountId ? [accountId] : []));
  const broken = await bind(
    env.DB.prepare(
      `SELECT id, account_id FROM products
        WHERE test_score = 1 AND enabled = 0 AND brand_decision IS NULL
          AND (disabled_reason LIKE '%HTTP 503%' OR disabled_reason LIKE '%HTTP 429%' OR disabled_reason LIKE '%high demand%'
               OR disabled_reason LIKE '%(provider_busy%' OR disabled_reason LIKE '%(timeout%' OR disabled_reason LIKE '%HTTP 500%' OR disabled_reason LIKE '%HTTP 502%' OR disabled_reason LIKE '%HTTP 504%')${only}
        LIMIT 200`,
    ),
  ).all<{ id: string; account_id: string }>();
  for (const p of broken.results) {
    await env.DB.batch([
      // Only the failed attempts go; any preview that did work is kept and reused.
      env.DB.prepare("DELETE FROM product_tests WHERE product_id = ? AND r2_key IS NULL").bind(p.id),
      env.DB.prepare(
        "UPDATE products SET test_score = NULL, needs_review = 0, disabled_reason = NULL, test_started_at = NULL, test_retry_at = NULL, test_busy_count = 0 WHERE id = ?",
      ).bind(p.id),
    ]);
    await env.JOBS.send({ t: "test", a: p.account_id, p: p.id });
  }
  const due = await bind(
    env.DB.prepare(`SELECT id, account_id FROM products WHERE selected = 1 AND test_score IS NULL AND test_retry_at IS NOT NULL AND test_retry_at <= ?${only} LIMIT 200`),
    new Date().toISOString(),
  ).all<{ id: string; account_id: string }>();
  for (const p of due.results) await env.JOBS.send({ t: "test", a: p.account_id, p: p.id });
  const count = broken.results.length + due.results.length;
  if (count) log("busy_retry", { count, account: accountId ?? null });
  return count;
}
