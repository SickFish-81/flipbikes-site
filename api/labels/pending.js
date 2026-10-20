// GET /api/labels/pending — what the print agent should print next.
//
// The agent (tools/print-agent) polls this once a minute from the always-on
// machine beside the printer in Craig's workshop, with
// `Authorization: Bearer $FLIP_AGENT_TOKEN`.
//
// Shape, matching what the agent already expects:
//
//   { "labels": [ { id, name, consignment_id, tracking_number, pdf_url } ] }
//
// `id` is the INVOICE NUMBER, not the Stripe session id. Three reasons: it is
// short enough to read out over the phone, it is what appears on the order
// email Craig is looking at, and it keeps a customer's payment session id out
// of a URL and out of the agent's log file.
//
// AN EMPTY LIST IS THE NORMAL ANSWER. Most minutes of most days there is
// nothing to print. The agent treats [] as "nothing to do" and says nothing,
// so this endpoint staying quiet is not a sign of a problem.
//
// Nothing can appear here until the consignment step exists and a label PDF
// has actually been stored — see pendingLabels() for why that condition is
// what keeps the agent from failing in a loop.

import { refuseUnlessAgent } from "../_lib/agent.js";
import { dbConfigured, pendingLabels } from "../_lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const no = refuseUnlessAgent(req);
  if (no) return res.status(no.status).json(no.body);

  // No database means we cannot know, and "cannot know" must not look like
  // "nothing to print".
  if (!dbConfigured()) {
    return res.status(503).json({ error: "The shop database isn't configured, so labels can't be looked up." });
  }

  let rows;
  try {
    rows = await pendingLabels();
  } catch (err) {
    console.error("Pending labels lookup failed:", err.message);
    return res.status(502).json({ error: "Couldn't read the pending labels." });
  }

  // A label a minute old is still a label; there is nothing to cache here and
  // a cached empty list would be actively wrong.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    labels: rows.map((r) => ({
      id: r.invoice_number,
      name: r.name,
      consignment_id: r.consignment_id,
      tracking_number: r.tracking_number,
      // The agent fetches this with the same bearer token. It is relative on
      // purpose, so the agent's FLIP_API_BASE decides the host and a label can
      // never be pulled from somewhere this endpoint didn't intend.
      pdf_url: `/api/labels/${r.invoice_number}/pdf`,
    })),
  });
}
