import { z } from "zod";
import { PHOTO, PLANS } from "./plans.js";

/** Account statuses (brief §7). */
export const AccountStatus = z.enum([
  "onboarding",
  "pilot",
  "active",
  "past_due",
  "suspended",
  "archived",
  "paused",
  "cancelled",
  "expired",
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

/** Onboarding steps (brief §6). */
export const OnboardingStep = z.enum([
  "invited",
  "account_created",
  "products_imported",
  "products_tested",
  "products_approved",
  "installed",
  "pilot_live",
  "converted",
  "expired",
]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const PlanIdSchema = z.enum(Object.keys(PLANS) as [keyof typeof PLANS, ...(keyof typeof PLANS)[]]);

export const Platform = z.enum(["shopify", "woocommerce", "other_website", "social_only"]);
export const Niche = z.enum(["clothing", "accessories", "home_decor"]);

const egyptPhone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^(?:\+20|0020|0)?1[0125]\d{8}$/, "Enter an Egyptian mobile number, e.g. +201001234567"))
  .transform((s) => `+20${s.replace(/^(?:\+20|0020|0)/, "")}`);

/** True only for a real web address (http/https). Rejects javascript:, data: and other schemes. */
export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * A web address typed by a brand or a visitor. Only http/https: a "javascript:" address would run
 * code when someone clicks the link it becomes (the Buy button, the admin's website link).
 */
export const httpUrl = (max = 1000) =>
  z.string().trim().max(max).refine(isHttpUrl, { message: "Use a web address starting with https://" });

/** Public /start lead form. */
export const LeadForm = z
  .object({
    brandName: z.string().trim().min(2).max(80),
    contactName: z.string().trim().min(2).max(80),
    email: z.string().trim().toLowerCase().email().max(254),
    whatsapp: egyptPhone,
    website: httpUrl(300).optional(),
    instagram: z
      .string()
      .trim()
      .regex(/^@?[A-Za-z0-9._]{1,30}$/, "Instagram handle")
      .optional(),
    platform: Platform,
    niche: Niche,
    plan: z.enum(["starter", "growth"]),
    turnstileToken: z.string().min(1),
    /** The brand whose try-on page sent this lead (its slug), from /start?ref=… */
    ref: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
  })
  .refine((v) => v.website !== undefined || v.instagram !== undefined, {
    message: "Add a website or an Instagram handle",
    path: ["website"],
  });
export type LeadForm = z.infer<typeof LeadForm>;

/** "Leave your number and we'll call you" on /start. */
export const ContactRequest = z.object({
  name: z.string().trim().min(2).max(80),
  whatsapp: egyptPhone,
  brand: z.string().trim().max(80).optional(),
  ref: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
  turnstileToken: z.string().min(1),
});

/** Admin "Invite brand". */
export const BrandCategory = z.enum(["fashion", "home"]);
export const InviteBrand = z.object({
  brandName: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  plan: z.enum(["starter", "growth"]),
  /** Fashion: try-on on a person. Home: room preview. A brand never gets the other. */
  category: BrandCategory.default("fashion"),
});

/** Shopper size-finder inputs (brief §5). Never stored or logged. */
export const BodyType = z.enum(["slim", "average", "athletic", "curvy", "broad", "prefer_not_to_say"]);
export const SizeInput = z.object({
  heightCm: z.number().int().min(120).max(220),
  weightKg: z.number().int().min(30).max(250).nullable(),
  /** The size the shopper usually buys (S, M, 38, …). */
  usualSize: z.string().trim().min(1).max(10),
  bodyType: BodyType,
  prefer: z.enum(["fitted", "regular", "loose"]).default("regular"),
});
export type SizeInput = z.infer<typeof SizeInput>;

/** Cached per-product fit profile written by the product read (brief §5). */
export const FitProfile = z.object({
  category: z.enum(["top", "bottom", "dress", "outerwear", "set"]),
  fit: z.enum(["slim", "regular", "relaxed", "oversized"]),
  stretch: z.enum(["none", "low", "medium", "high"]),
  length_note: z.string().max(200),
  sizes_sold: z.array(z.string().min(1).max(10)).min(1),
  notes: z.string().max(400),
});
export type FitProfile = z.infer<typeof FitProfile>;

/** Size model output. Confidence is never "high" (no brand size chart). */
export const SizeResult = z.object({
  recommended_size: z.string().min(1).max(10),
  alternative_size: z.string().min(1).max(10).nullable(),
  confidence: z.enum(["medium", "low"]),
  reasons: z.array(z.string().max(140)).length(2),
});
export type SizeResult = z.infer<typeof SizeResult>;

/** Anonymous aggregate widget events (brief §4). No identifiers. */
export const WidgetEvent = z.enum([
  "button_view",
  /** A shopper opened a try-on link (Instagram bio / WhatsApp), counted by our page. */
  "link_view",
  "try_on_started",
  "try_on_completed",
  "size_completed",
  "buy_click",
]);

/** Upload metadata check; bytes are checked separately by magic number. */
export const PhotoMeta = z.object({
  type: z.enum(PHOTO.acceptedMime as unknown as [string, ...string[]]),
  size: z.number().int().positive().max(PHOTO.maxBytes),
});
