import "dotenv/config";
import { postSlackMessage } from "../src/lib/slack.js";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error("Usage: node scripts/slack-post.js \"message\"");
  process.exit(1);
}

try {
  await postSlackMessage(text);
  console.log("Posted to Slack");
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
