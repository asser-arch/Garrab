/**
 * PRIVACY SENTINEL TEST (brief §3, "non-negotiable").
 *
 * Pushes a photo carrying unique sentinel bytes (in the pixels and in the EXIF) through
 * the real /v1/tryon path, from a known IP, then scans EVERY place we could store or log
 * anything: every D1 table, every KV key and value, and everything written to the console.
 * The sentinels, the IP and the provider's one-time user id must appear nowhere.
 *
 * The "not saved on our systems" wording may only be shown after this test passes AND the
 * manual provider-delete check (scripts/verify-genlook-delete.ts) has passed.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateStatus } from "../src/lib/db.js";
import { MockTryOnProvider } from "../src/providers/tryon.js";
import { fakeJpeg, getConfig, postTryOn, seedAccount } from "./helpers.js";

const PIXEL_SENTINEL = "SHOPPER-PIXELS-7f3a9c1e";
const EXIF_SENTINEL = "SHOPPER-EXIF-GPS-91b2d4";
const SHOPPER_IP = "203.0.113.77";

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  MockTryOnProvider.deleted = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  invalidateStatus();
});
afterEach(() => vi.restoreAllMocks());

async function dumpAllStorage(): Promise<string> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  ).all<{ name: string }>();
  expect(tables.results.length).toBeGreaterThan(10); // sanity: we really are scanning the schema
  let dump = "";
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    dump += `\n#${name}\n${JSON.stringify(rows.results)}`;
  }
  const keys = await env.CONFIG_KV.list();
  for (const k of keys.keys) dump += `\n#kv:${k.name}\n${(await env.CONFIG_KV.get(k.name)) ?? ""}`;
  return dump;
}

describe("privacy: no shopper data reaches any storage or log", () => {
  it("successful try-on", async () => {
    const s = await seedAccount();
    const ctx = (await getConfig(s)).body.ctx as string;
    const photo = fakeJpeg(PIXEL_SENTINEL, EXIF_SENTINEL);

    const r = await postTryOn({ ctx, product: s.productId, photo, ip: SHOPPER_IP });
    expect(r.status).toBe(200);
    const returned = new TextDecoder("latin1").decode(await r.arrayBuffer());
    // The sentinel really flowed through the pipeline (the mock echoes the photo)…
    expect(returned).toContain(PIXEL_SENTINEL);
    // …and EXIF was stripped before it left our server.
    expect(returned).not.toContain(EXIF_SENTINEL);

    for (let i = 0; i < 50 && MockTryOnProvider.deleted.length === 0; i++) await new Promise((x) => setTimeout(x, 10));
    expect(MockTryOnProvider.deleted).toHaveLength(1);
    const oneTimeId = MockTryOnProvider.deleted[0]!;

    const everything = (await dumpAllStorage()) + "\n#logs\n" + logged.join("\n");
    for (const needle of [PIXEL_SENTINEL, EXIF_SENTINEL, SHOPPER_IP, oneTimeId]) {
      expect(everything, `found "${needle}" in storage or logs`).not.toContain(needle);
    }
    // Base64 of the pixel sentinel must not appear either (no encoded copies).
    expect(everything).not.toContain(btoa(PIXEL_SENTINEL).slice(0, 16));
  });

  it("failed try-on (provider error) also leaves nothing behind", async () => {
    const s = await seedAccount();
    const ctx = (await getConfig(s)).body.ctx as string;
    MockTryOnProvider.failNext = "provider_error";
    const r = await postTryOn({ ctx, product: s.productId, photo: fakeJpeg(PIXEL_SENTINEL, EXIF_SENTINEL), ip: SHOPPER_IP });
    expect(r.status).toBe(422);
    const body = await r.text();
    expect(body).not.toContain(PIXEL_SENTINEL);
    const everything = (await dumpAllStorage()) + logged.join("\n");
    for (const needle of [PIXEL_SENTINEL, EXIF_SENTINEL, SHOPPER_IP]) expect(everything).not.toContain(needle);
  });

  it("rejected upload (bad type) leaves nothing behind", async () => {
    const s = await seedAccount();
    const ctx = (await getConfig(s)).body.ctx as string;
    const notImage = new TextEncoder().encode(`NOTANIMAGE ${PIXEL_SENTINEL}`);
    const r = await postTryOn({ ctx, product: s.productId, photo: notImage, ip: SHOPPER_IP });
    expect(r.status).toBe(415);
    const everything = (await dumpAllStorage()) + logged.join("\n");
    for (const needle of [PIXEL_SENTINEL, SHOPPER_IP]) expect(everything).not.toContain(needle);
  });

  it("schema guard: no table has a column meant for images, inputs or IPs", async () => {
    const tables = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all<{
      name: string;
      sql: string;
    }>();
    const bad: string[] = [];
    const seen: string[] = [];
    for (const t of tables.results) {
      const body = t.sql.slice(t.sql.indexOf("(") + 1).replace(/--[^\n]*/g, "");
      for (const line of body.split(/,\s*\n|\n/)) {
        const col = line.trim().split(/\s+/)[0]?.replace(/"/g, "") ?? "";
        seen.push(`${t.name}.${col}`);
        if (/(^|_)(ip|ip_address|photo|image_bytes|blob|height|weight|body_type|user_agent)$/i.test(col)) bad.push(`${t.name}.${col}`);
      }
    }
    expect(seen).toContain("api_keys.key_hash");
    expect(seen).toContain("usage_events.cost_micro_usd");
    expect(bad).toEqual([]);
  });
});
