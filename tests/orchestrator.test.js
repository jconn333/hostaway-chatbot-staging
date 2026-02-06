import test from "node:test";
import assert from "node:assert/strict";
import { createModelFirstOrchestrator } from "../src/orchestrator/orchestrator.js";

function makeClient(responsesQueue) {
  const queue = Array.isArray(responsesQueue) ? [...responsesQueue] : [];
  return {
    responses: {
      async create() {
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
