/**
 * Phase 3 "done when": an unpaid brand is suspended and the widget disappears within 60 seconds,
 * and paying restores it, through both the emailed link and the portal "Pay now" page.
 * Payment confirmation is the real flow: "I've paid" on the pay page, then Asser's Confirm
 * (a signed Telegram button press for path 1, the admin console button for path 2).
 */
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { query, sql } from "./db.js";

const SHOP = "http://localhost:8790";
const APP = "http://localhost:8788";
const ADMIN = "http://localhost:8789";
const API = "http://localhost:8787";

function cairoDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Make the demo brand 6 days late and run the billing job (as the 05:00 run would). */
async function goUnpaid(page: Page): Promise<number> {
  sql(`UPDATE accounts SET status = 'active', manual_hold = 0, paid_through = '${cairoDay(-6)}' WHERE id = 'acc_demo'`);
  sql("DELETE FROM payment_claims WHERE account_id = 'acc_demo'");
  sql("UPDATE invoices SET status = 'void' WHERE account_id = 'acc_demo' AND status = 'open'");
  await page.goto(`${SHOP}/products/red-dress`);
  await expect(page.locator("garrab-try-on button")).toBeVisible();
  const t0 = Date.now();
  const r = await page.request.post(`${ADMIN}/admin-api/jobs/billing_run/run`, { data: {} });
  expect(r.ok()).toBe(true);
  expect(query<{ status: string }>("SELECT status FROM accounts WHERE id = 'acc_demo'")[0]!.status).toBe("suspended");
  await expect(page.locator("garrab-try-on")).toHaveCount(0, { timeout: 60_000 });
  return (Date.now() - t0) / 1000;
}

async function claimOnPayPage(page: Page, payUrl: string, reference: string): Promise<void> {
  await page.goto(payUrl);
  await expect(page.getByRole("heading", { name: /Invoice/ })).toBeVisible();
  await expect(page.getByText("01009110001").first()).toBeVisible();
  await expect(page.getByText("5,000 EGP").first()).toBeVisible();
  await page.getByLabel("InstaPay reference (from your receipt)").fill(reference);
  await page.getByRole("button", { name: "I've paid" }).click();
  await expect(page.getByRole("heading", { name: "Thanks, we're checking your transfer" })).toBeVisible();
}

async function expectButtonBack(page: Page): Promise<void> {
  expect(query<{ status: string }>("SELECT status FROM accounts WHERE id = 'acc_demo'")[0]!.status).toBe("active");
  await expect(async () => {
    await page.goto(`${SHOP}/products/red-dress`);
    await expect(page.locator("garrab-try-on button")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
}

test.afterAll(() => {
  // Leave the demo brand paid for the other suites.
  sql("UPDATE accounts SET status = 'active', manual_hold = 0, paid_through = '2099-12-31' WHERE id = 'acc_demo'");
});

test("path 1: suspended → widget gone < 60 s → pay via the emailed link → Telegram Confirm → back on", async ({ page, request }) => {
  test.setTimeout(180_000);
  const secs = await goUnpaid(page);
  console.log(`widget removed ${secs.toFixed(1)} s after suspension (billing run)`);
  expect(secs).toBeLessThan(60);

  // The "switched off" email carries the pay link.
  const mail = query<{ html: string }>("SELECT html FROM dev_outbox WHERE to_addr = 'owner@demo-brand.example' AND subject = 'Garrab try-on is switched off' ORDER BY created_at DESC LIMIT 1")[0]!;
  const payUrl = /href="(http:\/\/localhost:8788\/pay\/[A-Za-z0-9]{32})"/.exec(mail.html)![1]!;
  await claimOnPayPage(page, payUrl, "IPN-E2E-0001");

  // Asser taps ✅ Confirm in Telegram (a signed button press from his chat).
  const claim = query<{ id: string }>("SELECT id FROM payment_claims WHERE account_id = 'acc_demo' AND status = 'pending'")[0]!;
  const body = `pc:${claim.id}:a`;
  const sig = createHmac("sha256", "dev-only-telegram-callback-key-not-for-prod").update(body).digest("base64url").slice(0, 12);
  const r = await request.post(`${API}/webhooks/telegram`, {
    headers: { "x-telegram-bot-api-secret-token": "dev-telegram-secret-local-only" },
    data: { update_id: Date.now(), callback_query: { id: "cq", data: `${body}:${sig}`, from: { id: 424242 }, message: { message_id: 1, chat: { id: 424242 }, text: "x" } } },
  });
  expect(r.status()).toBe(200);

  await expectButtonBack(page);
  const paid = query<{ paid_through: string }>("SELECT paid_through FROM accounts WHERE id = 'acc_demo'")[0]!;
  expect(paid.paid_through > cairoDay(0)).toBe(true); // a month on from the old date
  // The pay page now says paid, with a PDF receipt.
  await page.goto(payUrl);
  await expect(page.getByRole("heading", { name: "Paid ✓" })).toBeVisible();
  const pdf = await request.get(`${payUrl}/invoice.pdf`);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
});

test("path 2: suspended → brand uses portal Pay now → Asser confirms in the admin → back on", async ({ page }) => {
  test.setTimeout(180_000);
  const secs = await goUnpaid(page);
  expect(secs).toBeLessThan(60);

  // Brand signs in with the 6-digit code from the email.
  // Start from /portal (signed out), the address brands actually type.
  await page.goto(`${APP}/portal`);
  await page.getByLabel("Your email").fill("owner@demo-brand.example");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  const login = query<{ subject: string }>("SELECT subject FROM dev_outbox WHERE to_addr = 'owner@demo-brand.example' AND subject LIKE 'Your Garrab sign-in code%' ORDER BY created_at DESC LIMIT 1")[0]!;
  await page.getByLabel("6-digit code").fill(/(\d{6})$/.exec(login.subject)![1]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

  await page.goto(`${APP}/portal/billing`);
  await expect(page.getByText("Switched off: payment needed")).toBeVisible();
  await page.getByRole("button", { name: "Pay and switch back on" }).click();
  await page.waitForURL(/\/pay\/[A-Za-z0-9]{32}$/);
  await claimOnPayPage(page, page.url(), "IPN-E2E-0002");

  // Asser confirms from the admin dashboard.
  await page.goto(ADMIN);
  await expect(page.getByRole("heading", { name: "Payments to confirm" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).first().click();
  await expect(page.getByRole("heading", { name: "Payments to confirm" })).toHaveCount(0);

  await expectButtonBack(page);
  const pays = query<{ provider: string; reference: string; actor: string }>(
    "SELECT provider, reference, actor FROM payments WHERE account_id = 'acc_demo' ORDER BY created_at DESC LIMIT 1",
  );
  expect(pays[0]).toEqual({ provider: "instapay_direct", reference: "IPN-E2E-0002", actor: "admin:dev-admin" });
});

test("admin Kill switches a paying brand off at once; Restore brings it back", async ({ page }) => {
  test.setTimeout(120_000);
  sql("UPDATE accounts SET status = 'active', manual_hold = 0, paid_through = '2099-12-31' WHERE id = 'acc_demo'");
  await expectButtonBack(page); // allows for the API's 15 s status cache
  const kill = await page.request.post(`${ADMIN}/admin-api/accounts/acc_demo/kill`, { data: { reason: "e2e kill test" } });
  expect(kill.ok()).toBe(true);
  await expect(page.locator("garrab-try-on")).toHaveCount(0, { timeout: 60_000 });
  const restore = await page.request.post(`${ADMIN}/admin-api/accounts/acc_demo/restore`, { data: { reason: "e2e restore" } });
  expect(restore.ok()).toBe(true);
  await expectButtonBack(page);
});
