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

Customers add chocks to a cart on the home page, enter their delivery address
(Google address search, or typed in by hand), see the shipping price including
any rural surcharge, and pay on Stripe's hosted checkout page. Card details never touch
this site. After payment Stripe calls the webhook, which takes the stock off,
emails Craig what to ship, and emails the customer a confirmation.

    api/_lib/catalog.js   products and PRICES (edit here only)
    api/_lib/shipping.js  SHIPPING RATE TABLE + rural postcode list (edit here only)
    api/_lib/places.js    Google Places lookups (server-side; key never reaches the browser)
    api/_lib/order.js     prices a cart + address; shared by quote and checkout
    api/_lib/db.js        tiny Supabase client for stock + the order log
    api/shop.js           GET  - what the browser shows (prices, stock, on/off)
    api/address-suggest.js GET - address suggestions as the customer types
    api/quote.js          POST - live shipping price for the cart page
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
   - `GOOGLE_MAPS_API_KEY`      (optional; enables address search. Restrict it to
     "Places API (New)" in Google Cloud and set a daily quota cap. Without it the
     cart page shows plain address fields instead)
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

### Shipping

There is no courier API behind this: NZ Couriers' own API needs 100+ parcels a
day. `api/_lib/shipping.js` is a hand-kept rate table that mirrors how the
courier charges - a base rate by island, a little extra per additional item, and
a rural surcharge that is passed on to the customer. An address counts as rural
if its postcode is in `RURAL_POSTCODES` or it contains an "RD 2"-style number.
The order email to Craig says whether rural was applied, and whether the address
was typed in rather than verified by Google, so he can double-check before booking.

### Things that are guesses and need Craig
- Every rate in `shipping.js`, and the rural postcode list (empty right now, so
  only "RD n" addresses are caught). NZ Couriers publishes a rural list.
- Whether "Tie Downs" $59.50 and "D Rings" $25.00 are per item or per set (minor).
- Real stock counts, and prices (due to be revisited).

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
