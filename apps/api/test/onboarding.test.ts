import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount } from "../src/lib/accounts.js";
import { invalidateStatus } from "../src/lib/db.js";
import { cairoDay } from "../src/lib/time.js";
import { guessKind, importJsonLd, importShopify, importWoo, kindFor, parseRobots, rankScore, saveProducts } from "../src/onboarding/import.js";
import { advance, decideProduct, confirmApproval } from "../src/onboarding/machine.js";
import { testProduct } from "../src/onboarding/tests.js";
import { pilotClock, runScheduled, stuckDetector } from "../src/jobs.js";
import { fakeJpeg } from "./helpers.js";

const APP = "https://app.test";
const ADMIN = { authorization: "Bearer test-admin-token-123456" };

// ---------------------------------------------------------------- a fake internet of brand shops

const shopifyProducts = (n: number, title = (i: number) => `Linen dress ${i}`) => ({
  products: Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    title: title(i),
    handle: `item-${i}`,
    body_html: "<p>Relaxed fit <b>linen</b></p>",
    product_type: "Dress",
    tags: ["summer"],
    images: Array.from({ length: (i % 4) + 1 }, (_, k) => ({ src: `//cdn.shop.example/${i}-${k}.jpg` })),
    options: [{ name: "Taille", values: ["S", "M", "L"] }],
    variants: [{ price: String(500 + i * 50) }],
  })),
});

let installHtml = "<html>no script here</html>";

function route(url: string): Response {
  const u = new URL(url);
  if (u.hostname === "shopify.example") {
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /checkout\n");
    if (u.pathname === "/products.json") return Response.json(u.searchParams.get("page") === "1" ? shopifyProducts(14, (i) => (i === 0 ? "Floral cushion" : i === 1 ? "Abaya [low]" : i === 2 ? "Kaftan [review]" : `Linen dress ${i}`)) : { products: [] });
    return new Response(installHtml, { headers: { "content-type": "text/html" } });
  }
  if (u.hostname === "blocked.example") {
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
    return Response.json(shopifyProducts(3));
  }
  if (u.hostname === "cdn.shop.example") return new Response(fakeJpeg("PRODUCT"), { headers: { "content-type": "image/jpeg" } });
  return new Response("not found", { status: 404 });
}

beforeEach(async () => {
  installHtml = "<html>no script here</html>";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => route(input instanceof Request ? input.url : String(input)));
  await env.FILES.put("fixtures/model-a.jpg", fakeJpeg("MODEL-A"));
  await env.FILES.put("fixtures/model-b.jpg", fakeJpeg("MODEL-B"));
  await env.DB.prepare("UPDATE settings SET value_json = 'false' WHERE key = 'global_kill'").run();
  invalidateStatus();
});
afterEach(() => vi.restoreAllMocks());

const fetcher = (async (input: RequestInfo | URL) => route(String(input))) as typeof fetch;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function outbox(to: string): Promise<{ subject: string; html: string }[]> {
  return (await env.DB.prepare("SELECT subject, html FROM dev_outbox WHERE to_addr = ? ORDER BY created_at, id").bind(to).all<{ subject: string; html: string }>()).results;
}

// ---------------------------------------------------------------- importers

describe("import", () => {
  it("reads Shopify products.json: sizes (any language), prices, https images, kinds", async () => {
    const p = await importShopify(fetcher, "https://shopify.example");
    expect(p).toHaveLength(14);
    expect(p![3]).toMatchObject({ externalRef: "1003", sizes: ["S", "M", "L"], pricePiastres: 65000, urlPath: "/products/item-3", source: "shopify" });
    expect(p![3]!.images[0]).toBe("https://cdn.shop.example/3-0.jpg");
    expect(p![3]!.description).toBe("Relaxed fit linen");
    expect(p![0]!.kind).toBe("decor");
  });

  it("reads the WooCommerce Store API, using price_range for variable products", async () => {
    const woo = (async () =>
      Response.json([
        {
          id: 52059,
          name: "Wagd abaya",
          permalink: "https://woo.example/product/wagd-abaya/",
          description: "<p>Soft crepe</p>",
          images: [{ src: "https://woo.example/a.jpg" }],
          prices: { price: "0", currency_minor_unit: 2, price_range: { min_amount: "259000" } },
          attributes: [{ name: "Size", terms: [{ name: "L" }, { name: "XL" }] }],
          categories: [{ name: "Abayas" }],
        },
      ])) as unknown as typeof fetch;
    const p = await importWoo(woo, "https://woo.example");
    expect(p![0]).toMatchObject({ title: "Wagd abaya", sizes: ["L", "XL"], pricePiastres: 259000, urlPath: "/product/wagd-abaya/", source: "woocommerce" });
  });

  it("falls back to sitemap + JSON-LD, and respects robots.txt", async () => {
    const site = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      if (u.pathname === "/sitemap.xml") return new Response("<urlset><url><loc>https://jsonld.example/p/a</loc></url><url><loc>https://jsonld.example/private/b</loc></url></urlset>");
      if (u.pathname === "/p/a")
        return new Response(`<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Silk scarf","sku":"SC-1","image":["https://jsonld.example/s.jpg"],"offers":{"price":"450"}}]}</script>`);
      return new Response("<html></html>");
    }) as typeof fetch;
    const robots = parseRobots("User-agent: *\nDisallow: /private\n");
    const p = await importJsonLd(site, "https://jsonld.example", robots);
    expect(p).toEqual([expect.objectContaining({ externalRef: "SC-1", title: "Silk scarf", kind: "accessory", pricePiastres: 45000 })]);
  });

  it("robots.txt parser: longest rule wins, Allow beats Disallow on ties, wildcards", () => {
    const r = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-json/\nAllow: /wp-json/wc/store/\nDisallow: /*.json$\nSitemap: https://x.example/sm.xml");
    expect(r.allowed("/wp-json/wc/store/v1/products")).toBe(true);
    expect(r.allowed("/wp-json/wp/v2/users")).toBe(false);
    expect(r.allowed("/products.json")).toBe(false);
    expect(r.allowed("/products/red")).toBe(true);
    expect(r.sitemaps).toEqual(["https://x.example/sm.xml"]);
  });

  it("guesses kind in English and Arabic", () => {
    expect(guessKind("Velvet cushion cover")).toBe("decor");
    expect(guessKind("طرحة شيفون")).toBe("accessory");
    expect(guessKind("Linen wide-leg trousers")).toBe("clothing");
  });

  it("ranks products with more photos and sizes higher (décor too: home brands get room preview)", () => {
    const a = rankScore({ images: ["1", "2", "3", "4"], sizes: ["S"], pricePiastres: 1000, kind: "clothing" }, 1000);
    const b = rankScore({ images: ["1"], sizes: [], pricePiastres: 1000, kind: "clothing" }, 1000);
    const d = rankScore({ images: ["1", "2", "3", "4"], sizes: ["S"], pricePiastres: 1000, kind: "decor" }, 1000);
    expect(a).toBeGreaterThan(b);
    expect(d).toBe(a);
  });
});

describe("createAccount", () => {
  it("keeps the website scheme the brand gave, defaults to https, and locks the domain", async () => {
    const a = await createAccount(env, { brandName: "Scheme A", email: `sa-${uniq()}@x.example`, plan: "starter", website: "scheme-a.example/shop" });
    const b = await createAccount(env, { brandName: "Scheme B", email: `sb-${uniq()}@x.example`, plan: "starter", website: "http://scheme-b.example:8080" });
    const rows = await env.DB.prepare("SELECT a.website, d.host FROM accounts a JOIN domains d ON d.account_id = a.id WHERE a.id IN (?, ?) ORDER BY a.name")
      .bind(a.accountId, b.accountId)
      .all();
    expect(rows.results).toEqual([
      { website: "https://scheme-a.example", host: "scheme-a.example" },
      { website: "http://scheme-b.example:8080", host: "scheme-b.example:8080" },
    ]);
  });
});

// ---------------------------------------------------------------- the whole journey

describe("onboarding: invite → pilot_live with no admin action", () => {
  it("runs every step, sends every email, starts the pilot clock", async () => {
    const email = `owner-${uniq()}@shopify.example`;
    const { accountId } = await createAccount(env, { brandName: "Hayal Test", email, plan: "growth", website: "https://shopify.example", platform: "shopify" });
    const runTestsInline = (a: string, p: string) => testProduct(env, a, p);

    // invited → … → products_tested in one go (import + tests inline)
    expect(await advance(env, accountId, { fetcher, runTestsInline })).toBe("products_tested");
    const sel = await env.DB.prepare("SELECT title, test_score, enabled, needs_review, disabled_reason FROM products WHERE account_id = ? AND selected = 1 ORDER BY title")
      .bind(accountId)
      .all<{ title: string; test_score: number; enabled: number; needs_review: number; disabled_reason: string | null }>();
    expect(sel.results).toHaveLength(10); // pilot limit
    expect(sel.results.some((p) => p.title === "Floral cushion")).toBe(false); // decor not auto-picked
    const low = sel.results.find((p) => p.title === "Abaya [low]")!;
    const review = sel.results.find((p) => p.title === "Kaftan [review]")!;
    expect(low).toMatchObject({ test_score: 2, enabled: 0 });
    expect(low.disabled_reason).toBe("Our AI couldn't make a good preview from this photo."); // plain words for the brand
    expect(review).toMatchObject({ test_score: 3, enabled: 0, needs_review: 1 });
    expect(sel.results.filter((p) => p.enabled === 1)).toHaveLength(8);
    // 2 stock models × 10 products, results stored in R2 under tests/
    const tests = await env.DB.prepare("SELECT COUNT(*) AS c FROM product_tests WHERE account_id = ?").bind(accountId).first<{ c: number }>();
    expect(tests?.c).toBe(20);
    const stored = await env.FILES.list({ prefix: `tests/${accountId}/` });
    expect(stored.objects).toHaveLength(20);

    // Nothing is live yet: no approval.
    expect(await advance(env, accountId, { fetcher })).toBe("products_tested");
    const enabled = await env.DB.prepare("SELECT id FROM products WHERE account_id = ? AND enabled = 1 ORDER BY title LIMIT 2").bind(accountId).all<{ id: string }>();
    expect(await confirmApproval(env, accountId)).toBe(false); // must approve at least one first
    await decideProduct(env, accountId, enabled.results[0]!.id, "approved");
    await decideProduct(env, accountId, enabled.results[1]!.id, "hidden");
    expect(await confirmApproval(env, accountId)).toBe(true);
    // Approval puts the products live straight away (try-on links); the website line can come later.
    expect(await advance(env, accountId, { fetcher })).toBe("pilot_live");
    const key = (await env.DB.prepare("SELECT key_public FROM api_keys WHERE account_id = ?").bind(accountId).first<{ key_public: string }>())!.key_public;

    const acc = await env.DB.prepare("SELECT status, plan_id, target_plan_id, pilot_started_at, pilot_ends_at, cycle_start FROM accounts WHERE id = ?").bind(accountId).first<Record<string, string>>();
    expect(acc).toMatchObject({ status: "pilot", plan_id: "pilot", target_plan_id: "growth", cycle_start: cairoDay() });
    expect(Date.parse(acc!.pilot_ends_at!) - Date.parse(acc!.pilot_started_at!)).toBe(14 * 86_400_000);

    const subjects = (await outbox(email)).map((m) => m.subject);
    expect(subjects).toEqual([
      "Welcome to Garrab, Hayal Test",
      "Your try-on previews are ready to approve",
      "Your try-on link is live. Next: add Garrab to your shop",
      "Your 14-day Garrab pilot has started",
    ]);
    const steps = await env.DB.prepare("SELECT step, state FROM onboarding_steps WHERE account_id = ? ORDER BY entered_at").bind(accountId).all();
    expect(steps.results.map((s) => (s as { step: string }).step)).toEqual([
      "invited",
      "account_created",
      "products_imported",
      "products_tested",
      "products_approved",
      "installed",
      "pilot_live",
    ]);

    // Live: the approved product is served; the hidden one is not.
    const cfg = await exports.default.fetch(`https://api.test/v1/config?key=${key}`, { headers: { origin: "https://shopify.example" } });
    const body = (await cfg.json()) as { enabled: boolean; products: { id: string }[] };
    expect(body.enabled).toBe(true);
    expect(body.products.map((p) => p.id)).toEqual([enabled.results[0]!.id]);

    // The portal shows the pilot allowance from day one (0 of 300), before any preview.
    const cookie = await login(email);
    const me = (await (await portalGet("/me", cookie)).json()) as { usage: { used: number; included: number } };
    expect(me.usage).toEqual({ used: 0, included: 300, extra: 0 });
  });

  it("Instagram-only brand: waits for products, then hosted links count as installed", async () => {
    const email = `insta-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "Insta Abayas", email, plan: "starter", instagram: "@insta.abayas", whatsapp: "+201001234567" });
    expect(await advance(env, accountId, { fetcher })).toBe("account_created");
    expect((await outbox(email)).map((m) => m.subject)).toContain("Add your products to start the pilot");
    // Brand adds a product in the portal (simulated directly).
    await env.DB.prepare(
      `INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, 'manual:1', 'Black abaya', '["https://cdn.shop.example/x.jpg"]', 'clothing', 1, 'manual')`,
    )
      .bind(`p${uniq()}`, accountId)
      .run();
    expect(await advance(env, accountId, { fetcher, runTestsInline: (a, p) => testProduct(env, a, p) })).toBe("products_tested");
    const p = await env.DB.prepare("SELECT id FROM products WHERE account_id = ?").bind(accountId).first<{ id: string }>();
    await decideProduct(env, accountId, p!.id, "approved");
    await confirmApproval(env, accountId);
    expect(await advance(env, accountId, { fetcher })).toBe("pilot_live");
    const acc = await env.DB.prepare("SELECT buy_url FROM accounts WHERE id = ?").bind(accountId).first<{ buy_url: string }>();
    expect(acc?.buy_url).toBe("https://wa.me/201001234567");
  });

  it("a live pilot brand keeps adding products: new ones are tested, then go live once approved", async () => {
    const email = `more-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "More", email, plan: "starter", instagram: "@more", whatsapp: "+201001234567" });
    const add = async (title: string) => {
      const id = `p${uniq()}`;
      await env.DB.prepare(
        `INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, ?, ?, '["https://cdn.shop.example/x.jpg"]', 'clothing', 1, 'manual')`,
      )
        .bind(id, accountId, `manual:${id}`, title)
        .run();
      return id;
    };
    const inline = { fetcher, runTestsInline: (a: string, p: string) => testProduct(env, a, p) };
    const first = await add("Black abaya");
    expect(await advance(env, accountId, inline)).toBe("products_tested");
    await decideProduct(env, accountId, first, "approved");
    await confirmApproval(env, accountId);
    expect(await advance(env, accountId, inline)).toBe("pilot_live");

    // Added after going live: tested without leaving pilot_live, not served until approved.
    const second = await add("Olive kaftan");
    expect(await advance(env, accountId, inline)).toBe("pilot_live");
    const row = await env.DB.prepare("SELECT test_score, enabled, approved FROM products WHERE id = ?").bind(second).first<{ test_score: number | null; enabled: number; approved: number }>();
    expect(row?.test_score).not.toBeNull();
    expect(row).toMatchObject({ enabled: 1, approved: 0 });
    const slug = (await env.DB.prepare("SELECT slug FROM accounts WHERE id = ?").bind(accountId).first<{ slug: string }>())!.slug;
    const ids = async () => ((await (await exports.default.fetch(`https://api.test/v1/hosted/${slug}`)).json()) as { products: { id: string }[] }).products.map((p) => p.id);
    expect(await ids()).toEqual([first]);
    await decideProduct(env, accountId, second, "approved");
    invalidateStatus();
    expect((await ids()).sort()).toEqual([first, second].sort());
  });

  it("brand category: home décor brands only get décor products, fashion brands never do", async () => {
    expect(kindFor("home", "clothing")).toBe("decor");
    expect(kindFor("fashion", "decor")).toBe("clothing");
    expect(kindFor("fashion", "accessory")).toBe("accessory");
    const home = await createAccount(env, { brandName: "Beit Home", email: `home-${uniq()}@brand.example`, plan: "starter", niche: "home_decor" });
    const fashion = await createAccount(env, { brandName: "Abaya Co", email: `fash-${uniq()}@brand.example`, plan: "starter", category: "fashion" });
    const item = (t: string) => ({ externalRef: `r:${t}`, title: t, description: "", images: ["https://cdn.shop.example/1.jpg"], sizes: [], kind: guessKind(t), productUrl: null, urlPath: null, pricePiastres: null, source: "manual" as const });
    await saveProducts(env, home.accountId, [item("Linen cushion"), item("Cotton dress")]);
    await saveProducts(env, fashion.accountId, [item("Wrap dress with throw collar"), item("Leather bag")]);
    const kinds = async (a: string) =>
      (await env.DB.prepare("SELECT title, kind FROM products WHERE account_id = ? ORDER BY title").bind(a).all<{ title: string; kind: string }>()).results.map((r) => `${r.title}=${r.kind}`);
    expect(await kinds(home.accountId)).toEqual(["Cotton dress=decor", "Linen cushion=decor"]);
    expect(await kinds(fashion.accountId)).toEqual(["Leather bag=accessory", "Wrap dress with throw collar=clothing"]);
    expect((await env.DB.prepare("SELECT category FROM accounts WHERE id = ?").bind(home.accountId).first<{ category: string }>())?.category).toBe("home");
  });

  it("home décor brand: products are tested in the two test rooms (never on the models), then go live with room preview", async () => {
    await env.FILES.put("fixtures/room-a.jpg", fakeJpeg("ROOM-A"));
    await env.FILES.put("fixtures/room-b.jpg", fakeJpeg("ROOM-B"));
    const { accountId } = await createAccount(env, { brandName: "Beit Rugs", email: `rugs-${uniq()}@brand.example`, plan: "starter", category: "home", instagram: "@beitrugs" });
    const pid = `p${uniq()}`;
    await env.DB.prepare(
      `INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, 'manual:rug', 'Berber rug', '["https://cdn.shop.example/rug.jpg"]', 'decor', 1, 'manual')`,
    )
      .bind(pid, accountId)
      .run();
    expect(await advance(env, accountId, { fetcher, runTestsInline: (a, p) => testProduct(env, a, p) })).toBe("products_tested");
    const fx = (await env.DB.prepare("SELECT fixture FROM product_tests WHERE product_id = ? ORDER BY fixture").bind(pid).all<{ fixture: string }>()).results.map((r) => r.fixture);
    expect(fx).toEqual(["fixtures/room-a.jpg", "fixtures/room-b.jpg"]);
    await decideProduct(env, accountId, pid, "approved");
    await confirmApproval(env, accountId);
    expect(await advance(env, accountId, { fetcher })).toBe("pilot_live");
    const slug = (await env.DB.prepare("SELECT slug FROM accounts WHERE id = ?").bind(accountId).first<{ slug: string }>())!.slug;
    invalidateStatus();
    const page = (await (await exports.default.fetch(`https://api.test/v1/hosted/${slug}`)).json()) as { products: { id: string; kind: string }[] };
    expect(page.products).toEqual([expect.objectContaining({ id: pid, kind: "decor" })]);
    const one = (await (await exports.default.fetch(`https://api.test/v1/hosted/${slug}/${pid}`)).json()) as { enabled: boolean; ctx: string; product: { kind: string } };
    expect(one).toMatchObject({ enabled: true, product: { kind: "decor" } });

    // A shopper's room photo → a room preview, counted as "room" usage, and deleted at the provider.
    const form = new FormData();
    form.set("ctx", one.ctx);
    form.set("product", pid);
    form.set("turnstile", "ok");
    form.set("photo", new Blob([fakeJpeg("MY-ROOM")], { type: "image/jpeg" }), "room.jpg");
    const r = await exports.default.fetch("https://api.test/v1/tryon", { method: "POST", headers: { origin: APP }, body: form });
    expect(r.status).toBe(200);
    const u = await env.DB.prepare("SELECT kind FROM usage_events WHERE account_id = ? AND kind IN ('tryon','room')").bind(accountId).all<{ kind: string }>();
    expect(u.results.map((x) => x.kind)).toEqual(["room"]);
    await env.FILES.delete(["fixtures/room-a.jpg", "fixtures/room-b.jpg"]);
  });

  it("fashion brands are never tested in the rooms", async () => {
    await env.FILES.put("fixtures/room-a.jpg", fakeJpeg("ROOM-A"));
    const { accountId } = await createAccount(env, { brandName: "Abaya House", email: `ab-${uniq()}@brand.example`, plan: "starter", instagram: "@abayahouse" });
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, 'manual:a', 'Black abaya', '["https://cdn.shop.example/a.jpg"]', 'clothing', 1, 'manual')`)
      .bind(pid, accountId)
      .run();
    await testProduct(env, accountId, pid);
    const fx = (await env.DB.prepare("SELECT fixture FROM product_tests WHERE product_id = ? ORDER BY fixture").bind(pid).all<{ fixture: string }>()).results.map((r) => r.fixture);
    expect(fx).toEqual(["fixtures/model-a.jpg", "fixtures/model-b.jpg"]);
    await env.FILES.delete("fixtures/room-a.jpg");
  });

  it("more than 15 products: one test preview per product, alternating between the test models", async () => {
    const { accountId } = await createAccount(env, { brandName: "Big Catalogue", email: `big-${uniq()}@brand.example`, plan: "starter", instagram: "@big" });
    const add = async (count: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const pid = `p${uniq()}`;
        ids.push(pid);
        await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, ?, 'Dress', '["https://cdn.shop.example/d.jpg"]', 'clothing', 1, 'manual')`)
          .bind(pid, accountId, `manual:${pid}`)
          .run();
      }
      return ids;
    };
    const tests = async (pid: string) =>
      (await env.DB.prepare("SELECT fixture FROM product_tests WHERE product_id = ?").bind(pid).all<{ fixture: string }>()).results.map((r) => r.fixture);
    // 15 products: still two previews each.
    const first = await add(15);
    await testProduct(env, accountId, first[0]!);
    expect(await tests(first[0]!)).toHaveLength(2);
    // The 16th product on: one preview each, and both models are used across the catalogue.
    const more = await add(5);
    const used = new Set<string>();
    for (const pid of [...first.slice(1, 5), ...more]) {
      await testProduct(env, accountId, pid);
      const f = await tests(pid);
      expect(f).toHaveLength(1);
      used.add(f[0]!);
    }
    expect([...used].sort()).toEqual(["fixtures/model-a.jpg", "fixtures/model-b.jpg"]);
  });

  it("a product is tested once even when duplicate test messages arrive together (no repeat AI spend)", async () => {
    const { accountId } = await createAccount(env, { brandName: "Dup", email: `dup-${uniq()}@brand.example`, plan: "starter", instagram: "@dup" });
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, ?, 'Dress', '["https://cdn.shop.example/d.jpg"]', 'clothing', 1, 'manual')`)
      .bind(pid, accountId, `manual:${pid}`)
      .run();
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => testProduct(env, accountId, pid)));
    expect(outcomes.filter((o) => o !== "already_tested")).toHaveLength(1);
    const spent = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ? AND kind = 'test'").bind(accountId).first<{ n: number }>();
    expect(spent?.n).toBe(2); // one test = the two test models, once
  });

  it("respects robots.txt: a store that disallows everything is not crawled", async () => {
    const email = `blocked-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "Blocked", email, plan: "starter", website: "https://blocked.example" });
    expect(await advance(env, accountId, { fetcher })).toBe("account_created");
    const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM products WHERE account_id = ?").bind(accountId).first<{ c: number }>();
    expect(c?.c).toBe(0);
  });

  it("test budget cap stops tests and sends the product to review", async () => {
    const { accountId } = await createAccount(env, { brandName: "Budget", email: `b-${uniq()}@x.example`, plan: "starter", website: "https://shopify.example" });
    await env.DB.prepare(
      `INSERT INTO products (id, account_id, external_ref, title, images_json, selected) VALUES ('bp${uniq()}', ?, 'r1', 'Dress', '["https://cdn.shop.example/1.jpg"]', 1)`,
    )
      .bind(accountId)
      .run();
    await env.DB.prepare("INSERT INTO usage_events (id, account_id, kind, provider, ok, cost_micro_usd) VALUES (?, ?, 'test', 'mock', 1, 3000000)").bind(`u${uniq()}`, accountId).run();
    const p = await env.DB.prepare("SELECT id FROM products WHERE account_id = ?").bind(accountId).first<{ id: string }>();
    expect(await testProduct(env, accountId, p!.id)).toBe("skipped_budget");
    expect(await testProduct(env, accountId, p!.id)).toBe("already_tested"); // never re-queued
  });
});

// ---------------------------------------------------------------- portal + auth

async function login(email: string): Promise<string> {
  await exports.default.fetch("https://api.test/portal-api/auth/request", {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const mails = await outbox(email);
  const token = /#t=([A-Za-z0-9]{40})/.exec(mails.at(-1)!.html)![1]!;
  const r = await exports.default.fetch("https://api.test/portal-api/auth/verify", {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(r.status).toBe(200);
  const cookie = r.headers.get("set-cookie")!;
  expect(cookie).toMatch(/__Host-garrab_s=[A-Za-z0-9]{40}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  return cookie.split(";")[0]!;
}

const portalGet = (path: string, cookie: string) => exports.default.fetch(`https://api.test/portal-api${path}`, { headers: { cookie } });
const portalPost = (path: string, cookie: string, body: unknown, origin = APP) =>
  exports.default.fetch(`https://api.test/portal-api${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("magic links and sessions", () => {
  it("single use, 15 minutes, bound to the email, no account probing", async () => {
    const email = `ml-${uniq()}@brand.example`;
    await createAccount(env, { brandName: "ML", email, plan: "starter" });
    const cookie = await login(email);
    expect((await portalGet("/me", cookie)).status).toBe(200);

    // Re-using the same link fails.
    const token = /#t=([A-Za-z0-9]{40})/.exec((await outbox(email)).at(-1)!.html)![1]!;
    const again = await exports.default.fetch("https://api.test/portal-api/auth/verify", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(401);

    // Expired link fails.
    await exports.default.fetch("https://api.test/portal-api/auth/request", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const t2 = /#t=([A-Za-z0-9]{40})/.exec((await outbox(email)).at(-1)!.html)![1]!;
    await env.DB.prepare("UPDATE magic_links SET expires_at = '2000-01-01T00:00:00Z' WHERE email = ? AND used_at IS NULL").bind(email).run();
    expect(
      (await exports.default.fetch("https://api.test/portal-api/auth/verify", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ token: t2 }) })).status,
    ).toBe(401);

    // Link bound to the email: if the user's email changes, old links stop working.
    await exports.default.fetch("https://api.test/portal-api/auth/request", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const t3 = /#t=([A-Za-z0-9]{40})/.exec((await outbox(email)).at(-1)!.html)![1]!;
    await env.DB.prepare("UPDATE users SET email = ? WHERE email = ?").bind(`changed-${email}`, email).run();
    expect(
      (await exports.default.fetch("https://api.test/portal-api/auth/verify", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ token: t3 }) })).status,
    ).toBe(401);

    // Unknown email: same answer, no email sent.
    const r = await exports.default.fetch("https://api.test/portal-api/auth/request", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@nowhere.example" }),
    });
    expect(await r.json()).toEqual({ ok: true });
    expect(await outbox("nobody@nowhere.example")).toHaveLength(0);
  });

  it("6-digit code: signs in, single use, 5 wrong tries lock it, and a link scanner can't burn it", async () => {
    const email = `code-${uniq()}@brand.example`;
    await createAccount(env, { brandName: "Code", email, plan: "starter" });
    const post = (path: string, body: unknown) =>
      exports.default.fetch(`https://api.test/portal-api${path}`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/auth/request", { email });
    const mail = (await outbox(email)).at(-1)!;
    const code = /(\d{6})$/.exec(mail.subject)![1]!;
    expect(mail.html).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
    // Opening the link page (what Outlook Safe Links does) uses nothing: only POST /auth/verify does.
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await post("/auth/code", { email, code: wrong })).status).toBe(401);
    const ok = await post("/auth/code", { email: email.toUpperCase(), code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect((await portalGet("/me", cookie)).status).toBe(200);
    expect((await post("/auth/code", { email, code })).status).toBe(401); // used

    // Five wrong tries lock that code, even the right one after.
    await post("/auth/request", { email });
    const c2 = /(\d{6})$/.exec((await outbox(email)).at(-1)!.subject)![1]!;
    const bad = c2 === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await post("/auth/code", { email, code: bad });
    expect((await post("/auth/code", { email, code: c2 })).status).toBe(401);
    // A fresh code works again.
    await post("/auth/request", { email });
    const c3 = /(\d{6})$/.exec((await outbox(email)).at(-1)!.subject)![1]!;
    expect((await post("/auth/code", { email, code: c3 })).status).toBe(200);
    // Expired codes fail.
    await post("/auth/request", { email });
    const c4 = /(\d{6})$/.exec((await outbox(email)).at(-1)!.subject)![1]!;
    await env.DB.prepare("UPDATE magic_links SET expires_at = '2000-01-01T00:00:00Z' WHERE email = ? AND used_at IS NULL").bind(email).run();
    expect((await post("/auth/code", { email, code: c4 })).status).toBe(401);
  });

  it("sessions last 60 days and renew while the brand uses the portal", async () => {
    const email = `renew-${uniq()}@brand.example`;
    await createAccount(env, { brandName: "Renew", email, plan: "starter" });
    const cookie = await login(email);
    const row = () => env.DB.prepare("SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?").bind(email).first<{ expires_at: string }>();
    const days = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;
    expect(days((await row())!.expires_at)).toBeGreaterThan(59);
    // Fresh session: no renewal, no new cookie.
    expect((await portalGet("/me", cookie)).headers.get("set-cookie")).toBeNull();
    // 10 days later: the next visit restarts the 60 days.
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(new Date(Date.now() + 50 * 86_400_000).toISOString(), email).run();
    const r = await portalGet("/me", cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/Max-Age=5184000/);
    expect(days((await row())!.expires_at)).toBeGreaterThan(59);
  });

  it("approving a product is the go-ahead (no 'Done' step); a brand stuck before that recovers on its next visit", async () => {
    const make = async (tag: string) => {
      const email = `go-${tag}-${uniq()}@brand.example`;
      const { accountId } = await createAccount(env, { brandName: `Go ${tag}`, email, plan: "starter", instagram: "@go" });
      const pid = `p${uniq()}`;
      await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, kind, selected, source) VALUES (?, ?, ?, 'Dress', '["https://cdn.shop.example/d.jpg"]', 'clothing', 1, 'manual')`)
        .bind(pid, accountId, `manual:${pid}`)
        .run();
      expect(await advance(env, accountId, { fetcher, runTestsInline: (a, p) => testProduct(env, a, p) })).toBe("products_tested");
      return { accountId, pid, cookie: await login(email) };
    };
    const status = async (id: string) => (await env.DB.prepare("SELECT status, onboarding_step FROM accounts WHERE id = ?").bind(id).first())!;

    const a = await make("a");
    expect((await portalPost(`/products/${a.pid}/decision`, a.cookie, { decision: "approved" })).status).toBe(200);
    expect(await status(a.accountId)).toEqual({ status: "pilot", onboarding_step: "pilot_live" });

    // Stuck the old way: approved, but approved_at never set (the old "Done" button wasn't tapped).
    const b = await make("b");
    await decideProduct(env, b.accountId, b.pid, "approved");
    expect(await status(b.accountId)).toMatchObject({ status: "onboarding", onboarding_step: "products_tested" });
    expect((await portalGet("/me", b.cookie)).status).toBe(200);
    expect(await status(b.accountId)).toEqual({ status: "pilot", onboarding_step: "pilot_live" });
  });

  it("brand look: the brand saves its colour and logo; try-on pages, the website button and the logo address use them", async () => {
    const email = `look-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "Look Co", email, plan: "starter", instagram: "@look" });
    const cookie = await login(email);
    const send = (fd: FormData) => exports.default.fetch("https://api.test/portal-api/brand", { method: "POST", headers: { cookie, origin: APP }, body: fd });
    const bad = new FormData();
    bad.set("color", "red");
    expect((await send(bad)).status).toBe(400);
    const fd = new FormData();
    fd.set("color", "#A0522D");
    fd.set("logo", new Blob([fakeJpeg("LOGO")], { type: "image/jpeg" }), "logo.jpg");
    expect((await send(fd)).status).toBe(200);
    const me = (await (await portalGet("/me", cookie)).json()) as { look: { color: string; logo: string } };
    expect(me.look.color).toBe("#a0522d");
    // A real-size logo (1.5 MB) is accepted; over 2 MB is refused.
    const big = (n: number) => {
      const b = new Uint8Array(n);
      b.set(fakeJpeg("BIG"));
      return b;
    };
    const ok = new FormData();
    ok.set("logo", new Blob([big(1_500_000)], { type: "image/jpeg" }), "big.jpg");
    expect((await send(ok)).status).toBe(200);
    const tooBig = new FormData();
    tooBig.set("logo", new Blob([big(2_200_000)], { type: "image/jpeg" }), "huge.jpg");
    expect((await send(tooBig)).status).toBe(413);
    const again = new FormData();
    again.set("color", "#A0522D");
    again.set("logo", new Blob([fakeJpeg("LOGO")], { type: "image/jpeg" }), "logo.jpg");
    expect((await send(again)).status).toBe(200);
    const me2 = (await (await portalGet("/me", cookie)).json()) as { look: { color: string; logo: string } };
    me.look.logo = me2.look.logo;
    expect(me.look.logo).toMatch(new RegExp(`^${APP}/bl/${accountId}/[a-z0-9]{26}\\.jpg$`));
    const file = me.look.logo.split("/").pop()!;
    const img = await exports.default.fetch(`https://api.test/v1/brand-logo/${accountId}/${file}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    // Removing the logo deletes the file.
    const rm = new FormData();
    rm.set("color", "#a0522d");
    rm.set("removeLogo", "1");
    expect((await send(rm)).status).toBe(200);
    expect((await exports.default.fetch(`https://api.test/v1/brand-logo/${accountId}/${file}`)).status).toBe(404);
  });

  it("brand look: a separate text colour (or automatic), passed to the try-on pages", async () => {
    const email = `text-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "Text Co", email, plan: "starter", instagram: "@text" });
    const cookie = await login(email);
    const send = (fd: FormData) => exports.default.fetch("https://api.test/portal-api/brand", { method: "POST", headers: { cookie, origin: APP }, body: fd });
    const bad = new FormData();
    bad.set("textColor", "blue");
    expect((await send(bad)).status).toBe(400);
    const fd = new FormData();
    fd.set("color", "#F3D6A8");
    fd.set("textColor", "#6B2737");
    expect((await send(fd)).status).toBe(200);
    let me = (await (await portalGet("/me", cookie)).json()) as { look: { color: string; textColor: string | null } };
    expect(me.look).toMatchObject({ color: "#f3d6a8", textColor: "#6b2737" });
    const row = await env.DB.prepare("SELECT brand_text_color FROM accounts WHERE id = ?").bind(accountId).first<{ brand_text_color: string }>();
    expect(row?.brand_text_color).toBe("#6b2737"); // try-on pages read it (api.test: hosted pages)
    // Changing only the button colour keeps the text colour; "" goes back to automatic.
    const onlyButton = new FormData();
    onlyButton.set("color", "#112233");
    await send(onlyButton);
    me = (await (await portalGet("/me", cookie)).json()) as typeof me;
    expect(me.look).toMatchObject({ color: "#112233", textColor: "#6b2737" });
    const auto = new FormData();
    auto.set("textColor", "");
    await send(auto);
    me = (await (await portalGet("/me", cookie)).json()) as typeof me;
    expect(me.look).toMatchObject({ color: "#112233", textColor: null });
  });

  it("no session → 401; cross-site writes refused", async () => {
    expect((await portalGet("/me", "")).status).toBe(401);
    const email = `csrf-${uniq()}@brand.example`;
    await createAccount(env, { brandName: "CSRF", email, plan: "starter" });
    const cookie = await login(email);
    expect((await portalPost("/approve/confirm", cookie, {}, "https://evil.example")).status).toBe(403);
  });

  it("cross-account isolation: brand A can't see or change brand B's data", async () => {
    const ea = `a-${uniq()}@brand.example`;
    const eb = `b-${uniq()}@brand.example`;
    const a = await createAccount(env, { brandName: "A", email: ea, plan: "starter", website: "https://shopify.example" });
    const b = await createAccount(env, { brandName: "B", email: eb, plan: "starter", website: "https://shopify.example" });
    void a;
    await advance(env, b.accountId, { fetcher, runTestsInline: (x, p) => testProduct(env, x, p) });
    const bProduct = await env.DB.prepare("SELECT id FROM products WHERE account_id = ? AND enabled = 1 LIMIT 1").bind(b.accountId).first<{ id: string }>();
    const bTest = await env.DB.prepare("SELECT id FROM product_tests WHERE account_id = ? AND r2_key IS NOT NULL LIMIT 1").bind(b.accountId).first<{ id: string }>();
    const cookieA = await login(ea);

    const products = (await (await portalGet("/products", cookieA)).json()) as { products: { id: string }[] };
    expect(products.products.find((p) => p.id === bProduct!.id)).toBeUndefined();
    expect((await portalGet(`/test-image/${bTest!.id}`, cookieA)).status).toBe(404);
    expect((await portalPost(`/products/${bProduct!.id}/decision`, cookieA, { decision: "approved" })).status).toBe(404);
    const still = await env.DB.prepare("SELECT brand_decision FROM products WHERE id = ?").bind(bProduct!.id).first<{ brand_decision: string | null }>();
    expect(still?.brand_decision).toBeNull();
  });

  it("portal shows progress, the install snippet and serves its own test images", async () => {
    const email = `p-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "Portal", email, plan: "starter", website: "https://shopify.example" });
    await advance(env, accountId, { fetcher, runTestsInline: (x, p) => testProduct(env, x, p) });
    const cookie = await login(email);
    const me = (await (await portalGet("/me", cookie)).json()) as { step: string; snippet: string; steps: { step: string; state: string }[] };
    expect(me.step).toBe("products_tested");
    expect(me.snippet).toMatch(/^<script src="https:\/\/app\.test\/w\.js" data-key="gk_test_[A-Za-z0-9]{28}" async><\/script>$/);
    expect(me.steps.find((s) => s.step === "products_imported")?.state).toBe("done");
    const list = (await (await portalGet("/products", cookie)).json()) as { products: { tests: string[]; result: string }[] };
    const withImg = list.products.find((p) => p.tests.length > 0)!;
    const img = await portalGet(withImg.tests[0]!.replace("/portal-api", ""), cookie);
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toBe("private, max-age=3600");
  });
});

// ---------------------------------------------------------------- /v1/start

describe("/v1/start", () => {
  it("creates a lead and an account, and answers the same for a repeat email", async () => {
    const email = `lead-${uniq()}@brand.example`;
    const body = {
      brandName: "Lead Brand",
      contactName: "Mona",
      email,
      whatsapp: "01001234567",
      website: "https://shopify.example",
      platform: "shopify",
      niche: "clothing",
      plan: "starter",
      turnstileToken: "x",
    };
    const post = () => exports.default.fetch("https://api.test/v1/start", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await post()).json()).toEqual({ ok: true });
    expect(await (await post()).json()).toEqual({ ok: true });
    const acc = await env.DB.prepare("SELECT status, plan_id, target_plan_id, whatsapp, platform FROM accounts WHERE email = ?").bind(email).all();
    expect(acc.results).toEqual([{ status: "onboarding", plan_id: "pilot", target_plan_id: "starter", whatsapp: "+201001234567", platform: "shopify" }]);
    const leads = await env.DB.prepare("SELECT COUNT(*) AS c FROM leads WHERE email = ?").bind(email).first<{ c: number }>();
    expect(leads?.c).toBe(2);
  });

  it("a sign-up from a brand's try-on page records the referring brand and alerts", async () => {
    const ref = await createAccount(env, { brandName: "Noor Ref", email: `noor-${uniq()}@brand.example`, plan: "starter", instagram: "@noor" });
    const slug = (await env.DB.prepare("SELECT slug FROM accounts WHERE id = ?").bind(ref.accountId).first<{ slug: string }>())!.slug;
    const email = `refd-${uniq()}@brand.example`;
    const body = { brandName: "Referred Co", contactName: "Sara", email, whatsapp: "01001234567", instagram: "@refd", platform: "social_only", niche: "clothing", plan: "starter", turnstileToken: "x", ref: slug };
    const r = await exports.default.fetch("https://api.test/v1/start", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    expect(await env.DB.prepare("SELECT referred_by FROM accounts WHERE email = ?").bind(email).first()).toEqual({ referred_by: slug });
    expect(await env.DB.prepare("SELECT referred_by FROM leads WHERE email = ?").bind(email).first()).toEqual({ referred_by: slug });
    const a = await env.DB.prepare("SELECT message FROM alerts WHERE kind = 'referral' ORDER BY created_at DESC LIMIT 1").first<{ message: string }>();
    expect(a?.message).toContain("New lead via Noor Ref");
    // An unknown ref is ignored, not stored.
    const email2 = `refx-${uniq()}@brand.example`;
    await exports.default.fetch("https://api.test/v1/start", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ ...body, email: email2, ref: "no-such-brand" }) });
    expect(await env.DB.prepare("SELECT referred_by FROM accounts WHERE email = ?").bind(email2).first()).toEqual({ referred_by: null });
  });

  it("call-back request: stored with the referring brand, alerted, listed in the admin, marked done", async () => {
    const ref = await createAccount(env, { brandName: "Call Ref", email: `cref-${uniq()}@brand.example`, plan: "starter", instagram: "@cref" });
    const slug = (await env.DB.prepare("SELECT slug FROM accounts WHERE id = ?").bind(ref.accountId).first<{ slug: string }>())!.slug;
    const send = (b: unknown, origin = APP) =>
      exports.default.fetch("https://api.test/v1/contact", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await send({ name: "Hana", whatsapp: "123", turnstileToken: "x" })).status).toBe(400);
    expect((await send({ name: "Hana", whatsapp: "01001234567", turnstileToken: "x" }, "https://evil.example")).status).toBe(403);
    expect((await send({ name: "Hana", whatsapp: "01001234567", brand: "Hana Wear", ref: slug, turnstileToken: "x" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT id, whatsapp, brand, referred_by FROM contact_requests WHERE name = 'Hana'").first<{ id: string; whatsapp: string; brand: string; referred_by: string }>();
    expect(row).toMatchObject({ whatsapp: "+201001234567", brand: "Hana Wear", referred_by: slug });
    const a = await env.DB.prepare("SELECT message FROM alerts WHERE kind = 'contact_request' ORDER BY created_at DESC LIMIT 1").first<{ message: string }>();
    expect(a?.message).toContain("via Call Ref");
  });

  it("rejects bad input with field errors", async () => {
    const r = await exports.default.fetch("https://api.test/v1/start", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ brandName: "X", email: "nope" }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { fields: { path: string }[] };
    expect(j.fields.map((f) => f.path)).toEqual(expect.arrayContaining(["email", "whatsapp"]));
  });
});

// ---------------------------------------------------------------- pilot clock, stuck detector, cron

/** A live pilot that started `daysAgo` days ago; a whole number means noon (Cairo date) that many days back, so the pilot day doesn't depend on the time the test runs. */
async function livePilot(daysAgo: number): Promise<{ id: string; email: string }> {
  const email = `pilot-${uniq()}@brand.example`;
  const { accountId } = await createAccount(env, { brandName: "Pilot", email, plan: "starter" });
  const start = Number.isInteger(daysAgo)
    ? new Date(Date.parse(cairoDay(new Date(Date.now() - daysAgo * 86_400_000))) + 10 * 3_600_000)
    : new Date(Date.now() - daysAgo * 86_400_000);
  await env.DB.prepare(
    "UPDATE accounts SET status = 'pilot', onboarding_step = 'pilot_live', pilot_started_at = ?, pilot_ends_at = ?, cycle_start = ? WHERE id = ?",
  )
    .bind(start.toISOString(), new Date(start.getTime() + 14 * 86_400_000).toISOString(), cairoDay(start), accountId)
    .run();
  return { id: accountId, email };
}

describe("pilot clock", () => {
  it("day 7 check-in only, once", async () => {
    const a = await livePilot(6.5);
    await pilotClock(env, new Date());
    await pilotClock(env, new Date());
    expect((await outbox(a.email)).map((m) => m.subject)).toEqual(["Week one of your pilot"]);
  });

  it("day 10: the branded pilot report, once, with the brand's real numbers and top product", async () => {
    const a = await livePilot(9);
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, images_json, selected, enabled, approved) VALUES (?, ?, 'r', 'Olive kaftan', '[]', 1, 1, 1)`)
      .bind(pid, a.id)
      .run();
    const d = cairoDay();
    await env.DB.prepare(
      `INSERT INTO daily_counters (account_id, day, metric, count) VALUES
        (?, ?, 'link_view', 200), (?, ?, 'try_on_started', 50), (?, ?, 'preview', 40), (?, ?, 'buy_click', 10),
        (?, ?, ?, 40), (?, ?, ?, 10)`,
    )
      .bind(a.id, d, a.id, d, a.id, d, a.id, d, a.id, d, `preview@${pid}`, a.id, d, `buy_click@${pid}`)
      .run();
    await pilotClock(env, new Date());
    await pilotClock(env, new Date());
    const mails = await outbox(a.email);
    expect(mails.map((m) => m.subject)).toEqual(["Week one of your pilot", "Pilot: your first 10 days with Garrab"]);
    const html = mails[1]!.html;
    expect(html).toContain("Pilot report · day 10");
    expect(html).toContain("40 previews created by your shoppers, and 10 Buy taps straight after.");
    expect(html).toContain("25%"); // 50 of 200 viewers started a try-on; 10 of 40 previews → Buy
    expect(html).toContain("Olive kaftan");
    expect(html).toContain("/portal/results");
    expect(html).not.toMatch(/box-shadow|gradient/); // brand guideline
  });

  it("day 14: check-in, ending soon (with price from plans.ts) and the final results with the pay link", async () => {
    const a = await livePilot(13.5);
    await env.DB.prepare("INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, 'button_view', 120), (?, ?, 'try_on_started', 20), (?, ?, 'preview', 15), (?, ?, 'buy_click', 4)")
      .bind(a.id, cairoDay(), a.id, cairoDay(), a.id, cairoDay(), a.id, cairoDay())
      .run();
    await pilotClock(env, new Date());
    const mails = await outbox(a.email);
    // Catching up at day 14: the final results replace the day-10 report.
    expect(mails.map((m) => m.subject)).toEqual(["Week one of your pilot", "Your pilot ends in 2 days", "Your Garrab pilot results, Pilot"]);
    expect(mails[1]!.html).toContain("5000 EGP a month");
    const final = mails[2]!.html;
    expect(final).toContain("Pilot results");
    expect(final).toContain("5,000 EGP a month");
    expect(final).toContain("/pay/");
    expect(final).toContain("27%"); // 4 of 15 previews → Buy
  });

  it("expires after pilot end + 5-day grace: kill switch on", async () => {
    const a = await livePilot(20);
    await pilotClock(env, new Date());
    const acc = await env.DB.prepare("SELECT status, onboarding_step FROM accounts WHERE id = ?").bind(a.id).first();
    expect(acc).toEqual({ status: "expired", onboarding_step: "expired" });
    const audit = await env.DB.prepare("SELECT actor, to_status FROM audit_log WHERE account_id = ? AND action = 'status'").bind(a.id).first();
    expect(audit).toEqual({ actor: "cron", to_status: "expired" });
  });

  it("does not expire inside the grace period", async () => {
    const a = await livePilot(17);
    await pilotClock(env, new Date());
    expect((await env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(a.id).first<{ status: string }>())?.status).toBe("pilot");
  });
});

describe("stuck detector", () => {
  it("alerts once per day for >48 h in a step, and reminds about the install", async () => {
    const email = `stuck-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: "Stuck", email, plan: "starter", website: "https://shopify.example" });
    await env.DB.prepare("UPDATE accounts SET onboarding_step = 'products_approved', onboarding_step_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 50 * 3_600_000).toISOString(), accountId)
      .run();
    await stuckDetector(env, new Date());
    await stuckDetector(env, new Date());
    const alerts = await env.DB.prepare("SELECT kind, message FROM alerts WHERE account_id = ?").bind(accountId).all<{ kind: string; message: string }>();
    expect(alerts.results).toHaveLength(1);
    expect(alerts.results[0]!.message).toMatch(/stuck 50 h at "Add Garrab to your shop"/);
    expect((await outbox(email)).map((m) => m.subject)).toEqual(["Reminder: add Garrab to your shop"]);
  });
});

describe("cron dispatcher (Cairo time)", () => {
  it("runs a daily job once, at or after its Cairo time", async () => {
    await env.DB.prepare("DELETE FROM cron_runs").run();
    const before = new Date("2026-07-01T05:40:00Z"); // 08:40 Cairo (summer, UTC+3)
    const after = new Date("2026-07-01T06:05:00Z"); //  09:05 Cairo
    await runScheduled(env, before);
    let runs = await env.DB.prepare("SELECT job FROM cron_runs WHERE job = 'pilot_clock'").all();
    expect(runs.results).toHaveLength(0);
    await runScheduled(env, after);
    await runScheduled(env, new Date("2026-07-01T06:20:00Z"));
    runs = await env.DB.prepare("SELECT job FROM cron_runs WHERE job = 'pilot_clock'").all();
    expect(runs.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- admin

describe("admin API", () => {
  const adminPost = (path: string, body: unknown, headers: Record<string, string> = ADMIN) =>
    exports.default.fetch(`https://api.test/admin-api${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("refuses without Access or the dev token", async () => {
    expect((await exports.default.fetch("https://api.test/admin-api/funnel")).status).toBe(401);
    expect((await exports.default.fetch("https://api.test/admin-api/funnel", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("invite returns a working sign-in link straight away", async () => {
    const email = `inv-${uniq()}@brand.example`;
    const r = await adminPost("/invite", { brandName: "Invited", email, plan: "growth", website: "https://shopify.example" });
    const j = (await r.json()) as { link: string; created: boolean };
    expect(j.created).toBe(true);
    const token = /#t=([A-Za-z0-9]{40})$/.exec(j.link)![1];
    const v = await exports.default.fetch("https://api.test/portal-api/auth/verify", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(v.status).toBe(200);
  });

  it("step override needs a reason and is audit-logged", async () => {
    const { accountId } = await createAccount(env, { brandName: "Ovr", email: `o-${uniq()}@x.example`, plan: "starter" });
    expect((await adminPost(`/accounts/${accountId}/step`, { to: "products_imported", reason: "" })).status).toBe(400);
    expect((await adminPost(`/accounts/${accountId}/step`, { to: "products_imported", reason: "brand sent products by WhatsApp" })).status).toBe(200);
    const s = await env.DB.prepare("SELECT state, actor FROM onboarding_steps WHERE account_id = ? AND step = 'invited'").bind(accountId).first();
    expect(s).toEqual({ state: "overridden", actor: "admin:dev-admin" });
  });

  it("funnel counts each stage with conversion", async () => {
    const r = (await (await exports.default.fetch("https://api.test/admin-api/funnel", { headers: ADMIN })).json()) as { stages: { stage: string; count: number }[] };
    expect(r.stages.map((s) => s.stage)).toEqual(["invited", "installed", "pilot_live", "paying", "churned"]);
    expect(r.stages[0]!.count).toBeGreaterThan(0);
  });
});

describe("product photo upload", () => {
  it("stores the photo without its metadata, serves it publicly, and adds the product", async () => {
    const email = `up-${uniq()}@brand.example`;
    const { accountId } = await createAccount(env, { brandName: `Upload ${uniq()}`, email, plan: "starter" });
    const cookie = await login(email);
    const fd = new FormData();
    fd.set("title", "Linen abaya");
    fd.set("photo", new Blob([fakeJpeg("PIXELS", "EXIF-GPS")], { type: "image/jpeg" }), "abaya.jpg");
    const r = await exports.default.fetch("https://api.test/portal-api/products/upload", { method: "POST", headers: { cookie, origin: APP }, body: fd });
    expect(r.status).toBe(200);
    const { imageUrl } = (await r.json()) as { imageUrl: string };
    const m = /\/pi\/([A-Z0-9]{26})\/([a-z0-9]{26}\.jpg)$/.exec(imageUrl)!;
    expect(m[1]).toBe(accountId);
    const img = await exports.default.fetch(`https://api.test/v1/product-image/${m[1]}/${m[2]}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    const body = new TextDecoder("latin1").decode(new Uint8Array(await img.arrayBuffer()));
    expect(body).toContain("PIXELS");
    expect(body).not.toContain("EXIF-GPS");
    const p = await env.DB.prepare("SELECT title, images_json, selected FROM products WHERE account_id = ?").bind(accountId).first<{ title: string; images_json: string; selected: number }>();
    expect(p).toMatchObject({ title: "Linen abaya", selected: 1 });
    expect(JSON.parse(p!.images_json)).toEqual([imageUrl]);
  });

  it("refuses files that aren't photos", async () => {
    const email = `up2-${uniq()}@brand.example`;
    await createAccount(env, { brandName: `Upload2 ${uniq()}`, email, plan: "starter" });
    const cookie = await login(email);
    const fd = new FormData();
    fd.set("title", "Not a photo");
    fd.set("photo", new Blob([new TextEncoder().encode("hello, this is a text file, not an image")], { type: "image/jpeg" }), "x.jpg");
    const r = await exports.default.fetch("https://api.test/portal-api/products/upload", { method: "POST", headers: { cookie, origin: APP }, body: fd });
    expect(r.status).toBe(415);
  });

  it("Garrab support adds photos for a brand from the admin (sign-in required; photo-sized bodies allowed only there)", async () => {
    const { accountId } = await createAccount(env, { brandName: `Neris ${uniq()}`, email: `neris-${uniq()}@brand.example`, plan: "starter" });
    const form = (title: string, bytes: Uint8Array) => {
      const fd = new FormData();
      fd.set("title", title);
      fd.set("sizes", "S, M, L");
      fd.set("photo", new Blob([bytes], { type: "image/jpeg" }), "p.jpg");
      return fd;
    };
    const url = `https://api.test/admin-api/accounts/${accountId}/products/upload`;
    expect((await exports.default.fetch(url, { method: "POST", body: form("Silk scarf", fakeJpeg()) })).status).toBe(401);
    // A real-sized phone photo (~1 MB) goes through; other admin calls keep their small limit.
    const big = new Uint8Array(1024 * 1024);
    big.set(fakeJpeg());
    const r = await exports.default.fetch(url, { method: "POST", headers: ADMIN, body: form("Silk scarf", big) });
    expect(r.status).toBe(200);
    const p = await env.DB.prepare("SELECT title, sizes_json, selected FROM products WHERE account_id = ?").bind(accountId).first<{ title: string; sizes_json: string; selected: number }>();
    expect(p).toMatchObject({ title: "Silk scarf", selected: 1 });
    expect(JSON.parse(p!.sizes_json)).toEqual(["S", "M", "L"]);
    const other = await exports.default.fetch(`https://api.test/admin-api/accounts/${accountId}/notes`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ notes: "x".repeat(100 * 1024) }),
    });
    expect(other.status).toBe(413);
    expect((await exports.default.fetch(`https://api.test/admin-api/accounts/nope/products/upload`, { method: "POST", headers: ADMIN, body: form("X", fakeJpeg()) })).status).toBe(404);
  });
});
