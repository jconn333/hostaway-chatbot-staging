import { readFile, writeFile } from "node:fs/promises";

const BUGS_PATH = new URL("./golden-bugs.json", import.meta.url);

function getArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function usage() {
  console.error(
    "Usage: npm run golden:bug:add -- --id <bug-id> [--session <session-id>] [--message \"message\"]"
  );
}

async function run() {
  const bugId = getArg("--id");
  if (!bugId) {
    usage();
    process.exit(1);
  }
  const sessionId = getArg("--session", `golden-bug-${bugId}`);
  const message = getArg("--message", "TODO: add failing user turn");

  const existing = JSON.parse(await readFile(BUGS_PATH, "utf8"));
  if (existing.some((b) => String(b.bugId) === String(bugId))) {
    throw new Error(`Bug id already exists: ${bugId}`);
  }

  existing.push({
    bugId,
    sessionId,
    turns: [
      {
        message,
        expectMeta: { route: "general" },
        expectReplyType: "general",
        expectOneOfIncludes: [],
        forbidIncludes: [],
      },
    ],
  });

  await writeFile(BUGS_PATH, JSON.stringify(existing, null, 2) + "\n");
  console.log(`Added bug template: ${bugId}`);
  console.log("Update the new entry in scripts/golden-bugs.json with exact expected assertions.");
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
