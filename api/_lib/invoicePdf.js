// The tax invoice as a PDF file, to attach to the customer's email.
//
// WHY A FILE AT ALL
// The invoice already goes out as the body of the email, which is legal in NZ —
// IRD cares what a tax invoice SAYS, not what format it arrives in. But people
// expect something they can save, forward to their accountant, or staple to an
// expense claim, and an email body is none of those.
//
// WHY THE FONT MATTERS, AND WHY IT IS THE FIRST THING IN THIS FILE
// The fourteen fonts built into every PDF reader are WinAnsi-encoded, and
// WinAnsi has no macron vowels. Drawing "Māhia" with one of them is not a near
// miss: pdf-lib refuses to guess and THROWS, which on Betterservice left rental
// invoice #01065 with no PDF at all on 10 Oct 2026. The same fault in jsPDF is
// worse because it is silent — the character is simply dropped and the line
// still reads like a sentence, so a customer's name is wrong on their own
// invoice and nothing reports it.
//
// So a real Unicode font is embedded. The two files in ./fonts are the same
// DejaVu Sans subsets Betterservice uses (see its lib/FONTS.md for what is in
// them and how to regenerate): ASCII, Latin-1, the te reo macrons, and the
// curly quotes and dashes that arrive pasted out of Word. 17 KB and 16 KB,
// and pdf-lib subsets them again on the way in.
//
// EVERY FAILURE HERE IS NON-FATAL, DELIBERATELY.
// This runs inside the Stripe webhook, after the customer's money has been
// taken. An invoice that arrives without its attachment is a nuisance; an
// email that never arrives because the PDF generator threw is a customer who
// paid and heard nothing. So the caller gets null and sends the email anyway.

import { readFileSync } from "node:fs";
import { money } from "./catalog.js";

const FONTS = {
  regular: new URL("./fonts/flip-sans.ttf", import.meta.url),
  bold: new URL("./fonts/flip-sans-bold.ttf", import.meta.url),
};

// Read once per cold start, not once per invoice.
let fontBytes;
function loadFonts() {
  if (fontBytes === undefined) {
    try {
      fontBytes = { regular: readFileSync(FONTS.regular), bold: readFileSync(FONTS.bold) };
    } catch (err) {
      console.error("Invoice PDF: font files unavailable:", err.message);
      fontBytes = null;
    }
  }
  return fontBytes;
}

// A4 in points, and the one margin everything is measured from.
const PAGE = { w: 595.28, h: 841.89 };
const M = 56;
const INNER = PAGE.w - M * 2;

const INK = [0.05, 0.05, 0.05];
const MUTED = [0.42, 0.42, 0.42];
const RULE = [0.80, 0.80, 0.80];
const YELLOW = [1.0, 0.78, 0.0]; // the FLIP yellow, #FFC800

/**
 * Render a built invoice to a PDF.
 *
 * @param {object} inv  the object buildInvoice() returns
 * @returns {Promise<string|null>} base64 PDF, or null if it could not be made
 */
export async function invoicePdfBase64(inv) {
  try {
    const bytes = loadFonts();
    if (!bytes) return null;

    const { PDFDocument, rgb } = await import("pdf-lib");
    const fontkit = (await import("@pdf-lib/fontkit")).default;

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const regular = await doc.embedFont(bytes.regular, { subset: true });
    const bold = await doc.embedFont(bytes.bold, { subset: true });

    doc.setTitle(`${inv.isTaxInvoice ? "Tax invoice" : "Order confirmation"} ${inv.number}`);
    doc.setProducer("flipbikes.co.nz");
    doc.setCreationDate(new Date());

    const page = doc.addPage([PAGE.w, PAGE.h]);
    const col = (c) => rgb(c[0], c[1], c[2]);

    // `y` walks down the page. Every helper leaves it below what it drew, so
    // adding a section never means recomputing the ones after it.
    let y = PAGE.h - M;

    const text = (s, { x = M, size = 10, font = regular, colour = INK, align = "left" } = {}) => {
      const str = String(s ?? "");
      const w = font.widthOfTextAtSize(str, size);
      const at = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      page.drawText(str, { x: at, y, size, font, color: col(colour) });
      return w;
    };
    const down = (n) => { y -= n; };
    const rule = (colour = RULE, thickness = 0.75) => {
      page.drawLine({
        start: { x: M, y }, end: { x: M + INNER, y },
        thickness, color: col(colour),
      });
    };

    // ---------------------------------------------------------- masthead
    page.drawRectangle({ x: M, y: y - 2, width: 46, height: 7, color: col(YELLOW) });
    down(30);
    text(inv.supplier.name, { size: 19, font: bold });
    down(16);
    for (const line of inv.supplier.address) { text(line, { size: 9, colour: MUTED }); down(11); }
    text(`${inv.supplier.email}   ${inv.supplier.phone}`, { size: 9, colour: MUTED });
    down(11);
    if (inv.isTaxInvoice) { text(`GST number: ${inv.supplier.gstNumber}`, { size: 9, colour: MUTED }); down(11); }

    // The document's own title, right-aligned against the sender block.
    const titleY = PAGE.h - M - 30;
    page.drawText(inv.isTaxInvoice ? "TAX INVOICE" : "ORDER CONFIRMATION", {
      x: M + INNER - bold.widthOfTextAtSize(inv.isTaxInvoice ? "TAX INVOICE" : "ORDER CONFIRMATION", 14),
      y: titleY, size: 14, font: bold, color: col(INK),
    });
    const meta = [`Invoice no. ${inv.number}`, `Date: ${inv.date}`];
    meta.forEach((line, i) => {
      page.drawText(line, {
        x: M + INNER - regular.widthOfTextAtSize(line, 9.5),
        y: titleY - 18 - i * 12, size: 9.5, font: regular, color: col(MUTED),
      });
    });

    down(18);
    rule(YELLOW, 1.5);
    down(26);

    // -------------------------------------------------------------- buyer
    text("BILL TO", { size: 8, font: bold, colour: MUTED });
    down(14);
    text(inv.buyer.name || "—", { size: 11, font: bold });
    down(13);
    for (const line of inv.buyer.address) { text(line, { size: 10, colour: MUTED }); down(12); }

    down(18);

    // -------------------------------------------------------------- items
    // Right edges, so every money column lines up on its last digit.
    const X = { item: M, qty: M + 330, each: M + 420, total: M + INNER };

    text("ITEM", { size: 8, font: bold, colour: MUTED });
    text("QTY", { x: X.qty, size: 8, font: bold, colour: MUTED, align: "right" });
    text("EACH", { x: X.each, size: 8, font: bold, colour: MUTED, align: "right" });
    text("TOTAL", { x: X.total, size: 8, font: bold, colour: MUTED, align: "right" });
    down(8);
    rule();
    down(16);

    for (const l of inv.lines) {
      // Long product names wrap rather than running under the qty column.
      const wrapped = wrap(l.name, regular, 10, X.qty - M - 24);
      wrapped.forEach((part, i) => {
        text(part, { size: 10 });
        if (i === 0) {
          text(String(l.qty), { x: X.qty, size: 10, align: "right" });
          if (l.unit != null) text(money(l.unit), { x: X.each, size: 10, align: "right" });
          if (l.total != null) text(money(l.total), { x: X.total, size: 10, align: "right" });
        }
        down(14);
      });
      down(2);
    }

    text("Shipping", { size: 10, colour: MUTED });
    text(money(inv.shipping), { x: X.total, size: 10, align: "right" });
    down(12);
    rule();
    down(20);

    // -------------------------------------------------------------- total
    text(`TOTAL ${inv.isTaxInvoice ? "(including GST) " : ""}NZD`, { size: 11, font: bold });
    text(money(inv.total), { x: X.total, size: 13, font: bold, align: "right" });
    down(16);
    if (inv.isTaxInvoice) {
      text(`GST (${inv.gstNote.toLowerCase()})`, { size: 9.5, colour: MUTED });
      text(money(inv.gst), { x: X.total, size: 9.5, colour: MUTED, align: "right" });
      down(16);
    }

    down(10);
    rule();
    down(16);
    text("Paid by card. Prices include GST.", { size: 9.5, colour: MUTED });

    // ------------------------------------------------------------- footer
    page.drawText("flipbikes.co.nz", {
      x: M, y: M - 10, size: 8.5, font: regular, color: col(MUTED),
    });

    return Buffer.from(await doc.save()).toString("base64");
  } catch (err) {
    // Loud in the log, silent to the customer: the email still goes.
    console.error("Invoice PDF could not be made:", err?.message ?? err);
    return null;
  }
}

/** Greedy word wrap measured in the font the text will actually print in. */
function wrap(s, font, size, maxWidth) {
  const words = String(s ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const out = [];
  let line = words[0];
  for (const w of words.slice(1)) {
    const next = line + " " + w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
    else { out.push(line); line = w; }
  }
  out.push(line);
  return out;
}

/** The filename the customer sees in their inbox. */
export const invoicePdfName = (inv) =>
  `${inv.isTaxInvoice ? "Tax-invoice" : "Order"}-${inv.number}.pdf`;
