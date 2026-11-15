/**
 * TRY-ON BAKE-OFF: the same products and the same consented stock photos through every
 * provider, side by side, so Asser can judge quality before the first pilot.
 *
 *   pnpm --filter @garrab/api bakeoff -- --photos ../../fixtures --shop https://hayal-eg.com --count 10
 *   pnpm --filter @garrab/api bakeoff -- --photos ../../fixtures --products my-products.json --dry-run
 *
 * Providers run when their credentials are present:
 *   GENLOOK_API_KEY                      → genlook
 *   GEMINI_API_KEY                       → gemini:gemini-3.1-flash-image and gemini:gemini-nano-banana-2.1
 *   VERTEX_PROJECT (+ VERTEX_LOCATION,   → vertex:virtual-try-on-001
 *   VERTEX_ACCESS_TOKEN or `gcloud auth print-access-token`)
 * Limit with --providers genlook,gemini:gemini-3.1-flash-image,vertex
 *
 * Safety: only use consented stock photos (never shoppers). Spend is capped by --max-usd
 * (default 6). Genlook data is deleted after every call. Output: docs/bakeoff/<date>/index.html
 * (git-ignored: it contains the stock model's face).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { GOOGLE_PRICES, GeminiTryOnProvider, VertexTryOnProvider } from "../src/providers/google.ts";
import { GenlookProvider, type TryOnProvider } from "../src/providers/tryon.ts";

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2).filter((a) => a !== "--");
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);

const photosDir = arg("photos");
const shop = arg("shop");
const productsFile = arg("products");
const count = Number(arg("count") ?? "10");
const maxUsd = Number(arg("max-usd") ?? "6");
const dryRun = flag("dry-run");
const only = arg("providers")?.split(",");

if (!photosDir || (!shop && !productsFile)) {
  console.error("Usage: bakeoff --photos <dir> (--shop <https://store> | --products <file.json>) [--count 10] [--max-usd 6] [--providers a,b] [--dry-run]");
  process.exit(2);
}

interface Product {
  id: string;
  title: string;
  description: string;
  images: string[];
}

// ------------------------------------------------------------------ inputs

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function productsFromShop(base: string, n: number): Promise<Product[]> {
  const url = new URL("/products.json?limit=250", base);
  const r = await fetch(url, { headers: { "user-agent": "garrab-bakeoff/1.0" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  const j = (await r.json()) as { products: { id: number; title: string; body_html: string | null; images: { src: string }[] }[] };
  return j.products
    .filter((p) => p.images.length > 0)
    .slice(0, n)
    .map((p) => ({ id: String(p.id), title: p.title, description: stripHtml(p.body_html ?? "").slice(0, 600), images: p.images.slice(0, 4).map((i) => i.src) }));
}

const products: Product[] = shop
  ? await productsFromShop(shop, count)
  : (JSON.parse(readFileSync(resolve(productsFile!), "utf8")) as Product[]).slice(0, count);

const photos = readdirSync(resolve(photosDir))
  .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
  .map((f) => join(resolve(photosDir), f));
if (photos.length === 0) throw new Error(`No .jpg/.png/.webp photos in ${photosDir}`);

// ------------------------------------------------------------------ providers

interface Entry {
  provider: TryOnProvider;
  estUsd: number;
}
const entries: Entry[] = [];
if (process.env.GENLOOK_API_KEY) entries.push({ provider: new GenlookProvider(process.env.GENLOOK_API_KEY, 0.04, false), estUsd: 0.04 });
if (process.env.GEMINI_API_KEY) {
  for (const m of ["gemini-3.1-flash-image", "gemini-nano-banana-2.1"] as const) {
    entries.push({ provider: new GeminiTryOnProvider(process.env.GEMINI_API_KEY, m), estUsd: GOOGLE_PRICES[m].perOutputImage + 0.003 });
  }
}
if (process.env.VERTEX_PROJECT) {
  const token = async (): Promise<string> =>
    process.env.VERTEX_ACCESS_TOKEN ?? execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  entries.push({
    provider: new VertexTryOnProvider(process.env.VERTEX_PROJECT, process.env.VERTEX_LOCATION ?? "us-central1", token),
    estUsd: 0.06,
  });
}
const chosen = entries.filter((e) => !only || only.some((o) => e.provider.name === o || e.provider.name.startsWith(`${o}:`)));
if (chosen.length === 0) {
  console.error("No providers: set GENLOOK_API_KEY, GEMINI_API_KEY and/or VERTEX_PROJECT.");
  process.exit(2);
}

const cells = products.length * photos.length;
const estimate = chosen.reduce((s, e) => s + e.estUsd * cells, 0);
console.log(`${products.length} products × ${photos.length} photos × ${chosen.length} providers = ${cells * chosen.length} previews`);
for (const e of chosen) console.log(`  ${e.provider.name.padEnd(36)} ~${(e.estUsd * cells).toFixed(2)} USD`);
console.log(`Estimated total ~${estimate.toFixed(2)} USD (cap ${maxUsd} USD)`);
if (dryRun) process.exit(0);

// ------------------------------------------------------------------ run

const day = new Date().toISOString().slice(0, 10);
const outDir = resolve(join(process.cwd(), "..", "..", "docs", "bakeoff", day));
mkdirSync(join(outDir, "img"), { recursive: true });

interface Cell {
  product: number;
  photo: number;
  provider: string;
  file?: string;
  error?: string;
  seconds: number;
  usd: number;
}
const results: Cell[] = [];
let spent = 0;

const mime = (f: string): "image/jpeg" | "image/png" | "image/webp" =>
  extname(f).toLowerCase() === ".png" ? "image/png" : extname(f).toLowerCase() === ".webp" ? "image/webp" : "image/jpeg";

outer: for (const [pi, p] of products.entries()) {
  for (const [fi, photoPath] of photos.entries()) {
    for (const e of chosen) {
      if (spent + e.estUsd > maxUsd) {
        console.log(`Budget cap reached at ${spent.toFixed(2)} USD; stopping.`);
        break outer;
      }
      const oneTimeUserId = randomUUID();
      const t0 = Date.now();
      const r = await e.provider.tryOn({
        product: { externalId: `bakeoff_${p.id}`, title: p.title, description: p.description, imageUrls: p.images, includesHeadwear: false, synced: false },
        photo: new Uint8Array(readFileSync(photoPath)),
        photoType: mime(photoPath),
        oneTimeUserId,
      });
      await e.provider.deleteUserData(oneTimeUserId);
      const seconds = (Date.now() - t0) / 1000;
      const usd = r.ok ? r.costMicroUsd / 1e6 : 0;
      spent += r.ok ? usd : r.code === "content_policy" ? 0.003 : 0; // a refusal after the model ran may bill input tokens
      const cell: Cell = { product: pi, photo: fi, provider: e.provider.name, seconds, usd };
      if (r.ok) {
        const ext = r.contentType.includes("png") ? "png" : "jpg";
        cell.file = `img/p${pi}-f${fi}-${e.provider.name.replace(/[^a-z0-9.-]/gi, "_")}.${ext}`;
        writeFileSync(join(outDir, cell.file), r.image);
      } else {
        cell.error = r.code;
      }
      results.push(cell);
      console.log(`${r.ok ? "ok  " : "FAIL"} ${e.provider.name.padEnd(36)} ${p.title.slice(0, 30).padEnd(30)} ${basename(photoPath)} ${seconds.toFixed(1)}s ${r.ok ? "" : `${cell.error} ${r.detail ?? ""}`}`);
    }
  }
}

// ------------------------------------------------------------------ report

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const providerNames = chosen.map((e) => e.provider.name);
const summary = providerNames
  .map((n) => {
    const rs = results.filter((r) => r.provider === n);
    const ok = rs.filter((r) => r.file);
    const avg = ok.length ? ok.reduce((s, r) => s + r.seconds, 0) / ok.length : 0;
    const usd = rs.reduce((s, r) => s + r.usd, 0);
    return `<tr><td>${esc(n)}</td><td>${ok.length}/${rs.length}</td><td>${avg.toFixed(1)} s</td><td>${usd.toFixed(3)} USD</td><td>${ok.length ? (usd / ok.length).toFixed(3) : "-"} USD</td></tr>`;
  })
  .join("");

let rows = "";
for (const [pi, p] of products.entries()) {
  for (const [fi, photoPath] of photos.entries()) {
    const photoRel = `img/person-${fi}${extname(photoPath)}`;
    if (!existsSync(join(outDir, photoRel))) writeFileSync(join(outDir, photoRel), readFileSync(photoPath));
    const cellsHtml = providerNames
      .map((n) => {
        const c = results.find((r) => r.product === pi && r.photo === fi && r.provider === n);
        if (!c) return `<td class="skip">not run</td>`;
        const key = `p${pi}f${fi}|${n}`;
        const score = [1, 2, 3, 4, 5].map((s) => `<label><input type="radio" name="${esc(key)}" value="${s}">${s}</label>`).join("");
        return c.file
          ? `<td><img src="${c.file}" loading="lazy"><div class="meta">${c.seconds.toFixed(1)} s · ${c.usd.toFixed(3)} USD</div><div class="score" data-key="${esc(key)}">${score}</div></td>`
          : `<td class="err">failed: ${esc(c.error ?? "")}</td>`;
      })
      .join("");
    rows += `<tr><th><img src="${esc(p.images[0] ?? "")}" referrerpolicy="no-referrer"><div>${esc(p.title)}</div><img src="${photoRel}" class="person"></th>${cellsHtml}</tr>`;
  }
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Try-on bake-off ${day}</title>
<style>
:root{--forest:#143822;--cream:#F4F2EB;--paper:#FCFBF8;--ink:#0F1A13;--sand:#DDD6C9;--grey:#8A8B84;--peach:#F3D6A8}
body{font-family:Cairo,system-ui,sans-serif;background:var(--cream);color:var(--ink);margin:0;padding:24px}
h1{font-weight:400;margin:0 0 8px}h1 span{color:var(--grey)}
table{border-collapse:separate;border-spacing:8px}td,th{background:var(--paper);border:1px solid var(--sand);border-radius:16px;padding:8px;vertical-align:top;font-size:13px}
th{width:160px;text-align:left;font-weight:700}th img{width:100%;border-radius:8px}th .person{width:60%;margin-top:6px}
td img{width:260px;border-radius:8px;display:block}.meta{color:var(--grey);margin-top:4px}.err{color:#8a2f12;width:260px}.skip{color:var(--grey);width:260px}
.score label{margin-right:6px}.sum td{padding:6px 10px}
button{background:var(--forest);color:var(--paper);border:0;border-radius:999px;padding:10px 20px;font:700 14px Cairo,system-ui;cursor:pointer}
</style></head><body>
<h1>Try-on bake-off <span>${day}</span></h1>
<p>${products.length} products from ${esc(shop ?? productsFile ?? "")} × ${photos.length} stock photos. Spent ${spent.toFixed(2)} USD. Score each result 1 (unusable) to 5 (would show a shopper): garment faithful, person unchanged, no artifacts, plausible fit.</p>
<table class="sum"><tr><th>Provider</th><th>OK</th><th>Avg time</th><th>Total</th><th>Per preview</th></tr>${summary}</table>
<p><button id="dl">Download my scores (CSV)</button></p>
<table><tr><th>Product / photo</th>${providerNames.map((n) => `<th>${esc(n)}</th>`).join("")}</tr>${rows}</table>
<script>
document.getElementById("dl").onclick=function(){var l=["cell,provider,score"];document.querySelectorAll(".score").forEach(function(d){var c=d.querySelector("input:checked");var k=d.dataset.key.split("|");l.push(k[0]+","+k[1]+","+(c?c.value:""))});var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([l.join("\\n")],{type:"text/csv"}));a.download="bakeoff-scores.csv";a.click()};
</script></body></html>`;
writeFileSync(join(outDir, "index.html"), html);
writeFileSync(join(outDir, "results.json"), JSON.stringify({ day, shop, products, photos: photos.map((p) => basename(p)), results, spent }, null, 2));
console.log(`\nSpent ${spent.toFixed(2)} USD. Open ${join(outDir, "index.html")}`);
