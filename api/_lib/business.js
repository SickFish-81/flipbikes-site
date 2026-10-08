// Who the sale is FROM, for the tax invoice. Set in Vercel (Production and
// Preview) so nothing business-specific is hard-coded and no code push is
// needed to change it:
//
//   FLIP_GST_NUMBER        Craig's IRD GST number, e.g. 123-456-789
//   FLIP_BUSINESS_NAME     the registered / trading name to show (default below)
//   FLIP_BUSINESS_ADDRESS  address lines separated by |  e.g. 556 Te Puke Highway|Te Puke 3187
//
// WITHOUT a GST number the customer gets an "Order confirmation", NOT a tax
// invoice: a document headed "Tax Invoice" with no GST number on it isn't a
// valid one, so we never issue it. Craig's order email warns when that happens.

export function business() {
  const gst = String(process.env.FLIP_GST_NUMBER || "").trim();
  return {
    name: String(process.env.FLIP_BUSINESS_NAME || "FLIP Bike Chocks").trim(),
    address: String(process.env.FLIP_BUSINESS_ADDRESS || "").split("|").map((l) => l.trim()).filter(Boolean),
    gstNumber: gst.replace(/\D/g, "").length >= 8 ? gst : "",
    email: "craig@betterservice.co.nz",
    phone: "+64 021 0832 7787",
  };
}

// NZ GST is 0% on goods exported to Australia (zero-rated), not 15%. Prices on
// the site are the same either way, so by default an Australian order's invoice
// shows no GST. !!! Craig / his accountant should confirm this before launch. !!!
// Set to true to charge-and-show 15% GST on Australian orders as well.
export const GST_ON_AUSTRALIA = false;
