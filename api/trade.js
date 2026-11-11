// POST /api/trade — the owner-only half of FLIP trade orders.
//
// Called from the Betterservice dashboard, never from the shop. Two actions:
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

import { callerIsOwner } from "./_lib/db.js";
import { atCostQuote, sendTradeInvoice } from "./_lib/tradeOrder.js";

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
    else r = { status: 400, body: { error: "Unknown action." } };
    return res.status(r.status).json(r.body);
  } catch (err) {
    console.error("trade:", b.action, err);
    return res.status(500).json({ error: "Something went wrong. Nothing was charged; try again." });
  }
}
