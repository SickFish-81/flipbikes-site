// FLIP dealer portal (trade.html). Talks only to /api/dealer, which decides
// everything that matters — prices, freight, who is billed. This page just
// collects what the dealer wants sent where, and shows the answers.
(function () {
  "use strict";
  var root = document.getElementById("trade-root");
  var state = { dealer: null, prices: [], qty: {}, to: {}, ref: "", freight: null, freightKey: null, tab: "order" };

  var money = function (c) { return "$" + (Number(c || 0) / 100).toFixed(2); };
  var gstOn = function (c) { return Math.round(c * 0.15); };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) n.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  function api(body) {
    return fetch("/api/dealer", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && body.action !== "verify_code") { state.dealer = null; showSignIn(); }
        return { ok: r.ok, status: r.status, body: j };
      });
    }).catch(function () {
      return { ok: false, status: 0, body: { error: "Couldn't reach the server. Check your connection and try again." } };
    });
  }

  function render(children) { root.innerHTML = ""; children.forEach(function (c) { root.appendChild(c); }); }
  function field(label, input, hint) {
    return el("label", { class: "cart-field" }, [el("span", { text: label }), input, hint ? el("small", { text: hint }) : null]);
  }

  // ------------------------------------------------------------- sign in
  function showSignIn(message) {
    var email = el("input", { class: "cart-input", type: "email", autocomplete: "email", placeholder: "you@yourbusiness.co.nz" });
    var msg = el("p", { class: "cart-error", text: message || "" });
    var btn = el("button", { class: "button w-button cart-pay", type: "submit", text: "Email me a sign-in code" });
    var form = el("form", { class: "trade-card", onsubmit: function (e) {
      e.preventDefault(); btn.disabled = true; msg.textContent = "";
      api({ action: "request_code", email: email.value }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { msg.textContent = r.body.error || "Something went wrong."; return; }
        showCode(email.value.trim(), r.body.message);
      });
    } }, [
      el("p", { class: "cart-fine", text: "For approved FLIP dealers. Sign in with the email address we have for your business and we'll send you a code." }),
      field("Email", email), msg, btn,
      el("p", { class: "cart-fine" }, ["Not a dealer yet? ", el("a", { href: "contact.html", class: "trade-link", text: "Get in touch" }), " about trade pricing."]),
    ]);
    render([form]);
    email.focus();
  }

  function showCode(email, message) {
    var code = el("input", { class: "cart-input trade-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "123456" });
    var msg = el("p", { class: "cart-error" });
    var btn = el("button", { class: "button w-button cart-pay", type: "submit", text: "Sign in" });
    render([el("form", { class: "trade-card", onsubmit: function (e) {
      e.preventDefault(); btn.disabled = true; msg.textContent = "";
      api({ action: "verify_code", email: email, code: code.value }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { msg.textContent = r.body.error || "That didn't work."; return; }
        loadMe();
      });
    } }, [
      el("p", { class: "cart-fine", text: message }),
      field("Code from the email", code), msg, btn,
      el("p", { class: "cart-fine" }, [el("a", { href: "#", class: "trade-link", text: "Use a different email", onclick: function (e) { e.preventDefault(); showSignIn(); } })]),
    ])]);
    code.focus();
  }

  function loadMe() {
    api({ action: "me" }).then(function (r) {
      if (!r.ok) { if (r.status !== 401) showSignIn(r.body.error); return; }
      state.dealer = r.body.dealer; state.prices = r.body.prices || [];
      showPortal();
    });
  }

  // -------------------------------------------------------------- portal
  function showPortal() {
    var d = state.dealer;
    var head = el("div", { class: "trade-head" }, [
      el("p", {}, ["Signed in as ", el("b", { text: d.business }), d.contact ? " (" + d.contact + ")" : ""]),
      el("button", { class: "cart-remove", type: "button", text: "Sign out", onclick: function () {
        api({ action: "logout" }).then(function () { state.dealer = null; showSignIn(); });
      } }),
    ]);
    var tabs = el("div", { class: "trade-tabs" }, [
      el("button", { type: "button", class: "trade-tab" + (state.tab === "order" ? " is-on" : ""), text: "New order", onclick: function () { state.tab = "order"; showPortal(); } }),
      el("button", { type: "button", class: "trade-tab" + (state.tab === "orders" ? " is-on" : ""), text: "Your orders", onclick: function () { state.tab = "orders"; showPortal(); } }),
    ]);
    var body = el("div");
    render([head, tabs, body]);
    if (state.tab === "orders") showOrders(body); else showOrderForm(body);
  }

  function lines() {
    return state.prices.filter(function (p) { return p.price_ex_gst != null && Number(state.qty[p.sku]) > 0; })
      .map(function (p) { return { sku: p.sku, qty: Number(state.qty[p.sku]), unit: p.price_ex_gst, name: p.name }; });
  }
  function freightKey() {
    var t = state.to;
    return JSON.stringify([t.line1, t.suburb, t.city, t.postcode, !!t.rural, lines().map(function (l) { return [l.sku, l.qty]; })]);
  }

  function showOrderForm(box) {
    var t = state.to;
    var input = function (k, attrs) {
      var i = el("input", Object.assign({ class: "cart-input", value: t[k] || "" }, attrs || {}));
      i.addEventListener("input", function () { t[k] = i.value; refresh(); });
      return i;
    };
    var rural = el("input", { type: "checkbox", class: "cart-check" });
    rural.checked = !!t.rural;
    rural.addEventListener("change", function () { t.rural = rural.checked; refresh(); });

    var products = el("div", { class: "cart-lines" }, state.prices.map(function (p) {
      var priced = p.price_ex_gst != null;
      var q = el("input", { class: "cart-qty", type: "number", min: "0", max: "1000", step: "1", value: state.qty[p.sku] || "", placeholder: "0", "aria-label": "Quantity of " + p.name, disabled: !priced });
      q.addEventListener("input", function () { state.qty[p.sku] = q.value; refresh(); });
      return el("div", { class: "cart-line" }, [
        el("div", { class: "cart-name" }, [el("span", { text: p.name }), el("span", { class: "cart-unit", text: priced ? money(p.price_ex_gst) + " each + GST" : "Contact us to order this one" })]),
        el("div", { class: "cart-controls" }, [q]),
      ]);
    }));

    var ref = el("input", { class: "cart-input", value: state.ref, maxlength: "60" });
    ref.addEventListener("input", function () { state.ref = ref.value; });

    var summary = el("div", { class: "cart-summary" });
    var msg = el("p", { class: "cart-error" });
    var freightBtn = el("button", { type: "button", class: "trade-secondary", text: "Work out freight" });
    var placeBtn = el("button", { type: "button", class: "button w-button cart-pay", text: "Place order" });

    freightBtn.addEventListener("click", function () {
      msg.textContent = "";
      var problem = missing(true);
      if (problem) { msg.textContent = problem; return; }
      freightBtn.disabled = true; freightBtn.textContent = "Asking the courier…";
      var key = freightKey();
      api({ action: "quote", items: lines(), deliver_to: t }).then(function (r) {
        freightBtn.disabled = false; freightBtn.textContent = "Work out freight";
        if (!r.ok) { msg.textContent = r.body.error || "Couldn't work out freight."; return; }
        state.freight = r.body; state.freightKey = key; refresh();
      });
    });

    placeBtn.addEventListener("click", function () {
      msg.textContent = "";
      var problem = missing(false);
      if (problem) { msg.textContent = problem; return; }
      placeBtn.disabled = true; placeBtn.textContent = "Placing your order…";
      api({ action: "order", items: lines().map(function (l) { return { sku: l.sku, qty: l.qty }; }), deliver_to: t, customer_ref: state.ref })
        .then(function (r) {
          placeBtn.disabled = false; placeBtn.textContent = "Place order";
          if (!r.ok) { msg.textContent = r.body.error || "The order didn't go through."; return; }
          showPlaced(r.body);
        });
    });

    function missing(forFreight) {
      if (!lines().length) return "Add at least one product.";
      if (!(t.line1 || "").trim() || !(t.city || "").trim()) return "Fill in the street and town or city.";
      if (!/^\d{4}$/.test((t.postcode || "").trim())) return "The postcode must be 4 digits.";
      if (forFreight) return null;
      if (!(t.name || "").trim()) return "Who is it going to? Fill in the name for the label.";
      if (!state.freight || state.freightKey !== freightKey()) return "Work out the freight first.";
      return null;
    }

    function refresh() {
      var ls = lines();
      var goods = ls.reduce(function (s, l) { return s + l.qty * l.unit; }, 0);
      var fresh = state.freight && state.freightKey === freightKey();
      var freight = fresh ? state.freight.shipping_ex_gst : null;
      var ex = goods + (freight || 0);
      summary.innerHTML = "";
      var row = function (a, b, cls) { return el("div", { class: "cart-row" + (cls ? " " + cls : "") }, [el("span", { text: a }), el("span", { text: b })]); };
      summary.appendChild(row("Products", money(goods)));
      summary.appendChild(row("Freight" + (fresh && state.freight.carrier ? " (" + state.freight.carrier + ")" : ""), fresh ? money(freight) : "—"));
      if (fresh && state.freight.estimate) summary.appendChild(el("p", { class: "cart-fine", text: "The courier didn't give us a firm price for this address, so this freight is our estimate." }));
      if (state.freight && !fresh) summary.appendChild(el("p", { class: "cart-fine", text: "The address or products changed. Work out the freight again." }));
      summary.appendChild(row("Subtotal excluding GST", money(ex)));
      summary.appendChild(row("GST 15%", money(gstOn(ex))));
      summary.appendChild(row("Total including GST", money(ex + gstOn(ex)), "cart-grand"));
    }

    box.appendChild(el("div", { class: "cart-details" }, [
      el("h2", { text: "What to send" }),
      el("p", { class: "cart-fine", text: "Your trade prices, excluding GST." }),
      products,
    ]));
    box.appendChild(el("div", { class: "cart-details" }, [
      el("h2", { text: "Send it to" }),
      el("p", { class: "cart-fine" }, ["Your customer's details, or your own. ", el("a", { href: "#", class: "trade-link", text: "Send it to us", onclick: function (e) {
        e.preventDefault(); t.name = state.dealer.business; t.phone = state.dealer.phone || ""; showPortal();
      } })]),
      field("Name on the parcel", input("name", { autocomplete: "off" })),
      field("Phone", input("phone", { type: "tel" }), "The courier uses it if they can't find the place."),
      field("Street address", input("line1")),
      field("Suburb", input("suburb")),
      field("Town or city", input("city")),
      field("Postcode", input("postcode", { inputmode: "numeric", maxlength: "4" })),
      el("label", { class: "cart-field cart-field-check" }, [rural, el("span", { text: "Rural delivery address" })]),
      field("Delivery instructions", input("note"), "Printed on the label, e.g. Leave at the shed."),
      field("Your order reference", ref, "Optional. Goes on the invoice, e.g. your PO number."),
    ]));
    box.appendChild(el("div", {}, [freightBtn]));
    box.appendChild(summary);
    box.appendChild(msg);
    box.appendChild(placeBtn);
    box.appendChild(el("p", { class: "cart-fine", text: "Charged to your account. The invoice is emailed to " + state.dealer.email + " and is due on the 20th of next month. Freight is charged at cost." }));
    refresh();
  }

  function showPlaced(o) {
    state.qty = {}; state.to = {}; state.ref = ""; state.freight = null;
    render([el("div", { class: "trade-card" }, [
      el("h2", { class: "trade-done", text: "Order " + o.number + " placed" }),
      el("p", { text: money(o.amount_ex_gst) + " + GST " + money(o.gst_amount) + " = " + money(o.amount_total) }),
      el("p", { class: "cart-fine", text: o.invoice_sent
        ? "The invoice is on its way to " + o.invoice_to + ". We'll pack and send it shortly."
        : "Your order is in and we'll pack and send it shortly. The invoice email didn't go through, so we'll send it separately." }),
      el("button", { type: "button", class: "button w-button cart-pay", text: "Place another order", onclick: function () { state.tab = "order"; showPortal(); } }),
      el("p", {}, [el("a", { href: "#", class: "trade-link", text: "See your orders", onclick: function (e) { e.preventDefault(); state.tab = "orders"; showPortal(); } })]),
    ])]);
  }

  function showOrders(box) {
    box.appendChild(el("p", { class: "cart-empty", text: "Loading..." }));
    api({ action: "orders" }).then(function (r) {
      box.innerHTML = "";
      if (!r.ok) { box.appendChild(el("p", { class: "cart-error", text: r.body.error || "Couldn't load your orders." })); return; }
      var list = r.body.orders || [];
      if (!list.length) { box.appendChild(el("p", { class: "cart-empty", text: "No orders yet." })); return; }
      box.appendChild(el("div", { class: "cart-lines" }, list.map(function (o) {
        var due = o.paid ? "Paid" : o.due_date ? "Due " + o.due_date.split("-").reverse().join("/") : "Awaiting payment";
        return el("div", { class: "cart-line" }, [
          el("div", { class: "cart-name" }, [
            el("span", {}, [el("b", { text: o.number }), " to " + o.to + (o.town ? ", " + o.town : "")]),
            el("span", { class: "cart-unit", text: new Date(o.date).toLocaleDateString("en-NZ") + (o.ref ? " · your ref " + o.ref : "") }),
            el("span", { class: "cart-unit", text: o.items.join(", ") }),
            el("span", { class: "cart-unit", text: o.status + (o.tracking ? " · tracking " + o.tracking : "") + " · " + due }),
          ]),
          el("div", { class: "cart-controls" }, [
            el("span", { class: "cart-total", text: money(o.total) }),
            el("a", { class: "trade-link", href: "/api/dealer?invoice=" + o.invoice_number, text: "Invoice PDF" }),
          ]),
        ]);
      })));
    });
  }

  loadMe();
})();
