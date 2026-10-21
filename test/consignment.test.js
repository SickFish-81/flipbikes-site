// Run with: npm test
//
// Booking a parcel with the carrier. Both the carrier and Supabase are a fake
// fetch, so nothing here touches the network, a real order, or anybody's
// money.
//
// These tests are mostly about ONE failure, because it is the only one here
// that costs real money: creating two consignments for one order. Two
// consignments is two labels, two charges, and a parcel travelling under a
// number nobody is tracking. So the interesting cases are the ugly ones —
// the carrier booked it and then the label fetch died, the webhook arrived
// twice, the retry button was pressed on an order already booked.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ensureConsignment, parcelFor, cheapest } from "../api/_lib/consignment.js";
import { packagesFor, destinationFrom, CARTON_CM } from "../api/_lib/gss.js";

const SESSION = "cs_test_session_1";

let orders = [];      // the fake flip_orders table
let patches = [];     // every PATCH, in order
let calls = [];       // every URL fetched, in order
let stored = {};      // the storage bucket
let carrier;          // what the carrier does this test

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function anOrder(extra = {}) {
  return {
    session_id: SESSION,
    invoice_number: 1006,
    name: "Hine Mahia",
    email: "hine@example.test",
    phone: "021 555 0000",
    country: "NZ",
    address: {
      formatted: "12 Example Road, Greerton, Tauranga, 3112, New Zealand",
      postcode: "3112",
      rural: false,
      note: "Leave at the shed",
    },
    items: [{ sku: "flip-g3", qty: 2, name: "FLIP G3 Bike Chock", unit_amount: 17900 }],
    shipping_amount: 1290,
    consignment_id: null,
    tracking_number: null,
    label_fetched_at: null,
    label_error: null,
    ...extra,
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";
  process.env.GSS_ACCESS_KEY = "key_fake";
  process.env.GSS_SITE_ID = "4242";
  process.env.GSS_BASE_URL = "https://carrier.fake";

  orders = [anOrder()];
  patches = [];
  calls = [];
  stored = {};
  carrier = {
    rates: { Available: [{ QuoteId: "q-1", CarrierName: "Castle Parcels", Charge: 21.5, IsRuralDelivery: false }], Rejected: [] },
    shipment: { CarrierName: "Castle Parcels", Consignments: [{ ConsignmentId: 99001, Connote: "CSWH0002999", TrackingUrl: "https://track/CSWH0002999", Charge: 21.5 }] },
    label: [TINY_PNG_B64],
    labelFails: false,
    storageFails: false,
  };

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    calls.push(`${method} ${u}`);

    // ---- the carrier
    if (u.includes("carrier.fake")) {
      if (u.includes("api/rates")) return json(carrier.rates);
      if (u.includes("api/shipments")) return json(carrier.shipment);
      if (u.includes("api/labels")) {
        if (carrier.labelFails) return new Response("upstream exploded", { status: 500 });
        return json(carrier.label);
      }
      throw new Error(`unexpected carrier call: ${u}`);
    }

    // ---- Supabase storage
    const s = u.match(/\/storage\/v1\/object\/flip-labels\/(\d+)\.png/);
    if (s) {
      if (carrier.storageFails) return new Response("no bucket", { status: 404 });
      stored[s[1]] = opts.body;
      return new Response(null, { status: 200 });
    }

    // ---- Supabase REST
    if (!u.includes("/rest/v1/flip_orders")) throw new Error(`unexpected fetch: ${u}`);
    if (method === "PATCH") {
      const body = JSON.parse(opts.body);
      patches.push(body);
      Object.assign(orders[0], body);
      return new Response(null, { status: 204 });
    }
    return json(orders);
  };
});

const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
const carrierCalls = () => calls.filter((c) => c.includes("carrier.fake"));
const booked = () => carrierCalls().filter((c) => c.includes("api/shipments")).length;

// --------------------------------------------------------------- happy path

test("books the parcel, files the label, and records both", async () => {
  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, true);
  assert.equal(out.connote, "CSWH0002999");
  assert.equal(out.consignmentId, "99001");
  assert.equal(out.carrier, "Castle Parcels");
  assert.equal(booked(), 1);
  assert.ok(stored["1006"], "the label PNG was filed under the invoice number");
});

test("the consignment id is written BEFORE the label is fetched", async () => {
  await ensureConsignment(SESSION);

  // This ordering is the whole idempotency guarantee: if the process dies
  // after the booking, the id is already on the order, so the retry recovers
  // the label instead of buying a second consignment.
  const idPatch = patches.findIndex((p) => p.consignment_id);
  const fetchedPatch = patches.findIndex((p) => p.label_fetched_at);
  assert.ok(idPatch >= 0 && fetchedPatch >= 0);
  assert.ok(idPatch < fetchedPatch, "consignment id must be recorded first");

  const labelCall = calls.findIndex((c) => c.includes("api/labels"));
  const idCallPos = calls.findIndex((c) => c.startsWith("PATCH") && c.includes("flip_orders"));
  assert.ok(idCallPos < labelCall, "the id must reach the database before we go for the label");
});

test("label_fetched_at is written only after the bytes are stored", async () => {
  carrier.storageFails = true;
  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, false);
  assert.equal(orders[0].consignment_id, "99001", "the booking still happened and is recorded");
  assert.equal(orders[0].label_fetched_at, null, "but the agent must not be offered a label that isn't there");
  assert.match(orders[0].label_error, /Storage/);
});

// ------------------------------------------------------- never book it twice

test("an order that already has a consignment and a label does nothing at all", async () => {
  orders = [anOrder({ consignment_id: "99001", tracking_number: "CSWH0002999", label_fetched_at: "2026-10-22T01:00:00Z" })];

  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(carrierCalls().length, 0, "the carrier must not be touched");
  assert.equal(patches.length, 0, "and nothing is rewritten");
});

test("booked but the label never arrived: recover it, do NOT book again", async () => {
  // Exactly the state the previous test's failure leaves behind.
  orders = [anOrder({ consignment_id: "99001", tracking_number: "CSWH0002999", label_fetched_at: null })];

  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, true);
  assert.equal(booked(), 0, "a second consignment would be a second charge");
  assert.ok(stored["1006"], "the label was recovered for the connote we already held");
  assert.ok(orders[0].label_fetched_at);
});

test("a dead carrier leaves the order booked and retryable, and the retry finishes it", async () => {
  carrier.labelFails = true;
  const first = await ensureConsignment(SESSION);
  assert.equal(first.ok, false);
  assert.equal(orders[0].consignment_id, "99001");
  assert.match(orders[0].label_error, /500|label/i);

  // The carrier comes back. Nothing is booked a second time.
  carrier.labelFails = false;
  calls = [];
  const second = await ensureConsignment(SESSION);
  assert.equal(second.ok, true);
  assert.equal(booked(), 0);
  assert.ok(stored["1006"]);
});

// ------------------------------------------------------------- refusing well

test("no carrier configured: skipped, and NOT recorded as an error on the order", async () => {
  delete process.env.GSS_ACCESS_KEY;

  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /No carrier configured/);
  assert.equal(carrierCalls().length, 0);
  // The column means "something is wrong with this order". Writing to it on
  // every order while there is no account would make it mean nothing.
  assert.equal(patches.length, 0);
});

test("nobody quoted: the reasons the carriers gave are kept", async () => {
  carrier.rates = { Available: [], Rejected: [{ Carrier: "Post Haste", Reason: "No service to this postcode" }] };

  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, false);
  assert.equal(booked(), 0);
  assert.match(orders[0].label_error, /Post Haste/);
  assert.match(orders[0].label_error, /No service to this postcode/);
});

test("the carrier answering 200 with an Errors array is still a failure", async () => {
  // Their shipments endpoint reports some failures inside a 200 response, so
  // checking the HTTP status alone would record a consignment that does not
  // exist — and a consignment id that is a lie is worse than none.
  carrier.shipment = { Errors: ["Account not enabled for this carrier"], Consignments: [] };

  const out = await ensureConsignment(SESSION);

  assert.equal(out.ok, false);
  assert.equal(orders[0].consignment_id, null);
  assert.match(orders[0].label_error, /Account not enabled/);
});

test("ensureConsignment never throws, whatever the carrier does", async () => {
  globalThis.fetch = async () => { throw new Error("network is on fire"); };

  const out = await ensureConsignment(SESSION);
  assert.equal(out.ok, false);
  assert.match(out.reason, /network is on fire/);
});

test("an unknown session is reported, not thrown", async () => {
  orders = [];
  const out = await ensureConsignment("cs_nope");
  assert.equal(out.ok, false);
  assert.match(out.reason, /No order/);
});

// ------------------------------------------------------- shaping the parcel

test("five chocks are two cartons, and the weight is split across them", () => {
  const parcel = parcelFor(anOrder({ items: [{ sku: "flip-g3", qty: 5 }] }));
  assert.equal(parcel.cartons, 2);

  const pkgs = packagesFor(parcel);
  assert.equal(pkgs.length, 2);
  // 5 x 1500g + 2 x 350g carton = 8200g
  assert.equal(parcel.weightG, 8200);
  assert.equal(pkgs[0].Kg, 4.1);
  assert.equal(pkgs[0].Length, CARTON_CM.Length);
});

test("dimensions are sent in CENTIMETRES, not metres", () => {
  // The API stores them as metres and names the fields ...Cm, which reads
  // like a bug and is not. Sending 0.37 here would declare a 3.7mm carton.
  const pkgs = packagesFor(parcelFor(anOrder()));
  assert.equal(pkgs[0].Length, 37);
  assert.equal(pkgs[0].Width, 20);
  assert.equal(pkgs[0].Height, 18.5);
});

test("an accessories-only order goes as one satchel", () => {
  const parcel = parcelFor(anOrder({ items: [{ sku: "d-rings", qty: 2 }] }));
  assert.equal(parcel.bag, true);
  const pkgs = packagesFor(parcel);
  assert.equal(pkgs.length, 1);
  assert.equal(pkgs[0].Name, "Satchel");
});

test("the delivery note reaches the carrier, because it is what a hand-typed label loses", () => {
  const d = destinationFrom(anOrder());
  assert.equal(d.DeliveryInstructions, "Leave at the shed");
  assert.equal(d.Address.PostCode, "3112");
  assert.ok(d.Address.Suburb, "an empty suburb is rejected outright by the carrier");
});

// ------------------------------------------------------------ choosing a rate

test("cheapest ignores quotes with no QuoteId and sorts on what we pay", () => {
  const pick = cheapest([
    { QuoteId: "a", Charge: 45 },
    { QuoteId: "b", Charge: 21.5 },
    { Charge: 1, CarrierName: "unbookable" },
  ]);
  assert.equal(pick.QuoteId, "b");
});

test("a quote with no Charge falls back to Cost rather than sorting as free", () => {
  const pick = cheapest([{ QuoteId: "a", Cost: 30 }, { QuoteId: "b", Charge: 40 }]);
  assert.equal(pick.QuoteId, "a");
});

test("no usable quotes returns null rather than undefined", () => {
  assert.equal(cheapest([]), null);
  assert.equal(cheapest([{ Charge: 10 }]), null);
});
