// Run with: npm test
//
// /api/dealer — the dealer portal.
//
// What these tests hold, most important first:
//   1. Nobody gets in without a code from THEIR inbox, and a session can't be
//      forged, reused after access is switched off, or used from another site.
//   2. A dealer can't set their own price, freight or bill-to: whatever the
//      browser sends, the database gets only skus, quantities, the delivery
//      address and freight this server quoted itself.
//   3. A dealer only ever sees their own orders and invoices.
//   4. An order that was placed is never reported as failed, and Craig hears
//      about every one.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import dealer from "../api/dealer.js";
import { signSession } from "../api/_lib/dealerAuth.js";

const HOST = "www.flipbikes.co.nz";
const ORIGIN = `https://${HOST}`;
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

let db, sent, rpcCalls, queries;

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function res() {
  const r = { code: 0, body: undefined, headers: {} };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => ((r.body = b), r);
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  return r;
}

async function call({ method = "POST", body, cookie, origin = ORIGIN, query, url } = {}) {
  const r = res();
  await dealer({
    method,
    headers: { host: HOST, ...(origin ? { origin } : {}), ...(cookie ? { cookie: `flip_dealer=${encodeURIComponent(cookie)}` } : {}) },
    body, query, url: url || "/api/dealer",
  }, r);
  return r;
}

const cookieOf = (r) => {
  const c = r.headers["Set-Cookie"] || "";
  const m = /flip_dealer=([^;]*)/.exec(c);
  return m ? decodeURIComponent(m[1]) : null;
};

const sessionFor = (id, v = 1) => signSession(id, v);

const ORDER_BODY = () => ({
  action: "order",
  items: [{ sku: "flip-standard", qty: 2, price: 1 }, { sku: "d-rings", qty: 4 }],
  deliver_to: { name: "Jim", line1: "5 Farm Rd", city: "Gore", postcode: "9710", rural: false },
  customer_ref: "PO-77",
  // Things a dealer might try. None of them may reach the database.
  shipping_ex_gst: 0, bill_to: { business: "Someone Else", email: "evil@example.test" }, paid: true,
});

beforeEach(() => {
  sent = []; rpcCalls = []; queries = [];
  db = {
    dealers: {
      [A]: { id: A, business: "Gold Dealer Ltd", contact: "Ann", email: "ann@gold.test", phone: null, address: "1 Gold St, Hamilton 3200", tier_id: "gold", portal_access: true, session_version: 1 },
      [B]: { id: B, business: "No Portal Ltd", contact: null, email: "b@np.test", phone: null, address: null, tier_id: "standard", portal_access: false, session_version: 1 },
    },
    codes: [],
    stock: { "flip-standard": 11, "d-rings": 5 },
    orders: {},
    nextInvoice: 1009,
    rpcError: null,
  };

  process.env.SUPABASE_URL = "https://db.fake";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";
  process.env.RESEND_API_KEY = "re_fake";
  process.env.FLIP_DEALER_SECRET = "x".repeat(40);
  process.env.FLIP_GST_NUMBER = "123-456-789";
  process.env.FLIP_BANK_ACCOUNT = "12-3456-7890123-00";
  process.env.FLIP_ORDER_EMAILS = "craig@example.test";
  process.env.GSS_ACCESS_KEY = "key_fake";
  process.env.GSS_SITE_ID = "4242";
  process.env.GSS_BASE_URL = "https://carrier.fake";

  globalThis.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const method = opts.method || "GET";
    queries.push(u);
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (u.startsWith("https://db.fake/rest/v1/flip_dealers?email=eq.")) {
      const e = u.split("email=eq.")[1].split("&")[0];
      return json(Object.values(db.dealers).filter((d) => d.email === e));
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_dealers?id=eq.")) {
      const id = u.split("id=eq.")[1].split("&")[0];
      return json(db.dealers[id] ? [db.dealers[id]] : []);
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_dealer_codes")) {
      if (method === "POST") {
        db.codes.push({ id: db.codes.length + 1, ...body, created_at: new Date().toISOString(), attempts: 0, used_at: null });
        return new Response(null, { status: 201 });
      }
      if (method === "PATCH") {
        const id = Number(u.split("id=eq.")[1]);
        Object.assign(db.codes.find((c) => c.id === id), body);
        return new Response(null, { status: 204 });
      }
      const dealerId = u.split("dealer_id=eq.")[1].split("&")[0];
      let rows = db.codes.filter((c) => c.dealer_id === dealerId);
      if (u.includes("used_at=not.is.null")) {
        const except = Number(u.split("id=neq.")[1].split("&")[0]);
        return json(rows.filter((c) => c.used_at && c.id !== except).slice(0, 1));
      }
      if (u.includes("used_at=is.null")) {
        const now = u.split("expires_at=gt.")[1].split("&")[0];
        rows = rows.filter((c) => !c.used_at && c.expires_at > now).reverse().slice(0, 1);
      } else {
        const since = u.split("created_at=gte.")[1].split("&")[0];
        rows = rows.filter((c) => c.created_at >= since);
      }
      return json(rows);
    }
    if (u === "https://db.fake/rest/v1/rpc/flip_dealer_price_list") {
      return json([
        { sku: "d-rings", name: "D Rings", price_ex_gst: 1500 },
        { sku: "flip-standard", name: "FLIP Standard Bike Chock", price_ex_gst: 8000 },
        { sku: "flip-g3", name: "FLIP G3 Bike Chock", price_ex_gst: null },
      ]);
    }
    if (u === "https://db.fake/rest/v1/rpc/create_flip_dealer_order") {
      rpcCalls.push(body);
      if (db.rpcError) return json({ code: "P0001", message: db.rpcError }, 400);
      const d = db.dealers[body.p_dealer_id];
      const n = db.nextInvoice++;
      // What the real function does, for the numbers this test uses.
      const goods = body.p_order.lines.reduce((s, l) => s + l.qty * (l.sku === "flip-standard" ? 8000 : 1500), 0);
      const ex = goods + body.p_order.shipping_ex_gst;
      const gst = Math.round(ex * 0.15);
      db.orders[n] = {
        session_id: `trade_${n}`, invoice_number: n, created_at: "2026-11-11T00:00:00Z", channel: "trade",
        name: body.p_order.deliver_to.name, phone: null, country: "NZ",
        address: { formatted: `${body.p_order.deliver_to.line1}, ${body.p_order.deliver_to.city} ${body.p_order.deliver_to.postcode}, New Zealand`, collect: false },
        items: body.p_order.lines.map((l) => ({ sku: l.sku, qty: l.qty, name: l.sku, unit_ex_gst: l.sku === "flip-standard" ? 8000 : 1500 })),
        amount_total: ex + gst, shipping_amount: Math.round(body.p_order.shipping_ex_gst * 1.15),
        amount_ex_gst: ex, gst_amount: gst, shipping_ex_gst: body.p_order.shipping_ex_gst,
        bill_to: { business: d.business, contact: d.contact, email: d.email, address: d.address },
        due_date: "2026-12-20", paid_at: null, emailed: false, customer_ref: body.p_order.customer_ref,
        placed_via: "portal", dealer_id: d.id, packed_at: null,
      };
      return json({ session_id: `trade_${n}`, invoice_number: n, amount_ex_gst: ex, gst_amount: gst, amount_total: ex + gst, stock_left: {} });
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_stock")) {
      return json(Object.entries(db.stock).map(([sku, qty]) => ({ sku, qty })));
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_orders?invoice_number=eq.")) {
      const n = Number(u.split("invoice_number=eq.")[1].split("&")[0]);
      return json(db.orders[n] ? [db.orders[n]] : []);
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_orders?dealer_id=eq.")) {
      const id = u.split("dealer_id=eq.")[1].split("&")[0];
      return json(Object.values(db.orders).filter((o) => o.dealer_id === id));
    }
    if (u.startsWith("https://db.fake/rest/v1/flip_orders?session_id=eq.") && method === "PATCH") {
      const sid = u.split("session_id=eq.")[1];
      for (const o of Object.values(db.orders)) if (o.session_id === sid) Object.assign(o, body);
      return new Response(null, { status: 204 });
    }
    if (u.startsWith("https://db.fake/rest/v1/email_log")) return new Response(null, { status: 201 });
    if (u === "https://api.resend.com/emails") {
      if (db.resendDown && body.subject?.startsWith("Tax invoice")) return new Response("down", { status: 500 });
      sent.push(body);
      return json({ id: `email_${sent.length}` });
    }
    if (u === "https://carrier.fake/api/rates") {
      return json({ Available: [{ QuoteId: "q1", CarrierName: "NZ Post Domestic", Charge: 12.05, IsRuralDelivery: false }],
                    Suppressed: [], Rejected: [], ValidationErrors: {} });
    }
    throw new Error("unexpected fetch: " + u);
  };
});

// ------------------------------------------------------------ switched off

test("no FLIP_DEALER_SECRET (or a short one): the portal is shut", async () => {
  process.env.FLIP_DEALER_SECRET = "short";
  const r = await call({ body: { action: "request_code", email: "ann@gold.test" } });
  assert.equal(r.code, 503);
  assert.equal(sent.length, 0);
});

test("a POST from another website is refused before anything happens", async () => {
  const r = await call({ origin: "https://evil.example", cookie: sessionFor(A), body: ORDER_BODY() });
  assert.equal(r.code, 403);
  const none = await call({ origin: null, cookie: sessionFor(A), body: ORDER_BODY() });
  assert.equal(none.code, 403);
  assert.equal(rpcCalls.length, 0);
});

// ----------------------------------------------------------------- sign in

test("asking for a code: same answer for a dealer, a non-dealer and a dealer without access", async () => {
  const known = await call({ body: { action: "request_code", email: "  Ann@Gold.test " } });
  const stranger = await call({ body: { action: "request_code", email: "nobody@example.test" } });
  const noAccess = await call({ body: { action: "request_code", email: "b@np.test" } });
  assert.deepEqual(known.body, stranger.body);
  assert.deepEqual(known.body, noAccess.body);
  assert.equal(sent.length, 1, "only the real dealer gets an email");
  assert.equal(sent[0].to[0], "ann@gold.test");
  const code = /(\d{6})/.exec(sent[0].text)[1];
  assert.equal(db.codes.length, 1);
  assert.notEqual(db.codes[0].code_hash, code, "the code is stored hashed");
  assert.ok(!db.codes[0].code_hash.includes(code));
});

test("codes are rate limited: the fourth request in 15 minutes sends nothing", async () => {
  for (let i = 0; i < 4; i++) await call({ body: { action: "request_code", email: "ann@gold.test" } });
  assert.equal(sent.length, 3);
});

async function getCode() {
  await call({ body: { action: "request_code", email: "ann@gold.test" } });
  return /(\d{6})/.exec(sent.at(-1).text)[1];
}

test("the right code signs in with an HttpOnly cookie, and can't be used twice", async () => {
  const code = await getCode();
  const r = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(r.code, 200);
  assert.match(r.headers["Set-Cookie"], /HttpOnly/);
  assert.match(r.headers["Set-Cookie"], /Secure/);
  assert.match(r.headers["Set-Cookie"], /SameSite=Lax/);
  assert.ok(cookieOf(r));
  const again = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(again.code, 400);
});

test("wrong codes count, and after five even the right code is refused", async () => {
  const code = await getCode();
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    const r = await call({ body: { action: "verify_code", email: "ann@gold.test", code: wrong } });
    assert.equal(r.code, 400);
  }
  const right = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(right.code, 400);
  assert.equal(cookieOf(right), null);
});

test("an expired code is refused", async () => {
  const code = await getCode();
  db.codes.at(-1).expires_at = "2000-01-01T00:00:00.000Z";
  const r = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(r.code, 400);
});

// ----------------------------------------------------------------- session

test("no cookie, a forged cookie, access switched off, or signed out everywhere: 401", async () => {
  assert.equal((await call({ body: { action: "me" } })).code, 401);

  const real = sessionFor(A);
  process.env.FLIP_DEALER_SECRET = "y".repeat(40);
  const forged = sessionFor(A);
  process.env.FLIP_DEALER_SECRET = "x".repeat(40);
  assert.equal((await call({ cookie: forged, body: { action: "me" } })).code, 401);
  assert.equal((await call({ cookie: real + "x", body: { action: "me" } })).code, 401);
  assert.equal((await call({ cookie: real, body: { action: "me" } })).code, 200);

  db.dealers[A].session_version = 2;
  assert.equal((await call({ cookie: real, body: { action: "me" } })).code, 401);
  db.dealers[A].session_version = 1;
  db.dealers[A].portal_access = false;
  assert.equal((await call({ cookie: real, body: { action: "me" } })).code, 401);
});

test("me: the dealer's own details and their tier's prices, in shop order", async () => {
  const r = await call({ cookie: sessionFor(A), body: { action: "me" } });
  assert.equal(r.body.dealer.business, "Gold Dealer Ltd");
  assert.deepEqual(r.body.prices.map((p) => p.sku), ["flip-g3", "flip-standard", "d-rings"]);
  assert.equal(r.body.prices.find((p) => p.sku === "flip-standard").price_ex_gst, 8000);
  assert.ok(!("tier_id" in r.body.dealer), "the tier name is Craig's business, not the dealer's");
});

// ------------------------------------------------------------------- order

test("an order: the database gets skus, quantities and OUR freight — no price, bill-to or paid flag", async () => {
  const r = await call({ cookie: sessionFor(A), body: ORDER_BODY() });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(rpcCalls.length, 1);
  const p = rpcCalls[0];
  assert.equal(p.p_dealer_id, A);
  assert.deepEqual(p.p_order.lines, [{ sku: "flip-standard", qty: 2 }, { sku: "d-rings", qty: 4 }]);
  assert.equal(p.p_order.shipping_ex_gst, 1205, "freight quoted by us, not the 0 the browser sent");
  assert.equal(p.p_order.shipping_source, "carrier");
  assert.ok(!("bill_to" in p.p_order));
  assert.ok(!("paid" in p.p_order));
  assert.ok(!("due_date" in p.p_order));
  assert.equal(p.p_order.customer_ref, "PO-77");
  // 2 x 80 + 4 x 15 + 12.05 = 232.05; GST 34.81
  assert.equal(r.body.amount_ex_gst, 23205);
  assert.equal(r.body.gst_amount, 3481);
  assert.equal(r.body.invoice_sent, true);
});

test("the invoice goes to the dealer's saved email; Craig's copy says it was placed online", async () => {
  await call({ cookie: sessionFor(A), body: ORDER_BODY() });
  const inv = sent.find((m) => m.subject.startsWith("Tax invoice FLIP-1009"));
  assert.ok(inv, "invoice sent");
  assert.deepEqual(inv.to, ["ann@gold.test"]);
  assert.match(inv.text, /Your ref: PO-77/);
  assert.match(inv.text, /Payment due 20\/12\/2026/);
  const craig = sent.find((m) => m.to[0] === "craig@example.test");
  assert.match(craig.subject, /FLIP dealer order FLIP-1009: Gold Dealer Ltd \(placed online\)/);
  assert.match(craig.text, /placed this order themselves/);
  assert.equal(db.orders[1009].emailed, true);
});

test("not enough stock: refused before the database is asked", async () => {
  db.stock["d-rings"] = 2;
  const r = await call({ cookie: sessionFor(A), body: ORDER_BODY() });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /Only 2 of "D Rings"/);
  assert.equal(rpcCalls.length, 0);
});

test("the database's own refusal is shown to the dealer", async () => {
  db.rpcError = "FLIP G3 Bike Chock is not available to order online yet. Please get in touch.";
  const r = await call({ cookie: sessionFor(A), body: { ...ORDER_BODY(), items: [{ sku: "flip-g3", qty: 1 }] } });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /not available to order online/);
});

test("if the invoice email fails the order still stands, and Craig is told", async () => {
  db.resendDown = true;
  const r = await call({ cookie: sessionFor(A), body: ORDER_BODY() });
  assert.equal(r.code, 200);
  assert.equal(r.body.placed, true);
  assert.equal(r.body.invoice_sent, false);
  assert.ok(sent.some((m) => /invoice NOT sent/.test(m.subject) && m.to[0] === "craig@example.test"));
});

// ------------------------------------------------------- only your own stuff

test("orders: only the signed-in dealer's", async () => {
  await call({ cookie: sessionFor(A), body: ORDER_BODY() });
  db.orders[2000] = { ...db.orders[1009], invoice_number: 2000, session_id: "x", dealer_id: B };
  const r = await call({ cookie: sessionFor(A), body: { action: "orders" } });
  assert.deepEqual(r.body.orders.map((o) => o.invoice_number), [1009]);
  assert.equal(r.body.orders[0].town, "Gore");
  assert.equal(r.body.orders[0].status, "Being packed");
  assert.ok(queries.some((q) => q.includes(`flip_orders?dealer_id=eq.${A}`)));
});

test("invoice PDF: your own downloads; someone else's is 'no such invoice'", async () => {
  await call({ cookie: sessionFor(A), body: ORDER_BODY() });
  db.dealers[B].portal_access = true;
  const theirs = await call({ method: "GET", cookie: sessionFor(B), query: { invoice: "1009" }, origin: null });
  assert.equal(theirs.code, 404);
  const mine = await call({ method: "GET", cookie: sessionFor(A), query: { invoice: "1009" }, origin: null });
  assert.equal(mine.code, 200);
  assert.equal(mine.headers["Content-Type"], "application/pdf");
  assert.ok(Buffer.isBuffer(mine.body) && mine.body.subarray(0, 4).toString() === "%PDF");
  const signedOut = await call({ method: "GET", query: { invoice: "1009" }, origin: null });
  assert.equal(signedOut.code, 401);
});

test("sessions don't expire: a two-year-old sign-in still works, and each visit renews the cookie", async () => {
  const twoYearsAgo = Date.now() - 2 * 365 * 86400 * 1000;
  const old = signSession(A, 1, twoYearsAgo);
  const r = await call({ cookie: old, body: { action: "me" } });
  assert.equal(r.code, 200);
  const renewed = r.headers["Set-Cookie"];
  assert.match(renewed, /Max-Age=34560000/, "400 days, the most a browser keeps");
  assert.ok(cookieOf(r) && cookieOf(r) !== old, "a fresh cookie was issued");
  // ...but turning access off still ends it at once.
  db.dealers[A].portal_access = false;
  assert.equal((await call({ cookie: old, body: { action: "me" } })).code, 401);
});

// ------------------------------------------------------ telling us they're in

test("a dealer's FIRST sign-in emails the order-email list, and a later one says so quietly", async () => {
  let code = await getCode();
  sent = [];
  let r = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(r.code, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["craig@example.test"]);
  assert.match(sent[0].subject, /New FLIP trade dealer signed in: Gold Dealer Ltd/);
  assert.match(sent[0].text, /first time/);

  code = await getCode();
  sent = [];
  r = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(r.code, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^FLIP trade portal sign-in: Gold Dealer Ltd/);
  assert.match(sent[0].text, /Sign out everywhere/);
});

test("a failed sign-in tells nobody", async () => {
  await getCode();
  sent = [];
  await call({ body: { action: "verify_code", email: "ann@gold.test", code: "000001" } });
  assert.equal(sent.length, 0);
});

test("if the notice can't be sent, the dealer still gets in", async () => {
  const code = await getCode();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) throw new Error("mail is down");
    return base(url, opts);
  };
  const r = await call({ body: { action: "verify_code", email: "ann@gold.test", code } });
  assert.equal(r.code, 200);
  assert.ok(cookieOf(r));
});
