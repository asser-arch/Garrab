/** Calendar-date arithmetic on YYYY-MM-DD strings (Cairo dates), with no time-zone drift. */

const toUtc = (d: string): Date => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(d: string, n: number): string {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
}

/** Adds months, clamping to the last day of the month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number): string {
  const x = toUtc(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fmt(x);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** The billing month that starts on `start`: [start, end] inclusive. */
export function periodFrom(start: string): { start: string; end: string } {
  return { start, end: addDays(addMonths(start, 1), -1) };
}
