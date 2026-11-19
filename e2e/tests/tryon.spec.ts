import { expect, test, type Page } from "@playwright/test";
import { setDemoStatus, sql } from "./db.js";

const SHOP = "http://localhost:8790";
const APP = "http://localhost:8788";
const PHOTO = new URL("../fixtures/synthetic-photo.png", import.meta.url).pathname;

function hostConsole(page: Page): string[] {
  const msgs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") msgs.push(`${m.type()}: ${m.text()}`);
  });
  return msgs;
}

test.beforeEach(() => setDemoStatus("active"));

test("shopper tries on a product from the brand page", async ({ page }) => {
  const noise = hostConsole(page);
  await page.goto(`${SHOP}/products/red-dress`);
  const button = page.locator("garrab-try-on button");
  await expect(button).toHaveText("Try it on");

  await button.click();
  const frame = page.frameLocator("garrab-try-on iframe");
  await expect(frame.getByRole("heading", { name: "Try it on" })).toBeVisible();
  await expect(frame.getByText("By uploading a photo you agree we use it only to create your preview.")).toBeVisible();
  // The privacy claim stays hidden until the delete test has been verified.
  await expect(frame.getByText("We don't save it.", { exact: false })).toHaveCount(0);

  await frame.locator("input#photo").setInputFiles(PHOTO);
  await expect(frame.locator("img.result")).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator(".chip")).toHaveText("AI preview");
  await expect(frame.getByText("This is an AI preview to help you imagine the look.", { exact: false })).toBeVisible();
  const download = frame.getByRole("link", { name: "Download preview" });
  await expect(download).toHaveAttribute("href", /^blob:/);

  await frame.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("garrab-try-on iframe")).toHaveCount(0);
  await expect(page.locator("garrab-try-on").getByRole("status")).toHaveText("Your photo has been deleted.");
  await expect(button).toBeFocused();
  expect(noise.filter((m) => !m.includes("fonts.g"))).toEqual([]);
});

test("Escape closes the dialog", async ({ page }) => {
  await page.goto(`${SHOP}/products/red-dress`);
  await page.locator("garrab-try-on button").click();
  const frame = page.frameLocator("garrab-try-on iframe");
  await expect(frame.getByRole("button", { name: "Close" })).toBeVisible();
  await frame.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("garrab-try-on iframe")).toHaveCount(0);
});

test("Arabic page gets the Arabic, right-to-left flow", async ({ page }) => {
  await page.goto(`${SHOP}/products/red-dress-ar`);
  const button = page.locator("garrab-try-on button");
  await expect(button).toHaveAttribute("dir", "rtl");
  await button.click();
  const frame = page.frameLocator("garrab-try-on iframe");
  await expect(frame.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(frame.locator("html")).toHaveAttribute("lang", "ar");
});

test("nothing renders for a product that is not enabled", async ({ page }) => {
  const noise = hostConsole(page);
  await page.goto(`${SHOP}/products/blue-shirt`);
  await page.waitForTimeout(2500);
  await expect(page.locator("garrab-try-on")).toHaveCount(0);
  expect(noise).toEqual([]);
});

test("nothing renders and nothing is logged for a wrong key", async ({ page }) => {
  const noise = hostConsole(page);
  await page.goto(`${SHOP}/products/wrong-key`);
  await page.waitForTimeout(2500);
  await expect(page.locator("garrab-try-on")).toHaveCount(0);
  expect(noise).toEqual([]);
});

test("hosted link: try on, then Buy; back to all products, the result is gone", async ({ page }) => {
  await page.goto(`${APP}/t/demo-brand/prodRedDress01?lang=en`);
  await expect(page.getByRole("heading", { name: "Red linen dress" })).toBeVisible();
  await expect(page.getByText("Demo Brand")).toBeVisible();
  await page.locator("input#photo").setInputFiles(PHOTO);
  await expect(page.locator("img.result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Buy" })).toHaveAttribute("href", "http://localhost:8790/products/red-dress");
  const blobUrl = await page.locator("img.result").getAttribute("src");
  // "See all products" goes back to the brand page; the photo and result are gone.
  await page.getByRole("button", { name: "See all products" }).click();
  await expect(page).toHaveURL(/\/t\/demo-brand\?lang=en$/);
  await expect(page.getByRole("heading", { name: "Choose a piece to try on" })).toBeVisible();
  // The object URL was revoked: the image bytes are no longer reachable in the page.
  const stillThere = await page.evaluate(async (u) => fetch(u!).then(() => true, () => false), blobUrl);
  expect(stillThere).toBe(false);
});

test("kill switch: the button disappears within 60 s on an open page, and comes back after restore", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(`${SHOP}/products/red-dress`);
  await expect(page.locator("garrab-try-on button")).toBeVisible();

  const t0 = Date.now();
  setDemoStatus("suspended");
  await expect(page.locator("garrab-try-on")).toHaveCount(0, { timeout: 60_000 });
  const seconds = (Date.now() - t0) / 1000;
  console.log(`widget removed ${seconds.toFixed(1)} s after suspension`);
  expect(seconds).toBeLessThan(60);

  // Hosted link and brand page show the neutral page.
  await page.goto(`${APP}/t/demo-brand/prodRedDress01?lang=en`);
  await expect(page.getByRole("heading", { name: "Temporarily unavailable" })).toBeVisible({ timeout: 20_000 });
  await page.goto(`${APP}/t/demo-brand?lang=en`);
  await expect(page.getByRole("heading", { name: "Temporarily unavailable" })).toBeVisible({ timeout: 20_000 });

  setDemoStatus("active");
  await page.waitForTimeout(16_000); // server status cache is 15 s
  await page.goto(`${SHOP}/products/red-dress`);
  await expect(page.locator("garrab-try-on button")).toBeVisible();
});

test("brand page (Instagram bio link) lists products and opens one", async ({ page }) => {
  await page.goto(`${APP}/t/demo-brand?lang=en`);
  await expect(page.getByRole("heading", { name: "Choose a piece to try on" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: /Red linen dress/ }).click();
  await expect(page).toHaveURL(/\/t\/demo-brand\/prodRedDress01\?lang=en$/);
  await expect(page.getByRole("button", { name: "Upload a clear photo of yourself" }).first()).toBeVisible();
});

test("size finder (Growth): answers on the try-on link in English and Arabic, then back to try-on", async ({ page }) => {
  sql("UPDATE accounts SET plan_id = 'growth' WHERE id = 'acc_demo'");
  sql(`UPDATE products SET sizes_json = '["S","M","L","XL"]' WHERE id = 'prodRedDress01'`);
  try {
    await page.goto(`${APP}/t/demo-brand/prodRedDress01?lang=en`);
    await page.getByRole("button", { name: "Find my size" }).click();
    await page.getByLabel("Height (cm)").fill("165");
    await page.getByLabel("Weight (kg, optional)").fill("60");
    await page.getByLabel("Your usual size").fill("M");
    await page.getByLabel("How do you like it to fit?").selectOption("loose");
    await page.getByRole("button", { name: "Suggest my size" }).click();
    await expect(page.getByText("Estimated size")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "M" })).toBeVisible();
    await expect(page.getByText("Also worth a look:")).toBeVisible();
    await page.getByRole("button", { name: "Try it on" }).click();
    await expect(page.getByRole("button", { name: "Upload a clear photo of yourself" }).first()).toBeVisible();

    await page.goto(`${APP}/t/demo-brand/prodRedDress01?lang=ar`);
    await page.getByRole("button", { name: "اعرف مقاسك" }).click();
    await page.getByLabel("الطول (سم)").fill("170");
    await page.getByLabel("مقاسك المعتاد").fill("L");
    await page.getByRole("button", { name: "اقترح مقاسي" }).click();
    await expect(page.getByText("المقاس التقديري")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "L" })).toBeVisible();
  } finally {
    sql("UPDATE accounts SET plan_id = 'starter' WHERE id = 'acc_demo'");
    sql(`UPDATE products SET sizes_json = '[]' WHERE id = 'prodRedDress01'`);
  }
});

test("size finder is not offered on Starter", async ({ page }) => {
  await page.goto(`${APP}/t/demo-brand/prodRedDress01?lang=en`);
  await expect(page.getByRole("button", { name: "Upload a clear photo of yourself" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Find my size" })).toHaveCount(0);
});

test("home décor brand: bio link lists pieces 'to see in your room', and a room photo gives a room preview", async ({ page }) => {
  sql(
    "INSERT OR IGNORE INTO accounts (id, slug, name, plan_id, status, cycle_start, buy_url, paid_through, onboarding_step, email, category) VALUES ('acc_home', 'home-brand', 'Beit Home', 'starter', 'active', '2026-11-01', 'http://localhost:8790', '2099-12-31', 'converted', 'owner@home-brand.example', 'home')",
  );
  sql(
    `INSERT OR IGNORE INTO products (id, account_id, external_ref, url_path, title, description, images_json, kind, enabled, approved) VALUES ('prodRug01', 'acc_home', 'rug1', '/products/rug', 'Berber rug', 'Hand-woven wool rug.', '["http://localhost:8790/red-dress.svg"]', 'decor', 1, 1)`,
  );
  await page.goto(`${APP}/t/home-brand?lang=en`);
  await expect(page.getByRole("heading", { name: "Choose a piece to see in your room" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: /Berber rug/ }).click();
  await expect(page.getByRole("button", { name: "Upload a photo of your room" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Find my size" })).toHaveCount(0);
  await page.locator("input#photo").setInputFiles(PHOTO);
  await expect(page.locator("img.result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("AI preview").first()).toBeVisible();
});

test("an iPhone HEIC photo works even where the browser can't open HEIC (Chrome on a Mac)", async ({ page }) => {
  // This Chromium, like Chrome on a Mac, can't decode HEIC: the page sends the file as it is and the
  // server removes its location/device details before the AI sees it.
  const HEIC = new URL("../fixtures/synthetic-room.heic", import.meta.url).pathname;
  await page.goto(`${SHOP}/products/red-dress`);
  await page.locator("garrab-try-on button").click();
  const frame = page.frameLocator("garrab-try-on iframe");
  await frame.locator("input#photo").setInputFiles({ name: "IMG_0035.HEIC", mimeType: "image/heic", buffer: (await import("node:fs")).readFileSync(HEIC) });
  await expect(frame.locator("img.result")).toBeVisible({ timeout: 30_000 });
});
