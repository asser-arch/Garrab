import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount } from "../src/lib/accounts.js";
import { invalidateStatus } from "../src/lib/db.js";
import { cairoDay } from "../src/lib/time.js";
import { guessKind, importJsonLd, importShopify, importWoo, parseRobots, rankScore } from "../src/onboarding/import.js";
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

  it("ranks products with more photos and sizes higher, and never auto-picks decor", () => {
    const a = rankScore({ images: ["1", "2", "3", "4"], sizes: ["S"], pricePiastres: 1000, kind: "clothing" }, 1000);
    const b = rankScore({ images: ["1"], sizes: [], pricePiastres: 1000, kind: "clothing" }, 1000);
    const d = rankScore({ images: ["1", "2", "3", "4"], sizes: ["S"], pricePiastres: 1000, kind: "decor" }, 1000);
    expect(a).toBeGreaterThan(b);
    expect(d).toBeLessThan(0);
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
    expect(low.disabled_reason).toMatch(/don't match/);
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
    expect(await advance(env, accountId, { fetcher })).toBe("products_approved");

    // Not installed yet → waits. Then the snippet appears on the shop → installed → pilot_live.
    const key = (await env.DB.prepare("SELECT key_public FROM api_keys WHERE account_id = ?").bind(accountId).first<{ key_public: string }>())!.key_public;
    await env.DB.prepare("UPDATE domains SET last_checked_at = NULL WHERE account_id = ?").bind(accountId).run();
    installHtml = `<html><script src="https://cdn.garrab.example/w.js" data-key="${key}" async></script></html>`;
    expect(await advance(env, accountId, { fetcher })).toBe("pilot_live");

    const acc = await env.DB.prepare("SELECT status, plan_id, target_plan_id, pilot_started_at, pilot_ends_at, cycle_start FROM accounts WHERE id = ?").bind(accountId).first<Record<string, string>>();
    expect(acc).toMatchObject({ status: "pilot", plan_id: "pilot", target_plan_id: "growth", cycle_start: cairoDay() });
    expect(Date.parse(acc!.pilot_ends_at!) - Date.parse(acc!.pilot_started_at!)).toBe(14 * 86_400_000);

    const subjects = (await outbox(email)).map((m) => m.subject);
    expect(subjects).toEqual([
      "Welcome to Garrab, Hayal Test",
      "Your try-on previews are ready to approve",
      "One last step: add Garrab to your shop",
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

async function livePilot(daysAgo: number): Promise<{ id: string; email: string }> {
  const email = `pilot-${uniq()}@brand.example`;
  const { accountId } = await createAccount(env, { brandName: "Pilot", email, plan: "starter" });
  const start = new Date(Date.now() - daysAgo * 86_400_000);
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

  it("day 14: check-in, ending soon (with price from plans.ts) and the results report", async () => {
    const a = await livePilot(13.5);
    await env.DB.prepare("INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, 'button_view', 120), (?, ?, 'try_on_started', 20), (?, ?, 'try_on_completed', 15), (?, ?, 'buy_click', 4)")
      .bind(a.id, cairoDay(), a.id, cairoDay(), a.id, cairoDay(), a.id, cairoDay())
      .run();
    await pilotClock(env, new Date());
    const mails = await outbox(a.email);
    expect(mails.map((m) => m.subject)).toEqual(["Week one of your pilot", "Your pilot ends in 2 days", "Your Garrab pilot results"]);
    expect(mails[1]!.html).toContain("5000 EGP a month");
    expect(mails[2]!.html).toContain("Completion rate: 75%");
    expect(mails[2]!.html).toContain("Buy clicks from the try-on page: 4");
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
});
