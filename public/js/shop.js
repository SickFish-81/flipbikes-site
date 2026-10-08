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
  function renderCart() {
    var root = document.getElementById("cart-root");
    if (!root) return;
    root.textContent = "";

    if (!shop || !shop.enabled) {
      root.appendChild(el("p", { class: "cart-empty", text: "Online ordering isn't open yet." }));
      root.appendChild(el("a", { href: "contact.html", class: "button", text: "Contact us to order" }));
      return;
    }

    // Drop anything that's no longer sold, and clamp quantities to stock.
    var cart = getCart().filter(function (l) { return product(l.sku) && limitFor(product(l.sku)) > 0; });
    cart.forEach(function (l) { l.qty = Math.min(l.qty, limitFor(product(l.sku))); });
    write(CART_KEY, cart);
    refreshNavCount();

    if (!cart.length) {
      root.appendChild(el("p", { class: "cart-empty", text: "Your cart is empty." }));
      root.appendChild(el("a", { href: "index.html", class: "button", text: "Back to the shop" }));
      return;
    }

    var country = read(COUNTRY_KEY, "NZ");
    if (!shop.shipping[country]) country = "NZ";

    var table = el("div", { class: "cart-lines" });
    var subtotal = 0;
    cart.forEach(function (l) {
      var p = product(l.sku);
      var lineTotal = p.price * l.qty;
      subtotal += lineTotal;

      var qty = el("input", { type: "number", min: "1", max: String(limitFor(p)), value: String(l.qty), class: "cart-qty", "aria-label": "Quantity for " + p.name });
      qty.addEventListener("change", function () {
        var n = parseInt(qty.value, 10);
        var c = getCart();
        c.forEach(function (x) { if (x.sku === l.sku) x.qty = Math.max(1, Math.min(isNaN(n) ? 1 : n, limitFor(p))); });
        setCart(c); renderCart();
      });
      var remove = el("button", { type: "button", class: "cart-remove", text: "Remove" });
      remove.addEventListener("click", function () {
        setCart(getCart().filter(function (x) { return x.sku !== l.sku; })); renderCart();
      });

      table.appendChild(el("div", { class: "cart-line" }, [
        el("div", { class: "cart-name" }, [el("strong", { text: p.name }), el("span", { class: "cart-unit", text: money(p.price) + " each" })]),
        el("div", { class: "cart-controls" }, [qty, remove]),
        el("div", { class: "cart-total", text: money(lineTotal) })
      ]));
    });
    root.appendChild(table);

    var select = el("select", { id: "cart-country", class: "cart-country", "aria-label": "Delivery country" }, [
      el("option", { value: "NZ", text: "New Zealand" }),
      el("option", { value: "AU", text: "Australia" })
    ]);
    select.value = country;
    select.addEventListener("change", function () { write(COUNTRY_KEY, select.value); renderCart(); });

    var ship = shop.shipping[country];
    root.appendChild(el("div", { class: "cart-summary" }, [
      el("div", { class: "cart-row" }, [el("span", { text: "Deliver to" }), select]),
      el("div", { class: "cart-row" }, [el("span", { text: "Subtotal" }), el("span", { text: money(subtotal) })]),
      el("div", { class: "cart-row" }, [el("span", { text: ship.label }), el("span", { text: money(ship.amount) })]),
      el("div", { class: "cart-row cart-grand" }, [el("span", { text: "Total (NZD)" }), el("span", { text: money(subtotal + ship.amount) })]),
      el("p", { class: "cart-fine", text: "All prices include GST. Shipped from Tauranga, usually the next business day. Australian orders are charged in NZD." })
    ]));

    var error = el("p", { class: "cart-error", role: "alert" });
    var pay = el("button", { type: "button", class: "button cart-pay", text: "Pay securely with card" });
    pay.addEventListener("click", function () {
      error.textContent = "";
      pay.disabled = true; pay.textContent = "Please wait...";
      fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: getCart(), country: select.value })
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
