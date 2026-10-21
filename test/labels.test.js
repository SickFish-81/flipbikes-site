// Run with: npm test
//
// The label endpoints the print agent polls. Supabase is a fake fetch, so
// nothing here touches the network or any real order.
//
// What these tests actually guard is the two ways this could go wrong quietly:
//
//   1. the endpoints answering as though they were open when the token is
//      unset — which would publish customers' names and addresses, because
//      FLIP_AGENT_TOKEN is not set in Vercel yet;
//   2. a label vanishing from the pending list without having printed — the
//      failure where an order silently never goes out.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import pending from "../api/labels/pending.js";
import printed from "../api/labels/[id]/printed.js";
import labelPdf from "../api/labels/[id]/pdf.js";
import { buildLabelSheet } from "../api/_lib/labelSheet.js";

const TOKEN = "agent_test_token";

function res() {
  const r = { code: 0, body: undefined, headers: {} };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => ((r.body = b), r);
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  return r;
}

const asAgent = (extra = {}) => ({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, ...extra });

// Every order the fake database holds. Tests mutate `orders` to set the scene,
// and `patches` records what the endpoint wrote so we can assert on it.
let orders = [];
let patches = [];
// The stored carrier label, keyed by invoice number. null = none filed.
let labels = {};

// A real 1x1 PNG. Small enough to inline, valid enough for pdf-lib to embed.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(() => {
  process.env.FLIP_AGENT_TOKEN = TOKEN;
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";
  orders = [];
  patches = [];
  labels = {};

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);

    // Supabase Storage, where the carrier's label is filed.
    const m = u.match(/\/storage\/v1\/object\/flip-labels\/(\d+)\.png/);
    if (m) {
      const png = labels[m[1]];
      return png
        ? new Response(png, { status: 200, headers: { "Content-Type": "image/png" } })
        : new Response("not found", { status: 404 });
    }

    if (!u.includes("/rest/v1/flip_orders")) throw new Error(`unexpected fetch: ${u}`);

    if ((opts.method || "GET") === "PATCH") {
      const m = u.match(/session_id=eq\.([^&]+)/);
      patches.push({ session_id: m && decodeURIComponent(m[1]), fields: JSON.parse(opts.body) });
      // `new Response("", { status: 204 })` THROWS — a 204 may not carry a
      // body. That threw inside this fake, the endpoint caught it and answered
      // 502, and one test still "passed" because it only looked at what had
      // been recorded before the throw. Worth keeping: a fake that fails in a
      // way the code under test swallows is the worst kind of test.
      return new Response(null, { status: 204 });
    }

    // A GET. Apply whichever of the two filters the caller used.
    let rows = orders;
    const inv = u.match(/invoice_number=eq\.(\d+)/);
    if (inv) {
      rows = rows.filter((o) => o.invoice_number === Number(inv[1]));
    } else {
      if (u.includes("printed_at=is.null")) rows = rows.filter((o) => !o.printed_at);
      if (u.includes("consignment_id=not.is.null")) rows = rows.filter((o) => o.consignment_id);
      if (u.includes("label_fetched_at=not.is.null")) rows = rows.filter((o) => o.label_fetched_at);
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});

const order = (over = {}) => ({
  session_id: `cs_test_${over.invoice_number || 1}`,
  invoice_number: 1,
  name: "A Customer",
  consignment_id: null,
  tracking_number: null,
  label_fetched_at: null,
  printed_at: null,
  label_error: null,
  ...over,
});

// --------------------------------------------------------------- the token

test("no token on the server is a refusal, not an open door", async () => {
  delete process.env.FLIP_AGENT_TOKEN;
  orders = [order({ consignment_id: "C1", label_fetched_at: "2026-10-20T00:00:00Z" })];

  const r = res();
  await pending(asAgent(), r);
  assert.equal(r.code, 503);
  assert.equal(r.body.labels, undefined, "a refusal must not carry customer data");
});

test("a wrong token is 401, and a missing header is 401", async () => {
  for (const headers of [{ authorization: "Bearer wrong" }, {}]) {
    const r = res();
    await pending({ method: "GET", headers }, r);
    assert.equal(r.code, 401);
    assert.equal(r.body.labels, undefined);
  }
});

test("the right token gets in", async () => {
  const r = res();
  await pending(asAgent(), r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.labels, []);
});

// ------------------------------------------------------------ what's pending

test("nothing to print is an empty list, not an error", async () => {
  const r = res();
  await pending(asAgent(), r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.labels, []);
  assert.equal(r.headers["Cache-Control"], "no-store", "a cached empty list would be actively wrong");
});

test("a consignment with no fetched PDF is NOT offered", async () => {
  // Offering it would have the agent fail, report an error, and try again a
  // minute later, forever.
  orders = [order({ consignment_id: "C1", label_fetched_at: null })];
  const r = res();
  await pending(asAgent(), r);
  assert.deepEqual(r.body.labels, []);
});

test("an order with no consignment is not offered", async () => {
  orders = [order({ consignment_id: null, label_fetched_at: "2026-10-20T00:00:00Z" })];
  const r = res();
  await pending(asAgent(), r);
  assert.deepEqual(r.body.labels, []);
});

test("a fetched, unprinted label is offered, keyed by invoice number", async () => {
  orders = [order({
    invoice_number: 1004, name: "John Davis",
    consignment_id: "CONS-9", tracking_number: "TRK-1",
    label_fetched_at: "2026-10-20T00:00:00Z",
  })];
  const r = res();
  await pending(asAgent(), r);
  assert.equal(r.body.labels.length, 1);
  const l = r.body.labels[0];
  assert.equal(l.id, 1004, "the agent keys everything off this");
  assert.equal(l.name, "John Davis");
  assert.equal(l.consignment_id, "CONS-9");
  assert.equal(l.pdf_url, "/api/labels/1004/pdf");
  assert.match(l.pdf_url, /^\//, "relative, so the agent's own base URL decides the host");
});

test("a printed label is gone from the list", async () => {
  orders = [order({ consignment_id: "C1", label_fetched_at: "x", printed_at: "2026-10-20T01:00:00Z" })];
  const r = res();
  await pending(asAgent(), r);
  assert.deepEqual(r.body.labels, []);
});

test("no session id ever leaves the building", async () => {
  orders = [order({ invoice_number: 7, consignment_id: "C1", label_fetched_at: "x" })];
  const r = res();
  await pending(asAgent(), r);
  assert.ok(!JSON.stringify(r.body).includes("cs_test_"), "a payment session id has no business in an agent's log");
});

// --------------------------------------------------------- reporting back

const post = (id, body) => ({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, query: { id: String(id) }, body });

test("printed: true stamps printed_at and clears any error", async () => {
  orders = [order({ invoice_number: 1004, label_error: "printer was asleep" })];
  const r = res();
  await printed(post(1004, { printed: true }), r);
  assert.equal(r.code, 200);
  assert.equal(r.body.recorded, "printed");
  assert.equal(patches.length, 1);
  assert.ok(patches[0].fields.printed_at, "paper came out, and that is a fact with a time on it");
  assert.equal(patches[0].fields.label_error, null, "the thing that was wrong isn't any more");
});

test("printed: false records the reason and LEAVES IT PENDING", async () => {
  orders = [order({ invoice_number: 1004, consignment_id: "C1", label_fetched_at: "x" })];
  const r = res();
  await printed(post(1004, { printed: false, error: "printer offline" }), r);

  assert.equal(r.code, 200, "a reported failure is a successful request — we now know something needs attention");
  assert.equal(r.body.recorded, "error");
  assert.equal(patches[0].fields.label_error, "printer offline");
  assert.equal(patches[0].fields.printed_at, undefined, "stamping this would make the order silently never go out");

  // And it is still on the list, so the next poll retries it.
  orders[0].label_error = "printer offline";
  const r2 = res();
  await pending(asAgent(), r2);
  assert.equal(r2.body.labels.length, 1, "a failed label must stay pending");
});

test("a failure with no detail still says something", async () => {
  orders = [order({ invoice_number: 1004 })];
  const r = res();
  await printed(post(1004, { printed: false }), r);
  assert.match(patches[0].fields.label_error, /failure/i);
});

test("an over-long error is cut, not rejected", async () => {
  orders = [order({ invoice_number: 1004 })];
  const r = res();
  await printed(post(1004, { printed: false, error: "x".repeat(5000) }), r);
  assert.equal(r.code, 200);
  assert.equal(patches[0].fields.label_error.length, 500);
});

test("reporting the same print twice keeps the FIRST time", async () => {
  orders = [order({ invoice_number: 1004, printed_at: "2026-10-20T01:00:00Z" })];
  const r = res();
  await printed(post(1004, { printed: true }), r);
  assert.equal(r.code, 200);
  assert.equal(r.body.already, true);
  assert.equal(r.body.printed_at, "2026-10-20T01:00:00Z");
  assert.equal(patches.length, 0, "the question is when it printed, and that answer hasn't changed");
});

test("an absent `printed` flag means it printed", async () => {
  orders = [order({ invoice_number: 1004 })];
  const r = res();
  await printed(post(1004, {}), r);
  assert.equal(r.body.recorded, "printed");
});

test("a JSON string body is accepted", async () => {
  orders = [order({ invoice_number: 1004 })];
  const r = res();
  await printed(post(1004, JSON.stringify({ printed: false, error: "out of paper" })), r);
  assert.equal(patches[0].fields.label_error, "out of paper");
});

test("an unknown invoice number is 404, a junk one is 400", async () => {
  const r = res();
  await printed(post(9999, { printed: true }), r);
  assert.equal(r.code, 404);

  const r2 = res();
  await printed(post("not-a-number", { printed: true }), r2);
  assert.equal(r2.code, 400);
  assert.equal(patches.length, 0);
});

test("reporting back needs the token too", async () => {
  orders = [order({ invoice_number: 1004 })];
  const r = res();
  await printed({ method: "POST", headers: {}, query: { id: "1004" }, body: { printed: true } }, r);
  assert.equal(r.code, 401);
  assert.equal(patches.length, 0);
});

test("the wrong method is 405 on both", async () => {
  const a = res();
  await pending({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }, a);
  assert.equal(a.code, 405);

  const b = res();
  await printed({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, query: { id: "1" } }, b);
  assert.equal(b.code, 405);
});

// --------------------------------------------------------------- the database

test("a database that is down is not 'nothing to print'", async () => {
  globalThis.fetch = async () => new Response("down", { status: 500 });
  const r = res();
  await pending(asAgent(), r);
  assert.equal(r.code, 502);
  assert.equal(r.body.labels, undefined);
});

test("an unconfigured database is 503, not an empty list", async () => {
  delete process.env.SUPABASE_URL;
  const r = res();
  await pending(asAgent(), r);
  assert.equal(r.code, 503);
  assert.equal(r.body.labels, undefined);
});


// ------------------------------------------------------------- the A4 sheet

const sheetReq = (id) => ({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, query: { id: String(id) } });

test("the sheet builder makes an A4 PDF", async () => {
  const pdf = await buildLabelSheet({
    labelPng: TINY_PNG,
    order: { invoice_number: 1004, name: "A Customer", items: [{ qty: 1, sku: "flip-g3", name: "G3" }] },
  });
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString("latin1"), "%PDF-");

  // Read the page size back rather than grepping the bytes: pdf-lib compresses
  // object streams, so /MediaBox is not reliably present as plain text.
  const { PDFDocument } = await import("pdf-lib");
  const [page] = (await PDFDocument.load(pdf)).getPages();
  const { width, height } = page.getSize();
  assert.ok(Math.abs(width - 595.28) < 0.01, `A4 width, got ${width}`);
  assert.ok(Math.abs(height - 841.89) < 0.01, `A4 height, got ${height}`);
});

test("a name with a macron does not throw — the whole point of the embedded font", async () => {
  // pdf-lib THROWS on a macron with a built-in font. That is what left
  // Betterservice invoice #01065 with no PDF at all.
  const pdf = await buildLabelSheet({
    labelPng: TINY_PNG,
    order: { invoice_number: 1, name: "Hine Māhia Ngātai-Whakaawe",
             address: { formatted: "12 Ōhauiti Road, Tauranga" },
             items: [{ qty: 1, sku: "flip-g3", name: "G3" }] },
  });
  assert.ok(pdf.length > 1000);
});

test("no label image is a refusal, not a blank sheet", async () => {
  await assert.rejects(() => buildLabelSheet({ labelPng: new Uint8Array(), order: {} }),
    /no label image/i);
});

test("the sheet endpoint returns a PDF once a label is filed", async () => {
  orders = [order({ invoice_number: 1004, consignment_id: "C1", label_fetched_at: "x" })];
  labels["1004"] = TINY_PNG;
  const r = res();
  await labelPdf(sheetReq(1004), r);
  assert.equal(r.code, 200);
  assert.equal(r.headers["Content-Type"], "application/pdf");
  assert.match(r.headers["Content-Disposition"], /FLIP-1004-label\.pdf/);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(Buffer.from(r.body.slice(0, 5)).toString("latin1"), "%PDF-");
});

test("no label filed yet is a 404, not a 500", async () => {
  orders = [order({ invoice_number: 1004 })];
  const r = res();
  await labelPdf(sheetReq(1004), r);
  assert.equal(r.code, 404);
  assert.match(r.body.error, /No label has been filed/);
});

test("the sheet needs the token too", async () => {
  orders = [order({ invoice_number: 1004 })];
  labels["1004"] = TINY_PNG;
  const r = res();
  await labelPdf({ method: "GET", headers: {}, query: { id: "1004" } }, r);
  assert.equal(r.code, 401);
});

test("the sheet rejects a junk id and an unknown order", async () => {
  const a = res();
  await labelPdf(sheetReq("nope"), a);
  assert.equal(a.code, 400);

  const b = res();
  await labelPdf(sheetReq(4242), b);
  assert.equal(b.code, 404);
});
