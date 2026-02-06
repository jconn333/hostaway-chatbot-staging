import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const BASELINE_TESTS_PATH = new URL("./golden-prompts.json", import.meta.url);
const MATRIX_TESTS_PATH = new URL("./golden-matrix.json", import.meta.url);
const GOLDEN_MODE = (process.env.GOLDEN_MODE || "full").toLowerCase();
const GOLDEN_SUITE = (process.env.GOLDEN_SUITE || "baseline").toLowerCase();
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
      });
    }
  }
  return expanded;
}

async function postChat(message, sessionId) {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json?.reply || "";
}

function expectIncludes(reply, values = []) {
  for (const v of values) {
    if (!reply.includes(v)) {
      return `Expected reply to include: ${v}`;
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

  if (GOLDEN_SUITE === "all") {
    return [...baselineTests, ...matrixTests];
  }

  throw new Error(
    `Unsupported GOLDEN_SUITE="${GOLDEN_SUITE}". Use baseline, matrix, or all.`
  );
}

async function run() {
  const tests = await loadTests();

  let server = null;
  if (!process.env.BASE_URL) {
    console.log("🚀 Starting server...");
    server = spawn("node", ["index.js"], { stdio: "inherit" });
    await sleep(1500);
  }

  let failed = 0;
  let passed = 0;
  for (const t of tests) {
    const reply = await postChat(t.message, t.sessionId);

    const errIncludes = expectIncludes(reply, t.expectIncludes || []);
    const errRegex = expectRegex(reply, t.expectRegex || []);
    const errOneOf = expectOneOfIncludes(reply, t.expectOneOfIncludes || []);

    const err = errIncludes || errRegex || errOneOf;
    if (err) {
      failed += 1;
      console.error(`\n❌ ${t.name}: ${err}`);
      console.error(`Message: ${t.message}`);
      console.error(`Reply: ${reply}`);
    } else {
      passed += 1;
      console.log(`✅ ${t.name}`);
    }
  }

  if (server) {
    console.log("🛑 Stopping server...");
    server.kill("SIGINT");
  }

  if (failed > 0) {
    console.error(
      `\n❌ Golden prompts failed: ${failed} failing test(s), ${passed} passing test(s)`
    );
    process.exit(1);
  }

  console.log(
    `\n✅ Golden prompts PASSED (${passed} tests, mode=${GOLDEN_MODE}, suite=${GOLDEN_SUITE})`
  );
}

run().catch((err) => {
  console.error("❌ Golden prompts error:", err);
  process.exit(1);
});
