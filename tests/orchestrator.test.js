import test from "node:test";
import assert from "node:assert/strict";
import { createModelFirstOrchestrator } from "../src/orchestrator/orchestrator.js";

function makeClient(completionsQueue) {
  const queue = Array.isArray(completionsQueue) ? [...completionsQueue] : [];
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(payload) {
          calls.push(payload);
          if (!queue.length) throw new Error("No queued mock completion");
          return queue.shift();
        },
      },
    },
  };
}

function completionWithToolCall(name, args = {}, callId = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function completionWithText(text) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function makeDeps(overrides = {}) {
  return {
    getHostawayAccessToken: async () => "token",
    getListingsCached: async () => [{ id: 214151, name: "Treehouse #3" }],
    fetchListingByIdCached: async () => ({ id: 214151, name: "Treehouse #3", listingAmenities: [] }),
    fetchSafeListingFacts: async () => ({
      id: 214151,
      name: "Treehouse #3",
      bookingUrl: "https://book.amishcountrylodging.com/listings/214151",
      amenities: [],
      highlights: [],
    }),
    fetchCalendarRange: async () => [],
    toSafeListingFacts: (l) => ({
      id: l.id,
      name: l.name,
      bookingUrl: `https://book.amishcountrylodging.com/listings/${l.id}`,
      amenities: [],
    }),
    extractDates: () => null,
    getTodayIso: () => "2026-02-06",
    ...overrides,
  };
}

test("orchestrator asks clarification on invalid args", async () => {
  const client = makeClient([completionWithToolCall("check_availability", { listingId: "214151" })]);

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
    completionWithToolCall("search_listings", {}),
    completionWithText("Role blocked handled."),
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
    completionWithToolCall("made_up_tool", { foo: "bar" }),
    completionWithText("Unknown tool handled."),
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
    completionWithToolCall("search_listings", { unitType: "treehouse" }),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    maxExecutionFailures: 1,
    deps: failingDeps,
  });

  const out = await orchestrator.runTurn({
    message: "show me treehouses",
    sessionId: "t-circuit-breaker",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "error");
  assert.equal(out.trace.failureReason, "circuit_breaker_open");
  assert.match(out.reply, /having trouble reaching one of my data tools/i);
});

test("orchestrator uses chat-only mode for small-talk turns", async () => {
  const client = makeClient([completionWithText("Happy to help anytime.")]);

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
  const client = makeClient([completionWithText("Which unit are you asking about?")]);

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
  const client = makeClient([
    completionWithText("Let me think."),
    completionWithToolCall("check_availability", {
      listingId: "214151",
      startDate: "2023-01-01",
      endDate: "2023-01-02",
    }),
    completionWithText("Availability checked."),
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
  const client = makeClient([
    completionWithToolCall("check_availability", {
      listingId: "214151",
      startDate: "2023-01-01",
      endDate: "2023-01-02",
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
    /today or later|endDate must be after args.startDate/i
  );
});

test("orchestrator context always includes today_iso from deps.getTodayIso", async () => {
  const client = makeClient([completionWithText("ok")]);
  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      getTodayIso: () => "2026-02-06",
    }),
  });

  await orchestrator.runTurn({
    message: "hello",
    sessionId: "t-today-iso",
    session: {},
    role: "guest",
  });

  assert.equal(client.calls.length, 1);
  assert.match(String(client.calls[0].messages?.[0]?.content || ""), /\"today_iso\": \"2026-02-06\"/);
});

test("orchestrator strips unsupported search_listings args before validation", async () => {
  const client = makeClient([
    completionWithToolCall("search_listings", {
      unit_type: "treehouse",
      maxItems: 5,
      petFriendly: true,
    }),
    completionWithText("done"),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps(),
  });

  const out = await orchestrator.runTurn({
    message: "show treehouses",
    sessionId: "t-strip-unsupported",
    session: {},
    role: "guest",
  });

  assert.equal(out.route, "amenity_inventory");
  assert.equal(out.trace.validation.length > 0, true);
  assert.equal(out.trace.validation[0].ok, true);
  assert.equal(out.reply, "done");
});

test("orchestrator uses session dates when availability call has no dates in args", async () => {
  const seen = { start: null, end: null };
  const client = makeClient([
    completionWithToolCall("check_availability", { listingId: "214151" }),
    completionWithText("ok"),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      fetchCalendarRange: async (_id, start, end) => {
        seen.start = start;
        seen.end = end;
        return [];
      },
    }),
  });

  const out = await orchestrator.runTurn({
    message: "what about next friday?",
    sessionId: "t-session-dates",
    session: { listingId: "214151", dates: { start: "2026-02-20", end: "2026-02-22" } },
    role: "guest",
  });

  assert.equal(out.reply, "ok");
  assert.equal(seen.start, "2026-02-20");
  assert.equal(seen.end, "2026-02-22");
});

test("orchestrator injects listing id from session for availability calls missing id", async () => {
  const seen = { listingId: null };
  const client = makeClient([
    completionWithToolCall("check_availability", {
      startDate: "2026-02-13",
      endDate: "2026-02-15",
    }),
    completionWithText("ok"),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      fetchCalendarRange: async (listingId) => {
        seen.listingId = String(listingId);
        return [];
      },
    }),
  });

  const out = await orchestrator.runTurn({
    message: "next friday works",
    sessionId: "t-session-listing",
    session: { listingId: "214151" },
    role: "guest",
  });

  assert.equal(out.reply, "ok");
  assert.equal(seen.listingId, "214151");
});

test("orchestrator can resolve listing id from message text before validation", async () => {
  const seen = { listingId: null };
  const client = makeClient([
    completionWithText("I can check that."),
    completionWithToolCall("check_availability", {
      startDate: "2026-02-13",
      endDate: "2026-02-15",
    }),
    completionWithText("ok"),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      getListingsCached: async () => [{ id: 214151, name: "Red Fern Cabin" }],
      findListingIdFromMessageStrong: () => "214151",
      fetchCalendarRange: async (listingId) => {
        seen.listingId = String(listingId);
        return [];
      },
    }),
  });

  const out = await orchestrator.runTurn({
    message: "Is Red Fern Cabin available next weekend?",
    sessionId: "t-presearch-resolve-id",
    session: {},
    role: "guest",
  });

  assert.equal(out.reply, "ok");
  assert.equal(seen.listingId, "214151");
});

test("orchestrator retries once and forces tool call for listing availability prompts", async () => {
  const seen = { listingId: null, startDate: null, endDate: null };
  const client = makeClient([
    completionWithText("I can help with that."),
    completionWithToolCall("check_availability", {
      listingId: "214151",
      startDate: "2026-02-13",
      endDate: "2026-02-15",
    }),
    completionWithText("ok"),
  ]);

  const orchestrator = createModelFirstOrchestrator({
    client,
    model: "gpt-4o-mini",
    deps: makeDeps({
      fetchCalendarRange: async (listingId, startDate, endDate) => {
        seen.listingId = String(listingId);
        seen.startDate = String(startDate);
        seen.endDate = String(endDate);
        return [];
      },
    }),
  });

  const out = await orchestrator.runTurn({
    message: "Is Red Fern Cabin available for next weekend?",
    sessionId: "t-force-availability-tool",
    session: {},
    role: "guest",
  });

  assert.equal(out.reply, "ok");
  assert.equal(out.trace.toolCallCount, 1);
  assert.equal(seen.listingId, "214151");
  assert.equal(seen.startDate, "2026-02-13");
  assert.equal(seen.endDate, "2026-02-15");
});
