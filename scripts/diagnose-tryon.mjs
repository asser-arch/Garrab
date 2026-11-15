#!/usr/bin/env node
/**
 * Diagnose failing try-ons: reads the newest products from staging D1 (via a JSON file made by
 * `wrangler d1 execute --json`), checks each photo URL is reachable, then sends the newest product
 * to Genlook once with a stock photo and prints Genlook's exact answer. At most one preview.
 * Usage: node scripts/diagnose-tryon.mjs <products.json> <stock-photo.jpg>
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [file, photo] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(file, "utf8"))[0].results;
console.log(`Newest products: ${rows.length}`);
for (const r of rows) {
  const imgs = JSON.parse(r.images_json);
  console.log(`- ${r.title} | test_score=${r.test_score} | ${imgs.length} photo(s)`);
  for (const u of imgs.slice(0, 2)) {
    try {
      const h = await fetch(u, { method: "GET", headers: { "user-agent": "Mozilla/5.0" } });
      console.log(`    ${u} -> HTTP ${h.status} ${h.headers.get("content-type")} ${h.headers.get("content-length") ?? ""}`);
    } catch (e) {
      console.log(`    ${u} -> fetch failed: ${e.message}`);
    }
  }
}
const key = process.env.GENLOOK_API_KEY;
const p = rows[0];
if (!key || !p) process.exit(0);
const uid = `diag-${randomUUID()}`;
const form = new FormData();
form.set(
  "data",
  JSON.stringify({
    products: [{ externalId: `diag_${p.id}`, title: p.title, description: p.description ?? "", images: JSON.parse(p.images_json).slice(0, 6).map((url) => ({ source: { url } })) }],
    person: { image: { source: { fileKey: "person" } }, keepHeadCovering: true },
    externalUserId: uid,
    output: { watermark: false, aiLabel: false, keepForDays: 1 },
  }),
);
form.set("person", new Blob([readFileSync(photo)], { type: "image/jpeg" }), "photo.jpg");
const r = await fetch("https://api.genlook.app/tryon/v1/try-on/sync", { method: "POST", headers: { "x-api-key": key }, body: form });
const text = await r.text();
console.log(`\nGenlook try-on for "${p.title}": HTTP ${r.status}`);
console.log(text.replace(/https:\/\/[^"]+/g, "<url>").slice(0, 1500));
const d = await fetch(`https://api.genlook.app/tryon/v1/customers/${uid}`, { method: "DELETE", headers: { "x-api-key": key } });
console.log(`Cleanup DELETE customer: HTTP ${d.status}`);
