// Shipping price for an order, from the destination and what is in the box.
//
// HOW NZ POST ACTUALLY CHARGES, because the old version of this file had it
// wrong in a way that cost real money:
//
//   One ticket covers 5kg OR 0.025 m3, whichever runs out first.
//   Each further ticket adds another 5kg / 0.025 m3.
//
// There is no "volumetric weight" divisor and nothing gets gradually dearer as
// the box grows. The cost is a STAIRCASE: you pay the same right up to a line,
// and then you pay double. So the only question that matters is which side of
// the line an order falls.
//
// The old table charged a base rate plus $8 per additional item, on the stated
// belief that "a chock is its own parcel". It is not: THREE chocks go in one
// carton (330 x 200 x 185mm), which is also what Craig tells customers to buy.
// That table charged $29 to send three chocks to Auckland. The real price is
// $12.90, because three chocks and a carton weigh 4.85kg and fit in one ticket.
// It over-charged the most common order in the shop by $16.
//
// WHAT WE KNOW, AND FROM WHERE
//   chock weight 1.5kg ........ Craig, by email, 1 Oct 2026
//   carton 330 x 200 x 185mm .. Ben, 14 Oct 2026 (0.0122 m3 = half a ticket's
//                               volume allowance, so volume never binds here;
//                               weight always decides)
//   ticket prices ............. NZ Post published retail, Oct 2026
//
// The prices below are RETAIL. Craig's Small Business Sending account pays
// commercial rates, which are lower, so every figure here is a ceiling rather
// than a guess - the shop collects slightly more than the freight costs, which
// is the right direction to be wrong in.
//
// All amounts are CENTS, NZD, GST-inclusive.

export const RATES = {
  // Craig ships from Tauranga. "North" is NZ Post's Within Island; "South"
  // really means crossing Cook Strait, priced here at Economy Nationwide
  // rather than the $39.70 express, because a bike chock is not urgent.
  ticketNorth: 1290,
  ticketSouth: 2500,

  ruralSurcharge: 700,  // additive, and still unverified against Craig's account
  au: 6000,             // flat, Australia - UNVERIFIED, untouched by this rewrite

  // A bag, not a carton. An order of nothing but accessories goes in a courier
  // satchel, flat-rated NATIONWIDE - a satchel pays no Cook Strait premium,
  // which is why this one rate replaces BOTH ticket prices rather than sitting
  // alongside them. Without it a $25 set of D Rings to Dunedin was quoted $28
  // of freight, more than the product.
  bagNz: 800,
  bagMaxItems: 4,
  bagMaxWeightG: 3000,  // NZ Post's satchel limit. Four sets of tie-downs exceed it.
};

// One ticket's weight allowance.
export const TICKET_WEIGHT_G = 5000;

// What fits in one carton, and what the empty carton weighs.
//
// ! THE TIGHTEST NUMBER IN THIS FILE !
// Three chocks and a carton = 3 x 1500 + 350 = 4850g, against a 5000g ticket.
// That is 150g of headroom. If the packed carton actually weighs half a kilo,
// a three-chock order silently becomes TWO tickets and the shop under-collects
// by $12.90 (North) or $25.00 (South) on its most common order.
//
// Weigh one made-up, taped, ready-to-send carton and put the real number here.
// Until then this is the one assumption in the file worth distrusting - which
// is why there is a test below that states it out loud.
export const CHOCKS_PER_CARTON = 3;
export const CARTON_WEIGHT_G = 350;

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

// `itemCount` is everything in the cart, `chockCount` just the chocks, and
// `goodsWeightG` the weight of the products themselves (cartons added here).
// order.js works those out from the catalog, so this file stays ignorant of
// the catalog's shape.
export function quoteShipping({ country, postcode, text = "", itemCount, chockCount = itemCount, goodsWeightG = 0, declaredRural = false }) {
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

  // Three ways an address can be rural, and we record WHICH, because Craig
  // needs to know whether to trust it before he books the ticket.
  //
  // `declaredRural` is the customer ticking "this is a rural delivery address"
  // on the cart page. It is ADDITIVE ONLY: an unticked box can never cancel a
  // rural address we detected ourselves, or a customer could opt out of a
  // surcharge the courier charges Craig regardless.
  const ruralReason =
    RURAL_POSTCODES.has(postcode) ? "postcode"
    : RD_PATTERN.test(text)       ? "address"
    : declaredRural               ? "declared"
    : null;
  const rural = ruralReason !== null;
  const ruralCost = rural ? RATES.ruralSurcharge : 0;

  // One bag, one flat price, no island split. Accessories only, few enough to
  // fit, and light enough for a satchel - all three, or it travels as a carton.
  const bag =
    chockCount === 0 &&
    itemCount <= RATES.bagMaxItems &&
    goodsWeightG <= RATES.bagMaxWeightG;

  if (bag) {
    return {
      amount: RATES.bagNz + ruralCost,
      label: "Courier - New Zealand" + (rural ? " (rural delivery)" : ""),
      rural, ruralReason, bag: true, cartons: 0, tickets: 1,
      weightG: goodsWeightG,
      region: north ? "NZ-North" : "NZ-South",
    };
  }

  // Cartons are decided by how many chocks fit in one; accessories ride along
  // in a box that is going anyway and never force another carton.
  const cartons = Math.max(1, Math.ceil(chockCount / CHOCKS_PER_CARTON));
  const weightG = goodsWeightG + cartons * CARTON_WEIGHT_G;

  // You need at least one ticket per carton, and enough tickets to carry the
  // weight. Whichever is greater.
  const tickets = Math.max(cartons, Math.ceil(weightG / TICKET_WEIGHT_G));
  const amount = tickets * (north ? RATES.ticketNorth : RATES.ticketSouth) + ruralCost;

  return {
    amount,
    label: "Courier - New Zealand" + (rural ? " (rural delivery)" : ""),
    rural, ruralReason, bag: false, cartons, tickets, weightG,
    region: north ? "NZ-North" : "NZ-South",
  };
}
