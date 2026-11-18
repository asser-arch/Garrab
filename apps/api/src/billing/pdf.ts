import { COMPANY } from "@garrab/shared/plans";
/**
 * Invoice PDF, generated on demand from the stored invoice (English only: see DECISIONS).
 * VAT is shown only when the rate is above 0.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { InvoiceRow } from "./ledger.js";

const FOREST = rgb(0x14 / 255, 0x38 / 255, 0x22 / 255);
const INK = rgb(0x0f / 255, 0x1a / 255, 0x13 / 255);
const GREY = rgb(0x8a / 255, 0x8b / 255, 0x84 / 255);
const PEACH = rgb(0xf3 / 255, 0xd6 / 255, 0xa8 / 255);

const money = (p: number): string => `${(p / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;
/** Standard PDF fonts are Latin-1 only; keep brand names printable. */
const latin = (s: string): string => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

export async function invoicePdf(
  inv: InvoiceRow,
  brand: { name: string; email: string | null },
  seller: { name: string; contact: string; instapay: string | null },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number}`);
  doc.setProducer("Garrab");
  const page = doc.addPage([595, 842]); // A4
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (s: string, x: number, y: number, size = 11, font = regular, color = INK): void => page.drawText(latin(s), { x, y, size, font, color });

  // Logo: Forest rounded tile, white G, Peach dot.
  page.drawRectangle({ x: 48, y: 760, width: 34, height: 34, color: FOREST });
  page.drawCircle({ x: 76, y: 788, size: 4, color: PEACH });
  text("G", 58, 769, 18, bold, rgb(1, 1, 1));
  text("Garrab", 92, 769, 18, bold);

  text("INVOICE", 420, 780, 12, bold, GREY);
  text(inv.number, 420, 762, 14, bold);
  text(`Issued ${inv.created_at.slice(0, 10)}`, 420, 744, 10, regular, GREY);
  text(`Due ${inv.due_date}`, 420, 730, 10, regular, GREY);

  text("From", 48, 700, 10, bold, GREY);
  text(seller.name, 48, 684);
  text(seller.contact, 48, 670, 10, regular, GREY);
  text("Bill to", 300, 700, 10, bold, GREY);
  text(brand.name, 300, 684);
  if (brand.email) text(brand.email, 300, 670, 10, regular, GREY);

  let y = 620;
  page.drawLine({ start: { x: 48, y: y + 16 }, end: { x: 547, y: y + 16 }, thickness: 1, color: rgb(0.87, 0.84, 0.79) });
  text("Description", 48, y, 10, bold, GREY);
  text("Amount", 470, y, 10, bold, GREY);
  y -= 22;
  for (const l of JSON.parse(inv.lines_json) as { label: string; amount: number }[]) {
    text(l.label.slice(0, 80), 48, y);
    text(money(l.amount), 470, y);
    y -= 18;
  }
  y -= 8;
  page.drawLine({ start: { x: 300, y: y + 12 }, end: { x: 547, y: y + 12 }, thickness: 1, color: rgb(0.87, 0.84, 0.79) });
  if (inv.vat_rate_bp > 0) {
    text("Subtotal", 300, y);
    text(money(inv.subtotal), 470, y);
    y -= 18;
    text(`VAT ${inv.vat_rate_bp / 100}%`, 300, y);
    text(money(inv.vat), 470, y);
    y -= 18;
  }
  text("Total", 300, y, 12, bold);
  text(money(inv.total), 470, y, 12, bold);
  y -= 40;

  if (inv.status === "paid") {
    text(`PAID${inv.paid_at ? ` on ${inv.paid_at.slice(0, 10)}` : ""}`, 48, y, 14, bold, FOREST);
  } else if (seller.instapay) {
    text("How to pay", 48, y, 10, bold, GREY);
    text(`InstaPay to ${/^\+?[0-9 ]{10,15}$/.test(seller.instapay) ? "mobile number " : ""}${seller.instapay}. Write ${inv.number} in the note.`, 48, y - 16);
  }
  text("Garrab: AI try-on for Egyptian brands. Payment is due before each month starts.", 48, 60, 9, regular, GREY);
  text(`${COMPANY.poweredBy} · theinfinisync.com`, 48, 46, 9, regular, GREY);
  return doc.save();
}
