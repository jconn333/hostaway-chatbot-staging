// src/lib/hostaway.js

let listingsCache = { data: null, fetchedAt: 0 };
let listingDetailsCache = new Map(); // id -> { data, fetchedAt }

/* ===============================
   HOSTAWAY AUTH
================================ */
export async function getHostawayAccessToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.HOSTAWAY_ACCOUNT_ID,
    client_secret: process.env.HOSTAWAY_API_KEY,
    scope: "general",
  });

  const resp = await fetch("https://api.hostaway.com/v1/accessTokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-control": "no-cache",
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hostaway token failed (${resp.status}): ${text}`);
  }

  return await resp.json();
}

/* ===============================
   LISTINGS CACHE
================================ */
export async function getListingsCached(accessToken) {
  const TEN_MINUTES = 10 * 60 * 1000;

  if (listingsCache.data && Date.now() - listingsCache.fetchedAt < TEN_MINUTES) {
    return listingsCache.data;
  }

  const resp = await fetch("https://api.hostaway.com/v1/listings", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Cache-control": "no-cache",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hostaway listings failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const listings = data?.result || [];

  listingsCache = { data: listings, fetchedAt: Date.now() };
  return listings;
}

export async function fetchListingById(listingId, accessToken) {
  const resp = await fetch(`https://api.hostaway.com/v1/listings/${listingId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Cache-control": "no-cache",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hostaway listing failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data?.result;
}

export async function fetchListingByIdCached(listingId, accessToken) {
  const TEN_MINUTES = 10 * 60 * 1000;
  const hit = listingDetailsCache.get(String(listingId));

  if (hit && Date.now() - hit.fetchedAt < TEN_MINUTES) return hit.data;

  const data = await fetchListingById(listingId, accessToken);
  listingDetailsCache.set(String(listingId), { data, fetchedAt: Date.now() });
  return data;
}

/* ===============================
   SAFETY FILTER (CRITICAL)
   - Only public info
   - No door codes, WiFi passwords, private instructions, etc.
   - Booking URL is generated from your booking engine domain
================================ */
const CUSTOM_FIELDS_PREBOOKING = new Set([
  "Listing Layout",
  "Other Things To Know",
  "Listing Location",
]);

const CUSTOM_FIELDS_POSTBOOKING = new Set([
  ...CUSTOM_FIELDS_PREBOOKING,
  "Fireplace Instructions",
  "Grill / Firepit Location",
  "Trash Collection Location",
  "Outdoor Hot Tub Instructions",
  "Jacuzzi Tub Instructions",
  "Thermostat Instructions",
  "Sauna Instructions",
]);

function summarizeText(text, maxChars = 320) {
  if (!text) return "";
  const raw = String(text).replace(/\s+/g, " ").trim();
  const sentences = raw.split(/(?<=\.)\s+/);
  let out = sentences.slice(0, 2).join(" ");
  if (!out) out = raw;
  if (out.length > maxChars) out = out.slice(0, maxChars).trim() + "…";
  return out;
}

function deriveHighlights(amenities, tags) {
  const a = (amenities || []).map((x) => String(x).toLowerCase());
  const t = (tags || []).map((x) => String(x).toLowerCase());
  const highlights = [];
  const has = (needle) => a.some((x) => x.includes(needle)) || t.includes(needle);

  if (has("hot tub") || has("jacuzzi")) highlights.push("Private hot tub");
  if (has("fireplace")) highlights.push("Fireplace");
  if (has("pool") || has("swimming pool")) highlights.push("Pool access");
  if (has("treehouse")) highlights.push("Treehouse stay");
  if (has("kitchen")) highlights.push("Full kitchen");
  if (has("fitness center")) highlights.push("Fitness center access");

  return highlights.slice(0, 6);
}

function summarizeHouseRules(rulesText) {
  const rules = String(rulesText || "").toLowerCase();
  if (!rules) return "";
  const points = [];
  if (/\bno pets?\b|\bnot permitted\b|\bnot allowed\b/.test(rules)) points.push("No pets");
  if (/\bno smoking\b|\bnon[- ]?smoking\b/.test(rules)) points.push("No smoking");
  if (/\bno parties\b|\bzero[- ]tolerance\b/.test(rules)) points.push("No parties/events");
  if (/\bquiet\b|\bnoise\b/.test(rules)) points.push("Quiet hours / respect neighbors");
  return points.join("; ");
}

export function toSafeListingFacts(listing, opts = {}) {
  const audience = opts.audience || "prebooking"; // prebooking | postbooking
  const allowlist =
    audience === "postbooking" ? CUSTOM_FIELDS_POSTBOOKING : CUSTOM_FIELDS_PREBOOKING;

  const latitude =
    listing.latitude ??
    listing.lat ??
    listing.geoLat ??
    listing.locationLat ??
    null;
  const longitude =
    listing.longitude ??
    listing.lng ??
    listing.lon ??
    listing.geoLng ??
    listing.locationLng ??
    null;

  const amenities = (listing.listingAmenities || [])
    .map((a) => a.amenityName)
    .filter(Boolean);

  const tags = (listing.listingTags || [])
    .map((t) => t?.name)
    .filter(Boolean);

  const publicCustomFields = (listing.customFieldValues || [])
    .filter((c) => c?.customField?.isPublic === 1)
    .filter((c) => allowlist.has(c?.customField?.name))
    .map((c) => ({
      name: c.customField.name,
      value: c.value,
    }))
    .filter((x) => x.name && x.value);

  return {
    id: listing.id,
    name: listing.name,
    description: listing.description,
    descriptionShort: summarizeText(listing.description),
    houseRules: listing.houseRules,
    houseRulesSummary: summarizeHouseRules(listing.houseRules),

    address: listing.publicAddress || listing.address,
    city: listing.city,
    state: listing.state,
    locationSummary: [listing.city, listing.state].filter(Boolean).join(", "),

    sleeps: listing.personCapacity,
    bedrooms: listing.bedroomsNumber,
    bathrooms: listing.bathroomsNumber,
    beds: listing.bedsNumber,

    checkInStart: listing.checkInTimeStart,
    checkInEnd: listing.checkInTimeEnd,
    checkOut: listing.checkOutTime,
    minNights: listing.minNights,
    cancellationPolicy: listing.cancellationPolicy,

    latitude,
    longitude,

    amenities,
    highlights: deriveHighlights(amenities, tags),
    tags,
    publicCustomFields,

    // ✅ Booking engine link (stable, no Hostaway dependency)
    bookingUrl: `https://book.amishcountrylodging.com/listings/${listing.id}`,
  };
}

export async function fetchCalendarRange(listingId, startDate, endDate, accessToken) {
  const url =
    `https://api.hostaway.com/v1/listings/${listingId}/calendar` +
    `?startDate=${startDate}&endDate=${endDate}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Cache-control": "no-cache",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Availability failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data?.result || [];
}

export async function fetchSafeListingFacts(listingId, accessToken, opts = {}) {
  const listing = await fetchListingByIdCached(listingId, accessToken);
  return toSafeListingFacts(listing, opts);
}
