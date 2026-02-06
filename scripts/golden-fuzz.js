import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PROMPTS_PATH = new URL("./golden-prompts.json", import.meta.url);
const BUGS_PATH = new URL("./golden-bugs.json", import.meta.url);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    seed: Number(process.env.GOLDEN_FUZZ_SEED || Date.now()),
    count: Number(process.env.GOLDEN_FUZZ_COUNT || 50),
    minTurns: Number(process.env.GOLDEN_FUZZ_MIN_TURNS || 8),
    maxTurns: Number(process.env.GOLDEN_FUZZ_MAX_TURNS || 12),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const b = argv[i + 1];
    if (a === "--seed" && b) out.seed = Number(b);
    if (a === "--count" && b) out.count = Number(b);
    if (a === "--min-turns" && b) out.minTurns = Number(b);
    if (a === "--max-turns" && b) out.maxTurns = Number(b);
  }
  if (!Number.isFinite(out.seed)) out.seed = Date.now();
  if (!Number.isFinite(out.count) || out.count < 1) out.count = 50;
  if (!Number.isFinite(out.minTurns) || out.minTurns < 1) out.minTurns = 8;
  if (!Number.isFinite(out.maxTurns) || out.maxTurns < out.minTurns) out.maxTurns = 12;
  return out;
}

function makeRng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function pick(rng, arr) {
  if (!arr.length) return null;
  return arr[Math.floor(rng() * arr.length)];
}

function typoNoise(input, rng) {
  let out = input;
  const replacements = [
    [/\bweekend\b/gi, "weekened"],
    [/\bavailable\b/gi, "avaiable"],
    [/\btonight\b/gi, "tonite"],
    [/\bfor\b/gi, "4"],
    [/\bwith\b/gi, "w/"],
    [/\btwo nights\b/gi, "2 nites"],
    [/\bnext weekend\b/gi, "nxt wknd"],
  ];
  for (const [re, val] of replacements) {
    if (rng() < 0.25) out = out.replace(re, val);
  }
  if (rng() < 0.2) out = out.toLowerCase();
  if (rng() < 0.15) out = out.replace(/[?]$/, "");
  if (rng() < 0.1) out = out.replace(/\bwhat about\b/i, "what about that");
  return out;
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
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function groupChains(prompts) {
  const bySession = new Map();
  for (const p of prompts || []) {
    const key = String(p.sessionId || "");
    if (!key) continue;
    const list = bySession.get(key) || [];
    list.push(p);
    bySession.set(key, list);
  }

  const chains = [];
  for (const [sessionId, turns] of bySession.entries()) {
    if (turns.length < 3) continue;
    if (!/deep-|golden-/.test(sessionId)) continue;
    chains.push(
      turns.map((t) => ({
        name: t.name,
        message: t.message,
      }))
    );
  }
  return chains;
}

function bugChains(bugs) {
  const chains = [];
  for (const bug of bugs || []) {
    if (!Array.isArray(bug.turns) || bug.turns.length < 2) continue;
    chains.push(
      bug.turns.map((t, i) => ({
        name: `${bug.bugId || "bug"}-${i + 1}`,
        message: t.message,
      }))
    );
  }
  return chains;
}

function shouldExpectAvailabilityRoute(message, previousRoute) {
  const msg = String(message || "").toLowerCase();
  if (/\b(today|tonight|tomorrow|weekend|march|april|may|june|july|august|september|october|november|december)\b/.test(msg)) {
    return true;
  }
  if (/\bwhat about|how about|instead\b/.test(msg) && previousRoute === "availability") {
    return true;
  }
  return false;
}

async function run() {
  const opts = parseArgs(process.argv);
  const rng = makeRng(opts.seed);
  let server = null;
  if (!process.env.BASE_URL) {
    server = spawn("node", ["index.js"], { stdio: "inherit" });
    await sleep(1500);
  }

  const prompts = JSON.parse(await readFile(PROMPTS_PATH, "utf8"));
  const bugs = JSON.parse(await readFile(BUGS_PATH, "utf8"));
  const bases = [...groupChains(prompts), ...bugChains(bugs)];
  if (!bases.length) {
    throw new Error("No base chains found for fuzzing");
  }

  const failures = [];
  let totalTurns = 0;

  for (let i = 0; i < opts.count; i++) {
    const chain = pick(rng, bases);
    const turnsTarget = Math.floor(rng() * (opts.maxTurns - opts.minTurns + 1)) + opts.minTurns;
    const sessionId = `golden-fuzz-${opts.seed}-${i}`;
    const transcript = [];
    let previousRoute = null;

    for (let t = 0; t < turnsTarget; t++) {
      const baseTurn = chain[t % chain.length];
      const message = typoNoise(baseTurn.message, rng);
      const body = await postChat(message, sessionId);
      const reply = body.reply || "";
      const meta = body.meta || {};
      totalTurns += 1;
      transcript.push({ message, reply, meta });

      if (!reply.trim()) {
        failures.push({
          seed: opts.seed,
          chainIndex: i,
          reason: "empty_reply",
          transcript,
        });
        break;
      }

      const route = String(meta.route || "");
      const followupAsked = /\bwhat about|how about|that one|it\b/i.test(message);
      if (followupAsked && ["availability", "inventory_availability", "amenity_inventory"].includes(previousRoute)) {
        if (["summary", "general", "disambiguation"].includes(route)) {
          failures.push({
            seed: opts.seed,
            chainIndex: i,
            reason: `followup_route_drift:${previousRoute}->${route}`,
            transcript,
          });
          break;
        }
      }

      if (shouldExpectAvailabilityRoute(message, previousRoute) && route !== "availability" && route !== "inventory_availability") {
        failures.push({
          seed: opts.seed,
          chainIndex: i,
          reason: `availability_route_expected:${route || "none"}`,
          transcript,
        });
        break;
      }

      previousRoute = route || previousRoute;
    }
  }

  await mkdir("tmp", { recursive: true });
  const outPath = `tmp/golden-fuzz-failures-${opts.seed}.json`;
  await writeFile(
    outPath,
    JSON.stringify(
      {
        seed: opts.seed,
        count: opts.count,
        totalTurns,
        failures,
      },
      null,
      2
    )
  );

  if (failures.length) {
    console.error(`❌ Fuzz failures: ${failures.length}/${opts.count}`);
    console.error(`See ${outPath}`);
    if (server) server.kill("SIGINT");
    process.exit(1);
  }

  console.log(`✅ Fuzz passed (${opts.count} chains, ${totalTurns} turns, seed=${opts.seed})`);
  console.log(`Saved report: ${outPath}`);
  if (server) server.kill("SIGINT");
}

run().catch((err) => {
  console.error("❌ golden-fuzz error:", err.message || err);
  process.exit(1);
});
