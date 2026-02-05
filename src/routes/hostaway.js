// src/routes/hostaway.js
import express from "express";
import { addDays, summarizeAvailabilityWithAlternatives } from "../lib/availability.js";
import {
  getHostawayAccessToken,
  toSafeListingFacts,
  fetchListingById,
  fetchCalendarRange,
} from "../lib/hostaway.js";

export function createHostawayRouter() {
  const router = express.Router();

  /* ---------- HOSTAWAY DEBUG ---------- */
  router.get("/test", async (req, res) => {
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

  router.get("/safe-listing/:id", async (req, res) => {
    try {
      const tokenData = await getHostawayAccessToken();
      const listing = await fetchListingById(req.params.id, tokenData.access_token);
      res.json({ ok: true, safe: toSafeListingFacts(listing) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /* ---------- AVAILABILITY ENDPOINT ---------- */
  router.get("/availability/:id", async (req, res) => {
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

      if (endForCalendar < start) {
        return res.status(400).json({
          ok: false,
          error: "End date must be after start date (checkout after check-in).",
        });
      }

      const days = await fetchCalendarRange(listingId, start, endForCalendar, accessToken);
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

  return router;
}