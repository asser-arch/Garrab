import { describe, expect, it, vi } from "vitest";
import { signCtx, ulid, verifyCtx } from "../src/lib/crypto.js";
import { originHost } from "../src/lib/db.js";
import { log } from "../src/lib/log.js";
import { sniffImage, stripJpegMetadata } from "../src/lib/photo.js";
import { cairoDay } from "../src/lib/time.js";
import { fakeJpeg } from "./helpers.js";

const KEY = "k".repeat(40);
const now = Math.floor(Date.now() / 1000);

describe("ctx tokens", () => {
  it("round-trips", async () => {
    const t = await signCtx(KEY, { a: "acc", o: "shop.example", e: now + 60, v: 1 });
    expect(await verifyCtx(KEY, t)).toMatchObject({ a: "acc", o: "shop.example" });
  });
  it("rejects expired, tampered and wrong-key tokens", async () => {
    const t = await signCtx(KEY, { a: "acc", o: "shop.example", e: now - 1, v: 1 });
    expect(await verifyCtx(KEY, t)).toBeNull();
    const good = await signCtx(KEY, { a: "acc", o: "shop.example", e: now + 60, v: 1 });
    const [body, sig] = good.split(".");
    const forged = btoa(JSON.stringify({ a: "other", o: "shop.example", e: now + 60, v: 1 })).replace(/=+$/, "");
    expect(await verifyCtx(KEY, `${forged}.${sig}`)).toBeNull();
    expect(await verifyCtx("x".repeat(40), good)).toBeNull();
    expect(await verifyCtx(KEY, `${body}`)).toBeNull();
  });
});

describe("photo handling", () => {
  it("sniffs by magic bytes, not by name", () => {
    expect(sniffImage(fakeJpeg())).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/png");
  });
  it("strips EXIF (APP1) but keeps the image data", () => {
    const src = fakeJpeg("SCANDATA", "GPS-31.2,29.9");
    const out = new TextDecoder("latin1").decode(stripJpegMetadata(src));
    expect(out).not.toContain("GPS-31.2,29.9");
    expect(out).toContain("SCANDATA");
    expect(out).toContain("JFIF");
  });
});

describe("misc", () => {
  it("normalises origins to host form", () => {
    expect(originHost("https://www.Shop.example")).toBe("shop.example");
    expect(originHost("http://localhost:8788")).toBe("localhost:8788");
    expect(originHost("javascript:alert(1)")).toBeNull();
    expect(originHost(null)).toBeNull();
  });
  it("Cairo day is YYYY-MM-DD and uses Cairo time", () => {
    // 22:30 UTC on 1 July = 01:30 on 2 July in Cairo (UTC+3 summer time).
    expect(cairoDay(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
    // 22:30 UTC on 1 Dec = 00:30 on 2 Dec in Cairo (UTC+2).
    expect(cairoDay(new Date("2026-12-01T22:30:00Z"))).toBe("2026-12-02");
    expect(cairoDay(new Date("2026-12-01T21:30:00Z"))).toBe("2026-12-01");
  });
  it("ULIDs are sortable and unique", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
    expect(a).toHaveLength(26);
  });
  it("logger drops fields that are not allow-listed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("x", { route: "r", ip: "203.0.113.9", body: "secret" } as never);
    const line = String(spy.mock.calls[0]?.[0]);
    spy.mockRestore();
    expect(line).not.toContain("203.0.113.9");
    expect(line).not.toContain("secret");
    expect(line).toContain("dropped_fields");
  });
});

import { accessTeamHost, checkAccessJwt } from "../src/lib/auth.js";
describe("Cloudflare Access settings", () => {
  it("accepts the team domain with or without https:// and a trailing slash", () => {
    for (const v of ["team.cloudflareaccess.com", "https://team.cloudflareaccess.com/", " HTTPS://Team.cloudflareaccess.com "]) {
      expect(accessTeamHost({ CF_ACCESS_TEAM_DOMAIN: v } as never)).toBe("team.cloudflareaccess.com");
    }
  });
  it("explains a refusal instead of failing silently", async () => {
    expect(await checkAccessJwt({} as never, "a.b.c")).toEqual({ ok: false, reason: "access_not_configured" });
    expect(await checkAccessJwt({ CF_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", CF_ACCESS_AUD: "x" } as never, "nope")).toEqual({ ok: false, reason: "malformed_token" });
  });
});
