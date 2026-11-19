import { PHOTO } from "@garrab/shared/plans";

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

/** Detect the real image type from magic bytes. Never trust the declared MIME type. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(ascii(8, 12)))
    return "image/heic";
  return null;
}

/**
 * Remove metadata from a JPEG: every APPn segment except APP0 (JFIF), and COM segments.
 * EXIF (GPS, device, time) lives in APP1. The browser already re-encodes photos, which
 * drops EXIF; this is the server-side safety net.
 */
export function stripJpegMetadata(src: Uint8Array): Uint8Array {
  if (src[0] !== 0xff || src[1] !== 0xd8) return src;
  const out: Uint8Array[] = [src.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= src.length) {
    if (src[i] !== 0xff) return src; // malformed: leave as is (provider will reject if broken)
    const marker = src[i + 1] ?? 0;
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      // Start of scan: the rest is image data.
      out.push(src.subarray(i));
      return concat(out);
    }
    const len = ((src[i + 2] ?? 0) << 8) | (src[i + 3] ?? 0);
    const end = i + 2 + len;
    if (len < 2 || end > src.length) return src;
    const isApp = marker >= 0xe1 && marker <= 0xef; // APP1..APP15
    const isCom = marker === 0xfe;
    if (!isApp && !isCom) out.push(src.subarray(i, end));
    i = end;
  }
  out.push(src.subarray(i));
  return concat(out);
}

/**
 * Remove metadata from a HEIC/HEIF photo (iPhone format), in place on a copy: the payloads of its
 * "Exif" items (GPS, device, time) and "mime" items (XMP) are blanked; the picture is untouched.
 * Browsers that can't read HEIC (Chrome on a Mac) send the original file, so this is the only
 * cleaning such photos get. Returns null if the file can't be parsed: the caller refuses it rather
 * than send a photo with its location to the AI provider.
 */
export function stripHeicMetadata(src: Uint8Array): Uint8Array | null {
  const b = src.slice();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u = (o: number, n: number): number => (n === 0 ? 0 : n === 1 ? b[o]! : n === 2 ? dv.getUint16(o) : n === 4 ? dv.getUint32(o) : Number(dv.getBigUint64(o)));
  const type = (o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  /** Child boxes in [from, to): { type, start (header), body, end }. */
  const boxes = (from: number, to: number): { type: string; body: number; end: number }[] => {
    const out: { type: string; body: number; end: number }[] = [];
    let o = from;
    while (o + 8 <= to) {
      let size = u(o, 4);
      let head = 8;
      if (size === 1) {
        if (o + 16 > to) return out;
        size = u(o + 8, 8);
        head = 16;
      } else if (size === 0) size = to - o;
      if (size < head || o + size > to) return out;
      out.push({ type: type(o + 4), body: o + head, end: o + size });
      o += size;
    }
    return out;
  };
  try {
    const top = boxes(0, b.length);
    const meta = top.find((x) => x.type === "meta");
    if (!meta) return null;
    const kids = boxes(meta.body + 4, meta.end); // meta is a FullBox
    const iinf = kids.find((x) => x.type === "iinf");
    const iloc = kids.find((x) => x.type === "iloc");
    const idat = kids.find((x) => x.type === "idat");
    if (!iinf || !iloc) return null;
    // Items holding metadata.
    const ivers = b[iinf.body]!;
    const metaItems = new Set<number>();
    for (const e of boxes(iinf.body + 4 + (ivers === 0 ? 2 : 4), iinf.end)) {
      if (e.type !== "infe") continue;
      const v = b[e.body]!;
      if (v < 2) continue;
      const idSize = v === 2 ? 2 : 4;
      const id = u(e.body + 4, idSize);
      const itemType = type(e.body + 4 + idSize + 2);
      if (itemType === "Exif" || itemType === "mime") metaItems.add(id);
    }
    if (metaItems.size === 0) return b;
    // Where each item's bytes are.
    let o = iloc.body;
    const v = b[o]!;
    o += 4;
    const offsetSize = b[o]! >> 4;
    const lengthSize = b[o]! & 15;
    const baseSize = b[o + 1]! >> 4;
    const indexSize = v === 1 || v === 2 ? b[o + 1]! & 15 : 0;
    o += 2;
    const count = v < 2 ? u(o, 2) : u(o, 4);
    o += v < 2 ? 2 : 4;
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? u(o, 2) : u(o, 4);
      o += v < 2 ? 2 : 4;
      const method = v === 1 || v === 2 ? u(o, 2) & 15 : 0;
      if (v === 1 || v === 2) o += 2;
      o += 2; // data_reference_index
      const base = u(o, baseSize);
      o += baseSize;
      const extents = u(o, 2);
      o += 2;
      for (let e = 0; e < extents; e++) {
        o += indexSize;
        const off = u(o, offsetSize);
        o += offsetSize;
        const len = u(o, lengthSize);
        o += lengthSize;
        if (!metaItems.has(id)) continue;
        const start = (method === 1 ? (idat?.body ?? -1) : 0) + base + off;
        const end = len === 0 ? b.length : start + len;
        if (start < 0 || end > b.length || (method !== 0 && method !== 1)) return null;
        b.fill(0, start, end); // Exif: offset 0 + empty data; XMP: blank. Readers skip both.
      }
    }
    if (o > iloc.end) return null;
    return b;
  } catch {
    return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export type PhotoCheck =
  | { ok: true; bytes: Uint8Array; type: ImageType }
  | { ok: false; code: "photo_missing" | "photo_too_large" | "photo_type" };

export async function readPhoto(file: unknown): Promise<PhotoCheck> {
  if (!(file instanceof File) && !(file instanceof Blob)) return { ok: false, code: "photo_missing" };
  if (file.size === 0) return { ok: false, code: "photo_missing" };
  if (file.size > PHOTO.maxBytes) return { ok: false, code: "photo_too_large" };
  const raw = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(raw);
  if (!type) return { ok: false, code: "photo_type" };
  const bytes = type === "image/jpeg" ? stripJpegMetadata(raw) : type === "image/heic" ? stripHeicMetadata(raw) : raw;
  if (!bytes) return { ok: false, code: "photo_type" }; // a HEIC we couldn't clean is never sent on
  return { ok: true, bytes, type };
}
