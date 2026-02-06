import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL || "";
const LIMIT = Number(process.env.EVAL_LIMIT || 50);

function runPsql(sql) {
  if (!DATABASE_URL) return { ok: false, rows: [], error: "DATABASE_URL missing" };
  const out = spawnSync(
    "psql",
    [DATABASE_URL, "-X", "-A", "-t", "-F", "\t", "-c", sql],
    { encoding: "utf8" }
  );
  if (out.status !== 0) {
    return {
      ok: false,
      rows: [],
      error: String(out.stderr || out.stdout || "psql failed").trim(),
    };
  }
  const lines = String(out.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean);
  return { ok: true, rows: lines, error: null };
}

function classifyExpectedTool(message) {
  const msg = String(message || "").toLowerCase();
  if (/\b(available|availability|open|booked|tonight|weekend|check dates?)\b/.test(msg)) {
    return "check_listing_availability";
  }
  if (/\b(which|what|list|show).*(units|cabins|suites|properties)\b/.test(msg)) {
    return "list_units";
  }
  if (/\b(pets?|smoking|parties|noise|check-?in|check-?out|cancellation)\b/.test(msg)) {
    return "get_policy";
  }
  if (/\b(tell me about|overview|how many people|sleeps|bedrooms|bathrooms|amenities)\b/.test(msg)) {
    return "get_listing_summary";
  }
  return null;
}

async function postChat(message, sessionId) {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Mode": "1",
    },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, reply: "", meta: null };
  }
  const json = await res.json();
  return { ok: true, error: null, reply: json.reply || "", meta: json.meta || null };
}

function parseTranscript(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === "object" && x.role === "user")
      .map((x) => String(x.text || x.content || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatPct(a, b) {
  if (!b) return "0.0%";
  return `${((a / b) * 100).toFixed(1)}%`;
}

async function main() {
  const sql = `
SELECT session_id, COALESCE(transcript::text, '[]') AS transcript, COALESCE(user_message,'') AS user_message
FROM chatbot_feedback.turn_feedback
ORDER BY created_at DESC
LIMIT ${Number.isFinite(LIMIT) ? LIMIT : 50};
`;

  const db = runPsql(sql);

  const conversations = [];
  if (db.ok) {
    for (const row of db.rows) {
      const [sessionId, transcriptRaw, fallbackMsg] = row.split("\t");
      const messages = parseTranscript(transcriptRaw);
      if (!messages.length && fallbackMsg) messages.push(String(fallbackMsg));
      if (messages.length) {
        conversations.push({
          sessionId: sessionId || `eval-${Math.random().toString(36).slice(2, 8)}`,
          messages,
        });
      }
    }
  }

  if (!conversations.length) {
    console.log("No DB conversations found; using fallback sample conversation set.");
    conversations.push({
      sessionId: `eval-fallback-${Date.now()}`,
      messages: [
        "Is treehouse 3 available this weekend?",
        "What about a weekend in March?",
        "Does it have a hot tub?",
        "How many people does it sleep?",
      ],
    });
  }

  let totalTurns = 0;
  let completedTurns = 0;
  let clarificationTurns = 0;
  let totalToolCalls = 0;
  let unknownToolCalls = 0;
  let validArgs = 0;
  let totalValidations = 0;
  let toolSelectionExpected = 0;
  let toolSelectionMatched = 0;

  const failures = [];

  for (const convo of conversations) {
    const evalSession = `${convo.sessionId}::eval-${Date.now()}`;
    for (const userMessage of convo.messages.slice(0, 10)) {
      totalTurns += 1;
      const expectedTool = classifyExpectedTool(userMessage);
      const response = await postChat(userMessage, evalSession);
      if (!response.ok) {
        failures.push({ userMessage, error: response.error });
        continue;
      }

      const meta = response.meta || {};
      const orch = meta.orchestration || {};
      const firstTool = Array.isArray(orch.toolExecutions) && orch.toolExecutions.length
        ? orch.toolExecutions[0].tool
        : null;

      if (expectedTool) {
        toolSelectionExpected += 1;
        if (firstTool === expectedTool) toolSelectionMatched += 1;
      }

      const validations = Array.isArray(orch.validation) ? orch.validation : [];
      totalValidations += validations.length;
      validArgs += validations.filter((v) => v && v.ok === true).length;

      totalToolCalls += Number(orch.toolCallCount || 0);
      unknownToolCalls += Number(orch.unknownToolCalls || 0);

      const route = String(meta.route || "").toLowerCase();
      const isClarify = route === "clarification" || Boolean(orch.clarificationAsked);
      if (isClarify) clarificationTurns += 1;

      if (!isClarify && route !== "error") completedTurns += 1;
    }
  }

  const metrics = {
    total_turns: totalTurns,
    tool_selection_accuracy: formatPct(toolSelectionMatched, toolSelectionExpected),
    arg_validity_rate: formatPct(validArgs, totalValidations),
    completion_rate: formatPct(completedTurns, totalTurns),
    hallucinated_tool_rate: formatPct(unknownToolCalls, totalToolCalls || 1),
    clarification_rate: formatPct(clarificationTurns, totalTurns),
  };

  const report = `# Model-First Eval Baseline\n\n` +
`- Generated: ${new Date().toISOString()}\n` +
`- Base URL: ${BASE_URL}\n` +
`- Conversations replayed: ${conversations.length}\n` +
`- Turns replayed: ${totalTurns}\n\n` +
`## Metrics\n\n` +
`- Tool-selection accuracy: ${metrics.tool_selection_accuracy}\n` +
`- Arg-validity rate: ${metrics.arg_validity_rate}\n` +
`- Completion rate: ${metrics.completion_rate}\n` +
`- Hallucinated-tool rate: ${metrics.hallucinated_tool_rate}\n` +
`- Clarification rate: ${metrics.clarification_rate}\n\n` +
`## Notes\n\n` +
`- Failures captured: ${failures.length}\n` +
(failures.length
  ? failures.slice(0, 10).map((f, i) => `  - ${i + 1}. ${f.userMessage} -> ${f.error}`).join("\n") + "\n"
  : "- No transport/runtime failures during replay.\n");

  mkdirSync("docs/reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const reportPath = `docs/reports/eval-baseline-${stamp}.md`;
  writeFileSync(reportPath, report, "utf8");

  console.log(JSON.stringify({ ok: true, metrics, reportPath }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
