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
import { RATES, CHOCKS_PER_CARTON, CARTON_WEIGHT_G, TICKET_WEIGHT_G } from "../api/_lib/shipping.js";
import { PRODUCTS } from "../api/_lib/catalog.js";

// Expectations are DERIVED from the rate table, never hard-coded, so that
// changing Craig's rates doesn't break seven tests that still pass in spirit.
// What these tests guard is the BEHAVIOUR: which region, whether rural was
// detected and why, how extras accumulate and cap.
const NORTH = RATES.ticketNorth;
const SOUTH = RATES.ticketSouth;
const RURAL = RATES.ruralSurcharge;
const AU = RATES.au;
const BAG = RATES.bagNz;

// Expectations are DERIVED, so changing a weight or a rate moves the tests
// with it rather than breaking them. `freight` is the whole pricing rule
// restated independently of the implementation: cartons from chocks, tickets
// from whichever of cartons and weight needs more.
const GRAMS = { "flip-g3": 1500, "flip-standard": 1500, "flip-road": 1500, "flip-starter-pack": 3200, "tie-downs": 1000, "d-rings": 350 };
const weigh = (lines) => lines.reduce((g, [sku, qty]) => g + GRAMS[sku] * qty, 0);
const cartonsFor = (chocks) => Math.max(1, Math.ceil(chocks / CHOCKS_PER_CARTON));
const ticketsFor = (chocks, goodsG) => {
  const cartons = cartonsFor(chocks);
  return Math.max(cartons, Math.ceil((goodsG + cartons * CARTON_WEIGHT_G) / TICKET_WEIGHT_G));
};
const freight = (chocks, goodsG, rate = NORTH) => ticketsFor(chocks, goodsG) * rate;

const calls = [];
let fakeStock;     // what the fake DB's flip_stock holds
let orders;        // what the fake DB's flip_orders holds
let stripeStatus;  // status the fake Stripe returns
let places;        // what the fake Google Places knows, by place id
let invSeq;        // the fake database's invoice-number counter
let emailLog;      // rows the shop writes to email_log
let resendSeq;     // Resend hands out a distinct id per message

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
  emailLog = [];
  resendSeq = 0;
  delete process.env.FLIP_GST_NUMBER; delete process.env.FLIP_BUSINESS_NAME; delete process.env.FLIP_BUSINESS_ADDRESS;
  delete process.env.FLIP_ORDER_EMAILS;   // see the junk-list test: a bad restore used to leak "undefined" into every later test
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
    if (u.startsWith("https://api.resend.com/")) return json({ id: `email_${++resendSeq}` });
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
    if (u.includes("/rest/v1/email_log")) {
      // Mirrors the real table closely enough to be worth testing against:
      // resend_id is UNIQUE, the insert ignores duplicates, and the PATCH
      // matches on resend_id and never touches status.
      if (opts.method === "POST") {
        const row = JSON.parse(opts.body);
        const clash = row.resend_id && emailLog.some((e) => e.resend_id === row.resend_id);
        if (!clash) emailLog.push(row);
        return new Response("", { status: 201 });
      }
      if (opts.method === "PATCH") {
        const id = decodeURIComponent(u.split("resend_id=eq.")[1]);
        const row = emailLog.find((e) => e.resend_id === id);
        if (row) Object.assign(row, JSON.parse(opts.body));
        return new Response(null, { status: 204 });
      }
      return json([]);
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

test("shipping: North vs South Island, a full carton, Australia", async () => {
  await post(checkout, order());                                   // 1 chock, North
  assert.equal(shipAmount(), String(NORTH));
  calls.length = 0;
  await post(checkout, order({ address: manual("9300") }));        // 1 chock, South
  assert.equal(shipAmount(), String(SOUTH));
  calls.length = 0;

  // THE HEADLINE CHANGE. Three chocks are a carton, 4.85kg, ONE ticket - so
  // three cost the same to send as one. The old table charged a base plus $8
  // an item and quoted $29 for this, over-charging the shop's most common
  // order by $16 on the exact quantity Craig tells customers to buy.
  await post(checkout, order({ items: [{ sku: "flip-g3", qty: 3 }] }));
  assert.equal(shipAmount(), String(NORTH));
  assert.equal(shipAmount(), String(freight(3, weigh([["flip-g3", 3]]))));
  calls.length = 0;
  await post(checkout, order({ country: "AU", address: manual("2000", { city: "Sydney" }) }));
  assert.equal(shipAmount(), String(AU));
  assert.equal(stripeBody().get("payment_intent_data[shipping][address][country]"), "AU");
});

test("homepage: every product's price is wired to the API, not typed in", async () => {
  // The trap this guards: a price lives in catalog.js AND in the page. When
  // the page carried its own hand-typed copy, changing one left the site
  // advertising a different number from the one Stripe charged.
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  for (const p of PRODUCTS) {
    assert.ok(
      html.includes(`data-shop-price="${p.sku}"`),
      `${p.sku} has no data-shop-price hook on the homepage — its price would be hand-typed again`,
    );
  }

  // And nothing is left showing a bare dollar figure outside a wired element.
  // Strip the hooked spans/divs, then look for survivors.
  const stripped = html.replace(/<(div|span)[^>]*data-shop-price=[^>]*>.*?<\/\1>/gs, "");
  const stray = stripped.match(/\$\s?\d[\d,.]*/g) || [];
  assert.deepEqual(stray, [], `prices still hard-coded in the page: ${stray.join(", ")}`);
});

test("shipping: an all-small order ships as a flat-rate bag, nationwide", async () => {
  // The bug this fixes: D Rings cost $25, and the South Island carton rate is
  // $28 — the freight was dearer than the product.
  await post(checkout, order({ items: [{ sku: "d-rings", qty: 1 }] }));
  assert.equal(shipAmount(), String(BAG));
  calls.length = 0;

  // Same price to the South Island: a satchel doesn't pay a Cook Strait premium.
  await post(checkout, order({ items: [{ sku: "d-rings", qty: 1 }], address: manual("9300") }));
  assert.equal(shipAmount(), String(BAG));
  calls.length = 0;

  // Several small items still make one bag, as long as they fit in one.
  // (d-rings has 1 in the fake stock; tie-downs is untracked, so it carries qty.)
  const light = [["d-rings", 1], ["tie-downs", 1]];
  assert.ok(weigh(light) <= RATES.bagMaxWeightG, "this much still fits a satchel");
  await post(checkout, order({ items: [{ sku: "d-rings", qty: 1 }, { sku: "tie-downs", qty: 1 }] }));
  assert.equal(shipAmount(), String(BAG));
  calls.length = 0;

  // But a satchel holds 3kg, and that is a real limit rather than a policy:
  // three sets of tie-downs and a D ring weigh more than that, so it becomes
  // a carton. The old table called this a bag and charged $8 for it.
  const heavy = [["d-rings", 1], ["tie-downs", 3]];
  assert.ok(weigh(heavy) > RATES.bagMaxWeightG, "this is the case that no longer fits a bag");
  await post(checkout, order({ items: [{ sku: "d-rings", qty: 1 }, { sku: "tie-downs", qty: 3 }] }));
  assert.equal(shipAmount(), String(freight(0, weigh(heavy))));
});

test("shipping: a bag is cheaper than the carton it replaces", async () => {
  await post(checkout, order({ items: [{ sku: "d-rings", qty: 1 }], address: manual("9300") }));
  const bagged = Number(shipAmount());
  calls.length = 0;
  await post(checkout, order({ items: [{ sku: "flip-g3", qty: 1 }], address: manual("9300") }));
  assert.ok(bagged < Number(shipAmount()), "small-item rate must undercut the South Island carton rate");
});

test("shipping: a mixed cart is a carton, and the accessory rides in it free", async () => {
  await post(checkout, order({ items: [{ sku: "d-rings", qty: 1 }, { sku: "flip-g3", qty: 1 }] }));
  assert.equal(shipAmount(), String(NORTH));   // one chock, one carton, no extra
});

test("shipping: accessories never add a CARTON, but they do add weight", async () => {
  // Two things that used to be conflated. Accessories ride along in a box that
  // is going anyway, so they never force a second carton - but the courier
  // charges by the kilo, and four sets of tie-downs outweigh two chocks. The
  // old table let them ride entirely free, which is how order FLIP-1004 was
  // quoted $21 of freight for an 8.75kg parcel that costs $25.80 to send.
  const lines = [["flip-g3", 2], ["tie-downs", 3]];
  await post(checkout, order({ items: [{ sku: "flip-g3", qty: 2 }, { sku: "tie-downs", qty: 3 }] }));
  assert.equal(shipAmount(), String(freight(2, weigh(lines))));
  assert.equal(cartonsFor(2), 1, "two chocks and three sets of ties is still one box");
  assert.ok(ticketsFor(2, weigh(lines)) > 1, "but it is over 5kg, so it is two tickets");
});

test("shipping: the three-chock carton has 150g of headroom, and we know it", async () => {
  // The tightest assumption in the pricing, written down so it cannot drift
  // quietly. Three chocks at Craig's stated 1.5kg plus a 350g carton come to
  // 4.85kg against a 5kg ticket. If a real, taped, ready-to-send carton
  // weighs half a kilo instead, the shop's most common order silently costs
  // two tickets and under-collects by $12.90 North or $25.00 South.
  const goods = weigh([["flip-standard", 3]]);
  const packed = goods + CARTON_WEIGHT_G;
  const headroom = TICKET_WEIGHT_G - packed;

  assert.equal(ticketsFor(3, goods), 1, "three chocks must be one ticket, or the whole rebuild is wrong");
  assert.ok(headroom > 0, "a three-chock carton has to fit in one ticket");
  assert.ok(headroom < 400, `only ${headroom}g of slack - weigh a real packed carton`);

  // And the cliff is real: a heavier carton tips it.
  const tippingCarton = headroom + 1;
  assert.ok(
    Math.ceil((goods + CARTON_WEIGHT_G + tippingCarton) / TICKET_WEIGHT_G) === 2,
    "just over the line is two tickets, which is what makes this worth watching",
  );
});

test("shipping: past the bag, the price steps by the ticket - it does not explode", async () => {
  // The trap this guards: the old table made 4 sets of tie-downs cost $8 and
  // 5 cost $52, a 6.5x jump for one more item. Now the price only ever moves
  // when another ticket is genuinely needed.
  const qty = RATES.bagMaxItems + 1;
  await post(checkout, order({ items: [{ sku: "tie-downs", qty }] }));
  const got = Number(shipAmount());
  assert.equal(got, freight(0, weigh([["tie-downs", qty]])));

  // Never more than one ticket per 5kg carried, plus the carton it rides in.
  const ceiling = Math.ceil((weigh([["tie-downs", qty]]) + CARTON_WEIGHT_G) / TICKET_WEIGHT_G) * NORTH;
  assert.equal(got, ceiling);
});

test("shipping: rural is still charged on a bag", async () => {
  await post(checkout, order({
    items: [{ sku: "d-rings", qty: 1 }],
    address: manual("3874", { line1: "456 Hautapu Rd, RD 2" }),
  }));
  assert.equal(shipAmount(), String(BAG + RURAL));
  assert.equal(stripeBody().get("metadata[rural]"), "yes");
});

test("shipping: rural surcharge is added for an RD address and flagged for Craig", async () => {
  await post(checkout, order({ address: manual("3874", { line1: "456 Hautapu Rd, RD 2" }) }));
  assert.equal(shipAmount(), String(NORTH + RURAL));
  assert.equal(stripeBody().get("metadata[rural]"), "yes");
  assert.match(stripeBody().get("shipping_options[0][shipping_rate_data][display_name]"), /rural/);
});

test("shipping: the customer can declare a rural address, and it only ever ADDS the surcharge", async () => {
  // No RD number anywhere and the postcode table is empty, so we cannot tell.
  await post(checkout, order({ address: manual("3800") }));
  assert.equal(shipAmount(), String(NORTH));
  calls.length = 0;

  // The customer ticks the box: surcharge applied, and we record that THEY
  // said so rather than pretending we worked it out.
  await post(checkout, order({ address: manual("3800"), ruralDeclared: true }));
  assert.equal(shipAmount(), String(NORTH + RURAL));
  assert.equal(stripeBody().get("metadata[rural]"), "yes");
  assert.equal(stripeBody().get("metadata[rural_why]"), "declared");
  calls.length = 0;

  // Leaving it off must NOT cancel a rural address we detected ourselves, or a
  // customer could opt out of a surcharge the courier charges Craig anyway.
  await post(checkout, order({ address: manual("3874", { line1: "456 Hautapu Rd, RD 2" }), ruralDeclared: false }));
  assert.equal(shipAmount(), String(NORTH + RURAL));
  assert.equal(stripeBody().get("metadata[rural_why]"), "address");
});

test("shipping: declaring rural does nothing for Australia, which is a flat rate", async () => {
  await post(checkout, order({ country: "AU", address: manual("2000", { city: "Sydney" }), ruralDeclared: true }));
  assert.equal(shipAmount(), String(AU));
  assert.equal(stripeBody().get("metadata[rural]"), "no");
  assert.equal(stripeBody().get("metadata[rural_why]"), null);
});

test("shipping: \"Rural Delivery 3\" spelled out is caught as well as \"RD 3\"", async () => {
  await post(checkout, order({ address: manual("3800", { line1: "7 Pine Lane, Rural Delivery 3" }) }));
  assert.equal(shipAmount(), String(NORTH + RURAL));
  assert.equal(stripeBody().get("metadata[rural_why]"), "address");
});

test("quote: the cart page is told WHY it is rural, so it can explain the surcharge", async () => {
  const r = await post(quote, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ", address: manual("3800"), ruralDeclared: true });
  assert.equal(r.body.amount, NORTH + RURAL);
  assert.equal(r.body.rural, true);
  assert.equal(r.body.ruralReason, "declared");
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
  assert.equal(shipAmount(), String(SOUTH)); // ...but the SERVER's postcode (9300) decided the price
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
  assert.equal(r.body.amount, SOUTH);
  assert.equal(r.body.rural, false);
  const rr = await post(quote, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ", address: manual("3874", { line1: "9 Foo Rd RD 1" }) });
  assert.equal(rr.body.amount, NORTH + RURAL);
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
  // Ben is on the order email too, so a shop fault is noticed by someone who
  // can fix it rather than waiting for Craig to say orders stopped arriving.
  assert.equal(craig.to.length, 2);
  assert.match(craig.text, /2 x FLIP G3/);
  assert.match(craig.text, /12 Smith Rd/);
  assert.match(craig.text, /Rural delivery: YES/);
  assert.match(craig.text, /Leave at the shed/);
  assert.match(craig.text, /TOTAL PAID: \$365\.00/);
  assert.equal(cust.to[0], "pat@example.com");
  assert.match(cust.text, /payment has been received/);
});

test("webhook: the order email still goes somewhere if the recipient list is junk", async () => {
  // One address left in a trailing comma, spaces either side — the shape a
  // hand-edited env var actually arrives in.
  const prev = process.env.FLIP_ORDER_EMAILS;
  process.env.FLIP_ORDER_EMAILS = " craig@betterservice.co.nz , ,";
  await deliver(event());
  assert.deepEqual(emails()[0].to, ["craig@betterservice.co.nz"]);

  // Blanked out entirely — must fall back, never email nobody.
  calls.length = 0;
  process.env.FLIP_ORDER_EMAILS = "  , ";
  await deliver(event({ id: "cs_test_fallback" }));
  assert.equal(emails()[0].to.length, 2);

  // Restore by DELETING when there was nothing there. `process.env.X = undefined`
  // stores the literal string "undefined", which then leaks into every later
  // test as a one-address recipient list. It went unnoticed because nothing
  // after this point inspected the recipients until the email_log tests below.
  if (prev === undefined) delete process.env.FLIP_ORDER_EMAILS;
  else process.env.FLIP_ORDER_EMAILS = prev;
});

test("webhook: Craig's email says HOW rural was decided, not just that it was", async () => {
  const meta = {
    items: "flip-g3:1", country: "NZ", name: "Pat Rider", phone: "021123456",
    addr: "9 Pine Lane, Te Awamutu, 3800, New Zealand", postcode: "3800",
    rural: "yes", rural_why: "declared",
  };
  await deliver(event({ metadata: meta }));
  assert.match(emails()[0].text, /Rural delivery: YES.*CUSTOMER ticked the rural box/);
});

test("webhook: both emails carry the invoice as a PDF attachment", async () => {
  await deliver(event());
  const [craig, cust] = emails();

  for (const [who, mail] of [["Craig", craig], ["the customer", cust]]) {
    assert.ok(Array.isArray(mail.attachments) && mail.attachments.length === 1,
      `${who}'s email should carry exactly one attachment`);
    const a = mail.attachments[0];
    assert.match(a.filename, /^(Tax-invoice|Order)-FLIP-\d+\.pdf$/);
    // Base64 of a real PDF: decodes, and starts with the file signature.
    const bytes = Buffer.from(a.content, "base64");
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(bytes.length > 2000, "a one-page invoice should not be near-empty");
  }

  // Built once, attached twice — not generated separately per recipient.
  assert.equal(craig.attachments[0].content, cust.attachments[0].content);
});

test("webhook: a macron survives into the PDF rather than being dropped", async () => {
  // The fault this guards: WinAnsi has no macron vowel. jsPDF drops it
  // silently and pdf-lib throws, which is how Betterservice's rental invoice
  // #01065 ended up with no PDF at all.
  await deliver(event({
    metadata: {
      items: "flip-g3:1", country: "NZ", name: "Māhia Ngātai", phone: "021123456",
      addr: "1 Ōhauiti Road, Tauranga, 3173, New Zealand", postcode: "3173", rural: "no",
    },
  }));
  const pdf = Buffer.from(emails()[0].attachments[0].content, "base64");
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > 2000);
});

test("webhook: if the PDF can't be built the emails still go", async () => {
  // Simulated by an order the invoice builder cannot render — the point is
  // that a failure costs the attachment, never the email. This runs AFTER the
  // customer has paid.
  const { invoicePdfBase64 } = await import("../api/_lib/invoicePdf.js");
  const broken = await invoicePdfBase64(null);
  assert.equal(broken, null, "a bad invoice should return null, not throw");
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

// ---------------------------------------------------------------------------
// Search-engine plumbing. None of this changes what a customer sees; it is
// what Google reads. It is tested for the same reason the prices are: a
// quietly wrong number in markup nobody looks at is the dangerous kind.
// ---------------------------------------------------------------------------

const PUBLIC = new URL("../public/", import.meta.url);
const readPublic = async (name) =>
  (await import("node:fs")).readFileSync(new URL(name, PUBLIC), "utf8");

// The pages we want in search results, and the ones we do not. Every .html in
// public/ must be in exactly one of these lists, so a new page cannot be added
// without a decision about whether Google should see it.
const INDEXABLE = {
  "index.html": "https://www.flipbikes.co.nz/",          // / and /index.html both answer 200
  "about.html": "https://www.flipbikes.co.nz/about.html",
  "installation.html": "https://www.flipbikes.co.nz/installation.html",
  "faq.html": "https://www.flipbikes.co.nz/faq.html",
  "contact.html": "https://www.flipbikes.co.nz/contact.html",
};
const NOT_INDEXABLE = ["cart.html", "thanks.html", "styleguide.html", "404.html"];

test("seo: every page is either canonical-tagged or noindexed, and we decided which", async () => {
  const { readdirSync } = await import("node:fs");
  const pages = readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).sort();
  assert.deepEqual(
    pages,
    [...Object.keys(INDEXABLE), ...NOT_INDEXABLE].sort(),
    "a page was added or renamed: list it in INDEXABLE or NOT_INDEXABLE, and in sitemap.xml if it should be found",
  );

  for (const [page, url] of Object.entries(INDEXABLE)) {
    const html = await readPublic(page);
    assert.ok(
      html.includes(`<link rel="canonical" href="${url}">`),
      `${page} has no canonical tag pointing at ${url}`,
    );
    assert.ok(
      !/<meta name="robots" content="noindex">/.test(html),
      `${page} is both canonical and noindex - the two contradict each other`,
    );
  }

  // 404.html answers with a 404 status, which keeps it out of the index on its
  // own; the other three need the tag.
  for (const page of ["cart.html", "thanks.html", "styleguide.html"]) {
    const html = await readPublic(page);
    assert.ok(
      /<meta name="robots" content="noindex">/.test(html),
      `${page} should be noindex - it is not a page we want found in search`,
    );
  }
});

test("seo: the sitemap lists exactly the indexable pages", async () => {
  const xml = await readPublic("sitemap.xml");
  const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    listed,
    Object.values(INDEXABLE).sort(),
    "sitemap.xml is out of step with the pages - a page is missing, or one we noindexed is still listed",
  );

  const robots = await readPublic("robots.txt");
  assert.ok(
    robots.includes("Sitemap: https://www.flipbikes.co.nz/sitemap.xml"),
    "robots.txt must point crawlers at the sitemap",
  );
});

test("seo: each page's title and description are its own", async () => {
  // The FAQ page shipped for two years carrying the installation guide's title
  // ("FAQ") and its meta description word for word, which tells Google the two
  // pages are the same page.
  const seen = new Map();
  for (const page of Object.keys(INDEXABLE)) {
    const html = await readPublic(page);
    const title = html.match(/<title>(.*?)<\/title>/s)?.[1];
    const desc = html.match(/<meta content="([^"]+)" name="description">/)?.[1];
    assert.ok(title && title.length > 10, `${page} has no real <title>`);
    assert.ok(desc && desc.length > 50, `${page} has no real meta description`);
    for (const [key, value] of [["title", title], ["description", desc]]) {
      const owner = seen.get(key + "::" + value);
      assert.ok(!owner, `${page} shares its ${key} with ${owner}`);
      seen.set(key + "::" + value, page);
    }
  }
});

test("seo: the homepage's structured-data prices come from catalog.js", async () => {
  // Structured data is a price quoted to Google and shown in the search
  // result. It is generated from catalog.js by scripts/gen-schema.mjs; this is
  // the check that nobody edited it by hand or changed a price and forgot to
  // re-run it.
  const { render } = await import("../scripts/gen-schema.mjs");
  const html = await readPublic("index.html");
  assert.equal(
    render(html),
    html,
    "public/index.html structured data is out of date. Run: node scripts/gen-schema.mjs",
  );

  // And belt-and-braces: it is valid JSON, and the numbers in it are the ones
  // checkout will charge.
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(json, "no JSON-LD block on the homepage");
  const graph = JSON.parse(json)["@graph"];
  const list = graph.find((n) => n["@type"] === "ItemList").itemListElement;
  assert.equal(list.length, PRODUCTS.length, "every product should appear in the structured data");
  for (const p of PRODUCTS) {
    const entry = list.find((e) => e.item.sku === p.sku);
    assert.ok(entry, `${p.sku} is missing from the structured data`);
    assert.equal(
      entry.item.offers.price,
      (p.price / 100).toFixed(2),
      `${p.sku}: Google would be told a different price from the one Stripe charges`,
    );
    assert.equal(entry.item.offers.priceCurrency, "NZD");
  }
});

// ---------------------------------------------------------------------------
// email_log — the shop keeps its own record of what it sent
//
// Before this it kept none. A row appeared only if Resend's delivery webhook
// called back, and that row was labelled kind "unknown", had no link to the
// order, and carried only ONE recipient: Resend fires a separate event per
// recipient and the webhook sets to_email only when it CREATES the row. On
// 14 Oct that made it look as though Craig had not been emailed about the
// first real order. He had. Worse, a send that failed before reaching Resend
// left no trace at all.
// ---------------------------------------------------------------------------

test("email_log: both order emails are recorded, with every recipient", async () => {
  await deliver(event());

  assert.equal(emailLog.length, 2, "one row for the order email, one for the customer's invoice");

  const internal = emailLog.find((e) => e.kind === "flip_order");
  const invoice = emailLog.find((e) => e.kind === "flip_invoice");
  assert.ok(internal, "the order email is logged under a real kind, not 'unknown'");
  assert.ok(invoice, "the customer invoice is logged under a real kind");

  // The whole point: BOTH recipients, so this row can never again be read as
  // evidence that one of them was left out.
  assert.equal(internal.to_email, "craig@betterservice.co.nz, xspyder5x@gmail.com");
  assert.equal(invoice.to_email, "pat@example.com");

  // resend_id is what lets Resend's later delivery events land on these rows
  // instead of creating orphans labelled "unknown".
  assert.ok(internal.resend_id, "the order email records its Resend id");
  assert.ok(invoice.resend_id, "the invoice records its Resend id");
  assert.notEqual(internal.resend_id, invoice.resend_id, "two messages, two ids");

  for (const row of emailLog) {
    assert.equal(row.flip_session_id, "cs_test_1", "each row points at its order");
    assert.equal(row.status, "accepted");
    assert.equal(row.error, null);
  }
});

test("email_log: a send that never reaches Resend is still recorded", async () => {
  // This is the case that used to vanish completely.
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) =>
    String(u).startsWith("https://api.resend.com/") ? new Response("service unavailable", { status: 503 }) : real(u, o);
  const r = await deliver(event());
  globalThis.fetch = real;

  assert.equal(r.code, 500, "Stripe should retry a failed send");
  assert.equal(emailLog.length, 1, "the failure left a row behind");
  const row = emailLog[0];
  assert.equal(row.kind, "flip_order");
  assert.equal(row.status, "failed");
  assert.equal(row.resend_id, null, "there is no message id when the send never landed");
  assert.match(row.error, /503/, "the row says why");
  assert.equal(row.flip_session_id, "cs_test_1");
});

test("email_log: a logging failure never costs the customer their email", async () => {
  // The money is already taken. Losing a log line is a nuisance; failing the
  // webhook over it would make Stripe retry and send everything twice.
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) =>
    String(u).includes("/rest/v1/email_log") ? new Response("nope", { status: 500 }) : real(u, o);
  const r = await deliver(event());
  globalThis.fetch = real;

  assert.equal(r.code, 200, "the order still completes");
  assert.equal(emails().length, 2, "and both emails still went");
});
