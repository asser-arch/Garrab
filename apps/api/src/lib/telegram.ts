/**
 * Telegram Bot API (core.telegram.org/bots/api, Bot API 10.4, checked 14 Nov 2026):
 * sendMessage with an inline keyboard, answerCallbackQuery, editMessageText.
 * Webhooks carry our secret in the X-Telegram-Bot-Api-Secret-Token header (set via setWebhook).
 * callback_data is limited to 1–64 bytes.
 */
import { isLocal, type Env } from "../env.js";
import { hmacSign } from "./crypto.js";
import { log } from "./log.js";

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

async function call(env: Env, method: string, body: unknown): Promise<unknown> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    log("telegram_skipped", { kind: method });
    return null;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    log("telegram_failed", { kind: method });
    return null;
  }
}

/** Staging posts to the same chat as live: label it so the two are never confused. */
export function envLabel(env: Env): string {
  return env.ENVIRONMENT === "prod" ? "" : `[${env.ENVIRONMENT === "staging" ? "Staging" : env.ENVIRONMENT}] `;
}

export async function sendTelegram(env: Env, text: string, buttons: Button[][] = []): Promise<void> {
  if (!env.TELEGRAM_CHAT_ID) return;
  await call(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: envLabel(env) + text,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export async function answerCallback(env: Env, callbackQueryId: string, text: string): Promise<void> {
  await call(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

export async function editMessage(env: Env, chatId: number | string, messageId: number, text: string): Promise<void> {
  await call(env, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

function callbackKey(env: Env): string {
  if (env.TELEGRAM_CALLBACK_KEY && env.TELEGRAM_CALLBACK_KEY.length >= 32) return env.TELEGRAM_CALLBACK_KEY;
  if (isLocal(env)) return "dev-only-telegram-callback-key-not-for-prod";
  throw new Error("TELEGRAM_CALLBACK_KEY missing");
}

/** Signed button payload, e.g. "pc:<claimId>:a:<sig>" (≤ 64 bytes). Only buttons we sent can act. */
export async function signCallback(env: Env, kind: string, id: string, action: string): Promise<string> {
  const body = `${kind}:${id}:${action}`;
  return `${body}:${(await hmacSign(callbackKey(env), body)).slice(0, 12)}`;
}

export async function verifyCallback(env: Env, data: string): Promise<{ kind: string; id: string; action: string } | null> {
  const parts = data.split(":");
  if (parts.length !== 4) return null;
  const [kind, id, action, sig] = parts as [string, string, string, string];
  const expected = (await hmacSign(callbackKey(env), `${kind}:${id}:${action}`)).slice(0, 12);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { kind, id, action } : null;
}
