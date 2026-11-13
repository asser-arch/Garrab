import { test } from "@playwright/test";
import { setDemoStatus } from "./db.js";

// Screenshots for review only: SCREENSHOTS=1 pnpm e2e -- screens
test.skip(!process.env.SCREENSHOTS, "screenshots only on request");
test.use({ deviceScaleFactor: 2, viewport: { width: 390, height: 844 } });

const PHOTO = new URL("../fixtures/synthetic-photo.png", import.meta.url).pathname;
const out = (n: string): string => new URL(`../screens/${n}.png`, import.meta.url).pathname;

test("screens", async ({ page }) => {
  setDemoStatus("active");
  await page.goto("http://localhost:8790/products/red-dress");
  await page.locator("garrab-try-on button").waitFor();
  await page.screenshot({ path: out("1-shop-button") });
  await page.locator("garrab-try-on button").click();
  const frame = page.frameLocator("garrab-try-on iframe");
  await frame.getByRole("heading").waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out("2-consent") });
  await frame.locator("input#photo").setInputFiles(PHOTO);
  await frame.locator("img.result").waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("3-result") });
  await page.goto("http://localhost:8788/t/demo-brand/prodRedDress01?lang=ar");
  await page.getByRole("heading").first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out("4-hosted-ar") });
});
