import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { query } from "./db.js";

const APP = "http://localhost:8788";
const PHOTO = readFileSync(new URL("../fixtures/synthetic-photo.png", import.meta.url));
const NAMES = ["Olive kaftan", "Black abaya", "Sand linen set"];

/** A brand adds many products at once: names come from the file names, one Save for all. */
test("add many products: pick photos, name them, save all at once", async ({ page }) => {
  test.setTimeout(90_000);
  await page.request.post(`${APP}/portal-api/auth/request`, { data: { email: "owner@demo-brand.example" }, headers: { origin: APP } });
  const html = query<{ html: string }>(
    "SELECT html FROM dev_outbox WHERE subject LIKE 'Your Garrab sign-in code%' AND to_addr = 'owner@demo-brand.example' ORDER BY created_at DESC LIMIT 1",
  )[0]!.html;
  await page.goto(/href="([^"]+#t=[A-Za-z0-9]{40})"/.exec(html)![1]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome|pilot|live/i }).first().waitFor();
  await page.goto(`${APP}/portal/products`);

  try {
    await page.getByLabel("Product photos").setInputFiles([
      { name: "olive-kaftan.png", mimeType: "image/png", buffer: PHOTO },
      { name: "IMG_2041.png", mimeType: "image/png", buffer: PHOTO },
      { name: "sand_linen_set.png", mimeType: "image/png", buffer: PHOTO },
    ]);
    await expect(page.getByLabel("Name for photo 1")).toHaveValue("Olive kaftan");
    await expect(page.getByLabel("Name for photo 2")).toHaveValue(""); // camera file names aren't product names
    await expect(page.getByLabel("Name for photo 3")).toHaveValue("Sand linen set");
    await expect(page.getByText("1 photo needs a name.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save all 3 products" })).toBeDisabled();
    await page.getByLabel("Name for photo 2").fill("Black abaya");
    await page.getByLabel("Sizes for photo 2").fill("S, M, L");
    if (process.env.SHOTS) await page.locator(".bulk").screenshot({ path: `${process.env.SHOTS}/bulk.png` });
    await page.getByRole("button", { name: "Save all 3 products" }).click();
    await expect(page.getByText("All 3 saved.", { exact: false })).toBeVisible({ timeout: 30_000 });
    const rows = query<{ title: string }>(`SELECT title FROM products WHERE account_id = 'acc_demo' AND title IN ('${NAMES.join("','")}') ORDER BY title`);
    expect(rows.map((r) => r.title)).toEqual([...NAMES].sort());
  } finally {
    // Remove them the way a brand does (Delete product), so the demo brand is unchanged for other tests.
    const ids = query<{ id: string }>(`SELECT id FROM products WHERE account_id = 'acc_demo' AND title IN ('${NAMES.join("','")}')`);
    for (const { id } of ids) await page.request.post(`${APP}/portal-api/products/${id}/delete`, { data: {}, headers: { origin: APP } });
  }
});
