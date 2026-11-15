/** Pins the exact requests we send to each try-on provider (no network: fetch is faked). */
import { describe, expect, it } from "vitest";
import { GeminiTryOnProvider, VertexTryOnProvider, toBase64 } from "../src/providers/google.js";
import { GenlookProvider, type TryOnRequest } from "../src/providers/tryon.js";
import { fakeJpeg } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function req(over: Partial<TryOnRequest["product"]> = {}): TryOnRequest {
  return {
    product: {
      externalId: "acc_prod",
      title: "Red linen dress",
      description: "Relaxed midi dress",
      imageUrls: ["https://cdn.example/red.jpg"],
      includesHeadwear: false,
      synced: false,
      ...over,
    },
    photo: fakeJpeg("PIX"),
    photoType: "image/jpeg",
    oneTimeUserId: "11111111-2222-3333-4444-555555555555",
  };
}

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(routes: (url: string, init?: RequestInit) => Response): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return routes(url, init);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("Genlook request", () => {
  it("sends the photo as multipart, a one-time id, 1-day retention, and keeps head coverings", async () => {
    const { fetcher, calls } = fakeFetch((url) => {
      if (url.endsWith("/try-on/sync")) return Response.json({ generationId: "g", status: "COMPLETED", resultImageUrl: "https://storage.example/r.jpg" });
      if (url === "https://storage.example/r.jpg") return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response(null, { status: 204 });
    });
    const p = new GenlookProvider("gk_key", 0.04, false, fetcher);
    const r = await p.tryOn(req());
    expect(r.ok).toBe(true);
    const form = calls[0]!.init!.body as FormData;
    const data = JSON.parse(String(form.get("data")));
    expect(data.externalUserId).toBe("11111111-2222-3333-4444-555555555555");
    expect(data.output).toEqual({ watermark: false, aiLabel: false, keepForDays: 1 });
    expect(data.person).toEqual({ image: { source: { fileKey: "person" } }, keepHeadCovering: true });
    expect(data.products[0]).toMatchObject({ externalId: "acc_prod", title: "Red linen dress" });
    expect(form.get("person")).toBeInstanceOf(Blob);
    expect((calls[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("gk_key");

    expect(await p.deleteUserData("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: "https://api.genlook.app/tryon/v1/customers/11111111-2222-3333-4444-555555555555" });
    expect(calls.at(-1)!.init!.method).toBe("DELETE");
  });

  it("sends a reference for synced products and falls back to inline on PRODUCT_NOT_FOUND", async () => {
    let n = 0;
    const { fetcher, calls } = fakeFetch((url) => {
      if (url.endsWith("/try-on/sync")) {
        n++;
        return n === 1
          ? Response.json({ code: "PRODUCT_NOT_FOUND", status: 404 }, { status: 404 })
          : Response.json({ resultImageUrl: "https://storage.example/r.jpg" });
      }
      return new Response(PNG);
    });
    await new GenlookProvider("k", 0.04, false, fetcher).tryOn(req({ synced: true }));
    const first = JSON.parse(String((calls[0]!.init!.body as FormData).get("data")));
    const second = JSON.parse(String((calls[1]!.init!.body as FormData).get("data")));
    expect(first.products[0]).toEqual({ externalId: "acc_prod" });
    expect(second.products[0].title).toBe("Red linen dress");
  });

  it("never sends an empty description (Genlook rejects it): falls back to the product name", async () => {
    const { fetcher, calls } = fakeFetch((url) =>
      url.endsWith("/try-on/sync") ? Response.json({ resultImageUrl: "https://storage.example/r.jpg" }, { status: 201 }) : new Response(PNG),
    );
    await new GenlookProvider("k", 0.04, false, fetcher).tryOn(req({ description: "  " }));
    const data = JSON.parse(String((calls[0]!.init!.body as FormData).get("data")));
    expect(data.products[0].description).toBe("Red linen dress");
  });

  it("treats 201 Created (what Genlook really returns) as success", async () => {
    const { fetcher } = fakeFetch((url) =>
      url.endsWith("/try-on/sync") ? Response.json({ resultImageUrl: "https://storage.example/r.jpg" }, { status: 201 }) : new Response(PNG),
    );
    expect(await new GenlookProvider("k", 0.04, false, fetcher).tryOn(req())).toMatchObject({ ok: true });
  });

  it("maps content-policy errors and charges nothing", async () => {
    const { fetcher } = fakeFetch(() => Response.json({ code: "CONTENT_POLICY_VIOLATION" }, { status: 422 }));
    expect(await new GenlookProvider("k", 0.04, false, fetcher).tryOn(req())).toMatchObject({ ok: false, code: "content_policy", costMicroUsd: 0 });
  });
});

describe("Gemini request", () => {
  it("never stores the interaction and sends person image first", async () => {
    const { fetcher, calls } = fakeFetch((url) => {
      if (url === "https://cdn.example/red.jpg") return new Response(PNG, { headers: { "content-type": "image/png" } });
      return Response.json({
        steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: toBase64(PNG) }] }],
        usage: { total_input_tokens: 2400 },
      });
    });
    const r = await new GeminiTryOnProvider("g_key", "gemini-3.1-flash-image", fetcher).tryOn(req());
    expect(r.ok).toBe(true);
    const sent = calls.find((c) => c.url.endsWith("/v1beta/interactions"))!;
    const body = JSON.parse(String(sent.init!.body));
    expect(body.store).toBe(false);
    expect(body.model).toBe("gemini-3.1-flash-image");
    expect(body.input[0]).toMatchObject({ type: "image", mime_type: "image/jpeg", data: toBase64(fakeJpeg("PIX")) });
    expect(body.input[1]).toMatchObject({ type: "image", mime_type: "image/png" });
    expect(body.input.at(-1).text).toContain("Keep the person's own head covering");
    expect(body.response_format).toEqual({ type: "image", mime_type: "image/jpeg", image_size: "1K" });
    // 0.067 + 2400 tokens × 0.50 / 1M = 0.0682 USD
    if (r.ok) expect(r.costMicroUsd).toBe(68_200);
  });

  it("treats a text-only answer (e.g. a safety refusal) as a failure", async () => {
    const { fetcher } = fakeFetch((url) =>
      url.startsWith("https://cdn") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }] }),
    );
    expect(await new GeminiTryOnProvider("k", "gemini-3.1-flash-image", fetcher).tryOn(req())).toMatchObject({ ok: false, code: "content_policy" });
  });
});

describe("Vertex request", () => {
  it("sends personImage + productImages without a storage bucket", async () => {
    const { fetcher, calls } = fakeFetch((url) =>
      url.startsWith("https://cdn") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : Response.json({ predictions: [{ mimeType: "image/png", bytesBase64Encoded: toBase64(PNG) }] }),
    );
    const r = await new VertexTryOnProvider("proj", "us-central1", async () => "tok", fetcher).tryOn(req());
    expect(r.ok).toBe(true);
    const sent = calls.find((c) => c.url.includes("aiplatform"))!;
    expect(sent.url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/publishers/google/models/virtual-try-on-001:predict",
    );
    const body = JSON.parse(String(sent.init!.body));
    expect(body.parameters).toEqual({ sampleCount: 1 });
    expect(body.instances[0].personImage.image.bytesBase64Encoded).toBe(toBase64(fakeJpeg("PIX")));
    expect((sent.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
});

import { vi } from "vitest";
import { ResendProvider } from "../src/lib/email.js";
describe("fetch is never called as a method (Workers: 'Illegal invocation')", () => {
  it("every provider works with a fetch that refuses a foreign `this`", async () => {
    const strict = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect this reference");
      const u = String(input);
      if (u.includes("resend.com")) return Promise.resolve(Response.json({ id: "em_1" }));
      if (u.includes("genlook")) return Promise.resolve(u.includes("/customers/") ? new Response(null, { status: 204 }) : Response.json({ resultImageUrl: "https://storage.example/r.jpg" }, { status: 201 }));
      return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
    };
    vi.stubGlobal("fetch", strict);
    try {
      expect(await new ResendProvider("re_x", "Garrab <hello@garrabb.com>").send({ to: "a@b.example", subject: "s", html: "h", text: "t" }, "k")).toEqual({ ok: true, id: "em_1" });
      const g = new GenlookProvider("gk", 0.04, false);
      expect(await g.tryOn(req())).toMatchObject({ ok: true });
      expect(await g.deleteUserData("x")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
