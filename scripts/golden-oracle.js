import "dotenv/config";
import { spawn } from "node:child_process";
import {
  getHostawayAccessToken,
  getListingsCached,
  fetchListingByIdCached,
  fetchCalendarRange,
  toSafeListingFacts,
} from "../src/lib/hostaway.js";
import { summarizeAvailabilityWithAlternatives, addDays } from "../src/lib/availability.js";
import { hasAmenity } from "../src/lib/inventory.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChat(message, sessionId) {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Mode": "1",
    },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function parseYesNoAvailability(reply) {
  const text = String(reply || "").trim().toLowerCase();
  if (text.startsWith("yes")) return true;
  if (text.startsWith("no")) return false;
  return null;
}

function parseListNames(reply) {
  const lines = String(reply || "").split("\n");
  const names = [];
  for (const line of lines) {
    const m = line.match(/^\s*[•\-*]\s+\[([^\]]+)\]\(/);
    if (m) {
      names.push(m[1].trim());
      continue;
    }
    const p = line.match(/^\s*[•\-*]\s+([^—-]+?)\s*(?:—|$)/);
    if (p) {
      names.push(p[1].trim());
    }
  }
  return names;
}

async function run() {
  let server = null;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["index.js"], { stdio: "inherit" });
    await sleep(1500);
  }

  const failures = [];
  const tokenData = await getHostawayAccessToken();
  const accessToken = tokenData.access_token;
  const listings = await getListingsCached(accessToken);

  const byName = new Map(listings.map((l) => [String(l.name), l]));
  const mustGet = (name) => {
    const hit = byName.get(name);
    if (!hit) throw new Error(`Listing not found: ${name}`);
    return hit;
  };

  // 1) Availability truth checks
  const availabilityCases = [
    {
      unit: "Joy Lodge Suite",
      message: "Is Joy Lodge Suite available April 1 for two nights?",
      start: "2026-04-01",
      end: "2026-04-03",
    },
    {
      unit: "Treehouse #3",
      message: "Is treehouse 3 available today?",
      start: "2026-02-06",
      end: "2026-02-07",
    },
    {
      unit: "Red Fern Cabin",
      message: "Is red fern available this weekend?",
      start: "2026-02-06",
      end: "2026-02-08",
    },
  ];

  for (const c of availabilityCases) {
    const listing = mustGet(c.unit);
    const chat = await postChat(c.message, `oracle-${c.unit.replace(/\W+/g, "-").toLowerCase()}`);
    const route = chat.meta?.route;
    if (route !== "availability") {
      failures.push({ type: "route", case: c.message, expected: "availability", actual: route, reply: chat.reply });
      continue;
    }

    const endForCalendar = addDays(c.end, -1);
    const days = await fetchCalendarRange(listing.id, c.start, endForCalendar, accessToken);
    const summary = summarizeAvailabilityWithAlternatives(days, c.start, c.end);
    const actual = parseYesNoAvailability(chat.reply);
    if (actual == null || actual !== Boolean(summary.available)) {
      failures.push({
        type: "availability_truth",
        case: c.message,
        expectedAvailable: Boolean(summary.available),
        actualFromReply: actual,
        reply: chat.reply,
      });
    }
  }

  // 2) Time format checks (must be 12-hour)
  const timeCases = [
    "What time is check-in for Joy Lodge Suite?",
    "What time is check-out for Treehouse #3?",
  ];
  for (const message of timeCases) {
    const chat = await postChat(message, "oracle-time-format");
    if (!/\b(am|pm)\b/i.test(chat.reply) || /\b\d{1,2}:\d{2}\b/.test(chat.reply.replace(/\b(1[0-2]|0?[1-9]):[0-5][0-9]\s?(am|pm)\b/gi, ""))) {
      failures.push({ type: "time_format", case: message, reply: chat.reply });
    }
  }

  // 3) Inventory filter continuity: hot tubs -> also 2 bedrooms
  const inv1 = await postChat("Which units have hot tubs?", "oracle-inventory-continuity");
  const inv2 = await postChat("Do any of them also have 2 bedrooms?", "oracle-inventory-continuity");
  if (inv1.meta?.route !== "amenity_inventory" || inv2.meta?.route !== "amenity_inventory") {
    failures.push({
      type: "inventory_route",
      expected: "amenity_inventory",
      actual1: inv1.meta?.route,
      actual2: inv2.meta?.route,
    });
  }

  const firstSet = new Set(parseListNames(inv1.reply));
  const secondSet = new Set(parseListNames(inv2.reply));
  for (const name of secondSet) {
    if (!firstSet.has(name)) {
      failures.push({ type: "inventory_filter_drift", name, reply2: inv2.reply });
      break;
    }
  }

  // 4) Deterministic set sanity for "hot tubs + 2 bedrooms"
  const safes = await Promise.all(
    listings.map(async (l) => toSafeListingFacts(await fetchListingByIdCached(l.id, accessToken), { audience: "postbooking" }))
  );
  const expectedHotTub2Bd = new Set(
    safes
      .filter((s) => (hasAmenity(s, "hot tub") || hasAmenity(s, "jacuzzi")) && Number(s.bedrooms) >= 2)
      .map((s) => s.name)
  );
  for (const name of secondSet) {
    if (!expectedHotTub2Bd.has(name)) {
      failures.push({ type: "inventory_truth", name, expectedRule: "hot tub + >=2 bedrooms" });
      break;
    }
  }

  if (server) server.kill("SIGINT");

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, checks: 4 }, null, 2));
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
