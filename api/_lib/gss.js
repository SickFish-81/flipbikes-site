// GoSweetSpot — the carrier platform that actually sells us labels.
//
// Three calls, in this order, and that is the whole integration:
//
//   POST api/rates            -> what the carriers would charge, with a QuoteId
//   POST api/shipments        -> book one; get a ConsignmentId and a Connote
//   GET  api/labels?connote=  -> the label itself, base64 (a PNG today)
//
// Auth is three headers. No OAuth, no token refresh, no approval queue —
// which is the entire reason this is here and NZ Post's ParcelLabel is not.
// NZ Post told us on 22 Oct 2026 that their API is for commercial customers
// only, and that the eShip keys are a different system that does not reach it.
//
// NOTHING IMPORTS THIS YET. It is deliberately a leaf: no database, no
// Stripe, no response objects. It turns arguments into HTTP and HTTP into
// plain objects, so it can be tested without a carrier and read without
// holding the rest of the shop in your head.

const BASE = () => (process.env.GSS_BASE_URL || "https://api.gosweetspot.com").replace(/\/+$/, "");

export const gssConfigured = () =>
  Boolean(process.env.GSS_ACCESS_KEY && process.env.GSS_SITE_ID);

// THE SAME RULE AS agent.js: unset credentials are a REFUSAL, never a free
// pass. There is no sensible "default" carrier account, and the failure we
// are avoiding is the quiet one — a deploy where consignment creation
// silently does nothing and orders stop getting labels with no error anywhere.
function headers() {
  if (!gssConfigured()) {
    throw new Error("GoSweetSpot is not configured: set GSS_ACCESS_KEY and GSS_SITE_ID.");
  }
  return {
    access_key: process.env.GSS_ACCESS_KEY,
    site_id: String(process.env.GSS_SITE_ID),
    // Their docs call this optional; it is the address they contact about a
    // problem consignment, so it is worth sending.
    support_email: process.env.GSS_SUPPORT_EMAIL || "craig@betterservice.co.nz",
    "Content-Type": "application/json",
    // DELIBERATE, and it cost an evening to learn why: GoSweetSpot 403s some
    // default client user-agents. Identical key, headers and body — curl got
    // 200, Python's urllib got 403 — and a 403 reads exactly like an auth
    // failure. Naming ourselves means we never have to wonder whether the
    // runtime changed its default string underneath us.
    "User-Agent": "flipbikes-shop/1.0 (+https://www.flipbikes.co.nz)",
  };
}

// Serverless functions are billed by the second and Stripe is waiting on the
// other end of this, so a carrier having a bad day must fail rather than hang.
const TIMEOUT_MS = 15000;

async function call(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE()}/${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GoSweetSpot ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- addresses
//
// Their address model, from ours. `Suburb` must be non-empty or the whole
// consignment is rejected with "Suburb/City/Postcode is not valid" — Google
// Places gives us one, a hand-typed address may not, so the city stands in
// rather than sending an empty string.
export function destinationFrom(order) {
  const a = order?.address || {};
  const parts = String(a.formatted || "").split(",").map((s) => s.trim()).filter(Boolean);
  const street = a.line1 || parts[0] || "";
  const suburb = a.suburb || parts[1] || a.city || parts[2] || "";
  const city = a.city || parts[2] || suburb;

  return {
    Name: order?.name || "",
    Address: {
      StreetAddress: street,
      Suburb: suburb,
      City: city,
      PostCode: a.postcode || "",
      CountryCode: a.country || "NZ",
    },
    ContactPerson: order?.name || "",
    PhoneNumber: order?.phone || "",
    Email: order?.email || "",
    // The thing a hand-typed label loses first, and the reason FLIP-1004
    // needed one: "DELIVER TO SITE STORES".
    DeliveryInstructions: a.note || "",
  };
}

// ----------------------------------------------------------------- packages
//
// DIMENSIONS ARE CENTIMETRES. The API stores them as metres and names the
// fields LengthCm / WidthCm / HeightCm, which reads like a bug and is not:
// send 37 for a 37cm carton and it records 0.37. Confirmed by Ben, 22 Oct.
//
// Sizes are Craig's real boxes (flip-freight-and-boxes). Weight comes from
// quoteShipping, which already knows how many cartons an order takes and what
// they weigh — this file does not re-derive it, because two places deciding
// how many parcels there are is how one parcel travels unlabelled.
export const CARTON_CM = { Length: 37, Width: 20, Height: 18.5 };
export const SATCHEL_CM = { Length: 35, Width: 25, Height: 5 };

export function packagesFor(shipping) {
  const count = shipping?.bag ? 1 : Math.max(1, Number(shipping?.cartons) || 1);
  const totalKg = Math.max(0.1, (Number(shipping?.weightG) || 0) / 1000);
  // Split the weight evenly. The carrier bills on the total and re-weighs
  // anything that matters, so an even split is honest rather than precise.
  const kg = Math.round((totalKg / count) * 100) / 100;
  const dims = shipping?.bag ? SATCHEL_CM : CARTON_CM;
  return Array.from({ length: count }, () => ({
    Name: shipping?.bag ? "Satchel" : "Carton",
    ...dims,
    Kg: kg,
    HasDG: false,
  }));
}

// -------------------------------------------------------------------- calls

// What the carriers would charge. Returns { available, rejected }.
//
// `Rejected` is kept and handed back rather than dropped: when no carrier
// quotes, the reason they each gave is the only way to tell a bad address
// from a lane nobody serves.
export async function rates({ destination, packages, signatureRequired = true, reference = "" }) {
  const body = {
    DeliveryReference: String(reference).slice(0, 60),
    Destination: destination,
    Packages: packages,
    IsSignatureRequired: signatureRequired,
    IsSaturdayDelivery: false,
  };
  const out = await call("api/rates", { method: "POST", body });
  return { available: out?.Available || [], rejected: out?.Rejected || [] };
}

// Book it. Returns { consignmentId, connote, trackingUrl, carrier, charge }.
//
// QuoteId and Carrier are mutually exclusive — their docs are explicit that
// supplying a QuoteId makes carrier and service ignored. We always pass the
// QuoteId we were quoted, so the price the shop reasoned about is the price
// booked, rather than whatever is cheapest a few seconds later.
export async function createShipment({ destination, packages, quoteId, reference = "", signatureRequired = true }) {
  const body = {
    QuoteId: quoteId,
    Destination: destination,
    Packages: packages,
    DeliveryReference: String(reference).slice(0, 50),
    IsSignatureRequired: signatureRequired,
    IsSaturdayDelivery: false,
    PrintToPrinter: "false",
  };
  const out = await call("api/shipments", { method: "POST", body });

  // Their failures come back 200 with an Errors array, so a non-OK status is
  // not the only way this goes wrong.
  const errors = out?.Errors || [];
  const c = out?.Consignments?.[0];
  if (!c?.Connote) {
    throw new Error(`GoSweetSpot created no consignment: ${errors.join("; ") || out?.Message || "no reason given"}`);
  }
  return {
    consignmentId: String(c.ConsignmentId ?? c.Connote),
    connote: String(c.Connote),
    trackingUrl: c.TrackingUrl || null,
    carrier: out?.CarrierName || null,
    charge: typeof c.Charge === "number" ? c.Charge : null,
  };
}

// The label, as bytes. They return a JSON array of base64 documents; today
// that is a PNG even when the site is set to PDF, which suits us — pdf-lib
// embeds a PNG directly onto the A5 half-sheet with no PDF parsing at all.
export async function fetchLabel(connote) {
  const out = await call(`api/labels?connote=${encodeURIComponent(connote)}`);
  const first = Array.isArray(out) ? out[0] : out?.[0] ?? out;
  const b64 = typeof first === "string" ? first : first?.Contents || first?.File || null;
  if (!b64) throw new Error(`GoSweetSpot returned no label for connote ${connote}`);
  return new Uint8Array(Buffer.from(String(b64), "base64"));
}
