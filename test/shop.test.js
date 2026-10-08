// Run with: npm test   (Node 20+; no dependencies)
// Every outside service (Stripe, Resend, Supabase) is replaced by a fake
// fetch, so nothing here touches the network or any real account.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import checkout from "../api/checkout.js";
import shop from "../api/shop.js";
import webhook, { verifySignature, itemsFromMetadata } from "../api/stripe-webhook.js";

const calls = [];
let fakeStock;     // what the fake DB's flip_stock holds
let orders;        // what the fake DB's flip_orders holds
let stripeStatus;  // status the fake Stripe returns

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
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  process.env.RESEND_API_KEY = "re_fake";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });

    if (u.startsWith("https://api.stripe.com/")) {
      return stripeStatus === 200 ? json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }) : json({ error: "nope" }, stripeStatus);
    }
    if (u.startsWith("https://api.resend.com/")) return json({ id: "email_1" });
    if (u.includes("/rest/v1/flip_stock")) return json(Object.entries(fakeStock).map(([sku, qty]) => ({ sku, qty })));
    if (u.includes("/rest/v1/rpc/flip_take_stock")) {
      const { p_sku, p_qty } = JSON.parse(opts.body);
      fakeStock[p_sku] = Math.max((fakeStock[p_sku] ?? 0) - p_qty, 0);
      return json(fakeStock[p_sku]);
    }
    if (u.includes("/rest/v1/flip_orders")) {
      if (opts.method === "POST") {
        const o = JSON.parse(opts.body);
        orders[o.session_id] ??= { ...o, stock_taken: false, emailed: false };
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
const stripeBody = () => new URLSearchParams(calls.find((c) => c.url.startsWith("https://api.stripe.com/")).body);

// ---- /api/checkout
test("checkout: builds a Stripe session from catalog prices, ignoring any price the browser sends", async () => {
  const r = await post(checkout, { items: [{ sku: "flip-g3", qty: 2, price: 1 }], country: "NZ" });
  assert.equal(r.code, 200);
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  const b = stripeBody();
  assert.equal(b.get("line_items[0][price_data][unit_amount]"), "17900"); // not 1
  assert.equal(b.get("line_items[0][quantity]"), "2");
  assert.equal(b.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), "1500");
  assert.equal(b.get("shipping_address_collection[allowed_countries][0]"), "NZ");
  assert.equal(b.get("metadata[items]"), "flip-g3:2");
});

test("checkout: Australia gets the Australian rate and country", async () => {
  await post(checkout, { items: [{ sku: "flip-standard", qty: 1 }], country: "AU" });
  const b = stripeBody();
  assert.equal(b.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), "6000");
  assert.equal(b.get("shipping_address_collection[allowed_countries][0]"), "AU");
});

test("checkout: rejects unknown products, bad quantities, bad countries, empty carts", async () => {
  for (const body of [
    { items: [{ sku: "free-chock", qty: 1 }], country: "NZ" },
    { items: [{ sku: "flip-g3", qty: 0 }], country: "NZ" },
    { items: [{ sku: "flip-g3", qty: 1.5 }], country: "NZ" },
    { items: [{ sku: "flip-g3", qty: 21 }], country: "NZ" },
    { items: [{ sku: "flip-g3", qty: 1 }], country: "US" },
    { items: [], country: "NZ" },
  ]) {
    const r = await post(checkout, body);
    assert.equal(r.code, 400, JSON.stringify(body));
  }
  assert.equal(calls.filter((c) => c.url.startsWith("https://api.stripe.com/")).length, 0);
});

test("checkout: refuses when asking for more than is in stock, and says how many are left", async () => {
  const r = await post(checkout, { items: [{ sku: "d-rings", qty: 2 }], country: "NZ" });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /only 1/);
});

test("checkout: a product with no stock row is treated as untracked, not sold out", async () => {
  const r = await post(checkout, { items: [{ sku: "tie-downs", qty: 3 }], country: "NZ" });
  assert.equal(r.code, 200);
});

test("checkout: fails open if the stock database is down", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes("/rest/v1/") ? new Response("down", { status: 500 }) : real(u, o));
  const r = await post(checkout, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ" });
  assert.equal(r.code, 200);
});

test("checkout: 503 with a friendly message until Stripe is configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const r = await post(checkout, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ" });
  assert.equal(r.code, 503);
});

test("checkout: a Stripe failure becomes a generic 502, never leaking Stripe's error", async () => {
  stripeStatus = 400;
  const r = await post(checkout, { items: [{ sku: "flip-g3", qty: 1 }], country: "NZ" });
  assert.equal(r.code, 502);
  assert.doesNotMatch(JSON.stringify(r.body), /nope/);
});

// ---- /api/shop
test("shop: reports disabled until Stripe is configured, enabled after, with stock", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  let r = res(); await shop({ method: "GET" }, r);
  assert.equal(r.body.enabled, false);

  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  r = res(); await shop({ method: "GET" }, r);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.products.find((p) => p.sku === "flip-g3").stock, 5);
  assert.equal(r.body.products.find((p) => p.sku === "tie-downs").stock, null);
  assert.equal(r.body.shipping.NZ.amount, 1500);
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
      metadata: { items: "flip-g3:2", country: "NZ" },
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
  assert.match(craig.text, /1 Trailer Rd/);
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
