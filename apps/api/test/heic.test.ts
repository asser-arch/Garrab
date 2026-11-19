import { describe, expect, it } from "vitest";
import { readPhoto, sniffImage, stripHeicMetadata } from "../src/lib/photo.js";

// A tiny HEIC (ftyp + meta with an image item and an Exif item + mdat). Its Exif holds a fake GPS line.
const HEIC = Uint8Array.from(atob("AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAAAkW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAOGlpbmYAAAAAAAIAAAAVaW5mZQIAAAAAAQAAaHZjMQAAAAAVaW5mZQIAAAAAAgAARXhpZgAAAAAsaWxvYwAAAABEAAACAAEAAAABAAAAsQAAAQQAAgAAAAEAAAG1AAAAPgAAAUptZGF0UElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS1QSUNUVVJFLURBVEEtUElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS1QSUNUVVJFLURBVEEtUElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS1QSUNUVVJFLURBVEEtUElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS1QSUNUVVJFLURBVEEtUElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS1QSUNUVVJFLURBVEEtUElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS1QSUNUVVJFLURBVEEtUElDVFVSRS1EQVRBLVBJQ1RVUkUtREFUQS0AAAAATU0AKgAAAAhHUFMtU0VDUkVULTMwLjA0NDROLTMxLjIzNTdFIGlQaG9uZSAxNSBQcm8AAAAAAAAAAA=="), (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("iPhone HEIC photos (sent as they are by browsers that can't open them)", () => {
  it("location and device details are blanked; the picture is untouched", () => {
    expect(sniffImage(HEIC)).toBe("image/heic");
    expect(text(HEIC)).toContain("GPS-SECRET");
    const out = stripHeicMetadata(HEIC)!;
    expect(out.length).toBe(HEIC.length);
    expect(text(out)).not.toContain("GPS-SECRET");
    expect(text(out)).not.toContain("iPhone");
    expect(text(out).split("PICTURE-DATA-").length - 1).toBe(20);
    expect(text(HEIC)).toContain("GPS-SECRET"); // the original isn't changed in place
  });

  it("the try-on accepts it, cleaned", async () => {
    const r = await readPhoto(new Blob([HEIC], { type: "image/heic" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.type).toBe("image/heic");
      expect(text(r.bytes)).not.toContain("GPS-SECRET");
    }
  });

  it("a HEIC we can't read is refused, never sent on with its details", async () => {
    const broken = HEIC.slice(0, 40); // ftyp, then a cut-off meta box
    expect(stripHeicMetadata(broken)).toBeNull();
    expect(await readPhoto(new Blob([broken]))).toEqual({ ok: false, code: "photo_type" });
  });
});
