// Shipping price for an order, from the destination and what's in the box.
//
// There is no courier API behind this (NZ Couriers' own API needs 100+
// parcels a day), so this is a RATE TABLE we maintain by hand. It mirrors how
// the courier charges: a base rate by region, a bit extra per additional item,
// and a RURAL surcharge that gets passed on to the customer.
//
// !!! EVERY NUMBER AND THE RURAL LIST BELOW IS A PLACEHOLDER !!!
// Replace them with Craig's real NZ Couriers rates before the shop goes live.
// All amounts are CENTS, NZD, GST-inclusive.

export const RATES = {
  nzNorth: 1200,        // base, one item, North Island
  nzSouth: 1500,        // base, one item, South Island
  extraItem: 300,       // added per additional item in the order...
  maxExtra: 1500,       // ...up to this much in total
  ruralSurcharge: 1000, // added when the address is rural
  au: 6000,             // flat, Australia
};

// Postcodes NZ Couriers treats as rural delivery. EMPTY until Craig supplies
// the list (NZ Couriers publishes one, and has a "check an address" tool).
// While it's empty only the "RD 4"-style check below can flag a rural address.
export const RURAL_POSTCODES = new Set([
  // "3874",
]);

// Postcodes we can't deliver to through the normal flow.
const CONTACT_US_POSTCODES = new Set(["8942"]); // Chatham Islands

// Rural addresses are usually written "RD 2" (Rural Delivery number).
const RD_PATTERN = /\bR\.?\s?D\.?\s?\d{1,2}\b/i;

export function quoteShipping({ country, postcode, text = "", itemCount }) {
  if (country === "AU") {
    return { amount: RATES.au, label: "Courier - Australia", rural: false, region: "AU" };
  }
  if (country !== "NZ") return { error: "We only deliver to New Zealand and Australia online." };

  if (!/^\d{4}$/.test(postcode || "")) return { error: "Please include a valid 4-digit postcode." };
  if (CONTACT_US_POSTCODES.has(postcode)) {
    return { error: "For delivery to that address please contact us for a quote." };
  }

  // NZ postcodes: 0000-6999 North Island, 7000-9999 South Island.
  const north = Number(postcode) < 7000;
  const extra = Math.min(Math.max(itemCount - 1, 0) * RATES.extraItem, RATES.maxExtra);
  const rural = RURAL_POSTCODES.has(postcode) || RD_PATTERN.test(text);
  const amount = (north ? RATES.nzNorth : RATES.nzSouth) + extra + (rural ? RATES.ruralSurcharge : 0);

  return {
    amount,
    label: "Courier - New Zealand" + (rural ? " (rural delivery)" : ""),
    rural,
    region: north ? "NZ-North" : "NZ-South",
  };
}
