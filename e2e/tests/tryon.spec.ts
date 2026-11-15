import { expect, test, type Page } from "@playwright/test";
import { setDemoStatus } from "./db.js";

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

test("hosted link: try on, then Buy; the result is gone after closing", async ({ page }) => {
  await page.goto(`${APP}/t/demo-brand/prodRedDress01?lang=en`);
  await expect(page.getByRole("heading", { name: "Red linen dress" })).toBeVisible();
  await expect(page.getByText("Demo Brand")).toBeVisible();
  await page.locator("input#photo").setInputFiles(PHOTO);
  await expect(page.locator("img.result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Buy" })).toHaveAttribute("href", "http://localhost:8790/products/red-dress");
  const blobUrl = await page.locator("img.result").getAttribute("src");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Your photo has been deleted.")).toBeVisible();
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
