// GET /api/shop — what the browser needs to draw the shop: whether ordering
// is switched on, each product's price and stock, and shipping rates.
//
// "enabled" is false until STRIPE_SECRET_KEY is set in Vercel. While it's
// false the site's JS adds no buttons and no cart link, so the pages look
// exactly as they did before ecommerce — it's the launch switch.

import { PRODUCTS, MAX_QTY_PER_LINE } from "./_lib/catalog.js";
import { placesConfigured } from "./_lib/places.js";
import { dbConfigured, getStock } from "./_lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const enabled = Boolean(process.env.STRIPE_SECRET_KEY);

  // Stock is best-effort. If the database is down or unconfigured the shop
  // stays open and every product reads as "not tracked" (stock: null).
  let stock = {};
  if (enabled && dbConfigured()) {
    try {
      stock = await getStock();
    } catch (err) {
      console.error("Stock lookup failed; showing shop without stock levels:", err.message);
    }
  }

  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
  return res.status(200).json({
    enabled,
    maxQty: MAX_QTY_PER_LINE,
    addressSearch: placesConfigured(), // false = the cart page shows manual address fields
    products: PRODUCTS.map((p) => ({
      sku: p.sku,
      name: p.name,
      price: p.price,
      stock: Object.hasOwn(stock, p.sku) ? stock[p.sku] : null,
    })),
  });
}
