// Run with: npm test
//
// Live courier rates at checkout, and — more importantly — every way they can
// fail without costing a sale.
//
// The rule these tests exist to hold: THE SHOP MUST ALWAYS RETURN A PRICE. A
// missing key, a slow carrier, a refused call, an address nobody who collects
// will quote — all of them land on the hand-kept table, and the customer never
// finds out. A sale lost to somebody else's outage is worse than a dollar of
// freight.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { priceOrder } from "../api/_lib/order.js";
import { liveShipping } from "../api/_lib/liveRates.js";

const ADDRESS = {
  manual: { line1: "12 Example Road", suburb: "Springvale", city: "Whanganui", postcode: "4412" },
};
const THREE_CHOCKS = [{ sku: "flip-standard", qty: 3 }];

let calls = [];
let sent = [];   // the bodies we posted to the carrier
let reply;      // what the fake carrier answers
let fail;       // make the call blow up

function quoted(available, rejected = [], suppressed = []) {
  return { Available: available, Rejected: rejected, Suppressed: suppressed, ValidationErrors: {} };
}

beforeEach(() => {
  process.env.GSS_ACCESS_KEY = "key_fake";
  process.env.GSS_SITE_ID = "4242";
  process.env.GSS_BASE_URL = "https://carrier.fake";
  delete process.env.FLIP_COLLECTING_CARRIERS;
  delete process.env.FLIP_FREIGHT_MARKUP;
  delete process.env.FLIP_INTL_CARRIERS;
  calls = [];
  sent = [];
  fail = null;
  reply = quoted([
    { QuoteId: "q1", CarrierName: "NZ Post Domestic", Charge: 13.65, IsRuralDelivery: false, IsResidentialDelivery: true },
    { QuoteId: "q2", CarrierName: "Post Haste", Charge: 13.27, IsRuralDelivery: false, IsResidentialDelivery: true },
  ]);

  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    if (opts.body) sent.push(JSON.parse(opts.body));
    if (fail) throw new Error(fail);
    return new Response(JSON.stringify(reply), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
});

const carrierCalls = () => calls.filter((c) => c.includes("carrier.fake"));
const price = async (items = THREE_CHOCKS) =>
  await priceOrder({ items, country: "NZ", address: ADDRESS });

// ------------------------------------------------------------- the happy path

test("the carrier's price is used, with GST and the markup on top", async () => {
  const o = await price();
  // NZ Post Domestic is the only carrier that collects from Te Puke. $13.65
  // ex GST, x1.08 markup, x1.15 GST = $16.95, rounded up to the next 50c.
  assert.equal(o.shipping.source, "carrier");
  assert.equal(o.shipping.carrier, "NZ Post Domestic");
  assert.equal(o.shipping.amount, 1700);
  assert.equal(o.shipping.exGstCents, 1365);
});

test("the CHEAPEST carrier is not chosen if it will not collect", async () => {
  // Post Haste is 38c cheaper and would make Craig drive to Jellicoe Street.
  const o = await price();
  assert.equal(o.shipping.carrier, "NZ Post Domestic");
  assert.notEqual(o.shipping.carrier, "Post Haste");
});

test("which carriers collect can be changed without a deploy", async () => {
  process.env.FLIP_COLLECTING_CARRIERS = "NZ Post Domestic, Post Haste";
  const o = await price();
  assert.equal(o.shipping.carrier, "Post Haste", "now the cheaper one is allowed");
});

test("rural comes from the carrier, not from our guess or the customer", async () => {
  reply = quoted([{ QuoteId: "q", CarrierName: "NZ Post Domestic", Charge: 20.00, IsRuralDelivery: true }]);
  const o = await price();
  assert.equal(o.shipping.rural, true);
  assert.equal(o.shipping.ruralReason, "carrier");
  assert.match(o.shipping.label, /rural delivery/);
});

test("the carrier's residential flag is carried through", async () => {
  const o = await price();
  assert.equal(o.shipping.residential, true);
});

// ------------------------------------------------- every way it must not break

test("no key: the table answers and the carrier is never called", async () => {
  delete process.env.GSS_ACCESS_KEY;
  const o = await price();
  assert.equal(o.shipping.source, "table");
  assert.equal(o.shipping.amount, 1590, "ticketNorth");
  assert.equal(carrierCalls().length, 0);
});

test("the carrier throws: the table answers and the sale proceeds", async () => {
  fail = "network is on fire";
  const o = await price();
  assert.equal(o.shipping.source, "table");
  assert.ok(o.shipping.amount > 0);
  assert.equal(o.error, undefined);
});

test("nobody who collects quoted: the table answers", async () => {
  reply = quoted([{ QuoteId: "q", CarrierName: "Post Haste", Charge: 9.99 }]);
  const o = await price();
  assert.equal(o.shipping.source, "table");
});

test("no quotes at all: the table answers", async () => {
  reply = quoted([], [{ Carrier: "NZ Post Domestic", Reason: "No service to this postcode" }]);
  const o = await price();
  assert.equal(o.shipping.source, "table");
});

test("a quote with no price is ignored rather than treated as free", async () => {
  reply = quoted([{ QuoteId: "q", CarrierName: "NZ Post Domestic" }]);
  const o = await price();
  assert.equal(o.shipping.source, "table");
});

test("liveShipping itself never throws", async () => {
  globalThis.fetch = async () => { throw new Error("boom"); };
  const out = await liveShipping({ order: { address: { country: "NZ" } }, parcel: { cartons: 1, weightG: 5000 } });
  assert.equal(out, null);
});

// ------------------------------------------------------ validation still wins

test("a bad postcode is still refused, and no carrier is asked", async () => {
  const o = await priceOrder({
    items: THREE_CHOCKS, country: "NZ",
    address: { manual: { line1: "1 X St", suburb: "Y", city: "Z", postcode: "abc" } },
  });
  assert.match(o.error, /postcode/i);
  assert.equal(carrierCalls().length, 0, "no point asking a carrier about an address we reject");
});

// ---------------------------------------------------------------- Australia

const SYDNEY = { manual: { line1: "1 X St", suburb: "Surry Hills", city: "Sydney", postcode: "2010" } };
const priceAu = (items = THREE_CHOCKS) => priceOrder({ items, country: "AU", address: SYDNEY });

test("Australia is priced by the carrier: cheapest NZ Post International, markup, NO GST", async () => {
  reply = quoted([
    { QuoteId: "a1", CarrierName: "NZ Post International Courier", Charge: 100.67 },
    { QuoteId: "a2", CarrierName: "NZ Post International Economy", Charge: 72.78 },
    { QuoteId: "a3", CarrierName: "Aramex", Charge: 50.0 },
  ]);
  const o = await priceAu();
  assert.equal(o.shipping.source, "carrier");
  assert.equal(o.shipping.carrier, "NZ Post International Economy", "Aramex is cheaper but isn't on the list");
  // $72.78 x 1.08 = $78.60, an export so zero-rated: no x1.15.
  assert.equal(o.shipping.amount, 7900);
  assert.equal(o.shipping.exGstCents, 7278);
  assert.equal(sent[0].Destination.Address.CountryCode, "AU");
  assert.equal(sent[0].Destination.Address.PostCode, "2010");
});

test("Australia: two cartons are quoted as one carton each, and charged for both", async () => {
  // NZ Post International rejects two cartons in one request as "Item over
  // weight", so we ask about one carton and charge for each.
  reply = quoted([{ QuoteId: "a1", CarrierName: "NZ Post International", Charge: 70 }]);
  const o = await priceAu([{ sku: "flip-g3", qty: 5 }]);
  assert.equal(carrierCalls().length, 1);
  assert.equal(sent[0].Packages.length, 1, "one carton per question");
  assert.equal(sent[0].Packages[0].Kg, 4.1, "the weight of ONE of the two cartons");
  assert.equal(o.shipping.exGstCents, 14000, "both cartons paid for");
  assert.equal(o.shipping.amount, 15150, "$140 x 1.08 = $151.20, no GST, up to 50c");
});

test("NZ still asks about every carton in one go", async () => {
  await price([{ sku: "flip-g3", qty: 5 }]);
  assert.equal(sent[0].Packages.length, 2);
});

test("no live price to Australia means no checkout, never the unchecked $60", async () => {
  reply = quoted([]);
  const o = await priceAu();
  assert.equal(o.status, 503);
  assert.match(o.error, /Australia/);
  assert.equal(o.shipping, undefined);
});

test("Australia refuses when the carrier is down, too", async () => {
  fail = "network is on fire";
  const o = await priceAu();
  assert.equal(o.status, 503);
});

test("a carrier not on the international list is never used for Australia", async () => {
  reply = quoted([{ QuoteId: "a3", CarrierName: "Aramex", Charge: 50.0 }]);
  const o = await priceAu();
  assert.equal(o.status, 503);
});

// ----------------------------------------------------------------- the parcel

test("the carrier is asked about the parcel the TABLE worked out", async () => {
  await price([{ sku: "flip-g3", qty: 5 }]);

  assert.equal(carrierCalls().length, 1, "asked once, not per carrier");
  const body = sent[0];

  // Five chocks are two cartons (three fit in one), 5 x 1500g + 2 x 350g.
  // The table is the only thing that knows that, and the carrier must be
  // asked about the same parcel we would actually send — otherwise the price
  // the customer pays is for a parcel that does not exist.
  assert.equal(body.Packages.length, 2);
  assert.equal(body.Packages[0].Length, 37, "centimetres, not metres");
  assert.equal(body.Packages[0].Kg, 4.1, "8.2kg split across two cartons");
  assert.equal(body.Destination.Address.PostCode, "4412");
  assert.ok(body.Destination.Address.Suburb, "an empty suburb is refused outright");
});

test("an accessories-only order is quoted as one satchel", async () => {
  await price([{ sku: "d-rings", qty: 2 }]);
  assert.equal(sent[0].Packages.length, 1);
  assert.equal(sent[0].Packages[0].Name, "custom");
  assert.equal(sent[0].Packages[0].Type, "Satchel");
});

// ---------------------------------------------------------------------------
// The Hidden group.
//
// GSS returns three groups and we read two. Their docs call Hidden rates that
// are available but "filtered out due to user preference, based on cost
// centre, or destination courier preference" — an ACCOUNT SETTING, not a
// carrier declining the job.
//
// On 8 Nov the live account returned nothing in Available and nothing in
// Rejected. The log said "saw: none", which was read as "this account has no
// carriers" and acted on. Hidden was never looked at, because the parser threw
// it away. These two tests exist so that the next empty result says which of
// the two it is, instead of leaving it to be guessed at again.

test("carriers suppressed by an account setting still mean no live price", async () => {
  reply = quoted([], [], [
    { QuoteId: "h1", CarrierName: "NZ Post Domestic", Charge: 13.65 },
  ]);
  const out = await liveShipping({
    order: { address: { country: "NZ", postcode: "4412" } },
    parcel: { cartons: 1, weightG: 9000, region: "north" },
  });
  // Hidden is NOT usable — it is a quote the account has been told not to use.
  // Falling back to the table is correct; silently charging it would not be.
  assert.equal(out, null);
});

test("the log names the suppressed carriers, so an empty account cannot be confused with a filtered one", async () => {
  const seen = [];
  const realError = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    reply = quoted([], [], [
      { QuoteId: "h1", CarrierName: "NZ Post Domestic", Charge: 13.65 },
      { QuoteId: "h2", CarrierName: "CourierPost", Charge: 14.10 },
    ]);
    await liveShipping({
      order: { address: { country: "NZ", postcode: "4412" } },
      parcel: { cartons: 1, weightG: 9000, region: "north" },
    });
  } finally {
    console.error = realError;
  }

  const line = seen.join("\n");
  assert.match(line, /available: none/);
  assert.match(line, /suppressed: NZ Post Domestic, CourierPost/);
});

test("a genuinely empty account says so, and says suppressed is empty too", async () => {
  const seen = [];
  const realError = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    reply = quoted([], [], []);
    await liveShipping({
      order: { address: { country: "NZ", postcode: "4412" } },
      parcel: { cartons: 1, weightG: 9000, region: "north" },
    });
  } finally {
    console.error = realError;
  }
  assert.match(seen.join("\n"), /available: none; suppressed: none/);
});

// The stock size is not a label we get to choose.
//
// GSS resolves `Name` against the account's Administration > Stock Sizes, and
// their docs say to send "custom" when none matches. This account has only
// "-- Custom --" and six GSS satchel codes. We sent "Carton" for weeks; rates
// came back with Available, Hidden and Rejected all empty, which is the least
// informative failure the API has. This test exists so a friendlier-looking
// name never gets put back.
test("every package goes under a stock size the account actually has", async () => {
  await price([{ sku: "flip-standard", qty: 3 }]);
  for (const p of sent[0].Packages) {
    assert.equal(p.Name, "custom", "Name is a stock size, not a description");
    assert.ok(["Box", "Satchel"].includes(p.Type));
    assert.ok(p.Length > 0 && p.Width > 0 && p.Height > 0 && p.Kg > 0);
  }
});

// Dimensions must be whole centimetres.
//
// Their Rate Package Model types length/width/height as integer, and GSS is an
// ASP.NET app: a decimal against an int property fails model binding, and a
// package that does not bind cannot be rated. We sent Height 18.5 for weeks.
test("every dimension sent is a whole number", async () => {
  await price([{ sku: "flip-standard", qty: 3 }]);
  for (const p of sent[0].Packages) {
    for (const k of ["Length", "Width", "Height"]) {
      assert.equal(Number.isInteger(p[k]), true, `${k} must be an integer, got ${p[k]}`);
    }
  }
});

// A hand-typed address with no suburb must still rate.
//
// destinationFrom used to fall back to parts[1] of the formatted string before
// the city. For "123 No 1 Road, RD 2, Te Puke, 3182" that is "RD 2" — an RD
// number, not a suburb — and GSS answers it with Available, Suppressed and
// Rejected all empty. Four days were spent diagnosing that silence.
test("an address with no suburb sends the city, never the RD number", async () => {
  await priceOrder({
    items: [{ sku: "flip-standard", qty: 1 }],
    country: "NZ",
    address: { manual: { line1: "123 No 1 Road, RD 2", suburb: "", city: "Te Puke", postcode: "3182" } },
  });
  const sub = sent[0].Destination.Address.Suburb;
  assert.equal(sub, "Te Puke");
  assert.notEqual(sub, "RD 2");
  assert.ok(sub.length > 0, "an empty suburb is refused outright by GSS");
});
