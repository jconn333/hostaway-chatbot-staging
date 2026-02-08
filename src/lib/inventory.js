// src/lib/inventory.js

const AMENITY_SYNONYMS = [
  {
    key: "hot tub",
    patterns: ["hot tub", "hot tubs", "hottub", "hottubs", "spa", "spa tub", "spa tubs"],
  },
  { key: "jacuzzi", patterns: ["jacuzzi", "jacuzzis", "whirlpool", "jetted tub", "jet tub"] },
  { key: "pool", patterns: ["pool", "pools", "swimming pool", "swimming pools"] },
  { key: "fireplace", patterns: ["fireplace", "fireplaces", "gas fireplace", "wood fireplace"] },
  { key: "sauna", patterns: ["sauna", "saunas", "steam room"] },
];

function normalizeAmenityTerm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getCanonicalAmenity(term) {
  const input = normalizeAmenityTerm(term);
  if (!input) return "";
  for (const amenity of AMENITY_SYNONYMS) {
    const canonical = normalizeAmenityTerm(amenity.key);
    if (input === canonical) return amenity.key;
    for (const pattern of amenity.patterns) {
      if (input === normalizeAmenityTerm(pattern)) return amenity.key;
    }
  }
  return input;
}

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
      if (msg.includes(p)) return getCanonicalAmenity(a.key);
    }
  }
  return null;
}

export function hasAmenity(safeListing, amenityKey) {
  const canonicalNeedle = getCanonicalAmenity(amenityKey);
  const list = (safeListing?.amenities || []).map((x) => String(x).toLowerCase());
  return list.some((a) => {
    const canonicalEntry = getCanonicalAmenity(a);
    return canonicalEntry === canonicalNeedle || canonicalEntry.includes(canonicalNeedle);
  });
}
