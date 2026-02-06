import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TARGET_URL = process.env.TARGET_URL || BASE_URL;
const CHAT_URL = `${BASE_URL}/chat`;
const HEALTH_URL = `${BASE_URL}/healthz`;
const VERSION_URL = `${BASE_URL}/version`;
const REQUEST_TIMEOUT_MS = Number(process.env.QA_TIMEOUT_MS || 15000);
const MAX_RETRIES = Number(process.env.QA_MAX_RETRIES || 2);
const SESSIONS_TO_RUN = Number(process.env.QA_SESSIONS || 5);
const TURNS_LIMIT = Number(process.env.QA_TURNS_LIMIT || 8);
const QUESTION_SET_ID = process.env.QA_QUESTION_SET_ID || "qa_core_v3_user_prompts";

function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function psql(sql) {
  const res = spawnSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q"], {
    input: sql,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error("PSQL ERROR:", res.stderr || res.stdout);
    process.exit(1);
  }
  return (res.stdout || "").trim();
}

function readCmd(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) return "";
  return String(res.stdout || "").trim();
}

function resolveVersionMetadata() {
  const explicitVersion = String(process.env.QA_CODE_VERSION || "").trim();
  const gitCommit = readCmd("git", ["rev-parse", "HEAD"]);
  const gitBranch = readCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitShort = readCmd("git", ["rev-parse", "--short", "HEAD"]);
  const gitStatus = readCmd("git", ["status", "--porcelain"]);
  const dirty = Boolean(gitStatus);
  const dirtyFiles = gitStatus
    ? gitStatus
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 50)
    : [];

  return {
    code_version: explicitVersion || gitShort || "unknown",
    code_version_source: explicitVersion ? "env:QA_CODE_VERSION" : "git",
    git_commit: gitCommit || null,
    git_branch: gitBranch || null,
    git_dirty: dirty,
    git_dirty_file_count: dirtyFiles.length,
    git_dirty_files_sample: dirtyFiles,
  };
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES, timeoutMs = REQUEST_TIMEOUT_MS) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

function includesAll(text, arr) {
  const low = String(text || "").toLowerCase();
  return arr.every((x) => low.includes(String(x).toLowerCase()));
}

function singularizeToken(tok) {
  const t = String(tok || "").toLowerCase();
  if (t.length <= 3) return t;
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNumbers(normalized) {
  return normalized.match(/\b\d+\b/g) || [];
}

function containsSemanticTerm(reply, expectedTerm) {
  const normReply = normalizeText(reply);
  const normExpected = normalizeText(expectedTerm);
  if (!normExpected) return true;
  if (normReply.includes(normExpected)) return true;

  const canonReply = normReply
    .split(" ")
    .filter(Boolean)
    .map(singularizeToken)
    .join(" ");
  const canonExpected = normExpected
    .split(" ")
    .filter(Boolean)
    .map(singularizeToken)
    .join(" ");
  if (canonExpected && canonReply.includes(canonExpected)) return true;

  const numNoun = /(^|\s)(\d+)\s+([a-z]+)/.exec(normExpected);
  if (numNoun) {
    const n = numNoun[2];
    const noun = singularizeToken(numNoun[3]);
    const nounPattern = noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`\\b${n}\\s+${nounPattern}s?\\b`);
    if (rx.test(normReply) || rx.test(canonReply)) return true;
  }

  const expectedNums = extractNumbers(normExpected);
  if (expectedNums.length >= 2) {
    const replyNums = new Set(extractNumbers(normReply));
    if (expectedNums.every((n) => replyNums.has(n))) return true;
  }

  const replyTokSet = new Set(canonReply.split(" ").filter(Boolean));
  const expectedToks = canonExpected.split(" ").filter(Boolean);
  if (expectedToks.length && expectedToks.every((t) => replyTokSet.has(t))) return true;
  return false;
}

function checkMemoryTerms(reply, expectedTerms) {
  const matched = [];
  const missing = [];
  for (const term of expectedTerms || []) {
    if (containsSemanticTerm(reply, term)) matched.push(term);
    else missing.push(term);
  }
  return {
    allMatched: missing.length === 0,
    missing,
    matched,
  };
}

function evaluateTurnHybrid({ botReply, turnCfg, sessionState }) {
  const issues = [];
  const hardIssues = [];
  const text = String(botReply || "");
  const lowReply = text.toLowerCase();
  let missingExpectedTerms = [];
  let matchedExpectedTerms = [];

  if (Array.isArray(turnCfg.memoryMustInclude) && turnCfg.memoryMustInclude.length) {
    const memoryCheck = checkMemoryTerms(botReply, turnCfg.memoryMustInclude);
    missingExpectedTerms = memoryCheck.missing;
    matchedExpectedTerms = memoryCheck.matched;
    if (!memoryCheck.allMatched) {
      hardIssues.push("Memory failure: missing previously stated preferences.");
    }
  }
  if (Array.isArray(turnCfg.forbidIncludes) && turnCfg.forbidIncludes.length) {
    const hit = turnCfg.forbidIncludes.find((x) =>
      lowReply.includes(String(x).toLowerCase())
    );
    if (hit) hardIssues.push(`Forbidden phrase appeared in reply: ${hit}`);
  }

  if (turnCfg.consistencyKey) {
    const yn = /^\s*(yes|no)\b/i.exec(text);
    if (yn) {
      const val = yn[1].toLowerCase();
      const prev = sessionState.consistency[turnCfg.consistencyKey];
      if (
        prev &&
        prev !== val &&
        !/clarify|because|different|changed|updated|original|new requirement/i.test(lowReply)
      ) {
        hardIssues.push("Unreconciled contradiction across turns.");
      }
      sessionState.consistency[turnCfg.consistencyKey] = val;
    }
  }

  if (
    /\b(i accessed|i checked your files|i looked at your database|i opened your system|i used your tools)\b/i.test(
      lowReply
    )
  ) {
    hardIssues.push("Invalid capability claim: bot claimed inaccessible tools/systems/files.");
  }

  if (
    !/(amish|cabin|suite|unit|lodging|booking|book now|availability|policy|amenit|date|weekend|guest|pet|wifi|fireplace|bedroom|bathroom)/i.test(
      text
    )
  ) {
    hardIssues.push("Context drift away from Amish Country Lodging context.");
  }

  if (/\bguaranteed\b|\bdefinitely\b|\bcertainly\b/i.test(lowReply) && /without checking|cannot check|don't have access/i.test(lowReply)) {
    hardIssues.push("Hallucinated facts/policies/capabilities stated as certain.");
  }

  let relevance = 3;
  let correctness = 3;
  let clarity = 3;
  let consistency = 3;
  let hospitalityValue = 3;

  if (turnCfg.mustMention && includesAll(text, turnCfg.mustMention)) relevance += 1;
  if (text.length > 60) clarity += 1;
  if (/\bwould you like|i can|want me to|happy to help|book now\b/i.test(lowReply)) hospitalityValue += 1;
  if (/\bwhich unit are you asking about\b/i.test(lowReply) && turnCfg.expectingDirectAnswer) {
    relevance -= 2;
    correctness -= 1;
  }
  if (hardIssues.length) {
    consistency = Math.min(consistency, 1);
    correctness = Math.min(correctness, 1);
  }

  relevance = Math.max(0, Math.min(5, relevance));
  correctness = Math.max(0, Math.min(5, correctness));
  clarity = Math.max(0, Math.min(5, clarity));
  consistency = Math.max(0, Math.min(5, consistency));
  hospitalityValue = Math.max(0, Math.min(5, hospitalityValue));

  const scores = {
    relevance,
    correctness,
    clarity,
    consistency,
    hospitality_value: hospitalityValue,
  };

  const values = Object.values(scores);
  const qualityAvg = values.reduce((a, b) => a + b, 0) / values.length;

  let passFail = "PASS";
  let failureReasonType = null;

  if (hardIssues.length) {
    passFail = "FAIL";
    failureReasonType = "hard_rule";
    issues.push(...hardIssues);
  } else if (qualityAvg < 3.0 || values.some((v) => v <= 1)) {
    passFail = "FAIL";
    failureReasonType = "judgment_threshold";
    if (qualityAvg < 3.0) issues.push(`Quality average below threshold: ${qualityAvg.toFixed(2)} < 3.00.`);
    if (values.some((v) => v <= 1)) issues.push("At least one rubric dimension is <= 1.");
  }

  const minimalFix =
    passFail === "FAIL"
      ? failureReasonType === "hard_rule"
        ? "Maintain session memory, avoid contradictions, and keep the response grounded in Amish Country Lodging facts."
        : "Provide a more direct, accurate, and guest-useful answer to raise rubric quality above threshold."
      : "";

  return {
    passFail,
    scores,
    issues,
    minimalFix,
    judgmentThreshold: "balanced",
    failureReasonType,
    qualityAvg: Number(qualityAvg.toFixed(2)),
    missingExpectedTerms,
    matchedExpectedTerms,
  };
}

const coreSessionsV3 = [
  {
    persona: {
      group_type: "family",
      intent: "family vacation",
      constraints: "6 guests, 3+ bedrooms, fireplace + wifi, budget sensitive, privacy",
      tone: "polite, detail-oriented",
    },
    turns: [
      { msg: "Which units have hot tubs?", mustMention: ["hot"], expectingDirectAnswer: true },
      { msg: "Which of those units also have 2 bedrooms?", mustMention: ["2"], expectingDirectAnswer: true },
      { msg: "Are any of them available this weekend?", consistencyKey: "family_this_weekend", expectingDirectAnswer: true },
      { msg: "When is the next weekend they are available?", mustMention: ["weekend"], expectingDirectAnswer: true },
      { msg: "Please remember this exactly: 6 guests, 3 bedrooms minimum, fireplace, strong wifi, budget-sensitive, dates 2026-05-15 to 2026-05-18." },
      { msg: "Based on those exact requirements, what are the best options?", mustMention: ["6"], expectingDirectAnswer: true },
      { msg: "For those dates, do you have an option with both a fireplace and strong wifi?", consistencyKey: "family_fire_wifi_dates", expectingDirectAnswer: true },
      // QA self-test: memory term "3 bedroom" should semantically match replies like "3+ bedrooms".
      { msg: "Before I changed anything, can you restate my original requirements?", memoryMustInclude: ["6", "3 bedroom", "fireplace", "wifi", "2026-05-15"], expectingDirectAnswer: true },
    ],
  },
  {
    persona: {
      group_type: "couple",
      intent: "romantic getaway",
      constraints: "2 guests, weekend, hot tub + privacy, medium budget",
      tone: "chatty",
    },
    turns: [
      { msg: "Which units have a hot tub?", mustMention: ["hot"], expectingDirectAnswer: true },
      { msg: "Which of those units also have 2 bedrooms?", mustMention: ["2"], expectingDirectAnswer: true },
      { msg: "Are any of them available next weekend?", consistencyKey: "couple_next_weekend", expectingDirectAnswer: true },
      { msg: "When is the next weekend they are available?", mustMention: ["weekend"], expectingDirectAnswer: true },
      { msg: "Remember this: 2 guests, next weekend, hot tub required, privacy first." },
      { msg: "If you had to pick one for a romantic stay, what’s the best unit and why?", expectingDirectAnswer: true },
      { msg: "Actually, add pet-friendly as a new requirement too. Any conflicts?", mustMention: ["pet"], expectingDirectAnswer: true },
      { msg: "Before I added pet-friendly, what requirements had I already given you?", memoryMustInclude: ["2", "next weekend", "hot tub", "privacy"], expectingDirectAnswer: true },
    ],
  },
  {
    persona: {
      group_type: "solo",
      intent: "last-minute trip",
      constraints: "1 guest, tonight or tomorrow, strong wifi, low cost",
      tone: "rushed, blunt",
    },
    turns: [
      { msg: "What unit has four bedrooms and also has a hot tub?", mustMention: ["4"], expectingDirectAnswer: true },
      { msg: "Is it available this weekend?", consistencyKey: "solo_this_weekend", expectingDirectAnswer: true },
      { msg: "If not, what is the next weekend it is available?", mustMention: ["weekend"], expectingDirectAnswer: true },
      { msg: "Please remember this: solo traveler, strong wifi required, budget is tight, and I prefer one unit recommendation." },
      { msg: "Given that, what is your best single recommendation and why?", expectingDirectAnswer: true },
      { msg: "Before I added budget and wifi constraints, what were my original asks in this chat?", memoryMustInclude: ["four bedroom", "hot tub", "this weekend"], expectingDirectAnswer: true },
      { msg: "If any earlier answer conflicts with this recommendation, reconcile it clearly.", mustMention: ["because"], expectingDirectAnswer: true },
      { msg: "What are the exact next steps I should take to book quickly?", expectingDirectAnswer: true },
    ],
  },
  {
    persona: {
      group_type: "extended family",
      intent: "event lodging",
      constraints: "8-10 guests, accessibility concern, some pet-friendly need, multiple bathrooms",
      tone: "cautious, indecisive",
    },
    turns: [
      { msg: "We are an extended family of 8 to 10 coming for an event. Which units can handle that size?", mustMention: ["unit"], expectingDirectAnswer: true },
      { msg: "Please include bedroom and bathroom counts for each option.", mustMention: ["bath"], expectingDirectAnswer: true },
      { msg: "Remember these requirements: 8-10 guests, accessibility important, at least one pet-friendly option, multiple bathrooms." },
      { msg: "Can you summarize options with sleeps, bathroom count, pet-friendliness, and accessibility notes?", expectingDirectAnswer: true },
      { msg: "Do you have at least one option that meets all of these requirements together?", consistencyKey: "ext_all", expectingDirectAnswer: true },
      { msg: "If we prioritize accessibility over pet-friendly, what tradeoffs should we expect?", expectingDirectAnswer: true },
      { msg: "I am now conflicting: maybe only 6 guests and no pets. What changes?", mustMention: ["change"], expectingDirectAnswer: true },
      { msg: "Before that change, what were my original requirements?", memoryMustInclude: ["8-10", "accessibility", "pet", "bathroom"], expectingDirectAnswer: true },
      { msg: "Can you suggest two possible 3-night windows in June 2026?", expectingDirectAnswer: true },
      { msg: "If you contradicted earlier yes/no, reconcile explicitly in one sentence.", mustMention: ["because"], expectingDirectAnswer: true },
      { msg: "Correct any prior mistake now and keep Amish Country Lodging context explicit.", mustMention: ["amish"], expectingDirectAnswer: true },
      { msg: "Please give a final recommendation, why it fits, anything still unmet, and the next step for booking.", expectingDirectAnswer: true },
    ],
  },
];


function cloneDeep(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function hashSeed(seed, idx) {
  const h = crypto.createHash("sha256");
  h.update(`${seed}:${idx}`);
  return parseInt(h.digest("hex").slice(0, 8), 16);
}

function shiftIsoDate(iso, dayShift) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + dayShift);
  return d.toISOString().slice(0, 10);
}

function replaceYearAndShiftDates(text, year, dayShift) {
  return String(text || "").replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, _y, mm, dd) => {
    return shiftIsoDate(`${year}-${mm}-${dd}`, dayShift);
  });
}

function mutatePersona(basePersona, n) {
  const tones = ["chatty", "rushed", "cautious", "detail-oriented", "polite", "blunt"];
  const intents = ["family vacation", "romantic getaway", "event lodging", "last-minute", "accessibility", "pet-friendly"];
  const amenities = ["wifi", "hot tub", "fireplace", "pet-friendly", "accessibility", "privacy"];
  const p = { ...basePersona };
  p.tone = tones[n % tones.length];
  p.intent = intents[n % intents.length];
  const a1 = amenities[n % amenities.length];
  const a2 = amenities[(n + 2) % amenities.length];
  p.constraints = `${basePersona.constraints}; prioritize ${a1} then ${a2}`;
  return p;
}

function mutateTurns(baseTurns, fuzzIndex, seed) {
  const hashed = hashSeed(seed, fuzzIndex);
  const dayShift = (hashed % 35) - 10;
  const year = 2026 + (hashed % 2);
  const groupSize = 2 + (hashed % 9);
  const bedrooms = 1 + (hashed % 4);
  const tones = [
    "I'm in a hurry.",
    "I'm being careful with details.",
    "I'm indecisive and want to compare.",
    "I'm price-sensitive.",
  ];
  const toneHint = tones[hashed % tones.length];

  return cloneDeep(baseTurns).map((turn, idx) => {
    let msg = replaceYearAndShiftDates(turn.msg, year, dayShift);
    msg = msg.replace(/\b(family of )6\b/i, `$1${groupSize}`);
    msg = msg.replace(/\b6 guests\b/gi, `${groupSize} guests`);
    msg = msg.replace(/\b3 bedrooms?\b/gi, `${bedrooms} bedrooms`);
    msg = msg.replace(/\b2 guests\b/gi, `${Math.max(2, Math.min(4, groupSize))} guests`);
    msg = msg.replace(/\b8 to 10\b/gi, `${Math.max(6, groupSize)} to ${Math.max(8, groupSize + 2)}`);
    if (idx <= 1) msg = `${msg} ${toneHint}`;
    turn.msg = msg;

    if (Array.isArray(turn.memoryMustInclude)) {
      turn.memoryMustInclude = turn.memoryMustInclude.map((x) =>
        replaceYearAndShiftDates(String(x), year, dayShift)
          .replace(/\b6\b/g, String(groupSize))
          .replace(/\b3 bedroom\b/g, `${bedrooms} bedroom`)
      );
    }
    if (Array.isArray(turn.mustMention)) {
      turn.mustMention = turn.mustMention.map((x) => replaceYearAndShiftDates(String(x), year, dayShift));
    }
    if (typeof turn.consistencyKey === "string") {
      turn.consistencyKey = `${turn.consistencyKey}_fuzz_${fuzzIndex}`;
    }
    return turn;
  });
}

function buildRunSessions(requestedSessions, fuzzSeed) {
  const minSessions = Math.max(1, Number(requestedSessions) || 1);
  const baseSessions = coreSessionsV3;
  const sessions = [];

  for (let i = 0; i < Math.min(minSessions, baseSessions.length); i++) {
    sessions.push(cloneDeep(baseSessions[i]));
  }

  let fuzzIdx = 0;
  while (sessions.length < minSessions) {
    const base = baseSessions[fuzzIdx % baseSessions.length];
    sessions.push({
      persona: {
        ...mutatePersona(base.persona, fuzzIdx),
        variant: "fuzz",
        fuzz_index: fuzzIdx + 1,
      },
      turns: mutateTurns(base.turns, fuzzIdx, fuzzSeed),
    });
    fuzzIdx += 1;
  }
  return sessions;
}

async function run() {
  await fetchWithRetry(HEALTH_URL, { method: "GET" }, 1, 6000);

  psql(`
CREATE SCHEMA IF NOT EXISTS chatbot_qa;
CREATE TABLE IF NOT EXISTS chatbot_qa.runs (
  run_id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_url TEXT NOT NULL,
  agent_label TEXT NULL,
  notes JSONB NULL
);
CREATE TABLE IF NOT EXISTS chatbot_qa.sessions (
  session_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES chatbot_qa.runs(run_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  persona JSONB NOT NULL,
  turns_total INT NOT NULL,
  pass_count INT NOT NULL,
  fail_count INT NOT NULL,
  scores_avg JSONB NOT NULL,
  session_summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chatbot_qa.failed_turns (
  failed_turn_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chatbot_qa.sessions(session_id) ON DELETE CASCADE,
  turn_number INT NOT NULL,
  user_message TEXT NOT NULL,
  bot_reply TEXT NOT NULL,
  evaluation JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chatbot_qa.all_turns (
  turn_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chatbot_qa.sessions(session_id) ON DELETE CASCADE,
  turn_number INT NOT NULL,
  user_message TEXT NOT NULL,
  bot_reply TEXT NOT NULL,
  pass_fail TEXT NOT NULL CHECK (pass_fail IN ('PASS','FAIL')),
  evaluation JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, turn_number)
);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_sessions_run_id ON chatbot_qa.sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_failed_turns_session_id ON chatbot_qa.failed_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_failed_turns_turn_number ON chatbot_qa.failed_turns(turn_number);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_all_turns_session_id ON chatbot_qa.all_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_all_turns_turn_number ON chatbot_qa.all_turns(turn_number);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_all_turns_pass_fail ON chatbot_qa.all_turns(pass_fail);
CREATE INDEX IF NOT EXISTS idx_chatbot_qa_all_turns_created_at ON chatbot_qa.all_turns(created_at);
`);

  const runId = crypto.randomUUID();
  const fuzzSeed = process.env.QA_FUZZ_SEED || crypto.randomUUID();
  const requestedSessions = Math.max(1, SESSIONS_TO_RUN);
  const turnsPerSession = TURNS_LIMIT > 0 ? TURNS_LIMIT : 12;
  const runSessions = buildRunSessions(requestedSessions, fuzzSeed);
  const sessionGenerationMode = requestedSessions <= coreSessionsV3.length ? "core_fixed" : "4_core_plus_fuzz";
  const versionMeta = resolveVersionMetadata();
  let serverVersionMeta = {};
  try {
    const vr = await fetchWithRetry(VERSION_URL, { method: "GET" }, MAX_RETRIES, REQUEST_TIMEOUT_MS);
    const vj = await vr.json();
    serverVersionMeta = {
      server_code_version: vj?.codeVersion || null,
      server_intent_model: vj?.intentModel || null,
      server_answer_model: vj?.answerModel || null,
      server_llm_first_mode: typeof vj?.llmFirstMode === "boolean" ? vj.llmFirstMode : null,
    };
  } catch {
    serverVersionMeta = {
      server_code_version: null,
      server_intent_model: null,
      server_answer_model: null,
      server_llm_first_mode: null,
    };
  }
  const notes = {
    method: "direct_api_calls",
    mode: BASE_URL.includes("localhost") ? "local_only" : "remote",
    evaluation_mode: "hybrid",
    loosened_format_auto_fails: ["dates_only", "yes_no_only", "json_only"],
    judgment_threshold: "balanced",
    session_generation_mode: sessionGenerationMode,
    fuzz_seed: fuzzSeed,
    requested_sessions: requestedSessions,
    execution_started_at: new Date().toISOString(),
    sessions_planned: runSessions.length,
    turns_per_session: turnsPerSession,
    question_set_id: QUESTION_SET_ID,
    all_turns_enabled: true,
    ...versionMeta,
    ...serverVersionMeta,
  };

  psql(`INSERT INTO chatbot_qa.runs (run_id, target_url, agent_label, notes)
        VALUES (${sqlLit(runId)}, ${sqlLit(TARGET_URL)}, NULL, ${sqlLit(JSON.stringify(notes))}::jsonb);`);

  const runResults = [];
  const issueCounts = new Map();

  for (let sidx = 0; sidx < runSessions.length; sidx++) {
    const sessionDef = runSessions[sidx];
    const dbSessionId = crypto.randomUUID();
    const chatSessionId = `qa-hybrid-${sidx + 1}-${crypto.randomUUID()}`;
    const state = { consistency: {} };

    let passCount = 0;
    let failCount = 0;
    const totals = { relevance: 0, correctness: 0, clarity: 0, consistency: 0, hospitality_value: 0 };
    const failedRows = [];
    const allRows = [];

    const turns = TURNS_LIMIT > 0 ? sessionDef.turns.slice(0, TURNS_LIMIT) : sessionDef.turns;

    for (let i = 0; i < turns.length; i++) {
      const turnNo = i + 1;
      const turnCfg = turns[i];
      let replyText = "";
      let transportError = null;

      try {
        let serverCodeVersion = null;
        const resp = await fetchWithRetry(
          CHAT_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: turnCfg.msg, sessionId: chatSessionId }),
          },
          MAX_RETRIES,
          REQUEST_TIMEOUT_MS
        );
        serverCodeVersion = String(resp.headers.get("x-code-version") || "").trim() || null;
        const data = await resp.json();
        replyText = String(data?.reply || "").trim();
        if (serverCodeVersion && !serverVersionMeta.server_code_version) {
          serverVersionMeta.server_code_version = serverCodeVersion;
        }
        if (!replyText) transportError = "Empty reply payload";
      } catch (e) {
        transportError = `Transport failure: ${e.message}`;
      }

      let evaluation;
      if (transportError) {
        evaluation = {
          passFail: "FAIL",
          scores: { relevance: 0, correctness: 0, clarity: 1, consistency: 0, hospitality_value: 0 },
          issues: [transportError],
          minimalFix: "Return a successful, non-empty chatbot reply for the request.",
          judgmentThreshold: "balanced",
          failureReasonType: "hard_rule",
          qualityAvg: 0.2,
          missingExpectedTerms: [],
          matchedExpectedTerms: [],
        };
      } else {
        evaluation = evaluateTurnHybrid({ botReply: replyText, turnCfg, sessionState: state });
      }

      for (const k of Object.keys(totals)) totals[k] += evaluation.scores[k];
      if (evaluation.passFail === "PASS") passCount += 1;
      else failCount += 1;

      const evalObj = {
        pass_fail: evaluation.passFail,
        scores: evaluation.scores,
        detected_issues: evaluation.issues,
        minimal_fix: evaluation.minimalFix,
        judgment_threshold: evaluation.judgmentThreshold,
        failure_reason_type: evaluation.failureReasonType,
        quality_avg: evaluation.qualityAvg,
        missing_expected_terms: evaluation.missingExpectedTerms || [],
        matched_expected_terms: evaluation.matchedExpectedTerms || [],
      };

      allRows.push({
        turn_id: crypto.randomUUID(),
        turn_number: turnNo,
        user_message: turnCfg.msg,
        bot_reply: replyText,
        pass_fail: evaluation.passFail,
        evaluation: evalObj,
      });

      if (evaluation.passFail === "FAIL") {
        for (const issue of evaluation.issues) {
          issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
        }
        failedRows.push({
          failed_turn_id: crypto.randomUUID(),
          turn_number: turnNo,
          user_message: turnCfg.msg,
          bot_reply: replyText,
          evaluation: evalObj,
        });
      }
    }

    const turnsTotal = turns.length;
    const scoresAvg = {};
    for (const k of Object.keys(totals)) scoresAvg[k] = Number((totals[k] / turnsTotal).toFixed(2));

    const sessionSummary = `Persona ${sessionDef.persona.group_type}/${sessionDef.persona.intent}: ${passCount} pass, ${failCount} fail across ${turnsTotal} turns (hybrid evaluator).`;

    psql(`INSERT INTO chatbot_qa.sessions (session_id, run_id, persona, turns_total, pass_count, fail_count, scores_avg, session_summary)
          VALUES (${sqlLit(dbSessionId)}, ${sqlLit(runId)}, ${sqlLit(JSON.stringify(sessionDef.persona))}::jsonb, ${turnsTotal}, ${passCount}, ${failCount}, ${sqlLit(JSON.stringify(scoresAvg))}::jsonb, ${sqlLit(sessionSummary)});`);

    if (allRows.length) {
      const values = allRows
        .map(
          (r) =>
            `(${sqlLit(r.turn_id)}, ${sqlLit(dbSessionId)}, ${r.turn_number}, ${sqlLit(r.user_message)}, ${sqlLit(r.bot_reply)}, ${sqlLit(r.pass_fail)}, ${sqlLit(JSON.stringify(r.evaluation))}::jsonb)`
        )
        .join(",\n");
      psql(`INSERT INTO chatbot_qa.all_turns (turn_id, session_id, turn_number, user_message, bot_reply, pass_fail, evaluation)
            VALUES ${values};`);
    }

    if (failedRows.length) {
      const values = failedRows
        .map(
          (r) =>
            `(${sqlLit(r.failed_turn_id)}, ${sqlLit(dbSessionId)}, ${r.turn_number}, ${sqlLit(r.user_message)}, ${sqlLit(r.bot_reply)}, ${sqlLit(JSON.stringify(r.evaluation))}::jsonb)`
        )
        .join(",\n");
      psql(`INSERT INTO chatbot_qa.failed_turns (failed_turn_id, session_id, turn_number, user_message, bot_reply, evaluation)
            VALUES ${values};`);
    }

    runResults.push({
      session_id: dbSessionId,
      persona: sessionDef.persona,
      pass_count: passCount,
      fail_count: failCount,
      turns_total: turnsTotal,
      summary: sessionSummary,
    });
  }

  const totalTurns = runResults.reduce((a, s) => a + s.turns_total, 0);
  const totalPass = runResults.reduce((a, s) => a + s.pass_count, 0);
  const totalFail = runResults.reduce((a, s) => a + s.fail_count, 0);
  const passRate = totalTurns ? (100 * totalPass) / totalTurns : 0;

  const output = {
    run_id: runId,
    target_url: TARGET_URL,
    sessions: runResults.length,
    total_turns: totalTurns,
    total_pass: totalPass,
    total_fail: totalFail,
    pass_rate: Number(passRate.toFixed(2)),
    session_results: runResults,
    ranked_issues: Array.from(issueCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([issue, count], idx) => ({ rank: idx + 1, issue, count })),
  };

  console.log(JSON.stringify(output, null, 2));
}

run().catch((err) => {
  console.error("QA run failed:", err);
  process.exit(1);
});
