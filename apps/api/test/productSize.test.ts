import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAccount } from "../src/lib/accounts.js";
import { fillProductSizes } from "../src/lib/dimensions.js";
import { saveProducts, type ImportedProduct } from "../src/onboarding/import.js";
import { roomPrompt } from "../src/providers/google.js";

const ADMIN = { authorization: "Bearer test-admin-token-123456", "content-type": "application/json" };
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const vase = (description: string): ImportedProduct => ({
  externalRef: "shop:vase-1",
  title: "Sage ceramic vase",
  description,
  images: ["https://cdn.shop.example/vase.jpg"],
  sizes: [],
  kind: "decor",
  productUrl: "https://shop.example/products/vase",
  urlPath: "/products/vase",
  pricePiastres: null,
  source: "shopify",
});

describe("home décor sizes for room previews", () => {
  it("reads the size on import, keeps the brand's own size over re-imports, and tells the AI", async () => {
    const { accountId } = await createAccount(env, { brandName: `Home ${uniq()}`, email: `h-${uniq()}@brand.example`, plan: "starter", instagram: "@home", niche: "home_decor" });
    await saveProducts(env, accountId, [vase("Hand thrown. Height 35 cm, diameter 15 cm.")]);
    const row = () => env.DB.prepare("SELECT id, size_text, size_source FROM products WHERE account_id = ?").bind(accountId).first<{ id: string; size_text: string; size_source: string }>();
    expect(await row()).toMatchObject({ size_text: "height 35 cm, diameter 15 cm", size_source: "auto" });

    // Garrab support fixes it; a nightly re-import doesn't overwrite it.
    const id = (await row())!.id;
    expect((await exports.default.fetch(`https://api.test/admin-api/products/${id}/size`, { method: "POST", headers: ADMIN, body: JSON.stringify({ size: "height 40 cm" }) })).status).toBe(200);
    await saveProducts(env, accountId, [vase("Hand thrown. Height 35 cm, diameter 15 cm.")]);
    expect(await row()).toMatchObject({ size_text: "height 40 cm", size_source: "brand" });
    // Cleared: read from the shop again.
    await exports.default.fetch(`https://api.test/admin-api/products/${id}/size`, { method: "POST", headers: ADMIN, body: JSON.stringify({ size: "" }) });
    expect(await row()).toMatchObject({ size_text: "height 35 cm, diameter 15 cm", size_source: "auto" });

    const prompt = roomPrompt({ product: { externalId: "x", title: "Vase", description: "", imageUrls: [], includesHeadwear: false, synced: false, size: "height 35 cm" }, photo: new Uint8Array(), photoType: "image/jpeg", oneTimeUserId: "u" });
    expect(prompt).toContain("Real size of the item: height 35 cm");
    expect(prompt).toContain("sofa seat is about 45 cm high");
  });

  it("older products get their size read in the background", async () => {
    const { accountId } = await createAccount(env, { brandName: `Old ${uniq()}`, email: `o-${uniq()}@brand.example`, plan: "starter", instagram: "@old", niche: "home_decor" });
    const pid = `p${uniq()}`;
    await env.DB.prepare(`INSERT INTO products (id, account_id, external_ref, title, description, images_json, kind, source) VALUES (?, ?, ?, 'Jute rug 160 x 230 cm', '', '["https://x.example/r.jpg"]', 'decor', 'manual')`)
      .bind(pid, accountId, `manual:${pid}`)
      .run();
    await fillProductSizes(env);
    expect(await env.DB.prepare("SELECT size_text, size_source FROM products WHERE id = ?").bind(pid).first()).toEqual({ size_text: "160 × 230 cm", size_source: "auto" });
  });
});
