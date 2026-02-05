// src/lib/inventory.js

const AMENITY_SYNONYMS = [
  { key: "hot tub", patterns: ["hot tub", "hottub", "jacuzzi", "spa tub"] },
  { key: "pool", patterns: ["pool", "swimming pool"] },
  { key: "fireplace", patterns: ["fireplace", "gas fireplace", "wood fireplace"] },
];

export function detectAmenityQuery(message) {
  const msg = (message || "").toLowerCase();

  // simple phrasing patterns
  const looksLikeQuery =
    /\b(which|what|any|do any|show me|list)\b/.test(msg) &&
    /\b(units|cabins|suites|lodges|places|properties|rentals)\b/.test(msg);

  // Allow even if they don’t say “units”
  const broadQuery = /\b(which|what|any|do any|show me|list)\b/.test(msg);

  for (const a of AMENITY_SYNONYMS) {
    for (const p of a.patterns) {
      if (msg.includes(p) && (looksLikeQuery || broadQuery)) {
        return a.key; // canonical amenity key
      }
    }
  }

  return null;
}

export function hasAmenity(safeListing, amenityKey) {
  const list = (safeListing?.amenities || []).map((x) => String(x).toLowerCase());
  return list.some((a) => a.includes(amenityKey));
}