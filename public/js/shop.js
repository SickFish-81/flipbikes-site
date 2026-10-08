/* FLIP shop front end: "Add to cart" buttons, the cart link in the nav, and
 * the cart page. Prices/stock/shipping all come from /api/shop, which is the
 * single source of truth; this file only displays them. If /api/shop says
 * ordering is off (or fails) it adds nothing, so the pages look as they always
 * did. */
(function () {
  "use strict";

  var CART_KEY = "flipCart";
  var COUNTRY_KEY = "flipCountry";
  var shop = null; // response of /api/shop

  // ---- storage (wrapped: private windows / blocked storage must not break the page)
  function read(key, fallback) {
    try { var v = window.localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
  function getCart() {
    var c = read(CART_KEY, []);
    return Array.isArray(c) ? c.filter(function (l) { return l && typeof l.sku === "string" && l.qty >= 1; }) : [];
  }
  function setCart(c) { write(CART_KEY, c); refreshNavCount(); }

  // ---- helpers
  function money(cents) { return "$" + (cents / 100).toFixed(2); }
  function product(sku) {
    return (shop && shop.products || []).filter(function (p) { return p.sku === sku; })[0] || null;
  }
  function limitFor(p) {
    var max = shop.maxQty || 20;
    return p.stock === null || p.stock === undefined ? max : Math.min(max, p.stock);
  }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function addToCart(sku) {
    var p = product(sku);
    if (!p) return false;
    var cart = getCart();
    var line = cart.filter(function (l) { return l.sku === sku; })[0];
    var next = (line ? line.qty : 0) + 1;
    if (next > limitFor(p)) return false;
    if (line) line.qty = next; else cart.push({ sku: sku, qty: 1 });
    setCart(cart);
    return true;
  }

  // ---- nav cart link
  function refreshNavCount() {
    var link = document.getElementById("shop-cart-link");
    if (!link) return;
    var n = getCart().reduce(function (s, l) { return s + l.qty; }, 0);
    link.textContent = n ? "Cart (" + n + ")" : "Cart";
  }
  function addNavLink() {
    var nav = document.querySelector("nav.navigation-items");
    if (!nav || document.getElementById("shop-cart-link")) return;
    var a = el("a", { href: "cart.html", id: "shop-cart-link", class: "navigation-item w-nav-link" });
    if (/cart\.html$/.test(location.pathname)) { a.className += " w--current"; a.setAttribute("aria-current", "page"); }
    nav.appendChild(a);
    refreshNavCount();
  }

  // ---- "Add to cart" buttons on the product pages
  function renderBuyButtons() {
    var slots = document.querySelectorAll("[data-shop-sku]");
    Array.prototype.forEach.call(slots, function (slot) {
      var p = product(slot.getAttribute("data-shop-sku"));
      slot.textContent = "";
      if (!p) return;
      if (p.stock === 0) {
        slot.appendChild(el("p", { class: "shop-note shop-soldout", text: "Out of stock" }));
        slot.appendChild(el("a", { href: "contact.html", class: "shop-link", text: "Enquire about availability" }));
        return;
      }
      var status = el("span", { class: "shop-added", role: "status", "aria-live": "polite" });
      var btn = el("button", { type: "button", class: "button shop-add", text: "Add to cart" });
      btn.addEventListener("click", function () {
        if (addToCart(p.sku)) {
          status.textContent = "Added - ";
          status.appendChild(el("a", { href: "cart.html", text: "view cart" }));
        } else {
          status.textContent = "That's all we have in stock.";
        }
      });
      slot.appendChild(btn);
      if (p.stock !== null && p.stock !== undefined && p.stock <= 3) {
        slot.appendChild(el("p", { class: "shop-note", text: "Only " + p.stock + " left" }));
      }
      slot.appendChild(status);
    });
  }

  // ---- cart page
  //
  // Built once, then updated in place, so changing a quantity never wipes the
  // delivery details the customer has already typed.
  var ui = { country: "NZ", addr: null, quote: null, quoteError: "", token: "", seq: 0, timer: null };

  function newToken() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  }
  function field(label, input, hint) {
    return el("label", { class: "cart-field" }, [el("span", { text: label }), input, hint ? el("small", { text: hint }) : null]);
  }
  function inputEl(attrs) { attrs["class"] = "cart-input"; return el("input", attrs); }

  function cartIsEmpty(root, message, linkHref, linkText) {
    root.textContent = "";
    root.appendChild(el("p", { class: "cart-empty", text: message }));
    root.appendChild(el("a", { href: linkHref, class: "button", text: linkText }));
  }

  function renderCart() {
    var root = document.getElementById("cart-root");
    if (!root) return;

    if (!shop || !shop.enabled) { cartIsEmpty(root, "Online ordering isn't open yet.", "contact.html", "Contact us to order"); return; }

    // Drop anything that's no longer sold, and clamp quantities to stock.
    var cart = getCart().filter(function (l) { return product(l.sku) && limitFor(product(l.sku)) > 0; });
    cart.forEach(function (l) { l.qty = Math.min(l.qty, limitFor(product(l.sku))); });
    write(CART_KEY, cart);
    refreshNavCount();
    if (!cart.length) { cartIsEmpty(root, "Your cart is empty.", "index.html", "Back to the shop"); return; }

    if (!document.getElementById("cart-lines")) buildCartPage(root);
    renderLines(cart);
    refreshQuote();
  }

  function renderLines(cart) {
    var box = document.getElementById("cart-lines");
    box.textContent = "";
    cart.forEach(function (l) {
      var p = product(l.sku);
      var qty = el("input", { type: "number", min: "1", max: String(limitFor(p)), value: String(l.qty), class: "cart-qty", "aria-label": "Quantity for " + p.name });
      qty.addEventListener("change", function () {
        var n = parseInt(qty.value, 10);
        var c = getCart();
        c.forEach(function (x) { if (x.sku === l.sku) x.qty = Math.max(1, Math.min(isNaN(n) ? 1 : n, limitFor(p))); });
        setCart(c); renderCart();
      });
      var remove = el("button", { type: "button", class: "cart-remove", text: "Remove" });
      remove.addEventListener("click", function () { setCart(getCart().filter(function (x) { return x.sku !== l.sku; })); renderCart(); });
      box.appendChild(el("div", { class: "cart-line" }, [
        el("div", { class: "cart-name" }, [el("strong", { text: p.name }), el("span", { class: "cart-unit", text: money(p.price) + " each" })]),
        el("div", { class: "cart-controls" }, [qty, remove]),
        el("div", { class: "cart-total", text: money(p.price * l.qty) })
      ]));
    });
  }

  function buildCartPage(root) {
    root.textContent = "";
    ui.token = newToken();
    var search = shop.addressSearch;

    root.appendChild(el("div", { id: "cart-lines", class: "cart-lines" }));

    // --- delivery details
    var name = inputEl({ id: "d-name", type: "text", autocomplete: "name", maxlength: "100" });
    var email = inputEl({ id: "d-email", type: "email", autocomplete: "email", maxlength: "200" });
    var phone = inputEl({ id: "d-phone", type: "tel", autocomplete: "tel", maxlength: "30" });
    var note = inputEl({ id: "d-note", type: "text", maxlength: "200", placeholder: "e.g. leave at the shed, gate code" });

    var country = el("select", { id: "d-country", class: "cart-input", "aria-label": "Delivery country" }, [
      el("option", { value: "NZ", text: "New Zealand" }), el("option", { value: "AU", text: "Australia" })
    ]);
    country.value = ui.country;

    var lookup = inputEl({ id: "d-lookup", type: "text", autocomplete: "off", placeholder: "Start typing your street address", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false" });
    var list = el("ul", { class: "addr-list", role: "listbox", hidden: "hidden" });
    var chosen = el("div", { class: "addr-chosen", hidden: "hidden" });

    var m = {
      line1: inputEl({ id: "m-line1", type: "text", autocomplete: "address-line1", maxlength: "120" }),
      suburb: inputEl({ id: "m-suburb", type: "text", autocomplete: "address-level3", maxlength: "80" }),
      city: inputEl({ id: "m-city", type: "text", autocomplete: "address-level2", maxlength: "80" }),
      postcode: inputEl({ id: "m-postcode", type: "text", autocomplete: "postal-code", maxlength: "6", inputmode: "numeric" })
    };
    var manualBox = el("div", { class: "addr-manual", hidden: search ? "hidden" : null }, [
      field("Street address", m.line1, "Include RD number for rural addresses"),
      field("Suburb (optional)", m.suburb), field("Town / city", m.city), field("Postcode", m.postcode)
    ]);
    if (!search) manualBox.removeAttribute("hidden");
    var manualToggle = el("button", { type: "button", class: "cart-remove", text: "Can't find it? Enter it manually" });
    manualToggle.addEventListener("click", function () { manualBox.removeAttribute("hidden"); manualToggle.hidden = true; });

    function setAddress(addr) { ui.addr = addr; ui.quote = null; ui.quoteError = ""; refreshQuote(); }
    function resetAddress() {
      ui.token = newToken(); lookup.value = ""; chosen.hidden = true; lookup.parentNode.hidden = false; setAddress(null);
    }

    country.addEventListener("change", function () { ui.country = country.value; write(COUNTRY_KEY, ui.country); resetAddress(); });

    // suggestions while typing
    var typing = null;
    lookup.addEventListener("input", function () {
      clearTimeout(typing);
      var q = lookup.value.trim();
      if (q.length < 3) { list.hidden = true; lookup.setAttribute("aria-expanded", "false"); return; }
      typing = setTimeout(function () {
        fetch("/api/address-suggest?q=" + encodeURIComponent(q) + "&country=" + ui.country + "&token=" + encodeURIComponent(ui.token))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            list.textContent = "";
            (d.suggestions || []).forEach(function (s) {
              var b = el("button", { type: "button", role: "option", class: "addr-option", text: s.text });
              b.addEventListener("click", function () {
                list.hidden = true; lookup.setAttribute("aria-expanded", "false");
                chosen.textContent = "";
                var change = el("button", { type: "button", class: "cart-remove", text: "Change" });
                change.addEventListener("click", resetAddress);
                chosen.appendChild(el("span", { text: "Delivering to: " + s.text + " " })); chosen.appendChild(change);
                chosen.hidden = false; lookup.parentNode.hidden = true;
                setAddress({ placeId: s.placeId, text: s.text });
              });
              list.appendChild(el("li", {}, [b]));
            });
            list.hidden = !(d.suggestions || []).length;
            lookup.setAttribute("aria-expanded", String(!list.hidden));
          }).catch(function () { list.hidden = true; });
      }, 250);
    });

    // manual entry
    function manualChanged() {
      clearTimeout(ui.timer);
      ui.timer = setTimeout(function () {
        var v = { line1: m.line1.value.trim(), suburb: m.suburb.value.trim(), city: m.city.value.trim(), postcode: m.postcode.value.trim() };
        setAddress(v.line1 && v.city && /^\d{4}$/.test(v.postcode) ? { manual: v } : null);
      }, 350);
    }
    Object.keys(m).forEach(function (k) { m[k].addEventListener("input", manualChanged); });

    root.appendChild(el("div", { class: "cart-details" }, [
      el("h2", { text: "Delivery details" }),
      field("Name", name), field("Email", email), field("Phone", phone, "For the courier"),
      field("Deliver to", country),
      search ? el("div", { class: "cart-field" }, [el("label", { for: "d-lookup" }, [el("span", { text: "Address" })]), lookup, list]) : null,
      search ? chosen : null,
      search ? manualToggle : null,
      manualBox,
      field("Delivery note (optional)", note)
    ]));

    // --- summary + pay
    root.appendChild(el("div", { id: "cart-summary", class: "cart-summary" }));
    var error = el("p", { id: "cart-error", class: "cart-error", role: "alert" });
    var pay = el("button", { type: "button", id: "cart-pay", class: "button cart-pay", text: "Pay securely with card" });
    pay.addEventListener("click", function () {
      error.textContent = "";
      if (!name.value.trim()) { error.textContent = "Please enter your name."; name.focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { error.textContent = "Please enter a valid email address."; email.focus(); return; }
      if (phone.value.replace(/\D/g, "").length < 7) { error.textContent = "Please enter a phone number for the courier."; phone.focus(); return; }
      if (!ui.addr || !ui.quote) { error.textContent = "Please enter your delivery address so we can price shipping."; return; }
      pay.disabled = true; pay.textContent = "Please wait...";
      fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: getCart(), country: ui.country, address: ui.addr, sessionToken: ui.token,
          name: name.value, email: email.value, phone: phone.value, note: note.value
        })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
      }).then(function (res) {
        if (res.ok && res.data.url) { window.location.href = res.data.url; return; }
        throw new Error(res.data.error || "Couldn't start checkout. Please try again.");
      }).catch(function (e) {
        error.textContent = e.message || "Couldn't start checkout. Please try again.";
        pay.disabled = false; pay.textContent = "Pay securely with card";
      });
    });
    root.appendChild(error);
    root.appendChild(pay);
    root.appendChild(el("p", { class: "cart-fine", text: "You'll be taken to Stripe's secure page to pay. Questions? Call Craig on +64 021 0832 7787." }));
  }

  // Live shipping for the current cart + address, then redraw the totals.
  function refreshQuote() {
    var mySeq = ++ui.seq;
    if (!ui.addr) { ui.quote = null; drawSummary(); return; }
    ui.quote = null; drawSummary(true);
    fetch("/api/quote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: getCart(), country: ui.country, address: ui.addr, sessionToken: ui.token })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (mySeq !== ui.seq) return; // a newer change superseded this one
        if (res.ok) { ui.quote = res.d; ui.quoteError = ""; } else { ui.quote = null; ui.quoteError = res.d.error || "Couldn't price shipping."; }
        drawSummary();
      }).catch(function () {
        if (mySeq !== ui.seq) return;
        ui.quote = null; ui.quoteError = "Couldn't price shipping. Please try again."; drawSummary();
      });
  }

  function drawSummary(loading) {
    var box = document.getElementById("cart-summary");
    if (!box) return;
    var subtotal = getCart().reduce(function (s, l) { var p = product(l.sku); return s + (p ? p.price * l.qty : 0); }, 0);
    var shipRow, total;
    if (ui.quote) {
      shipRow = el("div", { class: "cart-row" }, [el("span", { text: ui.quote.label }), el("span", { text: money(ui.quote.amount) })]);
      total = el("div", { class: "cart-row cart-grand" }, [el("span", { text: "Total (NZD)" }), el("span", { text: money(subtotal + ui.quote.amount) })]);
    } else {
      var msg = loading ? "Working out shipping..." : (ui.quoteError || "Enter your address to see shipping");
      shipRow = el("div", { class: "cart-row" }, [el("span", { text: "Shipping" }), el("span", { class: ui.quoteError ? "cart-error" : "cart-fine", text: msg })]);
      total = null;
    }
    box.textContent = "";
    box.appendChild(el("div", { class: "cart-row" }, [el("span", { text: "Subtotal" }), el("span", { text: money(subtotal) })]));
    box.appendChild(shipRow);
    if (total) box.appendChild(total);
    box.appendChild(el("p", { class: "cart-fine", text: "All prices include GST. Shipped from Tauranga, usually the next business day. Rural delivery adds a courier surcharge. Australian orders are charged in NZD." }));
  }

  // ---- thanks page: the order is paid, so the cart is done with
  function clearIfThanks() {
    if (/thanks\.html$/.test(location.pathname)) write(CART_KEY, []);
  }

  function start() {
    clearIfThanks();
    fetch("/api/shop")
      .then(function (r) { if (!r.ok) throw new Error("shop " + r.status); return r.json(); })
      .then(function (data) {
        shop = data;
        if (!shop.enabled) { renderCart(); return; }
        addNavLink();
        renderBuyButtons();
        renderCart();
      })
      .catch(function () { renderCart(); /* shop stays hidden; site works as before */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
