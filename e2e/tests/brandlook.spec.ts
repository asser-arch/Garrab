import { expect, test } from "@playwright/test";
import { query } from "./db.js";

const APP = "http://localhost:8788";
const LOGO = new URL("../fixtures/two-colour-logo.png", import.meta.url).pathname;

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
    await page.getByLabel("Logo (PNG with a transparent background works best)").setInputFiles(LOGO);
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
