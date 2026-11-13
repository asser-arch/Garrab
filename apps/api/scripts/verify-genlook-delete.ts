/**
 * MANUAL PROVIDER-DELETE CHECK (brief §3).
 *
 * Proves that Genlook really deletes a shopper's photo and result when we call
 * DELETE /customers/{externalUserId}. Run it against the real API with a consented
 * stock photo (never a real shopper):
 *
 *   GENLOOK_API_KEY=gk_... pnpm --filter @garrab/api verify:genlook-delete -- fixtures/model-a.jpg
 *
 * Steps:
 *  1. Upload the photo with a fresh random externalUserId (keepForDays 1). Note the preview URL.
 *  2. Run one real try-on with that image (costs 1 credit, about 0.04 USD). Note the result URL.
 *  3. Confirm both URLs load (200).
 *  4. Call DELETE /customers/{externalUserId}; expect 204.
 *  5. Poll both URLs for up to 2 minutes; both must stop serving the image (403/404).
 *  6. Write a report to docs/privacy/ with the outcome. Commit it.
 *
 * Only after this PASSES and the automated privacy test passes may the setting
 * `privacy_claim_verified` be turned on (see demo/phase-1.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

const BASE = "https://api.genlook.app/tryon/v1";
const key = process.env.GENLOOK_API_KEY;
const photoPath = process.argv.filter((a) => a !== "--").at(2);
if (!key || !photoPath) {
  console.error("Usage: GENLOOK_API_KEY=gk_... verify-genlook-delete <consented-photo.jpg>");
  process.exit(2);
}

const headers = { "x-api-key": key };
const externalUserId = `verify-${randomUUID()}`;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), externalUserId, photo: basename(photoPath) };

async function status(url: string): Promise<number> {
  return (await fetch(url, { method: "GET" })).status;
}

async function main(): Promise<boolean> {
  const bytes = readFileSync(photoPath!);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
  form.set("externalUserId", externalUserId);
  form.set("keepForDays", "1");
  const up = await fetch(`${BASE}/images/upload`, { method: "POST", headers, body: form });
  const upJson = (await up.json()) as { imageId?: string; imageUrl?: string; code?: string };
  report.upload = { status: up.status, code: upJson.code ?? null };
  if (!upJson.imageId || !upJson.imageUrl) return false;

  const tr = await fetch(`${BASE}/try-on/sync`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      products: [
        {
          title: "Plain white cotton t-shirt",
          description: "Regular fit crew neck tee, short sleeves.",
          images: [{ source: { url: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800" } }],
        },
      ],
      person: { image: { source: { id: upJson.imageId } }, keepHeadCovering: true },
      externalUserId,
      output: { watermark: false, aiLabel: false },
    }),
    signal: AbortSignal.timeout(100_000),
  });
  const trJson = (await tr.json()) as { resultImageUrl?: string; code?: string };
  report.tryOn = { status: tr.status, code: trJson.code ?? null, keepHeadCoveringAccepted: tr.status !== 400 };
  const urls = [upJson.imageUrl, trJson.resultImageUrl].filter((u): u is string => !!u);

  report.before = await Promise.all(urls.map(status));
  const del = await fetch(`${BASE}/customers/${encodeURIComponent(externalUserId)}`, { method: "DELETE", headers });
  report.deleteStatus = del.status;
  if (del.status !== 204) return false;

  const deadline = Date.now() + 120_000;
  let after: number[] = [];
  while (Date.now() < deadline) {
    after = await Promise.all(urls.map(status));
    if (after.every((s) => s === 403 || s === 404 || s === 410)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  report.after = after;
  report.urlsChecked = urls.length;
  return urls.length === 2 && (report.before as number[]).every((s) => s === 200) && after.every((s) => s >= 400);
}

const pass = await main().catch((e: unknown) => {
  report.error = e instanceof Error ? e.message : String(e);
  return false;
});
report.result = pass ? "PASS" : "FAIL";
report.finishedAt = new Date().toISOString();
const dir = join(process.cwd(), "..", "..", "docs", "privacy");
mkdirSync(dir, { recursive: true });
const file = join(dir, `genlook-delete-${report.finishedAt.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`${report.result}: report written to ${file}`);
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
