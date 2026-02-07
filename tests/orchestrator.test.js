import test from "node:test";
import assert from "node:assert/strict";
import { createModelFirstOrchestrator } from "../src/orchestrator/orchestrator.js";

function makeClient(responsesQueue) {
  const queue = Array.isArray(responsesQueue) ? [...responsesQueue] : [];
  return {
    calls: [],
    responses: {
      async create() {
        if (!queue.length) throw new Error("No queued mock response");
        return queue.shift();
      },
    },
  };
}

function makeRecordingClient(responsesQueue) {
  const queue = Array.isArray(responsesQueue) ? [...responsesQueue] : [];
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(payload);
        if (!queue.length) throw new Error("No queued mock response");
        return queue.shift();
      },
    },
  };
}

function toolCallResponse(name, args = {}, callId = "call_1") {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 8)}`,
    output: [
      {
        type: "function_call",
        id: callId,
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      },
    ],
    output_text: "",
  };
}

function finalMessageResponse(text) {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 8)}`,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
    output_text: text,
  };
}

function makeDeps(overrides = {}) {
  return {
    getHostawayAccessToken: async () => "token",
    getListingsCached: async () => [{ id: 214151, name: "Treehouse #3" }],
    fetchListingByIdCached: async () => ({ id: 214151, name: "Treehouse #3", listingAmenities: [] }),
    fetchCalendarRange: async () => [],
    toSafeListingFacts: (l) => ({
      id: l.id,
      name: l.name,
      bookingUrl: `https://book.amishcountrylodging.com/listings/${l.id}`,
      amenities: [],
    }),
    findListingIdFromMessage: () => null,
    findListingIdFromMessageStrong: () => null,
    suggestUnits: () => [],
    extractDates: () => null,
    getTodayIso: () => "2026-02-06",
    helpers: {
      findListingIdFromMessage: () => null,
      findListingIdFromMessageStrong: () => null,
      suggestUnits: () => [],
    },
    ...overrides,
  };
}

test("orchestrator asks clarification on invalid args", async () => {
  const client = makeClient([
    toolCallResponse("check_listing_availability", { listing_id: "214151" }),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps(),
  });

  const out = await orchestrator.runTurn({
    message: "is treehouse 3 available this weekend?",
    sessionId: "t-invalid-args",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "clarification");
  assert.equal(out.trace.clarificationAsked, true);
  assert.match(out.reply, /what dates should i check|what unit and dates should i check/i);
  assert.equal(out.trace.validation.length > 0, true);
  assert.equal(out.trace.validation[0].ok, false);
});

test("orchestrator blocks disallowed role from tool execution", async () => {
  const client = makeClient([
    toolCallResponse("list_units", { limit: 5 }),
    finalMessageResponse("Role blocked handled."),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps(),
  });

  const out = await orchestrator.runTurn({
    message: "list all units",
    sessionId: "t-role-block",
    session: {},
    role: "viewer",
  });

  assert.equal(out.trace.validation.length > 0, true);
  assert.equal(out.trace.validation[0].ok, false);
  assert.match(out.trace.validation[0].reason, /not allowed to call/i);
  assert.equal(out.reply, "Role blocked handled.");
});

test("orchestrator tracks hallucinated tools", async () => {
  const client = makeClient([
    toolCallResponse("made_up_tool", { foo: "bar" }),
    finalMessageResponse("Unknown tool handled."),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps(),
  });

  const out = await orchestrator.runTurn({
    message: "do something impossible",
    sessionId: "t-hallucinated-tool",
    session: {},
    role: "guest",
  });

  assert.equal(out.trace.unknownToolCalls, 1);
  assert.equal(out.reply, "Unknown tool handled.");
});

test("orchestrator opens circuit breaker on repeated execution failure", async () => {
  const failingDeps = makeDeps({
    getHostawayAccessToken: async () => {
      throw new Error("upstream auth failure");
    },
  });

  const client = makeClient([
    toolCallResponse("resolve_listing", { listing_query: "treehouse 3" }),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    maxExecutionFailures: 1,
    deps: failingDeps,
  });

  const out = await orchestrator.runTurn({
    message: "treehouse 3",
    sessionId: "t-circuit-breaker",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "error");
  assert.equal(out.trace.failureReason, "circuit_breaker_open");
  assert.match(out.reply, /having trouble reaching one of my data tools/i);
});

test("orchestrator uses chat-only mode for small-talk turns", async () => {
  const client = makeRecordingClient([finalMessageResponse("Happy to help anytime.")]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps(),
  });

  const out = await orchestrator.runTurn({
    message: "Thanks.",
    sessionId: "t-chat-only",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "general");
  assert.equal(client.calls.length, 1);
  assert.equal(Object.hasOwn(client.calls[0], "tools"), false);
  assert.match(out.reply, /happy to help|you’re welcome|you're welcome/i);
});

test("orchestrator overrides disambiguation reply during chat-only mode", async () => {
  const client = makeRecordingClient([
    finalMessageResponse("Which unit are you asking about?"),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps(),
  });

  const out = await orchestrator.runTurn({
    message: "Thanks!",
    sessionId: "t-chat-only-disambiguation",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "general");
  assert.doesNotMatch(out.reply, /^Which unit are you asking about\?/i);
  assert.match(out.reply, /welcome|check dates|policy|compare units/i);
});

test("orchestrator normalizes availability dates from relative user message", async () => {
  const seen = { start: null, end: null };
  const client = makeRecordingClient([
    toolCallResponse("check_listing_availability", {
      listing_id: "214151",
      start_date: "2023-01-01",
      end_date: "2023-01-02",
    }),
    finalMessageResponse("Availability checked."),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      extractDates: () => ({ start: "2026-02-06", end: "2026-02-07" }),
      fetchCalendarRange: async (_id, start, end) => {
        seen.start = start;
        seen.end = end;
        return [];
      },
      fetchListingByIdCached: async () => ({ id: 214151, name: "Treehouse #3", listingAmenities: [] }),
      toSafeListingFacts: () => ({
        id: 214151,
        name: "Treehouse #3",
        bookingUrl: "https://book.amishcountrylodging.com/listings/214151",
        amenities: [],
      }),
    }),
  });

  const out = await orchestrator.runTurn({
    message: "Is treehouse 3 available tonight?",
    sessionId: "t-date-normalize",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "availability");
  assert.equal(seen.start, "2026-02-06");
  assert.equal(seen.end, "2026-02-07");
});

test("orchestrator blocks past-date availability calls before tool execution", async () => {
  const client = makeRecordingClient([
    toolCallResponse("check_listing_availability", {
      listing_id: "214151",
      start_date: "2023-01-01",
      end_date: "2023-01-02",
    }),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      extractDates: () => null,
      getTodayIso: () => "2026-02-06",
      fetchCalendarRange: async () => {
        throw new Error("should not execute calendar call for invalid past dates");
      },
    }),
  });

  const out = await orchestrator.runTurn({
    message: "Check 2023-01-01 to 2023-01-02",
    sessionId: "t-past-date-block",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "clarification");
  assert.equal(out.trace.clarificationAsked, true);
  assert.equal(out.trace.validation.length > 0, true);
  assert.equal(out.trace.validation[0].ok, false);
  assert.match(
    JSON.stringify(out.trace.validation[0].errors || []),
    /today or later|end_date must be after args.start_date/i
  );
});
