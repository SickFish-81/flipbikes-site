// /api/dealer — the FLIP dealer portal (flipbikes.co.nz/trade).
//
// Approved dealers sign in with a code emailed to them and place dropship
// orders themselves: who it goes to, what's in the box. They pay on account —
// the order goes straight on Craig's pack list and the invoice is emailed to
// the dealer, due the 20th of next month.
//
// What a dealer can NOT do from here, whatever their browser sends:
//   * set a price (their tier's price is applied by the database),
//   * set the freight (this server quotes it itself, at cost, when they order),
//   * bill anyone else or change where the invoice goes (taken from their
//     saved account, not the request),
//   * see or invoice another dealer's orders (every query is pinned to the
//     signed-in dealer's id).
//
// POST, JSON body { action, ... }:
//   request_code {email}        email a sign-in code (always says "sent")
//   verify_code  {email, code}  sign in; sets an HttpOnly session cookie
//   logout
//   me                          who you are + your prices
//   quote        {items, deliver_to}            freight, at cost
//   order        {items, deliver_to, customer_ref}
//   orders                      your recent orders
// GET ?invoice=1012             your invoice as a PDF

import { business } from "./_lib/business.js";
import { bySku, PRODUCTS } from "./_lib/catalog.js";
import {
  dbConfigured, getStock, dealerByEmail, dealerById, codesSince, insertCode, liveCode, patchCode,
  dealerPriceList, createDealerOrder, dealerOrders, tradeOrderByInvoice,
} from "./_lib/db.js";
import {
  portalConfigured, newCode, hashCode, codeMatches, signSession, readSession, cookieFrom,
  sessionCookie, clearCookie, CODE_MINUTES, CODE_MAX_ATTEMPTS, CODES_PER_WINDOW,
} from "./_lib/dealerAuth.js";
import { atCostQuote, sendTradeInvoice, TRADE_FROM, escapeHtml } from "./_lib/tradeOrder.js";
import { buildInvoice, invoiceNumber } from "./_lib/invoice.js";
import { invoicePdfBase64, invoicePdfName } from "./_lib/invoicePdf.js";
import { send, recipients, REPLY_TO } from "./_lib/mail.js";

const GENERIC_SENT = "If that email has a dealer account, a sign-in code is on its way. It works for 10 minutes.";
const BAD_CODE = "That code isn't right, or it has expired. Ask for a new one.";

// A request from another website must not be able to act with a dealer's
// cookie. Browsers always send Origin on a cross-site POST; it has to be us.
function sameOrigin(req) {
  const origin = req.headers?.origin;
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

async function currentDealer(req) {
  const s = readSession(cookieFrom(req));
  if (!s) return null;
  const d = await dealerById(s.dealerId);
  // Access switched off, or Craig signed them out everywhere: the cookie is dead.
  if (!d || !d.portal_access || d.session_version !== s.version) return null;
  return d;
}

const publicDealer = (d) => ({ business: d.business, contact: d.contact, email: d.email, phone: d.phone, address: d.address });

// The address as the quote (and the database) want it.
const manualAddress = (t = {}) => ({
  manual: {
    line1: String(t.line1 || "").trim(), suburb: String(t.suburb || "").trim(),
    city: String(t.city || "").trim(), postcode: String(t.postcode || "").trim(),
  },
});

const cleanItems = (items) => (Array.isArray(items) ? items : [])
  .map((i) => ({ sku: String(i?.sku || ""), qty: Number(i?.qty) }))
  .filter((i) => i.qty > 0);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!portalConfigured() || !dbConfigured()) {
    return res.status(503).json({ error: "The dealer portal isn't switched on yet. Please contact us to order." });
  }

  try {
    if (req.method === "GET") return await invoicePdf(req, res);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!sameOrigin(req)) return res.status(403).json({ error: "Refused." });

    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};

    if (b.action === "request_code") return await requestCode(b, res);
    if (b.action === "verify_code") return await verifyCode(b, res);
    if (b.action === "logout") { res.setHeader("Set-Cookie", clearCookie()); return res.status(200).json({ ok: true }); }

    const dealer = await currentDealer(req);
    if (!dealer) {
      res.setHeader("Set-Cookie", clearCookie());
      return res.status(401).json({ error: "Please sign in.", signedOut: true });
    }
    // Rolling renewal: every visit pushes the cookie's expiry out again, so a
    // dealer who keeps ordering stays signed in indefinitely.
    res.setHeader("Set-Cookie", sessionCookie(signSession(dealer.id, dealer.session_version)));
    if (b.action === "me") return await me(dealer, res);
    if (b.action === "quote") return await quote(b, res);
    if (b.action === "order") return await order(dealer, b, res);
    if (b.action === "orders") return await orders(dealer, res);
    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("dealer:", err);
    return res.status(500).json({ error: "Something went wrong on our side. Nothing was ordered; please try again." });
  }
}

// ------------------------------------------------------------------ sign in

async function requestCode(b, res) {
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter your email address." });

  // The same answer whether or not the address is a dealer, so the form can't
  // be used to find out who Craig's dealers are.
  const d = await dealerByEmail(email);
  if (!d || !d.portal_access) return res.status(200).json({ sent: true, message: GENERIC_SENT });

  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  if ((await codesSince(d.id, since)) >= CODES_PER_WINDOW) {
    return res.status(200).json({ sent: true, message: GENERIC_SENT });
  }

  const code = newCode();
  await insertCode(d.id, hashCode(d.id, code), new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString());

  const key = process.env.RESEND_API_KEY;
  if (key) {
    try {
      await send(key, {
        from: TRADE_FROM,
        to: d.email,
        subject: "Your FLIP dealer sign-in code",
        text: `Your sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.\n\nFLIP Bike Chocks`,
        html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p><p>FLIP Bike Chocks</p>`,
        reply_to: REPLY_TO,
      });
    } catch (err) {
      console.error("dealer code email failed:", err?.message ?? err);
    }
  } else {
    console.error("dealer code not sent: no RESEND_API_KEY");
  }
  return res.status(200).json({ sent: true, message: GENERIC_SENT });
}

async function verifyCode(b, res) {
  const d = await dealerByEmail(b.email);
  if (!d || !d.portal_access) return res.status(400).json({ error: BAD_CODE });

  const c = await liveCode(d.id, new Date().toISOString());
  if (!c || c.attempts >= CODE_MAX_ATTEMPTS) return res.status(400).json({ error: BAD_CODE });

  if (!codeMatches(d.id, b.code, c.code_hash)) {
    await patchCode(c.id, { attempts: c.attempts + 1 });
    return res.status(400).json({ error: BAD_CODE });
  }
  await patchCode(c.id, { used_at: new Date().toISOString() });
  res.setHeader("Set-Cookie", sessionCookie(signSession(d.id, d.session_version)));
  return res.status(200).json({ ok: true, dealer: publicDealer(d) });
}

// --------------------------------------------------------------- the portal

async function me(d, res) {
  const list = await dealerPriceList(d.id);
  const order = PRODUCTS.map((p) => p.sku);
  const prices = (list || [])
    .map((p) => ({ sku: p.sku, name: p.name, price_ex_gst: p.price_ex_gst }))
    .sort((a, b) => order.indexOf(a.sku) - order.indexOf(b.sku));
  return res.status(200).json({ dealer: publicDealer(d), prices });
}

async function quote(b, res) {
  const r = await atCostQuote({
    items: cleanItems(b.items),
    address: manualAddress(b.deliver_to),
    ruralDeclared: b.deliver_to?.rural === true,
  });
  if (r.status !== 200) return res.status(r.status).json(r.body);
  // A dealer sees the figure and whether it's firm. The internal wording about
  // dockets is for Craig.
  return res.status(200).json({
    shipping_ex_gst: r.body.shipping_ex_gst,
    carrier: r.body.carrier,
    estimate: r.body.source !== "carrier",
    rural: r.body.rural,
  });
}

async function order(d, b, res) {
  const items = cleanItems(b.items);
  if (items.length === 0) return res.status(400).json({ error: "Add at least one product." });
  const t = b.deliver_to || {};

  // Same stock check as the website, and the same fail-open: if stock can't
  // be read, take the order rather than turn a dealer away.
  try {
    const stock = await getStock();
    for (const i of items) {
      if (Object.hasOwn(stock, i.sku) && stock[i.sku] < i.qty) {
        const name = bySku.get(i.sku)?.name || i.sku;
        const left = stock[i.sku];
        return res.status(409).json({
          error: left > 0
            ? `Only ${left} of "${name}" in stock right now. Order fewer, or get in touch and we'll sort it.`
            : `"${name}" is out of stock right now. Get in touch and we'll let you know when it's back.`,
        });
      }
    }
  } catch (err) {
    console.error("dealer order: stock check failed; allowing:", err.message);
  }

  // Freight is quoted HERE, now, for this exact box and address — never taken
  // from the dealer's browser.
  const q = await atCostQuote({ items, address: manualAddress(t), ruralDeclared: t.rural === true });
  if (q.status !== 200) return res.status(q.status).json(q.body);

  const made = await createDealerOrder(d.id, {
    deliver_to: {
      name: t.name, phone: t.phone, line1: t.line1, suburb: t.suburb, city: t.city,
      postcode: t.postcode, note: t.note, rural: t.rural === true,
    },
    lines: items.map((i) => ({ sku: i.sku, qty: i.qty })),
    shipping_ex_gst: q.body.shipping_ex_gst,
    shipping_source: q.body.source,
    shipping_carrier: q.body.carrier,
    shipping_quoted_cents: q.body.quoted_cents,
    customer_ref: b.customer_ref,
  });
  if (!made.ok) return res.status(400).json({ error: made.error });
  const o = made.order;

  // The order exists from here on. Failing to email the invoice must not look
  // like a failed order (the dealer would just place it again), and Craig must
  // still hear about it.
  let invoiceSent = false;
  try {
    const s = await sendTradeInvoice(o.invoice_number, { dealerId: d.id });
    invoiceSent = s.status === 200;
    if (!invoiceSent) throw new Error(s.body?.error || `status ${s.status}`);
  } catch (err) {
    console.error(`dealer order FLIP-${o.invoice_number}: invoice not sent:`, err?.message ?? err);
    await tellCraigInvoiceFailed(d, o).catch((e) => console.error("…and Craig's notice failed too:", e?.message ?? e));
  }

  return res.status(200).json({
    placed: true,
    number: invoiceNumber(o.invoice_number),
    invoice_number: o.invoice_number,
    amount_ex_gst: o.amount_ex_gst,
    gst_amount: o.gst_amount,
    amount_total: o.amount_total,
    shipping_ex_gst: q.body.shipping_ex_gst,
    invoice_sent: invoiceSent,
    invoice_to: d.email,
  });
}

async function tellCraigInvoiceFailed(d, o) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const n = invoiceNumber(o.invoice_number);
  await send(key, {
    to: recipients(),
    subject: `FLIP dealer order ${n}: ${d.business} (invoice NOT sent)`,
    text: `${d.business} placed ${n} on the dealer portal and it's on the pack list, but the invoice email to ${d.email} failed.\n\nSend it from FLIP Orders in the Betterservice app ("Email invoice").`,
    html: `<p>${escapeHtml(d.business)} placed <b>${n}</b> on the dealer portal and it's on the pack list, but the invoice email to ${escapeHtml(d.email)} failed.</p><p>Send it from FLIP Orders in the Betterservice app ("Email invoice").</p>`,
  });
}

async function orders(d, res) {
  const rows = await dealerOrders(d.id);
  return res.status(200).json({
    orders: (rows || []).map((o) => ({
      number: invoiceNumber(o.invoice_number),
      invoice_number: o.invoice_number,
      date: o.created_at,
      to: o.name,
      town: townOf(o.address?.formatted),
      items: (o.items || []).map((i) => `${i.qty} × ${i.name}`),
      total: o.amount_total,
      ref: o.customer_ref,
      status: o.packed_at ? "Sent" : "Being packed",
      tracking: o.tracking_number || null,
      due_date: o.due_date,
      paid: Boolean(o.paid_at),
    })),
  });
}

// "12 Example Road, Fairview, Hamilton 3214, New Zealand" -> "Hamilton"
function townOf(formatted) {
  const parts = String(formatted || "").split(",").map((s) => s.trim()).filter(Boolean);
  const cityPart = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";
  return cityPart.replace(/\s+\d{4}$/, "");
}

async function invoicePdf(req, res) {
  const dealer = await currentDealer(req);
  if (!dealer) return res.status(401).send("Please sign in to the dealer portal first.");
  const n = Number(req.query?.invoice ?? new URL(req.url, "http://x").searchParams.get("invoice"));
  const o = Number.isInteger(n) && n > 0 ? await tradeOrderByInvoice(n) : null;
  // Someone else's invoice looks exactly like one that doesn't exist.
  if (!o || o.dealer_id !== dealer.id) return res.status(404).send("No such invoice.");

  const inv = buildInvoice({ order: o, number: invoiceNumber(o.invoice_number), dateMs: Date.parse(o.created_at) || Date.now(), biz: business() });
  const pdf = await invoicePdfBase64(inv);
  if (!pdf) return res.status(500).send("Couldn't make the PDF. Please try again.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${invoicePdfName(inv)}"`);
  return res.status(200).send(Buffer.from(pdf, "base64"));
}
