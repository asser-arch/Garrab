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
