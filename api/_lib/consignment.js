// Book one parcel with the carrier and file its label.
//
// This is the step between "a customer paid" and "a label is waiting in the
// printer". It runs when Craig presses "Book courier" on the label sheet in
// the Betterservice dashboard (POST /api/trade, action "book"), never on its
// own: not from the Stripe webhook, not on a timer. A booking costs money, so
// a person asks for each one.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: never create two consignments for
// one order. Stripe can deliver the same webhook twice, Craig can press the
// retry button twice, and a timeout can leave us unsure whether the first
// attempt worked. Two consignments means two labels, two charges, and one
// parcel travelling under a number nobody is tracking.
//
// It is enforced three ways, smallest first:
//   1. we read the order and stop if it already has a consignment id;
//   2. the consignment id is written to the database IMMEDIATELY after the
//      carrier creates it, before anything else that can fail;
//   3. a unique index on flip_orders.consignment_id (migration 0085), because
//      the code is where the mistake happens.
//
// Step 2 is the one that matters. Everything after the booking — fetching the
// label, storing the PNG — is retryable. The booking is not.

import { bySku, isSmall, weightOf } from "./catalog.js";
import { quoteShipping } from "./shipping.js";
import { gssConfigured, destinationFrom, packagesFor, rates, createShipment, fetchLabel } from "./gss.js";
import { orderForConsignment, patchOrder, markLabelError, storeLabelImage } from "./db.js";
import { collectingCarriers } from "./liveRates.js";
import { invoiceNumber } from "./invoice.js";

// What shape the parcel is, from what was actually bought. The ORDER ROW is
// the source, not the live cart: an order placed last week must book the
// parcel it was, even if the catalog has changed since.
export function parcelFor(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const lines = items.map((i) => ({ product: bySku.get(i.sku), qty: Number(i.qty) || 0 }));

  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const chockCount = lines.reduce((s, l) => s + (isSmall(l.product) ? 0 : l.qty), 0);
  const goodsWeightG = lines.reduce((s, l) => s + weightOf(l.product) * l.qty, 0);

  const a = order?.address || {};
  // quoteShipping is asked for the PARCEL, not the price. The price was
  // settled at checkout and the customer has paid it; what is wanted here is
  // how many cartons there are and what they weigh, which is the one place
  // that knows. Re-deriving that here would be a second opinion, and two
  // opinions about how many parcels there are is exactly the bug we cannot
  // afford.
  return quoteShipping({
    country: order?.country || a.country || "NZ",
    postcode: a.postcode || "",
    text: a.formatted || "",
    itemCount,
    chockCount,
    goodsWeightG,
    declaredRural: a.rural === true,
  });
}

// Pick what to book. Cheapest that is actually offered.
//
// `Charge` is what we pay; `Cost` is the carrier's own figure. Sort on Charge
// and fall back to Cost so a carrier that omits one is still comparable
// rather than silently sorting as zero and winning every time.
export function cheapest(available) {
  const priced = available
    .map((q) => ({ q, price: typeof q.Charge === "number" ? q.Charge : (typeof q.Cost === "number" ? q.Cost : null) }))
    .filter((x) => x.price !== null && x.q.QuoteId);
  if (!priced.length) return null;
  priced.sort((a, b) => a.price - b.price);
  return priced[0].q;
}

// Pick what to book: the cheapest quote from a carrier that COLLECTS from the
// workshop. Post Haste and NZ Couriers will happily quote Te Puke Highway and
// then never turn up — their parcels have to be dropped at a depot — so a
// cheaper quote from them is not cheaper, it's a box that doesn't leave. If
// the carrier the customer was quoted at checkout is still offered, it wins.
export function pickCollecting(available, preferred = null) {
  const collects = collectingCarriers();
  const ok = (available || []).filter((q) => collects.includes(String(q.CarrierName || "").toLowerCase()));
  const pref = String(preferred || "").toLowerCase();
  if (pref) {
    const same = cheapest(ok.filter((q) => String(q.CarrierName || "").toLowerCase() === pref));
    if (same) return same;
  }
  return cheapest(ok);
}

// -> { ok, skipped?, reason?, consignmentId?, connote?, carrier?, charge?, trackingUrl?, rural? }
//
// NEVER THROWS. Every caller of this has already taken a customer's money, so
// a carrier outage must not become a 500 that makes Stripe retry the whole
// order. Failures are recorded on the order in `label_error`, where the Emails
// page and the print agent can both see them, and the order stays retryable.
export async function ensureConsignment(sessionId, { signatureRequired = true } = {}) {
  let order = null;
  try {
    order = await orderForConsignment(sessionId);
    if (!order) return { ok: false, reason: `No order with session ${sessionId}.` };

    // Already done, both halves. Nothing to do and nothing to report.
    if (order.consignment_id && order.label_fetched_at) {
      return { ok: true, skipped: true, reason: "Already has a consignment and a label.",
               consignmentId: order.consignment_id, connote: order.tracking_number };
    }

    // No carrier account yet. This is the state of the world rather than a
    // fault with this order, so it does NOT write label_error — an error on
    // every order would train everyone to ignore the column that is supposed
    // to mean something is wrong.
    if (!gssConfigured()) {
      return { ok: false, skipped: true, reason: "No carrier configured (GSS_ACCESS_KEY / GSS_SITE_ID unset)." };
    }

    // Nothing to send. Not an error on the order — the customer is picking it up.
    const a = order.address || {};
    if (a.collect === true) {
      return { ok: false, skipped: true, reason: "This order is being collected — there is no courier to book." };
    }
    // Only NZ is booked from here. International goes NZ Post International,
    // with customs paperwork, and is still ticketed by hand.
    const country = String(order.country || a.country || "NZ").toUpperCase();
    if (country !== "NZ") {
      return { ok: false, skipped: true, reason: `International (${country}) orders are still ticketed by hand.` };
    }

    const reference = order.invoice_number ? invoiceNumber(order.invoice_number) : String(sessionId).slice(-8).toUpperCase();
    const destination = destinationFrom(order);

    // BOOKED ALREADY, LABEL MISSING. The expensive case: the consignment
    // exists and has been paid for, so we must NOT book another one. Go
    // straight to fetching the label for the connote we already hold.
    if (order.consignment_id) {
      await fileLabel(order, order.tracking_number || order.consignment_id);
      return { ok: true, consignmentId: order.consignment_id, connote: order.tracking_number,
               reason: "Recovered the label for a consignment that already existed." };
    }

    const parcel = parcelFor(order);
    if (parcel?.error) throw new Error(`Can't work out the parcel: ${parcel.error}`);
    const packages = packagesFor(parcel);

    const { available, rejected } = await rates({ destination, packages, signatureRequired, reference });
    const pick = pickCollecting(available, order.shipping_carrier);
    if (!pick) {
      // Say WHY nobody quoted. Without this, "no rates" is indistinguishable
      // from a bad address, a lane nobody serves, and an account problem.
      const why = rejected.map((r) => `${r.Carrier || "?"}: ${r.Reason || "no reason"}`).join("; ");
      const others = available.map((q) => q.CarrierName).filter(Boolean);
      const also = others.length ? ` Quoted only by carriers that don't collect from the workshop: ${[...new Set(others)].join(", ")}.` : "";
      throw new Error(`No collecting carrier quoted this address${why ? " — " + why : "."}${also}`);
    }

    const booked = await createShipment({ destination, packages, quoteId: pick.QuoteId, reference, signatureRequired });

    // THE MOMENT THAT MATTERS. The carrier has created a consignment and will
    // charge for it. Record it before doing anything else that can fail, so a
    // crash on the next line can never cause a second booking.
    await patchOrder(sessionId, {
      consignment_id: booked.consignmentId,
      tracking_number: booked.connote,
      label_error: null,
    });

    // What the freight actually cost, for the reports page, so Craig doesn't
    // have to type it in. Their charge excludes GST; freight_cost is GST
    // inclusive cents. Only filled when empty — a figure someone typed wins.
    // Separate from the patch above, and allowed to fail, because nothing
    // about the booking depends on it.
    if (typeof booked.charge === "number" && (order.freight_cost === null || order.freight_cost === undefined)) {
      try {
        await patchOrder(sessionId, {
          freight_cost: Math.round(booked.charge * 115),
          freight_cost_entered_at: new Date().toISOString(),
        });
      } catch (e) { console.error("freight_cost not recorded for", sessionId, e?.message); }
    }

    await fileLabel({ ...order, consignment_id: booked.consignmentId }, booked.connote);

    return {
      ok: true,
      consignmentId: booked.consignmentId,
      connote: booked.connote,
      carrier: booked.carrier || pick.CarrierName || null,
      charge: booked.charge,
      trackingUrl: booked.trackingUrl,
      // What the carrier says about the address, as opposed to what our table
      // guessed and what the customer ticked. This is the answer to the rural
      // question the cart has been asking customers for.
      rural: pick.IsRuralDelivery === true,
    };
  } catch (err) {
    const message = String(err?.message ?? err);
    // Recorded where someone will see it, and the order stays retryable: the
    // next webhook delivery or a press of "Packed and ready to send" tries
    // again. A label that silently stops being attempted is an order that
    // never goes.
    try { await markLabelError(sessionId, message); } catch { /* the real error is the one above */ }
    console.error("Consignment failed for", sessionId, message);
    return { ok: false, reason: message };
  }
}

// Fetch the label and file it. Separate because it is the retryable half, and
// because the recovery path above needs it on its own.
async function fileLabel(order, connote) {
  const png = await fetchLabel(connote);
  await storeLabelImage(order.invoice_number, png);
  // label_fetched_at is what makes the order visible to the print agent —
  // written LAST, after the bytes are safely in storage, so the agent is never
  // offered a label that isn't there. (pendingLabels requires both.)
  await patchOrder(order.session_id, { label_fetched_at: new Date().toISOString() });
}
