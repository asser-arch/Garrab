/**
 * Automatic product import (brief §6.3). Verified on live Egyptian stores 13–14 Nov 2026:
 *  - Shopify: GET /products.json?limit=250&page=N (8/8 stores reachable; pagination works)
 *  - WooCommerce: GET /wp-json/wc/store/v1/products?per_page=100&page=N (3/3 reachable)
 *  - Other sites: robots.txt → sitemap(s) → product pages → JSON-LD Product
 *  - Instagram/WhatsApp-only: the brand adds products in the portal (form or CSV)
 * Every fetch respects robots.txt and identifies itself.
 */
import { CAPS, productLimit, type PlanId } from "@garrab/shared/plans";
import type { Env } from "../env.js";
import { sha256Hex, ulid } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { parseDimensions } from "../lib/dimensions.js";

export const BOT_UA = "GarrabBot/1.0 (+product import for brands that signed up; contact via the brand)";

export interface ImportedProduct {
  externalRef: string;
  title: string;
  description: string;
  images: string[];
  sizes: string[];
  kind: "clothing" | "accessory" | "decor";
  productUrl: string | null;
  urlPath: string | null;
  pricePiastres: number | null;
  source: "shopify" | "woocommerce" | "jsonld" | "manual";
}

type Fetcher = typeof fetch;

async function get(fetcher: Fetcher, url: string, accept = "application/json"): Promise<Response | null> {
  try {
    const r = await fetcher(url, { headers: { "user-agent": BOT_UA, accept }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// robots.txt (the subset that matters: groups for * or GarrabBot, Allow/Disallow, * and $)

export interface Robots {
  allowed(path: string): boolean;
  sitemaps: string[];
}

export function parseRobots(txt: string): Robots {
  const rules: { allow: boolean; pattern: string }[] = [];
  const sitemaps: string[] = [];
  let applies = false;
  let inAgentLines = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k === "sitemap") {
      sitemaps.push(v);
      continue;
    }
    if (k === "user-agent") {
      const ua = v.toLowerCase();
      const match = ua === "*" || ua.includes("garrabbot");
      applies = inAgentLines ? applies || match : match;
      inAgentLines = true;
      continue;
    }
    inAgentLines = false;
    if (!applies) continue;
    if ((k === "disallow" || k === "allow") && v) rules.push({ allow: k === "allow", pattern: v });
  }
  const toRe = (p: string): RegExp =>
    new RegExp("^" + p.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$").replace(/\$$/, "$"));
  return {
    sitemaps,
    allowed(path: string): boolean {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (toRe(r.pattern).test(path) && (!best || r.pattern.length > best.len || (r.pattern.length === best.len && r.allow)))
          best = { allow: r.allow, len: r.pattern.length };
      }
      return best ? best.allow : true;
    },
  };
}

async function robotsFor(fetcher: Fetcher, origin: string): Promise<Robots> {
  const r = await get(fetcher, `${origin}/robots.txt`, "text/plain");
  return parseRobots(r ? await r.text() : "");
}

// ---------------------------------------------------------------------------
// Normalisation helpers

const SIZE_OPTION = /^(size|sizes|taille|talla|größe|مقاس|المقاس|المقاسات|مقاسات)$/i;

export function guessKind(text: string): "clothing" | "accessory" | "decor" {
  const t = text.toLowerCase();
  if (/\b(cushion|pillow|vase|rug|carpet|lamp|candle|curtain|throw|frame|decor|décor|wall art|mirror|planter|tray|table|chair|sofa)\b|مخدة|سجادة|فازة|ديكور|ستارة|شمعة/.test(t))
    return "decor";
  if (/\b(bag|handbag|tote|clutch|wallet|necklace|ring|earring|earrings|bracelet|watch|sunglasses|glasses|hat|cap|belt|scarf|hijab|shawl|jewel|jewelry|jewellery)\b|شنطة|حلق|سلسلة|خاتم|طرحة|حجاب|ساعة|نظارة/.test(t))
    return "accessory";
  return "clothing";
}

export function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

const httpsUrl = (u: unknown): string | null => {
  if (typeof u !== "string") return null;
  const v = u.startsWith("//") ? `https:${u}` : u;
  return /^https?:\/\//.test(v) ? v : null;
};

// ---------------------------------------------------------------------------
// Shopify

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  product_type?: string;
  tags?: string[] | string;
  images: { src: string }[];
  options?: { name: string; values: string[] }[];
  variants?: { price: string }[];
}

export async function importShopify(fetcher: Fetcher, origin: string, max = 1000): Promise<ImportedProduct[] | null> {
  const out: ImportedProduct[] = [];
  for (let page = 1; out.length < max && page <= 8; page++) {
    const r = await get(fetcher, `${origin}/products.json?limit=250&page=${page}`);
    if (!r) return page === 1 ? null : out;
    const j = (await r.json().catch(() => null)) as { products?: ShopifyProduct[] } | null;
    if (!j?.products) return page === 1 ? null : out;
    for (const p of j.products) {
      const tags = Array.isArray(p.tags) ? p.tags.join(" ") : (p.tags ?? "");
      const prices = (p.variants ?? []).map((v) => Number(v.price)).filter((n) => Number.isFinite(n) && n > 0);
      out.push({
        externalRef: String(p.id),
        title: p.title,
        description: stripHtml(p.body_html ?? ""),
        images: p.images.map((i) => httpsUrl(i.src)).filter((x): x is string => !!x).slice(0, 8),
        sizes: (p.options ?? []).find((o) => SIZE_OPTION.test(o.name.trim()))?.values ?? [],
        kind: guessKind(`${p.title} ${p.product_type ?? ""} ${tags}`),
        productUrl: `${origin}/products/${p.handle}`,
        urlPath: `/products/${p.handle}`,
        pricePiastres: prices.length ? Math.round(Math.min(...prices) * 100) : null,
        source: "shopify",
      });
    }
    if (j.products.length < 250) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WooCommerce Store API

interface WooProduct {
  id: number;
  name: string;
  permalink: string;
  description?: string;
  short_description?: string;
  images: { src: string }[];
  prices?: { price?: string; currency_minor_unit?: number; price_range?: { min_amount?: string } | null };
  attributes?: { name: string; terms: { name: string }[] }[];
  categories?: { name: string }[];
}

export async function importWoo(fetcher: Fetcher, origin: string, max = 1000): Promise<ImportedProduct[] | null> {
  const out: ImportedProduct[] = [];
  for (let page = 1; out.length < max && page <= 10; page++) {
    const r = await get(fetcher, `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!r) return page === 1 ? null : out;
    const list = (await r.json().catch(() => null)) as WooProduct[] | null;
    if (!Array.isArray(list)) return page === 1 ? null : out;
    for (const p of list) {
      const unit = 10 ** (p.prices?.currency_minor_unit ?? 2);
      const raw = Number(p.prices?.price ?? 0) || Number(p.prices?.price_range?.min_amount ?? 0);
      let path: string | null = null;
      try {
        path = new URL(p.permalink).pathname;
      } catch {
        /* ignore */
      }
      out.push({
        externalRef: String(p.id),
        title: stripHtml(p.name),
        description: stripHtml(p.description || p.short_description || ""),
        images: p.images.map((i) => httpsUrl(i.src)).filter((x): x is string => !!x).slice(0, 8),
        sizes: (p.attributes ?? []).find((a) => SIZE_OPTION.test(a.name.trim()))?.terms.map((t) => t.name) ?? [],
        kind: guessKind(`${p.name} ${(p.categories ?? []).map((c) => c.name).join(" ")}`),
        productUrl: p.permalink,
        urlPath: path,
        pricePiastres: raw > 0 ? Math.round((raw / unit) * 100) : null,
        source: "woocommerce",
      });
    }
    if (list.length < 100) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generic: sitemap + JSON-LD

export function jsonLdProducts(html: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const o = n as Record<string, unknown>;
    const t = o["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) found.push(o);
    visit(o["@graph"]);
  };
  while ((m = re.exec(html))) {
    try {
      visit(JSON.parse(m[1] ?? ""));
    } catch {
      /* broken JSON-LD */
    }
  }
  return found;
}

async function sitemapUrls(fetcher: Fetcher, url: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const r = await get(fetcher, url, "application/xml,text/xml");
  if (!r) return [];
  const xml = await r.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((x) => x[1]!.replace(/&amp;/g, "&"));
  if (/<sitemapindex/i.test(xml)) {
    const children = locs.filter((l) => /product/i.test(l)).concat(locs.filter((l) => !/product/i.test(l))).slice(0, 5);
    const all: string[] = [];
    for (const c of children) all.push(...(await sitemapUrls(fetcher, c, depth + 1)));
    return all;
  }
  return locs;
}

export async function importJsonLd(fetcher: Fetcher, origin: string, robots: Robots, maxPages = 40): Promise<ImportedProduct[]> {
  const maps = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const urls: string[] = [];
  for (const sm of maps.slice(0, 3)) urls.push(...(await sitemapUrls(fetcher, sm)));
  const candidates = [...new Set(urls)]
    .filter((u) => {
      try {
        const x = new URL(u);
        return x.origin === origin && robots.allowed(x.pathname);
      } catch {
        return false;
      }
    })
    .sort((a, b) => Number(/product|shop|item/i.test(b)) - Number(/product|shop|item/i.test(a)))
    .slice(0, maxPages);
  const out: ImportedProduct[] = [];
  for (const u of candidates) {
    const r = await get(fetcher, u, "text/html");
    if (!r) continue;
    for (const p of jsonLdProducts(await r.text())) {
      const name = typeof p.name === "string" ? p.name : null;
      if (!name) continue;
      const imgs = (Array.isArray(p.image) ? p.image : [p.image]).map((i) => httpsUrl(typeof i === "object" && i ? (i as { url?: unknown }).url : i)).filter((x): x is string => !!x);
      const offers = (Array.isArray(p.offers) ? p.offers[0] : p.offers) as { price?: unknown; lowPrice?: unknown } | undefined;
      const price = Number(offers?.price ?? offers?.lowPrice ?? NaN);
      const ref = String(p.sku ?? p.productID ?? p.url ?? u);
      out.push({
        externalRef: ref.slice(0, 120),
        title: stripHtml(name),
        description: stripHtml(typeof p.description === "string" ? p.description : ""),
        images: imgs.slice(0, 8),
        sizes: [],
        kind: guessKind(`${name} ${typeof p.category === "string" ? p.category : ""}`),
        productUrl: u,
        urlPath: new URL(u).pathname,
        pricePiastres: Number.isFinite(price) && price > 0 ? Math.round(price * 100) : null,
        source: "jsonld",
      });
      break; // one product per page
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ranking: pick the products most likely to give good previews.

export function rankScore(p: Pick<ImportedProduct, "images" | "sizes" | "pricePiastres" | "kind">, maxPrice: number): number {
  const img = Math.min(p.images.length, 4); // more angles → better try-on
  const sizes = p.sizes.length > 0 ? 1 : 0;
  const price = maxPrice > 0 && p.pricePiastres ? (p.pricePiastres / maxPrice) * 2 : 0; // pricier items gain most from try-on
  return img + sizes + price;
}

/**
 * The brand's category decides the kind: a home décor brand only gets room preview (every product is
 * décor), a fashion brand only gets try-on on a person (never décor). Keywords only split clothing from
 * accessories.
 */
export function kindFor(category: "fashion" | "home", guessed: ImportedProduct["kind"]): ImportedProduct["kind"] {
  if (category === "home") return "decor";
  return guessed === "decor" ? "clothing" : guessed;
}

// ---------------------------------------------------------------------------
// Orchestration

export interface ImportResult {
  source: ImportedProduct["source"] | "none";
  imported: number;
  selected: number;
}

export async function importForAccount(env: Env, accountId: string, fetcher: Fetcher = fetch): Promise<ImportResult> {
  const acc = await env.DB.prepare("SELECT id, website, platform, plan_id, max_products FROM accounts WHERE id = ?").bind(accountId).first<{
    id: string;
    website: string | null;
    platform: string | null;
    plan_id: PlanId;
    max_products: number | null;
  }>();
  if (!acc?.website || acc.platform === "social_only") return { source: "none", imported: 0, selected: 0 };
  const origin = new URL(acc.website).origin;
  const robots = await robotsFor(fetcher, origin);

  let products: ImportedProduct[] | null = null;
  let source: ImportResult["source"] = "none";
  const tryShopify = acc.platform !== "woocommerce" && robots.allowed("/products.json");
  const tryWoo = acc.platform !== "shopify" && robots.allowed("/wp-json/wc/store/v1/products");
  if (tryShopify) products = await importShopify(fetcher, origin);
  if (products?.length) source = "shopify";
  if (!products?.length && tryWoo) {
    products = await importWoo(fetcher, origin);
    if (products?.length) source = "woocommerce";
  }
  if (!products?.length) {
    products = await importJsonLd(fetcher, origin, robots);
    if (products.length) source = "jsonld";
  }
  if (!products?.length) {
    log("import", { account: accountId, count: 0 });
    return { source: "none", imported: 0, selected: 0 };
  }
  const imported = await saveProducts(env, accountId, products);
  // The first automatic pick is capped (testing a whole catalogue on day one would burn the test budget).
  const limit = productLimit(acc.plan_id, acc.max_products);
  const selected = await autoSelect(env, accountId, Math.min(limit ?? CAPS.autoSelectProducts, CAPS.autoSelectProducts));
  log("import", { account: accountId, count: imported, kind: source });
  return { source, imported, selected };
}

export async function saveProducts(env: Env, accountId: string, products: ImportedProduct[]): Promise<number> {
  const usable = products.filter((p) => p.title && p.images.length > 0);
  const category = (await env.DB.prepare("SELECT category FROM accounts WHERE id = ?").bind(accountId).first<{ category: "fashion" | "home" }>())?.category ?? "fashion";
  const stmts = [];
  for (const p of usable) {
    const hash = await sha256Hex(JSON.stringify([p.title, p.description, p.images]));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO products (id, account_id, external_ref, url_path, product_url, source, title, description, images_json, sizes_json,
                               kind, content_hash, price_piastres, size_text, size_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, external_ref) DO UPDATE SET
           url_path = excluded.url_path, product_url = excluded.product_url, title = excluded.title,
           description = excluded.description, images_json = excluded.images_json, sizes_json = excluded.sizes_json,
           price_piastres = excluded.price_piastres, kind = excluded.kind,
           size_text = CASE WHEN products.size_source = 'brand' THEN products.size_text ELSE excluded.size_text END,
           size_source = CASE WHEN products.size_source = 'brand' THEN 'brand' ELSE excluded.size_source END,
           provider_synced_at = CASE WHEN products.content_hash = excluded.content_hash THEN products.provider_synced_at ELSE NULL END,
           content_hash = excluded.content_hash,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).bind(
        ulid(),
        accountId,
        p.externalRef,
        p.urlPath,
        p.productUrl,
        p.source,
        p.title.slice(0, 200),
        p.description,
        JSON.stringify(p.images),
        JSON.stringify(p.sizes),
        kindFor(category, p.kind),
        hash,
        p.pricePiastres,
        ...(() => {
          // Home décor: its real size from the shop's text, for room previews at the right scale.
          const size = kindFor(category, p.kind) === "decor" ? parseDimensions(p.title, p.description, p.sizes.join(" ")) : null;
          return [size, kindFor(category, p.kind) === "decor" ? "auto" : null];
        })(),
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return usable.length;
}

/** Select the top N products for testing if the brand hasn't picked any. Never stalls onboarding. */
export async function autoSelect(env: Env, accountId: string, n: number): Promise<number> {
  const already = await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ? AND selected = 1").bind(accountId).first<{ c: number }>();
  if ((already?.c ?? 0) > 0) return already!.c;
  const rows = await env.DB.prepare("SELECT id, images_json, sizes_json, price_piastres, kind FROM products WHERE account_id = ?")
    .bind(accountId)
    .all<{ id: string; images_json: string; sizes_json: string; price_piastres: number | null; kind: ImportedProduct["kind"] }>();
  const maxPrice = Math.max(0, ...rows.results.map((r) => r.price_piastres ?? 0));
  const ranked = rows.results
    .map((r) => ({ id: r.id, s: rankScore({ images: JSON.parse(r.images_json), sizes: JSON.parse(r.sizes_json), pricePiastres: r.price_piastres, kind: r.kind }, maxPrice) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n);
  if (ranked.length) {
    await env.DB.batch(ranked.map((r) => env.DB.prepare("UPDATE products SET selected = 1 WHERE id = ?").bind(r.id)));
  }
  return ranked.length;
}
