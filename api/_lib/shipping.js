// Shipping price for an order, from the destination and what's in the box.
//
// There is no courier API behind this (NZ Couriers' own API needs 100+
// parcels a day), so this is a RATE TABLE we maintain by hand. It mirrors how
// the courier charges: a base rate by region, a bit extra per additional item,
// and a RURAL surcharge that gets passed on to the customer.
//
// These are ESTIMATES, set 13 Oct 2026, not Craig's NZ Couriers account rates.
// They are anchored on NZ Post's published 2026 retail prices with an account
// discount assumed, because NZ Couriers do not publish a rate card:
//
//   within-island large parcel, first 5kg ... $12.90 retail
//   nationwide (crossing Cook Strait) ....... $39.70 retail, $25.00 economy
//   rural delivery .......................... $6.00 per item
//
// Replace with Craig's real account rates when they arrive. All amounts are
// CENTS, NZD, GST-inclusive.
//
// NOTE on nzSouth: Craig ships from Tauranga, so "South Island" really means
// "crosses the Cook Strait" — that is the expensive leg, not a minor uplift.
// The old $15.00 placeholder was the single biggest under-collection risk.
//
// NOTE on extraItem: NZ Post charges each additional 5kg at the SAME rate as
// the first, so a second chock is nearer a second ticket than a small add-on.
//
// NOTE on volumetric weight: carriers charge the GREATER of actual weight and
// volumetric weight, rounded up to the nearest 5kg. Box dimensions therefore
// set the price as much as the product does — see the packaging item.

export const RATES = {
  nzNorth: 1300,        // base, one item, North Island (within-island)
  nzSouth: 2800,        // base, one item, South Island (crosses the Strait)
  extraItem: 800,       // added per additional item in the order...
  maxExtra: 2400,       // ...up to this much in total (caps at 3 extra items)
  ruralSurcharge: 700,  // added when the address is rural
  au: 6000,             // flat, Australia — UNVERIFIED, international is dear
};

// Postcodes NZ Couriers treats as rural delivery.
//
// DELIBERATELY EMPTY, and not an oversight. Researched 10 Oct 2026:
//
//  - NZ Couriers publish NO rural list. Their words: "Rural/Non-Urban areas
//    are defined by New Zealand Couriers as those that sit outside our
//    regularly serviced areas", and this "may differ from the rural
//    classification of other courier and postal companies". The only way to
//    classify an address is their Address Checker, one address at a time:
//    https://www.nzcouriers.co.nz/address_checker.html
//  - The one list that IS public comes from NZ POST's Rural Delivery
//    Directory, i.e. a different carrier's definition. Loading it here would
//    charge a $10 surcharge to customers NZ Couriers delivers at urban rates.
//    Under-charging costs Craig a known amount; over-charging quietly takes
//    money off real customers and comes back as chargebacks. So we don't.
//
// Fill this ONLY from data NZ Couriers gave Craig for his own account. Until
// then rural is caught two ways: the RD pattern below, and the customer saying
// so on the cart page.
export const RURAL_POSTCODES = new Set([
  // "3874",
]);

// Postcodes we can't deliver to through the normal flow.
const CONTACT_US_POSTCODES = new Set(["8942"]); // Chatham Islands

// Rural addresses are usually written "RD 2" (Rural Delivery number), and
// sometimes spelled out in full.
const RD_PATTERN = /\b(?:R\.?\s?D\.?|RURAL\s+DELIVERY)\s?\d{1,2}\b/i;

export function quoteShipping({ country, postcode, text = "", itemCount, declaredRural = false }) {
  if (country === "AU") {
    return { amount: RATES.au, label: "Courier - Australia", rural: false, ruralReason: null, region: "AU" };
  }
  if (country !== "NZ") return { error: "We only deliver to New Zealand and Australia online." };

  if (!/^\d{4}$/.test(postcode || "")) return { error: "Please include a valid 4-digit postcode." };
  if (CONTACT_US_POSTCODES.has(postcode)) {
    return { error: "For delivery to that address please contact us for a quote." };
  }

  // NZ postcodes: 0000-6999 North Island, 7000-9999 South Island.
  const north = Number(postcode) < 7000;
  const extra = Math.min(Math.max(itemCount - 1, 0) * RATES.extraItem, RATES.maxExtra);

  // Three ways an address can be rural, and we record WHICH, because Craig
  // needs to know whether to trust it before he books the ticket.
  //
  // `declaredRural` is the customer ticking "this is a rural delivery address"
  // on the cart page. It is ADDITIVE ONLY: an unticked box can never cancel a
  // rural address we detected ourselves, or a customer could opt out of a
  // surcharge the courier is going to charge Craig regardless.
  const ruralReason =
    RURAL_POSTCODES.has(postcode) ? "postcode"
    : RD_PATTERN.test(text)       ? "address"
    : declaredRural               ? "declared"
    : null;
  const rural = ruralReason !== null;
  const amount = (north ? RATES.nzNorth : RATES.nzSouth) + extra + (rural ? RATES.ruralSurcharge : 0);

  return {
    amount,
    label: "Courier - New Zealand" + (rural ? " (rural delivery)" : ""),
    rural,
    ruralReason,
    region: north ? "NZ-North" : "NZ-South",
  };
}
