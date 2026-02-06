const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function chat(message, sessionId) {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok) {
    throw new Error(`POST /chat failed: ${res.status}`);
  }
  const body = await res.json();
  return body.reply || "";
}

function assertIncludes(text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`Expected reply to include "${needle}"`);
  }
}

async function run() {
  const health = await get("/healthz");
  if (!health.ok) throw new Error("Health check not ok");

  const r1 = await chat("Is Red Fern available this weekend?", "synthetic-monitor");
  assertIncludes(r1, "Book now:");

  const r2 = await chat("Do you allow pets?", "synthetic-monitor-policy");
  if (!/pet/i.test(r2)) {
    throw new Error('Expected policy response to mention "pet"');
  }

  const r3 = await chat("Which units have hot tubs?", "synthetic-monitor-amenity");
  assertIncludes(r3, "Units with");

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: BASE_URL,
      checks: ["healthz", "availability", "policy", "amenity"],
      timestamp: new Date().toISOString(),
    })
  );
}

run().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      baseUrl: BASE_URL,
      error: err.message,
      timestamp: new Date().toISOString(),
    })
  );
  process.exit(1);
});

