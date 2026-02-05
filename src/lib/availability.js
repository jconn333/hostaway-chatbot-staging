// src/lib/availability.js

export function isAvailabilityQuestion(message) {
  return /available|availability|open|vacancy|booked|reserve/i.test(message || "");
}

export function isInventoryAvailabilityQuestion(message) {
  const msg = (message || "").toLowerCase();
  return (
    /\b(which|what|any|show me|list)\b/.test(msg) &&
    /\b(available|availability|open|vacancy)\b/.test(msg)
  );
}

export function getTodayIso(timeZone = "America/New_York") {
  return isoDateInTimeZoneDaysFromNow(timeZone, 0);
}

export function findNextAvailableWeekend(calendarDays, startDate, lookaheadDays = 180) {
  const daysArr = Array.isArray(calendarDays) ? calendarDays : [];
  const byDate = new Map(daysArr.map((d) => [d.date, d]));

  const isAvailableNight = (d) =>
    !d || (d.isAvailable !== 0 && d.status !== "reserved");

  const isArrivalOk = (d) => !d || d.closedOnArrival !== 1;
  const isDepartureOk = (d) => !d || d.closedOnDeparture !== 1;

  for (let i = 0; i <= lookaheadDays; i++) {
    const friday = addDays(startDate, i);
    if (weekdayOfIso(friday) !== 5) continue; // Friday

    const saturday = addDays(friday, 1);
    const sunday = addDays(friday, 2);
    const monday = addDays(friday, 3);

    const dayFri = byDate.get(friday);
    const daySat = byDate.get(saturday);
    const daySun = byDate.get(sunday);
    const dayMon = byDate.get(monday);

    if (!isAvailableNight(dayFri) || !isAvailableNight(daySat)) continue;
    if (!isArrivalOk(dayFri)) continue;
    if (daySun && !isDepartureOk(daySun)) continue;
    const minStay = dayFri?.minimumStay || daySat?.minimumStay || 2;

    if (minStay <= 2) {
      return { start: friday, end: sunday, minStay: 2, suggestedEnd: null };
    }

    // Weekend is open but requires longer stay
    // Suggest a 3-night Fri–Mon if available
    const canExtend =
      isAvailableNight(daySun) &&
      isAvailableNight(dayMon) &&
      isDepartureOk(dayMon);
    const suggestedEnd = canExtend ? monday : null;
    return { start: friday, end: sunday, minStay, suggestedEnd };
  }

  return null;
}

export function explainWeekendSearch(calendarDays, startDate, lookaheadDays = 180) {
  const daysArr = Array.isArray(calendarDays) ? calendarDays : [];
  const byDate = new Map(daysArr.map((d) => [d.date, d]));
  const notes = [];

  const isAvailableNight = (d) =>
    !d || (d.isAvailable !== 0 && d.status !== "reserved");
  const isArrivalOk = (d) => !d || d.closedOnArrival !== 1;
  const isDepartureOk = (d) => !d || d.closedOnDeparture !== 1;

  let checked = 0;
  for (let i = 0; i <= lookaheadDays; i++) {
    const friday = addDays(startDate, i);
    if (weekdayOfIso(friday) !== 5) continue;
    const saturday = addDays(friday, 1);
    const sunday = addDays(friday, 2);
    const dayFri = byDate.get(friday);
    const daySat = byDate.get(saturday);
    const daySun = byDate.get(sunday);
    checked += 1;
    if (notes.length < 10) {
      notes.push(
        `${friday}: Fri avail=${dayFri?.isAvailable} status=${dayFri?.status} arrival=${dayFri?.closedOnArrival} minStay=${dayFri?.minimumStay}; ` +
          `Sat ${saturday} avail=${daySat?.isAvailable} status=${daySat?.status} minStay=${daySat?.minimumStay}; ` +
          `Sun ${sunday} depart=${daySun?.closedOnDeparture} minStay=${daySun?.minimumStay}`
      );
    }
    if (!isAvailableNight(dayFri) || !isAvailableNight(daySat)) continue;
    if (!isArrivalOk(dayFri)) continue;
    if (!isDepartureOk(daySun)) continue;
    if (dayFri.minimumStay && dayFri.minimumStay > 2) continue;
  }

  return {
    daysFetched: daysArr.length,
    fridaysChecked: checked,
    samples: notes,
  };
}

export function addDays(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Summarize availability + provide:
 * - specific WHY (minimum stay, arrival/departure restriction, booked)
 * - suggestedStart (next available check-in date)
 */
export function summarizeAvailabilityWithAlternatives(calendarDays, start, end) {
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

  if (day?.status === "reserved") {
    return {
      available: false,
      suggestedStart,
      message:
        `No — this unit is already booked during ${start} to ${end} (booked on ${day.date}).` +
        suggestion,
    };
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

  return {
    available: false,
    suggestedStart,
    message: `No — this unit is not available for the selected dates.` + suggestion,
  };
}

export function extractDates(message, timeZone = "America/New_York") {
  const msg = (message || "").toLowerCase();

  // 1) Explicit ISO range: YYYY-MM-DD ... YYYY-MM-DD
  const isoMatches = msg.match(/\d{4}-\d{2}-\d{2}/g);
  if (isoMatches && isoMatches.length >= 2) {
    return { start: isoMatches[0], end: isoMatches[1] };
  }

  // 2) Month name dates: "March 24" / "Mar 24" (supports ranges)
  const monthRange = parseMonthNameRange(msg, timeZone);
  if (monthRange) return monthRange;

  // 3) Weekday range: "Friday to Sunday", "Fri-Sun", "Fri through Sun"
  const weekdayRange = parseWeekdayRange(msg, timeZone);
  if (weekdayRange) return weekdayRange;

  // 4) Relative phrases
  if (msg.includes("tonight") || (msg.includes("today") && msg.includes("night"))) {
    const start = isoDateInTimeZoneDaysFromNow(timeZone, 0);
    const end = isoDateInTimeZoneDaysFromNow(timeZone, 1);
    return { start, end };
  }

  // IMPORTANT: check "day after tomorrow" BEFORE "tomorrow"
  if (msg.includes("day after tomorrow")) {
    const start = isoDateInTimeZoneDaysFromNow(timeZone, 2);
    const end = isoDateInTimeZoneDaysFromNow(timeZone, 3);
    return { start, end };
  }

  if (msg.includes("tomorrow")) {
    const start = isoDateInTimeZoneDaysFromNow(timeZone, 1);
    const end = isoDateInTimeZoneDaysFromNow(timeZone, 2);
    return { start, end };
  }

  if (msg.includes("this weekend")) {
    const start = isoDateThisOrNextWeekday(timeZone, 5); // Friday
    const end = addDays(start, 2); // checkout Sunday (2 nights)
    return { start, end };
  }

  if (msg.includes("next weekend")) {
    const start = isoDateNextWeekdayFromNextWeek(timeZone, 5); // Friday of next week
    const end = addDays(start, 2);
    return { start, end };
  }

  // 5) Single weekday: "this friday", "next friday", "friday night"
  const singleWeekday = parseSingleWeekday(msg, timeZone);
  if (singleWeekday) {
    const start = singleWeekday;
    const end = addDays(start, 1);
    return { start, end };
  }

  // 6) Fallback: single ISO date anywhere -> 1 night
  if (isoMatches && isoMatches.length === 1) {
    const start = isoMatches[0];
    const end = addDays(start, 1);
    return { start, end };
  }

  return null;
}

// ----------------------
// Helpers (module-private)
// ----------------------

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

function weekdayOfIso(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCDay();
}

// weekdayIndex: 0=Sun ... 6=Sat
function isoDateThisOrNextWeekday(timeZone, weekdayIndex) {
  const todayIso = isoDateInTimeZoneDaysFromNow(timeZone, 0);
  const [y, m, d] = todayIso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));

  const todayDow = base.getUTCDay();
  let delta = weekdayIndex - todayDow;
  if (delta < 0) delta += 7;

  const target = new Date(base);
  target.setUTCDate(base.getUTCDate() + delta);

  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(
    target.getUTCDate()
  ).padStart(2, "0")}`;
}

function isoDateNextWeekdayFromNextWeek(timeZone, weekdayIndex) {
  const todayIso = isoDateInTimeZoneDaysFromNow(timeZone, 0);
  const [y, m, d] = todayIso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));

  const todayDow = base.getUTCDay();
  const daysToNextWeekStart = (7 - todayDow) % 7 || 7;
  const nextWeekStart = new Date(base);
  nextWeekStart.setUTCDate(base.getUTCDate() + daysToNextWeekStart);

  const delta = weekdayIndex - nextWeekStart.getUTCDay(); // Sunday-based
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
      const which = (m[1] || "").toLowerCase();
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

function monthDayToIso(timeZone, monthNum, dayNum) {
  const todayIso = isoDateInTimeZoneDaysFromNow(timeZone, 0);
  const [ty] = todayIso.split("-").map(Number);

  let year = ty;
  const candidate = `${year}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
  if (candidate < todayIso) year = ty + 1;

  return `${year}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
}
