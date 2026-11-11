// The customer's document for a paid order: a GST TAX INVOICE when Craig's GST
// number is configured, otherwise a plain order confirmation.
//
// Prices on the site are GST-inclusive, so the GST in an NZ sale is the total
// x 3/23 (15% on the ex-GST amount). Shown as a single figure for the whole
// invoice, rounded once, so it can't drift from per-line rounding.
//
// What IRD wants on a tax invoice (including over $1,000, the strictest case):
// the words "tax invoice", supplier name and GST number, date, a description
// and quantity of what was sold, the price including GST, and the buyer's name
// and address. All of those are here.

import { money } from "./catalog.js";
import { business, GST_ON_AUSTRALIA } from "./business.js";

export const gstFromInclusive = (cents) => Math.round((cents * 3) / 23);

export const invoiceNumber = (n) => "FLIP-" + String(n);

// What the document calls itself. Without a GST number nothing may be headed
// "Tax invoice" — a web order then gets an order confirmation, because it is
// already paid; a trade order gets a plain invoice, because it is still a bill.
export const invoiceTitle = (inv) =>
  inv.isTaxInvoice ? "TAX INVOICE" : inv.trade ? "INVOICE" : "ORDER CONFIRMATION";

export function nzDate(ms) {
  return new Date(ms).toLocaleDateString("en-NZ", {
    timeZone: "Pacific/Auckland", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// order: { name, country, address, items:[{name,qty,unit_amount}], amount_total, shipping_amount }
export function buildInvoice({ order, number, dateMs, biz = business() }) {
  if (order.channel === "trade") return buildTradeInvoice({ order, number, dateMs, biz });
  const total = order.amount_total ?? 0;
  const zeroRated = order.country === "AU" && !GST_ON_AUSTRALIA;
  const a = order.address || {};
  const buyerAddress = a.formatted
    ? a.formatted.split(", ")
    : [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(" "), a.postal_code, a.country].filter(Boolean);

  return {
    isTaxInvoice: Boolean(biz.gstNumber),
    number,
    date: nzDate(dateMs),
    supplier: biz,
    buyer: { name: order.name || "", address: buyerAddress },
    lines: order.items.map((i) => ({
      name: i.name, qty: i.qty, unit: i.unit_amount, total: i.unit_amount != null ? i.unit_amount * i.qty : null,
    })),
    shipping: order.shipping_amount ?? 0,
    total,
    gst: zeroRated ? 0 : gstFromInclusive(total),
    gstNote: zeroRated ? "Zero-rated: goods exported from New Zealand" : "Included in total",
  };
}

export function invoiceText(inv) {
  if (inv.trade) return tradeText(inv);
  const title = invoiceTitle(inv);
  const s = inv.supplier;
  const rows = inv.lines.map((l) =>
    `  ${l.qty} x ${l.name}` + (l.unit != null ? `   ${money(l.unit)} each = ${money(l.total)}` : ""));
  return [
    `${title}${inv.number ? "  " + inv.number : ""}`,
    `Date: ${inv.date}`,
    "",
    "From:",
    `  ${s.name}`,
    ...s.address.map((l) => "  " + l),
    ...(inv.isTaxInvoice ? [`  GST number: ${s.gstNumber}`] : []),
    `  ${s.email}  ${s.phone}`,
    "",
    "To:",
    `  ${inv.buyer.name}`,
    ...inv.buyer.address.map((l) => "  " + l),
    "",
    "Items (prices include GST):",
    ...rows,
    `  Shipping   ${money(inv.shipping)}`,
    "",
    `  TOTAL ${inv.isTaxInvoice ? "(including GST) " : ""}${money(inv.total)} NZD`,
    ...(inv.isTaxInvoice ? [`  GST: ${money(inv.gst)}  (${inv.gstNote.toLowerCase()})`] : []),
    "  Paid by card",
  ].join("\n");
}

export function invoiceHtml(inv, introHtml = "") {
  if (inv.trade) return tradeHtml(inv, introHtml);
  const title = invoiceTitle(inv);
  const s = inv.supplier;
  const td = "padding:6px 8px;border-bottom:1px solid #ddd;";
  const rows = inv.lines.map((l) =>
    `<tr><td style="${td}">${esc(l.name)}</td><td style="${td}text-align:center">${l.qty}</td>` +
    `<td style="${td}text-align:right">${l.unit != null ? money(l.unit) : ""}</td>` +
    `<td style="${td}text-align:right">${l.total != null ? money(l.total) : ""}</td></tr>`).join("");
  const lines = (arr) => arr.map(esc).join("<br>");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px">
${introHtml}
<h2 style="margin:16px 0 4px">${title}</h2>
<p style="margin:0 0 16px">${inv.number ? "Invoice no. <b>" + esc(inv.number) + "</b><br>" : ""}Date: ${esc(inv.date)}</p>
<table style="width:100%;margin-bottom:16px"><tr>
<td style="vertical-align:top;width:50%"><b>From</b><br>${esc(s.name)}<br>${lines(s.address)}${s.address.length ? "<br>" : ""}${inv.isTaxInvoice ? "GST number: " + esc(s.gstNumber) + "<br>" : ""}${esc(s.email)}<br>${esc(s.phone)}</td>
<td style="vertical-align:top;width:50%"><b>To</b><br>${esc(inv.buyer.name)}<br>${lines(inv.buyer.address)}</td></tr></table>
<table style="width:100%;border-collapse:collapse"><tr style="background:#f3f3f3"><th style="${td}text-align:left">Item</th><th style="${td}">Qty</th><th style="${td}text-align:right">Each</th><th style="${td}text-align:right">Total</th></tr>
${rows}
<tr><td style="${td}" colspan="3">Shipping</td><td style="${td}text-align:right">${money(inv.shipping)}</td></tr>
<tr><td style="padding:8px" colspan="3"><b>Total ${inv.isTaxInvoice ? "(including GST) " : ""}NZD</b></td><td style="padding:8px;text-align:right"><b>${money(inv.total)}</b></td></tr>
${inv.isTaxInvoice ? `<tr><td style="padding:0 8px 8px" colspan="3">GST (${esc(inv.gstNote.toLowerCase())})</td><td style="padding:0 8px 8px;text-align:right">${money(inv.gst)}</td></tr>` : ""}
</table>
<p style="color:#666;margin-top:8px">Prices include GST. Paid by card.</p>
</div>`;
}

// ======================================================== trade invoices
//
// A trade order's invoice. Three things differ from a web order's, and each is
// a reason this is a separate builder rather than a flag sprinkled through the
// one above:
//
//   PRICES EXCLUDE GST. Trade buyers are quoted ex-GST and expect to see it,
//   so the lines are ex-GST and the invoice shows subtotal, GST and total.
//
//   THE MONEY IS NOT RE-DERIVED. create_flip_trade_order() worked out the
//   ex-GST total, the GST and the total once, and those are the figures the
//   reports already summed. This prints them. Doing the arithmetic a second
//   time here is how an invoice ends up a cent away from the ledger.
//
//   IT IS A BILL, NOT A RECEIPT. A web order is paid before it exists; a trade
//   order usually is not. So there is a due date and a way to pay, where the
//   web invoice says "Paid by card".
//
// And one that matters for dropship: who PAYS and where it GOES can differ, so
// both are printed — Bill to the trade customer, Deliver to their customer.

function buildTradeInvoice({ order, number, dateMs, biz }) {
  const bill = order.bill_to || {};
  const a = order.address || {};
  // due_date is a plain calendar date, and a calendar date has no timezone —
  // so it is reformatted as text and never turned into a moment in time.
  //
  // The first version did `Date.parse(d + "T12:00:00Z")` with a comment
  // claiming noon UTC "keeps it on the same NZ day". It does not: New Zealand
  // is 13 hours AHEAD in summer, so noon UTC is 1am the next day here, and an
  // invoice due on 20 December said 21 December. Caught by a test, 11 Nov.
  const plainDate = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
  };
  const paid = Boolean(order.paid_at);
  const due = plainDate(order.due_date);

  return {
    trade: true,
    isTaxInvoice: Boolean(biz.gstNumber),
    number,
    date: nzDate(dateMs),
    dueDate: due,
    // The dealer's own order or PO number. Their accounts team matches our
    // invoice to their purchase order by it, so it goes on the invoice.
    yourRef: order.customer_ref || null,
    paid,
    supplier: biz,
    buyer: {
      name: bill.business || "",
      contact: bill.contact || "",
      address: splitAddress(bill.address),
    },
    shipTo: a.collect
      ? { collect: true, name: "", address: [] }
      : { collect: false, name: order.name || "", address: splitAddress(a.formatted) },
    lines: (order.items || []).map((i) => ({
      name: i.name,
      qty: i.qty,
      unit: i.unit_ex_gst ?? null,
      total: i.unit_ex_gst != null ? i.unit_ex_gst * i.qty : null,
    })),
    shipping: order.shipping_ex_gst ?? 0,
    subtotal: order.amount_ex_gst ?? 0,
    gst: order.gst_amount ?? 0,
    total: order.amount_total ?? 0,
    gstNote: "15%",
    payment: paymentLine({ paid, due, bank: biz.bankAccount, number }),
  };
}

const splitAddress = (s) => String(s || "").split(/\s*(?:,|\n)\s*/).filter(Boolean);

function paymentLine({ paid, due, bank, number }) {
  if (paid) return "Paid, thank you.";
  const when = due ? `Payment due ${due}.` : "Payment due on receipt.";
  // No account configured: still send the invoice, and say how to find out,
  // rather than print a blank where the bank number should be.
  return bank
    ? `${when} Please pay into ${bank}, reference ${number}.`
    : `${when} Contact us for payment details, quoting ${number}.`;
}

// The freight line is left off only when the customer collects and nothing
// was charged for it — "Freight $0.00" on a collection reads like a mistake.
const showFreight = (inv) => !(inv.shipTo.collect && !inv.shipping);

function tradeText(inv) {
  const s = inv.supplier;
  const rows = inv.lines.map((l) =>
    `  ${l.qty} x ${l.name}` + (l.unit != null ? `   ${money(l.unit)} each = ${money(l.total)}` : ""));
  return [
    `${invoiceTitle(inv)}  ${inv.number}`,
    `Date: ${inv.date}`,
    ...(inv.dueDate && !inv.paid ? [`Due: ${inv.dueDate}`] : []),
    ...(inv.yourRef ? [`Your ref: ${inv.yourRef}`] : []),
    "",
    "From:",
    `  ${s.name}`,
    ...s.address.map((l) => "  " + l),
    ...(inv.isTaxInvoice ? [`  GST number: ${s.gstNumber}`] : []),
    `  ${s.email}  ${s.phone}`,
    "",
    "Bill to:",
    `  ${inv.buyer.name}`,
    ...(inv.buyer.contact ? [`  Attn: ${inv.buyer.contact}`] : []),
    ...inv.buyer.address.map((l) => "  " + l),
    "",
    ...(inv.shipTo.collect
      ? ["Delivery: collected from our workshop", ""]
      : ["Deliver to:", `  ${inv.shipTo.name}`, ...inv.shipTo.address.map((l) => "  " + l), ""]),
    "Items (prices exclude GST):",
    ...rows,
    ...(showFreight(inv) ? [`  Freight   ${money(inv.shipping)}`] : []),
    "",
    `  Subtotal (excluding GST)   ${money(inv.subtotal)}`,
    `  GST ${inv.gstNote}   ${money(inv.gst)}`,
    `  TOTAL (including GST)   ${money(inv.total)} NZD`,
    "",
    inv.payment,
  ].join("\n");
}

function tradeHtml(inv, introHtml = "") {
  const s = inv.supplier;
  const td = "padding:6px 8px;border-bottom:1px solid #ddd;";
  const lines = (arr) => arr.map(esc).join("<br>");
  const rows = inv.lines.map((l) =>
    `<tr><td style="${td}">${esc(l.name)}</td><td style="${td}text-align:center">${l.qty}</td>` +
    `<td style="${td}text-align:right">${l.unit != null ? money(l.unit) : ""}</td>` +
    `<td style="${td}text-align:right">${l.total != null ? money(l.total) : ""}</td></tr>`).join("");
  const shipTo = inv.shipTo.collect
    ? "Collected from our workshop"
    : `${esc(inv.shipTo.name)}<br>${lines(inv.shipTo.address)}`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px">
${introHtml}
<h2 style="margin:16px 0 4px">${invoiceTitle(inv)}</h2>
<p style="margin:0 0 16px">Invoice no. <b>${esc(inv.number)}</b><br>Date: ${esc(inv.date)}${inv.dueDate && !inv.paid ? "<br>Due: <b>" + esc(inv.dueDate) + "</b>" : ""}${inv.yourRef ? "<br>Your ref: <b>" + esc(inv.yourRef) + "</b>" : ""}</p>
<table style="width:100%;margin-bottom:16px"><tr>
<td style="vertical-align:top;width:34%"><b>From</b><br>${esc(s.name)}<br>${lines(s.address)}${s.address.length ? "<br>" : ""}${inv.isTaxInvoice ? "GST number: " + esc(s.gstNumber) + "<br>" : ""}${esc(s.email)}<br>${esc(s.phone)}</td>
<td style="vertical-align:top;width:33%"><b>Bill to</b><br>${esc(inv.buyer.name)}${inv.buyer.contact ? "<br>Attn: " + esc(inv.buyer.contact) : ""}${inv.buyer.address.length ? "<br>" + lines(inv.buyer.address) : ""}</td>
<td style="vertical-align:top;width:33%"><b>Deliver to</b><br>${shipTo}</td></tr></table>
<p style="color:#666;margin:0 0 6px">Prices exclude GST.</p>
<table style="width:100%;border-collapse:collapse"><tr style="background:#f3f3f3"><th style="${td}text-align:left">Item</th><th style="${td}">Qty</th><th style="${td}text-align:right">Each</th><th style="${td}text-align:right">Total</th></tr>
${rows}
${showFreight(inv) ? `<tr><td style="${td}" colspan="3">Freight</td><td style="${td}text-align:right">${money(inv.shipping)}</td></tr>` : ""}
<tr><td style="padding:8px 8px 2px" colspan="3">Subtotal (excluding GST)</td><td style="padding:8px 8px 2px;text-align:right">${money(inv.subtotal)}</td></tr>
<tr><td style="padding:2px 8px" colspan="3">GST ${esc(inv.gstNote)}</td><td style="padding:2px 8px;text-align:right">${money(inv.gst)}</td></tr>
<tr><td style="padding:8px" colspan="3"><b>Total (including GST) NZD</b></td><td style="padding:8px;text-align:right"><b>${money(inv.total)}</b></td></tr>
</table>
<p style="margin-top:12px"><b>${esc(inv.payment)}</b></p>
</div>`;
}

