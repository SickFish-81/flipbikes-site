// The shop's single source of truth: what is for sale, what it costs, and
// (shipping is in shipping.js). The browser NEVER decides a price — /api/checkout
// looks every item up here, so a tampered cart can't buy a chock for $1.
//
// All amounts are in CENTS, NZD, and GST-INCLUSIVE (NZ consumer prices are
// quoted GST-inclusive, and these match what the site already advertises).
//
// CHANGE A PRICE HERE AND NOWHERE ELSE — and as of 14 Oct 2026 that is finally
// true. It was not before.
//
// This comment used to say the same thing while index.html carried its own
// hand-typed copy of every price, so following it left the homepage
// advertising one number and Stripe charging another. Advertise $150 and
// charge $179 and that is a Fair Trading Act problem, not an untidy one.
//
// The page now reads its prices from /api/shop, which reads them from here.
// The numbers still written into index.html are FALLBACKS, shown only if the
// API never answers — worth keeping accurate, but no longer what decides what
// a customer is quoted. public/js/shop.js -> renderPrices() is the mechanism,
// and test/shop.test.js checks every SKU still has a price hook on the page.

// `size` decides which freight rate applies, and it is the ONLY thing in here
// that isn't money. "small" means the item goes in a courier BAG — a satchel,
// flat-rated nationwide up to 3kg — instead of a carton. See shipping.js.
//
// A product with no `size` is treated as "large", deliberately: a new item can
// never accidentally inherit the cheap rate by someone forgetting a field.
export const PRODUCTS = [
  { sku: "flip-starter-pack", name: "FLIP Starter Pack (1x Standard chock, 2x D rings, 2x tie-downs)", price: 27000, size: "large" },
  { sku: "flip-g3",           name: "FLIP G3 Bike Chock",       price: 17900, size: "large" },
  { sku: "flip-standard",     name: "FLIP Standard Bike Chock", price: 15000, size: "large" },
  { sku: "flip-road",         name: "FLIP Road Bike Chock",     price: 24900, size: "large" },
  { sku: "tie-downs",         name: "Tie Downs",                price: 5950,  size: "small" },
  { sku: "d-rings",           name: "D Rings",                  price: 2500,  size: "small" },
];

export const isSmall = (product) => product?.size === "small";

// Shipping is priced per order from the destination: see shipping.js.

export const MAX_QTY_PER_LINE = 20;

export const bySku = new Map(PRODUCTS.map((p) => [p.sku, p]));

// Turn whatever the browser sent into a clean list of { product, qty }, or
// an { error } string. Merges duplicate lines and rejects anything unknown.
export function parseCart(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: "Your cart is empty." };
  if (items.length > 20) return { error: "Too many items in the cart." };

  const merged = new Map();
  for (const it of items) {
    const product = bySku.get(String(it?.sku ?? ""));
    const qty = Number(it?.qty);
    if (!product) return { error: "One of the items in your cart is no longer available." };
    if (!Number.isInteger(qty) || qty < 1) return { error: "Quantities must be whole numbers." };
    merged.set(product.sku, (merged.get(product.sku) || 0) + qty);
  }

  const lines = [];
  for (const [sku, qty] of merged) {
    if (qty > MAX_QTY_PER_LINE) {
      return { error: `For more than ${MAX_QTY_PER_LINE} of one item, please contact us.` };
    }
    lines.push({ product: bySku.get(sku), qty });
  }
  return { lines };
}

export const money = (cents) => "$" + (cents / 100).toFixed(2);
