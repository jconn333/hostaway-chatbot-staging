// src/lib/listings.js

/* ===============================
   UNIT SUGGESTIONS
================================ */
export function suggestUnits(message, listings) {
  const msg = (message || "").toLowerCase();
  const words = msg.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

  const scored = listings.map((l) => {
    const hay = `${l.name || ""} ${l.internalListingName || ""} ${
      l.externalListingName || ""
    } ${l.airbnbName || ""}`.toLowerCase();

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
export function findListingIdFromMessage(message, listings) {
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