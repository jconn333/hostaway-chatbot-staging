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
export function toSafeListingFacts(listing) {
  const amenities = (listing.listingAmenities || [])
    .map((a) => a.amenityName)
    .filter(Boolean);

  const publicCustomFields = (listing.customFieldValues || [])
    .filter((c) => c?.customField?.isPublic === 1)
    .map((c) => ({
      name: c.customField.name,
      value: c.value,
    }))
    .filter((x) => x.name && x.value);

  return {
    id: listing.id,
    name: listing.name,
    description: listing.description,
    houseRules: listing.houseRules,

    address: listing.publicAddress || listing.address,
    city: listing.city,
    state: listing.state,

    sleeps: listing.personCapacity,
    bedrooms: listing.bedroomsNumber,
    bathrooms: listing.bathroomsNumber,
    beds: listing.bedsNumber,

    checkInStart: listing.checkInTimeStart,
    checkInEnd: listing.checkInTimeEnd,
    checkOut: listing.checkOutTime,
    minNights: listing.minNights,

    amenities,
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

export async function fetchSafeListingFacts(listingId, accessToken) {
  const listing = await fetchListingByIdCached(listingId, accessToken);
  return toSafeListingFacts(listing);
}