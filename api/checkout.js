// POST /api/checkout — turn a cart + delivery details into a Stripe Checkout
// Session and hand back the URL to send the customer to. Stripe hosts the
// payment page, so card details never touch this site.
//
// Body: { items: [{sku, qty}], country, address: {placeId}|{manual}, sessionToken,
//         name, email, phone, note }
// Reply: { url } on success, { error } with a 4xx/5xx otherwise.
//
// The delivery address is collected on OUR cart page (so the shipping price,
// including any rural surcharge, is known before payment) and passed to Stripe
// rather than asked for again there. Prices, shipping and the stock check all
// happen HERE — nothing the browser says about money is trusted.

import { dbConfigured, getStock } from "./_lib/db.js";
import { priceOrder, clean } from "./_lib/order.js";

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

  const name = clean(body.name, 100);
  const email = clean(body.email, 200);
  const phone = clean(body.phone, 30);
  const note = clean(body.note, 200);
  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "That email address doesn't look right." });
  if (phone.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "Please enter a phone number the courier can reach you on." });

  const order = await priceOrder({
    items: body.items,
    country: String(body.country ?? ""),
    address: body.address,
    sessionToken: body.sessionToken,
  });
  if (order.error) return res.status(order.status || 400).json({ error: order.error });
  const { lines, address, shipping } = order;

  // Stock check. Fails OPEN: if we can't read stock we'd rather take the
  // order than lose a sale to a database hiccup. Craig sees it either way.
  if (dbConfigured()) {
    try {
      const stock = await getStock();
      for (const { product, qty } of lines) {
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
  p.set("customer_email", email);
  p.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  p.set("shipping_options[0][shipping_rate_data][display_name]", shipping.label);
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(shipping.amount));
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "nzd");
  lines.forEach(({ product, qty }, i) => {
    p.set(`line_items[${i}][quantity]`, String(qty));
    p.set(`line_items[${i}][price_data][currency]`, "nzd");
    p.set(`line_items[${i}][price_data][unit_amount]`, String(product.price));
    p.set(`line_items[${i}][price_data][product_data][name]`, product.name);
    p.set(`line_items[${i}][price_data][product_data][metadata][sku]`, product.sku);
  });

  // Shows the delivery address on the payment in the Stripe dashboard.
  p.set("payment_intent_data[shipping][name]", name);
  p.set("payment_intent_data[shipping][phone]", phone);
  p.set("payment_intent_data[shipping][address][line1]", address.line1 || address.formatted);
  if (address.city) p.set("payment_intent_data[shipping][address][city]", address.city);
  if (address.state) p.set("payment_intent_data[shipping][address][state]", address.state);
  p.set("payment_intent_data[shipping][address][postal_code]", address.postcode);
  p.set("payment_intent_data[shipping][address][country]", address.country);

  // The webhook reads the order back out of this — it's what we sold and where
  // it's going. (Stripe allows 500 characters per metadata value.)
  p.set("metadata[items]", lines.map(({ product, qty }) => `${product.sku}:${qty}`).join(","));
  p.set("metadata[country]", address.country);
  p.set("metadata[name]", name);
  p.set("metadata[phone]", phone);
  p.set("metadata[addr]", address.formatted.slice(0, 480));
  p.set("metadata[postcode]", address.postcode);
  p.set("metadata[rural]", shipping.rural ? "yes" : "no");
  p.set("metadata[addr_source]", address.source);
  if (note) p.set("metadata[note]", note);

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
