// index.js
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";
import { getSandboxHtml, getReviewHtml } from "./src/ui.js";
import {
  isAvailabilityQuestion,
  isInventoryAvailabilityQuestion,
  summarizeAvailabilityWithAlternatives,
  addDays,
  extractDates,
  getTodayIso,
  findNextAvailableWeekend,
} from "./src/lib/availability.js";
import {
  getHostawayAccessToken,
  getListingsCached,
  toSafeListingFacts,
  fetchListingById,
  fetchCalendarRange,
} from "./src/lib/hostaway.js";
import {
  suggestUnits,
  findListingIdFromMessage,
  findListingIdFromMessageStrong,
} from "./src/lib/listings.js";
import { createHostawayRouter } from "./src/routes/hostaway.js";
import {
  detectAmenityQuery,
  detectAmenityKeys,
  detectAmenityKeyLoose,
  hasAmenity,
} from "./src/lib/inventory.js";
import { fetchListingByIdCached } from "./src/lib/hostaway.js";

const { Pool } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INVENTORY_AVAILABILITY_CONCURRENCY = 5;
const INVENTORY_AVAILABILITY_MAX = 20;
const INTENT_MODEL = "gpt-4o-mini";

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessionStore = new Map(); // sessionId -> { listingId, dates, lastMessage, lastIntent, lastPolicyIntent, lastAmenityKey, updatedAt }

const metrics = {
  requests_total: 0,
  errors_total: 0,
  intents: {},
  availability_queries: 0,
  policy_queries: 0,
};

function logEvent(type, data = {}) {
  const base = { ts: new Date().toISOString(), type };
  console.log(JSON.stringify({ ...base, ...data }));
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const s = sessionStore.get(String(sessionId));
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessionStore.delete(String(sessionId));
    return null;
  }
  return s;
}

function setSession(sessionId, patch) {
  if (!sessionId) return;
  const key = String(sessionId);
  const prev = sessionStore.get(key) || {};
  sessionStore.set(key, {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  });
}

function looksLikeSameDatesReference(message) {
  const msg = (message || "").toLowerCase();
  return /\b(same|those|that|previous|earlier)\b.*\b(dates|days|nights|range|weekend|time)\b/.test(
    msg
  );
}

function looksLikeSameMessageReference(message) {
  const msg = (message || "").toLowerCase();
  return /\b(same|that|previous|earlier)\b.*\b(one|unit|place|cabin|suite|listing|as before|again)\b/.test(
    msg
  );
}

function looksLikeFollowupQuestion(message) {
  const msg = (message || "").trim().toLowerCase();
  if (!msg) return false;
  if (/^(what about|how about|and what|and how|and|also|ok|okay|so|then)\b/.test(msg)) {
    return true;
  }
  return /\b(what about that|what about those|that one|those ones|them|those|any others|which ones)\b/.test(
    msg
  );
}

function looksLikeGenericUnitReference(message) {
  const msg = (message || "").toLowerCase();
  return /\b(cabin|unit|suite|lodge|place|property|rental|listing)\b/.test(msg);
}

function looksLikeProximityQuery(message) {
  const msg = (message || "").toLowerCase();
  return /\b(close|near|nearby|distance|far|how far|proximity)\b/.test(msg);
}

function getLatLon(safe) {
  const lat = Number(safe?.latitude);
  const lon = Number(safe?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function haversineMiles(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8; // miles
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function findSecondaryListingId(message, listings, primaryId) {
  if (!primaryId) return null;
  const filtered = listings.filter((l) => String(l.id) !== String(primaryId));
  return findListingIdFromMessage(message, filtered);
}

function looksLikeSummaryRequest(message) {
  const msg = (message || "").toLowerCase();
  return /\b(tell me about|about|overview|describe|summary)\b/.test(msg);
}

function isInventoryQuery(message) {
  const msg = (message || "").toLowerCase();
  const hasListWords = /\b(which|what|any|show|list)\b/.test(msg);
  const hasUnitWords = /\b(units|cabins|suites|lodges|places|properties|rentals|listings)\b/.test(
    msg
  );
  const hasFeatureWords = /\b(pet|pets|fireplace|hot tub|pool|sleeps|bedrooms|bathrooms|beds|available|availability)\b/.test(
    msg
  );
  return hasListWords && (hasUnitWords || hasFeatureWords);
}

async function classifyIntent(message) {
  const text = (message || "").trim();
  if (!text) return { intent: "general", confidence: 0 };
  try {
    const resp = await client.responses.create({
      model: INTENT_MODEL,
      instructions:
        "Return JSON only. Classify intent as one of: " +
        "availability, inventory_availability, amenity_inventory, policy, compare, summary, general. " +
        "Include a confidence number 0-1. No other keys.",
      input: [
        {
          role: "user",
          content: `Message: ${text}`,
        },
      ],
    });
    const raw = resp.output_text || "";
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.intent === "string") return parsed;
  } catch (err) {
    console.error("Intent classify error:", err);
  }
  return { intent: "general", confidence: 0 };
}

function renderStructuredReply(data) {
  if (!data || typeof data !== "object") return "";
  const parts = [];
  if (data.title) parts.push(data.title);
  if (data.answer) parts.push(data.answer);
  if (Array.isArray(data.bullets) && data.bullets.length) {
    parts.push("\n" + data.bullets.map((b) => `• ${b}`).join("\n"));
  }
  if (data.followup) {
    parts.push("\n" + data.followup);
  } else {
    const last = parts[parts.length - 1] || "";
    if (!/\?\s*$/.test(last)) {
      parts.push("\nWould you like me to check availability or answer anything else about this unit?");
    }
  }
  return parts.join("\n");
}

function appendFollowupIfMissing(text, followup) {
  const t = String(text || "").trimEnd();
  if (!t) return followup;
  if (/\?\s*$/.test(t)) return t;
  return `${t}\n\n${followup}`;
}

function detectPolicyIntent(message) {
  const msg = (message || "").toLowerCase();
  if (msg.includes("pet")) return "pets";
  if (/\b(pet|pets|dog|dogs|cat|cats)\b/.test(msg)) return "pets";
  if (/\b(smok|smoking|cigarette|vape)\b/.test(msg)) return "smoking";
  if (/\b(party|parties|events|gathering)\b/.test(msg)) return "parties";
  if (/\b(noise|quiet|loud|music|neighbors)\b/.test(msg)) return "noise";
  if (/\b(check[- ]?in|check in|arrival)\b/.test(msg)) return "checkin";
  if (/\b(check[- ]?out|check out|departure)\b/.test(msg)) return "checkout";
  if (/\b(cancellation|cancel|refund)\b/.test(msg)) return "cancellation";
  return null;
}

function isPetFriendlyListRequest(message) {
  const msg = (message || "").toLowerCase();
  const hasOtherAmenities = detectAmenityKeys(msg).length > 0;
  const hasUnitType = detectUnitType(msg);
  if (hasOtherAmenities || hasUnitType) return false;
  return (
    /\b(which|what|list|show)\b/.test(msg) &&
    /\b(pet|pets|pet[- ]friendly|dogs|cats)\b/.test(msg)
  );
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
  if (/\bpet fee\b|\bpets allowed\b|\bpet[- ]friendly\b/.test(hay)) return "allowed";
  return "unknown";
}

function extractCapacityQuery(message) {
  const msg = (message || "").toLowerCase();
  const cap = {};
  const sleeps = msg.match(/\b(sleeps?|guests?|people|persons?)\s*(\d+)\b/);
  if (sleeps) cap.sleeps = Number(sleeps[2]);
  const beds = msg.match(/\b(\d+)\s*beds?\b/);
  if (beds) cap.beds = Number(beds[1]);
  const bedrooms = msg.match(/\b(\d+)\s*bedrooms?\b/);
  if (bedrooms) cap.bedrooms = Number(bedrooms[1]);
  const bathrooms = msg.match(/\b(\d+)\s*bathrooms?\b/);
  if (bathrooms) cap.bathrooms = Number(bathrooms[1]);
  return Object.keys(cap).length ? cap : null;
}

function policyAnswerFromHouseRules(safe, intent) {
  // Global policies (company-wide)
  if (intent === "smoking") {
    return "Smoking isn’t allowed at any of our units (non‑smoking).";
  }
  if (intent === "parties") {
    return "Parties and events aren’t allowed at any of our units.";
  }

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
    if (/\bpet fee\b|\bpets allowed\b|\bpet[- ]friendly\b/.test(hay)) {
      return "Pets are allowed at this property.";
    }
  }

  if (intent === "smoking") {
    if (/\bnon[- ]?smoking\b|\bno smoking\b/.test(hay)) {
      return "Smoking isn’t allowed at this property.";
    }
  }

  if (intent === "parties") {
    if (/\bno parties\b|\bno party\b|\bzero[- ]tolerance\b/.test(hay)) {
      return "Parties and events aren’t allowed at this property.";
    }
  }

  if (intent === "noise") {
    if (/\bquiet\b|\bnoise\b|\bnot tolerate\b/.test(hay)) {
      return "Please keep noise to a respectful level; quiet hours apply per house rules.";
    }
  }

  if (intent === "cancellation") {
    if (safe?.cancellationPolicy) {
      return `Cancellation policy: ${safe.cancellationPolicy}.`;
    }
  }

  return null;
}

function policyAnswerFromFacts(safe, intent) {
  if (intent === "checkin") {
    if (safe?.checkInStart || safe?.checkInEnd) {
      const ci = [safe.checkInStart, safe.checkInEnd].filter(Boolean).join("–");
      return `Check‑in is ${ci || "available during the standard window for this unit"}.`;
    }
  }
  if (intent === "checkout") {
    if (safe?.checkOut) {
      return `Check‑out is ${safe.checkOut}.`;
    }
  }
  return null;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildSafeSummary(safe) {
  if (!safe) return "I don’t have details for that unit yet.";
  const MAX_SUMMARY_CHARS = 1200;
  const parts = [];
  parts.push(`Here’s a quick, friendly overview of ${safe.name}:`);
  if (safe.description) {
    const raw = String(safe.description).replace(/\s+/g, " ").trim();
    let desc = raw;
    const sentences = raw.split(/(?<=\.)\s+/);
    if (sentences.length > 2) {
      desc = sentences.slice(0, 2).join(" ");
    } else if (raw.length > 420) {
      desc = raw.slice(0, 420).trim() + "…";
    }
    parts.push(`\n${desc}`);
  }
  const facts = [];
  if (safe.sleeps != null) facts.push(`Sleeps ${safe.sleeps}`);
  if (safe.bedrooms != null) facts.push(`${safe.bedrooms} bedrooms`);
  if (safe.bathrooms != null) facts.push(`${safe.bathrooms} bathrooms`);
  if (safe.beds != null) facts.push(`${safe.beds} beds`);
  if (facts.length) parts.push(`\nAt‑a‑glance: ${facts.join(", ")}.`);
  if (safe.checkInStart || safe.checkInEnd || safe.checkOut) {
    const ci = [safe.checkInStart, safe.checkInEnd].filter(Boolean).join("–");
    const co = safe.checkOut ? `Check‑out ${safe.checkOut}` : "";
    parts.push(`Check‑in ${ci || "time varies"}${co ? `, ${co}` : ""}.`);
  }
  if (safe.minNights != null) parts.push(`Minimum stay: ${safe.minNights} nights.`);
  if (safe.address || safe.city || safe.state) {
    const loc = [safe.address, safe.city, safe.state].filter(Boolean).join(", ");
    parts.push(`Location: ${loc}.`);
  }
  if (Array.isArray(safe.amenities) && safe.amenities.length) {
    parts.push(
      `Amenities include ${safe.amenities.slice(0, 12).join(", ")}${
        safe.amenities.length > 12 ? "…" : ""
      }.`
    );
  }
  if (safe.bookingUrl) parts.push(`\nBook now: ${safe.bookingUrl}`);
  parts.push("\nWould you like me to check availability or answer anything else?");
  const text = parts.join("\n");
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return text.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + "…";
}

function formatAmenityList(amenities, limit = 8) {
  const list = Array.isArray(amenities) ? amenities.filter(Boolean) : [];
  if (list.length === 0) return "—";
  const shown = list.slice(0, limit).join(", ");
  return list.length > limit ? `${shown}…` : shown;
}

function formatCheckTimes(safe) {
  const ci = [safe.checkInStart, safe.checkInEnd].filter(Boolean).join("–");
  const co = safe.checkOut ? `Check‑out ${safe.checkOut}` : "";
  if (!ci && !co) return "";
  return `Check‑in ${ci || "time varies"}${co ? `, ${co}` : ""}.`;
}

function detectUnitType(message) {
  const msg = (message || "").toLowerCase();
  const types = ["treehouse", "cabin", "suite", "lodge", "cottage", "tiny home"];
  return types.find((t) => msg.includes(t)) || null;
}

function detectPetFriendlyFilter(message) {
  const msg = (message || "").toLowerCase();
  return /\bpet[- ]?friendly\b|\bpets? allowed\b|\ballow(s)? pets\b/.test(msg);
}

function buildComparison(primarySafe, secondarySafe) {
  const lines = [];
  const diffs = [];
  lines.push("Here’s a quick comparison:");
  lines.push("");
  lines.push(
    `• ${primarySafe.name}: Sleeps ${primarySafe.sleeps ?? "—"}, ` +
      `${primarySafe.bedrooms ?? "—"} bd, ${primarySafe.bathrooms ?? "—"} ba, ` +
      `min stay ${primarySafe.minNights ?? "—"}`
  );
  lines.push(`  Amenities: ${formatAmenityList(primarySafe.amenities)}`);
  lines.push(
    `• ${secondarySafe.name}: Sleeps ${secondarySafe.sleeps ?? "—"}, ` +
      `${secondarySafe.bedrooms ?? "—"} bd, ${secondarySafe.bathrooms ?? "—"} ba, ` +
      `min stay ${secondarySafe.minNights ?? "—"}`
  );
  lines.push(`  Amenities: ${formatAmenityList(secondarySafe.amenities)}`);
  if (primarySafe.bedrooms !== secondarySafe.bedrooms) {
    diffs.push(
      `${primarySafe.name} has ${primarySafe.bedrooms ?? "—"} bedrooms vs ${secondarySafe.name} has ${secondarySafe.bedrooms ?? "—"}`
    );
  }
  if (primarySafe.bathrooms !== secondarySafe.bathrooms) {
    diffs.push(
      `${primarySafe.name} has ${primarySafe.bathrooms ?? "—"} bathrooms vs ${secondarySafe.name} has ${secondarySafe.bathrooms ?? "—"}`
    );
  }
  const aSet = new Set((primarySafe.amenities || []).map((x) => String(x).toLowerCase()));
  const bSet = new Set((secondarySafe.amenities || []).map((x) => String(x).toLowerCase()));
  const aHotTub = [...aSet].some((x) => x.includes("hot tub") || x.includes("jacuzzi"));
  const bHotTub = [...bSet].some((x) => x.includes("hot tub") || x.includes("jacuzzi"));
  if (aHotTub !== bHotTub) {
    diffs.push(
      `${primarySafe.name} ${aHotTub ? "has" : "does not have"} a hot tub vs ${secondarySafe.name} ${
        bHotTub ? "has" : "does not have"
      } a hot tub`
    );
  }
  if (diffs.length) {
    lines.push("");
    lines.push("Key differences:");
    for (const d of diffs.slice(0, 6)) lines.push(`• ${d}`);
  }
  lines.push("");
  lines.push(`[${primarySafe.name}](${primarySafe.bookingUrl})`);
  lines.push(`[${secondarySafe.name}](${secondarySafe.bookingUrl})`);
  return lines.join("\n");
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===============================
   ROUTES
================================ */

// Health check
app.get("/", (req, res) => {
  res.send("Chatbot server is running 🚀");
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    uptime_sec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", (req, res) => {
  res.json(metrics);
});

/* ---------- SANDBOX UI ---------- */
app.get("/sandbox", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getSandboxHtml());
});

/* ---------- REVIEW UI ---------- */

app.get("/review", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getReviewHtml());
});

app.use("/hostaway", createHostawayRouter());

/* ---------- SESSION DEBUG ---------- */
app.get("/session/debug", (req, res) => {
  const sessionId = req.query.sessionId || req.headers["x-session-id"] || null;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "Missing sessionId" });
  }
  const session = getSession(sessionId);
  res.json({
    ok: true,
    sessionId: String(sessionId),
    session: session || null,
    ttlMs: SESSION_TTL_MS,
  });
});

/* ---------- CHAT ---------- */
app.post("/chat", async (req, res) => {
  try {
    metrics.requests_total += 1;
    const userMessage = req.body.message || "";
    let listingId = req.body.listingId || null;
    const sessionId = req.body.sessionId || req.headers["x-session-id"] || null;
    const session = sessionId ? getSession(sessionId) : null;
    let memoryNote = "";
    const debugEnabled =
      req.query?.debug === "1" || String(req.headers["x-debug"] || "") === "1";
    const setDebugHeader = (key, value) => {
      if (!debugEnabled) return;
      if (value == null) return;
      res.setHeader(`X-Debug-${key}`, String(value));
    };
    const followupAmenityKey =
      looksLikeFollowupQuestion(userMessage) && session?.lastAmenityKey
        ? session.lastAmenityKey
        : null;
    const followupInventory =
      looksLikeFollowupQuestion(userMessage) && session?.lastInventory
        ? session.lastInventory
        : null;
    const intent = await classifyIntent(userMessage);
    metrics.intents[intent.intent] = (metrics.intents[intent.intent] || 0) + 1;
    setSession(sessionId, { lastIntent: intent.intent });
    setDebugHeader("Intent", intent.intent);
    logEvent("chat_request", {
      sessionId: sessionId || "anonymous",
      listingId: listingId || null,
      intent: intent.intent,
    });
    const policyIntentRaw = detectPolicyIntent(userMessage);
    setDebugHeader("PolicyIntent", policyIntentRaw);
    const earlyAmenityIntent = detectAmenityKeyLoose(userMessage);
    let inventoryIntent =
      isInventoryQuery(userMessage) ||
      ["inventory_availability", "amenity_inventory", "policy"].includes(intent.intent);
    if (session?.listingId && earlyAmenityIntent && !isInventoryQuery(userMessage)) {
      inventoryIntent = false;
    }
    setDebugHeader("InventoryIntent", inventoryIntent);

    const tokenData = await getHostawayAccessToken();
    const accessToken = tokenData.access_token;

    const listings = await getListingsCached(accessToken);

    // ---------- INVENTORY-WIDE CAPACITY QUESTIONS ----------
    if (inventoryIntent) {
      const cap = extractCapacityQuery(userMessage);
      if (cap) {
        const results = await mapWithConcurrency(
          listings,
          INVENTORY_AVAILABILITY_CONCURRENCY,
          async (l) => {
            try {
              const listing = await fetchListingByIdCached(l.id, accessToken);
              const safe = toSafeListingFacts(listing, { audience: "postbooking" });
              const ok =
                (cap.sleeps ? safe.sleeps >= cap.sleeps : true) &&
                (cap.bedrooms ? safe.bedrooms >= cap.bedrooms : true) &&
                (cap.bathrooms ? safe.bathrooms >= cap.bathrooms : true) &&
                (cap.beds ? safe.beds >= cap.beds : true);
              if (ok) {
                return `• [${safe.name}](${safe.bookingUrl}) — Sleeps ${safe.sleeps}, ${safe.bedrooms} bd`;
              }
            } catch (err) {
              console.error("Inventory capacity error:", err);
            }
            return null;
          }
        );

        const lines = results.filter(Boolean);
        if (lines.length === 0) {
          return res.json({
            reply: "I didn’t find any units that match that capacity.",
          });
        }
        return res.json({
          reply: `Units that match your request:\n\n${lines.join("\n")}`,
        });
      }
    }

    // ---------- INVENTORY-WIDE PET-FRIENDLY LIST ----------
    if (isPetFriendlyListRequest(userMessage)) {
      const results = await mapWithConcurrency(
        listings,
        INVENTORY_AVAILABILITY_CONCURRENCY,
        async (l) => {
          try {
            const listing = await fetchListingByIdCached(l.id, accessToken);
            const safe = toSafeListingFacts(listing, { audience: "postbooking" });
            const policy = petPolicyFromRules(safe);
            if (policy === "allowed") {
              return `• [${safe.name}](${safe.bookingUrl})`;
            }
          } catch (err) {
            console.error("Pet policy list error:", err);
          }
          return null;
        }
      );

      const lines = results.filter(Boolean);
      if (lines.length === 0) {
        return res.json({
          reply: "I don’t currently see any pet‑friendly units.",
        });
      }

      setSession(sessionId, {
        lastInventory: { type: "amenity", amenityKeys: [], unitType: null, petFriendly: true },
      });

      return res.json({
        reply: `Pet‑friendly units:\n\n${lines.join("\n")}`,
      });
    }

    // Detect listing from message if not explicitly provided
    if (!listingId) {
      const amenityIntent = detectAmenityQuery(userMessage);
      const detected = inventoryIntent
        ? findListingIdFromMessageStrong(userMessage, listings)
        : findListingIdFromMessage(userMessage, listings);
      if (detected) {
        listingId = detected;
        setSession(sessionId, { listingId });
      } else if (
        session?.listingId &&
        !inventoryIntent
      ) {
        // Only reuse session unit when user implies continuity (e.g., "same/that one")
        // or the message doesn't reference a generic unit category.
        if (
          looksLikeSameMessageReference(userMessage) ||
          !looksLikeGenericUnitReference(userMessage)
        ) {
          listingId = session.listingId;
          memoryNote = "\n\n(Using your last unit from this session.)";
        }
      } else if (
        session?.listingId &&
        looksLikeFollowupQuestion(userMessage) &&
        !looksLikeGenericUnitReference(userMessage)
      ) {
        listingId = session.listingId;
        memoryNote = "\n\n(Using your last unit from this session.)";
      } else if (session?.lastMessage && looksLikeSameMessageReference(userMessage)) {
        const fromLast = findListingIdFromMessage(session.lastMessage, listings);
        if (fromLast) {
          listingId = fromLast;
          setSession(sessionId, { listingId });
          memoryNote = "\n\n(Using your last unit from this session.)";
        }
      }
    }
    setDebugHeader("ListingId", listingId);

    // ---------- INVENTORY-WIDE AVAILABILITY QUESTIONS ----------
    if (
      !listingId &&
      (isInventoryAvailabilityQuestion(userMessage) ||
        intent.intent === "inventory_availability" ||
        followupInventory?.type === "availability")
    ) {
      let dates = extractDates(userMessage);
      if (!dates && followupInventory?.type === "availability" && followupInventory?.dates) {
        dates = followupInventory.dates;
      }
      if (dates) {
        setDebugHeader("Dates", `${dates.start}..${dates.end}`);
      }
      if (!dates) {
        return res.json({
          reply:
            "Which dates should I check for availability? For example: “tonight” or “2026-03-24 to 2026-03-26”.",
        });
      }

      const endForCalendar = addDays(dates.end, -1);
      if (endForCalendar < dates.start) {
        return res.json({
          reply: "End date must be after start date (checkout after check-in).",
        });
      }

      const results = await mapWithConcurrency(
        listings,
        INVENTORY_AVAILABILITY_CONCURRENCY,
        async (l) => {
          try {
            const days = await fetchCalendarRange(l.id, dates.start, endForCalendar, accessToken);
            const summary = summarizeAvailabilityWithAlternatives(days, dates.start, dates.end);
            if (summary?.available === true) {
              const listing = await fetchListingByIdCached(l.id, accessToken);
              const safe = toSafeListingFacts(listing, { audience: "postbooking" });
              const bookUrl = `${safe.bookingUrl}?start=${dates.start}&end=${dates.end}`;
              return `• [${safe.name}](${bookUrl})`;
            }
          } catch (err) {
            console.error("Inventory availability error:", err);
          }
          return null;
        }
      );

      const lines = results.filter(Boolean);
      if (lines.length === 0) {
        return res.json({
          reply: `I didn’t find any available units for ${dates.start} to ${dates.end}.`,
        });
      }

      const total = lines.length;
      const shown = lines.slice(0, INVENTORY_AVAILABILITY_MAX);
      const more = total > shown.length ? `\n\n(+${total - shown.length} more available)` : "";

      setSession(sessionId, {
        lastInventory: { type: "availability", dates },
      });

      return res.json({
        reply: `Available units for ${dates.start} to ${dates.end}:\n\n${shown.join("\n")}${more}`,
      });
    }

    // If user mentions another listing, allow session primary to pair with it
    const secondaryIdPre = listingId
      ? findSecondaryListingId(userMessage, listings, listingId)
      : findListingIdFromMessage(userMessage, listings);
    if (!listingId && secondaryIdPre && session?.listingId) {
      listingId = session.listingId;
      memoryNote = "\n\n(Using your last unit from this session.)";
    }

    // If user asks proximity between current session unit and a mentioned unit
    let primaryId = listingId;
    let secondaryId = findSecondaryListingId(userMessage, listings, listingId);
    if (
      (looksLikeProximityQuery(userMessage) || intent.intent === "compare") &&
      session?.listingId &&
      listingId &&
      String(listingId) !== String(session.listingId)
    ) {
      primaryId = session.listingId;
      secondaryId = listingId;
      memoryNote = "\n\n(Using your last unit from this session.)";
    }

    // If user mentions another listing (e.g., "close to Water Lily Cabin"), handle comparison
    if (
      primaryId &&
      secondaryId &&
      (looksLikeProximityQuery(userMessage) || intent.intent === "compare")
    ) {
      const primaryFull = await fetchListingByIdCached(primaryId, accessToken);
      const secondaryFull = await fetchListingByIdCached(secondaryId, accessToken);
      const primarySafe = toSafeListingFacts(primaryFull, { audience: "postbooking" });
      const secondarySafe = toSafeListingFacts(secondaryFull, { audience: "postbooking" });

      if (intent.intent === "compare" && !looksLikeProximityQuery(userMessage)) {
        return res.json({ reply: buildComparison(primarySafe, secondarySafe) });
      }

      const sameCity =
        primarySafe?.city &&
        secondarySafe?.city &&
        String(primarySafe.city).toLowerCase() === String(secondarySafe.city).toLowerCase();
      const sameState =
        primarySafe?.state &&
        secondarySafe?.state &&
        String(primarySafe.state).toLowerCase() === String(secondarySafe.state).toLowerCase();

      const msgLower = (userMessage || "").toLowerCase();
      const pIdx = msgLower.indexOf(String(primarySafe.name || "").toLowerCase());
      const sIdx = msgLower.indexOf(String(secondarySafe.name || "").toLowerCase());
      const shouldSwap =
        pIdx >= 0 && sIdx >= 0 && sIdx < pIdx;
      const displayPrimary = shouldSwap ? secondarySafe : primarySafe;
      const displaySecondary = shouldSwap ? primarySafe : secondarySafe;

      const a = getLatLon(primarySafe);
      const b = getLatLon(secondarySafe);
      let locationLine = "I don’t have exact distance data between units.";
      if (a && b) {
        const miles = haversineMiles(a, b);
        if (miles < 0.1) {
          locationLine =
            "They appear to be essentially at the same location (very close together).";
        } else {
          locationLine = `They’re approximately ${miles.toFixed(1)} miles apart (straight‑line distance).`;
        }
      } else if (sameCity && sameState) {
        locationLine = `Both are in ${primarySafe.city}, ${primarySafe.state}. I don’t have exact distance data between units.`;
      }
      if (sameCity && sameState) {
        // keep the city/state note if we don't have coordinates
      } else if (displayPrimary.city || displayPrimary.state || displaySecondary.city || displaySecondary.state) {
        const aLoc = [displayPrimary.city, displayPrimary.state].filter(Boolean).join(", ");
        const bLoc = [displaySecondary.city, displaySecondary.state].filter(Boolean).join(", ");
        locationLine = `They appear to be in different locations: ${displayPrimary.name} is in ${aLoc || "an unknown location"}, and ${displaySecondary.name} is in ${bLoc || "an unknown location"}. I don’t have exact distance data between units.`;
      }

      return res.json({
        reply:
          `${locationLine}\n\n` +
          `[${displayPrimary.name}](${displayPrimary.bookingUrl})\n` +
          `[${displaySecondary.name}](${displaySecondary.bookingUrl})`,
      });
    }

    // ---------- INVENTORY-WIDE AMENITY QUESTIONS ----------
    if (!listingId || followupAmenityKey) {
      let amenityKeys = detectAmenityKeys(userMessage);
      let unitType = detectUnitType(userMessage);
      let wantsPetFriendly = detectPetFriendlyFilter(userMessage);
      const looksLikeListRequest = /\b(which|what|list|show|any)\b/.test(
        (userMessage || "").toLowerCase()
      );
      const skipAmenityInventory =
        policyIntentRaw === "pets" && !looksLikeListRequest && !amenityKeys.length && !unitType;
      const availabilityAsked =
        isAvailabilityQuestion(userMessage) ||
        intent.intent === "availability" ||
        session?.lastIntent === "availability";

      if (followupInventory?.type === "amenity") {
        if (!amenityKeys.length && followupInventory.amenityKeys) {
          amenityKeys = followupInventory.amenityKeys;
        }
        if (!unitType && followupInventory.unitType) {
          unitType = followupInventory.unitType;
        }
        if (!wantsPetFriendly && followupInventory.petFriendly) {
          wantsPetFriendly = true;
        }
      }

      const amenityKey = detectAmenityQuery(userMessage) || followupAmenityKey;

      if (
        amenityKeys.length > 0 ||
        amenityKey ||
        wantsPetFriendly ||
        unitType ||
        intent.intent === "amenity_inventory"
      ) {
        if (
          !skipAmenityInventory &&
          !(
            availabilityAsked &&
            unitType &&
            !amenityKeys.length &&
            !amenityKey &&
            !wantsPetFriendly
          ) &&
          (looksLikeListRequest || amenityKeys.length || unitType || intent.intent === "amenity_inventory")
        ) {
        const effectiveAmenityKeys = amenityKeys.length ? amenityKeys : amenityKey ? [amenityKey] : [];
        if (effectiveAmenityKeys.length) {
          setDebugHeader("AmenityKeys", effectiveAmenityKeys.join(","));
        }
        if (unitType) setDebugHeader("UnitType", unitType);
        if (wantsPetFriendly) setDebugHeader("PetFriendly", "true");
        setSession(sessionId, {
          lastAmenityKey: amenityKey || effectiveAmenityKeys[0] || null,
          lastInventory: {
            type: "amenity",
            amenityKeys: effectiveAmenityKeys,
            unitType,
            petFriendly: wantsPetFriendly,
          },
        });
        // Fetch details for each listing (cached), convert to safe facts, filter by amenity
        const safes = await Promise.all(
          listings.map(async (l) => {
            const full = await fetchListingByIdCached(l.id, accessToken);
            return toSafeListingFacts(full, { audience: "postbooking" });
          })
        );

        let matches = safes;
        if (effectiveAmenityKeys.length) {
          matches = matches.filter((s) =>
            effectiveAmenityKeys.every((k) => hasAmenity(s, k))
          );
        }
        if (wantsPetFriendly) {
          matches = matches.filter((s) => petPolicyFromRules(s) === "allowed");
        }
        if (unitType) {
          matches = matches.filter((s) =>
            String(s.name || "").toLowerCase().includes(unitType)
          );
        }

        if (matches.length === 0) {
          const parts = [];
          if (effectiveAmenityKeys.length) parts.push(effectiveAmenityKeys.join(" + "));
          if (wantsPetFriendly) parts.push("pet‑friendly");
          if (unitType) parts.push(unitType);
          const label = parts.length ? parts.join(", ") : "that";
          return res.json({
            reply: `I didn’t find any units matching ${label}.`,
          });
        }

        const lines = matches
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map((s) => `• [${s.name}](${s.bookingUrl})`)
          .join("\n");

        const labelParts = [];
        if (effectiveAmenityKeys.length) labelParts.push(effectiveAmenityKeys.join(" + "));
        if (wantsPetFriendly) labelParts.push("pet‑friendly");
        if (unitType) labelParts.push(unitType);
        const label = labelParts.length ? ` (${labelParts.join(", ")})` : "";

        return res.json({
          reply: `Units with${label}:\n\n${lines}`,
        });
        }
      }
    }

    // If we still don't have a listing, try inventory-wide policy answer
    if (!listingId) {
      let policyIntent = policyIntentRaw;
      if (
        !policyIntent &&
        !followupAmenityKey &&
        looksLikeFollowupQuestion(userMessage) &&
        session?.lastPolicyIntent
      ) {
        policyIntent = session.lastPolicyIntent;
      }
      if (policyIntent) {
        metrics.policy_queries += 1;
        setSession(sessionId, { lastPolicyIntent: policyIntent });
        const results = await mapWithConcurrency(
          listings,
          INVENTORY_AVAILABILITY_CONCURRENCY,
          async (l) => {
            try {
              const listing = await fetchListingByIdCached(l.id, accessToken);
              const safe = toSafeListingFacts(listing, { audience: "postbooking" });
              return policyAnswerFromHouseRules(safe, policyIntent);
            } catch (err) {
              console.error("Inventory policy error:", err);
              return null;
            }
          }
        );

        const nonNull = results.filter(Boolean);
        if (nonNull.length > 0) {
          const counts = new Map();
          for (const ans of nonNull) {
            counts.set(ans, (counts.get(ans) || 0) + 1);
          }
          const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
          const general = top ? top[0] : null;
          if (general) {
            let generalized = general;
            if (!listingId) {
              generalized = generalized.replace(/this property/i, "most units");
              if (generalized === general) {
                generalized = generalized.replace(/at this property/i, "here");
              }
            }
            logEvent("policy_response", {
              sessionId: sessionId || "anonymous",
              listingId: null,
              policy: policyIntent,
            });
            const uniform = nonNull.length === listings.length && counts.size === 1;
            if (uniform) {
              return res.json({ reply: generalized });
            }
            if (policyIntent === "pets") {
              return res.json({
                reply:
                  `${generalized}\n\n` +
                  "Pet policies can vary by unit. Do you have a specific unit you'd like me to check, " +
                  "or would you like a list of pet‑friendly units?",
              });
            }
            return res.json({
              reply:
                `${generalized}\n\n` +
                "Policies can vary by unit. Do you have a specific unit you'd like me to check?",
            });
          }
        }
      }
    }

    // If we still don't have a listing, ask + suggestions
    if (!listingId) {
      const suggestions = suggestUnits(userMessage, listings);
      const suggestionText =
        suggestions.length > 0
          ? suggestions.map((s) => `• ${s.name}`).join("\n")
          : "• (No close matches found)";

      return res.json({
        reply:
          "Which unit are you asking about?\n\n" +
          "I can give an exact answer once I know the unit.\n\n" +
          "Possible matches:\n" +
          suggestionText,
      });
    }

    const wantsNextAvailableWeekend =
      listingId &&
      /\bnext available weekend\b|\bnext weekend available\b|\bwhen.*next weekend\b|\bnext weekend\b.*\bavailable\b/i.test(
        userMessage
      );

    // If availability question AND user gave dates -> answer from Hostaway truth
    const availabilityAsked =
      isAvailabilityQuestion(userMessage) ||
      intent.intent === "availability" ||
      session?.lastIntent === "availability";
    if (availabilityAsked) metrics.availability_queries += 1;
    let dates = extractDates(userMessage);
    if (
      !dates &&
      (isAvailabilityQuestion(userMessage) ||
        intent.intent === "availability" ||
        session?.lastIntent === "availability") &&
      session?.dates
    ) {
      if (looksLikeSameDatesReference(userMessage)) {
        dates = session.dates;
      }
    }
    if (wantsNextAvailableWeekend) {
      const start = getTodayIso();
      const end = addDays(start, 180);
      const days = await fetchCalendarRange(listingId, start, end, accessToken);
      const next = findNextAvailableWeekend(days, start);
      if (next) {
        const listing = await fetchListingById(listingId, accessToken);
        const safe = toSafeListingFacts(listing, { audience: "postbooking" });
        const bookUrl = `${safe.bookingUrl}?start=${next.start}&end=${next.end}`;
        let note = "";
        if (next.minStay && next.minStay > 2) {
          note = ` (requires a ${next.minStay}-night minimum)`;
        }
        let suggestLine = "";
        if (next.suggestedEnd) {
          const suggestUrl = `${safe.bookingUrl}?start=${next.start}&end=${next.suggestedEnd}`;
          suggestLine = `\n\nSuggested stay: ${next.start} to ${next.suggestedEnd}\nBook now: ${suggestUrl}`;
        }
        return res.json({
          reply:
            `Next available weekend is ${next.start} to ${next.end}${note}.\n\nBook now: ${bookUrl}` +
            suggestLine +
            memoryNote,
          });
      }
      return res.json({
        reply:
          "I couldn’t find an available weekend in the next few months. " +
          "If you have specific dates in mind, I can check those." +
          memoryNote,
      });
    }
    if (
      dates &&
      (isAvailabilityQuestion(userMessage) ||
        intent.intent === "availability" ||
        session?.lastIntent === "availability")
    ) {
      setSession(sessionId, { dates });
      const endForCalendar = addDays(dates.end, -1);

      if (endForCalendar < dates.start) {
        return res.json({
          reply: "End date must be after start date (checkout after check-in).",
        });
      }

      const days = await fetchCalendarRange(listingId, dates.start, endForCalendar, accessToken);
      const data = summarizeAvailabilityWithAlternatives(days, dates.start, dates.end);

      // Fetch safe listing to get stable bookingUrl
      const listing = await fetchListingById(listingId, accessToken);
      const safe = toSafeListingFacts(listing, { audience: "postbooking" });

      // Only include dates when the requested range is actually available
      let bookUrl = safe.bookingUrl;
      if (data?.available === true && dates?.start && dates?.end) {
        const sep = safe.bookingUrl.includes("?") ? "&" : "?";
        bookUrl = `${safe.bookingUrl}${sep}start=${dates.start}&end=${dates.end}`;
      }

      const timeLine = formatCheckTimes(safe);
      const minStayLine =
        safe.minNights != null
          ? `Minimum stay: ${safe.minNights} ${safe.minNights === 1 ? "night" : "nights"}.`
          : "";
      const extraLines = [timeLine, minStayLine].filter(Boolean).join("\n");

      const bookingLine = bookUrl ? `\n\nBook now: ${bookUrl}` : "";
      logEvent("availability_response", {
        sessionId: sessionId || "anonymous",
        listingId,
        start: dates.start,
        end: dates.end,
        available: Boolean(data?.available),
      });
      return res.json({
        reply: appendFollowupIfMissing(
          (data.message || "Availability check complete.") +
            (extraLines ? `\n${extraLines}` : "") +
            bookingLine +
            memoryNote,
          "Would you like me to check other dates?"
        ),
      });
    }

    // Listing-level amenity questions
    const listingAmenityKey = listingId ? detectAmenityKeyLoose(userMessage) : null;
    if (listingId && listingAmenityKey) {
      const listing = await fetchListingById(listingId, accessToken);
      const safe = toSafeListingFacts(listing, { audience: "postbooking" });
      const has = hasAmenity(safe, listingAmenityKey);
      const reply = has
        ? `Yes — ${safe.name} has a ${listingAmenityKey}.`
        : `No — ${safe.name} does not have a ${listingAmenityKey}.`;
      return res.json({ reply: reply + `\n\nBook now: ${safe.bookingUrl}` + memoryNote });
    }

    // General Q&A: Fetch listing and build safe facts
    const listing = await fetchListingById(listingId, accessToken);
    const safe = toSafeListingFacts(listing, { audience: "postbooking" });
    const safeFactsText = JSON.stringify(safe, null, 2);

    const wantsBookingLink =
      isAvailabilityQuestion(userMessage) ||
      /\b(book|booking|reserve|reservation|availability|available|check[- ]?in|check[- ]?out|checkout|checkin)\b/i.test(
        userMessage
      );

    let policyIntent = detectPolicyIntent(userMessage);
    if (!policyIntent && looksLikeFollowupQuestion(userMessage) && session?.lastPolicyIntent) {
      policyIntent = session.lastPolicyIntent;
    }
    if (policyIntent) {
      metrics.policy_queries += 1;
      setSession(sessionId, { lastPolicyIntent: policyIntent });
      const fromRules = policyAnswerFromHouseRules(safe, policyIntent);
      const fromFacts = policyAnswerFromFacts(safe, policyIntent);
      const policyReply = fromRules || fromFacts;
      if (policyReply) {
        const bookingLine =
          safe.bookingUrl && wantsBookingLink ? `\n\nBook now: ${safe.bookingUrl}` : "";
        logEvent("policy_response", {
          sessionId: sessionId || "anonymous",
          listingId,
          policy: policyIntent,
        });
        res.json({
          reply: appendFollowupIfMissing(
            policyReply + bookingLine + memoryNote,
            "Want me to check a different unit?"
          ),
        });
        return;
      }
    }

    if (looksLikeSummaryRequest(userMessage) || intent.intent === "summary") {
      const bookingLine =
        safe.bookingUrl && wantsBookingLink ? `\n\nBook now: ${safe.bookingUrl}` : "";
      setSession(sessionId, { lastMessage: userMessage });
      res.json({ reply: buildSafeSummary(safe) + bookingLine + memoryNote });
      return;
    }

    let aiText = "";
    try {
      const aiResponse = await client.responses.create({
        model: INTENT_MODEL,
        instructions:
          "You are a customer service assistant for AmishCountryLodging.com. " +
          "Write in a warm, conversational tone. " +
          "Only answer using the UNIT DATA provided. " +
          "If the unit is unclear, ask which unit they mean. " +
          "Never reveal passwords, door codes, WiFi credentials, or private instructions. " +
          "If a detail is not present in UNIT DATA, say you don’t have it. " +
          "Include a short, friendly follow‑up question when appropriate. " +
          "Return JSON only in the shape: {\"title\": string?, \"answer\": string, \"bullets\": string[]?, \"followup\": string?}.",
        input: [
          {
            role: "user",
            content: `UNIT DATA:\n${safeFactsText}\n\nQUESTION:\n${userMessage}`,
          },
        ],
      });
      const raw = aiResponse.output_text || "";
      try {
        const parsed = JSON.parse(raw);
        const rendered = renderStructuredReply(parsed);
        aiText = rendered || raw;
      } catch {
        aiText = raw;
      }
    } catch (err) {
      console.error("OpenAI error:", err);
      aiText =
        "Sorry — I’m having trouble answering that right now. Could you try again?";
    }

    const bookingLine =
      safe.bookingUrl && wantsBookingLink ? `\n\nBook now: ${safe.bookingUrl}` : "";
    res.json({ reply: aiText + bookingLine + memoryNote });
    setSession(sessionId, { lastMessage: userMessage });
  } catch (err) {
    console.error(err);
    metrics.errors_total += 1;
    logEvent("error", { message: String(err?.message || err) });
    res.status(500).json({ reply: "Something went wrong on the server." });
  }
});

/* ---------- FEEDBACK (thumbs-only; no numeric rating) ---------- */
app.post("/feedback", async (req, res) => {
  try {
    const { testerName, pageUrl, listingId, userMessage, botReply, thumbs, feedback } = req.body;

    if (!userMessage || !botReply) {
      return res.status(400).json({
        ok: false,
        error: "Missing userMessage or botReply",
      });
    }

    await db.query(
      `
      insert into chat_feedback
        (tester_name, page_url, listing_id, user_message, bot_reply, rating, thumbs, feedback)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        testerName || null,
        pageUrl || null,
        listingId || null,
        userMessage,
        botReply,
        null, // rating (thumbs-only)
        thumbs || null,
        feedback || null,
      ]
    ).catch(async (err) => {
      // Backward compatibility if the "rating" column was removed.
      if (err?.code === "42703") {
        await db.query(
          `
          insert into chat_feedback
            (tester_name, page_url, listing_id, user_message, bot_reply, thumbs, feedback)
          values
            ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            testerName || null,
            pageUrl || null,
            listingId || null,
            userMessage,
            botReply,
            thumbs || null,
            feedback || null,
          ]
        );
        return;
      }
      throw err;
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Feedback error:", err);
    res.status(500).json({ ok: false, error: "Failed to save feedback" });
  }
});

/* ---------- FEEDBACK (RECENT) ---------- */
/**
 * Example:
 *   /feedback/recent
 *   /feedback/recent?limit=50
 *   /feedback/recent?limit=50&thumbs=up
 *   /feedback/recent?listingId=214120
 *   /feedback/recent?tester=Jeff
 */
app.get("/feedback/recent", async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const thumbs = (req.query.thumbs || "").toString().trim().toLowerCase(); // "up" or "down" or ""
    const listingIdRaw = (req.query.listingId || "").toString().trim();
    const tester = (req.query.tester || "").toString().trim();

    const where = [];
    const params = [];
    let i = 1;

    if (thumbs === "up" || thumbs === "down") {
      where.push(`thumbs = $${i++}`);
      params.push(thumbs);
    }

    if (listingIdRaw && !Number.isNaN(Number(listingIdRaw))) {
      where.push(`listing_id = $${i++}`);
      params.push(Number(listingIdRaw));
    }

    if (tester) {
      where.push(`tester_name ILIKE $${i++}`);
      params.push(`%${tester}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // NOTE: This query works whether or not you still have a "rating" column.
    const sql = `
      SELECT
        id,
        created_at,
        tester_name,
        page_url,
        listing_id,
        user_message,
        bot_reply,
        thumbs,
        feedback
      FROM chat_feedback
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${i++}
    `;

    params.push(limit);

    const result = await db.query(sql, params);
    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    console.error("Recent feedback error:", err);
    res.status(500).json({ ok: false, error: "Failed to load feedback" });
  }
});

/* ===============================
   START SERVER
================================ */
function startServer() {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export { app, startServer };
