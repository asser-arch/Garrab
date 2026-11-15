import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AR_IS_DRAFT,
  BILLING,
  EXTRA_PACK,
  LeadForm,
  PILOT,
  PLANS,
  SERVING_STATUSES,
  SETUP_FEE,
  SizeResult,
  TRY_ON_KEYS,
  ar,
  assertStringsReadyForProduction,
  dailyCap,
  egp,
  productLimit,
  en,
  langFromPage,
  tokens,
  tryOnStrings,
} from "../src/index.js";

describe("plans.ts matches the brief (§1)", () => {
  it("prices and limits", () => {
    expect(SETUP_FEE).toBe(egp(1500));
    expect(PLANS.starter.monthlyPrice).toBe(egp(5000));
    expect(PLANS.growth.monthlyPrice).toBe(egp(8500));
    expect(PLANS.starter.includedPreviews).toBe(250);
    expect(PLANS.growth.includedPreviews).toBe(600);
    expect(PLANS.starter.sizeFinder).toBe(false);
    expect(PLANS.growth.sizeFinder).toBe(true);
    expect(EXTRA_PACK).toEqual({ previews: 100, price: egp(800) });
    // Asser, 14 Nov: no product limit on paid plans; per-brand limit possible.
    expect(PLANS.starter.maxProducts).toBeNull();
    expect(PLANS.growth.maxProducts).toBeNull();
    expect(productLimit("growth", null)).toBeNull();
    expect(productLimit("growth", 40)).toBe(40);
    expect(productLimit("pilot", null)).toBe(10);
  });

  it("pilot and billing rules", () => {
    expect(PILOT.days).toBe(14);
    expect(PILOT.maxProducts).toBe(10);
    expect(PILOT.previews).toBe(300);
    expect(PILOT.setupFee).toBe(0);
    expect(BILLING.graceDays).toBe(5);
    expect(BILLING.invoiceLeadDays).toBe(7);
    expect(BILLING.reminderOffsetsDays).toEqual([0, 1, 3, 5]);
    expect(BILLING.vatRateBp).toBe(0);
    expect([...SERVING_STATUSES]).toEqual(["pilot", "active", "past_due"]);
  });

  it("daily cap is 3x the average daily allowance", () => {
    expect(dailyCap(PLANS.starter)).toBe(Math.ceil((250 / 30) * 3));
    expect(dailyCap(PLANS.pilot)).toBe(Math.ceil((300 / 14) * 3));
  });

  it("no price or limit is hard-coded outside plans.ts", () => {
    // Guard: the money amounts from the brief must only appear in plans.ts.
    const root = join(__dirname, "..", "..", "..");
    const forbidden = /\b(1[,_]?500|3[,_]?000|6[,_]?000|800)\s*(EGP|egp|piastres)?\b/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".git", "dist", ".wrangler", "docs", "test"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !p.endsWith("plans.ts")) {
          const src = readFileSync(p, "utf8");
          if (forbidden.test(src) && /price|egp|fee|pack/i.test(src)) offenders.push(relative(root, p));
        }
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    expect(offenders).toEqual([]);
  });
});

describe("strings (§4)", () => {
  it("exact English wording", () => {
    expect(en.upload).toBe("Upload a clear photo of yourself");
    expect(en.consent).toBe("By uploading a photo you agree we use it only to create your preview.");
    expect(en.aiPreview).toBe("AI preview");
    expect(en.disclaimer).toBe(
      "This is an AI preview to help you imagine the look. Colours, size and small details may differ slightly from the real product.",
    );
    expect(en.progress).toBe("Creating your preview…");
    expect(en.download).toBe("Download preview");
    expect(en.closed).toBe("Your photo has been deleted.");
    expect(en.error).toBe("We couldn't create a preview from this photo. Try a clearer one.");
    expect(en.sizeLabel).toBe("Estimated size");
  });

  it("Arabic covers every try-on key", () => {
    for (const k of TRY_ON_KEYS) expect(ar[k], k).toBeTruthy();
  });

  it("picks the language from the page", () => {
    expect(langFromPage("ar-EG")).toBe("ar");
    expect(langFromPage("en")).toBe("en");
    expect(langFromPage(null)).toBe("en");
    expect(tryOnStrings("ar").aiPreview).toBe(ar.aiPreview);
  });

  it("Arabic uses the exact Pitch Kit §05 wording", () => {
    expect(ar.buttonTryOn).toBe("جرّبه على نفسك");
    expect(ar.aiPreview).toBe("معاينة بالذكاء الاصطناعي");
    expect(ar.privacy).toBe("نستخدم صورتك فقط لإنشاء هذه المعاينة. لا نحتفظ بها، ويتم حذفها عند إغلاق الصفحة.");
    expect(ar.closed).toBe("تم حذف صورتك.");
    expect(AR_IS_DRAFT).toBe(false);
  });

  it("production builds are blocked while Arabic is DRAFT", () => {
    if (AR_IS_DRAFT) expect(() => assertStringsReadyForProduction()).toThrow(/DRAFT/);
    else expect(() => assertStringsReadyForProduction()).not.toThrow();
  });
});

describe("schemas", () => {
  const base = {
    brandName: "Hayal",
    contactName: "Mona",
    email: "Mona@Example.com",
    whatsapp: "0100 123 4567",
    website: "https://example.com",
    platform: "shopify",
    niche: "clothing",
    plan: "starter",
    turnstileToken: "t",
  };

  it("normalises the lead form", () => {
    const v = LeadForm.parse(base);
    expect(v.email).toBe("mona@example.com");
    expect(v.whatsapp).toBe("+201001234567");
  });

  it("requires a website or Instagram", () => {
    const { website: _w, ...rest } = base;
    expect(LeadForm.safeParse(rest).success).toBe(false);
    expect(LeadForm.safeParse({ ...rest, instagram: "@hayal.eg" }).success).toBe(true);
  });

  it("rejects non-Egyptian mobile numbers", () => {
    expect(LeadForm.safeParse({ ...base, whatsapp: "+447700900000" }).success).toBe(false);
  });

  it("size result can never be high confidence", () => {
    const ok = { recommended_size: "M", alternative_size: null, confidence: "medium", reasons: ["a", "b"] };
    expect(SizeResult.safeParse(ok).success).toBe(true);
    expect(SizeResult.safeParse({ ...ok, confidence: "high" }).success).toBe(false);
  });
});

describe("design tokens (§11)", () => {
  it("match the brand guideline", () => {
    expect(tokens.colors.forest).toBe("#143822");
    expect(tokens.colors.peach).toBe("#F3D6A8");
    const css = tokens.cssVariables();
    expect(css).toContain("--forest:#143822;");
    expect(css).toContain("--radius-pill:999px;");
    expect(css).toContain("--font:Cairo, system-ui, sans-serif;");
  });
});
