import { expect, test } from "@playwright/test";
import { query } from "./db.js";

const APP = "http://localhost:8788";
const ADMIN = "http://localhost:8789";

/** The brand writes from the portal, gets an automatic first answer, Garrab support replies from the admin. */
test("support chat: portal → automatic reply → admin reply → brand sees it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.request.post(`${APP}/portal-api/auth/request`, { data: { email: "owner@demo-brand.example" }, headers: { origin: APP } });
  const html = query<{ html: string }>(
    "SELECT html FROM dev_outbox WHERE subject LIKE 'Your Garrab sign-in code%' AND to_addr = 'owner@demo-brand.example' ORDER BY created_at DESC LIMIT 1",
  )[0]!.html;
  await page.goto(/href="([^"]+#t=[A-Za-z0-9]{40})"/.exec(html)![1]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /Welcome|pilot|live/i }).first().waitFor();

  await page.getByRole("button", { name: /^Help/ }).click();
  const chat = page.getByRole("dialog", { name: "Chat with Garrab support" });
  await expect(chat).toBeVisible();
  await chat.getByLabel("Your message").fill("How do I put the button on my Shopify shop?");
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByText("Automatic reply", { exact: true })).toBeVisible();
  await expect(chat.getByText("Someone from Garrab's support team will be here shortly.", { exact: false })).toBeVisible();
  if (process.env.SHOTS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.SHOTS}/chat-portal.png` });
  }

  // Garrab support answers from the admin.
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await admin.goto(ADMIN);
  await admin.getByRole("link", { name: /^Support/ }).click();
  await admin.getByRole("button", { name: /Demo/ }).first().click();
  await admin.getByLabel("Reply as Garrab support").fill("Hi! Paste your line in theme.liquid before </body>. I can do it with you on a call.");
  await admin.getByRole("button", { name: "Send reply" }).click();
  await expect(admin.getByText("Garrab support (you)", { exact: false })).toBeVisible();
  if (process.env.SHOTS) await admin.screenshot({ path: `${process.env.SHOTS}/chat-admin.png`, fullPage: true });

  // The brand sees the reply in the open chat (polled).
  await expect(chat.getByText("I can do it with you on a call.", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(chat.locator(".bubble-who", { hasText: "Garrab support" })).toBeVisible();
  if (process.env.SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.SHOTS}/chat-phone.png` });
  }
});
