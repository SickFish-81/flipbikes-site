// What the courier would actually charge, asked at the moment of quoting.
//
// WHY THIS EXISTS
//
// shipping.js is a hand-kept table. It has been wrong twice in two weeks — the
// old version charged $29 to send three chocks to Auckland when the real price
// was $12.90, and the rebuilt version charged $12.90 when the real price (from
// GoSweetSpot's own rate card for this address) is $15.70. Every correction is
// a guess replaced by a better guess.
//
// It also forced the cart to ASK THE CUSTOMER whether their address is rural,
// because we had no authoritative source. Asking a customer to volunteer a
// surcharge is a poor mechanism. The carrier knows, and says so in every quote.
//
// THE TABLE DOES NOT GO AWAY
//
// It becomes the fallback, permanently. If this call is slow, refused, or the
// key is missing, the shop must still be able to take money — a customer lost
// to somebody else's outage is worse than a dollar of freight. So every path
// through here ends in a usable price.
//
// ONLY CARRIERS THAT WILL COLLECT
//
// Post Haste is usually cheapest into the lower North Island and WILL NOT pick
// up from Te Puke — GoSweetSpot flagged it in writing: their parcels have to be
// dropped at Jellicoe Street. Quoting their price books Craig a drive. So the
// cheapest quote is not the answer; the cheapest quote from a carrier that
// collects is.

import { gssConfigured, destinationFrom, packagesFor, rates } from "./gss.js";
import { quoteShipping } from "./shipping.js";

// Carriers that collect from 556 Te Puke Highway. From GoSweetSpot's proposal,
// 22 Oct 2026: "Post Haste and NZ Couriers consider this location out of zone
// for collections; their services will still be available, but items will need
// to be dropped off at the closest agent/branch."
//
// Override without a deploy, because the day Craig arranges a Post Haste pickup
// this list is wrong and nobody will remember this file exists.
// Exported because booking (consignment.js) must obey the same list: a parcel
// booked with a carrier that won't come to the workshop just sits there.
export const collectingCarriers = () =>
  String(process.env.FLIP_COLLECTING_CARRIERS || "NZ Post Domestic")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const COLLECTS = collectingCarriers;

// The same idea for Australia: NZ Post International is the international
// service that collects from the workshop. Matched by the START of the name,
// because their international services come back as more than one product
// (economy, courier) and we want whichever of them is cheapest.
export const internationalCarriers = () =>
  String(process.env.FLIP_INTL_CARRIERS || "NZ Post")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const intlOk = (name) => {
  const n = String(name || "").toLowerCase();
  return internationalCarriers().some((c) => n.startsWith(c));
};

// What we add to the carrier's number before charging it.
//
// Not greed — slack. A carrier re-measures cartons and bills what it finds, and
// our declared dimensions have been wrong before; a quote can also expire
// between the customer paying and Craig booking. Collecting slightly more than
// it costs is the right direction to be wrong in, and it is the same principle
// the table was written on.
// 2% since 12 Nov 2026 — Ben: 8% "might put people off buying". The 50c
// round-up below still adds a little on top.
const MARKUP = () => Number(process.env.FLIP_FREIGHT_MARKUP || "1.02");
const roundUpTo50c = (cents) => Math.ceil(cents / 50) * 50;

export const liveRatesConfigured = () => gssConfigured();

// -> the same shape quoteShipping returns, plus `source` and `carrier`, or null
// when this cannot answer and the caller should use the table.
//
// NEVER THROWS. A quote is on the path between a customer and a purchase.
export async function liveShipping({ order, parcel, signatureRequired = true }) {
  if (!gssConfigured()) return null;
  const country = order?.address?.country || "NZ";
  if (country !== "NZ" && country !== "AU") return null;
  const au = country === "AU";

  try {
    const destination = destinationFrom(order);
    const packages = packagesFor(parcel);
    // NZ Post International takes ONE parcel per consignment. Ask it about two
    // cartons at once and it adds them together and rejects the lot as "Item
    // over weight" (seen live, 12 Nov, five chocks to Sydney). Each carton
    // goes on its own ticket, so ask about one carton and charge for each.
    // packagesFor() splits the weight evenly, so every carton is the same.
    const perParcel = au && packages.length > 1;
    const asked = perParcel ? [packages[0]] : packages;
    const count = perParcel ? packages.length : 1;
    const { available, rejected, suppressed, validationErrors, keys } = await rates({
      destination, packages: asked, signatureRequired,
      reference: "quote",
    });

    const collects = COLLECTS();
    const usable = available
      .map((q) => ({ q, price: typeof q.Charge === "number" ? q.Charge : null }))
      .filter((x) => x.price !== null && (au
        ? intlOk(x.q.CarrierName)
        : collects.includes(String(x.q.CarrierName || "").toLowerCase())));

    if (!usable.length) {
      // Say why in the log, not to the customer. "No carrier quoted this
      // address" is indistinguishable from a bad address, a lane nobody serves
      // and an account problem unless the reasons are kept.
      const why = (rejected || []).map((r) => `${r.Carrier || "?"}: ${r.Reason || "?"}`).join("; ");
      const seen = available.map((q) => q.CarrierName).join(", ") || "none";
      // Everything the response contained, named. A quote that comes back with
      // nothing usable has exactly one useful property — what it DID contain —
      // and guessing at that has cost three wrong diagnoses already.
      const sup = (suppressed || []).map((q) => q.CarrierName || "?").join(", ") || "none";
      const ve = Object.keys(validationErrors || {}).length
        ? ` — validation: ${JSON.stringify(validationErrors).slice(0, 200)}`
        : "";
      console.error(
        `live rates: nothing usable (available: ${seen}; suppressed: ${sup}` +
        `; keys: ${(keys || []).join("/") || "none"})` +
        (why ? ` — rejected: ${why}` : "") + ve
      );
      return null;
    }

    usable.sort((a, b) => a.price - b.price);
    const best = usable[0];

    // Their rates exclude GST and include FAF/RUC. Ours are GST-inclusive
    // everywhere, because that is how a price is shown to a New Zealander.
    // Freight to Australia is an export and zero-rated, like the goods
    // (invoice.js, GST_ON_AUSTRALIA), so it carries no GST at all.
    const exGst = best.price * count * MARKUP();
    const amount = roundUpTo50c(Math.round(exGst * (au ? 100 : 115))); // dollars -> cents

    return {
      amount,
      label: au
        ? "NZ Post International - Australia"
        : "Courier - New Zealand" + (best.q.IsRuralDelivery ? " (rural delivery)" : ""),
      // The carrier's own answer, not our guess and not the customer's.
      rural: best.q.IsRuralDelivery === true,
      ruralReason: best.q.IsRuralDelivery === true ? "carrier" : null,
      residential: best.q.IsResidentialDelivery === true,
      bag: parcel?.bag === true,
      cartons: parcel?.cartons ?? null,
      tickets: null,                 // a ticket is a concept this pricing does not have
      weightG: parcel?.weightG ?? null,
      region: parcel?.region ?? null,
      source: "carrier",
      carrier: best.q.CarrierName || null,
      quoteId: best.q.QuoteId || null,
      exGstCents: Math.round(best.price * count * 100),
    };
  } catch (err) {
    // Slow, refused, offline: the table answers instead and the sale proceeds.
    console.error("live rates failed, falling back to the table:", err?.message ?? err);
    return null;
  }
}

// The table's answer, tagged so callers can tell which one they got.
export function tableShipping(args) {
  const out = quoteShipping(args);
  return out?.error ? out : { ...out, source: "table", carrier: null };
}
