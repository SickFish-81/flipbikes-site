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
