// GET /api/labels/:id/pdf — one A4 sheet: the courier label on the top half,
// what to pick on the bottom. This is the URL `pending` hands the agent.
//
// `:id` is the invoice number, same as everywhere else in this pair of
// endpoints. Same bearer token.
//
// WHERE THE LABEL COMES FROM
//
// The consignment step (still to build) stores the carrier's label in the
// `flip-labels` bucket as `<invoice number>.png` and stamps `label_fetched_at`.
// This endpoint reads it back and composites the sheet on the way out. It does
// NOT call the carrier: a print agent retrying every minute must not be able to
// make us hammer a carrier's API, and the label a customer's parcel travels
// with should be the one that was filed, not one regenerated later.
//
// WHY NOT STORE THE FINISHED SHEET
//
// Because the picking half can change — a new line, a corrected address, a
// tweak to the layout — while the label half is fixed the moment the
// consignment exists. Compositing on the way out means the paper always
// matches the order as it stands, and there is only ever one file to keep.

import { refuseUnlessAgent } from "../../_lib/agent.js";
import { dbConfigured, orderForLabel, labelImage } from "../../_lib/db.js";
import { buildLabelSheet } from "../../_lib/labelSheet.js";
import { parseCart, isSmall, weightOf } from "../../_lib/catalog.js";
import { CHOCKS_PER_CARTON, CARTON_WEIGHT_G } from "../../_lib/shipping.js";

// What the shop thought it was sending, recomputed from the order's own lines
// the same way quoteShipping() does it. Printed on the sheet so a human can
// notice when the freight table is wrong (see labelSheet.js).
function expectedPacking(order) {
  try {
    const cart = parseCart(order.items);
    const chocks = cart.lines.reduce((n, l) => n + (isSmall(l.product) ? 0 : l.qty), 0);
    const goodsG = cart.lines.reduce((g, l) => g + weightOf(l.product) * l.qty, 0);
    const cartons = Math.max(1, Math.ceil(chocks / CHOCKS_PER_CARTON));
    return {
      cartons,
      kg: (goodsG + cartons * CARTON_WEIGHT_G) / 1000,
      freightCents: typeof order.shipping_amount === "number" ? order.shipping_amount : undefined,
    };
  } catch (err) {
    // A sheet without this line is still a printable sheet.
    console.error("Could not work out expected packing:", err.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const no = refuseUnlessAgent(req);
  if (no) return res.status(no.status).json(no.body);

  if (!dbConfigured()) {
    return res.status(503).json({ error: "The shop database isn't configured." });
  }

  const invoiceNumber = Number(req.query?.id);
  if (!Number.isInteger(invoiceNumber) || invoiceNumber <= 0) {
    return res.status(400).json({ error: "Which label? Expected an invoice number." });
  }

  let order;
  try {
    order = await orderForLabel(invoiceNumber);
  } catch (err) {
    console.error("Label order lookup failed:", err.message);
    return res.status(502).json({ error: "Couldn't look that order up." });
  }
  if (!order) return res.status(404).json({ error: `No order with invoice number ${invoiceNumber}.` });

  let png;
  try {
    png = await labelImage(invoiceNumber);
  } catch (err) {
    console.error("Label image fetch failed:", err.message);
    return res.status(502).json({ error: "Couldn't read the stored label." });
  }
  // No label filed yet is a 404, not an error: `pending` only offers orders
  // whose label HAS been filed, so the agent should never see this.
  if (!png) {
    return res.status(404).json({ error: `No label has been filed for FLIP-${invoiceNumber} yet.` });
  }

  let pdf;
  try {
    pdf = await buildLabelSheet({ labelPng: png, order, packing: expectedPacking(order) });
  } catch (err) {
    // Loud on purpose. If the sheet can't be built there is nothing to print,
    // and the label stays pending for the next poll.
    console.error("Label sheet build failed:", err.message);
    return res.status(502).json({ error: "Couldn't build the label sheet: " + err.message });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="FLIP-${invoiceNumber}-label.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(Buffer.from(pdf));
}
