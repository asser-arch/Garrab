/**
 * Remove a brand logo / watermark stamped in a corner of a product photo on a plain background.
 *
 * Works on raw RGBA pixels (no DOM), so the portal, the admin and the shopper pages share it.
 * Safe by design: it only acts when
 *  - the photo's border is a plain, light background (studio shot), and
 *  - a mark sits wholly inside a corner zone, is small, and is clearly apart from the product.
 * Anything else is left exactly as it was. Returns how many pixels were cleaned (0 = untouched).
 */

const CORNER_W = 0.38; // corner zone: outer 38% of the width…
const CORNER_H = 0.24; // …and outer 24% of the height
const MAX_MARK_AREA = 0.04; // a mark covers at most 4% of the photo
const FG_DIST = 42; // colour distance from the background that counts as "something"

export function removeCornerMarks(data: Uint8ClampedArray, w: number, h: number): number {
  if (w < 40 || h < 40) return 0;
  const at = (x: number, y: number): number => (y * w + x) * 4;

  // 1. Background: the photo's border must be one plain, light colour.
  const border: number[] = [];
  for (let x = 0; x < w; x += 2) border.push(at(x, 0), at(x, h - 1));
  for (let y = 0; y < h; y += 2) border.push(at(0, y), at(w - 1, y));
  const med = (k: number): number => {
    const v = border.map((i) => data[i + k]!).sort((a, b) => a - b);
    return v[v.length >> 1]!;
  };
  const bg = [med(0), med(1), med(2)] as const;
  if (Math.min(bg[0], bg[1], bg[2]) < 200) return 0; // not a light studio background
  const dist = (i: number): number => Math.max(Math.abs(data[i]! - bg[0]), Math.abs(data[i + 1]! - bg[1]), Math.abs(data[i + 2]! - bg[2]));
  const plain = border.filter((i) => dist(i) < 24).length / border.length;
  if (plain < 0.85) return 0; // busy background: never touch

  // 2. Connected groups of "something" pixels (not background).
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const groups: { area: number; x0: number; y0: number; x1: number; y1: number; px: number[] }[] = [];
  const stack: number[] = [];
  for (let p = 0; p < n; p++) {
    if (label[p] !== -1 || dist(p * 4) < FG_DIST) continue;
    const g = { area: 0, x0: w, y0: h, x1: 0, y1: 0, px: [] as number[] };
    const id = groups.push(g) - 1;
    label[p] = id;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w;
      const y = (q - x) / w;
      g.area++;
      if (g.px.length < 200_000) g.px.push(q);
      if (x < g.x0) g.x0 = x;
      if (x > g.x1) g.x1 = x;
      if (y < g.y0) g.y0 = y;
      if (y > g.y1) g.y1 = y;
      // 8-connected, and bridge 1-pixel gaps (thin script logos) by also looking 2 pixels away.
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const r = ny * w + nx;
          if (label[r] === -1 && dist(r * 4) >= FG_DIST) {
            label[r] = id;
            stack.push(r);
          }
        }
    }
  }
  if (groups.length < 2) return 0;

  // 3. The product: the biggest group. Marks: small groups wholly inside a corner zone, apart from it.
  const product = groups.reduce((a, b) => (b.area > a.area ? b : a));
  const productId = groups.indexOf(product);
  const gap = Math.max(4, Math.round(Math.min(w, h) * 0.015));
  const inCorner = (g: (typeof groups)[number]): boolean => {
    const left = g.x1 < w * CORNER_W;
    const right = g.x0 > w * (1 - CORNER_W);
    const top = g.y1 < h * CORNER_H;
    const bottom = g.y0 > h * (1 - CORNER_H);
    return (left || right) && (top || bottom);
  };
  // Apart from the product = no product pixel within a small gap around the mark (real pixels, not boxes:
  // a logo can sit inside the product's bounding box, e.g. beside a wide lampshade).
  const touchesProduct = (g: (typeof groups)[number]): boolean => {
    for (let y = Math.max(0, g.y0 - gap); y <= Math.min(h - 1, g.y1 + gap); y++)
      for (let x = Math.max(0, g.x0 - gap); x <= Math.min(w - 1, g.x1 + gap); x++) if (label[y * w + x] === productId) return true;
    return false;
  };
  const marks = groups.filter((g) => g !== product && g.area < n * MAX_MARK_AREA && inCorner(g) && !touchesProduct(g));
  if (!marks.length) return 0;

  // 4. Paint the marks (and a 2-pixel halo for soft edges) with the background colour.
  let cleaned = 0;
  for (const g of marks)
    for (const q of g.px) {
      const x = q % w;
      const y = (q - x) / w;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const r = ny * w + nx;
          if (label[r] === productId) continue; // never paint the product
          const i = r * 4;
          if (data[i] === bg[0] && data[i + 1] === bg[1] && data[i + 2] === bg[2]) continue;
          data[i] = bg[0];
          data[i + 1] = bg[1];
          data[i + 2] = bg[2];
          cleaned++;
        }
    }
  // 5. JPEG ghosts: faint halos around the letters reach further than 2 pixels. In each mark's area (plus a
  // margin that stays inside the product gap), anything faint (close to the background) becomes background.
  const halo = Math.min(gap - 1, 8);
  for (const g of marks)
    for (let y = Math.max(0, g.y0 - halo); y <= Math.min(h - 1, g.y1 + halo); y++)
      for (let x = Math.max(0, g.x0 - halo); x <= Math.min(w - 1, g.x1 + halo); x++) {
        const r = y * w + x;
        if (label[r] === productId) continue;
        const i = r * 4;
        if (data[i] === bg[0] && data[i + 1] === bg[1] && data[i + 2] === bg[2]) continue;
        data[i] = bg[0];
        data[i + 1] = bg[1];
        data[i + 2] = bg[2];
        cleaned++;
      }
  return cleaned;
}
