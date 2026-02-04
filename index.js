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
      .filter(Boolean)
      .map((n) => n.trim())
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
  const matches = (message || "").match(/\d{4}-\d{2}-\d{2}/g);
  if (!matches || matches.length < 2) return null;
  return { start: matches[0], end: matches[1] };
}

function isAvailabilityQuestion(message) {
  return /available|availability|open|vacancy|booked|reserve/i.test(message || "");
}

/**
 * Summarize availability + provide:
 * - specific WHY (minimum stay, arrival/departure restriction, booked)
 * - suggestedStart (next available check-in date)
 * - helpful alternative suggestion text
 */
function summarizeAvailabilityWithAlternatives(calendarDays, start, end) {
  const blocked = calendarDays.filter((d) => d.isAvailable === 0);

  if (blocked.length === 0) {
    return {
      available: true,
      suggestedStart: null,
      message: `Yes — this unit is available from ${start} to ${end}.`,
    };
  }

  const day = blocked[0];

  const nextAvailable = calendarDays.find((d) => {
    const arrivalOk =
      d.closedOnArrival === 0 ||
      d.closedOnArrival === null ||
      d.closedOnArrival === undefined;
    return d.isAvailable === 1 && arrivalOk;
  });

  const suggestedStart = nextAvailable ? nextAvailable.date : null;

  let suggestion = "";
  if (nextAvailable) {
    const minStay =
      nextAvailable.minimumStay && nextAvailable.minimumStay > 1
        ? `${nextAvailable.minimumStay} nights`
        : "your desired stay length";
    suggestion = ` It is available starting ${nextAvailable.date} for a minimum stay of ${minStay}.`;
  }

  if (day.minimumStay && day.minimumStay > 1) {
    return {
      available: false,
      suggestedStart,
      message:
        `No — this unit requires a minimum stay of ${day.minimumStay} nights starting on ${day.date}.` +
        suggestion,
    };
  }

  if (day.closedOnArrival === 1) {
    return {
      available: false,
      suggestedStart,
      message: `No — check-in is not allowed on ${day.date} for this unit.` + suggestion,
    };
  }

  if (day.closedOnDeparture === 1) {
    return {
      available: false,
      suggestedStart,
      message: `No — check-out is not allowed on ${day.date} for this unit.` + suggestion,
    };
  }

  if (day.status === "reserved") {
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