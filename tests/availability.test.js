import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDates,
  summarizeAvailabilityWithAlternatives,
  findAlternativeStays,
  addDays,
} from "../src/lib/availability.js";

test("extractDates parses month-day en-dash range", () => {
  const dates = extractDates("Which units are open Feb 8–Feb 10?");
  assert.ok(dates);
  assert.equal(dates.start.endsWith("-02-08"), true);
  assert.equal(dates.end.endsWith("-02-10"), true);
});

test("extractDates parses stay length wording", () => {
  const dates = extractDates("Need Joy Lodge Suite Feb 12 for two nights");
  assert.ok(dates);
  assert.equal(dates.start.endsWith("-02-12"), true);
  assert.equal(dates.end, addDays(dates.start, 2));
});

test("summarizeAvailabilityWithAlternatives returns reserved reason", () => {
  const out = summarizeAvailabilityWithAlternatives(
    [{ date: "2026-02-06", isAvailable: 0, status: "reserved" }],
    "2026-02-06",
    "2026-02-08"
  );
  assert.equal(out.available, false);
  assert.equal(out.reasonCode, "reserved");
});

test("summarizeAvailabilityWithAlternatives returns minimum_stay reason", () => {
  const out = summarizeAvailabilityWithAlternatives(
    [{ date: "2026-03-01", isAvailable: 0, minimumStay: 3 }],
    "2026-03-01",
    "2026-03-03"
  );
  assert.equal(out.available, false);
  assert.equal(out.reasonCode, "minimum_stay");
});

test("summarizeAvailabilityWithAlternatives returns available reason", () => {
  const out = summarizeAvailabilityWithAlternatives(
    [{ date: "2026-03-01", isAvailable: 1, status: "available" }],
    "2026-03-01",
    "2026-03-03"
  );
  assert.equal(out.available, true);
  assert.equal(out.reasonCode, "available");
});

test("findAlternativeStays returns closest matching windows", () => {
  const days = [
    { date: "2026-03-01", isAvailable: 0, status: "reserved" },
    { date: "2026-03-02", isAvailable: 0, status: "reserved" },
    { date: "2026-03-03", isAvailable: 1, status: "available", minimumStay: 2 },
    { date: "2026-03-04", isAvailable: 1, status: "available", minimumStay: 2 },
    { date: "2026-03-05", isAvailable: 1, status: "available", minimumStay: 1 },
  ];
  const out = findAlternativeStays(days, "2026-03-01", 2, 5, 2);
  assert.equal(out.length > 0, true);
  assert.equal(out[0].start, "2026-03-03");
  assert.equal(out[0].end, "2026-03-05");
});

test("findAlternativeStays honors minimum stay for the check-in day", () => {
  const days = [
    { date: "2026-03-10", isAvailable: 1, status: "available", minimumStay: 4 },
    { date: "2026-03-11", isAvailable: 1, status: "available", minimumStay: 1 },
    { date: "2026-03-12", isAvailable: 1, status: "available", minimumStay: 1 },
    { date: "2026-03-13", isAvailable: 1, status: "available", minimumStay: 1 },
    { date: "2026-03-14", isAvailable: 1, status: "available", minimumStay: 1 },
  ];
  const out = findAlternativeStays(days, "2026-03-10", 2, 5, 1);
  assert.equal(out[0].nights >= 4, true);
});
