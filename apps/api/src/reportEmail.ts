import { COMPANY } from "@garrab/shared/plans";
/**
 * The branded results report email (pilot day 10 and day 14). Email-safe: tables and inline
 * styles only, one image (the Garrab logo, with alt text), brand colours from tokens, no shadows
 * or gradients (brand guideline). Numbers are anonymous counts.
 */
import type { EmailMessage } from "./lib/email.js";
import type { Report } from "./lib/report.js";

const C = {
  forest: "#143822",
  cream: "#F4F2EB",
  paper: "#FCFBF8",
  ink: "#0F1A13",
  peach: "#F3D6A8",
  mint: "#BFE8E0",
  lavender: "#D2C6F7",
  sand: "#DDD6C9",
  mist: "#E9E9E3",
  muted: "#5c5d57",
};
const FONT = "Cairo,'Segoe UI',Arial,sans-serif";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (x: number): string => x.toLocaleString("en-US");
const dayLabel = (d: string): string => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export interface ReportEmailOptions {
  kind: "midway" | "final";
  /** Pilot day number the report covers up to. */
  dayNumber: number;
  cta: { label: string; url: string };
  /** Pilot end date (Cairo day), for the "what's next" lines. */
  endsOn: string | null;
  planLine: string | null;
}

function tile(label: string, value: number, bg: string, note: string): string {
  return `<td width="50%" valign="top" style="padding:6px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:16px">
    <tr><td style="padding:16px 18px;font-family:${FONT}">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.forest};font-weight:700">${esc(label)}</div>
      <div style="font-size:32px;line-height:1.2;font-weight:700;color:${C.ink};margin-top:4px">${n(value)}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:2px">${esc(note)}</div>
    </td></tr>
  </table></td>`;
}

function section(title: string, inner: string): string {
  return `<tr><td style="padding:24px 28px 0;font-family:${FONT}">
  <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${C.muted};font-weight:700;margin:0 0 10px">${esc(title)}</div>
  ${inner}
</td></tr>`;
}

function chart(r: Report): string {
  const max = Math.max(1, ...r.byDay.map((d) => d.previews));
  const rows = r.byDay
    .map((d) => {
      const w = Math.round((d.previews / max) * 100);
      const bar =
        d.previews > 0
          ? `<table role="presentation" width="${Math.max(w, 3)}%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.forest};height:14px;border-radius:7px;font-size:0;line-height:0">&nbsp;</td></tr></table>`
          : `<table role="presentation" width="3%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.mist};height:14px;border-radius:7px;font-size:0;line-height:0">&nbsp;</td></tr></table>`;
      return `<tr>
  <td width="64" style="font-family:${FONT};font-size:12px;color:${C.muted};padding:3px 8px 3px 0;white-space:nowrap">${esc(dayLabel(d.day))}</td>
  <td style="padding:3px 0">${bar}</td>
  <td width="36" align="right" style="font-family:${FONT};font-size:12px;color:${C.ink};font-weight:700;padding:3px 0 3px 8px">${n(d.previews)}</td>
</tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

function topProducts(r: Report): string {
  const top = r.products.slice(0, 5);
  if (top.length === 0) return `<p style="font-family:${FONT};font-size:14px;color:${C.muted};margin:0">No product has been tried on yet.</p>`;
  const head = `<tr>
  <td style="font-family:${FONT};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.08em;padding:0 0 6px">Product</td>
  <td align="right" style="font-family:${FONT};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.08em;padding:0 0 6px">Views</td>
  <td align="right" style="font-family:${FONT};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.08em;padding:0 0 6px 12px">Previews</td>
  <td align="right" style="font-family:${FONT};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.08em;padding:0 0 6px 12px">Buy taps</td>
</tr>`;
  const rows = top
    .map(
      (p, i) => `<tr>
  <td style="font-family:${FONT};font-size:14px;color:${C.ink};padding:10px 0;border-top:1px solid ${C.sand}">
    <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:11px;background:${i === 0 ? C.peach : C.mist};color:${C.forest};font-size:12px;font-weight:700;margin-right:8px">${i + 1}</span>${esc(p.title)}
  </td>
  <td align="right" style="font-family:${FONT};font-size:14px;color:${C.ink};padding:10px 0;border-top:1px solid ${C.sand}">${n(p.views)}</td>
  <td align="right" style="font-family:${FONT};font-size:14px;color:${C.ink};font-weight:700;padding:10px 0 10px 12px;border-top:1px solid ${C.sand}">${n(p.previews)}</td>
  <td align="right" style="font-family:${FONT};font-size:14px;color:${C.ink};padding:10px 0 10px 12px;border-top:1px solid ${C.sand}">${n(p.buys)}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${head}${rows}</table>`;
}

function headline(r: Report): string {
  const t = r.totals;
  if (t.previews === 0 && t.views === 0) return "Your try-on is live, but no shopper has reached it yet. The next step is to put your link where shoppers already look.";
  if (t.previews === 0) return `${n(t.views)} shoppers saw your try-on, but none have created a preview yet.`;
  return `${n(t.previews)} preview${t.previews === 1 ? "" : "s"} created by your shoppers${t.buys ? `, and ${n(t.buys)} Buy tap${t.buys === 1 ? "" : "s"} straight after` : ""}.`;
}

function tips(r: Report): string[] {
  const out: string[] = [];
  const t = r.totals;
  if (t.views < 50) out.push("Add your try-on link to your Instagram bio and share it in a story. Most try-ons come from stories.");
  if (r.products[0]) out.push(`"${r.products[0].title}" is your most tried piece. Feature it in your next post with the link.`);
  if (t.previews > 0 && t.buys === 0) out.push("Shoppers are trying pieces on but not tapping Buy. Check that each product has a link to where people buy it.");
  out.push("Compare your sales and returns for these products with the two weeks before the pilot. That's the honest test.");
  return out.slice(0, 3);
}

export function reportEmail(to: string, r: Report, o: ReportEmailOptions): EmailMessage {
  const t = r.totals;
  const period = `${dayLabel(r.from)} – ${dayLabel(r.to)} ${r.to.slice(0, 4)}`;
  const title = o.kind === "final" ? "Your pilot results" : "Your pilot report";
  const subject = o.kind === "final" ? `Your Garrab pilot results, ${r.brand}` : `${r.brand}: your first ${o.dayNumber} days with Garrab`;
  const rate = (x: number | null): string => (x === null ? "–" : `${x}%`);
  const next =
    o.kind === "final"
      ? [o.planLine ?? "To keep try-on running, continue your plan.", "If you don't continue, try-on switches off a few days after the pilot ends. Nothing else on your shop changes."]
      : [
          o.endsOn ? `Your pilot runs until ${dayLabel(o.endsOn)}. You'll get your final results then.` : "You'll get your final results at the end of the pilot.",
          "You can add more products any time from your portal.",
        ];

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.cream}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.paper};border:1px solid ${C.sand};border-radius:20px;overflow:hidden">

<tr><td style="background:${C.forest};padding:20px 28px;font-family:${FONT}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-family:${FONT};font-size:18px;font-weight:700;color:${C.paper}">
      <img src="${COMPANY.emailLogoDark}" width="93" height="36" alt="Garrab" style="display:block;border:0;outline:none;width:93px;height:36px">
    </td>
    <td align="right" style="font-family:${FONT};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.peach};font-weight:700">${esc(o.kind === "final" ? "Pilot results" : `Pilot report · day ${o.dayNumber}`)}</td>
  </tr></table>
</td></tr>

<tr><td style="padding:28px 28px 0;font-family:${FONT}">
  <div style="font-size:13px;color:${C.muted}">${esc(r.brand)} · ${esc(period)}</div>
  <h1 style="font-family:${FONT};font-size:28px;line-height:1.25;font-weight:400;color:${C.ink};margin:6px 0 10px">${esc(title)}</h1>
  <p style="font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink};margin:0">${esc(headline(r))}</p>
</td></tr>

<tr><td style="padding:18px 22px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${tile("Views", t.views, C.mist, "Shoppers who saw the try-on")}${tile("Try-ons started", t.started, C.lavender, "Uploaded a photo")}</tr>
    <tr>${tile("Previews", t.previews, C.mint, "AI previews created")}${tile("Buy taps", t.buys, C.peach, "Tapped Buy after a preview")}</tr>
  </table>
</td></tr>

${section(
  "How shoppers moved",
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.sand};border-radius:16px"><tr>
    <td width="50%" style="padding:14px 18px;font-family:${FONT};border-right:1px solid ${C.sand}">
      <div style="font-size:24px;font-weight:700;color:${C.forest}">${rate(r.rates.tryRate)}</div>
      <div style="font-size:13px;color:${C.muted}">of viewers started a try-on</div>
    </td>
    <td width="50%" style="padding:14px 18px;font-family:${FONT}">
      <div style="font-size:24px;font-weight:700;color:${C.forest}">${rate(r.rates.buyRate)}</div>
      <div style="font-size:13px;color:${C.muted}">of previews led to a Buy tap</div>
    </td>
  </tr></table>`,
)}

${section("Previews per day", chart(r))}

${section("Your most tried products", topProducts(r))}

${section(
  "What to do next",
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tips(r)
    .map(
      (x) =>
        `<tr><td valign="top" width="18" style="font-family:${FONT};font-size:15px;color:${C.forest};padding:4px 0">•</td><td style="font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink};padding:4px 0">${esc(x)}</td></tr>`,
    )
    .join("")}</table>`,
)}

<tr><td style="padding:20px 28px 0;font-family:${FONT}">
  ${next.map((x) => `<p style="font-family:${FONT};font-size:14px;line-height:1.6;color:${C.muted};margin:0 0 8px">${esc(x)}</p>`).join("")}
</td></tr>

<tr><td style="padding:16px 28px 28px">
  <a href="${esc(o.cta.url)}" style="display:inline-block;background:${C.forest};color:${C.paper};text-decoration:none;font-family:${FONT};font-weight:700;font-size:15px;padding:13px 26px;border-radius:999px">${esc(o.cta.label)}</a>
</td></tr>

</table>
<p style="font-family:${FONT};font-size:12px;color:#8A8B84;margin:16px 0 0;max-width:600px">Garrab · AI try-on for Egyptian brands. Counts are anonymous: we never know who your shoppers are. Previews are AI images, a guide rather than a promise.<br><a href="${COMPANY.url}" style="color:#8A8B84">${COMPANY.poweredBy}</a></p>
</td></tr></table>
</body></html>`;

  const text = [
    `${title} · ${r.brand} · ${period}`,
    "",
    headline(r),
    "",
    `Views: ${n(t.views)}`,
    `Try-ons started: ${n(t.started)}`,
    `Previews: ${n(t.previews)}`,
    `Buy taps: ${n(t.buys)}`,
    `Viewers who started a try-on: ${rate(r.rates.tryRate)}. Previews that led to a Buy tap: ${rate(r.rates.buyRate)}.`,
    "",
    "Most tried products:",
    ...(r.products.length ? r.products.slice(0, 5).map((p, i) => `${i + 1}. ${p.title}: ${n(p.previews)} previews, ${n(p.buys)} Buy taps`) : ["None yet."]),
    "",
    "What to do next:",
    ...tips(r).map((x) => `- ${x}`),
    "",
    ...next,
    "",
    `${o.cta.label}: ${o.cta.url}`,
    "",
    COMPANY.poweredBy,
  ].join("\n");

  return { to, subject, html, text };
}
