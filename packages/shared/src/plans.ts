/**
 * THE single source of prices, limits and billing rules.
 * Never hard-code any of these values anywhere else in the codebase.
 *
 * Money is in integer piastres (1 EGP = 100 piastres) so the ledger never rounds.
 */

export const CURRENCY = "EGP" as const;
export const TIMEZONE = "Africa/Cairo" as const;

/** Convert whole EGP to piastres. */
export const egp = (pounds: number): number => Math.round(pounds * 100);

export type PlanId = "pilot" | "starter" | "growth";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** Price per billing month in piastres. 0 for the free pilot. */
  readonly monthlyPrice: number;
  /** Previews included per cycle (per month, or per pilot for the pilot). */
  readonly includedPreviews: number;
  /** Maximum products that can be live at once. null = no limit (a per-brand limit can still be set in the admin). */
  readonly maxProducts: number | null;
  /** AI size finder (English only). */
  readonly sizeFinder: boolean;
  /** Can buy extra preview packs. */
  readonly extraPacks: boolean;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  pilot: {
    id: "pilot",
    name: "Founding pilot",
    monthlyPrice: 0,
    includedPreviews: 300,
    maxProducts: 10,
    sizeFinder: false,
    extraPacks: false,
  },
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPrice: egp(5000), // Asser, 15 Nov: Pitch Deck and Pilot Proposal prices
    includedPreviews: 250,
    // Asser, 14 Nov: no product limit on paid plans; previews are the limit.
    maxProducts: null,
    sizeFinder: false,
    extraPacks: true,
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPrice: egp(8500), // Asser, 15 Nov: Pitch Deck and Pilot Proposal prices
    includedPreviews: 600,
    // Asser, 14 Nov: no product limit on paid plans; previews are the limit.
    maxProducts: null,
    sizeFinder: true,
    extraPacks: true,
  },
};

/** Plans a brand can pay for (the pilot is free and time-limited). */
export const PAID_PLAN_IDS = ["starter", "growth"] as const satisfies readonly PlanId[];
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

export const SETUP_FEE = egp(1500);

export const EXTRA_PACK = {
  previews: 100,
  price: egp(800),
} as const;

export const PILOT = {
  days: 14,
  maxProducts: PLANS.pilot.maxProducts ?? 10,
  previews: PLANS.pilot.includedPreviews,
  setupFee: 0,
  cardRequired: false,
  /** Pilot clock emails, by day number after pilot_live (day 1 = first day). */
  emailDays: { welcome: 1, checkIn: 7, report: 10, endingSoon: 12, results: 14 },
} as const;

export const BILLING = {
  /** Invoice is created this many days before the due date (= paid_through). */
  invoiceLeadDays: 7,
  /** Days after the due date during which the widget keeps working (status past_due). */
  graceDays: 5,
  /** Reminder days relative to the due date (0 = due date). */
  reminderOffsetsDays: [0, 1, 3, 5],
  /** Suspended this many days → archived. Data is also kept this long after pilot expiry. */
  archiveAfterDays: 30,
  /** Billing period length. */
  periodMonths: 1,
  /** VAT in basis points (1400 = 14%). 0 until the accountant confirms; shown only if > 0. */
  vatRateBp: 0,
  invoicePrefix: "GRB",
} as const;

export const USAGE = {
  /** Warn the brand at these fractions of included previews. */
  warnAt: [0.8, 1.0],
  /** At 100% previews pause until the next cycle or a paid extra pack. Never on credit. */
  pauseAtFraction: 1.0,
} as const;

export const CAPS = {
  /** Per-account daily cap = this multiple of the account's average daily allowance. */
  perAccountDailyMultiple: 3,
  /** How many products the automatic first pick selects for testing (also the pilot limit). */
  autoSelectProducts: 10,
  /** Global daily AI spend cap in USD. Overridable in settings. */
  globalDailyUsd: 50,
  /** Budget for automatic product quality tests, per account per rolling 30 days, in USD. */
  onboardingTestBudgetUsd: 3,
} as const;

/** Account statuses in which the widget and AI calls are allowed. */
export const SERVING_STATUSES = ["pilot", "active", "past_due"] as const;

export const TIMINGS = {
  ctxTokenMinutes: 10,
  magicLinkMinutes: 15,
  /** Brands stay signed in this long; renewed whenever they use the portal (Asser, 15 Nov). */
  portalSessionDays: 60,
  /** Wrong sign-in code attempts before that code stops working. */
  signInCodeAttempts: 5,
  /** Widget keeps /v1/config in memory at most this long (never localStorage). */
  widgetConfigTtlSeconds: 30,
  /** Per-instance server cache of account status. */
  statusCacheSeconds: 15,
  /** Onboarding step older than this → stuck detector. */
  stuckAfterHours: 48,
  /** No install detected this long after approval → reminder. */
  installReminderHours: 48,
} as const;

export const PHOTO = {
  maxBytes: 8 * 1024 * 1024,
  acceptedMime: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  /** Long side after in-browser re-encode. */
  maxSidePx: 1600,
} as const;

export function getPlan(id: PlanId): Plan {
  return PLANS[id];
}

/** Average daily allowance used for the per-account daily cap. */
export function dailyCap(plan: Plan): number {
  const days = plan.id === "pilot" ? PILOT.days : 30;
  return Math.ceil((plan.includedPreviews / days) * CAPS.perAccountDailyMultiple);
}

/** A brand's product limit: its own limit if Asser set one, else the plan's. null = no limit. */
export function productLimit(planId: PlanId, override: number | null | undefined): number | null {
  return override ?? PLANS[planId].maxProducts;
}
