// Analytics wiring: js/track.js (Vercel Web Analytics custom events).
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const PUBLIC = new URL("../public/", import.meta.url);
const read = (f) => readFileSync(new URL(f, PUBLIC), "utf8");
const VA = '<script defer src="/_vercel/insights/script.js"></script>';

test("track: every page with Vercel analytics loads track.js just before it", () => {
  for (const page of readdirSync(PUBLIC).filter((f) => f.endsWith(".html"))) {
    const html = read(page);
    if (!html.includes(VA)) continue;
    assert.ok(
      html.includes('<script src="js/track.js"></script>\n' + VA),
      `${page} must load js/track.js on the line before the Vercel script, so early events are queued`,
    );
  }
});

test("contact: the phone number is written the international way everywhere", () => {
  const files = readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).map((f) => [f, read(f)]);
  files.push(["js/shop.js", read("js/shop.js")]);
  for (const [f, s] of files) {
    assert.ok(!s.includes("+64 021"), `${f} still says "+64 021": with +64 the leading 0 is dropped`);
  }
});

function loadTracker({ pathname = "/index.html", search = "", storage = {} } = {}) {
  const listeners = {};
  const store = { ...storage };
  const window = {
    location: { pathname, search },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { addEventListener: (type, fn) => { listeners[type] = fn; } },
  };
  window.window = window;
  vm.runInNewContext(read("js/track.js"), window);
  return { window, listeners, store, queued: () => JSON.parse(JSON.stringify((window.vaq || []).map((a) => Array.from(a)))) };
}

test("track: events queue until Vercel loads, keep two details, and cap text at 255", () => {
  const t = loadTracker();
  t.window.flipTrack("Add to cart", { sku: "FLIP-G3", page: "/index.html", extra: "dropped" });
  t.window.flipTrack("Checkout error", { error: "x".repeat(400) });
  t.window.flipTrack("Trade signed in");
  assert.deepEqual(t.queued(), [
    ["event", { name: "Add to cart", data: { sku: "FLIP-G3", page: "/index.html" } }],
    ["event", { name: "Checkout error", data: { error: "x".repeat(255) } }],
    ["event", { name: "Trade signed in" }],
  ]);
});

test("track: phone and email taps are counted", () => {
  const t = loadTracker({ pathname: "/" });
  const link = (href) => ({ target: { closest: () => ({ getAttribute: () => href }) } });
  t.listeners.click(link("tel:+642108327787"));
  t.listeners.click(link("mailto:sales@flipbikes.co.nz"));
  t.listeners.click(link("cart.html"));
  assert.deepEqual(t.queued(), [
    ["event", { name: "Phone tap", data: { page: "/index.html" } }],
    ["event", { name: "Email tap", data: { page: "/index.html", to: "sales@flipbikes.co.nz" } }],
  ]);
});

test("track: a purchase counts once per Stripe session, even if the thanks page is refreshed", () => {
  const first = loadTracker({ pathname: "/thanks.html", search: "?session_id=cs_test_1" });
  assert.deepEqual(first.queued(), [["event", { name: "Purchase" }]]);
  const refresh = loadTracker({ pathname: "/thanks.html", search: "?session_id=cs_test_1", storage: first.store });
  assert.deepEqual(refresh.queued(), []);
  const noSession = loadTracker({ pathname: "/thanks.html" });
  assert.deepEqual(noSession.queued(), [], "no session id means someone opened the page directly");
});

test("checkout: Stripe sends the buyer back with the session id, for purchase counting", () => {
  const src = readFileSync(new URL("../api/checkout.js", import.meta.url), "utf8");
  assert.ok(src.includes("/thanks.html?session_id={CHECKOUT_SESSION_ID}"));
});

test("contact: trade enquiries point at Ben, buying a chock still points at Craig", () => {
  for (const page of ["index.html", "about.html", "faq.html", "installation.html", "contact.html"]) {
    const html = read(page);
    assert.match(html, /Buying a chock\? Call Craig|or call Craig on/, `${page}: customers should still be sent to Craig`);
    assert.match(html, /Trade, dealer and trailer builder enquiries: email Ben on (<span class="text-span-4">)?<a href="mailto:ben@flipbikes\.co\.nz"/, `${page}: trade line should go to Ben`);
    assert.doesNotMatch(html, /wholesale enquiries please call Craig/, `${page}: old trade line still there`);
  }
  assert.match(read("js/trade.js"), /mailto:ben@flipbikes\.co\.nz/);
});

test("contact: the enquiry form reaches Ben as well as Craig, and trade mail replies to both", async () => {
  const send = readFileSync(new URL("../api/send.js", import.meta.url), "utf8");
  assert.match(send, /to: \[TO, TRADE_REP\]/);
  const { TRADE_REPLY_TO, REPLY_TO } = await import("../api/_lib/mail.js");
  assert.deepEqual(TRADE_REPLY_TO, ["ben@flipbikes.co.nz", "craig@betterservice.co.nz"]);
  assert.equal(REPLY_TO, "craig@betterservice.co.nz", "retail customers still reply to Craig");
  for (const f of ["../api/dealer.js", "../api/_lib/tradeOrder.js"]) {
    assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /reply_to: TRADE_REPLY_TO/, `${f} should reply to Ben and Craig`);
  }
});
