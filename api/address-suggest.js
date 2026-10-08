// GET /api/address-suggest?q=12+smith&country=NZ&token=<session>
// Address suggestions as the customer types. Proxies Google Places so the API
// key stays on the server. Returns { enabled, suggestions: [{ placeId, text }] }.

import { suggest, placesConfigured } from "./_lib/places.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!placesConfigured()) return res.status(200).json({ enabled: false, suggestions: [] });

  const q = String(req.query?.q ?? "").trim();
  const country = String(req.query?.country ?? "");
  if (q.length < 3 || q.length > 120 || (country !== "NZ" && country !== "AU")) {
    return res.status(200).json({ enabled: true, suggestions: [] });
  }
  try {
    const token = String(req.query?.token ?? "").slice(0, 64) || undefined;
    return res.status(200).json({ enabled: true, suggestions: await suggest(q, country, token) });
  } catch (err) {
    console.error("Address suggest failed:", err.message);
    // Not fatal: the cart page falls back to manual entry.
    return res.status(200).json({ enabled: true, suggestions: [], error: true });
  }
}
