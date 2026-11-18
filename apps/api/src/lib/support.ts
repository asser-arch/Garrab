/**
 * Support chat: one conversation per brand. Brand writes in the portal, Garrab support answers in the
 * admin. Until a person answers, the bot replies (at most SUPPORT.botReplies times per conversation).
 */
import { CAPS, PLANS, SUPPORT, type PlanId } from "@garrab/shared/plans";
import { isLocal, type Env } from "../env.js";
import { ulid } from "./crypto.js";
import { recordUsage } from "./metering.js";
import { getSetting } from "./db.js";
import { cairoDay } from "./time.js";
import { appFetch } from "./products.js";
import { sendTelegram } from "./telegram.js";
import { GeminiSupportBot, MockSupportBot, fallbackReply, isArabic, type BrandFacts, type ChatLine, type SupportBot } from "../providers/support.js";
import { STEP_LABEL, type Step } from "../onboarding/machine.js";
import type { AccountRow } from "./db.js";

export interface SupportMessage {
  id: string;
  sender: "brand" | "bot" | "admin";
  body: string;
  created_at: string;
}

let override: SupportBot | null = null;
/** Tests only: use this bot instead of the configured one. */
export function setSupportBotForTests(bot: SupportBot | null): void {
  override = bot;
}

export function supportBot(env: Env): SupportBot {
  if (override) return override;
  if (env.AI_MOCK === "true" && env.ENVIRONMENT !== "prod") return new MockSupportBot();
  if (env.GEMINI_API_KEY && env.ENVIRONMENT !== "test") return new GeminiSupportBot(env.GEMINI_API_KEY, "gemini-3.5-flash", appFetch(env));
  if (isLocal(env) || env.ENVIRONMENT === "test") return new MockSupportBot();
  throw new Error("GEMINI_API_KEY missing");
}

const hoursAgo = (h: number, now = Date.now()): string => new Date(now - h * 3_600_000).toISOString();

export async function messages(env: Env, accountId: string, limit = 200): Promise<SupportMessage[]> {
  const r = await env.DB.prepare(
    "SELECT id, sender, body, created_at FROM (SELECT * FROM support_messages WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at, id",
  )
    .bind(accountId, limit)
    .all<SupportMessage>();
  return r.results;
}

async function insert(env: Env, accountId: string, sender: SupportMessage["sender"], body: string): Promise<SupportMessage> {
  const m = { id: ulid(), sender, body, created_at: new Date().toISOString() };
  await env.DB.prepare("INSERT INTO support_messages (id, account_id, sender, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(m.id, accountId, sender, body, m.created_at)
    .run();
  return m;
}

/**
 * Should the bot answer now, and is this its first or last reply of the conversation?
 * - A person from Garrab replied in the last few hours → no (they're handling it).
 * - The bot already answered SUPPORT.botReplies times since the last person reply (within the
 *   conversation window) → no.
 */
export async function botTurn(env: Env, accountId: string, now = Date.now()): Promise<{ answer: boolean; first: boolean; last: boolean }> {
  const r = await env.DB.prepare(
    `SELECT (SELECT MAX(created_at) FROM support_messages WHERE account_id = ?1 AND sender = 'admin') AS last_admin`,
  )
    .bind(accountId)
    .first<{ last_admin: string | null }>();
  const lastAdmin = r?.last_admin ?? null;
  if (lastAdmin && lastAdmin > hoursAgo(SUPPORT.quietHoursAfterReply, now)) return { answer: false, first: false, last: false };
  const since = [lastAdmin ?? "", hoursAgo(SUPPORT.newConversationHours, now)].sort().at(-1)!;
  const bots = await env.DB.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE account_id = ? AND sender = 'bot' AND created_at > ?")
    .bind(accountId, since)
    .first<{ n: number }>();
  const n = bots?.n ?? 0;
  return { answer: n < SUPPORT.botReplies, first: n === 0, last: n === SUPPORT.botReplies - 1 };
}

async function brandFacts(env: Env, account: AccountRow): Promise<BrandFacts> {
  const a = await env.DB.prepare("SELECT name, category, status, plan_id, target_plan_id, onboarding_step, pilot_ends_at, website FROM accounts WHERE id = ?")
    .bind(account.id)
    .first<{ name: string; category: "fashion" | "home"; status: string; plan_id: PlanId; target_plan_id: PlanId | null; onboarding_step: Step; pilot_ends_at: string | null; website: string | null }>();
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE account_id = ? AND enabled = 1 AND approved = 1").bind(account.id).first<{ n: number }>();
  return {
    name: a?.name ?? account.name,
    category: a?.category ?? "fashion",
    status: a?.status ?? account.status,
    plan: a ? `${PLANS[a.plan_id].name}${a.plan_id === "pilot" && a.target_plan_id ? ` (then ${PLANS[a.target_plan_id].name})` : ""}` : "",
    step: a ? (STEP_LABEL[a.onboarding_step] ?? a.onboarding_step) : "",
    pilotEndsAt: a?.pilot_ends_at ?? null,
    website: a?.website ?? null,
    liveProducts: live?.n ?? 0,
  };
}

/** Global daily AI spend cap (the same one as try-ons). Only checked, never switches try-on off. */
async function underGlobalCap(env: Env): Promise<boolean> {
  const capUsd = await getSetting<number>(env, "global_daily_cap_usd", CAPS.globalDailyUsd);
  const spent = await env.DB.prepare("SELECT count FROM daily_counters WHERE account_id = '*' AND day = ? AND metric = 'spend_micro_usd'")
    .bind(cairoDay())
    .first<{ count: number }>();
  return (spent?.count ?? 0) < capUsd * 1_000_000;
}

/** A brand's message: store it, tell Garrab support, and let the bot answer if it's still its turn. */
export async function brandWrites(env: Env, account: AccountRow, body: string): Promise<SupportMessage[]> {
  const turn = await botTurn(env, account.id);
  const mine = await insert(env, account.id, "brand", body);
  const out = [mine];
  if (turn.answer) {
    const ar = isArabic(body);
    const history: ChatLine[] = (await messages(env, account.id, 20)).map((m) => ({ sender: m.sender, body: m.body }));
    let text: string | null = null;
    // The spend cap covers support replies too; past it, the plain acknowledgement goes out instead.
    if (await underGlobalCap(env)) {
      const bot = supportBot(env);
      const r = await bot.reply(await brandFacts(env, account), history);
      await recordUsage(env, account.id, "support", bot.name, r.text !== null, r.costMicroUsd, r.text === null ? "no_answer" : null);
      text = r.text;
    }
    const handoff = ar ? SUPPORT.handoff.ar : SUPPORT.handoff.en;
    const reply = text === null ? (turn.first ? fallbackReply(ar) : null) : turn.first || turn.last ? `${text}\n\n${handoff}` : text;
    if (reply) out.push(await insert(env, account.id, "bot", reply));
  }
  const link = env.ADMIN_ORIGIN ? `${env.ADMIN_ORIGIN}/#support=${account.id}` : null;
  await sendTelegram(
    env,
    `💬 ${account.name}: ${body.slice(0, 600)}${out.length > 1 ? "\n\n(Answered automatically. Reply in the admin to take over.)" : ""}`,
    link ? [[{ text: "Open chat", url: link }]] : [],
  );
  return out;
}

export async function adminWrites(env: Env, accountId: string, body: string): Promise<SupportMessage> {
  return insert(env, accountId, "admin", body);
}

/** Replies the brand hasn't seen yet (Garrab support and bot messages after it last opened the chat). */
export async function brandUnread(env: Env, accountId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM support_messages WHERE account_id = ?1 AND sender != 'brand'
       AND created_at > COALESCE((SELECT brand_seen_at FROM support_seen WHERE account_id = ?1), '')`,
  )
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function markBrandSeen(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO support_seen (account_id, brand_seen_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET brand_seen_at = excluded.brand_seen_at",
  )
    .bind(accountId, new Date().toISOString())
    .run();
}

/** Conversations for the admin, newest first. "waiting" = the brand wrote after Garrab support last replied. */
export async function threads(env: Env): Promise<
  { accountId: string; name: string; lastAt: string; lastSender: string; lastBody: string; waiting: boolean }[]
> {
  const r = await env.DB.prepare(
    `SELECT t.account_id, a.name, t.last_at, t.last_brand, t.last_admin,
            (SELECT sender FROM support_messages m WHERE m.account_id = t.account_id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_sender,
            (SELECT body FROM support_messages m WHERE m.account_id = t.account_id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body
       FROM (SELECT account_id, MAX(created_at) AS last_at,
                    MAX(CASE WHEN sender = 'brand' THEN created_at END) AS last_brand,
                    MAX(CASE WHEN sender = 'admin' THEN created_at END) AS last_admin
               FROM support_messages GROUP BY account_id) t
       JOIN accounts a ON a.id = t.account_id
      ORDER BY t.last_at DESC LIMIT 200`,
  ).all<{ account_id: string; name: string; last_at: string; last_brand: string | null; last_admin: string | null; last_sender: string; last_body: string }>();
  return r.results.map((t) => ({
    accountId: t.account_id,
    name: t.name,
    lastAt: t.last_at,
    lastSender: t.last_sender,
    lastBody: t.last_body.slice(0, 140),
    waiting: !!t.last_brand && (!t.last_admin || t.last_brand > t.last_admin),
  }));
}
