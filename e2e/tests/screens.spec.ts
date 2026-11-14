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

test("portal and admin screens", async ({ page, request }) => {
  test.setTimeout(120_000);
  const email = `shots-${Date.now()}@brand.example`;
  await page.goto("http://localhost:8789/");
  await page.getByLabel("Brand name").fill("Nour Linen");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Website (optional)").fill("http://127.0.0.1:8790");
  await page.getByRole("button", { name: "Create and get sign-in link" }).click();
  const link = (await page.getByRole("status").locator("p").nth(1).textContent())!.trim();
  await page.screenshot({ path: out("5-admin-invite"), fullPage: true });
  await page.goto(link);
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await expect_(async () => {
    await page.goto("http://localhost:8788/portal/approve");
    await page.getByRole("button", { name: "Approve" }).first().waitFor({ timeout: 2000 });
  });
  await page.getByRole("article", { name: "Olive linen dress" }).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "✓ Approved" }).waitFor();
  await page.screenshot({ path: out("6-portal-approve"), fullPage: true });
  await page.getByRole("button", { name: /Done:/ }).click();
  await page.getByLabel("Install code").waitFor();
  const key = /data-key="([^"]+)"/.exec((await page.getByLabel("Install code").textContent())!)![1];
  await request.post("http://127.0.0.1:8790/__install", { data: { key } });
  await page.getByRole("button", { name: "Check installation" }).click();
  await page.getByText("Installed ✓").waitFor();
  await page.screenshot({ path: out("7-portal-install"), fullPage: true });
  await page.goto("http://localhost:8788/portal");
  await page.getByRole("heading", { name: "Your pilot is live" }).waitFor();
  await page.waitForTimeout(500); // let the fade-in finish
  await page.screenshot({ path: out("8-portal-home"), fullPage: true });
  await page.goto("http://localhost:8788/start");
  await page.screenshot({ path: out("9-start"), fullPage: true });
});

async function expect_(fn: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 45; i++) {
    try {
      return await fn();
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("timed out");
}
