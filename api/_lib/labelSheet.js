// One A4 sheet: the courier label on the top half, what to pick on the bottom.
//
// Ben, 20 Oct 2026: "I want A5, so it can be half the A4 sheet, and the other
// half prints the order that needs picking and packing."
//
// WHY THIS SHAPE
//
// An A4 portrait sheet halves across the middle into two 210 x 148 mm pieces —
// A5 LANDSCAPE. A5 portrait is 148 x 210 and will not tile two-up without
// rotating, and a courier label is wider than it is tall (the one GoSweetSpot
// returns is 174 x 100 mm), so landscape suits it anyway.
//
// The label goes on TOP deliberately. It is the half that matters, it is the
// one that gets taped to the box, and the cut falls below it rather than
// through it. If the printer runs low on toner halfway down the page, you lose
// the picking list and not the barcode.
//
// WHY THE LABEL IS AN IMAGE AND THAT IS FINE
//
// The carrier hands back a PNG. Embedding a PNG is simpler than embedding
// another PDF's page, and pdf-lib does it in one call. The only rule is SCALE,
// NEVER STRETCH: the image is fitted proportionally to the box and centred.
// A squashed barcode is an unscannable barcode, and nobody finds out until a
// courier driver is standing in the workshop.
//
// WHY THE FONT IS THE SAME ONE THE INVOICE USES
//
// Same reason, and it is worth repeating because it has cost this project real
// invoices: the fonts built into every PDF reader are WinAnsi-encoded, WinAnsi
// has no macron, and a customer called Māhia either throws (pdf-lib) or
// silently loses the macron (jsPDF). A picking slip with a mangled name is a
// smaller problem than an invoice with one, but it is the same bug.
//
// FAILURE HERE IS FATAL, UNLIKE THE INVOICE PDF.
//
// invoicePdf.js returns null on failure because it runs after the money has
// been taken and an email without an attachment still beats no email. This
// runs when the agent asks for something to print: if the sheet cannot be
// built there is nothing to print, so it THROWS and the caller leaves the
// label pending for the next poll.

import { readFileSync } from "node:fs";

const FONTS = {
  regular: new URL("./fonts/flip-sans.ttf", import.meta.url),
  bold: new URL("./fonts/flip-sans-bold.ttf", import.meta.url),
};

let fontBytes;
function loadFonts() {
  if (fontBytes === undefined) {
    fontBytes = { regular: readFileSync(FONTS.regular), bold: readFileSync(FONTS.bold) };
  }
  return fontBytes;
}

const PAGE = { w: 595.28, h: 841.89 };  // A4 portrait, points
const HALF = PAGE.h / 2;                // where the scissors go
const M = 34;                           // ~12 mm, clear of any printer's dead zone

const INK = [0.05, 0.05, 0.05];
const MUTED = [0.45, 0.45, 0.45];
const RULE = [0.75, 0.75, 0.75];

/**
 * @param {object}  o
 * @param {Uint8Array} o.labelPng  the carrier's label, as PNG bytes
 * @param {object}  o.order        a flip_orders row
 * @param {object} [o.packing]     what the shop EXPECTED to pack:
 *                                 { cartons, kg, freightCents }
 * @returns {Promise<Uint8Array>}  the A4 sheet
 */
export async function buildLabelSheet({ labelPng, order, packing = null }) {
  if (!labelPng || labelPng.length === 0) throw new Error("no label image to print");

  const bytes = loadFonts();
  const { PDFDocument, rgb } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(bytes.regular, { subset: true });
  const bold = await doc.embedFont(bytes.bold, { subset: true });

  const num = order?.invoice_number ?? "";
  doc.setTitle(`FLIP-${num} label and picking slip`);
  doc.setProducer("flipbikes.co.nz");
  doc.setCreationDate(new Date());

  const page = doc.addPage([PAGE.w, PAGE.h]);
  const col = (c) => rgb(c[0], c[1], c[2]);
  const text = (s, x, y, { size = 10, font = regular, colour = INK, align = "left" } = {}) => {
    const str = String(s ?? "");
    const w = font.widthOfTextAtSize(str, size);
    const at = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    page.drawText(str, { x: at, y, size, font, color: col(colour) });
    return w;
  };

  // ------------------------------------------------------- the label, on top
  //
  // The box is the top half less the margin, and less a little more at the
  // bottom so the image never crowds the cut line.
  const box = { x: M, y: HALF + 14, w: PAGE.w - M * 2, h: HALF - M - 14 };
  const img = await doc.embedPng(labelPng);
  const scale = Math.min(box.w / img.width, box.h / img.height);  // fit, never stretch
  const drawn = { w: img.width * scale, h: img.height * scale };
  page.drawImage(img, {
    x: box.x + (box.w - drawn.w) / 2,
    y: box.y + (box.h - drawn.h) / 2,
    width: drawn.w,
    height: drawn.h,
  });

  // ------------------------------------------------------------ the cut line
  page.drawLine({
    start: { x: M / 2, y: HALF }, end: { x: PAGE.w - M / 2, y: HALF },
    thickness: 0.75, color: col(RULE), dashArray: [4, 3],
  });
  text("cut here", PAGE.w / 2, HALF + 4, { size: 7, colour: MUTED, align: "center" });

  // -------------------------------------------------- the picking slip below
  let y = HALF - 30;

  text(`FLIP-${num}`, M, y, { size: 20, font: bold });
  text("PACK THIS", PAGE.w - M, y, { size: 11, font: bold, colour: MUTED, align: "right" });
  y -= 20;

  const who = order?.name || "";
  if (who) { text(who, M, y, { size: 12, font: bold }); y -= 14; }

  const where = order?.address?.formatted || "";
  if (where) { text(where, M, y, { size: 9, colour: MUTED }); y -= 12; }

  // The delivery instruction is the single most missable thing on an order —
  // FLIP-1004 said "Deliver to Site Stores- Attn John Davis" — so it gets its
  // own line in black rather than being folded into the address.
  const note = order?.address?.note;
  if (note) { y -= 2; text(note, M, y, { size: 10, font: bold }); y -= 14; }

  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: PAGE.w - M, y }, thickness: 0.75, color: col(RULE) });
  y -= 18;

  // Every line gets an empty box. Someone picking in a cold workshop ticks
  // things off; a list with nothing to tick is a list you lose your place in.
  const items = Array.isArray(order?.items) ? order.items : [];
  for (const it of items) {
    page.drawRectangle({
      x: M, y: y - 2, width: 11, height: 11,
      borderColor: col(INK), borderWidth: 0.9,
    });
    text(`${it.qty} x`, M + 20, y, { size: 11, font: bold });
    text(it.name || it.sku || "", M + 48, y, { size: 11 });
    text(it.sku || "", PAGE.w - M, y, { size: 8, colour: MUTED, align: "right" });
    y -= 19;
  }
  if (items.length === 0) {
    text("No items recorded on this order — check the shop before sending.", M, y, { size: 10, font: bold });
    y -= 19;
  }

  // ------------------------------------------- what the shop thought it was
  //
  // The freight table guesses at cartons and weight, and nobody has ever
  // checked those guesses against a real parcel — CARTON_WEIGHT_G has 150 g of
  // headroom and is still an estimate. Printing what was EXPECTED next to the
  // thing being packed is the cheapest feedback loop available: if Craig ends
  // up taping three cartons when this says one, he can say so, and the table
  // gets fixed from reality instead of arithmetic.
  if (packing) {
    y -= 4;
    page.drawLine({ start: { x: M, y }, end: { x: PAGE.w - M, y },
                    thickness: 0.75, color: col(RULE) });
    y -= 16;
    const bits = [];
    if (packing.cartons) bits.push(`${packing.cartons} carton${packing.cartons === 1 ? "" : "s"}`);
    if (packing.kg) bits.push(`${Number(packing.kg).toFixed(2)} kg`);
    text("Shop expected: " + (bits.join(", ") || "not calculated"), M, y, { size: 9, colour: MUTED });
    if (typeof packing.freightCents === "number") {
      text(`Freight charged $${(packing.freightCents / 100).toFixed(2)}`,
           PAGE.w - M, y, { size: 9, colour: MUTED, align: "right" });
    }
    y -= 16;
    text("Different in real life? Tell Ben — the freight table is still guessing.",
         M, y, { size: 8, colour: MUTED });
  }

  // ------------------------------------------------------------------ footer
  const foot = 34;
  page.drawLine({ start: { x: M, y: foot + 16 }, end: { x: PAGE.w - M, y: foot + 16 },
                  thickness: 0.75, color: col(RULE) });
  const when = order?.created_at ? new Date(order.created_at).toLocaleDateString("en-NZ") : "";
  text(when ? `Ordered ${when}` : "", M, foot, { size: 8, colour: MUTED });
  text("Tape the top half to the box", PAGE.w - M, foot, { size: 8, colour: MUTED, align: "right" });

  return await doc.save();
}
