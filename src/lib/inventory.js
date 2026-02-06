// src/lib/inventory.js

const AMENITY_SYNONYMS = [
  { key: "hot tub", patterns: ["hot tub", "hot tubs", "hottub", "hottubs", "spa tub", "spa tubs"] },
  { key: "jacuzzi", patterns: ["jacuzzi", "jacuzzis", "spa", "whirlpool", "jetted tub", "jet tub"] },
  { key: "pool", patterns: ["pool", "pools", "swimming pool", "swimming pools"] },
  { key: "fireplace", patterns: ["fireplace", "fireplaces", "gas fireplace", "wood fireplace"] },
  { key: "sauna", patterns: ["sauna", "saunas", "steam room"] },
];

const AMENITY_PATTERN_TO_KEY = new Map();
for (const entry of AMENITY_SYNONYMS) {
  AMENITY_PATTERN_TO_KEY.set(entry.key, entry.key);
  for (const pattern of entry.patterns) {
    AMENITY_PATTERN_TO_KEY.set(pattern, entry.key);
  }
}

export function normalizeAmenityTerm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[-_/]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalAmenityKey(value) {
  const normalized = normalizeAmenityTerm(value);
  if (!normalized) return "";
  if (AMENITY_PATTERN_TO_KEY.has(normalized)) return AMENITY_PATTERN_TO_KEY.get(normalized);
  if (normalized.endsWith("s")) {
    const singular = normalized.slice(0, -1);
    if (AMENITY_PATTERN_TO_KEY.has(singular)) return AMENITY_PATTERN_TO_KEY.get(singular);
  }
  return normalized;
}

function buildCatalog(availableAmenityNames = []) {
  const catalog = new Set();
  for (const name of availableAmenityNames) {
    const normalized = normalizeAmenityTerm(name);
    if (!normalized) continue;
    catalog.add(normalized);
    if (normalized.endsWith("s")) catalog.add(normalized.slice(0, -1));
  }
  return catalog;
}

export function detectAmenityQuery(message, options = {}) {
  const keys = detectAmenityKeys(message, options);
  return keys.length ? keys[0] : null;
}

export function detectAmenityKeys(message, options = {}) {
  const msg = (message || "").toLowerCase();
  const normalizedMessage = normalizeAmenityTerm(msg);
  const catalog = buildCatalog(options.availableAmenityNames || []);
  const forceBroad = Boolean(options.forceBroad);

  // simple phrasing patterns
  const looksLikeQuery = /\b(which|what|any|do any|show me|list|with)\b/.test(msg);
  const inventoryWords = /\b(units|cabins|suites|lodges|places|properties|rentals|listings)\b/.test(
    msg
  );
  const broadQuery = forceBroad || looksLikeQuery || inventoryWords;

  const keys = new Set();
  for (const a of AMENITY_SYNONYMS) {
    for (const p of a.patterns) {
      if (msg.includes(p) && broadQuery) {
        keys.add(a.key);
      }
    }
  }

  // Dynamic detection from amenity names present in Hostaway listing facts.
  if (broadQuery && catalog.size) {
    for (const amenity of catalog) {
      if (!amenity || amenity.length < 3) continue;
      if (normalizedMessage.includes(amenity)) {
        keys.add(canonicalAmenityKey(amenity));
      }
    }
  }

  return [...keys];
}

export function detectAmenityKeyLoose(message) {
  const msg = normalizeAmenityTerm(message);
  for (const a of AMENITY_SYNONYMS) {
    for (const p of a.patterns) {
      const normalized = normalizeAmenityTerm(p);
      if (msg.includes(normalized)) return a.key;
    }
  }
  return null;
}

export function hasAmenity(safeListing, amenityKey) {
  const list = (safeListing?.amenities || []).map((x) => normalizeAmenityTerm(x)).filter(Boolean);
  const wanted = canonicalAmenityKey(amenityKey);
  if (!wanted) return false;
  return list.some((a) => {
    const aCanonical = canonicalAmenityKey(a);
    return (
      a.includes(wanted) ||
      wanted.includes(a) ||
      aCanonical === wanted ||
      aCanonical.includes(wanted) ||
      wanted.includes(aCanonical)
    );
  });
}
