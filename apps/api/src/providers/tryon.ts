import type { Env } from "../env.js";
import type { ImageType } from "../lib/photo.js";

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
  | { ok: false; code: TryOnErrorCode; costMicroUsd: 0; retryable: boolean };

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
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private body(req: TryOnRequest, inline: boolean): Record<string, unknown> {
    const p = req.product;
    const product = inline
      ? {
          externalId: p.externalId,
          title: p.title,
          description: p.description,
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
    if (res.status === 200) {
      resultUrl = ((await res.json()) as { resultImageUrl?: string }).resultImageUrl;
    } else if (res.status === 202) {
      const { generationId } = (await res.json()) as { generationId: string };
      const polled = await this.poll(generationId);
      if (polled.error) return { ok: false, ...mapGenlookError(polled.error, 500), costMicroUsd: 0 };
      resultUrl = polled.url;
    } else {
      const err = (await res.json().catch(() => ({}))) as GenlookError;
      return { ok: false, ...mapGenlookError(err.code, res.status), costMicroUsd: 0 };
    }
    if (!resultUrl) return { ok: false, code: "provider_error", costMicroUsd: 0, retryable: true };

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

export function tryOnProvider(env: Env): TryOnProvider {
  if (env.GENLOOK_API_KEY && env.ENVIRONMENT !== "test") {
    return new GenlookProvider(env.GENLOOK_API_KEY, Number(env.GENLOOK_USD_PER_CREDIT ?? "0.04"), env.GENLOOK_MOCK === "true");
  }
  if (env.ENVIRONMENT === "prod") throw new Error("GENLOOK_API_KEY missing in prod");
  return new MockTryOnProvider();
}
