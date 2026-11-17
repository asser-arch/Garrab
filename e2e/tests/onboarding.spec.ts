/**
 * Phase 2 "done when": invite a test brand and it reaches pilot_live with no admin action
 * after the invite. Everything in between is the brand's own clicks plus automation:
 * import from the shop, automatic tests on stock models, approval, install check, pilot start.
 */
import { expect, test } from "@playwright/test";
import { query } from "./db.js";

const ADMIN = "http://localhost:8789";
const APP = "http://localhost:8788";
const SHOP = "http://127.0.0.1:8790";

test("invite → import → tests → approve → install → pilot live, with no admin action", async ({ page, request }) => {
  test.setTimeout(180_000);
  const email = `e2e-${Date.now()}@brand.example`;

  // 1. Asser invites the brand from the admin (the only admin action).
  await page.goto(ADMIN);
  await page.getByRole("link", { name: "Onboarding" }).click();
  await page.getByLabel("Brand name").fill("E2E Linen Co");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Plan after pilot").selectOption("growth");
  await page.getByLabel("Website (optional)").fill(SHOP);
  await page.getByRole("button", { name: "Create and get sign-in link" }).click();
  const linkText = await page.getByRole("status").locator("p").nth(1).textContent();
  const link = linkText!.trim();
  expect(link).toMatch(/^http:\/\/localhost:8788\/portal\/login#t=[A-Za-z0-9]{40}$/);

  // 2. The brand opens the link: signed in, no password.
  // The link never signs in by itself (email scanners would use it up): one tap on "Sign in".
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Welcome, E2E Linen Co/ })).toBeVisible();

  // 3. Products are imported and tested automatically (queue). Wait for the previews.
  await expect(async () => {
    await page.goto(`${APP}/portal/approve`);
    await expect(page.getByRole("button", { name: "Approve" }).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000] });
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(3);
  // Any picture opens full size; arrows move between them; Escape closes.
  const firstCard = page.getByRole("article").filter({ has: page.getByRole("button", { name: "Approve" }) }).first();
  await firstCard.getByRole("button", { name: /^Enlarge on model a/ }).click();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText(/On model A/)).toBeVisible();
  await expect(viewer.locator("img")).toHaveJSProperty("complete", true);
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByText(/On model B/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Cotton shirt [low]" }).getByText(/Not available for try-on/)).toBeVisible();
  await expect(page.getByRole("article", { name: "Olive linen dress" }).locator(".chip").first()).toHaveText("AI preview");

  // 4. The brand approves one product and hides another.
  await page.getByRole("article", { name: "Olive linen dress" }).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("article", { name: "Black abaya with pockets" }).getByRole("button", { name: "Hide" }).click();
  // Approving is the go-ahead: the brand goes live straight away (no separate "Done" step).
  await expect(page.getByText("Approved products are live on your try-on link straight away.")).toBeVisible();
  await page.goto(`${APP}/portal/install`);

  // 5. Install page: copy the line into the shop, then check.
  await expect(page.getByRole("heading", { name: /Install/ })).toBeVisible();
  const snippet = (await page.getByLabel("Install code").textContent())!;
  const key = /data-key="([^"]+)"/.exec(snippet)![1]!;
  await request.post(`${SHOP}/__install`, { data: { key } }); // the brand pastes it into theme.liquid
  await page.getByRole("button", { name: "Check installation" }).click();
  await expect(page.getByText("Installed ✓")).toBeVisible({ timeout: 20_000 });

  // 6. Pilot is live.
  await page.goto(`${APP}/portal`);
  await expect(page.getByRole("heading", { name: "Your pilot is live" })).toBeVisible();
  const [acc] = query<{ status: string; onboarding_step: string; target_plan_id: string; pilot_ends_at: string }>(
    `SELECT status, onboarding_step, target_plan_id, pilot_ends_at FROM accounts WHERE email = '${email}'`,
  );
  expect(acc).toMatchObject({ status: "pilot", onboarding_step: "pilot_live", target_plan_id: "growth" });

  // Only the invite was an admin action.
  const adminActions = query<{ action: string }>(
    `SELECT action FROM audit_log WHERE actor LIKE 'admin:%' AND account_id = (SELECT id FROM accounts WHERE email = '${email}')`,
  );
  expect(adminActions.map((a) => a.action)).toEqual(["invite"]);

  // Emails went out at each step (captured locally in dev_outbox).
  const mails = query<{ subject: string }>(`SELECT subject FROM dev_outbox WHERE to_addr = '${email}' ORDER BY created_at`);
  expect(mails.map((m) => m.subject)).toEqual([
    "Welcome to Garrab, E2E Linen Co",
    "Your try-on previews are ready to approve",
    "Your try-on link is live. Next: add Garrab to your shop",
    "Your 14-day Garrab pilot has started",
  ]);

  // 7. Shoppers now see the button on the approved product, and not on the hidden one.
  await page.goto(`${SHOP}/products/item-1`);
  await expect(page.locator("garrab-try-on button")).toHaveText("Try it on");
  await page.goto(`${SHOP}/products/item-2`);
  await page.waitForTimeout(2_000);
  await expect(page.locator("garrab-try-on")).toHaveCount(0);

  // 8. The brand's one bio link is ready to share; the QR (for print) opens on request.
  await page.goto(`${APP}/portal/install`);
  await expect(page.getByRole("heading", { name: "Your try-on link" })).toBeVisible();
  await expect(page.getByRole("link", { name: /\/t\/[a-z0-9-]+$/ })).toBeVisible();
  await page.getByText("QR code for print").first().click();
  await expect(page.getByRole("img", { name: "QR code for Olive linen dress" })).toBeVisible();

  // 9. Results page: totals, the daily chart and the products table (anonymous counts).
  await page.goto(`${APP}/portal/results`);
  await expect(page.getByRole("heading", { name: /Results/ })).toBeVisible();
  await expect(page.getByText("Previews per day")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();
});

test("the public /start form creates a lead and an account", async ({ page }) => {
  const email = `start-${Date.now()}@brand.example`;
  await page.goto(`${APP}/start`);
  await expect(page.getByRole("heading", { name: /See it on you/ })).toBeVisible();
  await page.getByLabel("Brand name").fill("Start Form Brand");
  await page.getByLabel("Your name").fill("Mona");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("WhatsApp number").fill("01001234567");
  await page.getByLabel("Where do you sell?").selectOption("social_only");
  await page.getByLabel("Instagram handle").fill("startformbrand");
  await page.getByRole("button", { name: "Start my free pilot" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const rows = query<{ platform: string; instagram: string; whatsapp: string }>(`SELECT platform, instagram, whatsapp FROM accounts WHERE email = '${email}'`);
  expect(rows).toEqual([{ platform: "social_only", instagram: "@startformbrand", whatsapp: "+201001234567" }]);
});

test("a sign-in link works once", async ({ page }) => {
  await page.goto(`${APP}/portal/login#t=${"x".repeat(40)}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(/expired or was already used/);
});
