import { workerFetch } from "../lib/http.js";
import type { Env } from "../env.js";
import type { ImageType } from "../lib/photo.js";
import { GeminiTryOnProvider } from "./google.js";
import { appFetch } from "../lib/products.js";

export interface TryOnProduct {
  /** Stable id we give the provider: `{accountId}_{productId}`. */
  externalId: string;
  title: string;
  description: string;
  imageUrls: string[];
  /** Product is sold with headwear (e.g. abaya with shawl). Otherwise we keep the shopper's own. */
  includesHeadwear: boolean;
  /** We already sent this product inline once; try a reference first. */
  synced: boolean;
}

export interface TryOnRequest {
  product: TryOnProduct;
  photo: Uint8Array;
  photoType: ImageType;
  /** Random, single-use id. Used only to delete the shopper's data at the provider. */
  oneTimeUserId: string;
}

export type TryOnResult =
  | { ok: true; image: Uint8Array; contentType: string; costMicroUsd: number; productSynced: boolean }
  /** detail: provider status and error code only (never photos or shopper data), for logs and checks. */
  | { ok: false; code: TryOnErrorCode; costMicroUsd: 0; retryable: boolean; detail?: string };

export type TryOnErrorCode =
  | "content_policy"
  | "bad_photo"
  | "provider_busy"
  | "provider_credits"
  | "provider_error"
  | "timeout";

export interface TryOnProvider {
  readonly name: string;
  tryOn(req: TryOnRequest): Promise<TryOnResult>;
  /** Delete everything the provider holds for this one-time id. Must be idempotent. */
  deleteUserData(oneTimeUserId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Genlook (docs.genlook.app/docs/tryon-api, verified 13 Nov 2026)

const GENLOOK_BASE = "https://api.genlook.app/tryon/v1";

interface GenlookError {
  code?: string;
  message?: string;
}

function mapGenlookError(code: string | undefined, status: number): { code: TryOnErrorCode; retryable: boolean } {
  switch (code) {
    case "CONTENT_POLICY_VIOLATION":
      return { code: "content_policy", retryable: false };
    case "INVALID_IMAGE":
    case "UNSUPPORTED_IMAGE_TYPE":
    case "FILE_TOO_LARGE":
    case "CUSTOMER_IMAGE_REQUIRED":
      return { code: "bad_photo", retryable: false };
    case "RATE_LIMITED":
    case "QUOTA_EXCEEDED":
      return { code: "provider_busy", retryable: true };
    case "INSUFFICIENT_CREDITS":
      return { code: "provider_credits", retryable: false };
    case "GENERATION_TIMEOUT":
      return { code: "timeout", retryable: true };
    default:
      return { code: "provider_error", retryable: status >= 500 };
  }
}

export class GenlookProvider implements TryOnProvider {
  readonly name = "genlook";
  constructor(
    private readonly apiKey: string,
    private readonly usdPerCredit: number,
    private readonly mock: boolean,
    private readonly fetcher: typeof fetch = workerFetch,
  ) {}

  private body(req: TryOnRequest, inline: boolean): Record<string, unknown> {
    const p = req.product;
    const product = inline
      ? {
          externalId: p.externalId,
          title: p.title,
          // Genlook requires a non-empty description (VALIDATION_FAILED otherwise, seen 15 Nov):
          // products added by hand often have none, so fall back to the name.
          description: p.description.trim() || p.title,
          images: p.imageUrls.slice(0, 6).map((url) => ({ source: { url } })),
        }
      : { externalId: p.externalId };
    return {
      products: [product],
      person: { image: { source: { fileKey: "person" } }, keepHeadCovering: !p.includesHeadwear },
      externalUserId: req.oneTimeUserId,
      output: { watermark: false, aiLabel: false, keepForDays: 1 },
      ...(this.mock ? { mock: true } : {}),
    };
  }

  private async call(req: TryOnRequest, inline: boolean): Promise<Response> {
    const form = new FormData();
    form.set("data", JSON.stringify(this.body(req, inline)));
    const ext = req.photoType.split("/")[1] ?? "jpg";
    form.set("person", new Blob([req.photo], { type: req.photoType }), `photo.${ext}`);
    return this.fetcher(`${GENLOOK_BASE}/try-on/sync`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey },
      body: form,
      signal: AbortSignal.timeout(100_000),
    });
  }

  private async poll(generationId: string): Promise<{ url?: string; error?: string }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await this.fetcher(`${GENLOOK_BASE}/generations/${encodeURIComponent(generationId)}`, {
        headers: { "x-api-key": this.apiKey },
      });
      const j = (await r.json()) as { status?: string; resultImageUrl?: string; errorCode?: string };
      if (j.status === "COMPLETED" && j.resultImageUrl) return { url: j.resultImageUrl };
      if (j.status === "FAILED") return { error: j.errorCode ?? "GENERATION_FAILED" };
    }
    return { error: "GENERATION_TIMEOUT" };
  }

  async tryOn(req: TryOnRequest): Promise<TryOnResult> {
    let inline = !req.product.synced;
    let res: Response;
    try {
      res = await this.call(req, inline);
      if (res.status === 404 && !inline) {
        const err = (await res.clone().json().catch(() => ({}))) as GenlookError;
        if (err.code === "PRODUCT_NOT_FOUND") {
          inline = true;
          res = await this.call(req, inline);
        }
      }
    } catch {
      return { ok: false, code: "timeout", costMicroUsd: 0, retryable: true };
    }

    let resultUrl: string | undefined;
    // Success is 200 or 201 (Genlook answers 201 Created; seen in the 15 Nov delete check and bake-off).
    if (res.status === 200 || res.status === 201) {
      resultUrl = ((await res.json()) as { resultImageUrl?: string }).resultImageUrl;
    } else if (res.status === 202) {
      const { generationId } = (await res.json()) as { generationId: string };
      const polled = await this.poll(generationId);
      if (polled.error) return { ok: false, ...mapGenlookError(polled.error, 500), costMicroUsd: 0 };
      resultUrl = polled.url;
    } else {
      const err = (await res.json().catch(() => ({}))) as GenlookError;
      return { ok: false, ...mapGenlookError(err.code, res.status), costMicroUsd: 0, detail: `HTTP ${res.status} ${err.code ?? ""}`.trim() };
    }
    if (!resultUrl) return { ok: false, code: "provider_error", costMicroUsd: 0, retryable: true, detail: `HTTP ${res.status} without resultImageUrl` };

    // Fetch the result into memory; the signed provider URL never reaches the browser.
    const img = await this.fetcher(resultUrl);
    if (!img.ok) return { ok: false, code: "provider_error", costMicroUsd: 0, retryable: true };
    const image = new Uint8Array(await img.arrayBuffer());
    return {
      ok: true,
      image,
      contentType: img.headers.get("content-type") ?? "image/jpeg",
      costMicroUsd: this.mock ? 0 : Math.round(this.usdPerCredit * 1_000_000),
      productSynced: true,
    };
  }

  async deleteUserData(oneTimeUserId: string): Promise<boolean> {
    try {
      const r = await this.fetcher(`${GENLOOK_BASE}/customers/${encodeURIComponent(oneTimeUserId)}`, {
        method: "DELETE",
        headers: { "x-api-key": this.apiKey },
      });
      return r.status === 204 || r.status === 200 || r.status === 404;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Mock: returns the shopper photo unchanged (like Genlook `mock: true`), records deletes.

export class MockTryOnProvider implements TryOnProvider {
  readonly name = "mock";
  /** Inspectable by tests. */
  static deleted: string[] = [];
  static failNext: TryOnErrorCode | null = null;

  async tryOn(req: TryOnRequest): Promise<TryOnResult> {
    if (MockTryOnProvider.failNext) {
      const code = MockTryOnProvider.failNext;
      MockTryOnProvider.failNext = null;
      return { ok: false, code, costMicroUsd: 0, retryable: false };
    }
    return { ok: true, image: req.photo, contentType: req.photoType, costMicroUsd: 40_000, productSynced: true };
  }

  async deleteUserData(oneTimeUserId: string): Promise<boolean> {
    MockTryOnProvider.deleted.push(oneTimeUserId);
    return true;
  }
}

/**
 * Try the main provider; on a provider-side failure (busy, error, timeout) try the backup once.
 * A refusal (content rules) or an unusable photo is final: another model would only cost more.
 */
/** A temporary error (the AI service is overloaded, rate limited or slow), not a problem with the product or photo. */
export function isTemporary(r: { code: string; retryable: boolean; detail?: string | undefined }): boolean {
  if (r.code === "content_policy" || r.code === "bad_photo" || r.code === "provider_credits") return false;
  return r.retryable || r.code === "provider_busy" || r.code === "timeout" || /\b(429|500|502|503|504)\b|high demand|overloaded|unavailable/i.test(r.detail ?? "");
}

export class FallbackTryOnProvider implements TryOnProvider {
  readonly name: string;
  constructor(
    private readonly primary: TryOnProvider,
    private readonly backup: TryOnProvider,
  ) {
    this.name = primary.name;
  }

  /** The provider that produced the last result (for usage records). */
  lastUsed: string = "";

  /** Wait before the last attempt when both models are overloaded (0 in tests). */
  retryWaitMs = 1500;

  async tryOn(req: TryOnRequest): Promise<TryOnResult> {
    const r = await this.primary.tryOn(req);
    this.lastUsed = this.primary.name;
    if (r.ok || r.code === "content_policy" || r.code === "bad_photo") return r;
    this.lastUsed = this.backup.name;
    let b = await this.backup.tryOn(req);
    // Both overloaded (Google "high demand" spikes are usually seconds long): wait a moment, try once more.
    if (!b.ok && isTemporary(r) && isTemporary(b)) {
      await new Promise((res) => setTimeout(res, this.retryWaitMs));
      const again = await this.primary.tryOn(req);
      this.lastUsed = this.primary.name;
      if (again.ok) return again;
      b = again;
    }
    return b.ok ? b : { ...b, detail: `${this.primary.name}: ${r.code}${r.detail ? ` ${r.detail}` : ""}; ${this.backup.name}: ${b.code}${b.detail ? ` ${b.detail}` : ""}` };
  }

  async deleteUserData(oneTimeUserId: string): Promise<boolean> {
    const [a, b] = await Promise.all([this.primary.deleteUserData(oneTimeUserId), this.backup.deleteUserData(oneTimeUserId)]);
    return a && b;
  }
}

/**
 * The shopper try-on provider (Asser, 15 Nov, after the bake-off: nano-banana 3.6/5, flash-image 3.3/5,
 * Genlook 1.9/5). TRYON_PROVIDER: "gemini" (default) = nano-banana with flash-image as backup;
 * "genlook" = Genlook (kept for a later re-test).
 */
export function tryOnProvider(env: Env, mode: "person" | "room" = "person"): TryOnProvider {
  if (env.AI_MOCK === "true" && env.ENVIRONMENT !== "prod") return new MockTryOnProvider(); // free fake AI (staging)
  if (env.ENVIRONMENT !== "test") {
    // Room preview is Google only (Genlook dresses people; it doesn't place objects in rooms).
    if ((mode === "room" || (env.TRYON_PROVIDER ?? "gemini") === "gemini") && env.GEMINI_API_KEY) {
      const f = appFetch(env);
      return new FallbackTryOnProvider(
        new GeminiTryOnProvider(env.GEMINI_API_KEY, "gemini-nano-banana-2.1", f, mode),
        new GeminiTryOnProvider(env.GEMINI_API_KEY, "gemini-3.1-flash-image", f, mode),
      );
    }
    if (env.TRYON_PROVIDER === "genlook" && env.GENLOOK_API_KEY) {
      return new GenlookProvider(env.GENLOOK_API_KEY, Number(env.GENLOOK_USD_PER_CREDIT ?? "0.04"), env.GENLOOK_MOCK === "true");
    }
  }
  if (env.ENVIRONMENT === "prod") throw new Error("No try-on provider key in prod (GEMINI_API_KEY or GENLOOK_API_KEY)");
  return new MockTryOnProvider();
}
