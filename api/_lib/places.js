// Google Places API (New), called from the SERVER so the key never reaches the
// browser. Restrict the key in Google Cloud to "Places API (New)" only, and set
// a daily quota cap there as a backstop against anyone hammering the endpoint.

const key = () => process.env.GOOGLE_MAPS_API_KEY;
export const placesConfigured = () => Boolean(key());

// Address suggestions for what the customer has typed so far.
export async function suggest(input, country, sessionToken) {
  const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
    },
    body: JSON.stringify({
      input,
      includedRegionCodes: [country.toLowerCase()],
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Places autocomplete ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.suggestions || [])
    .filter((s) => s.placePrediction)
    .map((s) => ({ placeId: s.placePrediction.placeId, text: s.placePrediction.text?.text || "" }));
}

// The full, structured address for a chosen suggestion. This is what we price
// from — we never trust a postcode the browser claims a place has.
export async function details(placeId, sessionToken) {
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
    headers: {
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask": "id,formattedAddress,addressComponents",
    },
  });
  if (!r.ok) throw new Error(`Places details ${r.status}: ${await r.text()}`);
  const p = await r.json();
  const comp = (type, short = false) => {
    const c = (p.addressComponents || []).find((x) => (x.types || []).includes(type));
    return c ? (short ? c.shortText : c.longText) : "";
  };
  return {
    formatted: p.formattedAddress || "",
    line1: [comp("subpremise"), [comp("street_number"), comp("route")].filter(Boolean).join(" ")].filter(Boolean).join("/"),
    suburb: comp("sublocality") || comp("sublocality_level_1"),
    city: comp("locality") || comp("postal_town") || comp("administrative_area_level_2"),
    state: comp("administrative_area_level_1"),
    postcode: comp("postal_code"),
    country: comp("country", true),
  };
}
