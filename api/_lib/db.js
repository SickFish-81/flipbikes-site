// Tiny Supabase REST client (no SDK, so the project stays dependency-free).
// Used for stock levels and the order log. Everything here is OPTIONAL: if
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, the shop still takes
// payments — it just can't track stock.

const url = () => process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

export const dbConfigured = () => Boolean(url() && key());

async function call(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${url()}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// { sku: qty } for every SKU that has a stock row. A SKU with no row is
// simply absent, which callers treat as "not tracked" (unlimited).
export async function getStock() {
  const rows = await call("flip_stock?select=sku,qty");
  return Object.fromEntries(rows.map((r) => [r.sku, r.qty]));
}

// Take stock off the shelf; returns the new quantity (never below zero).
export async function takeStock(sku, qty) {
  const out = await call("rpc/flip_take_stock", { method: "POST", body: { p_sku: sku, p_qty: qty } });
  return typeof out === "number" ? out : null;
}

// Claim an order by its Stripe session id. Returns the order row. The
// primary key makes this safe against Stripe delivering the same webhook
// twice: the second insert is ignored and we read back the existing row.
export async function claimOrder(order) {
  await call("flip_orders", { method: "POST", body: order, prefer: "resolution=ignore-duplicates,return=minimal" });
  const rows = await call(`flip_orders?session_id=eq.${encodeURIComponent(order.session_id)}&select=*`);
  return rows[0];
}

export async function patchOrder(sessionId, fields) {
  await call(`flip_orders?session_id=eq.${encodeURIComponent(sessionId)}`, { method: "PATCH", body: fields, prefer: "return=minimal" });
}

// Record an email we sent, so there is a trace of it whether or not it arrives.
//
// WHY: before this, the shop logged nothing. A row only appeared if Resend's
// delivery webhook called back, and it created that row labelled kind
// 'unknown', with no link to the order, and with only ONE recipient — Resend
// fires a separate event per recipient, and the webhook sets to_email only
// when it CREATES the row, never on the updates that follow. On 14 Oct that
// made it look as though Craig had not been emailed about FLIP-1002. He had.
// Worse: an email that failed before reaching Resend at all left no trace
// anywhere.
//
// `resend_id` is what matters most. It is UNIQUE, and it is the key Resend's
// webhook looks a row up by — so writing it here is what makes the delivery
// events land on OUR row, properly labelled, instead of creating another
// orphan.
//
// Two calls on purpose:
//   1. INSERT, ignoring a duplicate. Resend's webhook may have raced us and
//      created the row first; we must never clobber a status it has set.
//   2. PATCH the labels — kind, recipients, subject, the order link —
//      whichever of us got there first. Deliberately NOT status: from the
//      moment the message is accepted, status belongs to the webhook.
export async function logEmail({ kind, to, subject, resendId, sessionId, status = "accepted", error = null }) {
  const to_email = (Array.isArray(to) ? to : [to]).filter(Boolean).join(", ");
  const labels = { kind, to_email, subject: subject ?? null, flip_session_id: sessionId ?? null };

  await call("email_log?on_conflict=resend_id", {
    method: "POST",
    body: { ...labels, resend_id: resendId ?? null, status, error },
    prefer: "resolution=ignore-duplicates,return=minimal",
  });

  // A failed send has no resend_id, so there is nothing to match on — and
  // nothing to correct either, because the insert above cannot have collided
  // (UNIQUE permits any number of nulls).
  if (resendId) {
    await call(`email_log?resend_id=eq.${encodeURIComponent(resendId)}`, {
      method: "PATCH",
      body: labels,
      prefer: "return=minimal",
    });
  }
}

// ------------------------------------------------------------------- labels
//
// What the print agent polls for, and how it reports back. See
// tools/print-agent/README.md for the other half of this contract and
// migration 0085 in the betterservice-app repo for the columns.

// Orders whose label exists, has been fetched, and has NOT printed yet.
//
// All three conditions matter, and the middle one is the one that keeps the
// agent honest: a row is only offered once there is a PDF to give it.
// `label_fetched_at is null` means the consignment exists but the document
// doesn't, so handing that row over would have the agent fail, report an
// error and try again a minute later, forever. Until the consignment step is
// built nothing satisfies this and the agent is correctly told "nothing to
// print" — which is the truth, not a failure.
//
// Oldest first: if two labels are waiting, the customer who has been waiting
// longer gets their parcel moving first.
export async function pendingLabels(limit = 20) {
  const cols = "invoice_number,name,consignment_id,tracking_number,label_fetched_at,printed_at";
  return await call(
    `flip_orders?select=${cols}` +
      "&printed_at=is.null&consignment_id=not.is.null&label_fetched_at=not.is.null" +
      `&order=created_at.asc&limit=${Number(limit) || 20}`
  );
}

export async function orderByInvoiceNumber(invoiceNumber) {
  const rows = await call(
    `flip_orders?invoice_number=eq.${Number(invoiceNumber)}` +
      "&select=session_id,invoice_number,name,printed_at,consignment_id,label_error"
  );
  return rows[0] || null;
}

// Paper came out. Recorded ONCE: if it is already stamped we keep the first
// time, because the question this column answers is "when did this label
// print", and a second poll re-printing it does not change that answer. It
// also clears whatever error was there — the thing that was wrong isn't any
// more.
export async function markLabelPrinted(sessionId) {
  await patchOrder(sessionId, { printed_at: new Date().toISOString(), label_error: null });
}

// It didn't print, and this is why, in words Craig can act on. printed_at is
// deliberately left alone: the label stays pending, so the next poll tries
// again. A label that silently stops being offered is how an order never goes.
export async function markLabelError(sessionId, message) {
  await patchOrder(sessionId, { label_error: String(message ?? "").slice(0, 500) || "unknown error" });
}

// Everything the picking half of the label sheet needs.
export async function orderForLabel(invoiceNumber) {
  const cols = "session_id,invoice_number,name,created_at,address,items,shipping_amount,printed_at,consignment_id";
  const rows = await call(`flip_orders?invoice_number=eq.${Number(invoiceNumber)}&select=${cols}`);
  return rows[0] || null;
}

// The carrier's label, as stored by the consignment step: one PNG per order in
// the `flip-labels` bucket, named by invoice number. Returns null when there
// isn't one, which is a normal state and not an error.
//
// Storage is not PostgREST, so it does not go through call() — different base
// path, and the body is bytes rather than JSON.
export async function labelImage(invoiceNumber) {
  const r = await fetch(`${url()}/storage/v1/object/flip-labels/${Number(invoiceNumber)}.png`, {
    headers: { apikey: key(), Authorization: `Bearer ${key()}` },
  });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`Storage said ${r.status}: ${await r.text()}`);
  return new Uint8Array(await r.arrayBuffer());
}

// File the carrier's label so it can be printed later, and re-printed without
// going back to the carrier. One PNG per order, named by invoice number — the
// same name labelImage() reads back.
//
// `upsert: true` because this must be safe to repeat: a retried consignment
// step that re-fetched the same label should overwrite its own file rather
// than fail on a name that already exists.
export async function storeLabelImage(invoiceNumber, bytes, contentType = "image/png") {
  const r = await fetch(`${url()}/storage/v1/object/flip-labels/${Number(invoiceNumber)}.png`, {
    method: "POST",
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Storage upload said ${r.status}: ${await r.text()}`);
}

// Everything the consignment step needs to book a parcel: who it goes to,
// what is in it, and whether it has been booked already.
export async function orderForConsignment(sessionId) {
  const cols = "session_id,invoice_number,name,email,phone,country,address,items," +
    "shipping_amount,shipping_carrier,freight_cost,consignment_id,tracking_number,label_fetched_at,label_error";
  const rows = await call(`flip_orders?session_id=eq.${encodeURIComponent(sessionId)}&select=${cols}`);
  return rows[0] || null;
}

// What the "Book courier" button needs to decide whether it may book at all.
// By invoice number, because that is what the dashboard knows the order by.
export async function orderForBooking(invoiceNumber) {
  const cols = "session_id,invoice_number,country,address,packed_at,consignment_id," +
    "tracking_number,label_fetched_at,label_error";
  const rows = await call(`flip_orders?invoice_number=eq.${Number(invoiceNumber)}&select=${cols}`);
  return rows[0] || null;
}

// ------------------------------------------------------------- trade orders

// Is whoever holds this token an OWNER of the Betterservice app?
//
// The token is the caller's own Supabase session, sent from the dashboard. It
// is checked by asking the database — as that user, not as the service role —
// so the answer comes from the same is_owner() that guards every owner policy
// in the app. There is no second copy of "who is an owner" to drift.
//
// The service key goes in `apikey` only, which the gateway needs to accept the
// request at all; the Authorization header is the user's, and that is what the
// database runs the query as. Anything other than a plain `true` is a no:
// a bad token, an expired one, a staff member who is not an owner, an outage.
export async function callerIsOwner(token) {
  if (!dbConfigured() || !token) return false;
  try {
    const r = await fetch(`${url()}/rest/v1/rpc/is_owner`, {
      method: "POST",
      headers: { apikey: key(), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

// One trade order, with everything its invoice needs. Read through the
// service role: callerIsOwner() has already decided who may ask.
export async function tradeOrderByInvoice(invoiceNumber) {
  const cols = "session_id,invoice_number,created_at,channel,name,phone,country,address,items," +
    "amount_total,shipping_amount,amount_ex_gst,gst_amount,shipping_ex_gst," +
    "bill_to,due_date,paid_at,emailed,customer_ref,placed_via,dealer_id";
  const rows = await call(`flip_orders?invoice_number=eq.${Number(invoiceNumber)}&select=${cols}`);
  return rows[0] || null;
}

// ------------------------------------------------------------ dealer portal
//
// All through the service key: the dealer is not a database user (see
// dealerAuth.js). /api/dealer decides who is asking before any of these run,
// and every query below is pinned to that one dealer's id.

const DEALER_COLS = "id,business,contact,email,phone,address,tier_id,portal_access,session_version";

export async function dealerByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  const rows = await call(`flip_dealers?email=eq.${encodeURIComponent(e)}&select=${DEALER_COLS}`);
  return rows[0] || null;
}

export async function dealerById(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const rows = await call(`flip_dealers?id=eq.${id}&select=${DEALER_COLS}`);
  return rows[0] || null;
}

export async function codesSince(dealerId, sinceIso) {
  const rows = await call(`flip_dealer_codes?dealer_id=eq.${dealerId}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`);
  return rows.length;
}

export async function insertCode(dealerId, codeHash, expiresIso) {
  await call("flip_dealer_codes", {
    method: "POST",
    body: { dealer_id: dealerId, code_hash: codeHash, expires_at: expiresIso },
    prefer: "return=minimal",
  });
}

// The newest code that is still usable: not used, not expired.
export async function liveCode(dealerId, nowIso) {
  const rows = await call(
    `flip_dealer_codes?dealer_id=eq.${dealerId}&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}` +
    "&select=id,code_hash,attempts&order=created_at.desc&limit=1");
  return rows[0] || null;
}

export async function patchCode(id, fields) {
  await call(`flip_dealer_codes?id=eq.${Number(id)}`, { method: "PATCH", body: fields, prefer: "return=minimal" });
}

export async function dealerPriceList(dealerId) {
  return call("rpc/flip_dealer_price_list", { method: "POST", body: { p_dealer_id: dealerId } });
}

// Returns { ok: true, order } or { ok: false, error } — the database's own
// message, because its refusals ("only an owner…", "postcode must be 4
// digits") are written to be shown to a person.
export async function createDealerOrder(dealerId, order) {
  const r = await fetch(`${url()}/rest/v1/rpc/create_flip_dealer_order`, {
    method: "POST",
    headers: { apikey: key(), Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_dealer_id: dealerId, p_order: order }),
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (r.ok) return { ok: true, order: j };
  // P0001 = a RAISE in the function: a message meant for a person. Anything
  // else is ours to look at, not the dealer's to read.
  if (j?.code === "P0001" || j?.code === "42501") return { ok: false, error: j.message };
  throw new Error(`create_flip_dealer_order -> ${r.status}: ${text}`);
}

export async function dealerOrders(dealerId) {
  const cols = "invoice_number,created_at,name,address,items,amount_total,due_date,paid_at,packed_at,tracking_number,customer_ref";
  return call(`flip_orders?dealer_id=eq.${dealerId}&select=${cols}&order=created_at.desc&limit=50`);
}
