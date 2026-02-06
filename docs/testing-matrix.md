# Chatbot Test Matrix

## Availability
- Relative dates: `tonight`, `tomorrow night`, `this weekend`, `next weekend`
- Explicit ranges: `YYYY-MM-DD`, month-day range, en-dash range
- Stay length: `2 nights`, `3 nights`, `for two nights`
- Unit-scoped availability: exact listing + range
- Inventory availability: all units, filtered by `suite`/`cabin`
- Failure reasons: `reserved`, `minimum_stay`, `closed_on_arrival`, `closed_on_departure`

## Policy
- Global policies: smoking, parties
- Per-unit policies: pets
- Follow-ups: `which ones then?`, `do you allow dogs?`
- Session continuity: follow-up without repeating unit

## Amenities
- Listing-level: `does X have Y?`
- Inventory-level: `which units have Y?`
- Synonyms: `hot tub`, `jacuzzi`, `jetted tub`
- Multi-constraint: `pet friendly and hot tub`

## Compare and Proximity
- Compare explicit two units
- Proximity explicit two units
- Proximity when session unit + referenced unit

## Session and Follow-ups
- Reuse prior dates (`what about that?`)
- Reuse prior listing (`and checkout?`)
- Disambiguation then resolve (`Joy Lodge Suite`)
- Deep 3-4 turn chains in one session:
  - availability -> month-weekend follow-up -> amenity -> check-in time
  - generic pet policy -> pet-friendly list -> named unit follow-up -> smoking follow-up

## Monitoring
- `GET /healthz`
- `GET /metrics`
- Synthetic checks:
  - availability
  - policy
  - amenity inventory

## Golden Layers
- Baseline deterministic regression suite:
  - `npm run golden:core` (fast PR gate)
  - `npm run golden:full` (full fixed prompt set)
- Matrix parameterized suite:
  - `npm run golden:matrix` (unit-rotated prompt templates)
- Combined nightly coverage:
  - `npm run golden:all` (baseline full + matrix)
