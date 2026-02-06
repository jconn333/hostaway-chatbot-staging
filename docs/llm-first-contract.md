# LLM-First Contract

## Purpose
Define a stable operating contract for the chatbot so we get natural conversation quality from the model without losing production reliability.

This contract is **binding for implementation** in this repository.

## Product Principle
1. The model owns language understanding and conversational planning.
2. Deterministic code owns safety, truth, policy constraints, and output consistency.
3. Tool-backed facts override model guesses.

## Scope
Applies to all user-facing chat flows in `POST /chat` and all test/CI gates that validate those flows.

## Model Responsibilities
The model is authoritative for:
1. User intent interpretation from natural language, including typos and shorthand.
2. Conversational continuity decisions (follow-up references like `it`, `that one`, `what about March?`).
3. Clarifying-question decisions when required context is missing.
4. Natural response phrasing and tone.

The model is **not** authoritative for:
1. Availability truth.
2. Listing fact truth (beds, amenities, policy, check-in/out).
3. Allowed Hostaway actions.
4. Link formatting and compliance rules.

## Deterministic Code Responsibilities
Code is authoritative for:
1. **Safety**
   1. Hostaway API is read-only (`GET` only except token request).
   2. No write/update/delete actions to Hostaway under any condition.
2. **Truth Resolution**
   1. Availability answers come from Hostaway calendar/tool results.
   2. Listing facts come from safe listing facts from Hostaway data.
3. **State & Routing Invariants**
   1. Active listing continuity in session memory.
   2. Route-level intent persistence for follow-ups.
   3. Inventory filter continuity across turns.
4. **Output Invariants**
   1. Time formatting is always 12-hour (`am/pm`).
   2. Booking output uses clean markdown links, not raw long URLs in prose blocks.
   3. “Book now” label must map to a valid booking target.

## Conflict Resolution Rule
When model output conflicts with deterministic truth:
1. Deterministic truth wins.
2. Response should be regenerated with corrected facts.
3. A debug/test metadata trace should record the correction path in non-production test mode.

## Request Handling Contract
For each message:
1. Normalize input text (typo normalization where configured).
2. Model produces intent/planning signal.
3. Deterministic router validates/plumbs route with session context.
4. Required tools execute for truth domains.
5. Response is generated and then normalized by output invariants.
6. Route-level metadata is stored for next-turn continuity.

## Test Mode Contract
When `X-Test-Mode: 1` and `ENABLE_TEST_MODE=true`:
1. Response includes `meta` with route/intent/listing/session/dates/filters/replyType.
2. Golden tests assert route correctness and continuity, not only text snippets.

Production default:
1. Test mode disabled unless explicitly enabled.

## Required Test Gates
### PR Required
1. `npm test`
2. `npm run golden:core`
3. `npm run golden:bugs`

### Pre-merge to main Required
1. `npm run golden:all`
2. `npm run golden:oracle`

### Nightly Required
1. `npm run golden:fuzz -- --count 200 --seed rotating`
2. `npm run monitor:synthetic`

On nightly failure:
1. Send failing seed + transcript to Slack.
2. Convert failure into `golden-bugs` case before closing incident.

## Bug Replay Contract
Any user-reported mismatch that is reproducible must be added to `scripts/golden-bugs.json` with:
1. Multi-turn transcript.
2. Expected route metadata.
3. Expected response traits.

No bug is considered fixed until bug-replay test passes.

## Data/Tool Trust Levels
1. Hostaway calendar/listing data: Source of truth for availability and listing facts.
2. Booking engine links: Source of truth for navigation target format.
3. Model-generated claims with no tool support: Non-authoritative.

## Change Management Rules
1. Changes touching routing/session/availability/policy must run full golden + oracle locally before merge.
2. Do not bypass read-only guardrails.
3. Do not merge behavior-only prompt changes without golden regression check.

## Non-Goals (Current)
1. Price optimization/price correctness.
2. Automated booking transactions.
3. Write-back integrations with Hostaway.

## Acceptance Criteria For “Production Ready”
1. No P0/P1 failures in `golden:bugs` for 7 consecutive days.
2. Nightly fuzz pass rate >= 99% for 7 days.
3. Oracle checks stable with zero deterministic mismatches for 7 days.
4. No unresolved long-tail conversation continuity failures in open bug registry.
