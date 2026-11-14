/**
 * Connect your Telegram bot to Garrab (one time per environment):
 *
 *   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_WEBHOOK_SECRET=<same value as the Worker secret> \
 *     pnpm --filter @garrab/api telegram:webhook -- https://api.<your-domain>
 *
 * Tells Telegram to deliver button presses to <api>/webhooks/telegram with our secret in the
 * X-Telegram-Bot-Api-Secret-Token header (core.telegram.org/bots/api#setwebhook).
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const api = process.argv.filter((a) => a !== "--").at(2);
if (!token || !secret || !api) {
  console.error("Usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… telegram:webhook -- https://api.<domain>");
  process.exit(2);
}
const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: `${api.replace(/\/$/, "")}/webhooks/telegram`, secret_token: secret, allowed_updates: ["callback_query"] }),
});
console.log(await r.text());
