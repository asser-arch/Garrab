#!/usr/bin/env node
/**
 * Live check of the size finder's AI call (same request the API sends). Prints Google's answer for
 * three shoppers on one sample product, EN and AR. Costs a fraction of a cent. No shopper data involved.
 * Usage: GEMINI_API_KEY=… node scripts/size-live.mjs
 */
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY missing");
const SCHEMA = {
  type: "object",
  properties: {
    recommended_size: { type: "string" },
    alternative_size: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["medium", "low"] },
    reasons: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
  },
  required: ["recommended_size", "alternative_size", "confidence", "reasons"],
};
const product = { title: "Linen wrap abaya", description: "Relaxed, flowing cut with wide sleeves. Falls to the ankle. No stretch.", sizes: ["S", "M", "L", "XL"] };
const shoppers = [
  { lang: "en", h: 160, w: 55, usual: "S", body: "slim", prefer: "regular" },
  { lang: "en", h: 170, w: 80, usual: "L", body: "curvy", prefer: "loose" },
  { lang: "ar", h: 165, w: null, usual: "M", body: "average", prefer: "fitted" },
];
let ok = 0;
for (const s of shoppers) {
  const prompt = [
    "You help a shopper choose a clothing size in an Egyptian online shop. Be careful and honest.",
    `Product: "${product.title}". ${product.description}`,
    `Sizes sold: ${product.sizes.join(", ")}.`,
    `Shopper: height ${s.h} cm${s.w ? `, weight ${s.w} kg` : ""}, usually wears ${s.usual}, body type ${s.body}, likes a ${s.prefer} fit.`,
    "Pick ONE size from the sizes sold. Stay close to the shopper's usual size unless the cut clearly runs small or large.",
    `Write both reasons in ${s.lang === "ar" ? "Modern Standard Arabic" : "plain English"}, under 20 words each. Do not mention the shopper's weight.`,
  ].join("\n");
  const t0 = Date.now();
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json", "Api-Revision": "2026-05-20" },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL ?? "gemini-3.5-flash-lite",
      store: false,
      generation_config: { seed: 7, temperature: 0 },
      input: [{ type: "text", text: prompt }],
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    }),
  });
  const body = await r.text();
  let out = body.slice(0, 400);
  try {
    const j = JSON.parse(body);
    if (j.error) out = `ERROR ${j.error.status} ${j.error.message}`;
    else {
      const text = (j.steps ?? []).filter((x) => x.type === "model_output").flatMap((x) => x.content ?? []).find((c) => c.type === "text")?.text;
      const a = JSON.parse(text);
      const valid = product.sizes.includes(a.recommended_size) && Array.isArray(a.reasons) && a.reasons.length === 2;
      if (valid) ok++;
      out = `${valid ? "VALID" : "INVALID"} ${JSON.stringify(a)}`;
    }
  } catch {
    // not JSON: the raw start of the body is printed
  }
  console.log(`${s.lang} usual ${s.usual}, ${s.prefer}: HTTP ${r.status} in ${Date.now() - t0} ms → ${out}`);
}
console.log(`${ok}/${shoppers.length} valid answers`);
if (ok < shoppers.length) process.exit(1);
