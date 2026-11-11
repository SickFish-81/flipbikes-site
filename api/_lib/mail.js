// Sending email, and leaving a record either way.
//
// Shared by the Stripe webhook (web orders) and /api/trade (trade orders), so
// both channels send through one code path, log the same way, and fail the
// same way. Moved out of stripe-webhook.js unchanged in behaviour when trade
// orders arrived; the only addition is that a caller may name the sender.

import { dbConfigured, logEmail } from "./db.js";

// Who hears about a new order. Craig packs them; Ben is on it as well so a
// problem with the shop is noticed by someone who can fix it, rather than
// waiting for Craig to mention that orders stopped arriving.
//
// FLIP_ORDER_EMAILS overrides the list (comma separated) without a deploy —
// useful when someone is away, and it keeps a staffing decision out of a
// public repo. Craig is the fallback, never nobody.
const DEFAULT_ORDER_EMAILS = "craig@betterservice.co.nz,xspyder5x@gmail.com";
// Read per request, not once at import: a value captured at module load only
// changes on a redeploy, which is exactly what this is meant to avoid. An
// empty or all-whitespace list falls back rather than emailing nobody — the
// order email is the only thing that tells anyone a sale happened.
export const recipients = () => {
  const list = String(process.env.FLIP_ORDER_EMAILS || "")
    .split(",").map((e) => e.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORDER_EMAILS.split(",");
};
export const FROM = "Flip Bikes Website <noreply@flipbikes.co.nz>";
export const REPLY_TO = "craig@betterservice.co.nz";

export async function send(key, { from = FROM, to, subject, text, html, reply_to, attachments }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: Array.isArray(to) ? to : [to], reply_to, subject, text,
      ...(html ? { html } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  // The message id, so email_log can be joined to the delivery events Resend
  // sends later. Without it a row here and a bounce there never meet.
  const body = await r.json().catch(() => null);
  return body?.id ?? null;
}

// Send, and leave a record either way.
//
// The record is the whole point. Before this the shop logged nothing: a
// successful email appeared in email_log only because Resend's webhook called
// back and created an orphan row labelled "unknown", and a send that FAILED
// left no trace at all. See the note on logEmail in _lib/db.js.
//
// Logging is never allowed to turn a sent email into a failed request — the
// money has already been taken. A failed SEND still throws, because Stripe
// retrying is the right answer to that.
export async function sendLogged(key, { kind, sessionId, ...opts }) {
  let resendId = null;
  try {
    resendId = await send(key, opts);
  } catch (err) {
    await logQuietly({ kind, to: opts.to, subject: opts.subject, sessionId,
                       status: "failed", error: String(err?.message ?? err) });
    throw err;
  }
  await logQuietly({ kind, to: opts.to, subject: opts.subject, sessionId, resendId, status: "accepted" });
  return resendId;
}

async function logQuietly(entry) {
  if (!dbConfigured()) return;
  try {
    await logEmail(entry);
  } catch (err) {
    // The email is already sent. Losing its log line is a nuisance; failing
    // the request over it would make the caller retry and send it twice.
    console.error("email_log write failed (the email itself was unaffected):", err?.message ?? err);
  }
}
