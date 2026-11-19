import { describe, expect, it } from "vitest";
import { removeCornerMarks } from "../src/watermark.js";

const W = 400;
const H = 400;
function photo(bg: [number, number, number] = [255, 255, 255]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) [d[i], d[i + 1], d[i + 2], d[i + 3]] = [...bg, 255];
  return d;
}
function rect(d: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) [d[(y * W + x) * 4], d[(y * W + x) * 4 + 1], d[(y * W + x) * 4 + 2]] = c;
}
const px = (d: Uint8ClampedArray, x: number, y: number) => [d[(y * W + x) * 4], d[(y * W + x) * 4 + 1], d[(y * W + x) * 4 + 2]];
const NAVY: [number, number, number] = [20, 30, 70];
const INK: [number, number, number] = [10, 10, 10];

describe("removing a logo stamped on a product photo", () => {
  it("removes a small logo in the top-left corner, even inside the product's box, and leaves the product alone", () => {
    const d = photo();
    // A lamp: a wide shade (reaching the top-left area) and a base.
    rect(d, 70, 60, 330, 200, NAVY);
    rect(d, 170, 200, 230, 380, NAVY);
    // "Nadiz" logo: three letters, top-left, above the shade's edge (not touching it).
    rect(d, 12, 12, 22, 40, INK);
    rect(d, 26, 20, 34, 40, INK);
    rect(d, 38, 14, 48, 40, INK);
    expect(removeCornerMarks(d, W, H)).toBeGreaterThan(0);
    expect(px(d, 16, 25)).toEqual([255, 255, 255]);
    expect(px(d, 42, 30)).toEqual([255, 255, 255]);
    expect(px(d, 100, 100)).toEqual(NAVY); // the product is untouched
    expect(px(d, 200, 300)).toEqual(NAVY);
  });

  it("never touches a photo with a real background", () => {
    const d = photo();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x + y) % 7 < 3) [d[(y * W + x) * 4], d[(y * W + x) * 4 + 1]] = [120, 90];
    rect(d, 12, 12, 40, 40, INK);
    const before = d.slice();
    expect(removeCornerMarks(d, W, H)).toBe(0);
    expect(d).toEqual(before);
  });

  it("keeps anything attached to the product, or outside the corners", () => {
    const d = photo();
    rect(d, 100, 100, 300, 380, NAVY);
    rect(d, 60, 60, 102, 110, INK); // touches the product (e.g. a tassel or handle)
    rect(d, 180, 20, 220, 40, INK); // top middle: not a corner
    const before = d.slice();
    expect(removeCornerMarks(d, W, H)).toBe(0);
    expect(d).toEqual(before);
  });

  it("leaves a photo with only the product as it was", () => {
    const d = photo([248, 247, 245]);
    rect(d, 100, 60, 300, 380, NAVY);
    const before = d.slice();
    expect(removeCornerMarks(d, W, H)).toBe(0);
    expect(d).toEqual(before);
  });
});
