// POST /api/stripe-webhook — Stripe tells us a payment succeeded.
//
// This is where an order actually becomes real: take the stock off the
// shelf, email the customer a confirmation, and email Craig what to ship.
// Set it up in Stripe: Developers > Webhooks > add endpoint
//   https://flipbikes.co.nz/api/stripe-webhook
// listening for the single event `checkout.session.completed`, then put the
// endpoint's signing secret in Vercel as STRIPE_WEBHOOK_SECRET.
//
// Stripe retries any non-2xx reply for days and may also deliver the same
// event twice, so every step is safe to repeat: the order is claimed by its
// Stripe session id, and "stock taken" / "emailed" are recorded per order.

import crypto from "node:crypto";
import { bySku, money } from "./_lib/catalog.js";
import { dbConfigured, claimOrder, patchOrder, takeStock } from "./_lib/db.js";

// Signature checking needs the EXACT bytes Stripe sent, so Vercel must not
// parse the body for us.
export const config = { api: { bodyParser: false } };

const TO = "craig@betterservice.co.nz";
const FROM = "Flip Bikes Website <noreply@flipbikes.co.nz>";
const REPLY_TO = "craig@betterservice.co.nz";

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

// https://docs.stripe.com/webhooks#verify-manually
export function verifySignature(payload, header, secret, now = Date.now(), toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  // Stripe can send several v1 signatures (during secret rotation); any may match.
  const candidates = header.split(",").filter((s) => s.trim().startsWith("v1=")).map((s) => s.trim().slice(3));
  const exp = Buffer.from(expected);
  return candidates.some((c) => {
    const buf = Buffer.from(c);
    return buf.length === exp.length && crypto.timingSafeEqual(buf, exp);
  });
}

// "flip-g3:2,d-rings:4" -> [{ sku, name, qty, unit_amount }]
export function itemsFromMetadata(str) {
  return String(str || "")
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const [sku, q] = pair.split(":");
      const p = bySku.get(sku);
      return { sku, name: p?.name || sku, qty: Number(q) || 0, unit_amount: p?.price ?? null };
    });
}

function buildEmails(order, remaining) {
  const a = order.address || {};
  const addr = a.formatted
    ? a.formatted.split(", ").join("\n") + (a.note ? `\n(Delivery note: ${a.note})` : "")
    : [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(" "), a.postal_code, a.country].filter(Boolean).join("\n");
  const typedLine = a.typed ? "  Address was typed in by the customer, not checked against Google Maps - give it a look.\n" : "";
  const ruralLine = typedLine + (a.formatted
    ? (a.rural
        ? "  Rural delivery: YES - the rural surcharge was charged to the customer.\n"
        : "  Rural delivery: not flagged by our table. Worth a quick check on NZ Couriers' address tool before booking.\n")
    : "");
  const lines = order.items
    .map((i) => `  ${i.qty} x ${i.name}` + (i.unit_amount != null ? `  @ ${money(i.unit_amount)}` : ""))
    .join("\n");
  const totals =
    `  Shipping: ${money(order.shipping_amount ?? 0)}\n` +
    `  TOTAL PAID: ${money(order.amount_total ?? 0)} NZD (GST inclusive)`;

  const low = Object.entries(remaining)
    .filter(([, q]) => q != null && q <= 2)
    .map(([sku, q]) => `  ${bySku.get(sku)?.name || sku}: ${q === 0 ? "OUT OF STOCK" : q + " left"}`);

  const craig =
    `New Flip Bikes order - paid.\n\n` +
    `Items:\n${lines}\n${totals}\n\n` +
    `Ship to:\n  ${order.name || "(no name)"}\n${addr ? addr.split("\n").map((l) => "  " + l).join("\n") : "  (no address)"}\n${ruralLine}\n` +
    `Contact:\n  Email: ${order.email || "(none)"}\n  Phone: ${order.phone || "(none)"}\n\n` +
    (low.length ? `Stock now low:\n${low.join("\n")}\n\n` : "") +
    `Stripe: https://dashboard.stripe.com/payments/${order.payment_intent || ""}\n` +
    `Order ref: ${order.session_id}\n`;

  const customer =
    `Hi ${order.name || "there"},\n\n` +
    `Thanks for your Flip Bikes order - your payment has been received.\n\n` +
    `Your order:\n${lines}\n${totals}\n\n` +
    `Shipping to:\n${addr ? addr.split("\n").map((l) => "  " + l).join("\n") : "  (address on file)"}\n\n` +
    `Orders are usually shipped the next business day. If you have any questions, just reply to this email ` +
    `or call Craig on +64 021 0832 7787.\n\n` +
    `Cheers,\nFLIP Bike Chocks\n`;

  return { craig, customer };
}

async function send(key, { to, subject, text, reply_to }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to, subject, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; cannot verify webhook.");
    return res.status(500).send("Webhook not configured");
  }

  const payload = await rawBody(req);
  if (!verifySignature(payload, req.headers["stripe-signature"], secret)) {
    return res.status(400).send("Bad signature");
  }

  let event;
  try { event = JSON.parse(payload); } catch { return res.status(400).send("Bad JSON"); }

  // We only ever act on completed checkouts; acknowledge anything else.
  if (event.type !== "checkout.session.completed") return res.status(200).send("Ignored");

  const s = event.data?.object || {};
  if (s.payment_status && s.payment_status !== "paid") return res.status(200).send("Not paid yet");

  // Name, phone and address were collected on OUR cart page and ride along in
  // metadata. Older sessions (or ones started elsewhere) fall back to whatever
  // Stripe collected itself.
  const m = s.metadata || {};
  const shipping = s.collected_information?.shipping_details || s.shipping_details || {};
  const details = s.customer_details || {};
  const order = {
    session_id: s.id,
    payment_intent: s.payment_intent,
    name: m.name || shipping.name || details.name || null,
    email: details.email || s.customer_email || null,
    phone: m.phone || details.phone || null,
    country: m.country || shipping.address?.country || null,
    address: m.addr
      ? { formatted: m.addr, postcode: m.postcode || null, rural: m.rural === "yes", note: m.note || null, typed: m.addr_source === "manual" }
      : shipping.address || details.address || null,
    items: itemsFromMetadata(m.items),
    amount_total: s.amount_total ?? null,
    shipping_amount: s.total_details?.amount_shipping ?? null,
  };

  try {
    // Claim the order. Without a database we can't dedupe, so a retried
    // webhook could email twice — acceptable only until Supabase is set up.
    let row = { stock_taken: false, emailed: false };
    if (dbConfigured()) {
      const { payment_intent, ...dbOrder } = order;
      row = await claimOrder(dbOrder);
    }

    const remaining = {};
    if (!row.stock_taken) {
      if (dbConfigured()) {
        for (const i of order.items) remaining[i.sku] = await takeStock(i.sku, i.qty);
        await patchOrder(order.session_id, { stock_taken: true });
      }
    }

    if (!row.emailed) {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error("RESEND_API_KEY is not set; order emails not sent.");
      const mail = buildEmails(order, remaining);
      await send(key, { to: TO, subject: `FLIP order: ${order.name || order.email || order.session_id}`, text: mail.craig, reply_to: order.email || REPLY_TO });
      if (order.email) {
        await send(key, { to: order.email, subject: "Your FLIP Bike Chocks order", text: mail.customer, reply_to: REPLY_TO });
      }
      if (dbConfigured()) await patchOrder(order.session_id, { emailed: true });
    }
    return res.status(200).send("OK");
  } catch (err) {
    // Non-2xx makes Stripe retry later; every step above is safe to repeat.
    console.error("Order processing failed for", order.session_id, err);
    return res.status(500).send("Processing failed");
  }
}
