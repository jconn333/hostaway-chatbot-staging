// scripts/smoke.js
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:3000";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasValidationFailures(meta) {
  const validation = meta?.orchestration?.validation || [];
  return validation.some((v) => v?.ok === false);
}

function hasSuccessfulToolExecution(meta) {
  const executions = meta?.orchestration?.toolExecutions || [];
  return executions.some((e) => e?.ok === true);
}

function hasToolExecution(meta, toolName) {
  const executions = meta?.orchestration?.toolExecutions || [];
  return executions.some((e) => String(e?.tool || "") === String(toolName));
}

async function sendChat({ message, sessionId = null, listingId = null }) {
  const body = { message };
  if (sessionId) body.sessionId = sessionId;
  if (listingId) body.listingId = listingId;

  const resp = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-mode": "1",
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw}`);
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON response: ${raw}`);
  }
  return json;
}

async function runCase(name, fn) {
  process.stdout.write(`\n🧪 ${name}\n`);
  try {
    await fn();
    process.stdout.write(`✅ ${name} passed\n`);
    return { name, ok: true };
  } catch (err) {
    process.stdout.write(`❌ ${name} failed: ${err?.message || err}\n`);
    return { name, ok: false, error: String(err?.message || err) };
  }
}

async function run() {
  process.stdout.write("🚀 Starting server...\n");
  const server = spawn("node", ["index.js"], { stdio: "inherit" });

  try {
    await sleep(1500);

    const results = [];

    results.push(await runCase("Test Case 1: Multi-Constraint Discovery", async () => {
      const out = await sendChat({
        message: "Show me any treehouses that sleep at least 4 people and have a hot tub.",
      });
      const meta = out?.meta || {};
      assert(meta?.orchestration?.toolCallCount > 0, "Expected at least one tool call.");
      assert(!hasValidationFailures(meta), "Validation failed in orchestrator.");
      assert(
        meta?.route === "amenity_inventory" || meta?.route === "inventory",
        `Expected inventory route, got: ${meta?.route}`
      );
    }));

    results.push(await runCase("Test Case 2: Relative Date Normalization", async () => {
      const out = await sendChat({
        message: "Is the Red Fern Cabin available for next weekend?",
      });
      const meta = out?.meta || {};
      const reply = String(out?.reply || "");
      assert(meta?.orchestration?.toolCallCount > 0, "Expected at least one tool call.");
      assert(!hasValidationFailures(meta), "Validation failed in orchestrator.");
      assert(meta?.route === "availability", `Expected availability route, got: ${meta?.route}`);
      assert(hasToolExecution(meta, "check_availability"), "Expected check_availability execution.");
      assert(reply.length > 0, "Expected a graceful non-empty reply.");
    }));

    results.push(await runCase("Test Case 3: Session Continuity & Policy", async () => {
      const sessionId = `smoke-${randomUUID()}`;
      const t1 = await sendChat({
        message: "Tell me about the Water Lily Cabin.",
        sessionId,
      });
      assert(t1?.meta?.orchestration?.toolCallCount > 0, "Turn 1 expected at least one tool call.");
      assert(!hasValidationFailures(t1?.meta || {}), "Turn 1 validation failed.");

      const t2 = await sendChat({
        message: "Does it allow pets?",
        sessionId,
      });
      const meta = t2?.meta || {};
      assert(meta?.orchestration?.toolCallCount > 0, "Turn 2 expected at least one tool call.");
      assert(!hasValidationFailures(meta), "Turn 2 validation failed.");
      assert(
        meta?.listingId || meta?.sessionListingId,
        "Expected listing context in session continuity test."
      );
    }));

    results.push(await runCase("Test Case 4: Availability with Alternative Suggestion", async () => {
      const out = await sendChat({
        message: "I want to stay at Joy Lodge Suite from March 24 to March 26, 2026.",
      });
      const meta = out?.meta || {};
      const reply = String(out?.reply || "");
      assert(meta?.orchestration?.toolCallCount > 0, "Expected at least one tool call.");
      assert(!hasValidationFailures(meta), "Validation failed in orchestrator.");
      assert(meta?.route === "availability", `Expected availability route, got: ${meta?.route}`);
      if (
        hasSuccessfulToolExecution(meta) &&
        !meta?.orchestration?.toolExecutions?.some((e) => e?.ok === false) &&
        /\bnot available|booked|unavailable\b/i.test(reply)
      ) {
        assert(
          /\bBook now:\b/i.test(reply) || /\balternative|option|nearby\b/i.test(reply),
          "Expected alternatives/helpful suggestion when unavailable."
        );
      }
    }));

    results.push(await runCase("Test Case 5: Small Talk Discipline", async () => {
      const out = await sendChat({
        message: "Thanks, that's really helpful. See you soon!",
      });
      const meta = out?.meta || {};
      const reply = String(out?.reply || "");
      assert(meta?.orchestration?.toolCallCount === 0, "Expected zero tool calls for small talk.");
      assert(!/Which unit are you asking about\?/i.test(reply), "Should not ask disambiguation on closure.");
    }));

    const failed = results.filter((r) => !r.ok);
    process.stdout.write("\n--- Golden Smoke Summary ---\n");
    for (const r of results) {
      process.stdout.write(`${r.ok ? "PASS" : "FAIL"}: ${r.name}\n`);
    }

    if (failed.length) {
      process.stdout.write(`\n❌ ${failed.length}/${results.length} golden smoke tests failed.\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write("\n✅ Golden smoke set passed.\n");
  } finally {
    process.stdout.write("\n🛑 Stopping server...\n");
    server.kill("SIGINT");
  }
}

run().catch((err) => {
  console.error("\n❌ Smoke test failure:", err?.message || err);
  process.exit(1);
});
