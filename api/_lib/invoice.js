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

export function nzDate(ms) {
  return new Date(ms).toLocaleDateString("en-NZ", {
    timeZone: "Pacific/Auckland", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// order: { name, country, address, items:[{name,qty,unit_amount}], amount_total, shipping_amount }
export function buildInvoice({ order, number, dateMs, biz = business() }) {
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
  const title = inv.isTaxInvoice ? "TAX INVOICE" : "ORDER CONFIRMATION";
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
  const title = inv.isTaxInvoice ? "TAX INVOICE" : "ORDER CONFIRMATION";
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
