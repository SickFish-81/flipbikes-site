// Run with: npm test   (Node 20+; no dependencies)
// Every outside service (Stripe, Resend, Supabase) is replaced by a fake
// fetch, so nothing here touches the network or any real account.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import checkout from "../api/checkout.js";
import shop from "../api/shop.js";
import quote from "../api/quote.js";
import suggest from "../api/address-suggest.js";
import webhook, { verifySignature, itemsFromMetadata } from "../api/stripe-webhook.js";
import { gstFromInclusive } from "../api/_lib/invoice.js";

const calls = [];
let fakeStock;     // what the fake DB's flip_stock holds
let orders;        // what the fake DB's flip_orders holds
let stripeStatus;  // status the fake Stripe returns
let places;        // what the fake Google Places knows, by place id
let invSeq;        // the fake database's invoice-number counter

function res() {
  const r = { code: 0, body: undefined, headers: {} };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => ((r.body = b), r);
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  return r;
}

beforeEach(() => {
  calls.length = 0;
  fakeStock = { "flip-g3": 5, "d-rings": 1 };
  orders = {};
  stripeStatus = 200;
  invSeq = 1000;
  delete process.env.FLIP_GST_NUMBER; delete process.env.FLIP_BUSINESS_NAME; delete process.env.FLIP_BUSINESS_ADDRESS;
  places = {
    place_1: { formattedAddress: "12 Smith Rd, Te Awamutu 3800, New Zealand", addressComponents: [
      { types: ["street_number"], longText: "12" }, { types: ["route"], longText: "Smith Road" },
      { types: ["locality"], longText: "Te Awamutu" }, { types: ["postal_code"], longText: "3800" },
      { types: ["country"], longText: "New Zealand", shortText: "NZ" } ] },
    place_south: { formattedAddress: "5 Beach St, Queenstown 9300, New Zealand", addressComponents: [
      { types: ["street_number"], longText: "5" }, { types: ["route"], longText: "Beach Street" },
      { types: ["locality"], longText: "Queenstown" }, { types: ["postal_code"], longText: "9300" },
      { types: ["country"], longText: "New Zealand", shortText: "NZ" } ] },
    place_au: { formattedAddress: "1 George St, Sydney NSW 2000, Australia", addressComponents: [
      { types: ["locality"], longText: "Sydney" }, { types: ["postal_code"], longText: "2000" },
      { types: ["country"], longText: "Australia", shortText: "AU" } ] },
    place_nopost: { formattedAddress: "Somewhere, New Zealand", addressComponents: [{ types: ["country"], longText: "New Zealand", shortText: "NZ" }] },
  };
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  process.env.RESEND_API_KEY = "re_fake";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";
  delete process.env.GOOGLE_MAPS_API_KEY; // each test opts in

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });

    if (u.startsWith("https://api.stripe.com/")) {
      return stripeStatus === 200 ? json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }) : json({ error: "nope" }, stripeStatus);
    }
    if (u.startsWith("https://api.resend.com/")) return json({ id: "email_1" });
    if (u === "https://places.googleapis.com/v1/places:autocomplete") {
      return json({ suggestions: [{ placePrediction: { placeId: "place_1", text: { text: "12 Smith Road, Te Awamutu, New Zealand" } } }, { queryPrediction: {} }] });
    }
    if (u.startsWith("https://places.googleapis.com/v1/places/")) {
      const id = decodeURIComponent(u.split("/places/")[1].split("?")[0]);
      return json(places[id] ?? {}, places[id] ? 200 : 404);
    }
    if (u.includes("/rest/v1/flip_stock")) return json(Object.entries(fakeStock).map(([sku, qty]) => ({ sku, qty })));
    if (u.includes("/rest/v1/rpc/flip_take_stock")) {
      const { p_sku, p_qty } = JSON.parse(opts.body);
      fakeStock[p_sku] = Math.max((fakeStock[p_sku] ?? 0) - p_qty, 0);
      return json(fakeStock[p_sku]);
    }
    if (u.includes("/rest/v1/flip_orders")) {
      if (opts.method === "POST") {
        const o = JSON.parse(opts.body);
        orders[o.session_id] ??= { ...o, invoice_number: ++invSeq, stock_taken: false, emailed: false };
        return new Response("", { status: 201 });
      }
      if (opts.method === "PATCH") {
        const id = decodeURIComponent(u.split("session_id=eq.")[1]);
        Object.assign(orders[id], JSON.parse(opts.body));
        return new Response(null, { status: 204 });
      }
      const id = decodeURIComponent(u.split("session_id=eq.")[1].split("&")[0]);
      return json([orders[id]]);
    }
    throw new Error("unexpected fetch: " + u);
  };
});

// ---- helpers
const post = (handler, body, headers = {}) => {
  const r = res();
  return handler({ method: "POST", body, headers: { host: "flipbikes.co.nz", ...headers } }, r).then(() => r);
};
const get = (handler, query = {}) => { const r = res(); return handler({ method: "GET", query }, r).then(() => r); };
const stripeBody = () => new URLSearchParams(calls.find((c) => c.url.startsWith("https://api.stripe.com/")).body);

const manual = (postcode = "3800", extra = {}) => ({ manual: { line1: "12 Smith Road", city: "Te Awamutu", postcode, ...extra } });
const order = (over = {}) => ({
  items: [{ sku: "flip-g3", qty: 1 }], country: "NZ", name: "Pat Rider", email: "pat@example.com",
  phone: "021 123 456", address: manual(), ...over,
});
const shipAmount = () => stripeBody().get("shipping_options[0][shipping_rate_data][fixed_amount][amount]");

// ---- /api/checkout
test("checkout: builds a Stripe session from catalog prices, ignoring any price the browser sends", async () => {
  const r = await post(checkout, order({ items: [{ sku: "flip-g3", qty: 2, price: 1 }] }));
  assert.equal(r.code, 200);
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  const b = stripeBody();
  assert.equal(b.get("line_items[0][price_data][unit_amount]"), "17900"); // not 1
  assert.equal(b.get("line_items[0][quantity]"), "2");
  assert.equal(b.get("metadata[items]"), "flip-g3:2");
  assert.equal(b.get("customer_email"), "pat@example.com");
  assert.equal(b.get("shipping_address_collection[allowed_countries][0]"), null); // we collect it, not Stripe
});

test("checkout: delivery details ride along to Stripe and the webhook", async () => {
  await post(checkout, order({ note: "Leave at the shed" }));
  const b = stripeBody();
  assert.equal(b.get("metadata[name]"), "Pat Rider");
  assert.equal(b.get("metadata[phone]"), "021 123 456");
  assert.match(b.get("metadata[addr]"), /12 Smith Road, Te Awamutu, 3800/);
  assert.equal(b.get("metadata[postcode]"), "3800");
  assert.equal(b.get("metadata[note]"), "Leave at the shed");
  assert.equal(b.get("payment_intent_data[shipping][address][postal_code]"), "3800");
});

test("shipping: North vs South Island, extra items, Australia", async () => {
  await post(checkout, order());                                   // 1 item, North
  assert.equal(shipAmount(), "1200");
  calls.length = 0;
  await post(checkout, order({ address: manual("9300") }));        // 1 item, South
  assert.equal(shipAmount(), "1500");
  calls.length = 0;
  await post(checkout, order({ items: [{ sku: "flip-g3", qty: 3 }] })); // 3 items: +2 x $3
  assert.equal(shipAmount(), "1800");
  calls.length = 0;
  await post(checkout, order({ country: "AU", address: manual("2000", { city: "Sydney" }) }));
  assert.equal(shipAmount(), "6000");
  assert.equal(stripeBody().get("payment_intent_data[shipping][address][country]"), "AU");
});

test("shipping: rural surcharge is added for an RD address and flagged for Craig", async () => {
  await post(checkout, order({ address: manual("3874", { line1: "456 Hautapu Rd, RD 2" }) }));
  assert.equal(shipAmount(), "2200"); // 1200 + 1000 rural
  assert.equal(stripeBody().get("metadata[rural]"), "yes");
  assert.match(stripeBody().get("shipping_options[0][shipping_rate_data][display_name]"), /rural/);
});

test("shipping: Chatham Islands asks the customer to contact us", async () => {
  const r = await post(checkout, order({ address: manual("8942") }));
  assert.equal(r.code, 400);
  assert.match(r.body.error, /contact us/);
});

test("checkout: requires name, a sane email and a phone number", async () => {
  for (const over of [{ name: "" }, { email: "nope" }, { phone: "12" }, { address: undefined }, { address: { manual: { line1: "x" } } }]) {
    const r = await post(checkout, order(over));
    assert.equal(r.code, 400, JSON.stringify(over));
  }
  assert.equal(calls.filter((c) => c.url.startsWith("https://api.stripe.com/")).length, 0);
});

test("checkout: rejects unknown products, bad quantities, bad countries, empty carts", async () => {
  for (const over of [
    { items: [{ sku: "free-chock", qty: 1 }] },
    { items: [{ sku: "flip-g3", qty: 0 }] },
    { items: [{ sku: "flip-g3", qty: 1.5 }] },
    { items: [{ sku: "flip-g3", qty: 21 }] },
    { country: "US" },
    { items: [] },
  ]) {
    const r = await post(checkout, order(over));
    assert.equal(r.code, 400, JSON.stringify(over));
  }
  assert.equal(calls.filter((c) => c.url.startsWith("https://api.stripe.com/")).length, 0);
});

test("checkout: refuses when asking for more than is in stock, and says how many are left", async () => {
  const r = await post(checkout, order({ items: [{ sku: "d-rings", qty: 2 }] }));
  assert.equal(r.code, 409);
  assert.match(r.body.error, /only 1/);
});

test("checkout: a product with no stock row is treated as untracked, not sold out", async () => {
  const r = await post(checkout, order({ items: [{ sku: "tie-downs", qty: 3 }] }));
  assert.equal(r.code, 200);
});

test("checkout: fails open if the stock database is down", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes("/rest/v1/") ? new Response("down", { status: 500 }) : real(u, o));
  const r = await post(checkout, order());
  assert.equal(r.code, 200);
});

test("checkout: 503 with a friendly message until Stripe is configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const r = await post(checkout, order());
  assert.equal(r.code, 503);
});

test("checkout: a Stripe failure becomes a generic 502, never leaking Stripe's error", async () => {
  stripeStatus = 400;
  const r = await post(checkout, order());
  assert.equal(r.code, 502);
  assert.doesNotMatch(JSON.stringify(r.body), /nope/);
});

// ---- Google Places address lookup
test("address: a Google place is re-read on the server, so the browser can't pick its own postcode", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "gkey";
  // The browser claims a cheap postcode alongside a real South Island place id...
  const r = await post(checkout, order({ address: { placeId: "place_south", manual: { line1: "x", city: "y", postcode: "3800" } } }));
  assert.equal(r.code, 200);
  assert.equal(shipAmount(), "1500"); // ...but the SERVER's postcode (9300) decided the price
  assert.equal(stripeBody().get("metadata[postcode]"), "9300");
  assert.match(stripeBody().get("metadata[addr]"), /Queenstown/);
});

test("address: a place in the wrong country, or with no postcode, is refused", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "gkey";
  let r = await post(checkout, order({ address: { placeId: "place_au" } }));           // NZ order, AU address
  assert.equal(r.code, 400);
  assert.match(r.body.error, /isn't in New Zealand/);
  r = await post(checkout, order({ address: { placeId: "place_nopost" } }));
  assert.equal(r.code, 400);
  r = await post(checkout, order({ address: { placeId: "place_unknown" } }));
  assert.equal(r.code, 400);
});

test("address-suggest: proxies Google, keeps the key server-side, and degrades quietly", async () => {
  let r = await get(suggest, { q: "12 smith", country: "NZ" });
  assert.equal(r.body.enabled, false);                       // no key yet

  process.env.GOOGLE_MAPS_API_KEY = "gkey";
  r = await get(suggest, { q: "12 smith", country: "NZ", token: "tok" });
  assert.deepEqual(r.body.suggestions, [{ placeId: "place_1", text: "12 Smith Road, Te Awamutu, New Zealand" }]);
  const g = calls.find((c) => c.url.includes("places:autocomplete"));
  assert.deepEqual(JSON.parse(g.body).includedRegionCodes, ["nz"]);
  assert.doesNotMatch(JSON.stringify(r.body), /gkey/);

  r = await get(suggest, { q: "12", country: "NZ" });         // too short: no call
  assert.deepEqual(r.body.suggestions, []);
  r = await get(suggest, { q: "12 smith", country: "US" });   // unsupported country
  assert.deepEqual(r.body.suggestions, []);
});

// ---- /api/quote
test("quote: gives the cart page a live shipping price, using the same logic as checkout", async () => {
  const r = await post(quote, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ", address: manual("9300") });
  assert.equal(r.code, 200);
  assert.equal(r.body.amount, 1500);
  assert.equal(r.body.rural, false);
  const rr = await post(quote, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ", address: manual("3874", { line1: "9 Foo Rd RD 1" }) });
  assert.equal(rr.body.amount, 2200);
  assert.equal(rr.body.rural, true);
  assert.equal((await post(quote, { items: [], country: "NZ", address: manual() })).code, 400);
});

// ---- /api/shop
test("shop: reports disabled until Stripe is configured, enabled after, with stock", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  let r = res(); await shop({ method: "GET" }, r);
  assert.equal(r.body.enabled, false);

  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  r = res(); await shop({ method: "GET" }, r);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.addressSearch, false);
  assert.equal(r.body.products.find((p) => p.sku === "flip-g3").stock, 5);
  assert.equal(r.body.products.find((p) => p.sku === "tie-downs").stock, null);

  process.env.GOOGLE_MAPS_API_KEY = "gkey";
  r = res(); await shop({ method: "GET" }, r);
  assert.equal(r.body.addressSearch, true);
  assert.doesNotMatch(JSON.stringify(r.body), /gkey/);
});

// ---- webhook
const sign = (payload, secret = "whsec_fake", t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

test("signature: accepts a genuine one, rejects tampering, wrong secret, and stale timestamps", () => {
  const p = '{"a":1}';
  assert.equal(verifySignature(p, sign(p), "whsec_fake"), true);
  assert.equal(verifySignature(p + " ", sign(p), "whsec_fake"), false);
  assert.equal(verifySignature(p, sign(p, "other"), "whsec_fake"), false);
  assert.equal(verifySignature(p, sign(p, "whsec_fake", 1000), "whsec_fake"), false);
  assert.equal(verifySignature(p, undefined, "whsec_fake"), false);
});

test("metadata round-trips into named items", () => {
  const i = itemsFromMetadata("flip-g3:2,d-rings:4");
  assert.deepEqual(i.map((x) => [x.sku, x.qty, x.unit_amount]), [["flip-g3", 2, 17900], ["d-rings", 4, 2500]]);
});

const event = (extra = {}) =>
  JSON.stringify({
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_test_1", payment_intent: "pi_1", payment_status: "paid", amount_total: 36500,
      total_details: { amount_shipping: 1500 },
      metadata: { items: "flip-g3:2", country: "NZ", name: "Pat Rider", phone: "021123456", addr: "12 Smith Rd, Te Awamutu, 3800, New Zealand", postcode: "3800", rural: "yes", note: "Leave at the shed" },
      customer_details: { name: "Pat Rider", email: "pat@example.com", phone: "021123456" },
      collected_information: { shipping_details: { name: "Pat Rider", address: { line1: "1 Trailer Rd", city: "Te Awamutu", postal_code: "3800", country: "NZ" } } },
      ...extra,
    } },
  });

const deliver = (payload, sig = sign(payload)) => {
  const r = res();
  const req = { method: "POST", body: Buffer.from(payload), headers: { "stripe-signature": sig } };
  return webhook(req, r).then(() => r);
};
const emails = () => calls.filter((c) => c.url.startsWith("https://api.resend.com/")).map((c) => JSON.parse(c.body));

test("webhook: rejects a bad signature without touching stock or email", async () => {
  const r = await deliver(event(), "t=1,v1=bad");
  assert.equal(r.code, 400);
  assert.equal(fakeStock["flip-g3"], 5);
  assert.equal(emails().length, 0);
});

test("webhook: a paid order takes stock off, emails Craig and the customer", async () => {
  const r = await deliver(event());
  assert.equal(r.code, 200);
  assert.equal(fakeStock["flip-g3"], 3);
  const [craig, cust] = emails();
  assert.equal(craig.to[0], "craig@betterservice.co.nz");
  assert.match(craig.text, /2 x FLIP G3/);
  assert.match(craig.text, /12 Smith Rd/);
  assert.match(craig.text, /Rural delivery: YES/);
  assert.match(craig.text, /Leave at the shed/);
  assert.match(craig.text, /TOTAL PAID: \$365\.00/);
  assert.equal(cust.to[0], "pat@example.com");
  assert.match(cust.text, /payment has been received/);
});

test("webhook: Stripe delivering the same event twice does not double-take stock or double-email", async () => {
  const payload = event();
  await deliver(payload);
  await deliver(payload);
  assert.equal(fakeStock["flip-g3"], 3);
  assert.equal(emails().length, 2); // one to Craig, one to the customer — from the first delivery only
});

test("webhook: if email fails after stock was taken, the retry sends email but does not take stock again", async () => {
  const payload = event();
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).startsWith("https://api.resend.com/") ? new Response("boom", { status: 500 }) : real(u, o));
  let r = await deliver(payload);
  assert.equal(r.code, 500);              // makes Stripe retry
  assert.equal(fakeStock["flip-g3"], 3);

  globalThis.fetch = real;
  r = await deliver(payload);
  assert.equal(r.code, 200);
  assert.equal(fakeStock["flip-g3"], 3);  // not 1
  assert.equal(emails().length, 2);
});

test("webhook: warns Craig when an order leaves an item sold out", async () => {
  await deliver(event({ metadata: { items: "d-rings:1", country: "NZ" } }));
  assert.equal(fakeStock["d-rings"], 0);
  assert.match(emails()[0].text, /D Rings: OUT OF STOCK/);
});

test("webhook: ignores unrelated events and unpaid sessions", async () => {
  let r = await deliver(JSON.stringify({ type: "charge.refunded", data: { object: {} } }));
  assert.equal(r.code, 200);
  r = await deliver(event({ payment_status: "unpaid" }));
  assert.equal(r.code, 200);
  assert.equal(fakeStock["flip-g3"], 5);
});

// ---- GST tax invoice
const withGst = () => {
  process.env.FLIP_GST_NUMBER = "123-456-789";
  process.env.FLIP_BUSINESS_NAME = "Flip Bikes Ltd";
  process.env.FLIP_BUSINESS_ADDRESS = "556 Te Puke Highway|Te Puke 3187";
};

test("gst: 3/23 of a GST-inclusive total, rounded once", () => {
  assert.equal(gstFromInclusive(36500), 4761);  // $365.00 -> $47.61
  assert.equal(gstFromInclusive(2500), 326);
  assert.equal(gstFromInclusive(0), 0);
});

test("invoice: with a GST number the customer gets a proper tax invoice", async () => {
  withGst();
  await deliver(event());
  const cust = emails()[1];
  assert.match(cust.subject, /^Tax invoice FLIP-1001 /);
  for (const part of [/TAX INVOICE\s+FLIP-1001/, /GST number: 123-456-789/, /Flip Bikes Ltd/, /556 Te Puke Highway/,
                      /Pat Rider/, /12 Smith Rd/, /2 x FLIP G3 Bike Chock\s+\$179\.00 each = \$358\.00/,
                      /TOTAL \(including GST\) \$365\.00/, /GST: \$47\.61/, /Date: \d\d\/\d\d\/\d{4}/]) {
    assert.match(cust.text, part);
  }
  assert.match(cust.html, /TAX INVOICE/);
  assert.match(cust.html, /123-456-789/);
  assert.match(cust.html, /\$47\.61/);
  assert.doesNotMatch(emails()[0].text, /GST number is NOT set/);
});

test("invoice: without a GST number it is only an order confirmation, and Craig is told", async () => {
  await deliver(event());
  const [craig, cust] = emails();
  assert.match(cust.subject, /^Order confirmation /);
  assert.match(cust.text, /ORDER CONFIRMATION/);
  assert.doesNotMatch(cust.text, /TAX INVOICE/);
  assert.doesNotMatch(cust.text, /GST:/);
  assert.match(craig.text, /GST number is NOT set/);
});

test("invoice: numbers are sequential per order and survive a webhook retry unchanged", async () => {
  withGst();
  await deliver(event());                                   // order 1
  const other = event({ id: "cs_test_2" });
  await deliver(other);                                     // order 2
  assert.match(emails()[1].subject, /FLIP-1001/);
  assert.match(emails()[3].subject, /FLIP-1002/);

  // order 1's email fails, then Stripe retries: it must still be 1001, not 1003
  calls.length = 0; orders["cs_test_3"] = undefined; delete orders["cs_test_3"];
  const real = globalThis.fetch;
  const third = event({ id: "cs_test_3" });
  globalThis.fetch = async (u, o) => (String(u).startsWith("https://api.resend.com/") ? new Response("boom", { status: 500 }) : real(u, o));
  assert.equal((await deliver(third)).code, 500);
  globalThis.fetch = real;
  calls.length = 0;
  assert.equal((await deliver(third)).code, 200);
  assert.match(emails()[1].subject, /FLIP-1003/);
});

test("invoice: Australian orders show zero-rated GST, not 15%", async () => {
  withGst();
  await deliver(event({ metadata: { items: "flip-g3:1", country: "AU", name: "Sam", phone: "0400", addr: "1 George St, Sydney, 2000, Australia", postcode: "2000", rural: "no" } }));
  const cust = emails()[1];
  assert.match(cust.text, /GST: \$0\.00\s+\(zero-rated/);
});

test("invoice: customer-supplied text is escaped in the HTML email", async () => {
  withGst();
  await deliver(event({ metadata: { items: "flip-g3:1", country: "NZ", name: "<script>alert(1)</script>", phone: "021123456", addr: "1 A St, B, 3800, New Zealand", postcode: "3800", rural: "no" } }));
  const cust = emails()[1];
  assert.doesNotMatch(cust.html, /<script>/);
  assert.match(cust.html, /&lt;script&gt;/);
});
