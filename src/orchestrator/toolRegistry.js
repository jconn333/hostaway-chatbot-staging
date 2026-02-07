import { hasAmenity } from "../lib/inventory.js";
import {
  summarizeAvailabilityWithAlternatives,
  findAlternativeStays,
} from "../lib/availability.js";

async function ensureHostawayContext(ctx) {
  if (!ctx.__runtime) ctx.__runtime = {};
  if (!ctx.__runtime.accessToken) {
    const tokenData = await ctx.getHostawayAccessToken();
    ctx.__runtime.accessToken =
      typeof tokenData === "string"
        ? tokenData
        : tokenData?.access_token || tokenData?.token || null;
    if (!ctx.__runtime.accessToken) {
      throw new Error("Hostaway token missing access_token");
    }
  }
  if (!ctx.__runtime.listings) {
    ctx.__runtime.listings = await ctx.getListingsCached(ctx.__runtime.accessToken);
  }
  return ctx.__runtime;
}

function formatTime12(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  let h = null;
  let m = 0;

  if (/^\d{1,2}$/.test(raw)) {
    h = Number(raw);
  } else if (/^\d{3,4}$/.test(raw)) {
    const padded = raw.padStart(4, "0");
    h = Number(padded.slice(0, 2));
    m = Number(padded.slice(2, 4));
  } else if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [hh, mm] = raw.split(":");
    h = Number(hh);
    m = Number(mm);
  } else {
    return raw;
  }

  if (!Number.isFinite(h) || !Number.isFinite(m)) return raw;
  if (h < 0 || h > 23 || m < 0 || m > 59) return raw;

  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minute = String(m).padStart(2, "0");
  return `${hour12}:${minute} ${suffix}`;
}

function formatCheckInRange(start, end) {
  const s = formatTime12(start);
  const e = formatTime12(end);
  return [s, e].filter(Boolean).join("-");
}

function toDisplayDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso || "");
  const [y, m, d] = String(iso).split("-");
  return `${m}-${d}-${String(y).slice(-2)}`;
}

function petPolicyFromRules(safe) {
  const rules = String(safe?.houseRules || "").toLowerCase();
  const tags = (safe?.tags || []).map((t) => String(t).toLowerCase());
  const fields = (safe?.publicCustomFields || []).map((c) =>
    `${c.name}: ${c.value}`.toLowerCase()
  );
  const hay = [rules, ...tags, ...fields].join(" ");
  if (!hay) return "unknown";
  if (/\bno pets?\b|\bnot permitted\b|\bnot allowed\b/.test(hay)) return "not_allowed";
  if (/\bpet fee\b|\bpets allowed\b|\bpet[- ]?friendly\b/.test(hay)) return "allowed";
  return "unknown";
}

function policyAnswerFromHouseRules(safe, intent) {
  if (intent === "smoking") return "Smoking isn’t allowed at any of our units (non-smoking).";
  if (intent === "parties") return "Parties and events aren’t allowed at any of our units.";

  const rules = String(safe?.houseRules || "").toLowerCase();
  const tags = (safe?.tags || []).map((t) => String(t).toLowerCase());
  const fields = (safe?.publicCustomFields || []).map((c) =>
    `${c.name}: ${c.value}`.toLowerCase()
  );
  const hay = [rules, ...tags, ...fields].join(" ");
  if (!hay) return null;

  if (intent === "pets") {
    if (/\bno pets?\b|\bnot permitted\b|\bnot allowed\b/.test(hay)) {
      return "Pets aren’t allowed at this property.";
    }
    if (/\bpet fee\b|\bpets allowed\b|\bpet[- ]?friendly\b/.test(hay)) {
      return "Pets are allowed at this property.";
    }
  }

  if (intent === "noise" && /\bquiet\b|\bnoise\b|\bnot tolerate\b/.test(hay)) {
    return "Please keep noise to a respectful level; quiet hours apply per house rules.";
  }

  return null;
}

function policyAnswerFromFacts(safe, intent) {
  if (intent === "checkin") {
    const ci = formatCheckInRange(safe?.checkInStart, safe?.checkInEnd);
    if (ci) return `Check-in is ${ci}.`;
  }
  if (intent === "checkout") {
    const co = formatTime12(safe?.checkOut);
    if (co) return `Check-out is ${co}.`;
  }
  if (intent === "cancellation" && safe?.cancellationPolicy) {
    return `Cancellation policy: ${safe.cancellationPolicy}.`;
  }
  return null;
}

async function resolveListingByIdOrQuery(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const { listing_query } = args;
  const query = String(listing_query || "").trim();
  const listings = runtime.listings || [];

  const exactId = query.match(/^\d+$/) ? query : null;
  if (exactId) {
    const byId = listings.find((l) => String(l.id) === exactId);
    if (byId) {
      return {
        status: "ok",
        listing_id: String(byId.id),
        listing_name: byId.name || byId.internalListingName || `Listing ${byId.id}`,
        match_type: "id",
      };
    }
  }

  const strong = ctx.helpers.findListingIdFromMessageStrong(query, listings);
  if (strong) {
    const hit = listings.find((l) => String(l.id) === String(strong));
    return {
      status: "ok",
      listing_id: String(strong),
      listing_name: hit?.name || hit?.internalListingName || `Listing ${strong}`,
      match_type: "strong_name",
    };
  }

  const loose = ctx.helpers.findListingIdFromMessage(query, listings);
  if (loose) {
    const hit = listings.find((l) => String(l.id) === String(loose));
    return {
      status: "ok",
      listing_id: String(loose),
      listing_name: hit?.name || hit?.internalListingName || `Listing ${loose}`,
      match_type: "fuzzy_name",
    };
  }

  const candidates = ctx.helpers.suggestUnits(query, listings, 5);
  if (Array.isArray(candidates) && candidates.length) {
    return {
      status: "ambiguous",
      candidates: candidates.map((name) => {
        const hit = listings.find((l) => String(l.name || "") === String(name));
        return {
          listing_id: hit ? String(hit.id) : null,
          listing_name: name,
        };
      }),
    };
  }

  return {
    status: "not_found",
    message: "No matching unit found.",
  };
}

async function getListingSummary(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const listing = await ctx.fetchListingByIdCached(args.listing_id, runtime.accessToken);
  const safe = ctx.toSafeListingFacts(listing, { audience: "postbooking" });

  return {
    listing_id: String(safe.id),
    listing_name: safe.name,
    summary: safe.descriptionShort || safe.description || "",
    sleeps: safe.sleeps,
    bedrooms: safe.bedrooms,
    bathrooms: safe.bathrooms,
    beds: safe.beds,
    check_in: formatCheckInRange(safe.checkInStart, safe.checkInEnd) || null,
    check_out: formatTime12(safe.checkOut) || null,
    min_nights: safe.minNights ?? null,
    address: safe.address || null,
    amenities: (safe.amenities || []).slice(0, 25),
    booking_url: safe.bookingUrl,
  };
}

async function checkListingAvailability(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const listing = await ctx.fetchListingByIdCached(args.listing_id, runtime.accessToken);
  const safe = ctx.toSafeListingFacts(listing, { audience: "postbooking" });
  const days = await ctx.fetchCalendarRange(
    String(args.listing_id),
    args.start_date,
    args.end_date,
    runtime.accessToken
  );
  const summary = summarizeAvailabilityWithAlternatives(days, args.start_date, args.end_date);
  const alternatives = findAlternativeStays(days, Number(args.nights || 2), args.start_date, 3);

  return {
    listing_id: String(safe.id),
    listing_name: safe.name,
    start_date: args.start_date,
    end_date: args.end_date,
    start_display: toDisplayDate(args.start_date),
    end_display: toDisplayDate(args.end_date),
    available: Boolean(summary?.available),
    reason_code: summary?.reasonCode || null,
    blocked_date: summary?.blockedDate || null,
    suggestion: summary?.message || null,
    min_nights: safe.minNights ?? null,
    check_in: formatCheckInRange(safe.checkInStart, safe.checkInEnd) || null,
    check_out: formatTime12(safe.checkOut) || null,
    booking_url: safe.bookingUrl,
    alternatives: alternatives.map((a) => {
      const url = `${safe.bookingUrl}?start=${a.start}&end=${a.end}`;
      return {
        start_date: a.start,
        end_date: a.end,
        start_display: toDisplayDate(a.start),
        end_display: toDisplayDate(a.end),
        nights: a.nights,
        booking_url: url,
      };
    }),
  };
}

async function listUnits(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const listings = runtime.listings || [];
  const limit = Math.max(1, Math.min(Number(args.limit || 20), 40));
  const amenityKeys = Array.isArray(args.amenity_keys)
    ? args.amenity_keys.map((v) => String(v).toLowerCase())
    : [];
  const unitType = args.unit_type ? String(args.unit_type).toLowerCase() : null;
  const minSleeps = Number.isFinite(args.min_sleeps) ? Number(args.min_sleeps) : null;
  const minBedrooms = Number.isFinite(args.min_bedrooms) ? Number(args.min_bedrooms) : null;
  const minBathrooms = Number.isFinite(args.min_bathrooms) ? Number(args.min_bathrooms) : null;
  const petFriendly = args.pet_friendly === true;
  const startDate = args.available_start_date || null;
  const endDate = args.available_end_date || null;

  const safes = await Promise.all(
    listings.map(async (l) => {
      const full = await ctx.fetchListingByIdCached(l.id, runtime.accessToken);
      return ctx.toSafeListingFacts(full, { audience: "postbooking" });
    })
  );

  let matches = safes;
  if (unitType) {
    matches = matches.filter((s) => String(s.name || "").toLowerCase().includes(unitType));
  }
  if (minSleeps != null) matches = matches.filter((s) => Number(s.sleeps || 0) >= minSleeps);
  if (minBedrooms != null) matches = matches.filter((s) => Number(s.bedrooms || 0) >= minBedrooms);
  if (minBathrooms != null) matches = matches.filter((s) => Number(s.bathrooms || 0) >= minBathrooms);
  if (amenityKeys.length) {
    matches = matches.filter((s) => amenityKeys.every((k) => hasAmenity(s, k)));
  }
  if (petFriendly) {
    matches = matches.filter((s) => petPolicyFromRules(s) === "allowed");
  }

  if (startDate && endDate) {
    const filtered = [];
    for (const safe of matches) {
      // Use same per-turn runtime token to keep reads deterministic.
      const cal = await ctx.fetchCalendarRange(
        String(safe.id),
        startDate,
        endDate,
        runtime.accessToken
      );
      const summary = summarizeAvailabilityWithAlternatives(cal, startDate, endDate);
      if (summary?.available) filtered.push(safe);
      if (filtered.length >= limit) break;
    }
    matches = filtered;
  }

  const final = matches.slice(0, limit).map((s) => ({
    listing_id: String(s.id),
    listing_name: s.name,
    sleeps: s.sleeps ?? null,
    bedrooms: s.bedrooms ?? null,
    bathrooms: s.bathrooms ?? null,
    amenities: (s.amenities || []).slice(0, 15),
    booking_url: s.bookingUrl,
    pet_friendly: petPolicyFromRules(s) === "allowed",
  }));

  return {
    filters_applied: {
      unit_type: unitType,
      min_sleeps: minSleeps,
      min_bedrooms: minBedrooms,
      min_bathrooms: minBathrooms,
      amenity_keys: amenityKeys,
      pet_friendly: petFriendly,
      available_start_date: startDate,
      available_end_date: endDate,
    },
    count: final.length,
    units: final,
  };
}

async function getPolicy(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const topic = String(args.topic || "").toLowerCase();
  const listingId = args.listing_id ? String(args.listing_id) : null;

  if (topic === "smoking") {
    return {
      topic,
      scope: "global",
      answer: "Smoking isn’t allowed at any of our units (non-smoking).",
    };
  }
  if (topic === "parties") {
    return {
      topic,
      scope: "global",
      answer: "Parties and events aren’t allowed at any of our units.",
    };
  }

  if (!listingId) {
    return {
      topic,
      scope: "global",
      answer:
        "This policy can vary by unit. Please provide a specific unit name so I can check accurately.",
    };
  }

  const listing = await ctx.fetchListingByIdCached(listingId, runtime.accessToken);
  const safe = ctx.toSafeListingFacts(listing, { audience: "postbooking" });
  const answer =
    policyAnswerFromHouseRules(safe, topic) ||
    policyAnswerFromFacts(safe, topic) ||
    "I couldn’t find a definitive policy note for that topic in this unit’s data.";

  return {
    topic,
    scope: "listing",
    listing_id: String(safe.id),
    listing_name: safe.name,
    answer,
    booking_url: safe.bookingUrl,
  };
}

export function createToolRegistry() {
  const tools = [
    {
      name: "resolve_listing",
      description:
        "Resolve a listing id from a specific unit name or id the user already mentioned. Do not use for broad discovery requests.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["listing_query"],
        properties: {
          listing_query: { type: "string", minLength: 2, maxLength: 120 },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: resolveListingByIdOrQuery,
    },
    {
      name: "get_listing_summary",
      description: "Get listing facts and summary for a specific listing id.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["listing_id"],
        properties: {
          listing_id: { type: "string", pattern: "^\\d+$", minLength: 1, maxLength: 12 },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: getListingSummary,
    },
    {
      name: "check_listing_availability",
      description: "Check if a specific listing is available for an exact date range.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["listing_id", "start_date", "end_date"],
        properties: {
          listing_id: { type: "string", pattern: "^\\d+$", minLength: 1, maxLength: 12 },
          start_date: { type: "string", format: "date" },
          end_date: { type: "string", format: "date" },
          nights: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: checkListingAvailability,
    },
    {
      name: "list_units",
      description:
        "List units filtered by amenities, capacity, pet policy, type, and optional availability range. Use for broad discovery and availability without a specific listing id.",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          unit_type: {
            anyOf: [
              { type: "null" },
              {
                type: "string",
                enum: ["cabin", "suite", "lodge", "treehouse", "cottage", "tiny home"],
              },
            ],
          },
          amenity_keys: {
            type: "array",
            maxItems: 10,
            items: {
              type: "string",
              enum: [
                "hot tub",
                "jacuzzi",
                "pool",
                "fireplace",
                "sauna",
                "wifi",
                "kitchen",
                "air conditioning",
                "washing machine",
                "free parking",
              ],
            },
          },
          pet_friendly: { type: "boolean" },
          min_sleeps: { type: "integer", minimum: 1, maximum: 20 },
          min_bedrooms: { type: "integer", minimum: 0, maximum: 10 },
          min_bathrooms: { type: "integer", minimum: 0, maximum: 10 },
          available_start_date: { type: "string", format: "date" },
          available_end_date: { type: "string", format: "date" },
          limit: { type: "integer", minimum: 1, maximum: 40 },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: listUnits,
    },
    {
      name: "get_policy",
      description: "Get policy answers globally or for a specific listing.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["topic"],
        properties: {
          topic: {
            type: "string",
            enum: ["pets", "smoking", "parties", "noise", "checkin", "checkout", "cancellation"],
          },
          listing_id: {
            anyOf: [
              { type: "null" },
              { type: "string", pattern: "^\\d+$", minLength: 1, maxLength: 12 },
            ],
          },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: getPolicy,
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  const openaiTools = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.schema,
  }));

  return {
    tools,
    byName,
    openaiTools,
  };
}
