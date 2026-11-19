/**
 * The main colours of a logo, read in the browser (nothing is uploaded for this).
 * Pixels are grouped into close colours; see-through and near-white pixels (the background) are skipped;
 * colourful groups rank above greys of the same size; near-duplicates are merged.
 */

const toHex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Count the colours of RGBA pixels. Exported for tests. */
export function dominantColors(data: Uint8ClampedArray, max = 6): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const whites = { n: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (data[i + 3]! < 200) continue; // see-through
    if (Math.min(r, g, b) > 235) {
      whites.n++;
      whites.r += r;
      whites.g += g;
      whites.b += b;
      continue; // white background
    }
    total++;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const x = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    x.n++;
    x.r += r;
    x.g += g;
    x.b += b;
    buckets.set(k, x);
  }
  // A white logo on a see-through background: white is its colour.
  if (total === 0) return whites.n ? [toHex(whites.r / whites.n, whites.g / whites.n, whites.b / whites.n)] : [];
  const groups = [...buckets.values()]
    .filter((x) => x.n >= total * 0.005)
    .map((x) => {
      const r = x.r / x.n;
      const g = x.g / x.n;
      const b = x.b / x.n;
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      return { r, g, b, score: x.n * (0.6 + sat) };
    })
    .sort((a, b) => b.score - a.score);
  const out: { r: number; g: number; b: number }[] = [];
  for (const c of groups) {
    if (out.some((o) => Math.hypot(o.r - c.r, o.g - c.g, o.b - c.b) < 48)) continue;
    out.push(c);
    if (out.length === max) break;
  }
  return out.map((c) => toHex(c.r, c.g, c.b));
}

/** Read a logo (blob: or same-site address) and return its main colours, or [] if it can't be read. */
export async function logoColors(src: string, max = 6): Promise<string[]> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, 120 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0, w, h);
    return dominantColors(ctx.getImageData(0, 0, w, h).data, max);
  } catch {
    return [];
  }
}

/** Contrast of a colour against the page's white (WCAG). */
export function contrastOnWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lum = [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  return (0.9646 + 0.05) / (lum + 0.05); // page background #FCFBF8 ≈ luminance 0.9646
}

/**
 * Tidy an uploaded logo in the browser: a plain white (or near-white) background touching the edges is
 * made transparent, and empty margins are cropped, so the logo shows large and sits on any page.
 * Logos that are already transparent are only cropped. Returns a PNG, or the original file if anything
 * goes wrong.
 */
export async function cleanLogo(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const light = (i: number): number => Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
    // Flood from the edges through near-white pixels only: white inside the logo (letters, shapes) stays.
    const seen = new Uint8Array(w * h);
    const stack: number[] = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    let cleared = 0;
    while (stack.length) {
      const p = stack.pop()!;
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      if (d[i + 3]! < 16) continue; // already see-through: nothing to do, but don't spread through it
      const l = light(i);
      if (l < 225) continue;
      // Soft edge: pure white → fully clear; light grey (anti-aliasing) → partly clear.
      d[i + 3] = l >= 245 ? 0 : Math.round(d[i + 3]! * ((245 - l) / 20));
      cleared++;
      const x = p % w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (p >= w) stack.push(p - w);
      if (p < w * (h - 1)) stack.push(p + w);
    }
    // Crop to what's visible, with a small margin.
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (d[(y * w + x) * 4 + 3]! > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
    if (maxX < 0) return file; // nothing left: not a logo on white, keep it as it was
    if (cleared === 0 && minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return file;
    ctx.putImageData(img, 0, 0);
    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
    const sx = Math.max(0, minX - pad);
    const sy = Math.max(0, minY - pad);
    const cw = Math.min(w, maxX + pad + 1) - sx;
    const ch = Math.min(h, maxY + pad + 1) - sy;
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    out.getContext("2d")!.drawImage(canvas, sx, sy, cw, ch, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    if (!blob || blob.size > 2 * 1024 * 1024) return file;
    return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + ".png", { type: "image/png" });
  } catch {
    return file;
  }
}
