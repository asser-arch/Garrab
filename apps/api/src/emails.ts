/**
 * Brand-facing email templates. Plain words, short, honest (brand guideline "How we sound").
 * English for now; Arabic versions follow the Pitch Kit wording.
 */
import { BILLING, COMPANY, EXTRA_PACK, PILOT, PLANS, type PlanId } from "@garrab/shared/plans";
import type { EmailMessage } from "./lib/email.js";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:#143822;color:#FCFBF8;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#F4F2EB;font-family:Cairo,Arial,sans-serif;color:#0F1A13">
<div style="max-width:520px;margin:0 auto;padding:24px">
<p style="margin:0 0 16px"><img src="${COMPANY.emailLogo}" width="93" height="36" alt="Garrab" style="display:block;border:0;outline:none;width:93px;height:36px"></p>
<div style="background:#FCFBF8;border:1px solid #DDD6C9;border-radius:20px;padding:24px">
<h1 style="font-size:22px;font-weight:400;margin:0 0 16px">${esc(title)}</h1>
${bodyHtml}${button}
</div>
<p style="color:#8A8B84;font-size:12px">Garrab · AI try-on for Egyptian brands. A preview, not a promise.<br><a href="${COMPANY.url}" style="color:#8A8B84">${COMPANY.poweredBy}</a></p>
</div></body></html>`;
}

const p = (s: string): string => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${s}</p>`;

function msg(to: string, subject: string, title: string, paras: string[], cta?: { label: string; url: string }): EmailMessage {
  const html = layout(title, paras.map((x) => p(esc(x))).join(""), cta);
  const text = [title, "", ...paras, ...(cta ? ["", `${cta.label}: ${cta.url}`] : []), "", COMPANY.poweredBy].join("\n");
  return { to, subject, html, text };
}

export const egpText = (piastres: number): string => `${(piastres / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;

export const emails = {
  welcome: (to: string, brand: string, link: string, code?: string): EmailMessage =>
    msg(
      to,
      `Welcome to Garrab, ${brand}`,
      `Welcome, ${brand}`,
      [
        "We're setting up AI try-on for your shop. Right now we're reading your products and testing how they look on our test models.",
        code
          ? `Tap the button below to sign in, or enter this code on the sign-in page: ${code.slice(0, 3)} ${code.slice(3)}. Both work once within 15 minutes; after that you stay signed in for 60 days on that device.`
          : "Tap the button below to sign in. It works once within 15 minutes; after that you stay signed in for 60 days on that device.",
        "You'll approve every product before anything goes live.",
      ],
      { label: "Open my Garrab Portal", url: link },
    ),

  login: (to: string, link: string, code?: string): EmailMessage =>
    msg(
      to,
      code ? `Your Garrab sign-in code: ${code}` : "Your Garrab sign-in link",
      "Sign in to Garrab",
      [
        code
          ? `Your code is ${code.slice(0, 3)} ${code.slice(3)}. Type it on the sign-in page, or tap the button below.`
          : "Tap the button below to sign in.",
        "It works once within 15 minutes. After that you stay signed in for 60 days on that device. If you didn't ask for it, ignore this email.",
      ],
      { label: "Sign in", url: link },
    ),

  addProducts: (to: string, brand: string, portal: string): EmailMessage =>
    msg(
      to,
      "Add your products to start the pilot",
      "We couldn't read your products",
      [
        `We couldn't import products from ${brand}'s website automatically. That's normal for Instagram and WhatsApp shops.`,
        "Add your products in the portal: a name, a photo and the link where people buy it. About a minute each.",
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
      social ? "Your try-on link is ready" : "Your try-on link is live. Next: add Garrab to your shop",
      social ? "Your link is ready" : "Your link is live",
      social
        ? ["Your try-on link is ready. Put it in your Instagram bio, or share it on WhatsApp. Your 14-day pilot starts now."]
        : [
            "Your try-on link is ready. Put it in your Instagram bio, or share it on WhatsApp. Your 14-day pilot starts now.",
            "To show the Try it on button on your website too, copy one line of code into your shop. The portal shows the exact steps for your platform, and checks that it worked.",
          ],
      { label: social ? "Get my link" : "Get my link and install steps", url: portal },
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

  // ------------------------------------------------------------------ billing

  invoice: (to: string, inv: { number: string; total: number; due: string; label: string }, payUrl: string): EmailMessage =>
    msg(
      to,
      `Invoice ${inv.number}: ${egpText(inv.total)} due ${inv.due}`,
      "Your next month of Garrab",
      [
        `${inv.label}: ${egpText(inv.total)}, due ${inv.due}.`,
        "Pay by InstaPay in about a minute. The page shows the exact steps.",
        `Try-on keeps running for ${BILLING.graceDays} days after the due date, then switches off until payment arrives.`,
      ],
      { label: "Pay now", url: payUrl },
    ),

  reminder: (to: string, inv: { number: string; total: number; due: string }, daysLate: number, payUrl: string): EmailMessage =>
    msg(
      to,
      daysLate === 0 ? `Due today: invoice ${inv.number}` : `Reminder: invoice ${inv.number} is ${daysLate} day${daysLate === 1 ? "" : "s"} late`,
      daysLate === 0 ? "Your payment is due today" : "Your payment is late",
      [
        `Invoice ${inv.number} for ${egpText(inv.total)} was due on ${inv.due}.`,
        daysLate >= BILLING.graceDays
          ? "Try-on switches off tomorrow if it isn't paid. It comes back on as soon as you pay."
          : `Try-on keeps running until ${BILLING.graceDays} days after the due date.`,
      ],
      { label: "Pay now", url: payUrl },
    ),

  suspended: (to: string, payUrl: string): EmailMessage =>
    msg(to, "Garrab try-on is switched off", "Try-on is off for now", [
      "We didn't receive this month's payment, so the try-on button and links are switched off. Nothing else on your shop changed.",
      "Pay any time and it switches back on within a minute.",
    ], { label: "Pay and switch back on", url: payUrl }),

  expired: (to: string, payUrl: string): EmailMessage =>
    msg(to, "Your Garrab pilot has ended", "Your pilot has ended", [
      "Try-on is switched off. We keep your products and settings for 30 days.",
      "Want it back? Pay the first month and it switches on again within a minute.",
    ], { label: "Continue with Garrab", url: payUrl }),

  paymentReceived: (to: string, inv: { number: string; total: number }, paidThrough: string | null, pdfUrl: string): EmailMessage =>
    msg(to, `Payment received: ${inv.number}`, "Thank you, payment received", [
      `We received ${egpText(inv.total)} for invoice ${inv.number}.`,
      ...(paidThrough ? [`Your plan is paid until ${paidThrough}.`] : ["Your extra previews are ready to use."]),
    ], { label: "Download invoice (PDF)", url: pdfUrl }),

  claimReceived: (to: string, inv: { number: string }): EmailMessage =>
    msg(to, `We're confirming your payment for ${inv.number}`, "Thanks, we're checking your transfer", [
      "We'll confirm your InstaPay transfer shortly, usually within a few hours. Try-on stays on while we check.",
    ]),

  claimRejected: (to: string, inv: { number: string }, payUrl: string): EmailMessage =>
    msg(to, `We couldn't find your transfer for ${inv.number}`, "We couldn't match your transfer", [
      "We couldn't find an InstaPay transfer matching your reference. Please check the reference in your InstaPay app and send it again, or reply to this email.",
    ], { label: "Open payment page", url: payUrl }),

  usageWarning: (to: string, pct: 80 | 100, used: number, total: number, portal: string): EmailMessage =>
    msg(
      to,
      pct === 100 ? "Previews paused: monthly limit reached" : "You've used 80% of this month's previews",
      pct === 100 ? "You've used all your previews" : "Previews are popular this month",
      [
        `You've used ${used} of ${total} previews this month.`,
        pct === 100
          ? `Previews are paused until your next month starts. Add ${EXTRA_PACK.previews} more for ${egpText(EXTRA_PACK.price)} any time in the portal.`
          : `At 100% previews pause until next month. You can add ${EXTRA_PACK.previews} more for ${egpText(EXTRA_PACK.price)} in the portal.`,
      ],
      { label: "Open billing", url: portal },
    ),

  supportReply: (to: string, reply: string, portal: string): EmailMessage =>
    msg(to, "Garrab support replied", "Garrab support replied", [reply.length > 600 ? `${reply.slice(0, 600)}…` : reply, "Open your portal to read it and reply."], {
      label: "Open the chat",
      url: portal,
    }),

  cancelled: (to: string, until: string | null): EmailMessage =>
    msg(to, "Your Garrab plan will end", "Cancellation confirmed", [
      until ? `Try-on stays on until ${until}, then switches off. No more invoices.` : "Try-on switches off at the end of your pilot.",
      "Changed your mind? Turn your plan back on in the portal any time before then.",
    ]),
};
