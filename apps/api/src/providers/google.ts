/**
 * Google try-on providers (verified 14 Nov 2026):
 *
 * - GeminiTryOnProvider: a general image model (e.g. gemini-3.1-flash-image) asked to dress
 *   the person. Uses the Interactions API: POST /v1beta/interactions with `store: false`
 *   (the API STORES requests by default; we never allow that for shopper photos).
 *   ai.google.dev/gemini-api/docs/image-generation, /docs/interactions
 *
 * - VertexTryOnProvider: Google's dedicated try-on model `virtual-try-on-001` on Vertex AI
 *   (`:predict`, personImage + productImages, base64 PNG back). 0.06 USD per image.
 *   docs.cloud.google.com/…/generate-virtual-try-on-images
 *
 * Neither has a per-user delete call: nothing is stored on request (Gemini: store=false),
 * but Google keeps paid-tier prompts for a limited time for abuse monitoring.
 */
import { workerFetch } from "../lib/http.js";
import type { TryOnProvider, TryOnRequest, TryOnResult } from "./tryon.js";

/** List prices in USD (paid tier), checked 13–14 Nov 2026. */
export const GOOGLE_PRICES = {
  "gemini-3.1-flash-image": { perOutputImage: 0.067, inputPerMTokens: 0.5, tokensPerInputImage: 1120 },
  "gemini-nano-banana-2.1": { perOutputImage: 0.0336, inputPerMTokens: 1.5, tokensPerInputImage: 1120 },
  "gemini-3.1-flash-lite-image": { perOutputImage: 0.0336, inputPerMTokens: 0.25, tokensPerInputImage: 1120 },
  "virtual-try-on-001": { perOutputImage: 0.06, inputPerMTokens: 0, tokensPerInputImage: 0 },
} as const;
export type GoogleModel = keyof typeof GOOGLE_PRICES;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchImage(fetcher: typeof fetch, url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim();
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;
    return { data: toBase64(new Uint8Array(await r.arrayBuffer())), mime };
  } catch {
    return null;
  }
}

/** Google's error message only (their JSON error body), trimmed. */
function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string } };
    return `${j.error?.status ?? ""} ${j.error?.message ?? ""}`.trim().slice(0, 200);
  } catch {
    return body.replace(/\s+/g, " ").slice(0, 200);
  }
}

export function tryOnPrompt(req: TryOnRequest): string {
  const p = req.product;
  const head = p.includesHeadwear
    ? "The product includes its headwear; show it as in the product photos."
    : "Keep the person's own head covering or hair exactly as in image 1. Take nothing worn on the head from the product photos.";
  return [
    "Image 1 is a photo of a real person. The following images are product photos of one item:",
    `"${p.title}". ${p.description}`.slice(0, 900),
    "Create one photorealistic image of the SAME person from image 1 wearing this item.",
    "Keep their face, skin tone, body shape, pose, background and lighting unchanged.",
    "Reproduce the item faithfully: colour, pattern, fabric, cut and length as in the product photos.",
    head,
    "The product photos may have a shop logo or watermark printed on them: ignore it, it is not part of the item.",
    "Do not add text, logos or watermarks. Do not change anything else. Return only the image.",
  ].join("\n");
}

/** Room preview (home décor brands): the product placed in the shopper's own room. */
export function roomPrompt(req: TryOnRequest): string {
  const p = req.product;
  return [
    "Image 1 is a photo of a real room. The following images are product photos of one home décor item:",
    `"${p.title}". ${p.description}`.slice(0, 900),
    "Create one photorealistic image of the SAME room with this item placed where it would naturally go",
    "(a rug on the floor, a cushion on a sofa or bed, a lamp on a table or the floor, art or a mirror on a wall).",
    "Keep the room's layout, walls, furniture, light and camera angle unchanged. Keep the item's real colour, pattern, material and a believable size for the room.",
    "The product photos may have a shop logo or watermark printed on them: ignore it, it is not part of the item.",
    "Do not add people, text, logos or watermarks. Do not change anything else. Return only the image.",
  ].join("\n");
}

export class GeminiTryOnProvider implements TryOnProvider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: GoogleModel = "gemini-3.1-flash-image",
    private readonly fetcher: typeof fetch = workerFetch,
    /** "person": dress the person (fashion). "room": place the item in the room (home décor). */
    private readonly mode: "person" | "room" = "person",
  ) {
    this.name = `gemini:${model}${mode === "room" ? ":room" : ""}`;
  }

  /** Exposed for tests: the exact body we send. */
  async buildBody(req: TryOnRequest): Promise<Record<string, unknown> | null> {
    const productImages = (await Promise.all(req.product.imageUrls.slice(0, 3).map((u) => fetchImage(this.fetcher, u)))).filter(
      (x): x is { data: string; mime: string } => x !== null,
    );
    if (productImages.length === 0) return null;
    return {
      model: this.model,
      store: false, // never let Google keep shopper photos as stored interactions
      input: [
        { type: "image", mime_type: req.photoType === "image/heic" ? "image/heic" : req.photoType, data: toBase64(req.photo) },
        ...productImages.map((i) => ({ type: "image", mime_type: i.mime, data: i.data })),
        { type: "text", text: this.mode === "room" ? roomPrompt(req) : tryOnPrompt(req) },
      ],
      response_format: { type: "image", mime_type: "image/jpeg", image_size: "1K" },
    };
  }

  async tryOn(req: TryOnRequest): Promise<TryOnResult> {
    const body = await this.buildBody(req);
    if (!body) return { ok: false, code: "provider_error", costMicroUsd: 0, retryable: false, detail: "product photos could not be fetched" };
    const inputImages = (body.input as unknown[]).length - 1;
    let r: Response;
    try {
      r = await this.fetcher("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json", "Api-Revision": "2026-05-20" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(100_000),
      });
    } catch {
      return { ok: false, code: "timeout", costMicroUsd: 0, retryable: true };
    }
    if (r.status === 429) return { ok: false, code: "provider_busy", costMicroUsd: 0, retryable: true, detail: "HTTP 429" };
    if (!r.ok) {
      // 400 is also used for a bad API key; only call it a bad photo when the error is about the input.
      const msg = await r.text().catch(() => "");
      const badInput = r.status === 400 && !/api.?key|permission|billing/i.test(msg);
      return { ok: false, code: badInput ? "bad_photo" : "provider_error", costMicroUsd: 0, retryable: r.status >= 500, detail: `HTTP ${r.status} ${errorMessage(msg)}` };
    }
    const j = (await r.json()) as {
      steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string }[] }[];
      usage?: { total_input_tokens?: number };
    };
    const images = (j.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "image" && c.data);
    const last = images.at(-1);
    const price = GOOGLE_PRICES[this.model];
    const inputTokens = j.usage?.total_input_tokens ?? inputImages * price.tokensPerInputImage;
    const cost = Math.round((price.perOutputImage + (inputTokens / 1e6) * price.inputPerMTokens) * 1e6);
    // A refused or text-only answer (e.g. safety block) is still billed for input.
    if (!last?.data) {
      // No image back: Google's reason (finish reason / short text), never the shopper's photo.
      const text = (j.steps ?? []).flatMap((s) => s.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text?: string }).text ?? "").join(" ");
      const why = [(j as { status?: string }).status, text].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 200);
      return { ok: false, code: "content_policy", costMicroUsd: 0, retryable: false, detail: `no image: ${why || JSON.stringify(Object.keys(j))}` };
    }
    return { ok: true, image: fromBase64(last.data), contentType: last.mime_type ?? "image/jpeg", costMicroUsd: cost, productSynced: true };
  }

  /** Nothing is stored (store=false), so there is nothing to delete. */
  async deleteUserData(): Promise<boolean> {
    return true;
  }
}

export class VertexTryOnProvider implements TryOnProvider {
  readonly name = "vertex:virtual-try-on-001";
  constructor(
    private readonly project: string,
    private readonly location: string,
    private readonly accessToken: () => Promise<string>,
    private readonly fetcher: typeof fetch = workerFetch,
  ) {}

  async buildBody(req: TryOnRequest): Promise<Record<string, unknown> | null> {
    const first = req.product.imageUrls[0];
    const product = first ? await fetchImage(this.fetcher, first) : null;
    if (!product) return null;
    return {
      instances: [
        {
          personImage: { image: { bytesBase64Encoded: toBase64(req.photo) } },
          productImages: [{ image: { bytesBase64Encoded: product.data } }],
        },
      ],
      parameters: { sampleCount: 1 }, // no storageUri: bytes come back in the response
    };
  }

  async tryOn(req: TryOnRequest): Promise<TryOnResult> {
    const body = await this.buildBody(req);
    if (!body) return { ok: false, code: "provider_error", costMicroUsd: 0, retryable: false };
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/virtual-try-on-001:predict`;
    let r: Response;
    try {
      r = await this.fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(100_000),
      });
    } catch {
      return { ok: false, code: "timeout", costMicroUsd: 0, retryable: true };
    }
    if (r.status === 429) return { ok: false, code: "provider_busy", costMicroUsd: 0, retryable: true };
    if (!r.ok) return { ok: false, code: "provider_error", costMicroUsd: 0, retryable: r.status >= 500 };
    const j = (await r.json()) as { predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] };
    const p = j.predictions?.[0];
    if (!p?.bytesBase64Encoded) return { ok: false, code: "content_policy", costMicroUsd: 0, retryable: false };
    return {
      ok: true,
      image: fromBase64(p.bytesBase64Encoded),
      contentType: p.mimeType ?? "image/png",
      costMicroUsd: Math.round(GOOGLE_PRICES["virtual-try-on-001"].perOutputImage * 1e6),
      productSynced: true,
    };
  }

  async deleteUserData(): Promise<boolean> {
    return true;
  }
}
