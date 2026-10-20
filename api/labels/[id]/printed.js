// POST /api/labels/:id/printed — the agent telling us what happened.
//
//   { "printed": true }                  paper came out
//   { "printed": false, "error": "..." } it didn't, and this is why
//
// `:id` is the invoice number. Same bearer token as /api/labels/pending.
//
// WHY A FAILURE IS A SUCCESSFUL REQUEST
//
// The agent reports failures here too, and this endpoint answers 200 to them.
// That is deliberate: the request succeeded — we now know the label didn't
// print, which is the thing worth knowing. Answering 4xx or 5xx to a reported
// failure would make the agent treat our record-keeping as broken and give up
// on the very message that says something needs attention.
//
// WHY printed_at IS NEVER OVERWRITTEN
//
// The column answers "when did this label print". A second POST for an
// already-printed label does not change that answer, so the first stamp wins
// and the reply says `already: true`. The agent only re-sends when it printed
// a label and then failed to record it, which it logs as "PRINTED BUT NOT
// RECORDED - it may print again" — a duplicate label is confusing in a way a
// missing one is not, so this endpoint stays dull and idempotent.
//
// A FAILURE DOES NOT STAMP printed_at, so the label stays in the pending list
// and the next poll retries it. Nothing here ever makes a label disappear.

import { refuseUnlessAgent } from "../../_lib/agent.js";
import { dbConfigured, orderByInvoiceNumber, markLabelPrinted, markLabelError } from "../../_lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const no = refuseUnlessAgent(req);
  if (no) return res.status(no.status).json(no.body);

  if (!dbConfigured()) {
    return res.status(503).json({ error: "The shop database isn't configured, so this can't be recorded." });
  }

  const invoiceNumber = Number(req.query?.id);
  if (!Number.isInteger(invoiceNumber) || invoiceNumber <= 0) {
    return res.status(400).json({ error: "Which label? Expected an invoice number." });
  }

  // Vercel parses JSON bodies for us, but a hand-rolled curl can still send a
  // string, so accept both rather than throwing on something harmless.
  let body = req.body ?? {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const printed = body.printed !== false; // absent means "it printed"

  let order;
  try {
    order = await orderByInvoiceNumber(invoiceNumber);
  } catch (err) {
    console.error("Label lookup failed:", err.message);
    return res.status(502).json({ error: "Couldn't look that order up." });
  }
  if (!order) return res.status(404).json({ error: `No order with invoice number ${invoiceNumber}.` });

  try {
    if (!printed) {
      await markLabelError(order.session_id, body.error || "the agent reported a failure with no detail");
      return res.status(200).json({ ok: true, recorded: "error", id: invoiceNumber });
    }
    if (order.printed_at) {
      return res.status(200).json({ ok: true, already: true, id: invoiceNumber, printed_at: order.printed_at });
    }
    await markLabelPrinted(order.session_id);
    return res.status(200).json({ ok: true, recorded: "printed", id: invoiceNumber });
  } catch (err) {
    console.error("Recording the print outcome failed:", err.message);
    return res.status(502).json({ error: "Couldn't record that." });
  }
}
