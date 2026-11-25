import { expect, test } from "@playwright/test";

const APP = "http://localhost:8788";

/** The landing page: readable by search engines and AI assistants, in English and Arabic. */
test("landing page: content, structured data and languages", async ({ page }) => {
  await page.goto(`${APP}/`);
  await expect(page).toHaveTitle(/Garrab: AI virtual try-on for online brands/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("try it on");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://garrabb.com/");
  await expect(page.locator('link[hreflang="ar"]')).toHaveAttribute("href", "https://garrabb.com/ar");
  const types = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[type="application/ld+json"]')).flatMap((s) => (JSON.parse(s.textContent!)["@graph"] as { "@type": string }[]).map((x) => x["@type"])),
  );
  expect(types).toEqual(expect.arrayContaining(["Organization", "SoftwareApplication", "FAQPage"]));
  await expect(page.getByRole("link", { name: "Start your free 14-day pilot" })).toHaveAttribute("href", "https://app.garrabb.com/start");
  // The FAQ answers are in the page itself (not hidden behind scripts) so crawlers can read them.
  await expect(page.locator("details", { hasText: "How much does it cost?" })).toContainText("5,000 EGP");

  await page.goto(`${APP}/ar`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("قبل ما يشتروا");

  // The local/staging copy must never be indexed (only garrabb.com is).
  const r = await page.request.get(`${APP}/`);
  expect(r.headers()["x-robots-tag"]).toBe("noindex");
  for (const f of ["/llms.txt", "/sitemap.xml", "/landing.css", "/og-en.png"]) expect((await page.request.get(`${APP}${f}`)).status(), f).toBe(200);
});
