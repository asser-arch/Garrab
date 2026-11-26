import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkGoogleBalance, googleBalance } from "../src/lib/googleBalance.js";
import { ulid } from "../src/lib/crypto.js";

const ADMIN = { authorization: "Bearer test-admin-token-123456", "content-type": "application/json" };
const use = (provider: string, micro: number, at = new Date().toISOString()) =>
  env.DB.prepare("INSERT INTO usage_events (id, account_id, kind, provider, ok, cost_micro_usd, created_at) VALUES (?, 'x', 'tryon', ?, 1, ?, ?)").bind(ulid(), provider, micro, at).run();

describe("Google balance (estimate)", () => {
  it("counts down from the balance you enter with Google AI calls only, and alerts once when low", async () => {
    await env.DB.prepare("DELETE FROM usage_events").run();
    await use("gemini:gemini-nano-banana-2.1", 5_000_000, "2020-01-01T00:00:00Z"); // before the balance: ignored
    const r = await exports.default.fetch("https://api.test/admin-api/settings", { method: "POST", headers: ADMIN, body: JSON.stringify({ googleBalanceUsd: 20 }) });
    expect(r.status).toBe(200);
    await use("gemini:gemini-nano-banana-2.1", 4_000_000);
    await use("gemini:gemini-3.5-flash", 1_500_000);
    await use("genlook", 9_000_000); // not Google
    const g = (await googleBalance(env))!;
    expect(g).toMatchObject({ setUsd: 20, spentUsd: 5.5, leftUsd: 14.5 });
    const d = (await (await exports.default.fetch("https://api.test/admin-api/dashboard", { headers: ADMIN })).json()) as { googleBalance: { leftUsd: number } };
    expect(d.googleBalance.leftUsd).toBe(14.5);

    await checkGoogleBalance(env);
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'google_balance'").first<{ n: number }>())!.n;
    const before = await count();
    await use("gemini:gemini-nano-banana-2.1", 6_000_000); // 8.50 left: low
    await checkGoogleBalance(env);
    await checkGoogleBalance(env);
    expect((await count()) - before).toBe(1); // once per balance entry
  });
});
