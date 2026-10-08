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
