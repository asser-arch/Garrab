import { describe, expect, it } from "vitest";
import { COMPANY } from "@garrab/shared/plans";
import { emails } from "../src/emails.js";

describe("Garrab logo in emails", () => {
  it("every brand email starts with the Garrab logo image (PNG, with alt text)", () => {
    const all = Object.entries(emails)
      .filter(([, fn]) => typeof fn === "function")
      .map(([name, fn]) => {
        // Call each template with plausible arguments; the layout (and so the logo) is shared.
        try {
          return [name, (fn as (...a: unknown[]) => { html: string })("brand@x.example", "Brand", "https://app.test/x", "123456")] as const;
        } catch {
          return [name, null] as const;
        }
      })
      .filter(([, m]) => m && typeof m.html === "string");
    expect(all.length).toBeGreaterThan(5);
    for (const [name, m] of all) {
      expect(m!.html, name).toContain(`<img src="${COMPANY.emailLogo}"`);
      expect(m!.html, name).toContain('alt="Garrab"');
    }
    expect(COMPANY.emailLogo).toMatch(/^https:\/\/.+\.png$/);
  });
});
