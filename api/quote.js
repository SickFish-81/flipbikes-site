// POST /api/quote — live shipping price for the cart page.
// Body: { items, country, address: { placeId } | { manual: {...} }, sessionToken,
//         ruralDeclared }
// Reply: { amount, label, rural, ruralReason, address: { formatted } } or { error }.

import { priceOrder } from "./_lib/order.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  const o = await priceOrder({
    items: b.items,
    country: String(b.country ?? ""),
    address: b.address,
    sessionToken: b.sessionToken,
    declaredRural: b.ruralDeclared === true,
  });
  if (o.error) return res.status(o.status || 400).json({ error: o.error });
  return res.status(200).json({
    amount: o.shipping.amount,
    label: o.shipping.label,
    rural: o.shipping.rural,
    ruralReason: o.shipping.ruralReason,
    address: { formatted: o.address.formatted },
  });
}
