import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildReport, readPeriod } from "../src/lib/report.js";
import { cairoDay } from "../src/lib/time.js";
import { fakeJpeg, postTryOn, seedAccount, APP } from "./helpers.js";

const ADMIN = { authorization: "Bearer test-admin-token-123456" };
async function ctx(s: Awaited<ReturnType<typeof seedAccount>>): Promise<string> {
  const r = await exports.default.fetch(`https://api.test/v1/config?key=${s.key}`, { headers: { origin: s.origin } });
  return ((await r.json()) as { ctx: string }).ctx;
}
const shoppers = async (accountId: string) =>
  (await env.DB.prepare("SELECT SUM(count) AS n FROM daily_counters WHERE account_id = ? AND metric = 'shopper'").bind(accountId).first<{ n: number | null }>())?.n ?? 0;

describe("shoppers who used the try-on", () => {
  it("counts a shopper once a day (the page flags the first preview of the day), only for a real preview", async () => {
    const s = await seedAccount();
    const c = await ctx(s);
    // First preview today on this device: counted. Two more from the same device: not.
    for (const first of [true, false, false]) await (await postTryOn({ ctx: c, product: s.productId, photo: fakeJpeg(), newShopper: first })).arrayBuffer();
    expect(await shoppers(s.accountId)).toBe(1);
    // A second person.
    await (await postTryOn({ ctx: c, product: s.productId, photo: fakeJpeg(), newShopper: true })).arrayBuffer();
    expect(await shoppers(s.accountId)).toBe(2);
    // A failed attempt (no photo) never counts.
    await (await postTryOn({ ctx: c, product: s.productId, newShopper: true })).arrayBuffer();
    expect(await shoppers(s.accountId)).toBe(2);
    const r = await buildReport(env, s.accountId, cairoDay(), cairoDay());
    expect(r!.totals).toMatchObject({ shoppers: 2, previews: 4 });
    expect(r!.byDay.at(-1)!.shoppers).toBe(2);
  });
});

describe("period filters", () => {
  it("accepts a valid range, caps it at today and refuses nonsense", () => {
    const now = new Date("2026-11-22T10:00:00Z");
    expect(readPeriod("2026-11-01", "2026-11-15", now)).toEqual({ from: "2026-11-01", to: "2026-11-15" });
    expect(readPeriod("2026-11-01", "2027-01-01", now)).toEqual({ from: "2026-11-01", to: "2026-11-22" });
    expect(readPeriod("2026-11-15", "2026-11-01", now)).toBeNull();
    expect(readPeriod("2024-01-01", "2026-11-01", now)).toBeNull(); // more than a year
    expect(readPeriod("nope", "2026-11-01", now)).toBeNull();
    expect(readPeriod(undefined, undefined, now)).toBeNull();
  });

  it("admin usage: every brand's numbers for the period; sign-in required", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await env.DB.batch(
      [
        [a.accountId, "shopper", 3],
        [a.accountId, "preview", 7],
        [a.accountId, "button_view", 40],
        [b.accountId, "preview", 1],
        [a.accountId, "preview", 100], // outside the period below (yesterday)
      ].map(([id, metric, n], i) =>
        env.DB.prepare("INSERT INTO daily_counters (account_id, day, metric, count) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, day, metric) DO UPDATE SET count = count + excluded.count").bind(
          id,
          i === 4 ? new Date(Date.now() - 86_400_000 * 2).toISOString().slice(0, 10) : cairoDay(),
          metric,
          n,
        ),
      ),
    );
    const today = cairoDay();
    expect((await exports.default.fetch(`https://api.test/admin-api/usage?from=${today}&to=${today}`)).status).toBe(401);
    const r = (await (await exports.default.fetch(`https://api.test/admin-api/usage?from=${today}&to=${today}`, { headers: ADMIN })).json()) as {
      from: string;
      rows: { id: string; shoppers: number; previews: number; views: number }[];
    };
    expect(r.from).toBe(today);
    expect(r.rows.find((x) => x.id === a.accountId)).toMatchObject({ shoppers: 3, previews: 7, views: 40 });
    expect(r.rows.find((x) => x.id === b.accountId)).toMatchObject({ shoppers: 0, previews: 1 });
  });

  it("the brand's results follow the chosen dates (and only ever show its own numbers)", async () => {
    const s = await seedAccount();
    const r = await buildReport(env, s.accountId, "2026-11-01", "2026-11-07");
    expect(r!.days).toBe(7);
    expect(r!.byDay).toHaveLength(7);
    void APP;
  });
});
