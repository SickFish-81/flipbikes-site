// Vercel Web Analytics custom events for flipbikes.co.nz.
//
// Loaded on every page just before /_vercel/insights/script.js. The stub
// below queues any event fired before Vercel's script has loaded, so early
// events are not lost. Never send personal details (names, emails, phone
// numbers, addresses): only product codes, counts, countries and pages.
(function () {
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };

  function page() {
    var p = location.pathname;
    return p === "/" ? "/index.html" : p;
  }

  // flipTrack("Add to cart", { sku: "FLIP-G3", page: "/index.html" })
  // The Pro plan keeps two details per event, and Vercel caps text at 255.
  window.flipTrack = function (name, details) {
    try {
      var data = {}, n = 0;
      Object.keys(details || {}).forEach(function (k) {
        if (n >= 2) return;
        var v = details[k];
        if (v === undefined) return;
        if (typeof v === "string") v = v.slice(0, 255);
        data[k] = v; n++;
      });
      window.va("event", n ? { name: name, data: data } : { name: name });
    } catch (e) { /* tracking must never break the page */ }
  };
  window.flipTrack.page = page;

  // Taps on the phone number and email address.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (/^tel:/i.test(href)) window.flipTrack("Phone tap", { page: page() });
    else if (/^mailto:/i.test(href)) {
      // Business addresses only (sales@, ben@), so the address itself is fine
      // to record: it shows how many people email the trade rep.
      window.flipTrack("Email tap", { page: page(), to: href.slice(7).split("?")[0].toLowerCase() });
    }
  }, true);

  // Enquiry forms (they post to /api/send).
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f && /\/api\/send$/.test(f.getAttribute("action") || "")) {
      window.flipTrack("Enquiry sent", { page: page() });
    }
  }, true);

  // Back from Stripe after paying: count each order once, even if the
  // thanks page is refreshed. Stripe puts the order's session id in the URL.
  if (/thanks\.html$/.test(location.pathname)) {
    var m = /[?&]session_id=([^&]+)/.exec(location.search);
    if (m) {
      var key = "flip_purchase_" + m[1], seen = false;
      try { seen = !!localStorage.getItem(key); localStorage.setItem(key, "1"); } catch (e) {}
      if (!seen) window.flipTrack("Purchase");
    }
  }
})();
