// Everything about turning "a cart + where it's going" into a priced order.
// Shared by /api/quote (live shipping on the cart page) and /api/checkout
// (the real thing), so the number the customer SAW is the number they're
// charged — both run exactly this.

import { parseCart } from "./catalog.js";
import { quoteShipping } from "./shipping.js";
import { details, placesConfigured } from "./places.js";

const clean = (v, max = 120) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

// -> { address } or { error }
// `input` is either { placeId } (chosen from suggestions; looked up here so the
// browser can't lie about the postcode) or { manual: { line1, suburb, city, postcode } }.
export async function resolveAddress(country, input, sessionToken) {
  if (input?.placeId && placesConfigured()) {
    let a;
    try {
      a = await details(String(input.placeId), sessionToken);
    } catch (err) {
      console.error("Address lookup failed:", err.message);
      return { error: "Couldn't look up that address. Try again, or enter it manually." };
    }
    if (a.country && a.country !== country) {
      return { error: `That address isn't in ${country === "NZ" ? "New Zealand" : "Australia"}. Check the delivery country.` };
    }
    if (!a.postcode) return { error: "That address has no postcode. Please pick a more specific address, or enter it manually." };
    return { address: { ...a, country, source: "google" } };
  }

  const m = input?.manual;
  if (m) {
    const line1 = clean(m.line1), city = clean(m.city), postcode = clean(m.postcode, 10), suburb = clean(m.suburb);
    if (!line1 || !city || !postcode) return { error: "Please fill in the street address, town/city and postcode." };
    const formatted = [line1, suburb, city, postcode, country === "NZ" ? "New Zealand" : "Australia"].filter(Boolean).join(", ");
    return { address: { formatted, line1, suburb, city, state: "", postcode, country, source: "manual" } };
  }
  return { error: "Please enter your delivery address." };
}

// -> { lines, address, shipping } or { error, status }
export async function priceOrder({ items, country, address: addressInput, sessionToken }) {
  const cart = parseCart(items);
  if (cart.error) return { error: cart.error, status: 400 };
  if (country !== "NZ" && country !== "AU") return { error: "Please choose a delivery country.", status: 400 };

  const resolved = await resolveAddress(country, addressInput, sessionToken);
  if (resolved.error) return { error: resolved.error, status: 400 };

  const itemCount = cart.lines.reduce((s, l) => s + l.qty, 0);
  const shipping = quoteShipping({
    country,
    postcode: resolved.address.postcode,
    text: resolved.address.formatted,
    itemCount,
  });
  if (shipping.error) return { error: shipping.error, status: 400 };
  return { lines: cart.lines, address: resolved.address, shipping };
}

export { clean };
