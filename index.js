// index.js
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  fetchSafeListingFacts,
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
import { createModelFirstOrchestrator } from "./src/orchestrator/orchestrator.js";

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
const DATABASE_URL = process.env.DATABASE_URL || "";
let feedbackTableReady = false;

function cloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function constraintsSignature(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "";
  }
}

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

function sqlLit(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(sql) {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required for feedback storage");
  const out = spawnSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", sql], {
    encoding: "utf8",
  });
  if (out.status !== 0) {
    const err = String(out.stderr || out.stdout || "psql failed").trim();
    throw new Error(err);
  }
}

function ensureFeedbackTable() {
  if (feedbackTableReady) return;
  const ddl = `
CREATE SCHEMA IF NOT EXISTS chatbot_feedback;
CREATE TABLE IF NOT EXISTS chatbot_feedback.turn_feedback (
  feedback_id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  code_version TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  tester_name TEXT,
  listing_id TEXT,
  feedback TEXT NOT NULL CHECK (feedback IN ('up', 'down')),
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT,
  user_message TEXT,
  bot_reply TEXT,
  transcript JSONB,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_chatbot_feedback_created_at ON chatbot_feedback.turn_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatbot_feedback_code_version ON chatbot_feedback.turn_feedback(code_version);
CREATE INDEX IF NOT EXISTS idx_chatbot_feedback_session_id ON chatbot_feedback.turn_feedback(session_id);
`;
  runPsql(ddl);
  feedbackTableReady = true;
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

const MAX_TOOL_CALLS_PER_TURN = Number(process.env.MAX_TOOL_CALLS_PER_TURN || 6);
const MAX_TOOL_FAILURES_PER_TURN = Number(process.env.MAX_TOOL_FAILURES_PER_TURN || 3);
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 15000);

const modelFirstOrchestrator = createModelFirstOrchestrator({
  client,
  model: ANSWER_MODEL,
  maxToolCalls: Number.isFinite(MAX_TOOL_CALLS_PER_TURN) ? MAX_TOOL_CALLS_PER_TURN : 6,
  maxExecutionFailures: Number.isFinite(MAX_TOOL_FAILURES_PER_TURN)
    ? MAX_TOOL_FAILURES_PER_TURN
    : 3,
  toolTimeoutMs: Number.isFinite(TOOL_TIMEOUT_MS) ? TOOL_TIMEOUT_MS : 15000,
  logger: (type, data) => logEvent(type, data),
  deps: {
    getHostawayAccessToken,
    getListingsCached,
    fetchListingByIdCached,
    fetchSafeListingFacts,
    fetchCalendarRange,
    toSafeListingFacts,
    findListingIdFromMessage,
    findListingIdFromMessageStrong,
    suggestUnits,
    extractDates,
    getTodayIso,
    helpers: {
      findListingIdFromMessage,
      findListingIdFromMessageStrong,
      suggestUnits,
    },
  },
});

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
  return /\b(what about that|what about those|that one|those ones|they|them|those|any others|which ones)\b/.test(
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

function isAllUnitTypesScopeRequest(message) {
  const msg = String(message || "").toLowerCase();
  return (
    /\b(all|any)\s+(unit types|units|properties|listings|accommodations)\b/.test(msg) ||
    /\bcheck all\b/.test(msg) ||
    /\ball types\b/.test(msg)
  );
}

function hasResultSetPronounReference(message) {
  const msg = String(message || "").toLowerCase();
  return /\b(they|them|those|any of those|any of them|those ones|of those)\b/.test(msg);
}

function isLikelyUnitSwitchPrompt(message) {
  const msg = String(message || "").toLowerCase();
  const mentionsSwitch = /\b(what about|how about|tell me about|and what about)\b/.test(msg);
  const hasAvailabilitySignal =
    /\b(available|availability|book|booking|dates?|when|tonight|tomorrow|weekend|check[- ]?in|check[- ]?out)\b/.test(
      msg
    );
  return mentionsSwitch && !hasAvailabilitySignal;
}

function shiftIsoRange(dates, days) {
  if (!dates?.start || !dates?.end) return null;
  return {
    start: addDays(dates.start, days),
    end: addDays(dates.end, days),
  };
}

function resolveRelativeDatesFromSession(message, sessionDates) {
  const msg = String(message || "").toLowerCase();
  if (!sessionDates?.start || !sessionDates?.end) return null;
  if (/\b(following|after that|week after)\s+weekend\b/.test(msg)) {
    return shiftIsoRange(sessionDates, 7);
  }
  if (/\b(two weekends? after|in two weekends?)\b/.test(msg)) {
    return shiftIsoRange(sessionDates, 14);
  }
  if (/\bsame dates?\b/.test(msg)) {
    return { start: sessionDates.start, end: sessionDates.end };
  }
  return null;
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

function appendConstraintHistory(history, constraints, reason = "update") {
  const list = Array.isArray(history) ? history.slice(-19) : [];
  list.push({
    at: new Date().toISOString(),
    reason,
    constraints: cloneJson(constraints) || null,
  });
  return list;
}

function pickRecalledConstraints(message, { baseline, current, history } = {}) {
  const msg = String(message || "").toLowerCase();
  const snapshots = Array.isArray(history) ? history : [];
  const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1].constraints : null;
  const previousSnapshot = snapshots.length > 1 ? snapshots[snapshots.length - 2].constraints : null;
  const firstSnapshot = snapshots.length ? snapshots[0].constraints : null;

  const asksOriginal =
    /\boriginal (requirements|asks|constraints|preferences)\b/.test(msg) ||
    /\bfirst (requirements|asks|constraints|preferences)\b/.test(msg);
  const asksBeforeChange =
    /\bbefore (i )?(changed|added|updated)\b/.test(msg) ||
    /\bbefore (that|the) change\b/.test(msg);

  if (asksBeforeChange) return previousSnapshot || baseline || latestSnapshot || current || null;
  if (asksOriginal) return firstSnapshot || baseline || previousSnapshot || latestSnapshot || current || null;
  return current || latestSnapshot || baseline || null;
}

function isBookingStepsRequest(message) {
  const msg = String(message || "").toLowerCase();
  return (
    /\bnext steps?\b/.test(msg) ||
    /\bhow (do i|to) book\b/.test(msg) ||
    /\bbook quickly\b/.test(msg) ||
    /\bhow can i reserve\b/.test(msg) ||
    /\bwhat should i do to book\b/.test(msg)
  );
}

function detectRecommendationIntent(message) {
  const msg = (message || "").toLowerCase();
  return /\b(recommend|suggest|best option|best unit|which should i|help me choose|help me book|find me|top choices?|top \d+ options?)\b/.test(
    msg
  );
}

function isDirectBookingRequest(message) {
  const msg = (message || "").toLowerCase();
  return /\b(book it|book this|book that|reserve it|reserve this|reserve that|book now|can you book|book .* for me|help me book)\b/.test(
    msg
  );
}

function isBookingActionRequest(message) {
  const msg = (message || "").toLowerCase();
  const bookingVerb =
    msg.includes("book") ||
    msg.includes("reserve") ||
    msg.includes("reservation");
  const planningOnly = isBookingStepsRequest(msg);
  return bookingVerb && !planningOnly;
}

function isConversationalClosureTurn(message) {
  const msg = normalizeUserMessage(message);
  if (!msg) return false;
  return (
    /^(thanks|thank you|great|awesome|perfect|sounds good|okay|ok|got it|nice)[!. ]*$/.test(msg) ||
    /\b(thanks|thank you|appreciate it|that helps)\b/.test(msg) ||
    /\b(we will stay home|i'll come back later|we'll come back later|bye|goodbye|talk later)\b/.test(msg)
  );
}

function conversationalClosureReply(message) {
  const msg = normalizeUserMessage(message);
  if (/\b(we will stay home|i'll come back later|we'll come back later|bye|goodbye|talk later)\b/.test(msg)) {
    return "No problem. If plans change, send dates or a unit name and I can help right away.";
  }
  return "You’re welcome. If you want, I can check dates, compare units, or answer policy questions.";
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

function formatPetFriendlyHeading(unitType) {
  const t = String(unitType || "").trim().toLowerCase();
  if (!t) return "Pet-friendly units:";
  const plural = t.endsWith("s") ? t : `${t}s`;
  return `Pet-friendly ${plural}:`;
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

app.post("/feedback", (req, res) => {
  try {
    const feedback = String(req.body?.feedback || "").toLowerCase();
    const sessionId = String(req.body?.sessionId || "").trim();
    const turnNumber = Number(req.body?.turnNumber);
    const codeVersion = String(req.body?.codeVersion || "").trim() || CODE_VERSION;

    if (!["up", "down"].includes(feedback)) {
      return res.status(400).json({ ok: false, error: "feedback must be 'up' or 'down'" });
    }
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId is required" });
    if (!Number.isInteger(turnNumber) || turnNumber <= 0) {
      return res.status(400).json({ ok: false, error: "turnNumber must be a positive integer" });
    }
    if (!codeVersion) {
      return res.status(400).json({ ok: false, error: "codeVersion is required" });
    }
    if (!DATABASE_URL) {
      return res.status(503).json({ ok: false, error: "DATABASE_URL is not configured" });
    }

    const testerName = String(req.body?.testerName || "").trim() || null;
    const listingId = req.body?.listingId != null ? String(req.body.listingId).trim() || null : null;
    const tagsRaw = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const tags = tagsRaw
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 12);
    const note = String(req.body?.note || "").trim().slice(0, 2000) || null;
    const userMessage = String(req.body?.userMessage || "").slice(0, 4000) || null;
    const botReply = String(req.body?.botReply || "").slice(0, 12000) || null;
    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript.slice(-40) : null;
    const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};
    const feedbackId = randomUUID();

    ensureFeedbackTable();
    runPsql(
      `INSERT INTO chatbot_feedback.turn_feedback
       (feedback_id, code_version, session_id, turn_number, tester_name, listing_id, feedback, tags, note, user_message, bot_reply, transcript, meta)
       VALUES (
         ${sqlLit(feedbackId)}::uuid,
         ${sqlLit(codeVersion)},
         ${sqlLit(sessionId)},
         ${turnNumber},
         ${sqlLit(testerName)},
         ${sqlLit(listingId)},
         ${sqlLit(feedback)},
         ${sqlLit(JSON.stringify(tags))}::jsonb,
         ${sqlLit(note)},
         ${sqlLit(userMessage)},
         ${sqlLit(botReply)},
         ${sqlLit(transcript ? JSON.stringify(transcript) : null)}::jsonb,
         ${sqlLit(JSON.stringify(meta))}::jsonb
       );`
    );
    logEvent("manual_feedback", {
      sessionId,
      turnNumber,
      feedback,
      codeVersion,
      listingId,
      tags,
    });
    return res.json({ ok: true, feedbackId, codeVersion });
  } catch (err) {
    console.error("Feedback write error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save feedback" });
  }
});

app.get("/feedback/recent", (req, res) => {
  try {
    if (!DATABASE_URL) {
      return res.status(503).json({ ok: false, error: "DATABASE_URL is not configured" });
    }
    ensureFeedbackTable();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const codeVersion = String(req.query.codeVersion || "").trim();
    const sessionId = String(req.query.sessionId || "").trim();
    const where = [];
    if (codeVersion) where.push(`code_version = ${sqlLit(codeVersion)}`);
    if (sessionId) where.push(`session_id = ${sqlLit(sessionId)}`);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql =
      `SELECT feedback_id, created_at, code_version, session_id, turn_number, tester_name, listing_id, feedback, tags, note, user_message, bot_reply
       FROM chatbot_feedback.turn_feedback
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${limit};`;
    const out = spawnSync(
      "psql",
      [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-F", "\t", "-c", sql],
      { encoding: "utf8" }
    );
    if (out.status !== 0) {
      const err = String(out.stderr || out.stdout || "psql failed").trim();
      throw new Error(err);
    }
    return res.type("text/plain").send(out.stdout || "");
  } catch (err) {
    console.error("Feedback read error:", err);
    return res.status(500).json({ ok: false, error: "Failed to read feedback" });
  }
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
    const listingId = req.body.listingId || null;
    const sessionId = req.body.sessionId || req.headers["x-session-id"] || null;
    const session = sessionId ? getSession(sessionId) : null;
    const debugEnabled =
      req.query?.debug === "1" || String(req.headers["x-debug"] || "") === "1";
    const setDebugHeader = (key, value) => {
      if (!debugEnabled) return;
      if (value == null) return;
      res.setHeader(`X-Debug-${key}`, String(value));
    };

    const testModeRequested =
      ENABLE_TEST_MODE && String(req.headers["x-test-mode"] || "").trim() === "1";
    const role = String(req.headers["x-user-role"] || "guest").toLowerCase();

    logEvent("chat_request", {
      sessionId: sessionId || "anonymous",
      listingId: listingId || session?.listingId || null,
      role,
      mode: "model_first_orchestrator",
      codeVersion: CODE_VERSION,
    });

    const orchestration = await modelFirstOrchestrator.runTurn({
      message: normalizedMessage,
      sessionId,
      session,
      role,
      listingIdHint: listingId || session?.listingId || null,
      runtime: {},
    });

    if (sessionId) {
      setSession(sessionId, {
        ...(orchestration.sessionPatch || {}),
        lastIntent: orchestration.route || "general",
      });
    }

    metrics.intents[orchestration.route || "general"] =
      (metrics.intents[orchestration.route || "general"] || 0) + 1;

    const reply = applyReplyVoice(orchestration.reply || "", {
      intent: orchestration.route || "general",
      policyIntent: null,
      userMessage: normalizedMessage,
    });

    setDebugHeader("Mode", "model_first_orchestrator");
    setDebugHeader("Route", orchestration.route || "general");
    setDebugHeader("CodeVersion", CODE_VERSION);

    if (testModeRequested) {
      return res.json({
        reply,
        meta: {
          codeVersion: CODE_VERSION,
          intent: orchestration.route || "general",
          route: orchestration.route || "general",
          listingId:
            orchestration.sessionPatch?.listingId || listingId || session?.listingId || null,
          sessionListingId: session?.listingId || null,
          dates: orchestration.sessionPatch?.dates || session?.dates || null,
          inventoryFilters:
            orchestration.sessionPatch?.inventoryFilters || session?.inventoryFilters || null,
          usedSessionMemory: Boolean(session?.listingId || session?.dates || session?.inventoryFilters),
          replyType:
            orchestration.replyType || inferReplyType(orchestration.route || "general", reply),
          orchestration: {
            toolCallCount: orchestration.trace?.toolCallCount || 0,
            unknownToolCalls: orchestration.trace?.unknownToolCalls || 0,
            validation: orchestration.trace?.validation || [],
            toolExecutions: orchestration.trace?.toolExecutions || [],
            failureReason: orchestration.trace?.failureReason || null,
            clarificationAsked: Boolean(orchestration.trace?.clarificationAsked),
          },
        },
      });
    }

    return res.json({ reply });
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
