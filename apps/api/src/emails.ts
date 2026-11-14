/**
 * Brand-facing email templates. Plain words, short, honest (brand guideline "How we sound").
 * English for now; Arabic versions follow the Pitch Kit wording.
 */
import { BILLING, PILOT, PLANS, type PlanId } from "@garrab/shared/plans";
import type { EmailMessage } from "./lib/email.js";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:#143822;color:#FCFBF8;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#F4F2EB;font-family:Cairo,Arial,sans-serif;color:#0F1A13">
<div style="max-width:520px;margin:0 auto;padding:24px">
<p style="font-weight:700;font-size:18px;margin:0 0 16px"><span style="display:inline-block;background:#143822;color:#FCFBF8;border-radius:8px;width:28px;height:28px;text-align:center;line-height:28px">G</span> Garrab</p>
<div style="background:#FCFBF8;border:1px solid #DDD6C9;border-radius:20px;padding:24px">
<h1 style="font-size:22px;font-weight:400;margin:0 0 16px">${esc(title)}</h1>
${bodyHtml}${button}
</div>
<p style="color:#8A8B84;font-size:12px">Garrab · AI try-on for Egyptian brands. A preview, not a promise.</p>
</div></body></html>`;
}

const p = (s: string): string => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${s}</p>`;

function msg(to: string, subject: string, title: string, paras: string[], cta?: { label: string; url: string }): EmailMessage {
  const html = layout(title, paras.map((x) => p(esc(x))).join(""), cta);
  const text = [title, "", ...paras, ...(cta ? ["", `${cta.label}: ${cta.url}`] : [])].join("\n");
  return { to, subject, html, text };
}

export const emails = {
  welcome: (to: string, brand: string, link: string): EmailMessage =>
    msg(
      to,
      `Welcome to Garrab, ${brand}`,
      `Welcome, ${brand}`,
      [
        "We're setting up AI try-on for your shop. Right now we're reading your products and testing how they look on our test models.",
        "Use the button below to sign in. It works once and expires in 15 minutes; you can always ask for a new one on the sign-in page.",
        "You'll approve every product before anything goes live.",
      ],
      { label: "Open my Garrab portal", url: link },
    ),

  login: (to: string, link: string): EmailMessage =>
    msg(to, "Your Garrab sign-in link", "Sign in to Garrab", ["This link works once and expires in 15 minutes. If you didn't ask for it, ignore this email."], {
      label: "Sign in",
      url: link,
    }),

  addProducts: (to: string, brand: string, portal: string): EmailMessage =>
    msg(
      to,
      "Add your products to start the pilot",
      "We couldn't read your products",
      [
        `We couldn't import products from ${brand}'s website automatically. That's normal for Instagram and WhatsApp shops.`,
        "Add up to 10 products in the portal: a name, a photo and the link where people buy it. It takes about 5 minutes.",
      ],
      { label: "Add products", url: portal },
    ),

  approve: (to: string, count: number, portal: string): EmailMessage =>
    msg(
      to,
      "Your try-on previews are ready to approve",
      "Your previews are ready",
      [
        `We tested ${count} product${count === 1 ? "" : "s"} on our test models. Have a look and tap Approve or Hide on each one.`,
        "Nothing goes live until you approve it.",
      ],
      { label: "Review previews", url: portal },
    ),

  install: (to: string, social: boolean, portal: string): EmailMessage =>
    msg(
      to,
      social ? "Your try-on links are ready" : "One last step: add Garrab to your shop",
      social ? "Your links are ready" : "Add one line to your shop",
      social
        ? ["Your try-on links and QR codes are ready to share on Instagram and WhatsApp. Your 14-day pilot starts now."]
        : ["Copy one line of code into your shop. The portal shows the exact steps for your platform, and checks that it worked."],
      { label: social ? "Get my links" : "Show me how", url: portal },
    ),

  installReminder: (to: string, portal: string): EmailMessage =>
    msg(
      to,
      "Reminder: add Garrab to your shop",
      "Your approved products are waiting",
      ["We haven't seen the Garrab line on your shop yet. It takes about 2 minutes, and the portal can check it for you."],
      { label: "Finish the install", url: portal },
    ),

  stepReminder: (to: string, step: string, portal: string): EmailMessage =>
    msg(to, "Your Garrab setup is waiting for you", "Pick up where you left off", [`Your setup is paused at: ${step}. It only takes a few minutes to finish.`], {
      label: "Continue",
      url: portal,
    }),

  pilotDay1: (to: string, portal: string, links: { hosted: string }): EmailMessage =>
    msg(
      to,
      "Your 14-day Garrab pilot has started",
      "Your pilot is live",
      [
        `For the next ${PILOT.days} days shoppers can see your products on themselves. You have ${PILOT.previews} previews for the pilot.`,
        "Tips: share your try-on link in your Instagram bio and stories, and reply to WhatsApp questions with it.",
        `Example link: ${links.hosted}`,
      ],
      { label: "See my portal", url: portal },
    ),

  pilotDay7: (to: string, used: number, views: number, portal: string): EmailMessage =>
    msg(
      to,
      "Week one of your pilot",
      "Halfway there",
      [`So far: ${views} button views and ${used} previews created.`, "Products that get shared on Instagram stories usually get the most try-ons."],
      { label: "See details", url: portal },
    ),

  pilotDay12: (to: string, plan: PlanId, payUrl: string): EmailMessage =>
    msg(
      to,
      "Your pilot ends in 2 days",
      "Keep try-on running",
      [
        `Your pilot ends in 2 days. To keep it running, the ${PLANS[plan].name} plan is ${PLANS[plan].monthlyPrice / 100} EGP a month, paid before each month. No minimum term.`,
        `If you don't continue, try-on switches off ${BILLING.graceDays} days after the pilot ends. Nothing else on your shop changes.`,
      ],
      { label: "Continue my plan", url: payUrl },
    ),

  pilotDay14: (
    to: string,
    r: { previews: number; started: number; completed: number; views: number; buys: number },
    payUrl: string,
  ): EmailMessage =>
    msg(
      to,
      "Your Garrab pilot results",
      "Your 14-day results",
      [
        `Button views: ${r.views}. Try-ons started: ${r.started}. Previews created: ${r.previews}.`,
        `Completion rate: ${r.started ? Math.round((r.completed / r.started) * 100) : 0}%. Buy clicks from the try-on page: ${r.buys}.`,
        "Now compare your add-to-cart rate and returns for these products with the two weeks before the pilot. That's the honest test.",
      ],
      { label: "Continue my plan", url: payUrl },
    ),
};
