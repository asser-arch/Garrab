/**
 * Outreach previews (admin): show a prospect what Garrab does with ONE of their own products, before they
 * sign up. Garrab support gives a product photo (uploaded, an image link, or a product page / post link whose
 * main image is read), and Garrab makes one try-on on a stock model (or one room preview for home décor).
 * Nothing about the prospect is stored: the product photo is kept in R2 only for the AI call, then deleted,
 * and the result goes straight back to the admin. The AI cost is recorded under "*outreach" (dashboard totals).
 */
import type { Env } from "../env.js";
import { ulid } from "./crypto.js";
import { workerFetch } from "./http.js";
import { recordUsage } from "./metering.js";
import { sniffImage, stripJpegMetadata } from "./photo.js";
import { productPhotoUrl } from "./products.js";
import { listFixtures } from "../onboarding/tests.js";
import { toBase64 } from "../providers/google.js";
import { tryOnProvider, type TryOnProvider } from "../providers/tryon.js";

/** Stands in for an account id in photo addresses and usage rows (26 characters, like an account id). */
export const OUTREACH_ID = "OUTREACH000000000000000000";
export const OUTREACH_USAGE = "*outreach";
const MAX_BYTES = 10 * 1024 * 1024;

type Img = { bytes: Uint8Array; type: "image/jpeg" | "image/png" | "image/webp" };

async function getBytes(url: string, fetcher: typeof fetch): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const r = await fetcher(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; GarrabPreview/1.0)", accept: "text/html,image/*;q=0.9,*/*;q=0.5" },
      redirect: "follow",
    });
    if (!r.ok) return null;
    const len = Number(r.headers.get("content-length") ?? "0");
    if (len > MAX_BYTES) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    return { bytes, contentType: (r.headers.get("content-type") ?? "").toLowerCase() };
  } catch {
    return null;
  }
}

/** The main image a page shares (og:image / twitter:image), resolved against the page address. */
export function mainImageOf(html: string, pageUrl: string): string | null {
  const tag = (re: RegExp) => re.exec(html)?.[1] ?? null;
  const raw =
    tag(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ??
    tag(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
    tag(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (!raw) return null;
  try {
    return new URL(raw.replace(/&amp;/g, "&"), pageUrl).href;
  } catch {
    return null;
  }
}

/** A link → the product photo: an image link directly, or the main image of a product page / post. */
export async function imageFromLink(url: string, fetcher: typeof fetch = workerFetch): Promise<Img | { error: string }> {
  const first = await getBytes(url, fetcher);
  if (!first) return { error: "We couldn't open that link. Save the photo and upload it instead." };
  let bytes = first.bytes;
  if (!sniffImage(bytes)) {
    const img = mainImageOf(new TextDecoder().decode(bytes.subarray(0, 600_000)), url);
    if (!img) return { error: "That page doesn't share a product photo we can read (Instagram often hides it). Save the photo and upload it instead." };
    const second = await getBytes(img, fetcher);
    if (!second) return { error: "We found the photo but couldn't download it. Save it and upload it instead." };
    bytes = second.bytes;
  }
  const type = sniffImage(bytes);
  if (!type || type === "image/heic") return { error: "That isn't a JPG, PNG or WEBP photo." };
  return { bytes, type };
}

export async function outreachPreview(
  env: Env,
  input: { product: Img; title: string; mode: "person" | "room"; fixture: number; own?: { bytes: Uint8Array; type: string } | null },
  deps: { tryon?: TryOnProvider } = {},
): Promise<{ ok: true; product: string; preview: string; fixture: string } | { ok: false; error: string }> {
  // The person or room: Garrab's stock photo, or one Garrab support uploads (e.g. sent by the prospect).
  // An uploaded one is handled like a shopper's photo: used for this one preview, never stored.
  let photo: Uint8Array;
  let label: string;
  const fixtures = input.own ? [] : await listFixtures(env, input.mode);
  if (input.own) {
    photo = input.own.type === "image/jpeg" ? stripJpegMetadata(input.own.bytes) : input.own.bytes;
    label = input.mode === "room" ? "Your room photo" : "Your model photo";
  } else {
    const key = fixtures[Math.min(Math.max(input.fixture, 0), fixtures.length - 1)];
    if (!key) return { ok: false, error: "No test models or rooms are set up." };
    const photoObj = await env.FILES.get(key);
    if (!photoObj) return { ok: false, error: "The test photo is missing." };
    photo = new Uint8Array(await photoObj.arrayBuffer());
    label = `${input.mode === "room" ? "Room" : "Model"} ${String.fromCharCode(65 + fixtures.indexOf(key))}`;
  }
  const photoType = sniffImage(photo);
  if (!photoType) return { ok: false, error: "That person or room photo can't be read. Use a JPG, PNG, WEBP or iPhone (HEIC) photo." };

  const product = input.product.type === "image/jpeg" ? { ...input.product, bytes: stripJpegMetadata(input.product.bytes) } : input.product;
  const name = `${ulid().toLowerCase()}.${product.type === "image/png" ? "png" : product.type === "image/webp" ? "webp" : "jpg"}`;
  const r2 = `products/${OUTREACH_ID}/${name}`;
  await env.FILES.put(r2, product.bytes, { httpMetadata: { contentType: product.type } });
  try {
    const tryon = deps.tryon ?? tryOnProvider(env, input.mode);
    const oneTimeUserId = crypto.randomUUID();
    const r = await tryon.tryOn({
      product: { externalId: `outreach_${name}`, title: input.title, description: "", imageUrls: [productPhotoUrl(env, OUTREACH_ID, name)], includesHeadwear: false, synced: false },
      photo,
      photoType,
      oneTimeUserId,
    });
    await tryon.deleteUserData(oneTimeUserId);
    await recordUsage(env, OUTREACH_USAGE, "test", tryon.name, r.ok, r.ok ? r.costMicroUsd : 0, r.ok ? null : r.code);
    if (!r.ok)
      return {
        ok: false,
        error: r.code === "content_policy" ? "The AI won't show this product (content rules)." : "The AI couldn't make a preview this time. Try again, or try another photo.",
      };
    return {
      ok: true,
      product: `data:${product.type};base64,${toBase64(product.bytes)}`,
      preview: `data:${r.contentType};base64,${toBase64(r.image)}`,
      fixture: label,
    };
  } finally {
    await env.FILES.delete(r2);
  }
}
