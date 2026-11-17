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
  await page.getByRole("link", { name: "Onboarding" }).click();
  await page.getByLabel("Brand name").fill("Nour Linen");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Website (optional)").fill("http://127.0.0.1:8790");
  await page.getByRole("button", { name: "Create and get sign-in link" }).click();
  const link = (await page.getByRole("status").locator("p").nth(1).textContent())!.trim();
  await page.screenshot({ path: out("5-admin-invite"), fullPage: true });
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await expect_(async () => {
    await page.goto("http://localhost:8788/portal/approve");
    await page.getByRole("button", { name: "Approve" }).first().waitFor({ timeout: 2000 });
  });
  await page.getByRole("article", { name: "Olive linen dress" }).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "✓ Approved" }).waitFor();
  await page.screenshot({ path: out("6-portal-approve"), fullPage: true });
  await page.goto("http://localhost:8788/portal/install");
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

test("billing screens", async ({ page }) => {
  test.setTimeout(120_000);
  const { sql, query } = await import("./db.js");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 6 * 86_400_000));
  sql(`UPDATE accounts SET status = 'active', manual_hold = 0, paid_through = '${day}' WHERE id = 'acc_demo'`);
  sql("UPDATE invoices SET status = 'void' WHERE account_id = 'acc_demo' AND status = 'open'");
  sql("DELETE FROM payment_claims WHERE account_id = 'acc_demo'");
  await page.request.post("http://localhost:8789/admin-api/jobs/billing_run/run", { data: {} });
  const token = query<{ pay_token: string }>("SELECT pay_token FROM invoices WHERE account_id = 'acc_demo' AND status = 'open' AND kind = 'plan'")[0]!.pay_token;
  await page.goto(`http://localhost:8788/pay/${token}`);
  await page.getByRole("heading", { name: "Pay by InstaPay" }).waitFor();
  await page.screenshot({ path: out("10-pay-page"), fullPage: true });
  await page.request.post(`http://localhost:8788/pay-api/${token}/claim`, { data: { reference: "IPN-778812", payerName: "Mona" }, headers: { origin: "http://localhost:8788" } });
  await page.request.post("http://localhost:8788/portal-api/auth/request", { data: { email: "owner@demo-brand.example" }, headers: { origin: "http://localhost:8788" } });
  const html = query<{ html: string }>("SELECT html FROM dev_outbox WHERE subject LIKE 'Your Garrab sign-in code%' AND to_addr = 'owner@demo-brand.example' ORDER BY created_at DESC LIMIT 1")[0]!.html;
  await page.goto(/href="([^"]+#t=[A-Za-z0-9]{40})"/.exec(html)![1]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await page.goto("http://localhost:8788/portal/billing");
  await page.getByRole("heading", { name: /Billing/ }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("11-portal-billing"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://localhost:8789/");
  await page.getByRole("heading", { name: "Payments to confirm" }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("12-admin-dashboard"), fullPage: true });
  sql("UPDATE accounts SET status = 'active', manual_hold = 0, paid_through = '2099-12-31' WHERE id = 'acc_demo'");
});
