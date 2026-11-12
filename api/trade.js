// POST /api/trade — the owner-only half of FLIP trade orders.
//
// Called from the Betterservice dashboard, never from the shop. Four actions:
//
//   { action: "quote", items, address }
//       What the freight would COST: the carrier's own quote, excluding GST,
//       with no markup. Trade freight is charged at cost.
//
//   { action: "invoice", invoice_number, resend? }
//       Build the trade invoice for an order the dashboard has just created
//       (through create_flip_trade_order) and email it to the trade customer,
//       with Craig's copy. The same invoice generator, PDF and mail path as a
//       web order — trade invoices are not a second system.
//
//   { action: "book", invoice_number }
//       Book the courier with GoSweetSpot and file the label. ANY order, web
//       or trade — the label sheet is the same page for both. Costs money, so
//       it refuses anything that looks already sent: an order marked packed
//       with no booking was ticketed by hand, and booking it again would buy
//       a second courier for a box that has gone.
//
//   { action: "label", invoice_number }
//       The stored carrier label, as base64 PNG, for the sheet to print. The
//       bucket is private; this is the door to it.
//
// WHY THIS IS NOT /api/quote WITH A FLAG
//
// /api/quote is public: anyone can POST to it, and it answers every visitor to
// the shop. The number it returns is a PRICE — the carrier's figure with our
// markup and GST on top. The number this returns is a COST, and costs are not
// shown to the public, full stop. Putting both behind one URL would make the
// difference between them a matter of one boolean in a request body anyone can
// edit. So the cost lives behind a door that only opens for an owner.
//
// WHO GETS IN
//
// The caller sends their own Supabase session token. callerIsOwner() asks the
// database is_owner() AS THAT USER — the same function that guards every owner
// policy in the app — so there is no second list of owners here to drift out
// of date. No token, a bad token, an expired one, or a staff member who is not
// an owner: refused.
//
// CORS lets the dashboard's browser READ the answer. It is not the lock — the
// token is. A request from anywhere without an owner's token gets nothing.

import { callerIsOwner, orderForBooking, labelImage } from "./_lib/db.js";
import { atCostQuote, sendTradeInvoice } from "./_lib/tradeOrder.js";
import { ensureConsignment } from "./_lib/consignment.js";

const invoiceNo = (v) => {
  const n = Number(String(v ?? "").replace(/^FLIP-/i, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function book(b) {
  const n = invoiceNo(b.invoice_number);
  if (!n) return { status: 400, body: { error: "Which order? No invoice number." } };
  const o = await orderForBooking(n);
  if (!o) return { status: 404, body: { error: `No order FLIP-${n}.` } };

  // Done already: say so, don't touch the carrier.
  if (o.consignment_id && o.label_fetched_at) {
    return { status: 200, body: { ok: true, already: true, connote: o.tracking_number } };
  }
  // Packed with no booking = it went on a hand-written ticket. Never book a
  // second courier for it. (Booked-but-no-label is different: that retry
  // only fetches the label for the consignment we already have.)
  if (o.packed_at && !o.consignment_id) {
    return { status: 409, body: { error: `FLIP-${n} is already marked as sent without a GoSweetSpot booking — it was ticketed by hand, so it won't be booked again.` } };
  }
  if (o.address?.collect === true) {
    return { status: 400, body: { error: "This order is being collected — there's no courier to book." } };
  }

  const r = await ensureConsignment(o.session_id);
  if (!r.ok) return { status: r.skipped ? 400 : 502, body: { error: r.reason || "The booking didn't go through." } };
  return {
    status: 200,
    body: { ok: true, connote: r.connote, carrier: r.carrier || null, charge: r.charge ?? null,
            trackingUrl: r.trackingUrl || null, recovered: !!r.reason },
  };
}

async function label(b) {
  const n = invoiceNo(b.invoice_number);
  if (!n) return { status: 400, body: { error: "Which order? No invoice number." } };
  const png = await labelImage(n);
  if (!png) return { status: 404, body: { error: `No courier label filed for FLIP-${n} yet.` } };
  return { status: 200, body: { ok: true, png: Buffer.from(png).toString("base64") } };
}

// Where the dashboard runs. FLIP_TRADE_ORIGINS overrides it (comma separated),
// e.g. to add a preview deployment while testing, without a code change.
const DEFAULT_ORIGINS = ["https://betterservice.co.nz", "https://www.betterservice.co.nz"];
const origins = () => {
  const list = String(process.env.FLIP_TRADE_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
};

function cors(req, res) {
  const origin = req.headers?.origin;
  res.setHeader("Vary", "Origin");
  if (origin && origins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Cost-side and per-owner: no cache anywhere may keep a copy.
  res.setHeader("Cache-Control", "no-store");

  const token = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "Sign in to the Betterservice app first." });
  if (!(await callerIsOwner(token))) return res.status(403).json({ error: "Only an owner can do that." });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  try {
    let r;
    if (b.action === "quote") r = await atCostQuote(b);
    else if (b.action === "invoice") r = await sendTradeInvoice(b.invoice_number, { resend: b.resend === true });
    else if (b.action === "book") r = await book(b);
    else if (b.action === "label") r = await label(b);
    else r = { status: 400, body: { error: "Unknown action." } };
    return res.status(r.status).json(r.body);
  } catch (err) {
    console.error("trade:", b.action, err);
    return res.status(500).json({ error: "Something went wrong. Nothing was charged; try again." });
  }
}
