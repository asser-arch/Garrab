import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OUTREACH_ID, OUTREACH_USAGE, imageFromLink, mainImageOf, outreachPreview } from "../src/lib/outreach.js";
import type { TryOnProvider } from "../src/providers/tryon.js";
import { fakeJpeg } from "./helpers.js";

const ADMIN = { authorization: "Bearer test-admin-token-123456" };

beforeEach(async () => {
  await env.FILES.put("fixtures/model-a.jpg", fakeJpeg("MODEL-A"));
  await env.FILES.put("fixtures/model-b.jpg", fakeJpeg("MODEL-B"));
});

describe("outreach preview (admin)", () => {
  it("reads a product page's main image", () => {
    const html = `<html><head><meta property="og:image" content="/cdn/dress.jpg?v=1&amp;w=800"></head></html>`;
    expect(mainImageOf(html, "https://shop.example/products/dress")).toBe("https://shop.example/cdn/dress.jpg?v=1&w=800");
    expect(mainImageOf("<html></html>", "https://x.example")).toBeNull();
  });

  it("a link to a page → its photo; a page without one → a plain message", async () => {
    const jpg = fakeJpeg("DRESS");
    const f = (async (u: string) =>
      u.endsWith(".jpg")
        ? new Response(jpg, { headers: { "content-type": "image/jpeg" } })
        : new Response(u.includes("nophoto") ? "<html></html>" : `<meta property="og:image" content="https://cdn.shop.example/d.jpg">`, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const ok = await imageFromLink("https://shop.example/p/dress", f);
    expect("bytes" in ok && ok.type).toBe("image/jpeg");
    const bad = await imageFromLink("https://instagram.example/p/nophoto", f);
    expect("error" in bad && bad.error).toMatch(/upload it instead/);
  });

  it("makes one preview, deletes the product photo straight after, records the cost under outreach", async () => {
    let seenUrl = "";
    const tryon: TryOnProvider = {
      name: "scripted",
      async tryOn(req) {
        seenUrl = req.product.imageUrls[0]!;
        return { ok: true, image: fakeJpeg("RESULT"), contentType: "image/jpeg", costMicroUsd: 40_000, productSynced: false };
      },
      async deleteUserData() {
        return true;
      },
    };
    const r = await outreachPreview(env, { product: { bytes: fakeJpeg("P"), type: "image/jpeg" }, title: "Kaftan", mode: "person", fixture: 1 }, { tryon });
    expect(r.ok && r.fixture).toBe("Woman B");
    expect(r.ok && r.preview.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(seenUrl).toContain(`/pi/${OUTREACH_ID}/`);
    expect((await env.FILES.list({ prefix: `products/${OUTREACH_ID}/` })).objects).toHaveLength(0);
    const u = await env.DB.prepare("SELECT cost_micro_usd FROM usage_events WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").bind(OUTREACH_USAGE).first();
    expect(u).toEqual({ cost_micro_usd: 40_000 });
  });

  it("admin route: upload a photo, get the preview back (local fake AI)", async () => {
    const fd = new FormData();
    fd.set("photo", new Blob([fakeJpeg("UPLOADED")], { type: "image/jpeg" }), "p.jpg");
    fd.set("mode", "person");
    const r = await exports.default.fetch("https://api.test/admin-api/outreach/preview", { method: "POST", headers: ADMIN, body: fd });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { product: string; preview: string; fixture: string };
    expect(j.fixture).toBe("Woman A");
    const none = await exports.default.fetch("https://api.test/admin-api/outreach/preview", { method: "POST", headers: ADMIN, body: new FormData() });
    expect(none.status).toBe(400);
  });

  it("uses a person / room photo you upload instead of a stock one, and keeps nothing", async () => {
    let seen = "";
    const tryon: TryOnProvider = {
      name: "scripted",
      async tryOn(req) {
        seen = new TextDecoder().decode(req.photo);
        return { ok: true, image: fakeJpeg("RESULT"), contentType: "image/jpeg", costMicroUsd: 0, productSynced: false };
      },
      async deleteUserData() {
        return true;
      },
    };
    const before = (await env.FILES.list()).objects.length;
    const r = await outreachPreview(env, { product: { bytes: fakeJpeg("P"), type: "image/jpeg" }, title: "Rug", mode: "room", fixture: 0, own: { bytes: fakeJpeg("THEIR-ROOM"), type: "image/jpeg" } }, { tryon });
    expect(r.ok && r.fixture).toBe("Your room photo");
    expect(seen).toContain("THEIR-ROOM");
    expect((await env.FILES.list()).objects.length).toBe(before);

    const fd = new FormData();
    fd.set("photo", new Blob([fakeJpeg("PRODUCT")], { type: "image/jpeg" }), "p.jpg");
    fd.set("own", new Blob([fakeJpeg("PERSON")], { type: "image/jpeg" }), "me.jpg");
    const res = await exports.default.fetch("https://api.test/admin-api/outreach/preview", { method: "POST", headers: ADMIN, body: fd });
    expect(((await res.json()) as { fixture: string }).fixture).toBe("Your model photo");
    const bad = new FormData();
    bad.set("photo", new Blob([fakeJpeg("PRODUCT")], { type: "image/jpeg" }), "p.jpg");
    bad.set("own", new Blob([new TextEncoder().encode("not an image")], { type: "text/plain" }), "x.txt");
    expect((await exports.default.fetch("https://api.test/admin-api/outreach/preview", { method: "POST", headers: ADMIN, body: bad })).status).toBe(415);
  });
});
