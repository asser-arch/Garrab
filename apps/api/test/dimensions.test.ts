import { describe, expect, it } from "vitest";
import { parseDimensions } from "../src/lib/dimensions.js";

describe("product size from shop text", () => {
  it.each([
    ["Ceramic vase. Height: 35 cm, Diameter 15 cm", "height 35 cm, diameter 15 cm"],
    ["Vase H 35cm Ø 15cm", "height 35 cm, diameter 15 cm"],
    ["Table lamp, 52 cm tall", "height 52 cm"],
    ["Rug 160 x 230 cm", "160 × 230 cm"],
    ["Cushion 45×45cm", "45 × 45 cm"],
    ["Side table 40 x 40 x 55 cm", "40 × 40 × 55 cm"],
    ["Mirror 600mm diameter", "diameter 60 cm"],
    ["Vase 12 inches tall", "height 30.5 cm"],
    ["فازة سيراميك ارتفاع ٣٥ سم وقطر ١٥ سم", "height 35 cm, diameter 15 cm"],
    ["سجادة مقاس ١٦٠ × ٢٣٠ سم", "160 × 230 cm"],
    ["Small 20cm ceramic pot", "about 20 cm"],
  ])("%s", (text, want) => expect(parseDimensions(text)).toBe(want));

  it("no size, or nonsense sizes", () => {
    expect(parseDimensions("Beautiful handmade ceramic vase in sage green")).toBeNull();
    expect(parseDimensions("Free shipping over 1500 EGP. 2024 collection")).toBeNull();
    expect(parseDimensions("Width 9000 cm")).toBeNull();
  });
});
