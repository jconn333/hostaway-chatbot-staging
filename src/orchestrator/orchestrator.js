import { ORCHESTRATOR_SYSTEM_PROMPT, buildOrchestratorContext } from "./systemPrompt.js";
import { createToolRegistry } from "./toolRegistry.js";
import { parseToolArgs, validateArgs } from "./schema.js";

function extractText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks = [];
  for (const item of response.output || []) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && c?.text) chunks.push(c.text);
        if (c?.type === "text" && c?.text) chunks.push(c.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractFunctionCalls(response) {
  const calls = [];
  for (const item of response?.output || []) {
    if (item?.type === "function_call") {
      calls.push({
        id: item.id || null,
        call_id: item.call_id || item.id || null,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }
  return calls;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildClarificationQuestion(toolName, errors) {
  const msg = String(errors?.[0] || "").toLowerCase();
  if (toolName === "check_listing_availability") {
    if (msg.includes("listing_id")) return "Which unit should I check availability for?";
    if (msg.includes("start_date") || msg.includes("end_date")) {
      return "What dates should I check? Please share start and end dates (YYYY-MM-DD).";
    }
    return "What unit and dates should I check for availability?";
  }
  if (toolName === "resolve_listing") return "Which unit name should I use?";
  if (toolName === "get_policy") {
    if (msg.includes("topic")) {
      return "Which policy should I check: pets, smoking, parties, noise, check-in/out, or cancellation?";
    }
    return "Which unit should I check that policy for?";
  }
  if (toolName === "get_listing_summary") return "Which unit would you like details for?";
  if (toolName === "list_units") return "What filters should I use (dates, guests, amenities, or unit type)?";
  return "Could you clarify what you'd like me to check?";
}

function getRouteFromTools(toolNames = []) {
  if (toolNames.includes("check_listing_availability")) return "availability";
  if (toolNames.includes("list_units")) return "amenity_inventory";
  if (toolNames.includes("get_policy")) return "policy";
  if (toolNames.includes("get_listing_summary")) return "summary";
  if (toolNames.includes("resolve_listing")) return "disambiguation";
  return "general";
}

function inferReplyTypeFromRoute(route = "general") {
  if (route === "availability") return "availability";
  if (route === "policy") return "policy";
  if (route === "amenity_inventory") return "inventory";
  if (route === "summary") return "summary";
  return "general";
}

function normalizeMessage(message) {
  return String(message || "").trim().toLowerCase();
}

function hasBookingSignal(message) {
  const msg = normalizeMessage(message);
  if (!msg) return false;
  return (
    /\b(availability|available|book|booking|reserve|reservation|check[- ]?in|check[- ]?out|checkout|checkin)\b/.test(
      msg
    ) ||
    /\b(unit|listing|property|cabin|suite|lodge|treehouse|cottage)\b/.test(msg) ||
    /\b(hot tub|jacuzzi|pool|fireplace|sauna|amenit|pet|pets|smoking|party|noise|cancel|refund)\b/.test(
      msg
    ) ||
    /\b(sleeps?|occupancy|capacity|bedroom|bathroom|beds?)\b/.test(msg) ||
    /\b(today|tonight|tomorrow|weekend|week|month|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
      msg
    ) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(msg)
  );
}

function isSmallTalkTurn(message) {
  const msg = normalizeMessage(message);
  if (!msg) return true;
  if (hasBookingSignal(msg)) return false;
  return (
    /^(hi|hello|hey|yo|good morning|good afternoon|good evening)[!. ]*$/.test(msg) ||
    /^(thanks|thank you|great|awesome|perfect|sounds good|okay|ok|got it|nice)[!. ]*$/.test(msg) ||
    /\b(thanks|thank you|appreciate it|that helps)\b/.test(msg) ||
    /\b(we will stay home|i'll come back later|we'll come back later|bye|goodbye|talk later)\b/.test(msg)
  );
}

function smallTalkFallbackReply(message) {
  const msg = normalizeMessage(message);
  if (/^(hi|hello|hey|yo|good morning|good afternoon|good evening)[!. ]*$/.test(msg)) {
    return "Hi! I can help with availability, amenities, and policies for Amish Country Lodging. What would you like to check?";
  }
  if (/\b(we will stay home|i'll come back later|we'll come back later|bye|goodbye|talk later)\b/.test(msg)) {
    return "No problem. If plans change, send dates or a unit name and I can help right away.";
  }
  return "You’re welcome. If you want, I can check dates, compare units, or answer policy questions.";
}

function maybeNormalizeAvailabilityArgs(toolName, parsed, message, deps) {
  if (toolName !== "check_listing_availability") return parsed;
  if (typeof deps?.extractDates !== "function") return parsed;
  const extracted = deps.extractDates(message);
  if (!extracted?.start || !extracted?.end) return parsed;
  return {
    ...parsed,
    start_date: extracted.start,
    end_date: extracted.end,
  };
}

function validateAvailabilityDateBounds(toolName, parsed, deps) {
  if (toolName !== "check_listing_availability") return [];
  const todayIso =
    typeof deps?.getTodayIso === "function"
      ? String(deps.getTodayIso() || "")
      : new Date().toISOString().slice(0, 10);
  const errors = [];
  const start = String(parsed?.start_date || "");
  const end = String(parsed?.end_date || "");
  if (start && start < todayIso) {
    errors.push(`args.start_date must be today or later (${todayIso})`);
  }
  if (start && end && end <= start) {
    errors.push("args.end_date must be after args.start_date");
  }
  return errors;
}

export function createModelFirstOrchestrator({
  client,
  model,
  maxToolCalls = 6,
  maxExecutionFailures = 3,
  toolTimeoutMs = 15000,
  logger = () => {},
  deps,
}) {
  if (!client) throw new Error("createModelFirstOrchestrator requires OpenAI client");
  if (!deps) throw new Error("createModelFirstOrchestrator requires deps");

  const registry = createToolRegistry();

  async function executeToolWithRetry(tool, args, ctx, trace) {
    let attempt = 0;
    let lastErr = null;
    while (attempt < 2) {
      attempt += 1;
      try {
        const result = await withTimeout(
          Promise.resolve(tool.handler(args, ctx)),
          toolTimeoutMs,
          `Tool ${tool.name}`
        );
        trace.toolExecutions.push({
          tool: tool.name,
          attempt,
          ok: true,
        });
        return { ok: true, result };
      } catch (err) {
        lastErr = err;
        trace.toolExecutions.push({
          tool: tool.name,
          attempt,
          ok: false,
          error: String(err?.message || err),
        });
      }
    }
    return { ok: false, error: String(lastErr?.message || lastErr || "tool failed") };
  }

  async function runTurn({
    message,
    sessionId,
    session,
    role = "guest",
    listingIdHint = null,
    runtime = {},
  }) {
    const normalizedRole = String(role || "guest").toLowerCase();
    const trace = {
      model: model,
      modelDecisions: [],
      validation: [],
      toolExecutions: [],
      failureReason: null,
      clarificationAsked: false,
      unknownToolCalls: 0,
      toolCallCount: 0,
      route: "general",
    };

    const toolContext = {
      ...deps,
      ...runtime,
      session,
      sessionId,
      listingIdHint: listingIdHint ? String(listingIdHint) : null,
    };

    const contextText = buildOrchestratorContext({
      session,
      userRole: normalizedRole,
      nowIso: new Date().toISOString(),
    });

    const chatOnlyMode = isSmallTalkTurn(message);
    let instructions = `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nSession context:\n${contextText}`;
    if (chatOnlyMode) {
      instructions +=
        "\n\nThis is conversational small talk or a closure turn. " +
        "Respond naturally in 1-2 sentences. " +
        "Do not ask the user to pick a unit unless they request unit-specific facts.";
    }

    const initialRequest = {
      model,
      instructions,
      input: [{ role: "user", content: message }],
    };
    if (!chatOnlyMode) {
      initialRequest.tools = registry.openaiTools;
      initialRequest.tool_choice = "auto";
    }

    let response = await client.responses.create(initialRequest);

    let executionFailures = 0;
    const toolNamesUsed = [];
    const sessionPatch = {};

    while (true) {
      const functionCalls = extractFunctionCalls(response);
      if (!functionCalls.length) {
        let reply = extractText(response) || "I’m not sure yet. Could you rephrase that request?";
        if (chatOnlyMode && /^which unit are you asking about\?/i.test(reply)) {
          reply = smallTalkFallbackReply(message);
        }
        trace.route = getRouteFromTools(toolNamesUsed);
        if (chatOnlyMode && trace.route === "general") {
          trace.modelDecisions.push({ chatOnlyMode: true });
        }
        logger("orchestrator_turn_complete", {
          sessionId,
          route: trace.route,
          toolCalls: trace.toolCallCount,
          failures: executionFailures,
        });
        return {
          reply,
          route: trace.route,
          replyType: inferReplyTypeFromRoute(trace.route),
          trace,
          sessionPatch,
        };
      }

      trace.modelDecisions.push({
        callCount: functionCalls.length,
        tools: functionCalls.map((c) => c.name),
      });

      const toolOutputs = [];

      for (const call of functionCalls) {
        trace.toolCallCount += 1;
        const toolName = String(call?.name || "");
        toolNamesUsed.push(toolName);

        logger("orchestrator_tool_selected", {
          sessionId,
          tool: toolName,
          callId: call.call_id,
        });

        if (trace.toolCallCount > maxToolCalls) {
          trace.failureReason = "max_tool_calls_exceeded";
          return {
            reply:
              "I need one specific detail to continue. Which unit and dates should I check next?",
            route: "clarification",
            replyType: "summary",
            trace,
            sessionPatch,
          };
        }

        const tool = registry.byName.get(toolName);
        if (!tool) {
          trace.unknownToolCalls += 1;
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` }),
          });
          continue;
        }

        if (!tool.roleAllowlist.includes(normalizedRole)) {
          const msg = `Role ${normalizedRole} is not allowed to call ${toolName}.`;
          trace.validation.push({ tool: toolName, ok: false, reason: msg });
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ ok: false, error: msg }),
          });
          continue;
        }

        let parsed = parseToolArgs(call.arguments);
        if (parsed.__invalid) {
          trace.validation.push({ tool: toolName, ok: false, reason: parsed.__invalid });
          trace.clarificationAsked = true;
          return {
            reply: buildClarificationQuestion(toolName, [parsed.__invalid]),
            route: "clarification",
            replyType: "summary",
            trace,
            sessionPatch,
          };
        }

        parsed = maybeNormalizeAvailabilityArgs(toolName, parsed, message, deps);

        const validation = validateArgs(tool.schema, parsed);
        const boundErrors = validateAvailabilityDateBounds(toolName, parsed, deps);
        if (boundErrors.length) {
          validation.ok = false;
          validation.errors = [...(validation.errors || []), ...boundErrors];
        }
        trace.validation.push({ tool: toolName, ok: validation.ok, errors: validation.errors || [] });
        logger("orchestrator_tool_validation", {
          sessionId,
          tool: toolName,
          ok: validation.ok,
          errors: validation.errors,
        });

        if (!validation.ok) {
          trace.clarificationAsked = true;
          return {
            reply: buildClarificationQuestion(toolName, validation.errors),
            route: "clarification",
            replyType: "summary",
            trace,
            sessionPatch,
          };
        }

        if (tool.irreversible && parsed.confirm !== true) {
          trace.clarificationAsked = true;
          return {
            reply: "Please confirm before I do that. Reply with: confirm.",
            route: "clarification",
            replyType: "summary",
            trace,
            sessionPatch,
          };
        }

        const executed = await executeToolWithRetry(tool, parsed, toolContext, trace);
        if (!executed.ok) {
          executionFailures += 1;
          logger("orchestrator_tool_execution", {
            sessionId,
            tool: toolName,
            ok: false,
            error: executed.error,
          });
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ ok: false, error: executed.error }),
          });
          if (executionFailures >= maxExecutionFailures) {
            trace.failureReason = "circuit_breaker_open";
            return {
              reply:
                "I’m having trouble reaching one of my data tools right now. Please try again in a moment.",
              route: "error",
              replyType: "summary",
              trace,
              sessionPatch,
            };
          }
          continue;
        }

        const result = executed.result;
        logger("orchestrator_tool_execution", {
          sessionId,
          tool: toolName,
          ok: true,
        });

        if (toolName === "resolve_listing" && result?.status === "ok") {
          sessionPatch.listingId = String(result.listing_id);
          sessionPatch.listingName = result.listing_name || null;
        }
        if (toolName === "check_listing_availability") {
          sessionPatch.listingId = String(result.listing_id);
          sessionPatch.listingName = result.listing_name || null;
          sessionPatch.dates = {
            start: result.start_date,
            end: result.end_date,
          };
        }
        if (toolName === "get_listing_summary") {
          sessionPatch.listingId = String(result.listing_id);
          sessionPatch.listingName = result.listing_name || null;
        }
        if (toolName === "list_units") {
          sessionPatch.inventoryFilters = result?.filters_applied || null;
          sessionPatch.activeResultSet = {
            listingIds: (result?.units || []).map((u) => String(u.listing_id)),
          };
        }

        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ ok: true, result }),
        });
      }

      response = await client.responses.create({
        model,
        previous_response_id: response.id,
        input: toolOutputs,
        tools: registry.openaiTools,
        tool_choice: "auto",
      });
    }
  }

  return {
    runTurn,
    registry,
  };
}
