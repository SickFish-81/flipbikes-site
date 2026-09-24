// Flip Bikes contact form handler.
//
// WHAT THIS REPLACED
// ------------------
// The old site ran send.php on HostPapa. Two reasons it couldn't come across:
//   1. Vercel doesn't run PHP at all.
//   2. It sent a silent second copy of every enquiry to a personal Gmail
//      address that had nothing to do with the business. That is gone.
//
// HOW THE FORM TALKS TO THIS
// --------------------------
// The five contact forms are Webflow exports. Each one sits inside a
// <div class="w-form"> next to a .w-form-done and a .w-form-fail div, and
// Webflow's own JS (public/js/flip-nz.js) intercepts the submit, POSTs it
// over AJAX, and then shows one of those two divs.
//
// That means this function's RESPONSE BODY IS NEVER SEEN BY ANYONE.
// Only the status code matters: 2xx shows "Thank you! Your submission has
// been received!", anything else shows "Oops! Something went wrong".
// Don't waste effort formatting a pretty reply here — write the status code
// you mean and move on.
//
// Webflow serialises with jQuery, so the body arrives as
// application/x-www-form-urlencoded. Vercel's Node runtime parses that into
// an object on req.body for us. The JSON branch below is only there so the
// endpoint can be tested with curl.

// Where enquiries land. This is a real mailbox today on HostPapa, and after
// the migration it becomes a Cloudflare Email Routing address forwarding to
// Craig's Gmail. Keeping the business address here rather than the Gmail
// directly means if Craig ever changes personal email, you change one
// forwarding rule instead of redeploying this site.
const TO = "craig@betterservice.co.nz";

// The From address must be on a domain verified in Resend, or Resend rejects
// the send outright. flipbikes.co.nz gets verified as part of the Cloudflare
// DNS move. Until that's done this will fail — that's expected, not a bug.
const FROM = "Flip Bikes Website <noreply@flipbikes.co.nz>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  // Webflow sends urlencoded; curl tests may send JSON. Accept either.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = Object.fromEntries(new URLSearchParams(body));
    }
  }
  body = body || {};

  // These four names come straight out of the Webflow HTML and are
  // inconsistent on purpose — "name" is lowercase, the rest are capitalised,
  // and the message field is called "field". Don't tidy them here without
  // changing all five HTML files to match, or submissions arrive blank.
  const name = String(body.name ?? "").trim();
  const email = String(body.Email ?? "").trim();
  const phone = String(body.Phone ?? "").trim();
  const message = String(body.field ?? "").trim();

  if (!name || !email || !message) {
    return res.status(400).send("Name, email and message are required.");
  }
  // Deliberately loose. A strict regex rejects real addresses; the real
  // check is whether Craig can reply to it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send("That email address doesn't look right.");
  }
  // A newline in the email field is the classic header-injection trick.
  // Resend uses JSON rather than raw headers so it can't be exploited the
  // way PHP's mail() could, but there's no reason to pass it through.
  if (/[\r\n]/.test(email)) {
    return res.status(400).send("That email address doesn't look right.");
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Fail loudly in the log, quietly to the visitor. If this fires, the
    // env var is missing in Vercel — set it and redeploy.
    console.error("RESEND_API_KEY is not set; enquiry was not sent.");
    return res.status(500).send("Unable to send right now.");
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        // Reply-To is what makes this useful: Craig hits reply in Gmail and
        // it goes to the customer, not to noreply@.
        reply_to: email,
        subject: `Flip Bikes enquiry from ${name}`,
        text:
          `Name:    ${name}\n` +
          `Email:   ${email}\n` +
          `Phone:   ${phone || "(not given)"}\n\n` +
          `Message:\n${message}\n`,
      }),
    });

    if (!r.ok) {
      // Resend's error body says why (unverified domain, bad key, etc).
      // It goes to the Vercel function log, never to the visitor.
      console.error("Resend rejected the send:", r.status, await r.text());
      return res.status(502).send("Unable to send right now.");
    }

    return res.status(200).send("Sent");
  } catch (err) {
    console.error("Contact form failed:", err);
    return res.status(500).send("Unable to send right now.");
  }
}
