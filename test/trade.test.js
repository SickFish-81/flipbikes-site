// Run with: npm test
//
// /api/trade — the owner-only side of FLIP trade orders.
//
// What these tests exist to hold, in order of how much it would hurt:
//   1. Nobody without an OWNER's token gets anything — not a cost, not an
//      invoice.
//   2. The carrier's raw cost never comes out of the PUBLIC quote endpoint.
//   3. A trade customer is never invoiced twice by a double-click.
//   4. A trade invoice's figures are the ones the database worked out, and
//      subtotal + GST = total to the cent.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import trade from "../api/trade.js";
import quote from "../api/quote.js";
import { buildInvoice, invoiceText } from "../api/_lib/invoice.js";

const OWNER = "owner-token";
const STAFF = "staff-token";

let sent;        // emails Resend was asked to send
let patches;     // PATCHes made to flip_orders
let emailLog;    // rows written to email_log
let rows;        // the fake flip_orders, by invoice number
let isOwnerCalls;

const TRADE = () => ({
  session_id: "trade_abc", invoice_number: 1009, created_at: "2026-11-11T00:00:00Z", channel: "trade",
  name: "End Customer", phone: "021 000 000", country: "NZ",
  address: { formatted: "12 Example Road, Fairview, Hamilton 3214, New Zealand", postcode: "3214",
             rural: false, note: "Leave at the shed", typed: true, collect: false },
  items: [
    { sku: "flip-standard", name: "FLIP Standard Bike Chock", qty: 2, unit_ex_gst: 9000, unit_amount: 10350 },
    { sku: "d-rings", name: "D Rings", qty: 4, unit_ex_gst: 1500, unit_amount: 1725 },
  ],
  // Exactly what create_flip_trade_order() produced for this order in the
  // migration dry run on 11 Nov: $252.05 + $37.81 GST = $289.86.
  amount_total: 28986, shipping_amount: 1386, amount_ex_gst: 25205, gst_amount: 3781, shipping_ex_gst: 1205,
  bill_to: { business: "Test Dealer Ltd", contact: "Sam", email: "accounts@example.co.nz",
             phone: "07 000 0000", address: "1 Test St, Hamilton 3200" },
  due_date: "2026-12-20", paid_at: null, emailed: false,
});

const WEB = () => ({ ...TRADE(), session_id: "cs_web", invoice_number: 1001, channel: "web", bill_to: null });

function res() {
  const r = { code: 0, body: undefined, headers: {} };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => ((r.body = b), r);
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  return r;
}

const call = async (handler, { method = "POST", token, origin, body } = {}) => {
  const r = res();
  await handler({
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
    body,
  }, r);
  return r;
};

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  sent = []; patches = []; emailLog = []; isOwnerCalls = 0;
  rows = { 1009: TRADE(), 1001: WEB() };

  process.env.SUPABASE_URL = "https://db.fake";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";
  process.env.RESEND_API_KEY = "re_fake";
  process.env.FLIP_GST_NUMBER = "123-456-789";
  process.env.FLIP_BANK_ACCOUNT = "12-3456-7890123-00";
  process.env.FLIP_ORDER_EMAILS = "craig@example.test";
  process.env.GSS_ACCESS_KEY = "key_fake";
  process.env.GSS_SITE_ID = "4242";
  process.env.GSS_BASE_URL = "https://carrier.fake";
  delete process.env.FLIP_TRADE_ORIGINS;
  delete process.env.FLIP_COLLECTING_CARRIERS;
  delete process.env.FLIP_FREIGHT_MARKUP;

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const auth = opts.headers?.Authorization || opts.headers?.authorization || "";

    if (u === "https://db.fake/rest/v1/rpc/is_owner") {
      isOwnerCalls++;
      // The database decides, as the caller. Only the owner's token is an owner.
      if (auth === `Bearer ${OWNER}`) return json(true);
      if (auth === `Bearer ${STAFF}`) return json(false);
      return json({ message: "JWT expired" }, 401);
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_orders?invoice_number=eq.")) {
      const n = Number(u.split("invoice_number=eq.")[1].split("&")[0]);
      return json(rows[n] ? [rows[n]] : []);
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_orders?session_id=eq.") && opts.method === "PATCH") {
      const sid = decodeURIComponent(u.split("session_id=eq.")[1]);
      const body = JSON.parse(opts.body);
      patches.push({ sid, ...body });
      for (const r of Object.values(rows)) if (r.session_id === sid) Object.assign(r, body);
      return new Response(null, { status: 204 });
    }
    if (u.startsWith("https://db.fake/rest/v1/email_log")) {
      if (opts.method === "POST") emailLog.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (u === "https://api.resend.com/emails") {
      sent.push(JSON.parse(opts.body));
      return json({ id: `email_${sent.length}` });
    }
    if (u === "https://carrier.fake/api/rates") {
      return json({
        Available: [{ QuoteId: "q1", CarrierName: "NZ Post Domestic", Charge: 12.05,
                      IsRuralDelivery: false, IsResidentialDelivery: true }],
        Suppressed: [], Rejected: [], ValidationErrors: {},
      });
    }
    throw new Error("unexpected fetch: " + u);
  };
});

const ADDRESS = { manual: { line1: "12 Example Road", suburb: "Fairview", city: "Hamilton", postcode: "3214" } };

// ---------------------------------------------------------------- who gets in

test("no token: refused, and the database is not even asked", async () => {
  const r = await call(trade, { body: { action: "quote", items: [{ sku: "flip-standard", qty: 1 }], address: ADDRESS } });
  assert.equal(r.code, 401);
  assert.equal(isOwnerCalls, 0);
  assert.equal(sent.length, 0);
});

test("a signed-in staff member who is not an owner: refused, for both actions", async () => {
  const q = await call(trade, { token: STAFF, body: { action: "quote", items: [{ sku: "flip-standard", qty: 1 }], address: ADDRESS } });
  assert.equal(q.code, 403);
  assert.equal(q.body.shipping_ex_gst, undefined, "no cost leaks in the refusal");
  const i = await call(trade, { token: STAFF, body: { action: "invoice", invoice_number: 1009 } });
  assert.equal(i.code, 403);
  assert.equal(sent.length, 0);
});

test("an expired or forged token: refused", async () => {
  const r = await call(trade, { token: "not-a-real-token", body: { action: "invoice", invoice_number: 1009 } });
  assert.equal(r.code, 403);
  assert.equal(sent.length, 0);
});

test("CORS opens only for the dashboard's origin, and is not what keeps anyone out", async () => {
  const pre = await call(trade, { method: "OPTIONS", origin: "https://betterservice.co.nz" });
  assert.equal(pre.code, 204);
  assert.equal(pre.headers["Access-Control-Allow-Origin"], "https://betterservice.co.nz");

  const evil = await call(trade, { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal(evil.headers["Access-Control-Allow-Origin"], undefined);

  // Even from the right origin, no token is still no.
  const r = await call(trade, { origin: "https://betterservice.co.nz", body: { action: "quote" } });
  assert.equal(r.code, 401);
});

// ---------------------------------------------------------------- the cost

test("the trade quote is the carrier's charge at cost: ex GST, no markup, no rounding", async () => {
  const r = await call(trade, { token: OWNER, body: { action: "quote", items: [{ sku: "flip-standard", qty: 1 }], address: ADDRESS } });
  assert.equal(r.code, 200);
  assert.equal(r.body.source, "carrier");
  assert.equal(r.body.carrier, "NZ Post Domestic");
  assert.equal(r.body.shipping_ex_gst, 1205, "$12.05 exactly as the carrier quoted it");
  assert.equal(r.headers["Cache-Control"], "no-store");
});

test("the PUBLIC quote for the same parcel never carries the cost", async () => {
  const r = await call(quote, { body: { items: [{ sku: "flip-standard", qty: 1 }], country: "NZ", address: ADDRESS } });
  assert.equal(r.code, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["address", "amount", "label", "rural", "ruralReason"]);
  assert.notEqual(r.body.amount, 1205, "the public number is a price, not the cost");
  assert.ok(!JSON.stringify(r.body).includes("1205"), "the carrier's figure appears nowhere in the public reply");
});

test("a trade quote prices more than the public cart's per-item limit", async () => {
  const pub = await call(quote, { body: { items: [{ sku: "flip-standard", qty: 30 }], country: "NZ", address: ADDRESS } });
  assert.equal(pub.code, 400, "the shop still sends 30 chocks to 'contact us'");
  const r = await call(trade, { token: OWNER, body: { action: "quote", items: [{ sku: "flip-standard", qty: 30 }], address: ADDRESS } });
  assert.equal(r.code, 200);
  assert.equal(r.body.source, "carrier");
});

// ---------------------------------------------------------------- the invoice

test("a trade invoice goes to the trade customer, ex-GST, with a due date and how to pay", async () => {
  const r = await call(trade, { token: OWNER, body: { action: "invoice", invoice_number: 1009 } });
  assert.equal(r.code, 200);
  assert.equal(r.body.sent, true);

  const customer = sent.find((m) => m.to.includes("accounts@example.co.nz"));
  assert.ok(customer, "the customer was emailed");
  assert.equal(customer.from, "FLIP Bike Chocks <noreply@flipbikes.co.nz>");
  assert.equal(customer.subject, "Tax invoice FLIP-1009 - FLIP Bike Chocks");
  assert.match(customer.text, /Items \(prices exclude GST\)/);
  assert.match(customer.text, /2 x FLIP Standard Bike Chock\s+\$90\.00 each = \$180\.00/);
  assert.match(customer.text, /Freight\s+\$12\.05/);
  assert.match(customer.text, /Subtotal \(excluding GST\)\s+\$252\.05/);
  assert.match(customer.text, /GST 15%\s+\$37\.81/);
  assert.match(customer.text, /TOTAL \(including GST\)\s+\$289\.86 NZD/);
  assert.match(customer.text, /Payment due 20\/12\/2026\. Please pay into 12-3456-7890123-00, reference FLIP-1009\./);
  assert.doesNotMatch(customer.text, /Paid by card/);
  // Dropship: billed to the dealer, delivered to their customer.
  assert.match(customer.text, /Bill to:\n  Test Dealer Ltd\n  Attn: Sam/);
  assert.match(customer.text, /Deliver to:\n  End Customer\n  12 Example Road/);
  assert.equal(customer.attachments?.[0]?.filename, "Tax-invoice-FLIP-1009.pdf");

  const craig = sent.find((m) => m.to.includes("craig@example.test"));
  assert.ok(craig, "Craig got his copy");
  assert.match(craig.subject, /FLIP trade order FLIP-1009: Test Dealer Ltd/);

  assert.deepEqual(patches, [{ sid: "trade_abc", emailed: true }]);
  assert.deepEqual(emailLog.map((e) => e.kind).sort(), ["flip_trade_invoice", "flip_trade_order"]);
});

test("a second click does not invoice the customer twice; resending has to be asked for", async () => {
  await call(trade, { token: OWNER, body: { action: "invoice", invoice_number: 1009 } });
  const before = sent.length;

  const again = await call(trade, { token: OWNER, body: { action: "invoice", invoice_number: 1009 } });
  assert.equal(again.code, 409);
  assert.equal(sent.length, before, "nothing sent on the second click");

  const resend = await call(trade, { token: OWNER, body: { action: "invoice", invoice_number: 1009, resend: true } });
  assert.equal(resend.code, 200);
  assert.ok(sent.length > before);
});

test("a website order cannot be re-invoiced through the trade path", async () => {
  // Given a bill-to email on purpose, so the ONLY thing that can stop this is
  // the channel check — not the missing-address check after it. Without that,
  // this test passed with the channel guard deleted.
  rows[1001].bill_to = { business: "Someone", email: "someone@example.co.nz" };
  const r = await call(trade, { token: OWNER, body: { action: "invoice", invoice_number: 1001 } });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /website order/);
  assert.equal(sent.length, 0);
});

test("with no bank account configured, the invoice still goes and says how to find out", async () => {
  delete process.env.FLIP_BANK_ACCOUNT;
  await call(trade, { token: OWNER, body: { action: "invoice", invoice_number: 1009 } });
  const customer = sent.find((m) => m.to.includes("accounts@example.co.nz"));
  assert.match(customer.text, /Payment due 20\/12\/2026\. Contact us for payment details, quoting FLIP-1009\./);
});

test("a paid trade order says so instead of asking for money", () => {
  const inv = buildInvoice({ order: { ...TRADE(), paid_at: "2026-11-11T01:00:00Z" }, number: "FLIP-1009",
                             dateMs: Date.parse("2026-11-11T00:00:00Z"), biz: { name: "FLIP", address: [], gstNumber: "123-456-789", email: "", phone: "", bankAccount: "x" } });
  assert.equal(inv.payment, "Paid, thank you.");
  assert.doesNotMatch(invoiceText(inv), /^Due:/m);
});

test("the trade invoice prints the database's figures, and they add up", () => {
  const inv = buildInvoice({ order: TRADE(), number: "FLIP-1009", dateMs: Date.parse("2026-11-11T00:00:00Z"),
                             biz: { name: "FLIP", address: [], gstNumber: "123-456-789", email: "", phone: "", bankAccount: "" } });
  assert.equal(inv.trade, true);
  assert.equal(inv.subtotal + inv.gst, inv.total);
  const goods = inv.lines.reduce((s, l) => s + l.total, 0);
  assert.equal(goods + inv.shipping, inv.subtotal, "lines + freight = subtotal");
  assert.equal(inv.shipTo.name, "End Customer");
  assert.equal(inv.buyer.name, "Test Dealer Ltd");
});

test("a collection prints no freight line and no delivery address", () => {
  const o = { ...TRADE(), shipping_ex_gst: 0, address: { collect: true, note: null }, name: "Test Dealer Ltd" };
  const inv = buildInvoice({ order: o, number: "FLIP-1009", dateMs: Date.now(),
                             biz: { name: "FLIP", address: [], gstNumber: "1", email: "", phone: "", bankAccount: "" } });
  const t = invoiceText(inv);
  assert.match(t, /Delivery: collected from our workshop/);
  assert.doesNotMatch(t, /Freight/);
});

// ------------------------------------------------------ booking the courier
//
// "book" spends money with the carrier, so the tests are about when it must
// NOT: not for a stranger, not twice, not for a box that already went on a
// hand-written ticket, not for a collection.

let shipments;
let storedLabel;
function withCarrier() {
  shipments = 0; storedLabel = null;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://db.fake/rest/v1/flip_orders?session_id=eq.") && (opts.method || "GET") === "GET") {
      const sid = decodeURIComponent(u.split("session_id=eq.")[1].split("&")[0]);
      return json(Object.values(rows).filter((r) => r.session_id === sid));
    }
    if (u === "https://carrier.fake/api/shipments") {
      shipments++;
      return json({ CarrierName: "NZ Post Domestic",
        Consignments: [{ ConsignmentId: 555, Connote: "NZP123", TrackingUrl: "https://track/NZP123", Charge: 12.05 }] });
    }
    if (u.startsWith("https://carrier.fake/api/labels")) return json(["iVBORw0KGgo="]);
    if (u === "https://db.fake/storage/v1/object/flip-labels/1009.png") {
      if (opts.method === "POST") { storedLabel = opts.body; return new Response(null, { status: 200 }); }
      return storedLabel ? new Response(storedLabel, { status: 200 }) : new Response("not found", { status: 404 });
    }
    return base(url, opts);
  };
}

test("book: a staff member who is not an owner can't book, and the carrier is not touched", async () => {
  withCarrier();
  const r = await call(trade, { token: STAFF, body: { action: "book", invoice_number: 1009 } });
  assert.equal(r.code, 403);
  assert.equal(shipments, 0);
});

test("book: an unpacked order is booked once, label filed, and a second press books nothing", async () => {
  withCarrier();
  Object.assign(rows[1009], { packed_at: null, consignment_id: null, tracking_number: null, label_fetched_at: null });

  const r = await call(trade, { token: OWNER, body: { action: "book", invoice_number: 1009 } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.connote, "NZP123");
  assert.equal(r.body.carrier, "NZ Post Domestic");
  assert.equal(shipments, 1);
  assert.equal(rows[1009].consignment_id, "555");
  assert.ok(rows[1009].label_fetched_at);

  const again = await call(trade, { token: OWNER, body: { action: "book", invoice_number: 1009 } });
  assert.equal(again.code, 200);
  assert.equal(again.body.already, true);
  assert.equal(shipments, 1, "a second press must not buy a second courier");

  const l = await call(trade, { token: OWNER, body: { action: "label", invoice_number: 1009 } });
  assert.equal(l.code, 200);
  assert.ok(l.body.png.length > 0);
});

test("book: an order already marked sent with no booking was hand-ticketed — refused", async () => {
  withCarrier();
  Object.assign(rows[1009], { packed_at: "2026-11-11T23:47:03Z", consignment_id: null });
  const r = await call(trade, { token: OWNER, body: { action: "book", invoice_number: 1009 } });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /ticketed by hand/);
  assert.equal(shipments, 0);
});

test("book: a collection is refused", async () => {
  withCarrier();
  Object.assign(rows[1009], { packed_at: null, consignment_id: null, address: { collect: true } });
  const r = await call(trade, { token: OWNER, body: { action: "book", invoice_number: 1009 } });
  assert.equal(r.code, 400);
  assert.equal(shipments, 0);
});

test("label: none filed yet is a 404, not a crash", async () => {
  withCarrier();
  const r = await call(trade, { token: OWNER, body: { action: "label", invoice_number: 1009 } });
  assert.equal(r.code, 404);
});
