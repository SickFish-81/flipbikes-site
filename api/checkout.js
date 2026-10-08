// POST /api/checkout — turn a cart into a Stripe Checkout Session and hand
// back the URL to send the customer to. Stripe hosts the payment page, so
// card details never touch this site.
//
// Body: { items: [{ sku, qty }], country: "NZ" | "AU" }
// Reply: { url } on success, { error } with a 4xx/5xx otherwise.
//
// Prices, shipping and the stock check all happen HERE, from the catalog —
// nothing the browser says about money is trusted.

import { SHIPPING, parseCart } from "./_lib/catalog.js";
import { dbConfigured, getStock } from "./_lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return res.status(503).json({ error: "Online ordering isn't switched on yet. Please contact us to order." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const country = String(body.country ?? "");
  const ship = Object.hasOwn(SHIPPING, country) ? SHIPPING[country] : null;
  if (!ship) return res.status(400).json({ error: "Please choose a delivery country." });

  const cart = parseCart(body.items);
  if (cart.error) return res.status(400).json({ error: cart.error });

  // Stock check. Fails OPEN: if we can't read stock we'd rather take the
  // order than lose a sale to a database hiccup. Craig sees it either way.
  if (dbConfigured()) {
    try {
      const stock = await getStock();
      for (const { product, qty } of cart.lines) {
        if (Object.hasOwn(stock, product.sku) && stock[product.sku] < qty) {
          const left = stock[product.sku];
          return res.status(409).json({
            error: left > 0
              ? `Sorry, only ${left} of "${product.name}" left in stock.`
              : `Sorry, "${product.name}" is out of stock.`,
          });
        }
      }
    } catch (err) {
      console.error("Stock check failed; allowing checkout:", err.message);
    }
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const origin = process.env.SITE_URL?.replace(/\/+$/, "") || `https://${host}`;

  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("success_url", `${origin}/thanks.html`);
  p.set("cancel_url", `${origin}/cart.html`);
  p.set("phone_number_collection[enabled]", "true");
  p.set("shipping_address_collection[allowed_countries][0]", country);
  p.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  p.set("shipping_options[0][shipping_rate_data][display_name]", ship.label);
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(ship.amount));
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "nzd");
  cart.lines.forEach(({ product, qty }, i) => {
    p.set(`line_items[${i}][quantity]`, String(qty));
    p.set(`line_items[${i}][price_data][currency]`, "nzd");
    p.set(`line_items[${i}][price_data][unit_amount]`, String(product.price));
    p.set(`line_items[${i}][price_data][product_data][name]`, product.name);
    p.set(`line_items[${i}][price_data][product_data][metadata][sku]`, product.sku);
  });
  // The webhook reads the order back out of this — it's what we sold.
  p.set("metadata[items]", cart.lines.map(({ product, qty }) => `${product.sku}:${qty}`).join(","));
  p.set("metadata[country]", country);

  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: p,
    });
    const data = await r.json();
    if (!r.ok || !data.url) {
      console.error("Stripe rejected the session:", r.status, JSON.stringify(data));
      return res.status(502).json({ error: "Couldn't start checkout. Please try again, or contact us to order." });
    }
    return res.status(200).json({ url: data.url });
  } catch (err) {
    console.error("Checkout failed:", err);
    return res.status(500).json({ error: "Couldn't start checkout. Please try again, or contact us to order." });
  }
}
