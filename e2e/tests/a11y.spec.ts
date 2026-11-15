/**
 * Automated accessibility scan (axe-core, WCAG 2.1 AA rules) of every public screen and the admin.
 * Fails on serious or critical violations. Catches about a third of issues; keyboard and screen
 * reader checks stay manual.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

async function scan(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return res.violations.map((v: { id: string; impact: string; help: string; nodes: { target: string[] }[] }) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      where: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
  });
  return (r as { id: string; impact: string; help: string; where: string[] }[])
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.help} @ ${v.where.join(", ")}`);
}

const pages: [string, string][] = [
  ["start page", "http://localhost:8788/start"],
  ["privacy", "http://localhost:8788/privacy"],
  ["terms", "http://localhost:8788/terms"],
  ["portal sign-in", "http://localhost:8788/portal"],
  ["brand page (bio link)", "http://localhost:8788/t/demo-brand"],
  ["hosted try-on (English)", "http://localhost:8788/t/demo-brand/prodRedDress01"],
  ["hosted try-on (Arabic)", "http://localhost:8788/t/demo-brand/prodRedDress01?lang=ar"],
  ["admin dashboard", "http://localhost:8789/"],
];

for (const [name, url] of pages) {
  test(`a11y: ${name}`, async ({ page }) => {
    await page.goto(url);
    await page.waitForLoadState("load");
    await page.waitForTimeout(800); // client-rendered screens
    expect(await scan(page)).toEqual([]);
  });
}
