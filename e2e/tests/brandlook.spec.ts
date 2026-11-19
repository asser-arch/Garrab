import { expect, test } from "@playwright/test";
import { query } from "./db.js";

const APP = "http://localhost:8788";
const LOGO = new URL("../fixtures/two-colour-logo.png", import.meta.url).pathname;
const ON_WHITE = new URL("../fixtures/logo-on-white.png", import.meta.url).pathname;

/** The portal reads the logo's main colours; the brand picks one for buttons and one for text. */
test("brand look: colours from the logo, for buttons and for text", async ({ page }) => {
  test.setTimeout(90_000);
  await page.request.post(`${APP}/portal-api/auth/request`, { data: { email: "owner@demo-brand.example" }, headers: { origin: APP } });
  const html = query<{ html: string }>(
    "SELECT html FROM dev_outbox WHERE subject LIKE 'Your Garrab sign-in code%' AND to_addr = 'owner@demo-brand.example' ORDER BY created_at DESC LIMIT 1",
  )[0]!.html;
  await page.goto(/href="([^"]+#t=[A-Za-z0-9]{40})"/.exec(html)![1]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome|pilot|live/i }).first().waitFor();
  await page.goto(`${APP}/portal/install`);

  try {
    // A logo on a white background: the white goes, the empty edges are cropped.
    await page.getByLabel("Logo (we remove a white background and empty edges for you)").setInputFiles(ON_WHITE);
    const logo = page.locator("img.look-logo");
    await expect(logo).toHaveAttribute("src", /^blob:/);
    const info = await logo.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext("2d")!;
      x.drawImage(img, 0, 0);
      return { w: img.naturalWidth, h: img.naturalHeight, corner: x.getImageData(0, 0, 1, 1).data[3], middle: x.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[3] };
    });
    expect(info.w).toBeLessThan(100); // 80 px logo + a small margin, not the 200 px canvas
    expect(info.h).toBeLessThan(60);
    expect(info.corner).toBe(0); // transparent background
    expect(info.middle).toBe(255); // the logo itself untouched

    await page.getByLabel("Logo (we remove a white background and empty edges for you)").setInputFiles(LOGO);
    const burgundy = page.getByRole("button", { name: "Use #6b2737 for buttons" });
    await expect(burgundy).toBeVisible();
    await expect(page.getByRole("button", { name: "Use #c9a24d for buttons" })).toBeVisible();
    await burgundy.click();
    await expect(page.getByLabel("Button colour code")).toHaveValue("#6b2737");

    // Same logo colour for text: switch the target, tap the swatch.
    await page.getByRole("radio", { name: "For text & links" }).click();
    await page.getByRole("button", { name: "Use #c9a24d for text and links" }).click();
    await expect(page.getByText("Too light to read on a white page", { exact: false })).toBeVisible(); // gold on white fails AA
    await page.getByRole("button", { name: "Use #6b2737 for text and links" }).click();
    await expect(page.getByLabel("Text colour code")).toHaveValue("#6b2737");
    if (process.env.SHOTS) await page.locator(".card", { hasText: "Your brand look" }).screenshot({ path: `${process.env.SHOTS}/brand-look.png` });

    await page.getByRole("button", { name: "Save my look" }).click();
    await expect(page.getByText("Saved. Your try-on pages", { exact: false })).toBeVisible();

    // The brand page uses the text colour for its heading.
    await page.goto(`${APP}/t/demo-brand`);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveCSS("color", "rgb(107, 39, 55)");
  } finally {
    // Back to Garrab's look, so other tests see the demo brand unchanged.
    await page.request.post(`${APP}/portal-api/brand`, { multipart: { color: "", textColor: "", removeLogo: "1" }, headers: { origin: APP } });
  }
});
