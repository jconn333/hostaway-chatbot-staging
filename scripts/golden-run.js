import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const BASELINE_TESTS_PATH = new URL("./golden-prompts.json", import.meta.url);
const MATRIX_TESTS_PATH = new URL("./golden-matrix.json", import.meta.url);
const BUG_TESTS_PATH = new URL("./golden-bugs.json", import.meta.url);
const GOLDEN_MODE = (process.env.GOLDEN_MODE || "full").toLowerCase();
const GOLDEN_SUITE = (process.env.GOLDEN_SUITE || "baseline").toLowerCase();
const GOLDEN_FILTER = (process.env.GOLDEN_FILTER || "").trim();
const GOLDEN_TEST_MODE = process.env.GOLDEN_TEST_MODE !== "0";
const RUN_ID =
  process.env.GOLDEN_RUN_ID ||
  `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const CORE_TESTS = new Set([
  "availability-weekend",
  "amenity-followup",
  "joy-two-nights",
  "pet-policy-generic",
  "pet-friendly-suites",
  "inventory-availability",
  "inventory-followup",
  "disambiguation",
  "disambiguation-followup",
  "policy-smoking",
  "policy-parties",
  "booking-short",
  "bug-treehouse-typo-weekend-1",
  "bug-treehouse-typo-weekend-2",
  "bug-hot-tub-filter-preserve-1",
  "bug-hot-tub-filter-preserve-2",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) => {
    return vars[key] ?? "";
  });
}

function expandMatrixSpecs(specs) {
  const expanded = [];
  for (const spec of specs) {
    for (const unit of spec.units || []) {
      const vars = {
        unit_name: unit.unit_name,
      };
      expanded.push({
        name: `${spec.name}-${unit.slug}`,
        sessionId: `${spec.sessionId}-${unit.slug}`,
        message: renderTemplate(spec.message, vars),
        expectIncludes: (spec.expectIncludes || []).map((v) => renderTemplate(v, vars)),
        expectRegex: (spec.expectRegex || []).map((v) => renderTemplate(v, vars)),
        expectOneOfIncludes: (spec.expectOneOfIncludes || []).map((v) => renderTemplate(v, vars)),
        forbidIncludes: (spec.forbidIncludes || []).map((v) => renderTemplate(v, vars)),
        expectMeta: spec.expectMeta || null,
        expectReplyType: spec.expectReplyType || null,
      });
    }
  }
  return expanded;
}

function expandBugSpecs(specs) {
  const out = [];
  for (const spec of specs || []) {
    if (!spec || typeof spec !== "object") continue;
    if (Array.isArray(spec.turns)) {
      for (let i = 0; i < spec.turns.length; i++) {
        const turn = spec.turns[i] || {};
        out.push({
          name: `${spec.bugId || "bug"}-${i + 1}`,
          sessionId: spec.sessionId || `golden-bug-${spec.bugId || "case"}`,
          message: turn.message || "",
          expectIncludes: turn.expectIncludes || [],
          expectRegex: turn.expectRegex || [],
          expectOneOfIncludes: turn.expectOneOfIncludes || [],
          forbidIncludes: turn.forbidIncludes || [],
          expectMeta: turn.expectMeta || spec.expectedMeta || null,
          expectReplyType: turn.expectReplyType || spec.expectedReplyType || null,
        });
      }
      continue;
    }

    // Backward-compatible: treat as flat scenario.
    out.push({
      name: spec.name || spec.bugId || "bug-case",
      sessionId: spec.sessionId || `golden-bug-${spec.bugId || "case"}`,
      message: spec.message || "",
      expectIncludes: spec.expectIncludes || [],
      expectRegex: spec.expectRegex || [],
      expectOneOfIncludes: spec.expectOneOfIncludes || [],
      forbidIncludes: spec.forbidIncludes || [],
      expectMeta: spec.expectMeta || spec.expectedMeta || null,
      expectReplyType: spec.expectReplyType || spec.expectedReplyType || null,
    });
  }
  return out;
}

async function postChat(message, sessionId) {
  const headers = { "Content-Type": "application/json" };
  if (GOLDEN_TEST_MODE) headers["X-Test-Mode"] = "1";

  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  return {
    reply: json?.reply || "",
    meta: json?.meta || null,
    raw: json,
  };
}

function scopedSessionId(baseSessionId) {
  const base = String(baseSessionId || "golden-session");
  return `${base}::${RUN_ID}`;
}

function expectIncludes(reply, values = []) {
  for (const v of values) {
    if (!reply.includes(v)) {
      return `Expected reply to include: ${v}`;
    }
  }
  return null;
}

function expectForbidIncludes(reply, values = []) {
  for (const v of values) {
    if (reply.includes(v)) {
      return `Expected reply to NOT include: ${v}`;
    }
  }
  return null;
}

function expectRegex(reply, values = []) {
  for (const pattern of values) {
    const re = new RegExp(pattern, "i");
    if (!re.test(reply)) {
      return `Expected reply to match regex: /${pattern}/i`;
    }
  }
  return null;
}

function expectOneOfIncludes(reply, values = []) {
  if (!values.length) return null;
  for (const v of values) {
    if (reply.includes(v)) return null;
  }
  return `Expected reply to include one of: ${values.join(" | ")}`;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function matchMetaShape(actual, expected, path = "meta") {
  if (!expected) return null;
  if (!isObject(expected)) {
    if (actual !== expected) {
      return `Expected ${path}=${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    }
    return null;
  }

  if (!isObject(actual)) {
    return `Expected ${path} to be object, got ${typeof actual}`;
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    const nextPath = `${path}.${key}`;
    const actualValue = actual[key];
    const err = matchMetaShape(actualValue, expectedValue, nextPath);
    if (err) return err;
  }
  return null;
}

function inferReplyTypeFromReply(reply = "") {
  const text = String(reply || "").toLowerCase();
  if (/\bavailable|booked|book now|weekend|dates\b/.test(text)) return "availability";
  if (/\bpets?|smoking|parties|check-?in|check-?out|cancellation\b/.test(text)) return "policy";
  if (/\bunits with|available units|pet-friendly units\b/.test(text)) return "inventory";
  if (/\bhere’s a quick|overview\b/.test(text)) return "summary";
  return "general";
}

function expectReplyType(reply, meta, expectedType) {
  if (!expectedType) return null;
  const actual = String(meta?.replyType || inferReplyTypeFromReply(reply)).toLowerCase();
  if (actual !== String(expectedType).toLowerCase()) {
    return `Expected replyType=${expectedType}, got ${actual}`;
  }
  return null;
}

async function loadTests() {
  const baselineRaw = await readFile(BASELINE_TESTS_PATH, "utf8");
  const baselineAllTests = JSON.parse(baselineRaw);
  const baselineTests =
    GOLDEN_MODE === "core"
      ? baselineAllTests.filter((t) => CORE_TESTS.has(t.name))
      : baselineAllTests;

  if (GOLDEN_SUITE === "baseline") {
    return baselineTests;
  }

  const matrixRaw = await readFile(MATRIX_TESTS_PATH, "utf8");
  const matrixSpecs = JSON.parse(matrixRaw);
  const matrixTests = expandMatrixSpecs(matrixSpecs);

  if (GOLDEN_SUITE === "matrix") {
    return matrixTests;
  }

  const bugsRaw = await readFile(BUG_TESTS_PATH, "utf8");
  const bugSpecs = JSON.parse(bugsRaw);
  const bugTests = expandBugSpecs(bugSpecs);

  if (GOLDEN_SUITE === "bugs") {
    return bugTests;
  }

  if (GOLDEN_SUITE === "all") {
    return [...baselineTests, ...matrixTests, ...bugTests];
  }

  throw new Error(
    `Unsupported GOLDEN_SUITE="${GOLDEN_SUITE}". Use baseline, matrix, bugs, or all.`
  );
}

function filterTests(tests) {
  if (!GOLDEN_FILTER) return tests;
  const matcher = GOLDEN_FILTER.toLowerCase();
  const filtered = tests.filter((t) => {
    const name = String(t.name || "").toLowerCase();
    const sessionId = String(t.sessionId || "").toLowerCase();
    const message = String(t.message || "").toLowerCase();
    return name.includes(matcher) || sessionId.includes(matcher) || message.includes(matcher);
  });
  return filtered;
}

function printTranscript(sessionId, transcripts) {
  const turns = transcripts.get(sessionId) || [];
  console.error(`Transcript for session=${sessionId}:`);
  turns.forEach((t, i) => {
    console.error(`  [${i + 1}] user: ${t.message}`);
    console.error(`      bot: ${t.reply}`);
    if (t.meta) {
      console.error(`      meta: ${JSON.stringify(t.meta)}`);
    }
  });
}

async function run() {
  const loadedTests = await loadTests();
  const tests = filterTests(loadedTests);
  if (!tests.length) {
    throw new Error(`No golden tests matched GOLDEN_FILTER="${GOLDEN_FILTER}".`);
  }

  let server = null;
  let failed = 0;
  let passed = 0;
  const transcripts = new Map();

  const stopServer = () => {
    if (!server || server.killed) return;
    console.log("🛑 Stopping server...");
    server.kill("SIGINT");
  };

  const sigintHandler = () => {
    stopServer();
    process.exit(130);
  };
  const sigtermHandler = () => {
    stopServer();
    process.exit(143);
  };
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  try {
    if (!process.env.BASE_URL) {
      console.log("🚀 Starting server...");
      server = spawn("node", ["index.js"], { stdio: "inherit" });
      await sleep(1500);
    }

    for (const t of tests) {
      const testSessionId = scopedSessionId(t.sessionId);
      const { reply, meta } = await postChat(t.message, testSessionId);
      const turns = transcripts.get(testSessionId) || [];
      turns.push({ message: t.message, reply, meta });
      transcripts.set(testSessionId, turns);

      const checks = [
        expectIncludes(reply, t.expectIncludes || []),
        expectRegex(reply, t.expectRegex || []),
        expectOneOfIncludes(reply, t.expectOneOfIncludes || []),
        expectForbidIncludes(reply, t.forbidIncludes || []),
        matchMetaShape(meta, t.expectMeta || null),
        expectReplyType(reply, meta, t.expectReplyType || null),
      ];

      const err = checks.find(Boolean) || null;
      if (err) {
        failed += 1;
        console.error(`\n❌ ${t.name}: ${err}`);
        console.error(`Message: ${t.message}`);
        console.error(`Reply: ${reply}`);
        if (meta) console.error(`Meta: ${JSON.stringify(meta)}`);
        printTranscript(testSessionId, transcripts);
      } else {
        passed += 1;
        console.log(`✅ ${t.name}`);
      }
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    stopServer();
  }

  if (failed > 0) {
    console.error(
      `\n❌ Golden prompts failed: ${failed} failing test(s), ${passed} passing test(s)`
    );
    process.exit(1);
  }

  console.log(
    `\n✅ Golden prompts PASSED (${passed} tests, mode=${GOLDEN_MODE}, suite=${GOLDEN_SUITE}${
      GOLDEN_FILTER ? `, filter=${GOLDEN_FILTER}` : ""
    }, runId=${RUN_ID})`
  );
}

run().catch((err) => {
  console.error("❌ Golden prompts error:", err);
  process.exit(1);
});
