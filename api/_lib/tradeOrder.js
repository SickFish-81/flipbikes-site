// The two things a trade order needs from flipbikes.co.nz, shared by Craig's
// door (/api/trade, owner token) and the dealers' (/api/dealer, portal
// session): what the freight COSTS, and sending the invoice.
//
// Shared rather than copied so that a dealer's order and one Craig types in
// are quoted by the same arithmetic and invoiced by the same email. Who is
// allowed to ask is decided by the caller before it gets here.

import { priceOrder } from "./order.js";
import { tradeOrderByInvoice, patchOrder } from "./db.js";
import { business } from "./business.js";
import { money } from "./catalog.js";
import { buildInvoice, invoiceText, invoiceHtml, invoiceNumber, invoiceTitle } from "./invoice.js";
import { invoicePdfBase64, invoicePdfName } from "./invoicePdf.js";
import { sendLogged, recipients, REPLY_TO } from "./mail.js";

// The sender a trade customer sees. Same verified address as the web shop's
// mail, but a business is writing to a business, not "the website".
export const TRADE_FROM = "FLIP Bike Chocks <noreply@flipbikes.co.nz>";

// The database caps a trade line at 1000; the quote must not refuse what the
// order would accept.
export const TRADE_MAX_QTY = 1000;

// ------------------------------------------------------------------ quote
//
// What the freight would COST: the carrier's own quote, excluding GST, with no
// markup. Returns { status, body } for the caller to send.
export async function atCostQuote({ items, address, ruralDeclared }) {
  const o = await priceOrder({
    items,
    country: "NZ",
    address,
    declaredRural: ruralDeclared === true,
    maxQty: TRADE_MAX_QTY,
  });
  if (o.error) return { status: o.status || 400, body: { error: o.error } };
  const s = o.shipping;

  if (s.source === "carrier" && typeof s.exGstCents === "number") {
    // The carrier's Charge, excluding GST, untouched. The website's markup and the
    // rounding to 50c exist on the web price because a carrier re-weighs a box
    // and bills the difference later; at cost, that difference is Craig's.
    return {
      status: 200,
      body: {
        shipping_ex_gst: s.exGstCents,
        source: "carrier",
        carrier: s.carrier,
        quoted_cents: s.exGstCents,
        rural: s.rural,
        ruralReason: s.ruralReason,
        address: { formatted: o.address.formatted },
      },
    };
  }

  // The carrier did not answer. What the table gives is the website's retail
  // freight, GST included — NOT a cost. Converted to ex-GST so everything deals
  // in one unit, and labelled, so nobody mistakes a price for a cost.
  return {
    status: 200,
    body: {
      shipping_ex_gst: Math.round(s.amount / 1.15),
      source: "table",
      carrier: null,
      quoted_cents: null,
      rural: s.rural,
      ruralReason: s.ruralReason,
      address: { formatted: o.address.formatted },
      warning: "The courier didn't quote this address, so this is the website's freight table, not a courier cost. Check it against a docket before charging.",
    },
  };
}

// ---------------------------------------------------------------- invoice
//
// Build the trade invoice for an order and email it to whoever pays, with
// Craig's copy. Returns { status, body }.
//
// `dealerId`, when given, must match the order's dealer — the portal passes
// it so a dealer can only ever trigger the invoice for their own order.
export async function sendTradeInvoice(invoiceNo, { resend = false, dealerId = null } = {}) {
  const n = Number(invoiceNo);
  if (!Number.isInteger(n) || n < 1) return { status: 400, body: { error: "Which invoice?" } };

  const order = await tradeOrderByInvoice(n);
  if (!order) return { status: 404, body: { error: `No order FLIP-${n}.` } };
  if (dealerId && order.dealer_id !== dealerId) return { status: 404, body: { error: `No order FLIP-${n}.` } };
  // A web order's invoice went at checkout, from the webhook, to the person who
  // paid. Re-sending it from here would build it as a trade invoice it isn't.
  if (order.channel !== "trade") {
    return { status: 400, body: { error: "That is a website order; its invoice was sent when it was paid." } };
  }
  // A double-click must not invoice a customer twice. Sending again is a
  // deliberate act, so it has to be asked for.
  if (order.emailed && resend !== true) {
    return { status: 409, body: { error: "That invoice has already been sent.", already: true } };
  }

  const to = order.bill_to?.email;
  if (!to) return { status: 400, body: { error: "This order has no email address to send the invoice to." } };

  const key = process.env.RESEND_API_KEY;
  if (!key) return { status: 503, body: { error: "Email isn't configured, so the invoice wasn't sent." } };

  const biz = business();
  if (!biz.gstNumber) console.error(`trade invoice FLIP-${n}: no FLIP_GST_NUMBER, so it goes as a plain INVOICE that still charges GST.`);
  if (!biz.bankAccount && !order.paid_at) console.error(`trade invoice FLIP-${n}: no FLIP_BANK_ACCOUNT, so it asks the customer to get in touch for payment details.`);

  const inv = buildInvoice({
    order,
    number: invoiceNumber(order.invoice_number),
    dateMs: Date.parse(order.created_at) || Date.now(),
    biz,
  });

  // Never fatal, as on the web: an invoice without its attachment is a
  // nuisance; an invoice that never goes because the PDF threw is worse.
  const pdf = await invoicePdfBase64(inv);
  const attachments = pdf ? [{ filename: invoicePdfName(inv), content: pdf }] : [];

  const who = order.bill_to.contact || order.bill_to.business || "there";
  const kindWord = inv.isTaxInvoice ? "tax invoice" : "invoice";
  const intro = `<p>Hi ${escapeHtml(who)},</p><p>Thanks for your order. Your ${kindWord} is below${pdf ? " and attached as a PDF" : ""}.</p>`;

  await sendLogged(key, {
    kind: "flip_trade_invoice",
    sessionId: order.session_id,
    from: TRADE_FROM,
    to,
    subject: `${inv.isTaxInvoice ? "Tax invoice" : "Invoice"} ${inv.number} - FLIP Bike Chocks`,
    text: `Hi ${who},\n\nThanks for your order. Your ${kindWord} is below${pdf ? " and attached as a PDF" : ""}.\n\n` + invoiceText(inv),
    html: invoiceHtml(inv, intro),
    reply_to: REPLY_TO,
    attachments,
  });

  // Recorded the moment the CUSTOMER'S copy is accepted, before Craig's copy
  // is tried. If Craig's then fails, a retry must not send the customer a
  // second invoice — it is already theirs.
  await patchOrder(order.session_id, { emailed: true });

  const online = order.placed_via === "portal";
  let copied = true;
  try {
    await sendLogged(key, {
      kind: online ? "flip_dealer_order" : "flip_trade_order",
      sessionId: order.session_id,
      to: recipients(),
      subject: online
        ? `FLIP dealer order ${inv.number}: ${order.bill_to.business} (placed online)`
        : `FLIP trade order ${inv.number}: ${order.bill_to.business}`,
      text: craigText(order, inv, to, pdf, online),
      reply_to: to,
      attachments,
    });
  } catch (err) {
    copied = false;
    console.error(`trade invoice FLIP-${n}: customer's copy sent; Craig's copy failed:`, err?.message ?? err);
  }

  return { status: 200, body: { sent: true, to, number: inv.number, pdf: Boolean(pdf), copied } };
}

function craigText(order, inv, to, pdf, online) {
  const a = order.address || {};
  return [
    ...(online
      ? [`${order.bill_to.business} placed this order themselves on the dealer portal. It is on the pack list now.`, ""]
      : []),
    `${invoiceTitle(inv)} ${inv.number} has gone to ${order.bill_to.business} (${to}).`,
    ...(order.customer_ref ? [`Their reference: ${order.customer_ref}`] : []),
    "",
    a.collect ? "Delivery: customer collects from the workshop." : `Deliver to: ${order.name}, ${a.formatted}`,
    ...(a.note ? [`Note: ${a.note}`] : []),
    "",
    ...inv.lines.map((l) => `  ${l.qty} x ${l.name}`),
    "",
    `Total ${money(inv.total)} incl GST (${money(inv.subtotal)} + ${money(inv.gst)} GST).`,
    inv.payment,
    ...(pdf ? [] : ["", "(The PDF could not be generated, so the customer got the invoice in the email body only.)"]),
  ].join("\n");
}

export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
