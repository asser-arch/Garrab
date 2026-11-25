/**
 * Automatic support replies (portal chat). Answers a brand's first messages from a fixed Garrab fact
 * sheet and the brand's own status, until a person from Garrab support replies.
 *
 * Rules the bot follows (prompt) and code enforces:
 *  - It never promises refunds, discounts, custom prices, deadlines or features; it says the support
 *    team will confirm instead.
 *  - Plain text, short. The hand-off line ("Someone from Garrab's support team…") is added by code, not
 *    the model, so it's always worded exactly.
 *  - If the AI fails, a fixed message is sent instead (never nothing, never an error).
 */
import { BILLING, EXTRA_PACK, PILOT, PLANS, SETUP_FEE, SUPPORT } from "@garrab/shared/plans";
import { workerFetch } from "../lib/http.js";

export interface ChatLine {
  sender: "brand" | "bot" | "admin";
  body: string;
}

export interface BrandFacts {
  name: string;
  category: "fashion" | "home";
  status: string;
  plan: string;
  step: string;
  pilotEndsAt: string | null;
  website: string | null;
  liveProducts: number;
}

export interface SupportBot {
  readonly name: string;
  reply(facts: BrandFacts, history: ChatLine[]): Promise<{ text: string | null; costMicroUsd: number }>;
}

const egp = (piastres: number): string => `${(piastres / 100).toLocaleString("en-US")} EGP`;

export const isArabic = (s: string): boolean => /[؀-ۿ]/.test(s);

/** What Garrab is and how it works: the only facts the bot may state. Built from plans.ts. */
export function garrabFacts(): string {
  const s = PLANS.starter;
  const g = PLANS.growth;
  return [
    "Garrab is an AI try-on service for online brands (based in Egypt; prices in EGP). Shoppers upload a photo and see a preview of the product on themselves (fashion brands) or in their own room (home décor brands). Previews are AI images: a guide, not an exact photo.",
    `Free pilot: ${PILOT.days} days, ${PILOT.previews} previews, as many products as the brand wants, no card, no setup fee. Garrab sets everything up.`,
    `Plans after the pilot: ${s.name} ${egp(s.monthlyPrice)} per month with ${s.includedPreviews} previews; ${g.name} ${egp(g.monthlyPrice)} per month with ${g.includedPreviews} previews and the size finder (English and Arabic). Extra previews: ${EXTRA_PACK.previews} for ${egp(EXTRA_PACK.price)}. A one-off setup fee of ${egp(SETUP_FEE)} may apply to the first paid invoice (waived for founding brands). Prices in EGP.`,
    `Payment: InstaPay or bank transfer from the Billing page in the portal. Invoices are made ${BILLING.invoiceLeadDays} days before the due date. If unpaid, try-on keeps working for ${BILLING.graceDays} days after the due date, then pauses until payment. When previews run out, try-on pauses until the next month or an extra pack is bought; never charged on credit.`,
    "Portal tabs: Home (progress), Products (add products by hand, upload photos, CSV, choose which to test, delete or remove products), Approve (look at the test previews and approve or hide each product; nothing goes live without approval), Install & links (the website line, the brand page link for the Instagram bio, per-product links, brand logo and colour, Check installation), Results (views, previews, report), Billing (invoices, pay, extra packs, plan).",
    "Going live: once at least one product is approved, the brand's links work right away. For the button on the brand's own website, the brand pastes its one-line code before </body> (Shopify: Online Store → Themes → Edit code → theme.liquid; WordPress: a header/footer plugin such as WPCode, Footer box), and its website address must be on the account. The Try it on button then appears under Add to cart on approved products only. Brands without a website use the brand page link in their Instagram bio.",
    "Photos: shopper photos are used only to make the preview and are not stored by Garrab.",
    "Sign-in: email code or link, no password; brands stay signed in for 60 days.",
  ].join("\n");
}

export function supportPrompt(facts: BrandFacts, history: ChatLine[]): string {
  const last = history.filter((m) => m.sender === "brand").at(-1)?.body ?? "";
  const lang = isArabic(last) ? "Egyptian-friendly Modern Standard Arabic (clear, polite, simple)" : "plain, friendly English";
  return [
    "You are the automatic first reply in Garrab's support chat, talking to a brand (a shop owner) inside their Garrab portal.",
    "Answer ONLY from the facts below. If the answer is not in the facts, or the question needs a decision (refunds, discounts, custom prices, deadlines, new features, account changes, bugs), say briefly that the support team will check and answer here. Never invent facts, prices, dates or features. Never promise anything.",
    "Never say you are a person. Do not use a personal name. Do not add a closing line about the support team (it is added for you).",
    `Reply in ${lang}. Plain text only: no markdown, no asterisks, no headings. At most 90 words. Give the exact portal tab or step when it helps.`,
    "",
    "GARRAB FACTS",
    garrabFacts(),
    "",
    "THIS BRAND",
    `Name: ${facts.name}. Type: ${facts.category === "home" ? "home décor (room preview)" : "fashion (try-on on a person)"}. Account status: ${facts.status}. Plan: ${facts.plan}. Setup step: ${facts.step}.`,
    `Pilot ends: ${facts.pilotEndsAt ? facts.pilotEndsAt.slice(0, 10) : "not started"}. Website: ${facts.website ?? "none"}. Products live for try-on: ${facts.liveProducts}.`,
    "",
    "CONVERSATION (oldest first)",
    ...history.slice(-12).map((m) => `${m.sender === "brand" ? "Brand" : "Garrab"}: ${m.body.slice(0, 1200)}`),
    "",
    "Write Garrab's next reply to the brand's last message.",
  ].join("\n");
}

/** Model output → safe chat text (no markdown, no stray hand-off line, length-capped). */
export function cleanReply(text: string): string | null {
  const t = text
    .replace(/\*\*?|__|`+|^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 900);
  return t.length >= 2 ? t : null;
}

export class GeminiSupportBot implements SupportBot {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-3.5-flash",
    private readonly fetcher: typeof fetch = workerFetch,
  ) {
    this.name = `gemini:${model}`;
  }

  async reply(facts: BrandFacts, history: ChatLine[]): Promise<{ text: string | null; costMicroUsd: number }> {
    try {
      const r = await this.fetcher("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json", "Api-Revision": "2026-05-20" },
        body: JSON.stringify({
          model: this.model,
          store: false,
          generation_config: { temperature: 0.3 },
          input: [{ type: "text", text: supportPrompt(facts, history) }],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) return { text: null, costMicroUsd: 0 };
      const j = (await r.json()) as {
        steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
      };
      const text = (j.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).find((c) => c.type === "text")?.text;
      // gemini-3.5-flash: 1.50 USD / 1M in, 9.00 USD / 1M out (thinking billed as output), 18 Nov 2026
      const u = j.usage ?? {};
      const cost = Math.round((u.total_input_tokens ?? 2500) * 1.5 + ((u.total_output_tokens ?? 300) + (u.total_thought_tokens ?? 0)) * 9);
      return { text: text ? cleanReply(text) : null, costMicroUsd: cost };
    } catch {
      return { text: null, costMicroUsd: 0 };
    }
  }
}

/** Local, test and staging (fake AI): a canned answer, so the whole path runs for free. */
export class MockSupportBot implements SupportBot {
  readonly name = "mock";
  async reply(_facts: BrandFacts, history: ChatLine[]): Promise<{ text: string | null; costMicroUsd: number }> {
    const ar = isArabic(history.filter((m) => m.sender === "brand").at(-1)?.body ?? "");
    return {
      text: ar ? "(رد تجريبي) شكرًا لرسالتك. هذا رد آلي على بيئة الاختبار." : "(Test reply) Thanks for your message. This is an automatic reply on the test setup.",
      costMicroUsd: 0,
    };
  }
}

/** Sent when the AI can't answer (failure, spend cap): a plain acknowledgement. */
export function fallbackReply(ar: boolean): string {
  return ar ? `شكرًا لرسالتك، وصلتنا. ${SUPPORT.handoff.ar}` : `Thanks, we got your message. ${SUPPORT.handoff.en}`;
}
