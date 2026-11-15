/**
 * Scores a stock-model test result with a vision model (brief §6.4 rubric).
 * Gemini Interactions API with structured JSON output (response_format text + application/json + schema),
 * `store: false`, fixed seed. Verified in ai.google.dev/gemini-api/docs/structured-output (14 Nov 2026).
 */
import { appFetch } from "../lib/products.js";
import { workerFetch } from "../lib/http.js";
import type { Env } from "../env.js";
import { isLocal } from "../env.js";
import { toBase64 } from "./google.js";

export interface Score {
  garment_preserved: number;
  no_artifacts: number;
  plausible_fit: number;
  overall: number;
  /** One plain-language sentence a shop owner understands. */
  reason: string;
}

export interface ScoringProvider {
  readonly name: string;
  score(input: { title: string; productImageUrl: string; result: Uint8Array; resultType: string }): Promise<{ score: Score | null; costMicroUsd: number }>;
}

const SCHEMA = {
  type: "object",
  properties: {
    garment_preserved: { type: "integer", minimum: 1, maximum: 5, description: "Colour, pattern, cut and length match the product photo." },
    no_artifacts: { type: "integer", minimum: 1, maximum: 5, description: "No distorted hands, faces, extra limbs, smears or broken edges." },
    plausible_fit: { type: "integer", minimum: 1, maximum: 5, description: "The item sits on the body believably." },
    overall: { type: "integer", minimum: 1, maximum: 5, description: "Would a shop owner be happy to show this to a shopper? 5 = yes without hesitation." },
    reason: { type: "string", description: "One short plain-English sentence for the shop owner explaining the overall score." },
  },
  required: ["garment_preserved", "no_artifacts", "plausible_fit", "overall", "reason"],
};

function clamp(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 1;
}

export class GeminiScorer implements ScoringProvider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-3.5-flash-lite",
    private readonly fetcher: typeof fetch = workerFetch,
  ) {
    this.name = `gemini:${model}`;
  }

  async score(input: { title: string; productImageUrl: string; result: Uint8Array; resultType: string }): Promise<{ score: Score | null; costMicroUsd: number }> {
    let product: { data: string; mime: string } | null = null;
    try {
      const r = await this.fetcher(input.productImageUrl, { signal: AbortSignal.timeout(15_000) });
      const mime = (r.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (r.ok && /^image\/(jpeg|png|webp)$/.test(mime)) product = { data: toBase64(new Uint8Array(await r.arrayBuffer())), mime };
    } catch {
      /* scored without the reference below */
    }
    const body = {
      model: this.model,
      store: false,
      generation_config: { seed: 7 },
      input: [
        {
          type: "text",
          text: `You are checking an AI virtual try-on result for a small fashion shop. Product: "${input.title}". ${
            product ? "Image 1 is the product photo. Image 2 is the try-on result on a stock model." : "The image is the try-on result on a stock model."
          } Score strictly. A result with any visible distortion of the face or hands cannot score above 3 overall.`,
        },
        ...(product ? [{ type: "image", mime_type: product.mime, data: product.data }] : []),
        { type: "image", mime_type: input.resultType, data: toBase64(input.result) },
      ],
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    };
    try {
      const r = await this.fetcher("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json", "Api-Revision": "2026-05-20" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) return { score: null, costMicroUsd: 0 };
      const j = (await r.json()) as {
        steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { total_input_tokens?: number; total_output_tokens?: number };
      };
      const text = (j.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).find((c) => c.type === "text")?.text;
      // gemini-3.5-flash-lite: 0.30 USD / 1M in, 2.50 USD / 1M out (paid tier, 13 Nov 2026)
      const cost = Math.round(((j.usage?.total_input_tokens ?? 2500) * 0.3 + (j.usage?.total_output_tokens ?? 200) * 2.5));
      if (!text) return { score: null, costMicroUsd: cost };
      const o = JSON.parse(text) as Record<string, unknown>;
      return {
        score: {
          garment_preserved: clamp(o.garment_preserved),
          no_artifacts: clamp(o.no_artifacts),
          plausible_fit: clamp(o.plausible_fit),
          overall: clamp(o.overall),
          reason: String(o.reason ?? "").slice(0, 240),
        },
        costMicroUsd: cost,
      };
    } catch {
      return { score: null, costMicroUsd: 0 };
    }
  }
}

/**
 * Local/test scorer: deterministic. Titles containing "[low]" score 2, "[review]" score 3,
 * everything else 4.
 */
export class MockScorer implements ScoringProvider {
  readonly name = "mock";
  async score(input: { title: string }): Promise<{ score: Score; costMicroUsd: number }> {
    const overall = /\[low\]/i.test(input.title) ? 2 : /\[review\]/i.test(input.title) ? 3 : 4;
    const reason =
      overall >= 4 ? "The product looks right on the model." : overall === 3 ? "Mostly right, but some details look off." : "The colour and shape don't match the product well.";
    return { score: { garment_preserved: overall, no_artifacts: overall, plausible_fit: overall, overall, reason }, costMicroUsd: 1000 };
  }
}

export function scoringProvider(env: Env): ScoringProvider {
  if (env.GEMINI_API_KEY && env.ENVIRONMENT !== "test") return new GeminiScorer(env.GEMINI_API_KEY, env.GEMINI_TEXT_MODEL ?? "gemini-3.5-flash-lite", appFetch(env));
  if (isLocal(env)) return new MockScorer();
  throw new Error("GEMINI_API_KEY missing");
}
