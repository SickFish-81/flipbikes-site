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

## The shop (ecommerce)

Customers add chocks to a cart on the home page, pick New Zealand or
Australia, and pay on Stripe's hosted checkout page. Card details never touch
this site. After payment Stripe calls the webhook, which takes the stock off,
emails Craig what to ship, and emails the customer a confirmation.

    api/_lib/catalog.js   products, PRICES and SHIPPING RATES (edit here only)
    api/_lib/db.js        tiny Supabase client for stock + the order log
    api/shop.js           GET  - what the browser shows (prices, stock, on/off)
    api/checkout.js       POST - validates the cart, creates the Stripe session
    api/stripe-webhook.js POST - Stripe says "paid": stock, emails, order log
    supabase/flip_shop.sql  run once in the Supabase SQL editor
    public/js/shop.js     buttons, cart page, nav link (display only)
    test/shop.test.js     `npm test` - no network, no real accounts needed

The browser never decides a price: `/api/checkout` looks every item up in
`catalog.js`. Prices are NZD and GST-inclusive. Australian orders are charged
in NZD.

### Switching it on

The shop is invisible until `STRIPE_SECRET_KEY` exists - no buttons, no cart
link - so merging this changes nothing on the live site by itself.

1. Run `supabase/flip_shop.sql` in Supabase, then set REAL stock counts
   (it seeds everything at 0 = "out of stock" on purpose; see the end of the file).
2. In Vercel > Settings > Environment Variables add:
   - `STRIPE_SECRET_KEY`        (use a `sk_test_...` key while testing)
   - `STRIPE_WEBHOOK_SECRET`    (`whsec_...`, from the webhook endpoint below)
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY` is already used by the contact form
   Scope the test keys to **Preview** only, and the live keys to **Production**.
3. In Stripe > Developers > Webhooks add an endpoint
   `https://<the site>/api/stripe-webhook` for the one event
   `checkout.session.completed`. Preview deployments need their own endpoint
   (and secret) pointing at the preview URL, or test the flow in Stripe test mode
   against the preview URL with the Stripe CLI.
4. Test with Stripe's test card `4242 4242 4242 4242` (any future expiry, any CVC).

If Supabase isn't configured the shop still takes payments and sends emails;
it just can't track stock or ignore a duplicate webhook.

### Things that are guesses and need Craig
- Shipping: flat $15 NZ / $60 AU per order (`SHIPPING` in `catalog.js`).
- Whether "Tie Downs" $59.50 and "D Rings" $25.00 are per item or per set.
- Real stock counts.

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
