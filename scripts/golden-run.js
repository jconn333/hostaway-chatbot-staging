import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TESTS_PATH = new URL("./golden-prompts.json", import.meta.url);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function run() {
  const raw = await readFile(TESTS_PATH, "utf8");
  const tests = JSON.parse(raw);

  let server = null;
  if (!process.env.BASE_URL) {
    console.log("🚀 Starting server...");
    server = spawn("node", ["index.js"], { stdio: "inherit" });
    await sleep(1500);
  }

  let failed = 0;
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
      console.log(`✅ ${t.name}`);
    }
  }

  if (server) {
    console.log("🛑 Stopping server...");
    server.kill("SIGINT");
  }

  if (failed > 0) {
    console.error(`\n❌ Golden prompts failed: ${failed} failing test(s)`);
    process.exit(1);
  }

  console.log("\n✅ Golden prompts PASSED");
}

run().catch((err) => {
  console.error("❌ Golden prompts error:", err);
  process.exit(1);
});
