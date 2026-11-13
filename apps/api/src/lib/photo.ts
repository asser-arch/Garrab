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
  const bytes = type === "image/jpeg" ? stripJpegMetadata(raw) : raw;
  return { ok: true, bytes, type };
}
