# Flip Bikes website

Static site for flipbikes.co.nz. Originally a Webflow export served from
HostPapa; moved to Vercel in September 2026 so HostPapa could be cancelled.

## Layout

    public/     the site exactly as Webflow exported it
    api/send.js the contact form handler (replaces HostPapa's send.php)

`vercel.json` tells Vercel there is no framework here and that `public/` is
the site. Files in `api/` become serverless functions automatically.

## The contact form

Five pages carry a form: index, about, contact, faq, installation. They all
POST to `/api/send`, which sends the enquiry through Resend to the address
set at the top of `api/send.js`.

Two things the form depends on that are NOT in this repo:

1. `RESEND_API_KEY` as an environment variable in the Vercel project.
2. `flipbikes.co.nz` verified as a sending domain in Resend. Until that is
   done, Resend rejects every send and the form shows its error message.

The forms are Webflow exports, so Webflow's own JS intercepts the submit and
shows a success or failure div based on the status code alone. Nothing this
function writes to the response body is ever displayed.

## What was deliberately left behind

- `send.php` — the old PHP handler. As well as emailing Craig, it sent a
  copy of every enquiry to an unrelated personal Gmail address. Replaced,
  not ported.
- `public_html/old/` — nineteen dead Webflow e-commerce template pages
  (log-in, sign-up, checkout, paypal-checkout, reset-password, user-account).
  Non-functional, but publicly reachable on the old host, and fake login and
  password-reset pages on a real business domain are worth not having.
- `error_log` — a 140 KB server log sitting in the web root.

The full original download is kept outside this repo; nothing above is lost,
it is just not published.
