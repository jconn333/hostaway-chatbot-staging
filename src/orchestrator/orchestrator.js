import { ORCHESTRATOR_SYSTEM_PROMPT, buildOrchestratorContext } from "./systemPrompt.js";
import { createToolRegistry } from "./toolRegistry.js";
import { parseToolArgs, validateArgs } from "./schema.js";

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function buildClarificationQuestion(toolName, errors) {
  const msg = String(errors?.[0] || "").toLowerCase();
  if (toolName === "check_availability") {
    if (msg.includes("listingid")) return "Which unit should I check availability for?";
    if (msg.includes("startdate") || msg.includes("enddate")) {
      return "What dates should I check? Please share start and end dates (YYYY-MM-DD).";
    }
    return "What unit and dates should I check for availability?";
  }
  if (toolName === "get_unit_details") return "Which unit should I use, and what topic should I check?";
  if (toolName === "search_listings") {
    return "What filters should I use (guests, amenities, pet-friendly, or unit type)?";
  }
  return "Could you clarify what you'd like me to check?";
}

function getRouteFromTools(toolNames = []) {
  if (toolNames.includes("check_availability")) return "availability";
  if (toolNames.includes("search_listings")) return "amenity_inventory";
  if (toolNames.includes("get_unit_details")) return "summary";
  return "general";
}

function inferReplyTypeFromRoute(route = "general") {
  if (route === "availability") return "availability";
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
  if (toolName !== "check_availability") return parsed;
  if (typeof deps?.extractDates !== "function") return parsed;
  const extracted = deps.extractDates(message);
  if (!extracted?.start || !extracted?.end) return parsed;
  return {
    ...parsed,
    startDate: extracted.start,
    endDate: extracted.end,
  };
}

function validateAvailabilityDateBounds(toolName, parsed, deps) {
  if (toolName !== "check_availability") return [];
  const todayIso =
    typeof deps?.getTodayIso === "function"
      ? String(deps.getTodayIso() || "")
      : new Date().toISOString().slice(0, 10);
  const errors = [];
  const start = String(parsed?.startDate || "");
  const end = String(parsed?.endDate || "");
  if (start && start < todayIso) errors.push(`args.startDate must be today or later (${todayIso})`);
  if (start && end && end <= start) errors.push("args.endDate must be after args.startDate");
  return errors;
}

function toChatTools(openaiTools) {
  return (openaiTools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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
  const chatTools = toChatTools(registry.openaiTools);

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
        trace.toolExecutions.push({ tool: tool.name, attempt, ok: true });
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

  async function runTurn({ message, sessionId, session, role = "guest", listingIdHint = null, runtime = {} }) {
    const normalizedRole = String(role || "guest").toLowerCase();
    const trace = {
      model,
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

    const todayIso =
      typeof deps?.getTodayIso === "function"
        ? String(deps.getTodayIso() || "")
        : new Date().toISOString().slice(0, 10);
    const contextText = buildOrchestratorContext({
      session,
      userRole: normalizedRole,
      nowIso: new Date().toISOString(),
      todayIso,
    });
    const chatOnlyMode = isSmallTalkTurn(message);
    let systemPrompt = `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nSession context:\n${contextText}`;
    if (chatOnlyMode) {
      systemPrompt +=
        "\n\nThis is conversational small talk or a closure turn. " +
        "Respond naturally in 1-2 sentences. " +
        "Do not ask the user to pick a unit unless they request unit-specific facts.";
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: String(message || "") },
    ];
    const sessionPatch = {};
    const toolNamesUsed = [];
    let executionFailures = 0;

    while (true) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        ...(chatOnlyMode ? {} : { tools: chatTools, tool_choice: "auto" }),
      });
      const assistant = completion?.choices?.[0]?.message || { role: "assistant", content: "" };
      const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];

      if (!toolCalls.length) {
        let reply = messageText(assistant) || "I’m not sure yet. Could you rephrase that request?";
        if (chatOnlyMode && /^which unit are you asking about\?/i.test(reply)) {
          reply = smallTalkFallbackReply(message);
        }
        trace.route = getRouteFromTools(toolNamesUsed);
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
        callCount: toolCalls.length,
        tools: toolCalls.map((c) => c?.function?.name || c?.name || ""),
      });

      messages.push({
        role: "assistant",
        content: assistant.content || "",
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c?.function?.name || "",
            arguments: c?.function?.arguments || "{}",
          },
        })),
      });

      for (const call of toolCalls) {
        trace.toolCallCount += 1;
        const toolName = String(call?.function?.name || "");
        const callId = String(call?.id || "");
        toolNamesUsed.push(toolName);

        logger("orchestrator_tool_selected", {
          sessionId,
          tool: toolName,
          callId,
        });

        if (trace.toolCallCount > maxToolCalls) {
          trace.failureReason = "max_tool_calls_exceeded";
          return {
            reply: "I need one specific detail to continue. Which unit and dates should I check next?",
            route: "clarification",
            replyType: "summary",
            trace,
            sessionPatch,
          };
        }

        const tool = registry.byName.get(toolName);
        if (!tool) {
          trace.unknownToolCalls += 1;
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` }),
          });
          continue;
        }

        if (!tool.roleAllowlist.includes(normalizedRole)) {
          const err = `Role ${normalizedRole} is not allowed to call ${toolName}.`;
          trace.validation.push({ tool: toolName, ok: false, reason: err });
          messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify({ ok: false, error: err }) });
          continue;
        }

        let parsed = parseToolArgs(call?.function?.arguments || "{}");
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

        const executed = await executeToolWithRetry(tool, parsed, toolContext, trace);
        if (!executed.ok) {
          executionFailures += 1;
          logger("orchestrator_tool_execution", {
            sessionId,
            tool: toolName,
            ok: false,
            error: executed.error,
          });
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({ ok: false, error: executed.error }),
          });
          if (executionFailures >= maxExecutionFailures) {
            trace.failureReason = "circuit_breaker_open";
            return {
              reply: "I’m having trouble reaching one of my data tools right now. Please try again in a moment.",
              route: "error",
              replyType: "summary",
              trace,
              sessionPatch,
            };
          }
          continue;
        }

        const result = executed.result;
        logger("orchestrator_tool_execution", { sessionId, tool: toolName, ok: true });
        if (toolName === "check_availability") {
          sessionPatch.listingId = String(result.listing_id);
          sessionPatch.listingName = result.listing_name || null;
          sessionPatch.dates = { start: result.start_date, end: result.end_date };
        }
        if (toolName === "get_unit_details") {
          sessionPatch.listingId = String(result.listing_id);
          sessionPatch.listingName = result.listing_name || null;
        }
        if (toolName === "search_listings") {
          sessionPatch.inventoryFilters = result?.filters_applied || null;
          sessionPatch.activeResultSet = {
            listingIds: (result?.units || []).map((u) => String(u.listing_id)),
          };
        }

        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify({ ok: true, result }),
        });
      }
    }
  }

  return { runTurn, registry };
}
