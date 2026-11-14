/**
 * The account status machine (brief §7):
 *   onboarding → pilot → active → past_due → suspended → archived
 *   + paused (Asser, by hand) + cancelled (brand, at period end) + expired (pilot not converted)
 *
 * `naturalStatus()` derives where an account SHOULD be from the ledger (paid_through, pilot dates,
 * pending payment claims). The daily billing run moves accounts there; payments move them there;
 * admin Restore moves them there. Admin Kill/Pause sets `manual_hold`, which nothing automatic lifts.
 */
import { BILLING } from "@garrab/shared/plans";
import type { AccountStatus } from "@garrab/shared";
import { daysBetween } from "./dates.js";

export const ALLOWED: Record<AccountStatus, readonly AccountStatus[]> = {
  onboarding: ["pilot", "active", "paused", "cancelled"],
  pilot: ["active", "expired", "paused", "cancelled", "suspended"],
  active: ["past_due", "paused", "cancelled", "suspended"],
  past_due: ["active", "suspended", "paused", "cancelled"],
  suspended: ["active", "past_due", "pilot", "expired", "cancelled", "archived", "paused"],
  archived: ["active"],
  expired: ["active", "pilot", "archived", "paused"], // pilot: an "I've paid" claim holds the switch-off
  paused: ["onboarding", "pilot", "active", "past_due", "suspended", "archived", "expired", "cancelled"],
  cancelled: ["active", "archived", "paused"],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export interface LedgerFacts {
  status: AccountStatus;
  paid_through: string | null;
  pilot_started_at: string | null;
  pilot_ends_at: string | null;
  cancel_at_period_end: number;
  /** A pending "I've paid" claim whose hold has not run out. */
  claimHold: boolean;
}

/** Where the ledger says the account should be today (Cairo date) at `now`. */
export function naturalStatus(f: LedgerFacts, today: string, now: Date): AccountStatus {
  const grace = BILLING.graceDays;
  const archiveAfter = BILLING.archiveAfterDays;

  if (f.paid_through) {
    if (today <= f.paid_through) return "active";
    if (f.cancel_at_period_end) return "cancelled";
    const late = daysBetween(f.paid_through, today);
    if (late <= grace || f.claimHold) return "past_due";
    if (late <= grace + archiveAfter) return "suspended";
    return "archived";
  }

  // Never paid: still onboarding, in the pilot, or the pilot ran out.
  if (!f.pilot_started_at || !f.pilot_ends_at) return f.status === "paused" ? "onboarding" : f.status;
  if (f.cancel_at_period_end && now.getTime() > Date.parse(f.pilot_ends_at)) return "cancelled";
  const graceEnd = Date.parse(f.pilot_ends_at) + grace * 86_400_000;
  if (now.getTime() <= graceEnd || f.claimHold) return "pilot";
  if (now.getTime() <= graceEnd + archiveAfter * 86_400_000) return "expired";
  return "archived";
}
