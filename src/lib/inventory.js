// src/lib/inventory.js

const AMENITY_SYNONYMS = [
  { key: "hot tub", patterns: ["hot tub", "hot tubs", "hottub", "hottubs", "spa tub", "spa tubs"] },
  { key: "jacuzzi", patterns: ["jacuzzi", "jacuzzis", "spa", "whirlpool"] },
  { key: "pool", patterns: ["pool", "pools", "swimming pool", "swimming pools"] },
  { key: "fireplace", patterns: ["fireplace", "fireplaces", "gas fireplace", "wood fireplace"] },
];

export function detectAmenityQuery(message) {
  const keys = detectAmenityKeys(message);
  return keys.length ? keys[0] : null;
}

export function detectAmenityKeys(message) {
  const msg = (message || "").toLowerCase();

  // simple phrasing patterns
  const looksLikeQuery = /\b(which|what|any|do any|show me|list|with)\b/.test(msg);
  const inventoryWords = /\b(units|cabins|suites|lodges|places|properties|rentals|listings)\b/.test(
    msg
  );
  const broadQuery = looksLikeQuery || inventoryWords;

  const keys = new Set();
  for (const a of AMENITY_SYNONYMS) {
    for (const p of a.patterns) {
      if (msg.includes(p) && broadQuery) {
        keys.add(a.key);
      }
    }
  }

  return [...keys];
}

export function detectAmenityKeyLoose(message) {
  const msg = (message || "").toLowerCase();
  for (const a of AMENITY_SYNONYMS) {
    for (const p of a.patterns) {
      if (msg.includes(p)) return a.key;
    }
  }
  return null;
}

export function hasAmenity(safeListing, amenityKey) {
  const list = (safeListing?.amenities || []).map((x) => String(x).toLowerCase());
  return list.some((a) => a.includes(amenityKey));
}
