// scripts/smoke.js
import { spawn } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log("🚀 Starting server...");
  const server = spawn("node", ["index.js"], { stdio: "inherit" });

  // Give server time to boot
  await sleep(1500);

  console.log("🧪 Running Red Fern availability test...");

  const curl = spawn(
    "curl",
    [
      "-s",
      "-X",
      "POST",
      "http://localhost:3000/chat",
      "-H",
      "Content-Type: application/json",
      "-d",
      '{"message":"Is the Red Fern Cabin available tonight?"}',
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let output = "";
  let error = "";

  curl.stdout.on("data", (d) => (output += d.toString()));
  curl.stderr.on("data", (d) => (error += d.toString()));

  const exitCode = await new Promise((resolve) => curl.on("close", resolve));

  console.log("🛑 Stopping server...");
  server.kill("SIGINT");

  if (exitCode !== 0) {
    console.error("❌ curl failed:\n", error);
    process.exit(1);
  }

  if (!output.includes('"reply"') || !output.includes("Book now:")) {
    console.error("❌ Smoke test failed. Output:\n", output);
    process.exit(1);
  }

  console.log("✅ Smoke test PASSED\n");
  console.log(output);
}

run().catch((err) => {
  console.error("❌ Smoke test error:", err);
  process.exit(1);
});