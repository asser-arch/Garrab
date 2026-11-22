/**
 * Results report (Phase 4): anonymous daily counts only. Used by the portal Results page,
 * the admin, and the branded pilot report emails (day 10 and day 14).
 *
 * Sources: daily_counters metrics `button_view` (website), `link_view` (try-on links),
 * `try_on_started`, `preview` (counted on the server), `buy_click`; each also per product as `<metric>@<productId>`.
 */
import type { Env } from "../env.js";
import { cairoDay } from "./time.js";

export interface ReportTotals {
  /** People who got a preview, each counted once a day (no ID: a date kept on their device). */
  shoppers: number;
  views: number;
  started: number;
  previews: number;
  buys: number;
}
export interface ReportProduct extends Omit<ReportTotals, "shoppers"> {
  id: string;
  title: string;
  image: string | null;
}
export interface Report {
  brand: string;
  from: string;
  to: string;
  days: number;
  totals: ReportTotals;
  /** Previews created per day (oldest first), for the chart. */
  byDay: { day: string; previews: number; views: number; shoppers: number }[];
  products: ReportProduct[];
  /** Percentages, rounded; null when there's nothing to divide by. */
  rates: { tryRate: number | null; buyRate: number | null };
  pilot: { startedAt: string | null; endsAt: string | null } | null;
}

const METRICS = ["button_view", "link_view", "try_on_started", "preview", "buy_click", "shopper"] as const;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : null);

/** The report for one brand between two Cairo days (inclusive). */
export async function buildReport(env: Env, accountId: string, from: string, to: string = cairoDay()): Promise<Report | null> {
  const acc = await env.DB.prepare("SELECT name, pilot_started_at, pilot_ends_at FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ name: string; pilot_started_at: string | null; pilot_ends_at: string | null }>();
  if (!acc) return null;
  const rows = await env.DB.prepare("SELECT day, metric, count FROM daily_counters WHERE account_id = ? AND day >= ? AND day <= ?")
    .bind(accountId, from, to)
    .all<{ day: string; metric: string; count: number }>();

  const totals: Record<string, number> = {};
  const perDay = new Map<string, { previews: number; views: number; shoppers: number }>();
  const perProduct = new Map<string, Record<string, number>>();
  for (const r of rows.results) {
    const [metric, pid] = r.metric.split("@") as [string, string | undefined];
    if (!(METRICS as readonly string[]).includes(metric)) continue;
    if (pid) {
      const p = perProduct.get(pid) ?? {};
      p[metric] = (p[metric] ?? 0) + r.count;
      perProduct.set(pid, p);
      continue;
    }
    totals[metric] = (totals[metric] ?? 0) + r.count;
    const d = perDay.get(r.day) ?? { previews: 0, views: 0, shoppers: 0 };
    if (metric === "preview") d.previews += r.count;
    if (metric === "shopper") d.shoppers += r.count;
    if (metric === "button_view" || metric === "link_view") d.views += r.count;
    perDay.set(r.day, d);
  }

  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  const byDay = Array.from({ length: days }, (_, i) => {
    const day = addDays(from, i);
    return { day, ...(perDay.get(day) ?? { previews: 0, views: 0, shoppers: 0 }) };
  });

  const ids = [...perProduct.keys()];
  const info = new Map<string, { title: string; image: string | null }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await env.DB.prepare(`SELECT id, title, images_json FROM products WHERE account_id = ? AND id IN (${chunk.map(() => "?").join(",")})`)
      .bind(accountId, ...chunk)
      .all<{ id: string; title: string; images_json: string }>();
    for (const p of r.results) info.set(p.id, { title: p.title, image: (JSON.parse(p.images_json) as string[])[0] ?? null });
  }
  const products: ReportProduct[] = ids
    .filter((id) => info.has(id))
    .map((id) => {
      const m = perProduct.get(id)!;
      return {
        id,
        ...info.get(id)!,
        views: (m.button_view ?? 0) + (m.link_view ?? 0),
        started: m.try_on_started ?? 0,
        previews: m.preview ?? 0,
        buys: m.buy_click ?? 0,
      };
    })
    .sort((a, b) => b.previews - a.previews || b.buys - a.buys || b.views - a.views);

  const t: ReportTotals = {
    shoppers: totals.shopper ?? 0,
    views: (totals.button_view ?? 0) + (totals.link_view ?? 0),
    started: totals.try_on_started ?? 0,
    previews: totals.preview ?? 0,
    buys: totals.buy_click ?? 0,
  };
  return {
    brand: acc.name,
    from,
    to,
    days,
    totals: t,
    byDay,
    products,
    rates: { tryRate: pct(t.started, t.views), buyRate: pct(t.buys, t.previews) },
    pilot: acc.pilot_started_at ? { startedAt: acc.pilot_started_at, endsAt: acc.pilot_ends_at } : null,
  };
}

/** The default period: the pilot so far (pilot brands) or the last 30 days. */
export async function defaultPeriod(env: Env, accountId: string, now = new Date()): Promise<{ from: string; to: string }> {
  const a = await env.DB.prepare("SELECT status, pilot_started_at FROM accounts WHERE id = ?").bind(accountId).first<{ status: string; pilot_started_at: string | null }>();
  const to = cairoDay(now);
  if (a?.status === "pilot" && a.pilot_started_at) return { from: cairoDay(new Date(a.pilot_started_at)), to };
  return { from: addDays(to, -29), to };
}

/**
 * A date range from a filter (?from=YYYY-MM-DD&to=YYYY-MM-DD, Cairo days, inclusive). null if either is
 * missing or invalid. "to" is capped at today; at most 366 days.
 */
export function readPeriod(from: string | undefined, to: string | undefined, now = new Date()): { from: string; to: string } | null {
  const ok = (d: string | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!ok(from) || !ok(to)) return null;
  const today = cairoDay(now);
  const end = to > today ? today : to;
  if (from > end) return null;
  if (Date.parse(end) - Date.parse(from) > 365 * 86_400_000) return null;
  return { from, to: end };
}
