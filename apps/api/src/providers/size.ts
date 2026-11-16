/**
 * Size finder (Phase 4, brief §5). Growth plan, clothing only, English and Arabic.
 *
 *  1. ONE AI call reads the product (title, description, sizes sold, first photo) and the shopper's
 *     answers, and suggests a size with two short reasons.
 *  2. CODE RULES check the answer: the size must be one the brand sells, at most two sizes away from the
 *     shopper's usual size, the alternative must be a neighbouring size, confidence is never "high"
 *     (we never have the brand's measurements).
 *  3. FALLBACK: if the AI fails or its answer breaks a rule, a plain rule gives the answer instead.
 *
 * The shopper's answers are used for this one request only: never stored, never logged.
 */
import type { Lang } from "@garrab/shared/strings";
import { workerFetch } from "../lib/http.js";
import { toBase64 } from "./google.js";

export type Prefer = "fitted" | "regular" | "loose";
export interface SizeQuestion {
  heightCm: number;
  weightKg: number | null;
  usualSize: string;
  bodyType: "slim" | "average" | "athletic" | "curvy" | "broad" | "prefer_not_to_say";
  prefer: Prefer;
}
export interface SizeProduct {
  title: string;
  description: string;
  sizes: string[];
  imageUrl: string | null;
}
export interface SizeAnswer {
  size: string;
  alternative: string | null;
  confidence: "medium" | "low";
  reasons: [string, string];
  source: "ai" | "rules";
}

// ---------------------------------------------------------------------------------------------
// Sizes

const LETTER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL"];
const ALIAS: Record<string, string> = { "2XS": "XXS", "3XS": "XXXS", "2XL": "XXL", XXXL: "3XL", XXXXL: "4XL", SMALL: "S", MEDIUM: "M", LARGE: "L" };
const ONE_SIZE = /^(one ?size|free ?size|os|onesize|فري ?سايز|مقاس واحد)$/i;

/** Normalise a size label for comparison: "xl " → "XL", "2xl" → "XXL", "38 " → "38". */
export function canon(s: string): string {
  const u = s.trim().toUpperCase().replace(/\s+/g, "");
  return ALIAS[u] ?? u;
}

/** The brand's sizes in order, smallest first (letter sizes or numbers). Unknown labels keep their order. */
export function orderSizes(sizes: string[]): string[] {
  const uniq = [...new Map(sizes.filter((s) => s.trim()).map((s) => [canon(s), s.trim()])).values()];
  const rank = (s: string): number => {
    const c = canon(s);
    const i = LETTER.indexOf(c);
    if (i >= 0) return i;
    const n = Number(c.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && /\d/.test(c) ? 100 + n : 1000;
  };
  return uniq.map((s, i) => ({ s, r: rank(s), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.s);
}

const indexIn = (sizes: string[], s: string): number => sizes.findIndex((x) => canon(x) === canon(s));

/** Where the shopper's usual size falls in this product's sizes (nearest letter/number), or -1. */
export function usualIndex(sizes: string[], usual: string): number {
  const exact = indexIn(sizes, usual);
  if (exact >= 0) return exact;
  const u = canon(usual);
  const ul = LETTER.indexOf(u);
  const un = Number(u.replace(/[^\d.]/g, ""));
  let best = -1;
  let bestD = Infinity;
  sizes.forEach((s, i) => {
    const c = canon(s);
    const l = LETTER.indexOf(c);
    const n = Number(c.replace(/[^\d.]/g, ""));
    const d = ul >= 0 && l >= 0 ? Math.abs(l - ul) : /\d/.test(u) && /\d/.test(c) ? Math.abs(n - un) / 2 : Infinity;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return bestD <= 2 ? best : -1;
}

/** Is the size finder offered for this product? Clothing with at least two real sizes. */
export function sizeFinderFits(kind: string, sizes: string[]): boolean {
  if (kind !== "clothing") return false;
  const real = sizes.filter((s) => s.trim() && !ONE_SIZE.test(s.trim()));
  return real.length >= 2;
}

// ---------------------------------------------------------------------------------------------
// Reasons (rules)

const R = {
  en: {
    usual: (s: string) => `You usually wear ${s}, and this piece comes in that size.`,
    nearest: (s: string) => `${s} is the closest size this piece comes in to your usual size.`,
    loose: "You like a looser fit, so the next size up is worth considering.",
    fitted: "You like a closer fit, so stay with your usual size.",
    regular: "Check the size notes on this page if you're between sizes.",
    noUsual: (s: string) => `${s} is a middle size for this piece. We couldn't match your usual size to its sizes.`,
  },
  ar: {
    usual: (s: string) => `مقاسك المعتاد ${s}، وهذه القطعة متوفرة بهذا المقاس.`,
    nearest: (s: string) => `${s} هو أقرب مقاس متوفر لهذه القطعة إلى مقاسك المعتاد.`,
    loose: "تفضّل القصّة الواسعة، لذا يمكنك التفكير في المقاس الأكبر.",
    fitted: "تفضّل القصّة المحددة، لذا ابقَ على مقاسك المعتاد.",
    regular: "راجع ملاحظات المقاس في هذه الصفحة إذا كنت بين مقاسين.",
    noUsual: (s: string) => `${s} مقاس متوسط لهذه القطعة. لم نتمكن من مطابقة مقاسك المعتاد مع مقاساتها.`,
    up: (s: string) => `${s} أكبر بدرجة من مقاسك المعتاد، بناءً على قصّة القطعة ووصفها.`,
    down: (s: string) => `${s} أصغر بدرجة من مقاسك المعتاد، بناءً على قصّة القطعة ووصفها.`,
    up2: (s: string) => `${s} أكبر بدرجتين من مقاسك المعتاد، لأن قصّة هذه القطعة ضيقة على الأرجح.`,
    down2: (s: string) => `${s} أصغر بدرجتين من مقاسك المعتاد، لأن قصّة هذه القطعة واسعة على الأرجح.`,
    alt: (s: string) => `إذا كنت بين مقاسين، فجرّب ${s} أيضًا.`,
  },
};

/**
 * Arabic reasons are written by us, not the model (the live check showed broken Arabic from the small
 * model). The AI still chooses the size; these fixed sentences explain it.
 */
export function arabicReasons(q: SizeQuestion, p: SizeProduct, size: string, alternative: string | null): [string, string] {
  const t = R.ar;
  const sizes = orderSizes(p.sizes);
  const ui = usualIndex(sizes, q.usualSize);
  const i = indexIn(sizes, size);
  const d = ui < 0 ? null : i - ui;
  const first =
    d === null ? t.noUsual(size) : d === 0 ? (indexIn(sizes, q.usualSize) >= 0 ? t.usual(size) : t.nearest(size)) : d === 1 ? t.up(size) : d === -1 ? t.down(size) : d > 0 ? t.up2(size) : t.down2(size);
  const second = alternative ? t.alt(alternative) : q.prefer === "loose" ? t.loose : q.prefer === "fitted" ? t.fitted : t.regular;
  return [first, second];
}

/** The fallback: a plain rule from the shopper's usual size and fit preference. Never fails. */
export function ruleSize(q: SizeQuestion, p: SizeProduct, lang: Lang): SizeAnswer {
  const sizes = orderSizes(p.sizes);
  const t = R[lang];
  const ui = usualIndex(sizes, q.usualSize);
  if (ui < 0) {
    const mid = sizes[Math.floor((sizes.length - 1) / 2)]!;
    return { size: mid, alternative: null, confidence: "low", reasons: [t.noUsual(mid), t.regular], source: "rules" };
  }
  const size = sizes[ui]!;
  const exact = indexIn(sizes, q.usualSize) >= 0;
  const up = sizes[ui + 1] ?? null;
  const down = sizes[ui - 1] ?? null;
  const alternative = q.prefer === "loose" || q.bodyType === "curvy" || q.bodyType === "broad" ? up : q.prefer === "fitted" ? null : (up ?? down);
  return {
    size,
    alternative,
    confidence: exact && q.weightKg !== null ? "medium" : "low",
    reasons: [exact ? t.usual(size) : t.nearest(size), q.prefer === "loose" ? t.loose : q.prefer === "fitted" ? t.fitted : t.regular],
    source: "rules",
  };
}

/** Code rules over the AI's answer. Returns null when the answer must not be shown (→ fallback). */
export function checkAnswer(raw: unknown, q: SizeQuestion, p: SizeProduct): SizeAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sizes = orderSizes(p.sizes);
  const i = typeof o.recommended_size === "string" ? indexIn(sizes, o.recommended_size) : -1;
  if (i < 0) return null; // a size the brand doesn't sell
  const ui = usualIndex(sizes, q.usualSize);
  if (ui >= 0 && Math.abs(i - ui) > 2) return null; // too far from what the shopper usually wears
  const ai = typeof o.alternative_size === "string" ? indexIn(sizes, o.alternative_size) : -1;
  const alternative = ai >= 0 && Math.abs(ai - i) === 1 ? sizes[ai]! : null;
  const reasons = Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim().slice(0, 160)) : [];
  if (reasons.length < 2) return null;
  // Never "high": we don't have the brand's measurements. Low when the shopper skipped weight or the size is a stretch.
  const confidence = q.weightKg === null || ui < 0 || Math.abs(i - ui) === 2 || o.confidence === "low" ? "low" : "medium";
  return { size: sizes[i]!, alternative, confidence, reasons: [reasons[0]!, reasons[1]!], source: "ai" };
}

// ---------------------------------------------------------------------------------------------
// The AI call

const SCHEMA = {
  type: "object",
  properties: {
    recommended_size: { type: "string", description: "Exactly one of the sizes this product is sold in." },
    alternative_size: { type: ["string", "null"], description: "A neighbouring size worth considering, or null." },
    confidence: { type: "string", enum: ["medium", "low"] },
    reasons: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "Two short, friendly sentences for the shopper." },
  },
  required: ["recommended_size", "alternative_size", "confidence", "reasons"],
};

export function sizePrompt(q: SizeQuestion, p: SizeProduct, lang: Lang): string {
  return [
    "You help a shopper choose a clothing size in an Egyptian online shop. Be careful and honest.",
    `Product: "${p.title}". ${p.description}`.slice(0, 1200),
    `Sizes sold: ${orderSizes(p.sizes).join(", ")}.`,
    `Shopper: height ${q.heightCm} cm${q.weightKg ? `, weight ${q.weightKg} kg` : ""}, usually wears ${q.usualSize}, body type ${q.bodyType.replace(/_/g, " ")}, likes a ${q.prefer} fit.`,
    "Judge the cut from the description and photo (loose abaya, fitted dress, stretch, etc). Pick ONE size from the sizes sold.",
    "Stay close to the shopper's usual size unless the cut clearly runs small or large.",
    `Write both reasons in ${lang === "ar" ? "Modern Standard Arabic, addressing the shopper in a neutral, polite form" : "plain English"}, under 20 words each. Do not mention the shopper's weight.`,
  ].join("\n");
}

export interface Sizer {
  readonly name: string;
  advise(q: SizeQuestion, p: SizeProduct, lang: Lang): Promise<{ raw: unknown; costMicroUsd: number }>;
}

export class GeminiSizer implements Sizer {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-3.5-flash-lite",
    private readonly fetcher: typeof fetch = workerFetch,
  ) {
    this.name = `gemini:${model}`;
  }

  async advise(q: SizeQuestion, p: SizeProduct, lang: Lang): Promise<{ raw: unknown; costMicroUsd: number }> {
    let image: { data: string; mime: string } | null = null;
    if (p.imageUrl) {
      try {
        const r = await this.fetcher(p.imageUrl, { signal: AbortSignal.timeout(10_000) });
        const mime = (r.headers.get("content-type") ?? "").split(";")[0]!.trim();
        if (r.ok && /^image\/(jpeg|png|webp)$/.test(mime)) image = { data: toBase64(new Uint8Array(await r.arrayBuffer())), mime };
      } catch {
        /* answer from the text only */
      }
    }
    const body = {
      model: this.model,
      store: false,
      generation_config: { seed: 7, temperature: 0 },
      input: [{ type: "text", text: sizePrompt(q, p, lang) }, ...(image ? [{ type: "image", mime_type: image.mime, data: image.data }] : [])],
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    };
    try {
      const r = await this.fetcher("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json", "Api-Revision": "2026-05-20" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return { raw: null, costMicroUsd: 0 };
      const j = (await r.json()) as {
        steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { total_input_tokens?: number; total_output_tokens?: number };
      };
      const text = (j.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).find((c) => c.type === "text")?.text;
      // gemini-3.5-flash-lite: 0.30 USD / 1M in, 2.50 USD / 1M out
      const cost = Math.round((j.usage?.total_input_tokens ?? 1500) * 0.3 + (j.usage?.total_output_tokens ?? 120) * 2.5);
      return { raw: text ? JSON.parse(text) : null, costMicroUsd: cost };
    } catch {
      return { raw: null, costMicroUsd: 0 };
    }
  }
}

/** Local/test sizer: the rule answer, phrased as an AI answer, so the whole path is exercised. */
export class MockSizer implements Sizer {
  readonly name = "mock";
  async advise(q: SizeQuestion, p: SizeProduct, lang: Lang): Promise<{ raw: unknown; costMicroUsd: number }> {
    const r = ruleSize(q, p, lang);
    return { raw: { recommended_size: r.size, alternative_size: r.alternative, confidence: r.confidence, reasons: r.reasons }, costMicroUsd: 500 };
  }
}

/** One call, code rules, fallback. */
export async function adviseSize(sizer: Sizer, q: SizeQuestion, p: SizeProduct, lang: Lang): Promise<{ answer: SizeAnswer; costMicroUsd: number }> {
  const { raw, costMicroUsd } = await sizer.advise(q, p, "en"); // reasons in English; Arabic ones are ours
  const checked = checkAnswer(raw, q, p);
  if (!checked) return { answer: ruleSize(q, p, lang), costMicroUsd };
  if (lang === "ar") checked.reasons = arabicReasons(q, p, checked.size, checked.alternative);
  return { answer: checked, costMicroUsd };
}
