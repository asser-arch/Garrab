#!/usr/bin/env node
/**
 * Called by deploy.sh when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set (GitHub secrets).
 *   plan <env> <out.json>  → writes the Worker secrets to set (token, chat id, and a fresh webhook
 *                            secret if this environment should own the bot's webhook)
 *   hook <env> <out.json>  → points the bot's webhook at this environment with that secret
 * One bot, one webhook: prod always takes it; staging takes it only while prod doesn't have it.
 * Sends a "connected" message to the chat when the webhook moves, so you can see it worked.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, env, file] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const api = `https://api${env === "prod" ? "" : `-${env}`}.garrabb.com`;
const target = `${api}/webhooks/telegram`;
const prodTarget = "https://api.garrabb.com/webhooks/telegram";

async function tg(method, body, tries = 3) {
  let r;
  for (let i = 1; ; i++) {
    try {
      r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      break;
    } catch (e) {
      // Network problem, not Telegram's answer: retry, then report it as such.
      if (i >= tries) throw Object.assign(new Error(`network: ${e.message}`), { network: true });
      await new Promise((res) => setTimeout(res, 2000 * i));
    }
  }
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

if (mode === "plan") {
  const me = await tg("getMe"); // fails fast on a wrong token
  try {
    await tg("getChat", { chat_id: chat });
  } catch (e) {
    if (e.network) {
      console.error(`::warning::Telegram unreachable (${e.message}); bot left as it was.`);
      process.exit(3);
    }
    // Telegram itself says the chat is wrong: unhook so the next good run counts as a move
    // and sends the "connected" message.
    await tg("deleteWebhook").catch(() => {});
    console.error(
      `::warning::Telegram chat ID not usable (${e.message}). Open @${me.username} in Telegram, press Start, send "hi", ` +
        `then put the number from getUpdates "chat":{"id":…} in the TELEGRAM_CHAT_ID GitHub secret.`,
    );
    process.exit(3);
  }
  const info = await tg("getWebhookInfo");
  const own = env === "prod" || info.url !== prodTarget;
  const out = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat };
  if (own) out.TELEGRAM_WEBHOOK_SECRET = randomBytes(32).toString("hex");
  writeFileSync(file, JSON.stringify(out));
  writeFileSync(`${file}.meta`, JSON.stringify({ own, moved: info.url !== target }));
  console.log(`Telegram bot @${me.username}: ${own ? "webhook → " + env : "webhook stays on prod"}`);
} else if (mode === "hook") {
  const meta = JSON.parse(readFileSync(`${file}.meta`, "utf8"));
  if (!meta.own) process.exit(0);
  const { TELEGRAM_WEBHOOK_SECRET: secret } = JSON.parse(readFileSync(file, "utf8"));
  await tg("setWebhook", { url: target, secret_token: secret, allowed_updates: ["callback_query"], drop_pending_updates: true });
  if (meta.moved) await tg("sendMessage", { chat_id: chat, text: `✅ Garrab ${env} is connected to this chat. Payment claims and alerts will arrive here.` });
  console.log(`Telegram webhook set: ${target}`);
} else {
  throw new Error("usage: telegram-connect.mjs plan|hook <env> <file>");
}
