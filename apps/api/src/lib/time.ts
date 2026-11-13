import { TIMEZONE } from "@garrab/shared/plans";

/** Calendar date (YYYY-MM-DD) in Africa/Cairo. Handles Egyptian summer time via Intl. */
export function cairoDay(d = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Hour and minute in Africa/Cairo. */
export function cairoClock(d = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { hour: get("hour"), minute: get("minute") };
}

export function nowIso(): string {
  return new Date().toISOString();
}
