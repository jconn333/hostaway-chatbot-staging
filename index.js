// index.js
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { getSandboxHtml } from "./src/ui.js";
import {
  isAvailabilityQuestion,
  isInventoryAvailabilityQuestion,
  summarizeAvailabilityWithAlternatives,
  findAlternativeStays,
  addDays,
  extractDates,
  getTodayIso,
  findNextAvailableWeekend,
  findAvailableWeekendsInRange,
} from "./src/lib/availability.js";
import {
  getHostawayAccessToken,
  getListingsCached,
  toSafeListingFacts,
  fetchListingById,
  fetchCalendarRange,
  fetchListingByIdCached,
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

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("X-Code-Version", CODE_VERSION);
  next();
});

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INVENTORY_AVAILABILITY_CONCURRENCY = 5;
const INVENTORY_AVAILABILITY_MAX = 20;
const INTENT_MODEL = process.env.INTENT_MODEL || "gpt-4o-mini";
const ANSWER_MODEL = process.env.ANSWER_MODEL || "gpt-4o-mini";
const ENABLE_TEST_MODE =
  String(
    process.env.ENABLE_TEST_MODE ??
      (process.env.NODE_ENV === "production" ? "false" : "true")
  ).toLowerCase() === "true";

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessionStore = new Map(); // sessionId -> { listingId, dates, lastMessage, lastIntent, lastPolicyIntent, lastAmenityKey, constraints, updatedAt }

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {}
  return "0.0.0";
}

function detectCommitShaShort() {
  const fromEnv =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "";
  if (fromEnv) return String(fromEnv).trim().slice(0, 7);
  try {
    return String(execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }))
      .trim()
      .slice(0, 7);
  } catch {}
  return "local";
}

function resolveCodeVersion() {
  if (process.env.APP_VERSION && String(process.env.APP_VERSION).trim()) {
    return String(process.env.APP_VERSION).trim();
  }
  const pkg = readPackageVersion();
  const sha = detectCommitShaShort();
  return `${pkg}+${sha}`;
}

const CODE_VERSION = resolveCodeVersion();

const metrics = {
  requests_total: 0,
  errors_total: 0,
  intents: {},
  intent_fallbacks: 0,
  availability_queries: 0,
  policy_queries: 0,
  recommendation_queries: 0,
  booking_link_replies: 0,
};

const eventLog = [];
const EVENT_LOG_MAX = 3000;

function logEvent(type, data = {}) {
  const base = { ts: new Date().toISOString(), type };
  const evt = { ...base, ...data };
  eventLog.push(evt);
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
  console.log(JSON.stringify(evt));
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
  if (
    /^(?:(?:yes|yeah|yep|sure)\s+)?(what about|how about|and what|and how|and|also|ok|okay|so|then)\b/.test(
      msg
    )
  ) {
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

function looksLikeInventoryWidePolicyRequest(message) {
  const msg = (message || "").toLowerCase();
  return (
    /\b(which|what|list|show|any)\b/.test(msg) &&
    /\b(units|cabins|suites|lodges|properties|listings|ones)\b/.test(msg)
  );
}

function personalizePolicyReply(policyReply, safe, policyIntent) {
  const name = safe?.name || "This unit";
  if (!policyReply) return policyReply;

  if (policyIntent === "pets") {
    if (/pets are allowed/i.test(policyReply)) {
      return `Yes — ${name} is pet-friendly (pets are allowed).`;
    }
    if (/pets aren[’']t allowed|pets are not allowed/i.test(policyReply)) {
      return `No — ${name} is not pet-friendly (pets are not allowed).`;
    }
  }

  if (policyIntent === "checkin") {
    return policyReply.replace(/^Check.?in is/i, `Check-in for ${name} is`);
  }
  if (policyIntent === "checkout") {
    return policyReply.replace(/^Check.?out is/i, `Check-out for ${name} is`);
  }

  return policyReply.replace(/this property/gi, name);
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

function hasConcreteListingCue(message) {
  const msg = String(message || "").toLowerCase();
  if (
    /\b(treehouse|cabin|suite|lodge|cottage|unit|listing)\s*#?\s*\d+\b/.test(msg)
  ) {
    return true;
  }
  if (/\b(red fern|water lily|joy lodge|grace lodge|hope lodge)\b/.test(msg)) {
    return true;
  }
  return false;
}

function normalizeUserMessage(message) {
  return String(message || "")
    .replace(/\bhottub(s)?\b/gi, "hot tub$1")
    .replace(/\bavaiable\b/gi, "available")
    .replace(/\bavailble\b/gi, "available")
    .replace(/\bweekened\b/gi, "weekend")
    .replace(/\bwknd\b/gi, "weekend")
    .replace(/\bnxt\b/gi, "next")
    .replace(/\bpet[- ]?freindly\b/gi, "pet-friendly")
    .replace(/\bcheckin\b/gi, "check in")
    .replace(/\bcheckout\b/gi, "check out");
}

function isoToShortDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || "");
  return `${m[2]}-${m[3]}-${m[1].slice(-2)}`;
}

function formatReplyDatesForDisplay(text) {
  const raw = String(text || "");
  return raw.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (match, iso, offset, full) => {
    const prev = full[offset - 1] || "";
    const next = full[offset + match.length] || "";
    // Keep URL query/path timestamps intact.
    if (prev === "=" || prev === "/" || prev === "-" || next === "T") return match;
    return isoToShortDate(iso);
  });
}

function monthQueryToRange(message, timeZone = "America/New_York") {
  const msg = String(message || "").toLowerCase();
  const months = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  const m = msg.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/
  );
  if (!m) return null;

  const month = months[m[1]];
  if (!month) return null;

  const todayIso = getTodayIso(timeZone);
  const [todayYear, todayMonth] = todayIso.split("-").map(Number);
  const year = month < todayMonth ? todayYear + 1 : todayYear;
  const mm = String(month).padStart(2, "0");
  const start = `${year}-${mm}-01`;
  const monthEndDate = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  const end = `${monthEndDate.getUTCFullYear()}-${String(monthEndDate.getUTCMonth() + 1).padStart(2, "0")}-${String(
    monthEndDate.getUTCDate()
  ).padStart(2, "0")}`;
  const rawName = String(m[1] || "");
  const monthName = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
  return { start, end, monthName };
}

function wantsEvidenceLine(message) {
  const msg = (message || "").toLowerCase();
  return /\b(source|evidence|how sure|confidence|how do you know|why)\b/.test(msg);
}

function buildEvidenceLine({ confidence = "high", source = "" } = {}) {
  if (!source) return "";
  return `\n\n(Confidence: ${confidence}. Source: ${source}.)`;
}

function nightsBetween(start, end) {
  if (!start || !end) return 1;
  const [ys, ms, ds] = String(start).split("-").map(Number);
  const [ye, me, de] = String(end).split("-").map(Number);
  const a = Date.UTC(ys, (ms || 1) - 1, ds || 1);
  const b = Date.UTC(ye, (me || 1) - 1, de || 1);
  const nights = Math.round((b - a) / 86400000);
  return Math.max(1, Math.min(5, nights || 1));
}

function detectSessionRecallRequest(message) {
  const msg = (message || "").toLowerCase();
  return (
    /\bwhat were my\b.*\b(requirements|constraints|preferences)\b/.test(msg) ||
    /\boriginal requirements\b/.test(msg) ||
    /\bbefore (that|the) change\b/.test(msg) ||
    /\bbefore adding\b/.test(msg) ||
    /\bbefore i added\b/.test(msg) ||
    /\bbefore i changed\b/.test(msg) ||
    /\bbefore i said\b/.test(msg)
  );
}

function detectInventoryConstraintRequest(message) {
  const msg = (message || "").toLowerCase();
  return (
    /\b(best options?|top options?|what options?|which options?|recommend(ation|ations)?|suggest)\b/.test(msg) ||
    /\bmeeting all requirements\b/.test(msg) ||
    /\bbased on (those|my|the) (exact )?(requirements|constraints|preferences)\b/.test(msg) ||
    /\bwhat improves\b/.test(msg) ||
    /\bfit(s)? (us|me|our group)\b/.test(msg) ||
    /\btop\s*\d+\s*options?\b/.test(msg) ||
    /\btop choices?\b/.test(msg) ||
    /\banything that actually matches\b/.test(msg) ||
    /\bmeet(s)? all (of )?(these|my|our) requirements\b/.test(msg) ||
    /\b(list|show) (a few )?options\b/.test(msg) ||
    /\binclude (bedroom|bathroom) counts?\b/.test(msg)
  );
}

function detectRepairRequest(message) {
  const msg = (message || "").toLowerCase();
  return (
    /\bcontradict(ed|ion)?\b/.test(msg) ||
    /\breconcile\b/.test(msg) ||
    /\bcorrect (any )?(earlier|prior) (mistake|response)\b/.test(msg) ||
    /\brepair that\b/.test(msg) ||
    /\bwrong format\b/.test(msg)
  );
}

function extractRememberedRequirements(message) {
  const text = String(message || "").trim();
  const m = text.match(/\bremember(?: these requirements| this)?\s*:\s*(.+)$/i);
  if (m && m[1]) return m[1].trim();
  if (/^remember\b/i.test(text)) return text.replace(/^remember\b[:\s-]*/i, "").trim();
  return null;
}

function parseConstraintSignals(message) {
  const msg = String(message || "").toLowerCase();
  const capacity = extractCapacityQuery(message);
  const dates = extractDates(message);
  const amenityKeys = detectAmenityKeys(msg);
  const explicitAmenity = detectAmenityQuery(msg);
  if (explicitAmenity && !amenityKeys.includes(explicitAmenity)) amenityKeys.push(explicitAmenity);

  const priorities = {
    wifi: /\b(wifi|wi[- ]?fi|internet)\b/.test(msg),
    privacy: /\bprivacy|private|quiet\b/.test(msg),
    budget: /\bbudget|affordable|low cost|cheap|cost\b/.test(msg),
    accessibility: /\baccessib|wheelchair|mobility\b/.test(msg),
    solo: /\bsolo\b/.test(msg),
    lastMinute: /\blast[- ]?minute|tonight|tomorrow\b/.test(msg),
  };

  const explicitRemember =
    /\bremember this\b|\bsave this\b|\bnote this\b|\bkeep this\b/.test(msg);
  const rememberedText = extractRememberedRequirements(message);

  const data = {
    capacity: capacity || null,
    dates: dates || null,
    unitType: detectUnitType(msg) || null,
    wantsPetFriendly: detectPetFriendlyFilter(msg) || null,
    amenityKeys: amenityKeys.length ? amenityKeys : null,
    priorities,
    explicitRemember,
    rememberedText,
  };

  const hasAny =
    Boolean(data.capacity) ||
    Boolean(data.dates) ||
    Boolean(data.unitType) ||
    Boolean(data.wantsPetFriendly) ||
    Boolean(data.amenityKeys) ||
    Object.values(priorities).some(Boolean) ||
    Boolean(data.rememberedText);

  return hasAny ? data : null;
}

function mergeConstraints(prev, patch) {
  const base = prev && typeof prev === "object" ? prev : {};
  const next = { ...base };
  if (patch?.capacity) next.capacity = { ...(base.capacity || {}), ...patch.capacity };
  if (patch?.dates) next.dates = patch.dates;
  if (patch?.unitType) next.unitType = patch.unitType;
  if (typeof patch?.wantsPetFriendly === "boolean") next.wantsPetFriendly = patch.wantsPetFriendly;
  if (Array.isArray(patch?.amenityKeys) && patch.amenityKeys.length) {
    const merged = new Set([...(base.amenityKeys || []), ...patch.amenityKeys]);
    next.amenityKeys = Array.from(merged);
  }
  const pri = { ...(base.priorities || {}) };
  if (patch?.priorities) {
    for (const [k, v] of Object.entries(patch.priorities)) {
      if (v) pri[k] = true;
    }
  }
  next.priorities = pri;
  if (patch?.rememberedText) next.rememberedText = String(patch.rememberedText);
  return next;
}

function formatConstraintsSummaryLine(constraints) {
  if (!constraints) return "I don’t have saved requirements yet.";
  const bits = [];
  if (constraints.rememberedText) bits.push(constraints.rememberedText);
  if (constraints.capacity?.sleeps) bits.push(`${constraints.capacity.sleeps} guests`);
  if (constraints.capacity?.bedrooms) bits.push(`${constraints.capacity.bedrooms}+ bedrooms`);
  if (constraints.capacity?.bathrooms) bits.push(`${constraints.capacity.bathrooms}+ bathrooms`);
  if (constraints.capacity?.beds) bits.push(`${constraints.capacity.beds}+ beds`);
  if (constraints.dates?.start && constraints.dates?.end) {
    bits.push(`dates ${constraints.dates.start} to ${constraints.dates.end}`);
  }
  if (constraints.unitType) bits.push(constraints.unitType);
  if (constraints.wantsPetFriendly) bits.push("pet-friendly");
  if (Array.isArray(constraints.amenityKeys) && constraints.amenityKeys.length) {
    bits.push(`amenities: ${constraints.amenityKeys.join(", ")}`);
  }
  if (constraints.priorities?.wifi) bits.push("priority: wifi");
  if (constraints.priorities?.privacy) bits.push("priority: privacy");
  if (constraints.priorities?.budget) bits.push("priority: budget");
  if (constraints.priorities?.accessibility) bits.push("priority: accessibility");
  if (constraints.priorities?.solo) bits.push("solo traveler");
  if (constraints.priorities?.lastMinute) bits.push("last-minute timing");
  return bits.length ? bits.join(", ") : "I don’t have saved requirements yet.";
}

function formatConstraintsBullets(constraints) {
  const line = formatConstraintsSummaryLine(constraints);
  if (!line || line === "I don’t have saved requirements yet.") return [];
  return line.split(", ").map((x) => `• ${x}`);
}

function buildConstraintFilterMeta(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  return {
    amenityKeys: Array.isArray(constraints.amenityKeys) ? constraints.amenityKeys : [],
    unitType: constraints.unitType || null,
    petFriendly: Boolean(constraints.wantsPetFriendly),
    capacity: constraints.capacity || null,
    dates: constraints.dates || null,
  };
}

function detectRecommendationIntent(message) {
  const msg = (message || "").toLowerCase();
  return /\b(recommend|suggest|best option|best unit|which should i|help me choose|help me book|find me|top choices?|top \d+ options?)\b/.test(
    msg
  );
}

function isDirectBookingRequest(message) {
  const msg = (message || "").toLowerCase();
  return /\b(book it|book this|book that|reserve it|reserve this|reserve that|book now)\b/.test(
    msg
  );
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

function isCapacityFactQuestion(message) {
  const msg = (message || "").toLowerCase();
  return (
    /\bhow many\b.*\b(people|guests?|persons?)\b/.test(msg) ||
    /\b(people|guests?|persons?)\b.*\b(sleep|sleeps)\b/.test(msg) ||
    /\bhow many\b.*\b(bedrooms?|bathrooms?|beds?)\b/.test(msg) ||
    /\b(sleeps?|bedrooms?|bathrooms?|beds?)\b/.test(msg)
  );
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

function heuristicIntent(message, policyIntent = null) {
  if (isInventoryAvailabilityQuestion(message)) return "inventory_availability";
  if (isAvailabilityQuestion(message)) return "availability";
  if (detectAmenityQuery(message) || isInventoryQuery(message)) return "amenity_inventory";
  if (policyIntent) return "policy";
  if (looksLikeProximityQuery(message)) return "compare";
  if (looksLikeSummaryRequest(message)) return "summary";
  return "general";
}

function normalizePlannerOutput(parsed, message, policyIntent) {
  const intentAllow = new Set([
    "availability",
    "inventory_availability",
    "amenity_inventory",
    "policy",
    "compare",
    "summary",
    "general",
  ]);
  const scope = ["single_unit", "inventory"].includes(parsed?.scope)
    ? parsed.scope
    : "single_unit";
  const intent = intentAllow.has(String(parsed?.intent || ""))
    ? String(parsed.intent)
    : heuristicIntent(message, policyIntent);
  const confidence = Number(parsed?.confidence ?? 0);
  const guestCount = Number(parsed?.guest_count);
  const needsClarification = Boolean(parsed?.needs_clarification);
  const clarificationQuestionRaw = parsed?.clarification_question;
  const clarificationQuestion =
    typeof clarificationQuestionRaw === "string" && clarificationQuestionRaw.trim()
      ? clarificationQuestionRaw.trim()
      : null;
  return {
    intent,
    scope,
    use_session_unit: Boolean(parsed?.use_session_unit),
    policy_topic: parsed?.policy_topic ? String(parsed.policy_topic) : null,
    unit_type: parsed?.unit_type ? String(parsed.unit_type).toLowerCase() : null,
    guest_count: Number.isFinite(guestCount) && guestCount > 0 ? guestCount : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    needs_clarification: needsClarification,
    clarification_question: clarificationQuestion,
  };
}

async function planTurn(message, { sessionHasListing = false } = {}) {
  const policyIntent = detectPolicyIntent(message);
  const fallback = {
    intent: heuristicIntent(message, policyIntent),
    scope: isInventoryQuery(message) || isInventoryAvailabilityQuestion(message) ? "inventory" : "single_unit",
    use_session_unit: sessionHasListing && looksLikeFollowupQuestion(message),
    policy_topic: policyIntent,
    unit_type: detectUnitType(message),
    guest_count: extractCapacityQuery(message)?.sleeps || null,
    confidence: 0,
    needs_clarification: false,
    clarification_question: null,
  };

  try {
    const resp = await client.responses.create({
      model: INTENT_MODEL,
      instructions:
        "Return JSON only. You are the intent planner for a lodging chatbot. " +
        "Infer user goal, scope, and key slots for deterministic tool execution. " +
        "Schema: {" +
        "\"intent\":\"availability|inventory_availability|amenity_inventory|policy|compare|summary|general\"," +
        "\"scope\":\"single_unit|inventory\"," +
        "\"use_session_unit\":boolean," +
        "\"policy_topic\":\"pets|smoking|parties|noise|checkin|checkout|cancellation|null\"," +
        "\"unit_type\":\"treehouse|cabin|suite|lodge|cottage|tiny home|null\"," +
        "\"guest_count\":number|null," +
        "\"confidence\":number," +
        "\"needs_clarification\":boolean," +
        "\"clarification_question\":string|null" +
        "}. " +
        "Rules: " +
        "1) Broad asks like 'any units', 'which units', capacity-only group asks, and amenity list/filter asks are inventory scope. " +
        "2) Pronoun follow-ups ('it', 'that one', 'what about') should set use_session_unit=true when sessionHasListing=true unless user asks inventory-wide. " +
        "3) Prefer availability intent only when dates/availability semantics are present; otherwise keep facts/policy/summary intents. " +
        "4) If uncertain, lower confidence instead of guessing.",
      input: [
        {
          role: "user",
          content: `sessionHasListing=${sessionHasListing ? "true" : "false"}\nmessage=${String(
            message || ""
          )}`,
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
    return normalizePlannerOutput(parsed, message, policyIntent);
  } catch (err) {
    console.error("Planner error:", err);
    return fallback;
  }
}

function chooseIntentFromPlannerAndClassifier(planner, classifier, message, policyIntent) {
  const plannerIntent = planner?.intent || "general";
  const plannerConfidence = Number(planner?.confidence ?? 0);
  const classifierIntent = classifier?.intent || "general";
  const classifierConfidence = Number(classifier?.confidence ?? 0);
  const heuristic = heuristicIntent(message, policyIntent);

  // Trust planner when it's confident and specific; otherwise use classifier.
  if (plannerConfidence >= 0.7 && plannerIntent !== "general") {
    return { intent: plannerIntent, confidence: plannerConfidence, source: "planner" };
  }

  // Classifier remains the safety net for ambiguous planner outputs.
  if (classifierConfidence > 0) {
    return { intent: classifierIntent, confidence: classifierConfidence, source: "classifier" };
  }

  return { intent: heuristic, confidence: 0, source: "heuristic" };
}

function buildValidatedExecutionPlan({ message, planner, classifier, sessionHasListing = false } = {}) {
  const policyIntent = planner?.policy_topic || detectPolicyIntent(message);
  const chosen = chooseIntentFromPlannerAndClassifier(
    planner || {},
    classifier || {},
    message,
    policyIntent
  );
  const proposedIntent = chosen.intent || "general";
  const confidence = Number(chosen.confidence ?? 0);
  const lowConfidence = Number.isFinite(confidence) && confidence > 0 && confidence < 0.45;
  const heuristicSupports =
    isInventoryAvailabilityQuestion(message) ||
    isInventoryQuery(message) ||
    isAvailabilityQuestion(message) ||
    Boolean(policyIntent) ||
    looksLikeProximityQuery(message) ||
    looksLikeSummaryRequest(message) ||
    Boolean(detectAmenityQuery(message));

  let validatedIntent =
    lowConfidence &&
    ["availability", "inventory_availability", "amenity_inventory", "policy", "compare", "summary"].includes(
      proposedIntent
    ) &&
    !heuristicSupports
      ? "general"
      : proposedIntent;

  if (
    validatedIntent === "inventory_availability" &&
    isPetFriendlyListRequest(message) &&
    !extractDates(message)
  ) {
    validatedIntent = "amenity_inventory";
  }

  const plannerInventoryScope = planner?.scope === "inventory";
  const inferredInventoryScope =
    plannerInventoryScope || isInventoryQuery(message) || isInventoryAvailabilityQuestion(message);
  const useSessionUnit = Boolean(planner?.use_session_unit) && Boolean(sessionHasListing);
  const guestCount = Number(planner?.guest_count);
  const unitType = planner?.unit_type ? String(planner.unit_type).toLowerCase() : detectUnitType(message);
  const plannerNeedsClarification = Boolean(planner?.needs_clarification);
  const plannerClarificationQuestion =
    typeof planner?.clarification_question === "string" ? planner.clarification_question.trim() : "";
  const missingCoreSignal =
    !isAvailabilityQuestion(message) &&
    !isInventoryAvailabilityQuestion(message) &&
    !isInventoryQuery(message) &&
    !Boolean(policyIntent) &&
    !looksLikeSummaryRequest(message) &&
    !looksLikeProximityQuery(message) &&
    !Boolean(detectAmenityQuery(message));
  const explicitListingCue = hasConcreteListingCue(message);
  const shouldClarify =
    (plannerNeedsClarification && !explicitListingCue) ||
    (lowConfidence && missingCoreSignal && !sessionHasListing && !explicitListingCue);
  const clarificationQuestion =
    plannerClarificationQuestion ||
    (sessionHasListing
      ? "Do you want me to keep using the same unit, or switch to a different one?"
      : "Do you want availability, unit details, or a list of matching units?");

  return {
    proposedIntent,
    validatedIntent,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    lowConfidence,
    intentSource: chosen.source || "heuristic",
    scope: inferredInventoryScope ? "inventory" : "single_unit",
    useSessionUnit,
    policyIntent,
    unitType: unitType || null,
    guestCount: Number.isFinite(guestCount) && guestCount > 0 ? guestCount : null,
    shouldClarify,
    clarificationQuestion,
  };
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

function applyReplyVoice(reply, { intent, policyIntent, userMessage } = {}) {
  const text = String(reply || "").trim();
  if (!text) return text;

  // Keep high-signal disambiguation prompts untouched.
  if (/^Which unit are you asking about\?/i.test(text)) return text;

  const hasFollowup = /\n\n(?:Would you like|Want me to|Do you want|Could you)/i.test(text);
  const availabilityIntent = intent === "availability" || isAvailabilityQuestion(userMessage || "");
  const policyLike = intent === "policy" || Boolean(policyIntent);

  if (/^(Yes|No)\s*[—-]/i.test(text) && !hasFollowup) {
    const followup = availabilityIntent
      ? "Would you like me to check other dates?"
      : policyLike
        ? "Want me to check another unit?"
        : "Want me to check anything else?";
    return appendFollowupIfMissing(text, followup);
  }

  if (/^I (didn’t|don't) (find|currently see)\b/i.test(text) && !hasFollowup) {
    const followup = availabilityIntent
      ? "Want me to try different dates?"
      : policyLike
        ? "Want me to check a specific unit?"
        : "Want me to try a different unit?";
    return appendFollowupIfMissing(text, followup);
  }

  return text;
}

function inferReplyType(route, reply = "") {
  const r = String(route || "").toLowerCase();
  if (r.includes("availability")) return "availability";
  if (r.includes("policy")) return "policy";
  if (r.includes("amenity") || r.includes("inventory")) return "inventory";
  if (r.includes("summary")) return "summary";
  const text = String(reply || "").toLowerCase();
  if (/\bavailable|booked|book now|weekend\b/.test(text)) return "availability";
  if (/\bpets?|smoking|parties|check-?in|check-?out|cancellation\b/.test(text)) return "policy";
  if (/\bunits with|available units|pet-friendly units\b/.test(text)) return "inventory";
  return "general";
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
  if (hasOtherAmenities) return false;
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
  const peopleFirst = msg.match(/\b(\d+)\s*(guests?|people|persons?)\b/);
  if (!cap.sleeps && peopleFirst) cap.sleeps = Number(peopleFirst[1]);
  const groupOf = msg.match(/\bgroup\s+of\s+(\d+)\b/);
  if (!cap.sleeps && groupOf) cap.sleeps = Number(groupOf[1]);
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
      const ci = formatCheckInRange(safe.checkInStart, safe.checkInEnd);
      return `Check‑in is ${ci || "available during the standard window for this unit"}.`;
    }
  }
  if (intent === "checkout") {
    if (safe?.checkOut) {
      return `Check‑out is ${formatTime12(safe.checkOut) || safe.checkOut}.`;
    }
  }
  return null;
}

function capacityAnswerFromFacts(safe, message) {
  const msg = (message || "").toLowerCase();
  const unitName = safe?.name || "This unit";

  if (
    /\bhow many\b.*\b(people|guests?|persons?)\b/.test(msg) ||
    /\b(people|guests?|persons?)\b.*\b(sleep|sleeps)\b/.test(msg) ||
    /\bsleeps?\b/.test(msg)
  ) {
    if (safe?.sleeps != null) return `${unitName} sleeps ${safe.sleeps} guests.`;
    return `I don’t have a confirmed guest capacity for ${unitName}.`;
  }

  if (/\bhow many\b.*\bbedrooms?\b|\bbedrooms?\b/.test(msg)) {
    if (safe?.bedrooms != null) return `${unitName} has ${safe.bedrooms} bedrooms.`;
    return `I don’t have a confirmed bedroom count for ${unitName}.`;
  }

  if (/\bhow many\b.*\bbathrooms?\b|\bbathrooms?\b/.test(msg)) {
    if (safe?.bathrooms != null) return `${unitName} has ${safe.bathrooms} bathrooms.`;
    return `I don’t have a confirmed bathroom count for ${unitName}.`;
  }

  if (/\bhow many\b.*\bbeds?\b|\bbeds?\b/.test(msg)) {
    if (safe?.beds != null) return `${unitName} has ${safe.beds} beds.`;
    return `I don’t have a confirmed bed count for ${unitName}.`;
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
    const ci = formatCheckInRange(safe.checkInStart, safe.checkInEnd);
    const co = safe.checkOut ? `Check‑out ${formatTime12(safe.checkOut) || safe.checkOut}` : "";
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
  if (safe.bookingUrl) parts.push(`\nBook now: [${safe.name}](${safe.bookingUrl})`);
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

function formatBookLink(url, label = "Book these dates") {
  if (!url) return "";
  return `[${label}](${url})`;
}

function formatCheckTimes(safe) {
  const ci = formatCheckInRange(safe.checkInStart, safe.checkInEnd);
  const co = safe.checkOut ? `Check‑out ${formatTime12(safe.checkOut) || safe.checkOut}` : "";
  if (!ci && !co) return "";
  return `Check‑in ${ci || "time varies"}${co ? `, ${co}` : ""}.`;
}

function shouldIncludeAvailabilityDetails(message, policyIntentRaw, reasonCode) {
  const msg = String(message || "").toLowerCase();
  const asksTimes =
    policyIntentRaw === "checkin" ||
    policyIntentRaw === "checkout" ||
    /\bcheck[- ]?in\b|\bcheck[- ]?out\b|\bcheckout\b|\barrival\b|\bdeparture\b|\bwhat time\b/.test(msg);
  const asksMinStay =
    /\bminimum\b|\bmin(?:imum)?\s*stay\b|\bmin(?:imum)?\s*nights?\b|\bnight minimum\b|\bhow many nights\b/.test(
      msg
    );
  const blockedByMinStay = reasonCode === "minimum_stay";
  return {
    includeTimes: asksTimes,
    includeMinStay: asksMinStay || blockedByMinStay,
  };
}

function formatCheckInRange(start, end) {
  const s = formatTime12(start);
  const e = formatTime12(end);
  return [s, e].filter(Boolean).join("–");
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

function safeFactsForModel(safe) {
  if (!safe || typeof safe !== "object") return safe;
  const checkInWindow = formatCheckInRange(safe.checkInStart, safe.checkInEnd);
  const checkOut12 = formatTime12(safe.checkOut);
  return {
    ...safe,
    // Keep only human-friendly time fields for model responses.
    checkIn: checkInWindow || null,
    checkOut: checkOut12 || null,
    checkInStart: undefined,
    checkInEnd: undefined,
  };
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

function explainRecommendationReasons(safe, { capacity, amenityKeys, wantsPetFriendly, unitType } = {}) {
  const reasons = [];
  if (capacity?.sleeps && safe.sleeps >= capacity.sleeps) reasons.push(`fits ${capacity.sleeps} guests`);
  if (capacity?.bedrooms && safe.bedrooms >= capacity.bedrooms)
    reasons.push(`${safe.bedrooms} bedrooms`);
  if (capacity?.bathrooms && safe.bathrooms >= capacity.bathrooms)
    reasons.push(`${safe.bathrooms} bathrooms`);
  if (amenityKeys?.length) {
    for (const k of amenityKeys) {
      if (hasAmenity(safe, k)) reasons.push(k);
    }
  }
  if (wantsPetFriendly && petPolicyFromRules(safe) === "allowed") reasons.push("pet-friendly");
  if (unitType && String(safe.name || "").toLowerCase().includes(unitType)) reasons.push(unitType);
  return reasons.slice(0, 3);
}

function scoreRecommendation(safe, { capacity, amenityKeys, wantsPetFriendly, unitType } = {}) {
  let score = 0;
  if (capacity?.sleeps) {
    if ((safe.sleeps || 0) < capacity.sleeps) return -1;
    score += 3;
  }
  if (capacity?.bedrooms) {
    if ((safe.bedrooms || 0) < capacity.bedrooms) return -1;
    score += 2;
  }
  if (capacity?.bathrooms) {
    if ((safe.bathrooms || 0) < capacity.bathrooms) return -1;
    score += 2;
  }
  if (capacity?.beds) {
    if ((safe.beds || 0) < capacity.beds) return -1;
    score += 1;
  }

  if (amenityKeys?.length) {
    let matched = 0;
    for (const key of amenityKeys) {
      if (hasAmenity(safe, key)) {
        score += 2;
        matched += 1;
      }
    }
    if (matched === 0) score -= 1;
  }

  if (wantsPetFriendly) {
    if (petPolicyFromRules(safe) === "allowed") score += 2;
    else score -= 2;
  }

  if (unitType && String(safe.name || "").toLowerCase().includes(unitType)) score += 1;
  return score;
}

function looksLikeAmenityFilterWithoutSupportedAmenity(message) {
  const msg = (message || "").toLowerCase();
  const hasFilterVerb = /\b(with|have|has|featuring|include|includes)\b/.test(msg);
  const hasInventoryWords = /\b(units|cabins|suites|lodges|properties|listings|rentals)\b/.test(msg);
  return hasFilterVerb && hasInventoryWords;
}

function extractUnsupportedAmenityTerms(message) {
  const msg = String(message || "").toLowerCase();
  const m = msg.match(/\b(?:with|have|has|featuring|include|includes)\b(.+)/);
  if (!m) return [];

  const tail = m[1]
    .replace(/\b(for|from|to|on|in|at|next|this|tonight|tomorrow)\b.*$/, "")
    .trim();
  if (!tail) return [];

  const supported =
    /\b(hot tub|hot tubs|hottub|hottubs|jacuzzi|jacuzzis|spa\b|whirlpool|pool|pools|fireplace|fireplaces|sauna|saunas|pet[- ]?friendly|pets?)\b/;
  const ignore = /\b(unit|units|cabin|cabins|suite|suites|lodge|lodges|property|properties|listing|listings|rental|rentals)\b/;

  const parts = tail
    .split(/\s*(?:,| and | or |\/|\+)\s*/)
    .map((s) =>
      s
        .replace(/\b(a|an|the|any)\b/g, "")
        .replace(/[^\w\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);

  const unsupported = [];
  for (const part of parts) {
    if (ignore.test(part)) continue;
    if (supported.test(part)) continue;
    if (/\d/.test(part)) continue;
    unsupported.push(part);
  }
  return unsupported;
}

function buildComparison(primarySafe, secondarySafe, message = "") {
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
  const msg = (message || "").toLowerCase();
  let recommendation = null;
  if (/\b(more beds?|more bedrooms?|bigger|larger|group)\b/.test(msg)) {
    recommendation =
      (primarySafe.bedrooms || 0) >= (secondarySafe.bedrooms || 0) ? primarySafe : secondarySafe;
  } else if (/\b(bath(room)?|more bathrooms?)\b/.test(msg)) {
    recommendation =
      (primarySafe.bathrooms || 0) >= (secondarySafe.bathrooms || 0) ? primarySafe : secondarySafe;
  } else if (/\bhot tub|jacuzzi\b/.test(msg)) {
    const pHas = hasAmenity(primarySafe, "hot tub") || hasAmenity(primarySafe, "jacuzzi");
    const sHas = hasAmenity(secondarySafe, "hot tub") || hasAmenity(secondarySafe, "jacuzzi");
    if (pHas !== sHas) recommendation = pHas ? primarySafe : secondarySafe;
  }
  if (recommendation) {
    lines.push("");
    lines.push(`Recommendation based on your preference: ${recommendation.name}.`);
  }
  lines.push("");
  lines.push(`[${primarySafe.name}](${primarySafe.bookingUrl})`);
  lines.push(`[${secondarySafe.name}](${secondarySafe.bookingUrl})`);
  return lines.join("\n");
}

/* ===============================
   ROUTES
================================ */

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getSandboxHtml());
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    codeVersion: CODE_VERSION,
    uptime_sec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    codeVersion: CODE_VERSION,
    intentModel: INTENT_MODEL,
    answerModel: ANSWER_MODEL,
    llmFirstMode: String(process.env.LLM_FIRST_MODE || "1") === "1",
    testModeEnabled: ENABLE_TEST_MODE,
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", (req, res) => {
  const fallbackRate =
    metrics.requests_total > 0
      ? Number((metrics.intent_fallbacks / metrics.requests_total).toFixed(4))
      : 0;
  res.json({ ...metrics, intent_fallback_rate: fallbackRate });
});

app.get("/analytics/recent", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const type = String(req.query.type || "").trim();
  const rows = type ? eventLog.filter((e) => e.type === type) : eventLog;
  res.json({
    ok: true,
    count: rows.length,
    rows: rows.slice(-limit),
  });
});

app.get("/analytics/summary", (req, res) => {
  const byType = {};
  for (const e of eventLog) byType[e.type] = (byType[e.type] || 0) + 1;
  const mismatches = eventLog.filter((e) => e.type === "qa_mismatch").length;
  const availabilityResponses = eventLog.filter((e) => e.type === "availability_response").length;
  res.json({
    ok: true,
    events_total: eventLog.length,
    byType,
    mismatches,
    availabilityResponses,
    bookingLinkReplies: metrics.booking_link_replies,
  });
});

app.get("/sandbox", (req, res) => {
  res.redirect(302, "/");
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
    const normalizedMessage = normalizeUserMessage(userMessage);
    let listingId = req.body.listingId || null;
    const sessionId = req.body.sessionId || req.headers["x-session-id"] || null;
    const session = sessionId ? getSession(sessionId) : null;
    let constraintsBaseline = session?.constraints?.baseline || null;
    let constraintsCurrent = session?.constraints?.current || null;
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
    const scopedInventoryFromSession =
      session?.scopeMemory?.kind === "inventory"
        ? {
            type: "scoped",
            amenityKeys: Array.isArray(session.scopeMemory?.filters?.amenityKeys)
              ? session.scopeMemory.filters.amenityKeys
              : [],
            unitType: session.scopeMemory?.filters?.unitType || null,
            petFriendly: Boolean(session.scopeMemory?.filters?.petFriendly),
            dates: session.scopeMemory?.dates || null,
          }
        : null;
    const followupInventory =
      looksLikeFollowupQuestion(userMessage) && session?.lastInventory
        ? session.lastInventory
        : looksLikeFollowupQuestion(userMessage)
          ? scopedInventoryFromSession
          : null;
    const directBookingRequest = isDirectBookingRequest(normalizedMessage);
    const llmFirstEnabled = String(process.env.LLM_FIRST_MODE || "1") === "1";
    const plan = llmFirstEnabled
      ? await planTurn(normalizedMessage, {
          sessionHasListing: Boolean(session?.listingId),
        })
      : {
          intent: "general",
          scope:
            isInventoryQuery(normalizedMessage) ||
            isInventoryAvailabilityQuestion(normalizedMessage)
              ? "inventory"
              : "single_unit",
          use_session_unit: Boolean(session?.listingId) && looksLikeFollowupQuestion(userMessage),
          policy_topic: null,
          unit_type: detectUnitType(normalizedMessage),
          guest_count: extractCapacityQuery(normalizedMessage)?.sleeps || null,
          confidence: 0,
        };
    const intent = await classifyIntent(normalizedMessage);
    const executionPlan = buildValidatedExecutionPlan({
      message: normalizedMessage,
      planner: plan,
      classifier: intent,
      sessionHasListing: Boolean(session?.listingId),
    });
    const policyIntentRaw = executionPlan.policyIntent;
    const modelIntent = executionPlan.proposedIntent || "general";
    const modelConfidence = Number(executionPlan.confidence ?? 0);
    const effectiveIntent = executionPlan.validatedIntent || "general";
    const constraintSignals = parseConstraintSignals(normalizedMessage);
    if (constraintSignals) {
      constraintsCurrent = mergeConstraints(constraintsCurrent, constraintSignals);
      if (!constraintsBaseline || constraintSignals.explicitRemember) {
        constraintsBaseline = mergeConstraints(constraintsBaseline, constraintSignals);
      }
      setSession(sessionId, {
        constraints: {
          baseline: constraintsBaseline,
          current: constraintsCurrent,
        },
      });
    }
    const testModeRequested =
      ENABLE_TEST_MODE && String(req.headers["x-test-mode"] || "").trim() === "1";
    let responseRoute = effectiveIntent || "general";
    let responseDates = null;
    let responseInventoryFilters = null;
    let responseReplyType = null;
    const setResponseContext = ({ route, dates, inventoryFilters, replyType } = {}) => {
      if (route) responseRoute = route;
      if (dates) responseDates = dates;
      if (inventoryFilters) responseInventoryFilters = inventoryFilters;
      if (replyType) responseReplyType = replyType;
    };
    const sendReply = (reply, ctx = {}) => {
      setResponseContext(ctx);
      // Persist the resolved route-level intent for follow-up continuity.
      const routedIntent = responseRoute || effectiveIntent || "general";
      let nextScopeMemory = session?.scopeMemory || null;
      if (listingId && !String(routedIntent).includes("inventory")) {
        nextScopeMemory = {
          kind: "single_unit",
          listingId: String(listingId),
          updatedAt: Date.now(),
        };
      } else if (
        String(routedIntent).includes("inventory") ||
        routedIntent === "recommendation" ||
        routedIntent === "inventory_constraints" ||
        routedIntent === "amenity_inventory"
      ) {
        nextScopeMemory = {
          kind: "inventory",
          filters: responseInventoryFilters || session?.scopeMemory?.filters || null,
          dates: responseDates || session?.scopeMemory?.dates || null,
          updatedAt: Date.now(),
        };
      }
      setSession(sessionId, { lastIntent: routedIntent, scopeMemory: nextScopeMemory });
      const voiced = applyReplyVoice(reply, {
        intent: effectiveIntent,
        policyIntent: policyIntentRaw,
        userMessage,
      });
      const displayReply = formatReplyDatesForDisplay(voiced);
      if (/Book now:/i.test(displayReply)) metrics.booking_link_replies += 1;
      if (!testModeRequested) {
        return res.json({ reply: displayReply });
      }
      return res.json({
        reply: displayReply,
        meta: {
          codeVersion: CODE_VERSION,
          intent: effectiveIntent || "general",
          route: responseRoute || effectiveIntent || "general",
          listingId: listingId ? String(listingId) : null,
          sessionListingId: session?.listingId ? String(session.listingId) : null,
          dates: responseDates,
          inventoryFilters: responseInventoryFilters,
          usedSessionMemory: Boolean(memoryNote),
          replyType: responseReplyType || inferReplyType(responseRoute, displayReply),
          plan: {
            proposedIntent: modelIntent,
            validatedIntent: effectiveIntent || "general",
            intentSource: executionPlan.intentSource || "heuristic",
            scope: executionPlan.scope || "single_unit",
            useSessionUnit: Boolean(executionPlan.useSessionUnit),
            confidence: modelConfidence,
          },
        },
      });
    };

    if (detectSessionRecallRequest(normalizedMessage)) {
      const recallMsg = String(normalizedMessage || "").toLowerCase();
      const wantsOriginal =
        /\boriginal requirements\b|\bbefore (that|the) change\b|\bbefore adding\b|\bbefore i added\b|\bbefore i changed\b|\bbefore i said\b/.test(
          recallMsg
        );
      const chosenConstraints = wantsOriginal
        ? constraintsBaseline || constraintsCurrent
        : constraintsCurrent || constraintsBaseline;
      if (chosenConstraints) {
        const bullets = formatConstraintsBullets(chosenConstraints);
        const label = wantsOriginal ? "original requirements" : "saved requirements";
        const msg = bullets.length
          ? `${label.charAt(0).toUpperCase() + label.slice(1)}:\n\n${bullets.join("\n")}`
          : `I don’t have ${label} saved yet.`;
        return sendReply(msg, { route: "session_recall", replyType: "summary" });
      }
    }
    if (detectRepairRequest(normalizedMessage)) {
      const includeAmish = /\bamish\b/i.test(normalizedMessage);
      const includeFormat = /\bformat\b/i.test(normalizedMessage);
      const base =
        "Sorry — because earlier replies used different assumptions (dates/filters), they could conflict; the latest constrained check is the correct one.";
      const amishLine = includeAmish
        ? " This is based on Amish Country Lodging listing data and current availability checks."
        : "";
      const formatLine = includeFormat ? " I’ll keep the format concise and consistent from here." : "";
      return sendReply(`${base}${amishLine}${formatLine}`, {
        route: "session_repair",
        replyType: "summary",
      });
    }
    if (effectiveIntent !== modelIntent) {
      metrics.intent_fallbacks += 1;
      setDebugHeader("IntentFallback", `${modelIntent}->${effectiveIntent}`);
    }
    metrics.intents[effectiveIntent] = (metrics.intents[effectiveIntent] || 0) + 1;
    setSession(sessionId, { lastIntent: effectiveIntent });
    const followupHasContext =
      looksLikeFollowupQuestion(userMessage) &&
      Boolean(
        followupInventory ||
          followupAmenityKey ||
          session?.lastInventory ||
          session?.lastPolicyIntent ||
          session?.lastIntent === "availability"
      );
    if (executionPlan.shouldClarify && !followupHasContext) {
      return sendReply(executionPlan.clarificationQuestion, {
        route: "clarification",
        replyType: "summary",
      });
    }
    setDebugHeader("Intent", effectiveIntent);
    logEvent("chat_request", {
      sessionId: sessionId || "anonymous",
      listingId: listingId || null,
      intent: effectiveIntent,
      modelIntent,
      modelConfidence,
      codeVersion: CODE_VERSION,
    });
    setDebugHeader("PolicyIntent", policyIntentRaw);
    setDebugHeader("IntentSource", executionPlan.intentSource);
    setDebugHeader("PlanScope", executionPlan.scope);
    setDebugHeader("PlanUseSession", executionPlan.useSessionUnit);
    setDebugHeader("CodeVersion", CODE_VERSION);
    const earlyAmenityIntent = detectAmenityKeyLoose(normalizedMessage);
    const capacityFactQuestion = isCapacityFactQuestion(normalizedMessage);
    let capacityQuery = extractCapacityQuery(normalizedMessage);
    if (!capacityQuery && Number.isFinite(executionPlan.guestCount) && executionPlan.guestCount > 0) {
      capacityQuery = { sleeps: executionPlan.guestCount };
    }
    let inventoryIntent =
      executionPlan.scope === "inventory" ||
      isInventoryQuery(normalizedMessage) ||
      ["inventory_availability", "amenity_inventory"].includes(effectiveIntent) ||
      (effectiveIntent === "policy" && looksLikeInventoryWidePolicyRequest(normalizedMessage));
    if (session?.listingId && earlyAmenityIntent && !isInventoryQuery(normalizedMessage)) {
      inventoryIntent = false;
    }
    if (session?.listingId && capacityFactQuestion && !looksLikeGenericUnitReference(userMessage)) {
      inventoryIntent = false;
    }
    if (session?.listingId && directBookingRequest) {
      inventoryIntent = false;
    }
    const inventoryCapacityIntent =
      Boolean(capacityQuery) &&
      (inventoryIntent || executionPlan.scope === "inventory");
    setDebugHeader("InventoryIntent", inventoryIntent);

    const tokenData = await getHostawayAccessToken();
    const accessToken = tokenData.access_token;

    const listings = await getListingsCached(accessToken);
    if (!listingId) {
      // Bind explicit full-name mentions early so unit-level availability questions
      // are not accidentally routed into inventory filters.
      const explicitListingId = findListingIdFromMessageStrong(normalizedMessage, listings);
      if (explicitListingId) {
        listingId = explicitListingId;
        setSession(sessionId, { listingId });
        setDebugHeader("ListingIdEarly", listingId);
      } else if (looksLikeSummaryRequest(normalizedMessage)) {
        const fuzzyListingId = findListingIdFromMessage(normalizedMessage, listings);
        if (fuzzyListingId) {
          listingId = fuzzyListingId;
          setSession(sessionId, { listingId });
          setDebugHeader("ListingIdSummaryFuzzy", listingId);
        }
      } else if (
        looksLikeFollowupQuestion(userMessage) &&
        session?.scopeMemory?.kind === "single_unit" &&
        session?.scopeMemory?.listingId &&
        !isInventoryQuery(normalizedMessage)
      ) {
        listingId = String(session.scopeMemory.listingId);
        setSession(sessionId, { listingId });
        setDebugHeader("ListingIdFromScopeMemory", listingId);
      }
    }
    const recommendationIntent = detectRecommendationIntent(normalizedMessage);

    const runRecommendations = async ({
      capacity = null,
      amenityKeys = [],
      wantsPetFriendly = false,
      unitType = null,
      dates = null,
    } = {}) => {
      const requestedNights = dates ? nightsBetween(dates.start, dates.end) : null;
      const safes = await mapWithConcurrency(
        listings,
        INVENTORY_AVAILABILITY_CONCURRENCY,
        async (l) => {
          try {
            const full = await fetchListingByIdCached(l.id, accessToken);
            const safe = toSafeListingFacts(full, { audience: "postbooking" });
            if (unitType && !String(safe.name || "").toLowerCase().includes(unitType)) return null;
            if (wantsPetFriendly && petPolicyFromRules(safe) !== "allowed") return null;
            const score = scoreRecommendation(safe, { capacity, amenityKeys, wantsPetFriendly, unitType });
            if (score < 0) return null;

            let available = true;
            if (dates) {
              const endForCalendar = addDays(dates.end, -1);
              const days = await fetchCalendarRange(safe.id, dates.start, endForCalendar, accessToken);
              const summary = summarizeAvailabilityWithAlternatives(days, dates.start, dates.end);
              available = summary?.available === true;
            }
            if (!available) return null;

            return {
              safe,
              score,
              reasons: explainRecommendationReasons(safe, {
                capacity,
                amenityKeys,
                wantsPetFriendly,
                unitType,
              }),
              requestedNights,
            };
          } catch (err) {
            console.error("Recommendation error:", err);
            return null;
          }
        }
      );

      return safes
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || String(a.safe.name).localeCompare(String(b.safe.name)))
        .slice(0, 3);
    };

    const constraintDrivenInventoryIntent =
      !listingId &&
      (detectInventoryConstraintRequest(normalizedMessage) ||
        (looksLikeFollowupQuestion(userMessage) &&
          followupInventory?.type === "constraints" &&
          !isAvailabilityQuestion(normalizedMessage)));

    if (constraintDrivenInventoryIntent) {
      metrics.recommendation_queries += 1;
      const activeConstraints = constraintsCurrent || constraintsBaseline || {};
      const capacity = activeConstraints.capacity || extractCapacityQuery(normalizedMessage);
      const dates = activeConstraints.dates || extractDates(normalizedMessage);
      const amenityKeys = Array.isArray(activeConstraints.amenityKeys)
        ? activeConstraints.amenityKeys
        : [];
      const wantsPetFriendly = Boolean(activeConstraints.wantsPetFriendly);
      const unitType = activeConstraints.unitType || null;

      setSession(sessionId, {
        lastInventory: {
          type: "constraints",
          amenityKeys,
          unitType,
          petFriendly: wantsPetFriendly,
          capacity: capacity || null,
          dates: dates || null,
        },
      });

      const recs = await runRecommendations({
        capacity,
        amenityKeys,
        wantsPetFriendly,
        unitType,
        dates,
      });

      const inventoryFilters = buildConstraintFilterMeta({
        amenityKeys,
        unitType,
        wantsPetFriendly,
        capacity,
        dates,
      });

      if (!recs.length) {
        const summary = formatConstraintsSummaryLine(activeConstraints);
        const noMatchMsg =
          summary && summary !== "I don’t have saved requirements yet."
            ? `I couldn’t find units matching all saved requirements (${summary}).`
            : "I couldn’t find units matching all saved requirements.";
        return sendReply(
          appendFollowupIfMissing(
            `${noMatchMsg}\n\nWant me to relax one requirement (for example bedrooms, amenities, or dates)?`,
            "Tell me one requirement to relax and I’ll re-rank options."
          ),
          {
            route: "inventory_constraints",
            dates: dates || null,
            inventoryFilters,
            replyType: "inventory",
          }
        );
      }

      const lines = recs.map((r) => {
        const withDates =
          dates && r.safe.bookingUrl
            ? `${r.safe.bookingUrl}?start=${dates.start}&end=${dates.end}`
            : r.safe.bookingUrl;
        return (
          `• [${r.safe.name}](${withDates})` +
          (r.reasons.length ? ` — ${r.reasons.join(", ")}` : "")
        );
      });
      const scope = dates ? ` for ${dates.start} to ${dates.end}` : "";
      return sendReply(
        appendFollowupIfMissing(
          `Best matches${scope} based on your saved requirements:\n\n${lines.join("\n")}`,
          "Want me to tighten these further (for example, exact bedrooms or a specific amenity)?"
        ),
        {
          route: "inventory_constraints",
          dates: dates || null,
          inventoryFilters,
          replyType: "inventory",
        }
      );
    }

    // Guided booking funnel mode: one question at a time.
    if (/help me book|book a stay|plan my stay|find me a place/i.test(normalizedMessage)) {
      setSession(sessionId, { funnel: { active: true, step: "dates", prefs: {} } });
      return sendReply(
        "Great — I can help you book. What dates are you looking at? " +
          "Example: 2026-03-24 to 2026-03-26.",
        { route: "recommendation", replyType: "summary" }
      );
    }

    if (session?.funnel?.active) {
      const funnel = session.funnel || { active: true, step: "dates", prefs: {} };
      const prefs = { ...(funnel.prefs || {}) };

      if (!prefs.dates) {
        const parsedDates = extractDates(normalizedMessage);
        if (!parsedDates) {
          return sendReply("What dates should I check? Example: 2026-03-24 to 2026-03-26.", {
            route: "recommendation",
            replyType: "summary",
          });
        }
        prefs.dates = parsedDates;
        setSession(sessionId, { funnel: { active: true, step: "guests", prefs } });
        return sendReply("Got it. How many guests should I plan for?", {
          route: "recommendation",
          replyType: "summary",
        });
      }

      if (!prefs.capacity?.sleeps) {
        const cap = extractCapacityQuery(normalizedMessage);
        const guestMatch = normalizedMessage.match(/\b(\d+)\s*(guest|guests|people|persons?)\b/);
        const sleeps = cap?.sleeps || (guestMatch ? Number(guestMatch[1]) : null);
        if (!sleeps) {
          return sendReply("How many guests are in your group?", {
            route: "recommendation",
            replyType: "summary",
          });
        }
        prefs.capacity = { ...(cap || {}), sleeps };
      }

      prefs.amenityKeys = detectAmenityKeys(normalizedMessage);
      prefs.wantsPetFriendly = detectPetFriendlyFilter(normalizedMessage);
      prefs.unitType = detectUnitType(normalizedMessage);

      const recs = await runRecommendations({
        capacity: prefs.capacity,
        amenityKeys: prefs.amenityKeys,
        wantsPetFriendly: prefs.wantsPetFriendly,
        unitType: prefs.unitType,
        dates: prefs.dates,
      });
      setSession(sessionId, { funnel: { active: false, step: "done", prefs } });
      metrics.recommendation_queries += 1;
      if (!recs.length) {
        return sendReply(
          "I couldn’t find a strong match for those details. " +
            "Want me to try nearby dates or relax one preference?",
          { route: "recommendation", replyType: "summary" }
        );
      }

      const lines = recs.map(
        (r) =>
          `• [${r.safe.name}](${r.safe.bookingUrl}?start=${prefs.dates.start}&end=${prefs.dates.end})` +
          (r.reasons.length ? ` — ${r.reasons.join(", ")}` : "")
      );
      return sendReply(
        `Best matches for ${prefs.dates.start} to ${prefs.dates.end}:\n\n${lines.join("\n")}\n\n` +
          "Want me to compare these side by side?",
        { route: "recommendation", dates: prefs.dates, replyType: "inventory" }
      );
    }

    if (recommendationIntent && !listingId) {
      metrics.recommendation_queries += 1;
      const dates = extractDates(normalizedMessage);
      const capacity = extractCapacityQuery(normalizedMessage);
      const amenityKeys = detectAmenityKeys(normalizedMessage);
      const wantsPetFriendly = detectPetFriendlyFilter(normalizedMessage);
      const unitType = detectUnitType(normalizedMessage);
      const recs = await runRecommendations({
        capacity,
        amenityKeys,
        wantsPetFriendly,
        unitType,
        dates,
      });

      if (!recs.length) {
        return sendReply("I couldn’t find a strong recommendation yet. Want me to check specific dates or guest count?", {
          route: "recommendation",
          replyType: "summary",
        });
      }

      const lines = recs.map((r) => {
        const dateParams =
          dates && r.safe.bookingUrl
            ? `?start=${dates.start}&end=${dates.end}`
            : "";
        return (
          `• [${r.safe.name}](${r.safe.bookingUrl}${dateParams})` +
          (r.reasons.length ? ` — ${r.reasons.join(", ")}` : "")
        );
      });

      const scope = dates ? ` for ${dates.start} to ${dates.end}` : "";
      return sendReply(`Top picks${scope}:\n\n${lines.join("\n")}`, {
        route: "recommendation",
        dates: dates || null,
        replyType: "inventory",
      });
    }

    // ---------- INVENTORY-WIDE CAPACITY QUESTIONS ----------
    if (inventoryIntent) {
      if (capacityQuery) {
        // Capacity queries should respect current and follow-up inventory filters.
        const hasFollowupInventoryContext =
          looksLikeFollowupQuestion(userMessage) && Boolean(followupInventory);
        let capacityAmenityKeys = detectAmenityKeys(normalizedMessage);
        let capacityUnitType = detectUnitType(normalizedMessage);
        let capacityWantsPetFriendly = detectPetFriendlyFilter(normalizedMessage);
        const hasAtLeastLanguage = /\b(at least|minimum|min\.?|or more|no fewer than)\b/i.test(
          normalizedMessage
        );
        const hasAtMostLanguage = /\b(at most|maximum|max\.?|or less|no more than)\b/i.test(
          normalizedMessage
        );
        const exactBedrooms =
          Number.isFinite(capacityQuery.bedrooms) &&
          !hasAtLeastLanguage &&
          !hasAtMostLanguage &&
          new RegExp(
            `\\b(?:have|has|with|exactly|also have|also has)\\s*${capacityQuery.bedrooms}\\s*bedrooms?\\b`,
            "i"
          ).test(normalizedMessage);
        const exactBathrooms =
          Number.isFinite(capacityQuery.bathrooms) &&
          !hasAtLeastLanguage &&
          !hasAtMostLanguage &&
          new RegExp(
            `\\b(?:have|has|with|exactly|also have|also has)\\s*${capacityQuery.bathrooms}\\s*bathrooms?\\b`,
            "i"
          ).test(normalizedMessage);
        const exactBeds =
          Number.isFinite(capacityQuery.beds) &&
          !hasAtLeastLanguage &&
          !hasAtMostLanguage &&
          new RegExp(
            `\\b(?:have|has|with|exactly|also have|also has)\\s*${capacityQuery.beds}\\s*beds?\\b`,
            "i"
          ).test(normalizedMessage);

        if (hasFollowupInventoryContext && followupInventory?.type === "amenity") {
          if (!capacityAmenityKeys.length && Array.isArray(followupInventory.amenityKeys)) {
            capacityAmenityKeys = followupInventory.amenityKeys;
          }
          if (!capacityUnitType && followupInventory.unitType) {
            capacityUnitType = followupInventory.unitType;
          }
          if (!capacityWantsPetFriendly && followupInventory.petFriendly) {
            capacityWantsPetFriendly = true;
          }
        }

        const results = await mapWithConcurrency(
          listings,
          INVENTORY_AVAILABILITY_CONCURRENCY,
          async (l) => {
            try {
              const listing = await fetchListingByIdCached(l.id, accessToken);
              const safe = toSafeListingFacts(listing, { audience: "postbooking" });
              const matchesAmenities =
                capacityAmenityKeys.length === 0 ||
                capacityAmenityKeys.every((k) => hasAmenity(safe, k));
              const matchesUnitType =
                !capacityUnitType ||
                String(safe.name || "").toLowerCase().includes(capacityUnitType);
              const matchesPetPolicy =
                !capacityWantsPetFriendly || petPolicyFromRules(safe) === "allowed";
              const ok =
                (capacityQuery.sleeps ? safe.sleeps >= capacityQuery.sleeps : true) &&
                (capacityQuery.bedrooms
                  ? exactBedrooms
                    ? safe.bedrooms === capacityQuery.bedrooms
                    : safe.bedrooms >= capacityQuery.bedrooms
                  : true) &&
                (capacityQuery.bathrooms
                  ? exactBathrooms
                    ? safe.bathrooms === capacityQuery.bathrooms
                    : safe.bathrooms >= capacityQuery.bathrooms
                  : true) &&
                (capacityQuery.beds
                  ? exactBeds
                    ? safe.beds === capacityQuery.beds
                    : safe.beds >= capacityQuery.beds
                  : true) &&
                matchesAmenities &&
                matchesUnitType &&
                matchesPetPolicy;
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
          return sendReply("I didn’t find any units that match that capacity.", {
            route: "amenity_inventory",
            inventoryFilters: {
              amenityKeys: capacityAmenityKeys,
              unitType: capacityUnitType,
              petFriendly: capacityWantsPetFriendly,
            },
            replyType: "inventory",
          });
        }
        setSession(sessionId, {
          lastInventory: {
            type: "amenity",
            amenityKeys: capacityAmenityKeys,
            unitType: capacityUnitType,
            petFriendly: capacityWantsPetFriendly,
          },
        });
        return sendReply(`Units that match your request:\n\n${lines.join("\n")}`, {
          route: "amenity_inventory",
          inventoryFilters: {
            amenityKeys: capacityAmenityKeys,
            unitType: capacityUnitType,
            petFriendly: capacityWantsPetFriendly,
          },
          replyType: "inventory",
        });
      }
    }

    // ---------- INVENTORY-WIDE PET-FRIENDLY LIST ----------
    if (isPetFriendlyListRequest(userMessage)) {
      const petUnitType = detectUnitType(normalizedMessage);
      const results = await mapWithConcurrency(
        listings,
        INVENTORY_AVAILABILITY_CONCURRENCY,
        async (l) => {
          try {
            const listing = await fetchListingByIdCached(l.id, accessToken);
            const safe = toSafeListingFacts(listing, { audience: "postbooking" });
            if (
              petUnitType &&
              !String(safe.name || "").toLowerCase().includes(String(petUnitType).toLowerCase())
            ) {
              return null;
            }
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
        return sendReply("I don’t currently see any pet‑friendly units.", {
          route: "amenity_inventory",
          inventoryFilters: {
            amenityKeys: [],
            unitType: petUnitType || null,
            petFriendly: true,
          },
          replyType: "inventory",
        });
      }

      setSession(sessionId, {
        lastInventory: {
          type: "amenity",
          amenityKeys: [],
          unitType: petUnitType || null,
          petFriendly: true,
        },
      });

      const label = petUnitType ? `pet‑friendly ${petUnitType}s` : "pet‑friendly";
      return sendReply(`Units with (${label}):\n\n${lines.join("\n")}`, {
        route: "amenity_inventory",
        inventoryFilters: {
          amenityKeys: [],
          unitType: petUnitType || null,
          petFriendly: true,
        },
        replyType: "inventory",
      });
    }

    // Detect listing from message if not explicitly provided
    if (!listingId) {
      const amenityIntent = detectAmenityQuery(normalizedMessage);
      if (inventoryCapacityIntent) {
        // Avoid false numeric listing matches (e.g. "group of 10" -> "Cottage #10")
        setDebugHeader("ListingDetect", "skipped_inventory_capacity");
      } else {
      // Even in inventory mode, keep a loose fallback so partial explicit unit mentions
      // like "Red Fern" still bind to a single listing when clearly present.
      const detectedStrong = findListingIdFromMessageStrong(normalizedMessage, listings);
      const detectedLoose = findListingIdFromMessage(normalizedMessage, listings);
      const genericUnitMention = looksLikeGenericUnitReference(userMessage);
      const detected = inventoryIntent
        ? detectedStrong || detectedLoose
        : detectedStrong || (genericUnitMention ? null : detectedLoose);
      if (detected) {
        listingId = detected;
        setSession(sessionId, { listingId });
      } else if (
        session?.listingId &&
        executionPlan.useSessionUnit &&
        !inventoryIntent &&
        !looksLikeInventoryWidePolicyRequest(normalizedMessage)
      ) {
        listingId = session.listingId;
        memoryNote = "\n\n(Using your last unit from this session.)";
      } else if (session?.listingId && directBookingRequest) {
        listingId = session.listingId;
        memoryNote = "\n\n(Using your last unit from this session.)";
        } else if (
          session?.listingId &&
          capacityFactQuestion &&
          !looksLikeGenericUnitReference(userMessage)
        ) {
          // Keep unit-level capacity/fact follow-ups pinned to the active session unit.
          listingId = session.listingId;
          memoryNote = "\n\n(Using your last unit from this session.)";
        } else if (session?.listingId && !inventoryIntent) {
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
          policyIntentRaw &&
          !looksLikeInventoryWidePolicyRequest(normalizedMessage)
        ) {
          // Policy/time follow-ups ("what time is check in?") should stay on current unit.
          listingId = session.listingId;
          memoryNote = "\n\n(Using your last unit from this session.)";
        } else if (
          session?.listingId &&
          looksLikeFollowupQuestion(userMessage) &&
          !looksLikeGenericUnitReference(userMessage)
        ) {
          listingId = session.listingId;
          memoryNote = "\n\n(Using your last unit from this session.)";
        } else if (session?.lastMessage && looksLikeSameMessageReference(userMessage)) {
          const fromLast = findListingIdFromMessage(normalizeUserMessage(session.lastMessage), listings);
          if (fromLast) {
            listingId = fromLast;
            setSession(sessionId, { listingId });
            memoryNote = "\n\n(Using your last unit from this session.)";
          }
        }
      }
    }
    setDebugHeader("ListingId", listingId);

    // Follow-up date-shift asks should stay on the active unit unless user asks inventory-wide.
    if (
      !listingId &&
      session?.listingId &&
      looksLikeFollowupQuestion(userMessage) &&
      isAvailabilityQuestion(normalizedMessage) &&
      !isInventoryAvailabilityQuestion(normalizedMessage)
    ) {
      listingId = session.listingId;
      memoryNote = "\n\n(Using your last unit from this session.)";
      setDebugHeader("ListingId", listingId);
      setDebugHeader("ListingFollowupPin", "session");
    }

    // ---------- INVENTORY-WIDE AVAILABILITY QUESTIONS ----------
    const hasAmenityFollowupSignal =
      Boolean(detectAmenityQuery(normalizedMessage)) ||
      detectAmenityKeys(normalizedMessage).length > 0 ||
      Boolean(detectPetFriendlyFilter(normalizedMessage));
    const looksLikeDateShiftFollowup =
      /\b(next|this)\s+weekend\b|\binstead\b|\banother\b\s+\b(date|weekend|range)\b|\bother\b\s+\b(date|dates)\b/i.test(
        normalizedMessage
      );
    const inventoryFollowupAvailability =
      looksLikeFollowupQuestion(userMessage) &&
      (isAvailabilityQuestion(normalizedMessage) || looksLikeDateShiftFollowup) &&
      Boolean(session?.lastInventory);

    if (
      !listingId &&
      (isInventoryAvailabilityQuestion(userMessage) ||
        effectiveIntent === "inventory_availability" ||
        (followupInventory?.type === "availability" && !hasAmenityFollowupSignal) ||
        inventoryFollowupAvailability)
    ) {
      let dates = extractDates(normalizedMessage);
      if (
        !dates &&
        (followupInventory?.type === "availability" || inventoryFollowupAvailability) &&
        followupInventory?.dates
      ) {
        dates = followupInventory.dates;
      }
      const unitType =
        detectUnitType(normalizedMessage) ||
        (followupInventory?.type === "availability" ? followupInventory.unitType : null);
      if (unitType) setDebugHeader("UnitType", unitType);
      if (dates) {
        setDebugHeader("Dates", `${dates.start}..${dates.end}`);
      }
      if (!dates) {
        return sendReply(
          "Which dates should I check for availability? For example: “tonight” or “2026-03-24 to 2026-03-26”.",
          { route: "inventory_availability", replyType: "availability" }
        );
      }

      const endForCalendar = addDays(dates.end, -1);
      if (endForCalendar < dates.start) {
        return sendReply("End date must be after start date (checkout after check-in).", {
          route: "inventory_availability",
          dates,
          inventoryFilters: { unitType: unitType || null },
          replyType: "availability",
        });
      }

      setSession(sessionId, { lastInventory: { type: "availability", dates, unitType } });
      const sourceListings = unitType
        ? listings.filter((l) =>
            String(l.name || "").toLowerCase().includes(unitType)
          )
        : listings;

      const results = await mapWithConcurrency(
        sourceListings,
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
        const typeLabel = unitType ? ` ${unitType}s` : "";
        logEvent("inventory_availability_response", {
          sessionId: sessionId || "anonymous",
          start: dates.start,
          end: dates.end,
          unitType: unitType || null,
          availableCount: 0,
        });
        return sendReply(
          appendFollowupIfMissing(
            `I didn’t find any available${typeLabel} for ${dates.start} to ${dates.end}.`,
            "Want me to check other dates or unit types?"
          ),
          {
            route: "inventory_availability",
            dates,
            inventoryFilters: { unitType: unitType || null },
            replyType: "availability",
          }
        );
      }

      const total = lines.length;
      const shown = lines.slice(0, INVENTORY_AVAILABILITY_MAX);
      const more = total > shown.length ? `\n\n(+${total - shown.length} more available)` : "";

      setSession(sessionId, {
        lastInventory: { type: "availability", dates },
      });

      const label = unitType ? ` (${unitType}s)` : "";
      logEvent("inventory_availability_response", {
        sessionId: sessionId || "anonymous",
        start: dates.start,
        end: dates.end,
        unitType: unitType || null,
        availableCount: shown.length,
      });
      return sendReply(
        appendFollowupIfMissing(
          `Available units for ${dates.start} to ${dates.end}${label}:\n\n${shown.join("\n")}${more}`,
          "Want me to check other dates or unit types?"
        ),
        {
          route: "inventory_availability",
          dates,
          inventoryFilters: { unitType: unitType || null },
          replyType: "availability",
        }
      );
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
      (looksLikeProximityQuery(userMessage) || effectiveIntent === "compare") &&
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
      (looksLikeProximityQuery(userMessage) || effectiveIntent === "compare")
    ) {
      const primaryFull = await fetchListingByIdCached(primaryId, accessToken);
      const secondaryFull = await fetchListingByIdCached(secondaryId, accessToken);
      const primarySafe = toSafeListingFacts(primaryFull, { audience: "postbooking" });
      const secondarySafe = toSafeListingFacts(secondaryFull, { audience: "postbooking" });

      if (effectiveIntent === "compare" && !looksLikeProximityQuery(userMessage)) {
        logEvent("compare_response", {
          sessionId: sessionId || "anonymous",
          primaryId,
          secondaryId,
        });
        return sendReply(buildComparison(primarySafe, secondarySafe, userMessage), {
          route: "compare",
          replyType: "summary",
        });
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

      logEvent("proximity_response", {
        sessionId: sessionId || "anonymous",
        primaryId: displayPrimary?.id || primaryId,
        secondaryId: displaySecondary?.id || secondaryId,
      });
      return sendReply(
        `${locationLine}\n\n` +
          `[${displayPrimary.name}](${displayPrimary.bookingUrl})\n` +
          `[${displaySecondary.name}](${displaySecondary.bookingUrl})`,
        { route: "compare", replyType: "summary" }
      );
    }

    // ---------- INVENTORY-WIDE AMENITY QUESTIONS ----------
    if (!listingId || followupAmenityKey) {
      let amenityKeys = detectAmenityKeys(normalizedMessage);
      let unitType = detectUnitType(normalizedMessage);
      let wantsPetFriendly = detectPetFriendlyFilter(normalizedMessage);
      const looksLikeListRequest = /\b(which|what|list|show|any)\b/.test(
        (userMessage || "").toLowerCase()
      );
      const skipAmenityInventory =
        policyIntentRaw === "pets" && !looksLikeListRequest && !amenityKeys.length && !unitType;
      const availabilityAsked =
        isAvailabilityQuestion(normalizedMessage) ||
        effectiveIntent === "availability" ||
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

      const amenityKey = detectAmenityQuery(normalizedMessage) || followupAmenityKey;

      if (
        amenityKeys.length > 0 ||
        amenityKey ||
        wantsPetFriendly ||
        unitType ||
        effectiveIntent === "amenity_inventory"
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
          (looksLikeListRequest || amenityKeys.length || unitType || effectiveIntent === "amenity_inventory")
        ) {
        const effectiveAmenityKeys = amenityKeys.length ? amenityKeys : amenityKey ? [amenityKey] : [];
        const unsupportedTerms = extractUnsupportedAmenityTerms(normalizedMessage);
        if (unsupportedTerms.length > 0) {
          return sendReply(
            `I can’t reliably filter by ${unsupportedTerms.map((t) => `"${t}"`).join(", ")} yet. ` +
              "I can filter by hot tubs, jacuzzis, pools, fireplaces, and saunas.",
            { route: "amenity_inventory", replyType: "inventory" }
          );
        }
        const unsupportedAmenityFilter =
          effectiveAmenityKeys.length === 0 &&
          !wantsPetFriendly &&
          looksLikeAmenityFilterWithoutSupportedAmenity(normalizedMessage);
        if (unsupportedAmenityFilter) {
          return sendReply(
            "I can filter units by hot tubs, jacuzzis, pools, fireplaces, and saunas right now. " +
              "Which amenity would you like me to use?",
            { route: "amenity_inventory", replyType: "inventory" }
          );
        }
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
          return sendReply(`I didn’t find any units matching ${label}.`, {
            route: "amenity_inventory",
            inventoryFilters: {
              amenityKeys: effectiveAmenityKeys,
              unitType: unitType || null,
              petFriendly: wantsPetFriendly,
            },
            replyType: "inventory",
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

        return sendReply(`Units with${label}:\n\n${lines}`, {
          route: "amenity_inventory",
          inventoryFilters: {
            amenityKeys: effectiveAmenityKeys,
            unitType: unitType || null,
            petFriendly: wantsPetFriendly,
          },
          replyType: "inventory",
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
              return sendReply(generalized, { route: "policy", replyType: "policy" });
            }
            if (policyIntent === "pets") {
              return sendReply(
                `${generalized}\n\n` +
                  "Pet policies can vary by unit. Do you have a specific unit you'd like me to check, " +
                  "or would you like a list of pet‑friendly units?",
                { route: "policy", replyType: "policy" }
              );
            }
            return sendReply(
              `${generalized}\n\n` +
                "Policies can vary by unit. Do you have a specific unit you'd like me to check?",
              { route: "policy", replyType: "policy" }
            );
          }
        }
      }
    }

    // If we still don't have a listing, ask + suggestions
    if (!listingId) {
      const shouldStayInventoryWide =
        inventoryCapacityIntent ||
        recommendationIntent ||
        isInventoryQuery(normalizedMessage) ||
        isInventoryAvailabilityQuestion(normalizedMessage) ||
        detectInventoryConstraintRequest(normalizedMessage) ||
        looksLikeInventoryWidePolicyRequest(normalizedMessage) ||
        (looksLikeFollowupQuestion(userMessage) &&
          (followupInventory?.type === "constraints" || followupInventory?.type === "amenity"));
      if (shouldStayInventoryWide) {
        return sendReply(
          "I can keep this inventory-wide without locking to one unit. " +
            "Tell me the filters you want (guests, dates, amenities, pet-friendly, or unit type) and I’ll narrow options.",
          { route: "inventory_constraints", replyType: "inventory" }
        );
      }
      const suggestions = suggestUnits(userMessage, listings);
      const suggestionText =
        suggestions.length > 0
          ? suggestions.map((s) => `• ${s.name}`).join("\n")
          : "• (No close matches found)";

      return sendReply(
        "Which unit are you asking about?\n\n" +
          "I can give an exact answer once I know the unit.\n\n" +
          "Possible matches:\n" +
          suggestionText,
        { route: "disambiguation", replyType: "summary" }
      );
    }

    if (listingId && directBookingRequest) {
      const listing = await fetchListingByIdCached(listingId, accessToken);
      const safe = toSafeListingFacts(listing, { audience: "postbooking" });
      let bookUrl = safe.bookingUrl;
      if (session?.dates?.start && session?.dates?.end) {
        bookUrl = `${safe.bookingUrl}?start=${session.dates.start}&end=${session.dates.end}`;
      }
      return sendReply(
        `Absolutely — here’s your booking link for ${safe.name}:\n\nBook now: ${formatBookLink(
          bookUrl,
          safe.name
        )}`,
        {
          route: "availability",
          dates: session?.dates || null,
          replyType: "availability",
        }
      );
    }

    const wantsNextAvailableWeekend =
      listingId &&
      /\bnext available weekend\b|\bnext weekend available\b|\bwhen.*next weekend\b|\bnext weekend\b.*\bavailable\b/i.test(
        normalizedMessage
      );

    let dates = extractDates(normalizedMessage);
    const monthRange = monthQueryToRange(normalizedMessage);
    // Availability flow should be driven by explicit availability/date signals
    // plus true availability follow-ups from session context.
    const availabilityAsked =
      isAvailabilityQuestion(normalizedMessage) ||
      Boolean(dates) ||
      session?.lastIntent === "availability" ||
      // Natural follow-ups like "what about in March?" should stay in availability flow
      // when we already have a unit in context.
      (Boolean(monthRange) && (Boolean(listingId) || looksLikeFollowupQuestion(userMessage)));
    if (availabilityAsked) metrics.availability_queries += 1;
    if (
      !dates &&
      (isAvailabilityQuestion(normalizedMessage) ||
        Boolean(extractDates(normalizedMessage)) ||
        session?.lastIntent === "availability") &&
      session?.dates
    ) {
      if (looksLikeSameDatesReference(normalizedMessage)) {
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
          suggestLine =
            `\n\nSuggested stay: ${next.start} to ${next.suggestedEnd}\n` +
            `Book now: ${formatBookLink(suggestUrl)}`;
        }
        return sendReply(
          `Next available weekend is ${next.start} to ${next.end}${note}.\n\nBook now: ${formatBookLink(bookUrl)}` +
            suggestLine +
            memoryNote,
          { route: "availability", dates: { start: next.start, end: next.end }, replyType: "availability" }
        );
      }
      return sendReply(
        "I couldn’t find an available weekend in the next few months. " +
          "If you have specific dates in mind, I can check those." +
          memoryNote,
        { route: "availability", replyType: "availability" }
      );
    }
    const wantsWeekendInMonth =
      listingId &&
      !dates &&
      Boolean(monthRange) &&
      (availabilityAsked || /\bweekend\b/i.test(normalizedMessage) || looksLikeFollowupQuestion(userMessage));
    if (wantsWeekendInMonth) {
      const listing = await fetchListingById(listingId, accessToken);
      const safe = toSafeListingFacts(listing, { audience: "postbooking" });
      const calEnd = addDays(monthRange.end, 3); // allow Fri-Sun + min-stay extension checks
      const days = await fetchCalendarRange(listingId, monthRange.start, calEnd, accessToken);
      const weekends = findAvailableWeekendsInRange(days, monthRange.start, monthRange.end, 3);

      if (!weekends.length) {
        return sendReply(
          `I couldn’t find an available weekend in ${monthRange.monthName}. Want me to check another month?` +
            memoryNote,
          { route: "availability", dates: { start: monthRange.start, end: monthRange.end }, replyType: "availability" }
        );
      }

      const lines = weekends.map((w) => {
        const baseUrl = `${safe.bookingUrl}?start=${w.start}&end=${w.end}`;
        if (w.minStay > 2) {
          const base = `• ${w.start} to ${w.end} (Fri-Sun, requires ${w.minStay} nights)`;
          if (w.suggestedEnd) {
            const suggestUrl = `${safe.bookingUrl}?start=${w.start}&end=${w.suggestedEnd}`;
            return `${base} — [Book Fri-Sun](${baseUrl}) or [book ${w.minStay}-night stay](${suggestUrl})`;
          }
          return `${base} — [Book Fri-Sun](${baseUrl})`;
        }
        return `• ${w.start} to ${w.end} (Fri-Sun) — [Book this weekend](${baseUrl})`;
      });

      return sendReply(
        `Available weekends in ${monthRange.monthName} for ${safe.name}:\n\n${lines.join("\n")}` +
          memoryNote,
        { route: "availability", dates: { start: monthRange.start, end: monthRange.end }, replyType: "availability" }
      );
    }

    if (
      listingId &&
      !dates &&
      (isAvailabilityQuestion(normalizedMessage) || effectiveIntent === "availability")
    ) {
      return sendReply(
        "Which dates should I check for availability? For example: “today”, “this weekend”, or “2026-03-24 to 2026-03-26”." +
          memoryNote,
        { route: "availability", replyType: "availability" }
      );
    }
    if (dates && availabilityAsked && !listingId) {
      return sendReply(
        "Which unit should I check for those dates? If you want, I can also search across all units.",
        { route: "availability", dates, replyType: "availability" }
      );
    }
    if (
      dates &&
      (isAvailabilityQuestion(normalizedMessage) ||
        effectiveIntent === "availability" ||
        session?.lastIntent === "availability")
    ) {
      setSession(sessionId, { dates });
      const endForCalendar = addDays(dates.end, -1);

      if (endForCalendar < dates.start) {
        return sendReply("End date must be after start date (checkout after check-in).", {
          route: "availability",
          dates,
          replyType: "availability",
        });
      }

      const days = await fetchCalendarRange(listingId, dates.start, endForCalendar, accessToken);
      const data = summarizeAvailabilityWithAlternatives(days, dates.start, dates.end);
      setDebugHeader("AvailabilityReason", data?.reasonCode || "unknown");

      // Fetch safe listing to get stable bookingUrl
      const listing = await fetchListingById(listingId, accessToken);
      const safe = toSafeListingFacts(listing, { audience: "postbooking" });

      // Only include dates when the requested range is actually available
      let bookUrl = safe.bookingUrl;
      if (data?.available === true && dates?.start && dates?.end) {
        const sep = safe.bookingUrl.includes("?") ? "&" : "?";
        bookUrl = `${safe.bookingUrl}${sep}start=${dates.start}&end=${dates.end}`;
      }

      const details = shouldIncludeAvailabilityDetails(normalizedMessage, policyIntentRaw, data?.reasonCode);
      const timeLine = details.includeTimes ? formatCheckTimes(safe) : "";
      const minStayLine =
        details.includeMinStay && safe.minNights != null
          ? `Minimum stay: ${safe.minNights} ${safe.minNights === 1 ? "night" : "nights"}.`
          : "";
      const extraLines = [timeLine, minStayLine].filter(Boolean).join("\n");
      let flexLine = "";
      if (data?.available === false) {
        const desiredNights = nightsBetween(dates.start, dates.end);
        const flexEnd = addDays(dates.start, 90);
        const flexDays = await fetchCalendarRange(listingId, dates.start, flexEnd, accessToken);
        const alternatives = findAlternativeStays(flexDays, dates.start, desiredNights, 5, 3);
        if (alternatives.length) {
          const altLines = alternatives.map((a) => {
            const url = `${safe.bookingUrl}?start=${a.start}&end=${a.end}`;
            return `• ${a.start} to ${a.end} (${a.nights} nights) — ${formatBookLink(url)}`;
          });
          flexLine = `\n\nClosest alternatives:\n${altLines.join("\n")}`;
        }
      }
      const evidenceLine = wantsEvidenceLine(normalizedMessage)
        ? buildEvidenceLine({
            confidence: data?.available ? "high" : "medium",
            source: "Hostaway calendar (read-only)",
          })
        : "";

      const bookingLine = bookUrl ? `\n\nBook now: ${formatBookLink(bookUrl)}` : "";
      logEvent("availability_response", {
        sessionId: sessionId || "anonymous",
        listingId,
        start: dates.start,
        end: dates.end,
        available: Boolean(data?.available),
        reasonCode: data?.reasonCode || "unknown",
      });
      return sendReply(
        appendFollowupIfMissing(
          (data.message || "Availability check complete.") +
            (extraLines ? `\n${extraLines}` : "") +
            flexLine +
            bookingLine +
            evidenceLine +
            memoryNote,
          "Would you like me to check other dates?"
        ),
        { route: "availability", dates, replyType: "availability" }
      );
    }

    // Listing-level amenity questions
    const listingAmenityKey = listingId ? detectAmenityKeyLoose(normalizedMessage) : null;
    if (listingId && listingAmenityKey) {
      const listing = await fetchListingById(listingId, accessToken);
      const safe = toSafeListingFacts(listing, { audience: "postbooking" });
      const has = hasAmenity(safe, listingAmenityKey);
      const reply = has
        ? `Yes — ${safe.name} has a ${listingAmenityKey}.`
        : `No — ${safe.name} does not have a ${listingAmenityKey}.`;
      return sendReply(reply + `\n\nBook now: ${formatBookLink(safe.bookingUrl, safe.name)}` + memoryNote, {
        route: "amenity_inventory",
        replyType: "inventory",
      });
    }

    // General Q&A: Fetch listing and build safe facts
    const listing = await fetchListingById(listingId, accessToken);
    const safe = toSafeListingFacts(listing, { audience: "postbooking" });
    const safeFactsText = JSON.stringify(safeFactsForModel(safe), null, 2);

    const wantsBookingLink =
      isAvailabilityQuestion(normalizedMessage) ||
      /\b(book|booking|reserve|reservation|availability|available|check[- ]?in|check[- ]?out|checkout|checkin)\b/i.test(
        normalizedMessage
      );

    if (capacityFactQuestion) {
      const capacityReply = capacityAnswerFromFacts(safe, normalizedMessage);
      if (capacityReply) {
        return sendReply(
          appendFollowupIfMissing(
            capacityReply + memoryNote,
            "Want me to check availability or other unit details?"
          ),
          { route: "summary", replyType: "summary" }
        );
      }
    }

    let policyIntent = detectPolicyIntent(normalizedMessage);
    if (!policyIntent && looksLikeFollowupQuestion(normalizedMessage) && session?.lastPolicyIntent) {
      policyIntent = session.lastPolicyIntent;
    }
    if (policyIntent) {
      metrics.policy_queries += 1;
      setSession(sessionId, { lastPolicyIntent: policyIntent });
      const fromRules = policyAnswerFromHouseRules(safe, policyIntent);
      const fromFacts = policyAnswerFromFacts(safe, policyIntent);
      const policyReply = fromRules || fromFacts;
      if (policyReply) {
        const policyReplyScoped = personalizePolicyReply(policyReply, safe, policyIntent);
        const evidenceSource = fromRules ? "listing house rules/tags/public fields" : "listing check-in/out facts";
        const evidenceLine = wantsEvidenceLine(normalizedMessage)
          ? buildEvidenceLine({ confidence: "high", source: evidenceSource })
          : "";
        const bookingLine =
          safe.bookingUrl && wantsBookingLink
            ? `\n\nBook now: ${formatBookLink(safe.bookingUrl, safe.name)}`
            : "";
        logEvent("policy_response", {
          sessionId: sessionId || "anonymous",
          listingId,
          policy: policyIntent,
        });
        sendReply(
          appendFollowupIfMissing(
            policyReplyScoped + bookingLine + evidenceLine + memoryNote,
            "Want me to check a different unit?"
          ),
          { route: "policy", replyType: "policy" }
        );
        return;
      }
    }

    if (looksLikeSummaryRequest(normalizedMessage) || effectiveIntent === "summary") {
      const bookingLine =
        safe.bookingUrl && wantsBookingLink
          ? `\n\nBook now: ${formatBookLink(safe.bookingUrl, safe.name)}`
          : "";
      setSession(sessionId, { lastMessage: userMessage });
      sendReply(buildSafeSummary(safe) + bookingLine + memoryNote, {
        route: "summary",
        replyType: "summary",
      });
      return;
    }

    let aiText = "";
    try {
      const aiResponse = await client.responses.create({
        model: ANSWER_MODEL,
        instructions:
          "You are a customer service assistant for AmishCountryLodging.com. " +
          "Write in a warm, conversational tone. " +
          "Global policy guardrails: smoking is not allowed and parties/events are not allowed at any unit. " +
          "Never contradict these global policies. " +
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
      safe.bookingUrl && wantsBookingLink
        ? `\n\nBook now: ${formatBookLink(safe.bookingUrl, safe.name)}`
        : "";
    const aiEvidenceLine = wantsEvidenceLine(normalizedMessage)
      ? buildEvidenceLine({ confidence: "medium", source: "unit safe facts" })
      : "";
    sendReply(aiText + bookingLine + aiEvidenceLine + memoryNote, {
      route: "general",
      replyType: "general",
    });
    setSession(sessionId, { lastMessage: userMessage });
  } catch (err) {
    console.error(err);
    metrics.errors_total += 1;
    logEvent("error", { message: String(err?.message || err) });
    res.status(500).json({ reply: "Something went wrong on the server." });
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
