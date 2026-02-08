import { getCanonicalAmenity, hasAmenity } from "../lib/inventory.js";
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

async function checkListingAvailability(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const listing = await ctx.fetchListingByIdCached(args.listingId, runtime.accessToken);
  const safe = ctx.toSafeListingFacts(listing, { audience: "postbooking" });
  const days = await ctx.fetchCalendarRange(
    String(args.listingId),
    args.startDate,
    args.endDate,
    runtime.accessToken
  );
  const summary = summarizeAvailabilityWithAlternatives(days, args.startDate, args.endDate);
  const alternatives = findAlternativeStays(days, args.startDate, Number(args.nights || 2), 5, 3);

  return {
    listing_id: String(safe.id),
    listing_name: safe.name,
    start_date: args.startDate,
    end_date: args.endDate,
    start_display: toDisplayDate(args.startDate),
    end_display: toDisplayDate(args.endDate),
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

async function searchListings(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const listings = runtime.listings || [];
  const limit = 40;
  const amenityKeys = Array.isArray(args.amenityKeys)
    ? Array.from(
        new Set(
          args.amenityKeys
            .map((v) => getCanonicalAmenity(v))
            .map((v) => String(v || "").toLowerCase().trim())
            .filter(Boolean)
        )
      )
    : [];
  const unitType = args.unitType ? String(args.unitType).toLowerCase() : null;
  const minSleeps = Number.isFinite(args.sleeps) ? Number(args.sleeps) : null;
  const petFriendly = args.wantsPetFriendly === true;

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
  if (amenityKeys.length) {
    matches = matches.filter((s) => amenityKeys.every((k) => hasAmenity(s, k)));
  }
  if (petFriendly) {
    matches = matches.filter((s) => petPolicyFromRules(s) === "allowed");
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
      unitType: unitType || null,
      sleeps: minSleeps,
      amenityKeys,
      wantsPetFriendly: petFriendly,
    },
    count: final.length,
    units: final,
  };
}

async function getUnitDetails(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const topic = String(args.topic || "");
  const listingId = String(args.listingId);
  const safe =
    typeof ctx.fetchSafeListingFacts === "function"
      ? await ctx.fetchSafeListingFacts(listingId, runtime.accessToken, { audience: "postbooking" })
      : ctx.toSafeListingFacts(
          await ctx.fetchListingByIdCached(listingId, runtime.accessToken),
          { audience: "postbooking" }
        );

  if (topic === "amenities") {
    return {
      listing_id: String(safe.id),
      listing_name: safe.name,
      topic,
      amenities: safe.amenities || [],
      highlights: safe.highlights || [],
      booking_url: safe.bookingUrl,
    };
  }

  if (topic === "location") {
    return {
      listing_id: String(safe.id),
      listing_name: safe.name,
      topic,
      address: safe.address || null,
      city: safe.city || null,
      state: safe.state || null,
      location_summary: safe.locationSummary || null,
      booking_url: safe.bookingUrl,
    };
  }

  if (topic === "bedding") {
    return {
      listing_id: String(safe.id),
      listing_name: safe.name,
      topic,
      sleeps: safe.sleeps ?? null,
      bedrooms: safe.bedrooms ?? null,
      bathrooms: safe.bathrooms ?? null,
      beds: safe.beds ?? null,
      booking_url: safe.bookingUrl,
    };
  }

  if (topic === "summary") {
    return {
      listing_id: String(safe.id),
      listing_name: safe.name,
      topic,
      summary: safe.descriptionShort || safe.description || "",
      booking_url: safe.bookingUrl,
    };
  }

  return {
    listing_id: String(safe.id),
    listing_name: safe.name,
    topic,
    check_in: formatCheckInRange(safe.checkInStart, safe.checkInEnd) || null,
    check_out: formatTime12(safe.checkOut) || null,
    min_nights: safe.minNights ?? null,
    cancellation_policy: safe.cancellationPolicy || null,
    pet_policy:
      policyAnswerFromHouseRules(safe, "pets") ||
      "I couldn’t find a definitive pets policy note in this unit’s data.",
    smoking_policy:
      policyAnswerFromHouseRules(safe, "smoking") ||
      "Smoking isn’t allowed at any of our units (non-smoking).",
    parties_policy:
      policyAnswerFromHouseRules(safe, "parties") ||
      "Parties and events aren’t allowed at any of our units.",
    house_rules_summary: safe.houseRulesSummary || null,
    booking_url: safe.bookingUrl,
  };
}

async function searchAvailableUnits(args, ctx) {
  const runtime = await ensureHostawayContext(ctx);
  const listings = runtime.listings || [];

  const units = [];
  for (const listing of listings) {
    const listingId = String(listing.id);
    const full = await ctx.fetchListingByIdCached(listingId, runtime.accessToken);
    const safe = ctx.toSafeListingFacts(full, { audience: "postbooking" });
    const days = await ctx.fetchCalendarRange(
      listingId,
      args.startDate,
      args.endDate,
      runtime.accessToken
    );
    const summary = summarizeAvailabilityWithAlternatives(days, args.startDate, args.endDate);
    if (!summary?.available) continue;
    units.push({
      listing_id: listingId,
      listing_name: safe.name,
      sleeps: safe.sleeps ?? null,
      bedrooms: safe.bedrooms ?? null,
      bathrooms: safe.bathrooms ?? null,
      booking_url: `${safe.bookingUrl}?start=${args.startDate}&end=${args.endDate}`,
    });
  }

  return {
    start_date: args.startDate,
    end_date: args.endDate,
    start_display: toDisplayDate(args.startDate),
    end_display: toDisplayDate(args.endDate),
    count: units.length,
    units,
  };
}

export function createToolRegistry() {
  const tools = [
    {
      name: "search_listings",
      description:
        "Find units based on amenities, unit type, minimum sleeps, and pet-friendly preference.",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          amenityKeys: {
            type: "array",
            maxItems: 10,
            items: { type: "string", minLength: 1, maxLength: 60 },
          },
          unitType: { type: "string", minLength: 1, maxLength: 40 },
          sleeps: { type: "integer", minimum: 1, maximum: 20 },
          wantsPetFriendly: { type: "boolean" },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: searchListings,
    },
    {
      name: "check_availability",
      description:
        "Check if a specific unit is available for an exact date range.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["listingId", "startDate", "endDate"],
        properties: {
          listingId: { type: "string", pattern: "^\\d+$", minLength: 1, maxLength: 12 },
          startDate: { type: "string", format: "date" },
          endDate: { type: "string", format: "date" },
          nights: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: checkListingAvailability,
    },
    {
      name: "search_available_units",
      description:
        "Find all units that are available for an exact date range.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["startDate", "endDate"],
        properties: {
          startDate: { type: "string", format: "date" },
          endDate: { type: "string", format: "date" },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: searchAvailableUnits,
    },
    {
      name: "get_unit_details",
      description:
        "Get policy or summary/fact-based information for a specific unit.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["listingId", "topic"],
        properties: {
          listingId: { type: "string", pattern: "^\\d+$", minLength: 1, maxLength: 12 },
          topic: {
            type: "string",
            enum: ["policy", "amenities", "location", "bedding", "summary"],
          },
        },
      },
      roleAllowlist: ["guest", "qa", "admin"],
      irreversible: false,
      handler: getUnitDetails,
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
