import { env } from "cloudflare:workers";
import { sha256Hex, ulid } from "../src/lib/crypto.js";
import { invalidateStatus } from "../src/lib/db.js";

export const APP = "https://app.test";

export interface Seeded {
  accountId: string;
  key: string;
  productId: string;
  origin: string;
  slug: string;
}

let n = 0;

export async function seedAccount(opts: {
  status?: string;
  plan?: "pilot" | "starter" | "growth";
  host?: string;
  kind?: "clothing" | "accessory" | "decor";
} = {}): Promise<Seeded> {
  n++;
  const accountId = ulid();
  const slug = `brand-${n}-${accountId.slice(-6).toLowerCase()}`;
  const host = opts.host ?? `shop${n}-${accountId.slice(-6).toLowerCase()}.example`;
  const key = `gk_live_${accountId}TESTKEY${n}`.replace(/[^A-Za-z0-9_]/g, "");
  const productId = ulid();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, slug, name, plan_id, status, cycle_start) VALUES (?, ?, ?, ?, ?, '2026-11-01')").bind(
      accountId,
      slug,
      `Brand ${n}`,
      opts.plan ?? "starter",
      opts.status ?? "active",
    ),
    env.DB.prepare("INSERT INTO api_keys (id, account_id, prefix, key_hash) VALUES (?, ?, ?, ?)").bind(
      ulid(),
      accountId,
      key.slice(0, 12),
      await sha256Hex(key),
    ),
    env.DB.prepare("INSERT INTO domains (id, account_id, host) VALUES (?, ?, ?)").bind(ulid(), accountId, host),
    env.DB.prepare(
      `INSERT INTO products (id, account_id, external_ref, url_path, title, description, images_json, kind, enabled, approved)
       VALUES (?, ?, '1001', '/products/red-dress', 'Red dress', 'A red dress', '["https://cdn.example/red.jpg"]', ?, 1, 1)`,
    ).bind(productId, accountId, opts.kind ?? "clothing"),
  ]);
  invalidateStatus();
  return { accountId, key, productId, origin: `https://${host}`, slug };
}

export async function setStatus(accountId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET status = ?, status_version = status_version + 1 WHERE id = ?").bind(status, accountId).run();
}

/** A tiny JPEG-shaped byte stream: APP0, an APP1 (EXIF) segment, a quant table, a scan. */
export function fakeJpeg(scanMarker = "PIXELS", exifMarker = "EXIF-GPS"): Uint8Array {
  const t = new TextEncoder();
  const seg = (marker: number, payload: Uint8Array): number[] => {
    const len = payload.length + 2;
    return [0xff, marker, len >> 8, len & 0xff, ...payload];
  };
  const app0 = seg(0xe0, t.encode("JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
  const app1 = seg(0xe1, t.encode(`Exif\0\0${exifMarker}`));
  const dqt = seg(0xdb, new Uint8Array(65));
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...dqt, ...sos, ...t.encode(scanMarker), 0xff, 0xd9]);
}

export async function getConfig(s: Seeded, origin = s.origin): Promise<{ status: number; acao: string | null; body: any }> {
  const { exports } = await import("cloudflare:workers");
  const r = await exports.default.fetch(`https://api.test/v1/config?key=${s.key}`, { headers: { origin } });
  return { status: r.status, acao: r.headers.get("access-control-allow-origin"), body: await r.json() };
}

export async function postTryOn(fields: {
  ctx: string;
  product: string;
  photo?: Uint8Array;
  origin?: string;
  ip?: string;
  /** The page's "first preview on this device today" flag. */
  newShopper?: boolean;
}): Promise<Response> {
  const { exports } = await import("cloudflare:workers");
  const form = new FormData();
  form.set("ctx", fields.ctx);
  form.set("product", fields.product);
  form.set("turnstile", "x");
  if (fields.photo) form.set("photo", new Blob([fields.photo], { type: "image/jpeg" }), "p.jpg");
  if (fields.newShopper) form.set("newShopper", "1");
  return exports.default.fetch("https://api.test/v1/tryon", {
    method: "POST",
    body: form,
    headers: { origin: fields.origin ?? APP, "cf-connecting-ip": fields.ip ?? `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
  });
}
