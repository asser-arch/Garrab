#!/usr/bin/env node
/**
 * Diagnose failing shopper try-ons on Gemini: sends the newest product (photos fetched from their
 * public URLs) with a stock model photo to nano-banana and flash-image, exactly as the API does,
 * and prints Google's answer (status, error message, or whether an image came back). At most 2 previews.
 * Usage: GEMINI_API_KEY=… node scripts/diagnose-gemini.mjs <products.json> <stock-photo.jpg> [photo2.jpg]
 */
import { readFileSync } from "node:fs";

const [file, ...photos] = process.argv.slice(2);
const key = process.env.GEMINI_API_KEY;
const rows = JSON.parse(readFileSync(file, "utf8"))[0].results;
const p = rows[0];
if (!key || !p) {
  console.log("No key or no product.");
  process.exit(0);
}
const b64 = (buf) => Buffer.from(buf).toString("base64");
const imgs = [];
for (const u of JSON.parse(p.images_json).slice(0, 3)) {
  const r = await fetch(u);
  const mime = (r.headers.get("content-type") ?? "").split(";")[0];
  const buf = await r.arrayBuffer();
  console.log(`product photo ${u} -> HTTP ${r.status} ${mime} ${buf.byteLength} bytes`);
  if (r.ok && /^image\/(jpeg|png|webp)$/.test(mime)) imgs.push({ type: "image", mime_type: mime, data: b64(buf) });
}
const prompt = `Image 1 is a photo of a real person. The following images are product photos of one item:\n"${p.title}". ${p.description ?? ""}`.slice(0, 900) +
  "\nCreate one photorealistic image of the SAME person from image 1 wearing this item. Return only the image.";
for (const photo of photos.slice(0, 1)) {
  const person = readFileSync(photo);
  console.log(`person photo ${photo}: ${person.length} bytes`);
  for (const model of ["gemini-nano-banana-2.1", "gemini-3.1-flash-image"]) {
    const t0 = Date.now();
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json", "Api-Revision": "2026-05-20" },
      body: JSON.stringify({
        model,
        store: false,
        input: [{ type: "image", mime_type: "image/jpeg", data: b64(person) }, ...imgs, { type: "text", text: prompt }],
        response_format: { type: "image", mime_type: "image/jpeg", image_size: "1K" },
      }),
    });
    const text = await r.text();
    let summary = text.slice(0, 600);
    try {
      const j = JSON.parse(text);
      const out = (j.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []);
      summary = j.error
        ? `ERROR ${j.error.status} ${j.error.message}`
        : `status=${j.status ?? "?"} outputs=${out.map((c) => `${c.type}${c.data ? `(${c.data.length} b64)` : ""}${c.text ? `:"${c.text.slice(0, 200)}"` : ""}`).join(", ")} keys=${Object.keys(j).join(",")}`;
    } catch {
      // not JSON: print the raw start of the body
    }
    console.log(`${model}: HTTP ${r.status} in ${Date.now() - t0} ms -> ${summary}`);
  }
}
