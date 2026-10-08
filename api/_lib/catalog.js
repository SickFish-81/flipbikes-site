// The shop's single source of truth: what is for sale, what it costs, and
// what shipping costs. The browser NEVER decides a price — /api/checkout
// looks every item up here, so a tampered cart can't buy a chock for $1.
//
// All amounts are in CENTS, NZD, and GST-INCLUSIVE (NZ consumer prices are
// quoted GST-inclusive, and these match what the site already advertises).
//
// The prices below are the "special price" figures currently shown on
// public/index.html. Change a price here and nowhere else.

export const PRODUCTS = [
  { sku: "flip-starter-pack", name: "FLIP Starter Pack (1x Standard chock, 2x D rings, 2x tie-downs)", price: 27000 },
  { sku: "flip-g3",           name: "FLIP G3 Bike Chock",       price: 17900 },
  { sku: "flip-standard",     name: "FLIP Standard Bike Chock", price: 15000 },
  { sku: "flip-road",         name: "FLIP Road Bike Chock",     price: 24900 },
  { sku: "tie-downs",         name: "Tie Downs",                price: 5950 },
  { sku: "d-rings",           name: "D Rings",                  price: 2500 },
];

// ---------------------------------------------------------------------------
// !!! PLACEHOLDER SHIPPING RATES — Craig needs to confirm these !!!
// Flat rate per ORDER, by destination. They are guesses, not quotes.
// ---------------------------------------------------------------------------
export const SHIPPING = {
  NZ: { label: "Courier - New Zealand", amount: 1500 },
  AU: { label: "Courier - Australia", amount: 6000 },
};

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
