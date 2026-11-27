/**
 * Real-world size of a home décor product, read from its title, description and options (shop text), so room
 * previews show it at the right scale. Understands cm, mm and inches; height / width / depth / length /
 * diameter (English and Arabic); "30 x 20 x 50 cm"; Arabic-Indic digits. Returns a short plain line such as
 * "height 35 cm, diameter 15 cm", or null when no believable size is found.
 */

const LABELS: [RegExp, string][] = [
  [/^(?:h|ht|height|tall|high|ارتفاع|الارتفاع|ارتفاعه|الطول الكلي)$/i, "height"],
  [/^(?:w|wd|width|wide|عرض|العرض)$/i, "width"],
  [/^(?:d|dp|depth|deep|عمق|العمق)$/i, "depth"],
  [/^(?:l|len|length|long|طول|الطول)$/i, "length"],
  [/^(?:ø|⌀|dia|diam|diameter|قطر|القطر)$/i, "diameter"],
];
const UNIT = String.raw`(cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?|in(?:ch(?:es)?)?|"|”|سم|سنتي(?:متر)?|مم|ملم|مللي(?:متر)?|بوصة)`;
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;

function toCm(v: number, unit: string | undefined): number {
  const u = (unit ?? "cm").toLowerCase();
  if (/^(mm|millimet|مم|ملم|مللي)/.test(u)) return v / 10;
  if (/^(in|"|”|بوصة)/.test(u)) return v * 2.54;
  return v;
}
const fmt = (cm: number): string => `${Math.round(cm * 10) / 10} cm`;
const sane = (cm: number): boolean => cm >= 1 && cm <= 400;

function normalise(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/\s+/g, " ");
}

export function parseDimensions(...texts: (string | null | undefined)[]): string | null {
  const s = normalise(texts.filter(Boolean).join(" \n "));
  const found = new Map<string, number>();
  // "Height: 35 cm", "H 35cm", "Ø15 cm", "ارتفاع ٣٥ سم", "35 cm high"
  const labelled = new RegExp(String.raw`(?:^|[^\p{L}])(ø|⌀|[\p{L}]{1,10})\s*[:=\-]?\s*${NUM}\s*${UNIT}?(?![\p{L}\d])`, "giu");
  for (const m of s.matchAll(labelled)) {
    // Arabic "and" is written joined to the next word: "وقطر" = "and diameter".
    const word = m[1]!.length > 2 ? m[1]!.replace(/^و(?=[\u0600-\u06FF]{2})/, "") : m[1]!;
    const label = LABELS.find(([re]) => re.test(word))?.[1];
    if (!label || found.has(label)) continue;
    // A bare number with a one-letter label ("H 35") needs a unit somewhere in the text to be trusted.
    if (!m[3] && m[1]!.length <= 2 && !new RegExp(UNIT, "i").test(s)) continue;
    const cm = toCm(Number(m[2]!.replace(",", ".")), m[3] ?? (new RegExp(`\\d\\s*mm`, "i").test(s) && !/cm|سم/i.test(s) ? "mm" : "cm"));
    if (sane(cm)) found.set(label, cm);
  }
  const trailing = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(tall|high|wide|deep|long|diameter|في الارتفاع|ارتفاع|عرض|طول|قطر)`, "giu");
  for (const m of s.matchAll(trailing)) {
    const label = LABELS.find(([re]) => re.test(m[3]!.replace(/^في ال/, "")))?.[1] ?? (/tall|high|ارتفاع/i.test(m[3]!) ? "height" : null);
    if (!label || found.has(label)) continue;
    const cm = toCm(Number(m[1]!.replace(",", ".")), m[2]);
    if (sane(cm)) found.set(label, cm);
  }
  if (found.size) return [...found].map(([k, v]) => `${k} ${fmt(v)}`).join(", ");

  // "30 x 20 x 50 cm", "40×60cm", "30 * 45 سم"
  const multi = new RegExp(String.raw`${NUM}\s*${UNIT}?\s*[x×*]\s*${NUM}\s*${UNIT}?(?:\s*[x×*]\s*${NUM})?\s*${UNIT}`, "iu");
  const m = multi.exec(s);
  if (m) {
    const unit = m[6] ?? m[4] ?? m[2];
    const vals = [m[1], m[3], m[5]].filter((v): v is string => !!v).map((v) => toCm(Number(v.replace(",", ".")), unit));
    if (vals.every(sane)) return `${vals.map((v) => Math.round(v * 10) / 10).join(" × ")} cm`;
  }
  // A single size: "35cm vase", "مقاس ٤٠ سم"
  const one = new RegExp(String.raw`${NUM}\s*${UNIT}(?![\p{L}])`, "iu").exec(s);
  if (one) {
    const cm = toCm(Number(one[1]!.replace(",", ".")), one[2]);
    if (sane(cm)) return `about ${fmt(cm)}`;
  }
  return null;
}

/** The line added to the room-preview instructions, so the AI keeps the real scale. */
export function scaleHint(size: string): string {
  return `Real size of the item: ${size}. Keep this real size in the room: use everyday objects as a ruler (a sofa seat is about 45 cm high, a coffee table 40-45 cm, a side table about 55 cm, a dining table about 75 cm, a door about 200 cm, a ceiling about 270 cm). Do not make it bigger or smaller to fill the space.`;
}

/**
 * Read the size of home décor products that haven't been read yet (older products, or a brand cleared its own
 * size). Runs every 15 minutes; cheap (text only, no AI).
 */
export async function fillProductSizes(env: import("../env.js").Env, limit = 300): Promise<number> {
  const rows = await env.DB.prepare("SELECT id, title, description, sizes_json FROM products WHERE kind = 'decor' AND size_source IS NULL LIMIT ?")
    .bind(limit)
    .all<{ id: string; title: string; description: string | null; sizes_json: string | null }>();
  if (!rows.results.length) return 0;
  await env.DB.batch(
    rows.results.map((r) => {
      let sizes = "";
      try {
        sizes = (JSON.parse(r.sizes_json ?? "[]") as string[]).join(" ");
      } catch {
        /* none */
      }
      return env.DB.prepare("UPDATE products SET size_text = ?, size_source = 'auto' WHERE id = ? AND size_source IS NULL").bind(parseDimensions(r.title, r.description, sizes), r.id);
    }),
  );
  return rows.results.length;
}

/** A size typed by a brand or Garrab support: plain text, at most 80 characters. Empty = read it from the shop again. */
export async function setProductSize(env: import("../env.js").Env, productId: string, accountId: string | null, size: string): Promise<boolean> {
  const t = size.trim().replace(/\s+/g, " ").slice(0, 80);
  const r = await env.DB.prepare(
    `UPDATE products SET size_text = ?, size_source = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?${accountId ? " AND account_id = ?" : ""}`,
  )
    .bind(t || null, t ? "brand" : null, productId, ...(accountId ? [accountId] : []))
    .run();
  if (r.meta.changes === 1 && !t) await fillProductSizes(env, 50);
  return r.meta.changes === 1;
}
