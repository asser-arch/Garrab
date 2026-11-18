import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORT } from "@garrab/shared/plans";
import { createAccount } from "../src/lib/accounts.js";
import { setSupportBotForTests } from "../src/lib/support.js";
import { cleanReply, supportPrompt, type SupportBot } from "../src/providers/support.js";
import { cairoDay } from "../src/lib/time.js";

const APP = "https://app.test";
const ADMIN = { authorization: "Bearer test-admin-token-123456" };
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function outbox(to: string): Promise<{ subject: string; html: string }[]> {
  return (await env.DB.prepare("SELECT subject, html FROM dev_outbox WHERE to_addr = ? ORDER BY created_at, id").bind(to).all<{ subject: string; html: string }>()).results;
}

async function brand(): Promise<{ id: string; email: string; cookie: string }> {
  const email = `chat-${uniq()}@x.example`;
  const { accountId } = await createAccount(env, { brandName: `Chat ${uniq()}`, email, plan: "starter" });
  await exports.default.fetch("https://api.test/portal-api/auth/request", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const token = /#t=([A-Za-z0-9]{40})/.exec((await outbox(email)).at(-1)!.html)![1]!;
  const r = await exports.default.fetch("https://api.test/portal-api/auth/verify", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ token }) });
  return { id: accountId, email, cookie: r.headers.get("set-cookie")!.split(";")[0]! };
}

const say = (cookie: string, body: string) =>
  exports.default.fetch("https://api.test/portal-api/support", { method: "POST", headers: { cookie, origin: APP, "content-type": "application/json" }, body: JSON.stringify({ body }) });
const read = async (cookie: string) =>
  ((await (await exports.default.fetch("https://api.test/portal-api/support", { headers: { cookie } })).json()) as { messages: { from: string; body: string }[] }).messages;
const unread = async (cookie: string) => ((await (await exports.default.fetch("https://api.test/portal-api/support/unread", { headers: { cookie } })).json()) as { unread: number }).unread;
const adminReply = (id: string, body: string) =>
  exports.default.fetch(`https://api.test/admin-api/support/${id}`, { method: "POST", headers: { ...ADMIN, "content-type": "application/json" }, body: JSON.stringify({ body }) });

afterEach(() => setSupportBotForTests(null));

describe("support chat", () => {
  it("answers automatically up to 3 times, with the hand-off line on the first and last reply", async () => {
    const b = await brand();
    const replies: string[] = [];
    for (const q of ["How do I add products?", "And the bio link?", "How do I pay?", "One more thing"]) {
      const r = (await (await say(b.cookie, q)).json()) as { messages: { from: string; body: string }[] };
      expect(r.messages[0]).toMatchObject({ from: "you", body: q });
      if (r.messages[1]) replies.push(r.messages[1].body);
      expect(r.messages[1]?.from ?? "auto").toBe("auto");
    }
    expect(replies).toHaveLength(SUPPORT.botReplies);
    expect(replies[0]).toContain(SUPPORT.handoff.en);
    expect(replies[1]).not.toContain(SUPPORT.handoff.en);
    expect(replies[2]).toContain(SUPPORT.handoff.en);
    expect(replies.join(" ")).not.toMatch(/Asser/);
    expect(await read(b.cookie)).toHaveLength(7);
    // Logged as an AI call (kind support), so it counts toward the daily spend cap.
    const u = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ? AND kind = 'support'").bind(b.id).first<{ n: number }>();
    expect(u?.n).toBe(3);
  });

  it("Arabic message → Arabic hand-off line", async () => {
    const b = await brand();
    const r = (await (await say(b.cookie, "إزاي أضيف منتجات؟")).json()) as { messages: { body: string }[] };
    expect(r.messages[1]!.body).toContain(SUPPORT.handoff.ar);
  });

  it("once Garrab support replies, the bot stops and the brand gets an email and an unread badge", async () => {
    const b = await brand();
    await say(b.cookie, "Hello");
    expect(await unread(b.cookie)).toBe(0); // the auto reply came back in the same request
    const r = await adminReply(b.id, "Hi! I'll set your products up today.");
    expect(r.status).toBe(200);
    expect(await unread(b.cookie)).toBe(1);
    const mails = await outbox(b.email);
    expect(mails.at(-1)!.subject).toBe("Garrab support replied");
    expect(mails.at(-1)!.html).toContain("set your products up today");
    // Brand writes again: no automatic answer now, a person is on it.
    const again = (await (await say(b.cookie, "Thanks!")).json()) as { messages: unknown[] };
    expect(again.messages).toHaveLength(1);
    const list = await read(b.cookie);
    expect(list.map((m) => m.from)).toEqual(["you", "auto", "support", "you"]);
    expect(await unread(b.cookie)).toBe(0); // opening the chat marks it seen
    // A second reply within half an hour: no second email.
    await adminReply(b.id, "You're welcome.");
    expect((await outbox(b.email)).filter((m) => m.subject === "Garrab support replied")).toHaveLength(1);
  });

  it("the admin inbox shows who is waiting", async () => {
    const b = await brand();
    await say(b.cookie, "Is my link live?");
    let t = (await (await exports.default.fetch("https://api.test/admin-api/support", { headers: ADMIN })).json()) as { threads: { accountId: string; waiting: boolean; lastSender: string }[] };
    expect(t.threads.find((x) => x.accountId === b.id)).toMatchObject({ waiting: true, lastSender: "bot" });
    await adminReply(b.id, "Yes it is.");
    t = (await (await exports.default.fetch("https://api.test/admin-api/support", { headers: ADMIN })).json()) as typeof t;
    expect(t.threads.find((x) => x.accountId === b.id)).toMatchObject({ waiting: false, lastSender: "admin" });
    expect((await exports.default.fetch("https://api.test/admin-api/support")).status).toBe(401);
  });

  it("if the AI fails, the first reply is a plain acknowledgement and later ones are skipped", async () => {
    setSupportBotForTests({ name: "broken", reply: async () => ({ text: null, costMicroUsd: 0 }) } satisfies SupportBot);
    const b = await brand();
    const first = (await (await say(b.cookie, "Help")).json()) as { messages: { body: string }[] };
    expect(first.messages[1]!.body).toBe(`Thanks, we got your message. ${SUPPORT.handoff.en}`);
    const second = (await (await say(b.cookie, "Hello?")).json()) as { messages: unknown[] };
    expect(second.messages).toHaveLength(1);
  });

  it("past the global daily AI cap, no AI call is made", async () => {
    let calls = 0;
    setSupportBotForTests({ name: "count", reply: async () => (calls++, { text: "x", costMicroUsd: 0 }) });
    await env.DB.prepare(
      "INSERT INTO daily_counters (account_id, day, metric, count) VALUES ('*', ?, 'spend_micro_usd', 999000000000) ON CONFLICT(account_id, day, metric) DO UPDATE SET count = excluded.count",
    )
      .bind(cairoDay())
      .run();
    try {
      const b = await brand();
      const r = (await (await say(b.cookie, "Hi")).json()) as { messages: { body: string }[] };
      expect(calls).toBe(0);
      expect(r.messages[1]!.body).toContain(SUPPORT.handoff.en);
    } finally {
      await env.DB.prepare("DELETE FROM daily_counters WHERE account_id = '*' AND day = ?").bind(cairoDay()).run();
    }
  });

  it("brands only see their own chat, and messages are validated", async () => {
    const a = await brand();
    const b = await brand();
    await say(a.cookie, "secret question from A");
    expect((await read(b.cookie)).some((m) => m.body.includes("secret"))).toBe(false);
    expect((await say(a.cookie, "   ")).status).toBe(400);
    expect((await say(a.cookie, "x".repeat(SUPPORT.maxMessageChars + 1))).status).toBe(400);
    expect((await exports.default.fetch("https://api.test/portal-api/support")).status).toBe(401);
  });

  it("deleting a brand deletes its chat", async () => {
    const b = await brand();
    await say(b.cookie, "bye");
    const name = (await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(b.id).first<{ name: string }>())!.name;
    const r = await exports.default.fetch(`https://api.test/admin-api/accounts/${b.id}/delete`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ confirmName: name, reason: "test cleanup" }),
    });
    expect(r.status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE account_id = ?").bind(b.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("support bot prompt", () => {
  it("states Garrab's real prices, forbids promises, and cleans markdown", () => {
    const p = supportPrompt(
      { name: "Noor", category: "fashion", status: "pilot", plan: "Founding pilot", step: "Live", pilotEndsAt: "2026-12-01T00:00:00Z", website: null, liveProducts: 4 },
      [{ sender: "brand", body: "كم السعر؟" }],
    );
    expect(p).toContain("5,000 EGP");
    expect(p).toContain("8,500 EGP");
    expect(p).toMatch(/Never promise/);
    expect(p).toMatch(/Arabic/);
    expect(p).toContain("2026-12-01");
    expect(cleanReply("**Go to** `Products`\n\n\n\n# then")).toBe("Go to Products\n\nthen");
  });
});
