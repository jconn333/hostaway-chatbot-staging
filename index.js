// index.js
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";
import { getSandboxHtml, getReviewHtml } from "./src/ui.js";

const { Pool } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===============================
   LISTINGS CACHE
================================ */
let listingsCache = { data: null, fetchedAt: 0 };

async function getListingsCached(accessToken) {
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

/* ===============================
   HOSTAWAY AUTH
================================ */
async function getHostawayAccessToken() {
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
   SAFETY FILTER (CRITICAL)
   - Only public info
   - No door codes, WiFi passwords, private instructions, etc.
   - Booking URL is generated from your booking engine domain
================================ */
function toSafeListingFacts(listing) {
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

/* ===============================
   UNIT SUGGESTIONS
================================ */
function suggestUnits(message, listings) {
  const msg = (message || "").toLowerCase();
  const words = msg.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

  const scored = listings.map((l) => {
    const hay = `${l.name || ""} ${l.internalListingName || ""} ${l.externalListingName || ""} ${l.airbnbName || ""}`.toLowerCase();
    let score = 0;

    for (const w of words) {
      if (hay.includes(w)) score += 1;
    }

    return { name: l.name, score };
  });

  const matches = scored
    .filter((x) => x.score > 0 && x.name)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // If we found fewer than 3, fill with defaults
  if (matches.length < 3) {
    const already = new Set(matches.map((m) => m.name));
    for (const l of listings) {
      if (l.name && !already.has(l.name)) {
        matches.push({ name: l.name, score: 0 });
        already.add(l.name);
      }
      if (matches.length === 3) break;
    }
  }

  return matches;
}

/* ===============================
   LISTING NAME MATCHING (supports nicknames)
================================ */
function findListingIdFromMessage(message, listings) {
  const msg = (message || "").toLowerCase();
  const candidates = [];

  for (const l of listings) {
    const names = [l.name, l.internalListingName, l.externalListingName, l.airbnbName]
      .filter((n) => n != null)
      .map((n) => String(n).trim())
      .filter((n) => n.length >= 4);

    for (const name of names) {
      candidates.push({
        id: l.id,
        nameLower: name.toLowerCase(),
        length: name.length,
      });
    }
  }

  // Longest names first to reduce false positives
  candidates.sort((a, b) => b.length - a.length);

  // Strong match: full phrase present
  for (const c of candidates) {
    if (msg.includes(c.nameLower)) return c.id;
  }

  // Nickname/partial match: most meaningful words (>=3 chars) present
  for (const c of candidates) {
    const words = c.nameLower.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length === 0) continue;

    let hits = 0;
    for (const w of words) {
      if (msg.includes(w)) hits += 1;
    }

    // Accept if most words match (e.g. "Joy Suite" -> "Joy Lodge Suite")
    if (hits >= Math.max(2, Math.ceil(words.length * 0.6))) {
      return c.id;
    }
  }

  return null;
}

/* ===============================
   AVAILABILITY HELPERS
================================ */

function isAvailabilityQuestion(message) {
  return /available|availability|open|vacancy|booked|reserve/i.test(message || "");
}

function summarizeAvailabilityWithAlternatives(calendarDays, start, end) {
  const daysArr = Array.isArray(calendarDays) ? calendarDays : [];
  const blocked = daysArr.filter((d) => d?.isAvailable === 0);

  if (blocked.length === 0) {
    return {
      available: true,
      suggestedStart: null,
      message: `Yes — this unit is available from ${start} to ${end}.`,
    };
  }

  const day = blocked[0];

  const nextAvailable = daysArr.find((d) => {
    const arrivalOk =
      d?.closedOnArrival === 0 ||
      d?.closedOnArrival === null ||
      d?.closedOnArrival === undefined;
    return d?.isAvailable === 1 && arrivalOk;
  });

  const suggestedStart = nextAvailable ? nextAvailable.date : null;

  let suggestion = "";
  if (nextAvailable?.date) {
    const minStay =
      nextAvailable.minimumStay && nextAvailable.minimumStay > 1
        ? `${nextAvailable.minimumStay} nights`
        : "your desired stay length";
    suggestion = ` It is available starting ${nextAvailable.date} for a minimum stay of ${minStay}.`;
  }

  if (day?.minimumStay && day.minimumStay > 1) {
    return {
      available: false,
      suggestedStart,
      message:
        `No — this unit requires a minimum stay of ${day.minimumStay} nights starting on ${day.date}.` +
        suggestion,
    };
  }

  if (day?.closedOnArrival === 1) {
    return {
      available: false,
      suggestedStart,
      message: `No — check-in is not allowed on ${day.date} for this unit.` + suggestion,
    };
  }

  if (day?.closedOnDeparture === 1) {
    return {
      available: false,
      suggestedStart,
      message: `No — check-out is not allowed on ${day.date} for this unit.` + suggestion,
    };
  }

  if (day?.status === "reserved") {
    return {
      available: false,
      suggestedStart,
      message: `No — this unit is already booked on ${day.date}.` + suggestion,
    };
  }

  return {
    available: false,
    suggestedStart,
    message: `No — this unit is not available for the selected dates.` + suggestion,
  };
}

function addDays(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function extractDates(message) {
  const msg = (message || "").toLowerCase();

  // ----------------------
  // Helpers (defined first so they are in-scope)
  // ----------------------

  // Returns YYYY-MM-DD for "today + offsetDays" in a specific IANA timezone
  function isoDateInTimeZoneDaysFromNow(timeZone, offsetDays) {
    const now = new Date();

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const d = parts.find((p) => p.type === "day").value;

    const base = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    base.setUTCDate(base.getUTCDate() + offsetDays);

    const yy = base.getUTCFullYear();
    const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(base.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  // "this or next" weekday relative to today in timezone.
  // weekdayIndex: 0=Sun ... 6=Sat
  function isoDateThisOrNextWeekday(timeZone, weekdayIndex) {
    const todayIso = isoDateInTimeZoneDaysFromNow(timeZone, 0);
    const [y, m, d] = todayIso.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));

    const todayDow = base.getUTCDay();
    let delta = weekdayIndex - todayDow;
    if (delta < 0) delta += 7; // upcoming

    const target = new Date(base);
    target.setUTCDate(base.getUTCDate() + delta);

    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(
      target.getUTCDate()
    ).padStart(2, "0")}`;
  }

  // Weekday in next week specifically
  function isoDateNextWeekdayFromNextWeek(timeZone, weekdayIndex) {
    const todayIso = isoDateInTimeZoneDaysFromNow(timeZone, 0);
    const [y, m, d] = todayIso.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));

    const todayDow = base.getUTCDay();
    const daysToNextWeekStart = (7 - todayDow) % 7 || 7; // at least 7
    const nextWeekStart = new Date(base);
    nextWeekStart.setUTCDate(base.getUTCDate() + daysToNextWeekStart);

    const delta = weekdayIndex - nextWeekStart.getUTCDay(); // from Sunday
    const target = new Date(nextWeekStart);
    target.setUTCDate(target.getUTCDate() + delta);

    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(
      target.getUTCDate()
    ).padStart(2, "0")}`;
  }

  function parseSingleWeekday(msg, timeZone) {
    const weekdayMap = {
      sunday: 0, sun: 0,
      monday: 1, mon: 1,
      tuesday: 2, tue: 2, tues: 2,
      wednesday: 3, wed: 3,
      thursday: 4, thu: 4, thur: 4, thurs: 4,
      friday: 5, fri: 5,
      saturday: 6, sat: 6,
    };

    const tokens = Object.keys(weekdayMap).sort((a, b) => b.length - a.length);
    for (const t of tokens) {
      const re = new RegExp(`\\b(this|next)?\\s*${t}\\b`, "i");
      const m = msg.match(re);
      if (m) {
        const which = (m[1] || "").toLowerCase(); // "this" | "next" | ""
        const dow = weekdayMap[t];

        if (which === "next") return isoDateNextWeekdayFromNextWeek(timeZone, dow);
        return isoDateThisOrNextWeekday(timeZone, dow);
      }
    }
    return null;
  }

  function parseWeekdayRange(msg, timeZone) {
    const weekdayMap = {
      sun: 0, sunday: 0,
      mon: 1, monday: 1,
      tue: 2, tues: 2, tuesday: 2,
      wed: 3, wednesday: 3,
      thu: 4, thur: 4, thurs: 4, thursday: 4,
      fri: 5, friday: 5,
      sat: 6, saturday: 6,
    };

    const cleaned = msg.replace(/[–—]/g, "-");
    const rangeRe =
      /\b(sun(day)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?)\b\s*(to|through|-)\s*\b(sun(day)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?)\b/i;

    const m = cleaned.match(rangeRe);
    if (!m) return null;

    const startWord = m[1].toLowerCase();
    const endWord = m[7].toLowerCase();

    const startKey = startWord.slice(0, 3);
    const endKey = endWord.slice(0, 3);

    const startDow = weekdayMap[startKey] ?? weekdayMap[startWord];
    const endDow = weekdayMap[endKey] ?? weekdayMap[endWord];
    if (startDow == null || endDow == null) return null;

    const start = isoDateThisOrNextWeekday(timeZone, startDow);

    let end = start;
    let steps = 0;
    while (steps < 8) {
      const [y, mo, d] = end.split("-").map(Number);
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCDay() === endDow) break;
      end = addDays(end, 1);
      steps += 1;
    }

    if (steps >= 8) return null;
    if (end === start) end = addDays(start, 1);

    return { start, end };
  }

  function monthDayToIso(timeZone, monthNum, dayNum) {
    const todayIso = isoDateInTimeZoneDaysFromNow(timeZone, 0);
    const [ty] = todayIso.split("-").map(Number);

    let year = ty;
    const candidate = `${year}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    if (candidate < todayIso) year = ty + 1;

    return `${year}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
  }

  function parseMonthNameRange(msg, timeZone) {
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

    const re =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*(?:to|through|-)\s*(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(\d{1,2}))\b/i;

    const m = msg.match(re);
    if (!m) return null;

    const m1 = months[m[1].toLowerCase()];
    const d1 = Number(m[2]);
    const m2 = m[3] ? months[m[3].toLowerCase()] : m1;
    const d2 = Number(m[4]);

    if (!m1 || !m2 || !Number.isFinite(d1) || !Number.isFinite(d2)) return null;

    const start = monthDayToIso(timeZone, m1, d1);
    const end = monthDayToIso(timeZone, m2, d2);

    if (start === end) return { start, end: addDays(start, 1) };
    return { start, end };
  }

  // -----------------------------------------
  // 1) Explicit ISO range: YYYY-MM-DD ... YYYY-MM-DD
  // -----------------------------------------
  const isoMatches = msg.match(/\d{4}-\d{2}-\d{2}/g);
  if (isoMatches && isoMatches.length >= 2) {
    return { start: isoMatches[0], end: isoMatches[1] };
  }

  // -----------------------------------------
  // 2) Month name dates: "March 24" / "Mar 24"
  //    Also supports ranges: "March 24 to March 26"
  // -----------------------------------------
  const monthRange = parseMonthNameRange(msg, "America/New_York");
  if (monthRange) return monthRange;

  // -----------------------------------------
  // 3) Weekday range: "Friday to Sunday", "Fri-Sun", "Fri through Sun"
  // -----------------------------------------
  const weekdayRange = parseWeekdayRange(msg, "America/New_York");
  if (weekdayRange) return weekdayRange;

  // -----------------------------------------
  // 4) Relative phrases
  // -----------------------------------------
  if (msg.includes("tonight") || (msg.includes("today") && msg.includes("night"))) {
    const start = isoDateInTimeZoneDaysFromNow("America/New_York", 0);
    const end = isoDateInTimeZoneDaysFromNow("America/New_York", 1);
    return { start, end };
  }

  if (msg.includes("tomorrow")) {
    const start = isoDateInTimeZoneDaysFromNow("America/New_York", 1);
    const end = isoDateInTimeZoneDaysFromNow("America/New_York", 2);
    return { start, end };
  }

  if (msg.includes("day after tomorrow")) {
    const start = isoDateInTimeZoneDaysFromNow("America/New_York", 2);
    const end = isoDateInTimeZoneDaysFromNow("America/New_York", 3);
    return { start, end };
  }

  if (msg.includes("this weekend")) {
    const start = isoDateThisOrNextWeekday("America/New_York", 5); // Friday
    const end = addDays(start, 2); // checkout Sunday (2 nights)
    return { start, end };
  }

  if (msg.includes("next weekend")) {
    const start = isoDateNextWeekdayFromNextWeek("America/New_York", 5); // Friday of next week
    const end = addDays(start, 2);
    return { start, end };
  }

  // -----------------------------------------
  // 5) Single weekday: "this friday", "next friday", "friday night"
  // -----------------------------------------
  const singleWeekday = parseSingleWeekday(msg, "America/New_York");
  if (singleWeekday) {
    const start = singleWeekday;
    const end = addDays(start, 1);
    return { start, end };
  }

  // -----------------------------------------
  // 6) Fallback: single ISO date anywhere (YYYY-MM-DD) -> 1 night
  // -----------------------------------------
  if (isoMatches && isoMatches.length === 1) {
    const start = isoMatches[0];
    const end = addDays(start, 1);
    return { start, end };
  }

  return null;
}
/* ===============================
   ROUTES
================================ */

// Health check
app.get("/", (req, res) => {
  res.send("Chatbot server is running 🚀");
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

/* ---------- HOSTAWAY DEBUG ---------- */
app.get("/hostaway/test", async (req, res) => {
  try {
    const data = await getHostawayAccessToken();
    res.json({
      ok: true,
      token_type: data.token_type,
      expires_in: data.expires_in,
      token_preview: data.access_token.slice(0, 12) + "...",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/hostaway/safe-listing/:id", async (req, res) => {
  try {
    const tokenData = await getHostawayAccessToken();
    const resp = await fetch(`https://api.hostaway.com/v1/listings/${req.params.id}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Hostaway listing failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    res.json({ ok: true, safe: toSafeListingFacts(data.result) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- AVAILABILITY ENDPOINT ---------- */
app.get("/hostaway/availability/:id", async (req, res) => {
  try {
    const listingId = req.params.id;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({
        ok: false,
        error: "Missing start or end date (YYYY-MM-DD)",
      });
    }

    const tokenData = await getHostawayAccessToken();
    const accessToken = tokenData.access_token;

    // Treat `end` as checkout date (not a night stayed). Query calendar through end-1 day.
    const endForCalendar = addDays(end, -1);

    // If someone passes the same day for start/end, there's no stay to check.
    if (endForCalendar < start) {
      return res.status(400).json({
        ok: false,
        error: "End date must be after start date (checkout after check-in).",
      });
    }

    const url =
      `https://api.hostaway.com/v1/listings/${listingId}/calendar` +
      `?startDate=${start}&endDate=${endForCalendar}`;

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
    const days = data?.result || [];

    const summary = summarizeAvailabilityWithAlternatives(days, start, end);

    res.json({
      ok: true,
      listingId,
      start,
      end,
      ...summary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- CHAT ---------- */
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message || "";
    let listingId = req.body.listingId || null;

    const tokenData = await getHostawayAccessToken();
    const accessToken = tokenData.access_token;

    const listings = await getListingsCached(accessToken);

    // Detect listing from message if not explicitly provided
    if (!listingId) {
      listingId = findListingIdFromMessage(userMessage, listings);
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

    // If availability question AND user gave dates -> answer from Hostaway truth
    const dates = extractDates(userMessage);
    if (dates && isAvailabilityQuestion(userMessage)) {
      const endForCalendar = addDays(dates.end, -1);

      if (endForCalendar < dates.start) {
        return res.json({
          reply: "End date must be after start date (checkout after check-in).",
        });
      }

      const url =
        `https://api.hostaway.com/v1/listings/${listingId}/calendar` +
        `?startDate=${dates.start}&endDate=${endForCalendar}`;

      const calResp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Cache-control": "no-cache",
        },
      });

      if (!calResp.ok) {
        const text = await calResp.text();
        throw new Error(`Availability failed (${calResp.status}): ${text}`);
      }

      const calData = await calResp.json();
      const days = calData?.result || [];
      const data = summarizeAvailabilityWithAlternatives(days, dates.start, dates.end);

      // Fetch safe listing to get stable bookingUrl
      const listingResp = await fetch(`https://api.hostaway.com/v1/listings/${listingId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listingData = await listingResp.json();
      const safe = toSafeListingFacts(listingData.result);

      // Only include dates when the requested range is actually available
      let bookUrl = safe.bookingUrl;
      if (data?.available === true && dates?.start && dates?.end) {
        bookUrl = `${safe.bookingUrl}?start=${dates.start}&end=${dates.end}`;
      }

      const bookingLine = bookUrl ? `\n\nBook now: ${bookUrl}` : "";
      return res.json({
        reply: (data.message || "Availability check complete.") + bookingLine,
      });
    }

    // General Q&A: Fetch listing and build safe facts
    const listingResp = await fetch(`https://api.hostaway.com/v1/listings/${listingId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Cache-control": "no-cache",
      },
    });

    if (!listingResp.ok) {
      const text = await listingResp.text();
      throw new Error(`Hostaway listing failed (${listingResp.status}): ${text}`);
    }

    const listingData = await listingResp.json();
    const safe = toSafeListingFacts(listingData.result);
    const safeFactsText = JSON.stringify(safe, null, 2);

    const aiResponse = await client.responses.create({
      model: "gpt-4o-mini",
      instructions:
        "You are a customer service assistant for AmishCountryLodging.com. " +
        "Only answer using the UNIT DATA provided. " +
        "If the unit is unclear, ask which unit they mean. " +
        "Never reveal passwords, door codes, WiFi credentials, or private instructions.",
      input: [
        {
          role: "user",
          content: `UNIT DATA:\n${safeFactsText}\n\nQUESTION:\n${userMessage}`,
        },
      ],
    });

    const bookingLine = safe.bookingUrl ? `\n\nBook now: ${safe.bookingUrl}` : "";
        res.json({ reply: aiResponse.output_text + bookingLine });
  } catch (err) {
    console.error(err);
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
    );

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
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});